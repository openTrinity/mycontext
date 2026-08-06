/**
 * ACP 的 JSON-RPC over stdio 客户端。
 *
 * 协议形态：每行一个 JSON 消息（ndjson）。三类消息：
 * · 请求（有 id，期待响应）
 * · 响应（有 id + result/error）
 * · 通知（无 id，单向）
 *
 * ACP 是**双向**的：agent 侧也会向我们发请求（`session/request_permission`
 * 等），因此这个 client 必须同时是一个 server。不实现反向 handler 的话
 * 实测所有工具调用会被静默拒绝。
 *
 * 传输层用 `spawnDuplex()`（A 阶段新增）：现有的 `spawn()` 硬编码
 * `stdin: "ignore"` 且必然超时，承载不了长连。
 */
import { AppError, type Logger } from "@mycontext/kernel"
import type { DuplexHandle } from "@mycontext/runtime-env"

export interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: number | string
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface JsonRpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: unknown
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return "id" in message && !("method" in message)
}

function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "id" in message && "method" in message
}

/** 反向请求的处理器表。返回值会被包成 JSON-RPC 响应发回去。 */
export type ReverseMethodHandler = (params: unknown) => unknown | Promise<unknown>

export interface AcpClientOptions {
  transport: DuplexHandle
  logger?: Logger
  /** 通知处理（`session/update` 等）。这是事件流的入口 */
  onNotification?: (method: string, params: unknown) => void
  /** 反向请求处理表。**必须包含 `session/request_permission`** */
  reverseHandlers?: Record<string, ReverseMethodHandler>
  /** 单次请求超时。默认 60s：模型响应可能很慢，但不能无限等 */
  requestTimeoutMs?: number
  /**
   * 按方法覆盖超时。`null` = **不设限**（那个方法永不因超时被拒）。
   *
   * ## ★ 为什么需要按方法分开，而不是调大全局值
   *
   * 这个 client 上跑着两类语义完全不同的请求：
   *
   * · `initialize` / `session/new` / `session/dispose` —— **协议动作**。
   *   它们要么毫秒级返回，要么就是真的坏了（子进程没起来 / 协议不匹配）。
   *   给它们无限等 = 一个起不来的 opencode 会让调用方永久挂住；
   * · `session/prompt` —— **一整轮 agent 推理**。它的耗时取决于模型要
   *   调几次工具，而那不是我们能预估的量。
   *
   * 原来两类共用一个 120s，代价实测过：一次跨消息+文档的汇总问题跑了
   * 8 次检索，到 116s 第 8 条命令还在跑，120s 到点整轮被掐掉 → 降级成
   * 「本地召回」只回两段原文。**本地其实已经搜到了要的数据**
   * （85 条 PPL、248 个商机），只是没来得及归纳。
   *
   * 那次失败的形态说明了这个超时的问题：它掐掉的是**快要成功的长查询**，
   * 而真正该被它抓住的故障（模型完全不响应）另有更可靠的判据 ——
   * 子进程死了 / 连接断了，那两个都不依赖墙钟。
   *
   * 与 `KlServerService.awaitIngest` 删掉墙钟超时是同一个判断：
   * **"太慢"不等于"坏了"**，而按时间猜出来的失败会真的降低可用性。
   */
  methodTimeouts?: Readonly<Record<string, number | null>>
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  /** `null` = 这个方法不设限（见 `methodTimeouts`），没有定时器要清。 */
  timer: NodeJS.Timeout | null
  /**
   * 发出的方法名 —— 错误响应回来时把它塞进 AppError 的 context。
   *
   * 首个真机端到端曾报 "Invalid params" 却看不出是哪个 method，浪费了
   * 一次调查窗口才定位。加上它一劳永逸。
   */
  method: string
}

export class AcpClient {
  private nextId = 1
  private readonly pending = new Map<number | string, Pending>()
  private closed = false

  constructor(private readonly options: AcpClientOptions) {}

  /** 把 transport 的每一行喂进来。由 supervisor 在 spawnDuplex 的 onLine 里调用。 */
  handleLine(line: string): void {
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch {
      // 非 JSON 行：opencode 可能打诊断输出。记 debug 而不是抛错 ——
      // 一行噪音不该让整条连接失效。
      this.options.logger?.debug("acp non-json line", { head: line.slice(0, 120) })
      return
    }

    if (isResponse(message)) {
      this.settle(message)
      return
    }
    if (isRequest(message)) {
      void this.handleReverseRequest(message)
      return
    }
    // 通知
    this.options.onNotification?.(message.method, message.params)
  }

  /** 发请求并等响应。 */
  async request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      throw new AppError("PROCESS_FAILED", "ACP 连接已关闭", { context: { method } })
    }
    const id = this.nextId
    this.nextId += 1

    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method }
    if (params !== undefined) payload.params = params

    const promise = new Promise<T>((resolve, reject) => {
      /**
       * `methodTimeouts` 里显式给 `null` = 不设限 → 不装定时器。
       *
       * ★ 用 `in` 判断而不是 `?? 全局值`：`null` 是**有意义的值**
       * （"不设限"），而 `??` 会把它当"没配"直接落回全局超时 ——
       * 那样这个功能会静默失效，且外观与配了一样。
       */
      const overrides = this.options.methodTimeouts
      const timeoutMs =
        overrides !== undefined && method in overrides
          ? overrides[method]
          : (this.options.requestTimeoutMs ?? 60_000)

      const timer =
        timeoutMs === null || timeoutMs === undefined
          ? null
          : setTimeout(() => {
              this.pending.delete(id)
              reject(
                new AppError("PROCESS_TIMEOUT", `ACP 请求超时：${method}`, {
                  retryable: true,
                  context: { method },
                }),
              )
            }, timeoutMs)

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        method,
      })
    })

    await this.options.transport.writeLine(JSON.stringify(payload))
    return promise
  }

  /** 发通知（不等响应）。 */
  async notify(method: string, params?: unknown): Promise<void> {
    const payload: JsonRpcNotification = { jsonrpc: "2.0", method }
    if (params !== undefined) payload.params = params
    await this.options.transport.writeLine(JSON.stringify(payload))
  }

  private settle(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id)
    if (pending === undefined) {
      // 迟到的响应（我们已经超时了）：丢弃并记 debug。
      this.options.logger?.debug("acp late response", { id: String(response.id) })
      return
    }
    this.pending.delete(response.id)
    if (pending.timer !== null) clearTimeout(pending.timer)

    if (response.error !== undefined) {
      /**
       * ★ 错误上下文必须带 method。
       *
       * 首个真机端到端调 turn 时 opencode 回 `Invalid params`，但
       * `context: { code }` 里没 method —— 无法判断是 initialize、session/new、
       * session/prompt、还是 session/resume 拒绝的。加 method 之后一眼可读。
       */
      pending.reject(
        new AppError("PROCESS_FAILED", `ACP 错误：${response.error.message}`, {
          context: { code: response.error.code, method: pending.method },
        }),
      )
      return
    }
    pending.resolve(response.result)
  }

  /**
   * 处理 agent 侧发来的请求。
   *
   * 未注册的方法回 JSON-RPC 的 "method not found"（-32601）而不是静默不回：
   * 不回的话对端会一直等，而这个"卡住"极难归因到"我们没实现某个反向方法"。
   */
  private async handleReverseRequest(request: JsonRpcRequest): Promise<void> {
    const handler = this.options.reverseHandlers?.[request.method]
    if (handler === undefined) {
      this.options.logger?.warn("acp reverse method not implemented", { method: request.method })
      await this.reply(request.id, undefined, {
        code: -32601,
        message: `method not found: ${request.method}`,
      })
      return
    }

    try {
      const result = await handler(request.params)
      await this.reply(request.id, result)
    } catch (error) {
      await this.reply(request.id, undefined, {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async reply(
    id: number | string,
    result?: unknown,
    error?: { code: number; message: string },
  ): Promise<void> {
    const payload: JsonRpcResponse = { jsonrpc: "2.0", id }
    if (error !== undefined) payload.error = error
    else payload.result = result ?? null
    await this.options.transport.writeLine(JSON.stringify(payload))
  }

  /**
   * 关闭：拒绝所有在途请求（否则调用方会永远等）。
   *
   * ★ 这条路径是**不设限请求的终止保证**（见 `methodTimeouts`）：
   * 一个没有定时器的 `session/prompt` 不会自己放弃，但子进程死掉 /
   * 连接断掉时 `close()` 会拒了它。也就是"永不超时"不等于"永远挂住" ——
   * 它换的是判据：从"猜它太慢"变成"连接确实没了"。
   */
  close(): void {
    this.closed = true
    for (const [id, pending] of this.pending) {
      if (pending.timer !== null) clearTimeout(pending.timer)
      pending.reject(new AppError("PROCESS_CANCELLED", "ACP 连接已关闭"))
      this.pending.delete(id)
    }
  }

  /** 在途请求数（诊断用：泄漏的话这个数只增不减）。 */
  get pendingCount(): number {
    return this.pending.size
  }
}
