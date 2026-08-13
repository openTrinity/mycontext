/**
 * OpenAI 兼容的最小 LLM 客户端。
 *
 * ## 为什么自己写而不是引 SDK
 *
 * 我们只需要 `/chat/completions` 一个端点。官方 SDK 带来的是流式、
 * 工具调用、助手 API 等一整套我们不用的东西，以及一个会自己更新
 * 请求形状的依赖 —— 而这个网关是 OpenAI **兼容**而非 OpenAI，
 * SDK 的新字段可能直接 400。
 *
 * ## ★ 三条实测出来的坑（都在这个网关上验过）
 *
 * 1. **`response_format: json_object` 不保证不加代码块围栏。**
 *    同一个模型（qwen3.7-plus），加不加 system 提示会得到：
 *    · 有提示 → `{"facets":[…]}`（裸 JSON）
 *    · 无提示 → ```json\n{"facets":[…]}\n```（带围栏）
 *    直接 `JSON.parse(content)` 会在第二种情况下抛。所以必须**剥围栏**
 *    —— 而不是"加了 system 提示就假定它裸着"（那是在赌）。
 *
 * 2. **响应里有 `reasoning_content`。** 那是思考过程，不是答案。
 *    读 `message.content` 而不是把整个 message 当输出。
 *
 * 3. 网关返回业务错误时 HTTP 可能仍是 200，错误在 body 的 `error` 字段里。
 *    只看 `res.ok` 会把错误当成"内容是 undefined"往下传。
 *
 * ## 超时 / 重试 / 并发
 *
 * 三个都是必须的，理由各不相同：
 * · **超时** —— 挂起的请求会让整轮蒸馏永远不结束（比失败更糟：没有错误可看）；
 * · **重试** —— 429/5xx 是常态，但**只重试这些**：400 重试 N 次只是把
 *   同一个错误犯 N 遍，还烧 N 倍配额；
 * · **并发闸** —— 蒸馏会一次排上几百个任务，不限并发会直接打到限流，
 *   然后所有请求一起进重试，形成雪崩。
 */
import { AppError, type Logger } from "@mycontext/kernel"

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string
  /**
   * 随这条消息一起送的图片（视觉输入）。
   *
   * ## ★ 为什么是单独一个字段，而不是让调用方把 `content` 写成数组
   *
   * OpenAI 兼容协议的多模态形状是
   * `content: [{type:"text",…},{type:"image_url",image_url:{url:"data:…"}}]`
   * —— 也就是**一旦有图，`content` 就从 string 变成数组**。把那个联合类型
   * 暴露给调用方的代价是：每一处读 `message.content` 的地方都要先判类型
   * （这个文件里就有工具循环、重试、日志三处），而其中大多数只关心文本。
   *
   * 所以对外保持 `content: string` + 一个可选的 `images`，
   * 转写成数组只在 wire 那一处做（与 `toolCalls` 的驼峰→下划线同一个位置、
   * 同一个理由：命名/形状的差异集中在一个地方）。
   *
   * 实测这个网关上 `qwen3.7-plus` 与 `gpt-5.6-sol` 都能正确读图。
   */
  images?: readonly LlmImage[]
  /**
   * 助手发起的工具调用。
   *
   * 回传给网关时**必须原样带上** —— 这是 OpenAI 兼容协议的要求：
   * `role: "tool"` 的消息要能对上某个 `tool_call_id`，
   * 对不上时网关会 400（而不是忽略）。
   */
  toolCalls?: LlmToolCall[]
  /** `role: "tool"` 时必填：这条结果回答的是哪次调用 */
  toolCallId?: string
}

/** 一张随消息送出去的图。 */
export interface LlmImage {
  /** base64（不含 data URI 前缀 —— 前缀在转写时拼） */
  base64: string
  /** 如 `image/png`。协议要求 data URI 里带它，猜错会被网关拒 */
  mimeType: string
}

export interface LlmToolCall {
  id: string
  name: string
  /** 原始 JSON 串。**不在这里解析** —— 解析交给知道 schema 的调用方 */
  argumentsJson: string
}

/** 工具声明（OpenAI 的 function calling 形状）。 */
export interface LlmToolSpec {
  name: string
  description: string
  /**
   * JSON Schema。
   *
   * ★ 参数越少越好。数字人那个检索工具只声明 `query` ——
   * 会话 id 由闭包捕获，模型连"换个会话"这个动作都表达不出来。
   * 多声明一个参数就等于把隔离交给模型的自觉。
   */
  parameters: Record<string, unknown>
}

export interface LlmUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface LlmCompletion {
  text: string
  usage: LlmUsage
  /** 思考过程（网关的 `reasoning_content`）。仅用于排查，不进业务 */
  reasoning?: string
  /**
   * 模型要求调用的工具。
   *
   * 非空时 `text` 通常是空串 —— 那**不是错误**（模型在等工具结果）。
   * 所以下面"空内容"的判定必须放过这种情况，否则每次工具调用
   * 都会被当成"返回空内容"而重试（表现是每轮慢三倍）。
   */
  toolCalls?: LlmToolCall[]
  /** 网关给的结束原因。`tool_calls` 表示它在等工具结果 */
  finishReason?: string
}

export interface LlmClientOptions {
  /** 网关根地址，如 `https://llmapi.llm-gateway.com`（末尾斜杠会被规范化） */
  baseUrl: string
  apiKey: string
  model: string
  /**
   * 网关协议。默认 `openai`（`/v1/chat/completions` + Bearer）。
   *
   * ★ `anthropic` 走 `/v1/messages`（`x-api-key` + `anthropic-version`、system 顶层、
   * content blocks、`tool_use`/`tool_result`、`usage.input/output_tokens`）——
   * 这是数字分身/蒸馏/直连能跟着主模型协议走的另一条传输（见 startup 的
   * `mainProvider`）。两条协议对外都归一成同一个 `LlmCompletion`。
   */
  provider?: "openai" | "anthropic"
  logger?: Logger
  /** 单请求超时（ms）。默认 90s —— 蒸馏的 prompt 可能很长 */
  timeoutMs?: number
  /** 最多重试几次（仅 429/5xx/网络错误）。默认 2 */
  maxRetries?: number
  /** 并发上限。默认 3 —— 与网关限流留余量 */
  concurrency?: number
  /** 注入 fetch（测试用；缺省用全局 fetch） */
  fetchImpl?: typeof fetch
  /** 注入睡眠（测试用，避免真的等退避时间） */
  sleep?: (ms: number) => Promise<void>
}

export interface CompleteOptions {
  messages: readonly LlmMessage[]
  /** 要求 JSON 输出。会同时设 `response_format` 与剥围栏 */
  json?: boolean
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  /**
   * 只对**这一次**调用生效的超时（毫秒）。省略时用 client 的默认。
   *
   * ## ★★ 为什么需要按调用覆盖，而不是把 client 的默认调大
   *
   * 同一个 `LlmClient` 被两类消费者共用（`LlmHolder` 只持有一个实例）：
   *
   * · **数字分身回消息** —— 用户在等，慢了就该出草稿让人来写；
   * · **蒸馏的 facet 抽取** —— 后台批处理，没人在等。
   *
   * 两者对"等多久算太久"的答案相反，而默认 90s 是按前者定的。
   * 实测后果：facet 抽取单次调用约 125s（400 条语料 / 4 批），
   * 于是**超时阈值比正常耗时还短** —— 语料长的窗口必然失败：
   *
   * ```
   * 已成功窗口   400 条  6768 字符（均 17 字符/条）  ✓
   * 05-12 窗口   400 条 14680 字符（均 37 字符/条）  ✗ role/tasks 双双超时
   * ```
   *
   * 而且这是**可复现的失败**而不是偶发：那一轮 `llm retry` 打到 attempt=2，
   * 每次重试都白烧一整个 prompt 的 token。把 client 默认调大能修它，
   * 但代价是数字分身也跟着等 —— 那是另一个方向的错。
   */
  timeoutMs?: number
  /** 可用工具。给了之后模型可能返回 `toolCalls` 而不是正文 */
  tools?: readonly LlmToolSpec[]
}

/** 工具执行器：调用方注入。客户端只管协议，不管工具怎么实现。 */
export interface ToolExecutor {
  (call: LlmToolCall): Promise<string> | string
}

export interface CompleteWithToolsOptions extends Omit<CompleteOptions, "tools"> {
  tools: readonly LlmToolSpec[]
  execute: ToolExecutor
  /**
   * 最多跑几轮工具调用。默认 3。
   *
   * ★ 必须有上限：模型可能反复要求调同一个工具（尤其在工具返回空结果时 ——
   * 它会以为"换个词再查一次"）。无限轮会在一次限流里烧掉整轮配额，
   * 而表现只是"这次回复特别慢"，没有任何错误。
   */
  maxRounds?: number
}

/**
 * 剥掉 Markdown 代码块围栏。
 *
 * ★ 这不是"以防万一"：实测同一个模型在**开了** `response_format:
 * json_object` 的情况下仍然会返回 ```json 包裹的内容（取决于提示词）。
 * 不剥的话 `JSON.parse` 抛 `Unexpected token \``，
 * 而那个错看起来像"模型不听话"，实际是网关行为不稳定。
 *
 * 只剥**最外层**一对围栏，且要求它包住整个串 —— 内容里合法出现的
 * ``` 不该被动到（比如结论正文里引用了一段代码）。
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith("```")) return trimmed
  // 第一行可能是 ``` 或 ```json / ```JSON 等
  const firstNewline = trimmed.indexOf("\n")
  if (firstNewline === -1) return trimmed
  const closing = trimmed.lastIndexOf("```")
  if (closing <= firstNewline) return trimmed
  return trimmed.slice(firstNewline + 1, closing).trim()
}

/** 哪些错误值得重试。400/401/403/404 重试只是把同一个错误犯多遍。 */
export function isRetryable(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500
}

/**
 * 并发闸：最简单的信号量。
 *
 * 不引 p-limit：那是一个依赖，而这里的全部需求是"同时最多 N 个"。
 */
class Semaphore {
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1
      return () => this.release()
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.active += 1
    return () => this.release()
  }

  private release(): void {
    this.active -= 1
    const next = this.waiting.shift()
    if (next !== undefined) next()
  }
}

interface RawToolCall {
  id?: unknown
  function?: { name?: unknown; arguments?: unknown }
}

interface RawChoice {
  message?: {
    content?: unknown
    reasoning_content?: unknown
    tool_calls?: unknown
  }
  finish_reason?: unknown
}

interface RawResponse {
  choices?: RawChoice[]
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown }
  error?: unknown
}

/** Anthropic Messages 的响应信封（我们只读到的那几个字段）。 */
interface RawAnthropicResponse {
  type?: unknown
  content?: unknown
  stop_reason?: unknown
  usage?: { input_tokens?: unknown; output_tokens?: unknown }
  error?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * 把一条内部 `LlmMessage` 转成 Anthropic Messages 的 `{role, content: blocks}`。
 *
 * · `role:"tool"`（我们内部的工具结果）→ Anthropic 的 `role:"user"` +
 *   `tool_result` block（`tool_use_id` 对上之前那次 `tool_use`）；
 * · 助手带 `toolCalls` → content 里既有 text（可能空）也有 `tool_use` block ——
 *   原样回传，否则下一条 `tool_result` 的 `tool_use_id` 对不上会 400；
 * · 图片 → `{type:"image",source:{type:"base64",media_type,data}}`。
 */
function toAnthropicMessage(message: LlmMessage): {
  role: "user" | "assistant"
  content: unknown[]
} {
  if (message.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: message.toolCallId ?? "",
          content: message.content,
        },
      ],
    }
  }

  const role = message.role === "assistant" ? "assistant" : "user"
  const content: unknown[] = []
  if (message.content !== "") content.push({ type: "text", text: message.content })
  for (const image of message.images ?? []) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: image.mimeType, data: image.base64 },
    })
  }
  // 助手发起的工具调用：Anthropic 要 content 里带 `tool_use` block 原样回传。
  for (const call of message.toolCalls ?? []) {
    let parsedInput: unknown
    try {
      parsedInput = JSON.parse(call.argumentsJson)
    } catch {
      // 参数不是合法 JSON 时给空对象 —— 与 OpenAI 分支"缺参数给 {}"同一个兜底。
      parsedInput = {}
    }
    content.push({ type: "tool_use", id: call.id, name: call.name, input: parsedInput })
  }
  // content 不能为空（Anthropic 会 400）—— 兜一个空文本块。
  if (content.length === 0) content.push({ type: "text", text: "" })
  return { role, content }
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/**
 * 解析工具调用。
 *
 * 形状不对的条目**跳过而不抛**：模型偶尔会给一个没有 `id` 的调用，
 * 抛的话整轮就废了，而跳过之后它下一轮通常就对了。
 * 全部跳过时上层看到 `toolCalls` 为空 → 按"没有工具调用"处理。
 */
function parseToolCalls(raw: unknown): LlmToolCall[] {
  if (!Array.isArray(raw)) return []
  const out: LlmToolCall[] = []
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue
    const call = entry as RawToolCall
    const id = typeof call.id === "string" ? call.id : null
    const name = typeof call.function?.name === "string" ? call.function.name : null
    if (id === null || name === null) continue
    out.push({
      id,
      name,
      // 缺参数时给 "{}" 而不是空串：调用方要 JSON.parse 它
      argumentsJson:
        typeof call.function?.arguments === "string" && call.function.arguments !== ""
          ? call.function.arguments
          : "{}",
    })
  }
  return out
}

export class LlmClient {
  private readonly gate: Semaphore
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly provider: "openai" | "anthropic"
  /** 累计用量。蒸馏进度页要显示"花了多少 token" */
  private totals: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

  constructor(private readonly options: LlmClientOptions) {
    if (options.baseUrl.trim() === "") {
      throw new AppError("CONFIG_INVALID", "LLM baseUrl 未配置", {
        messageKey: "errors:config.invalid",
        messageParams: { detail: "MYCONTEXT_LLM_BASE_URL" },
      })
    }
    this.gate = new Semaphore(options.concurrency ?? 3)
    this.timeoutMs = options.timeoutMs ?? 90_000
    this.maxRetries = options.maxRetries ?? 2
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    this.provider = options.provider ?? "openai"
  }

  usage(): LlmUsage {
    return { ...this.totals }
  }

  /** 一次补全。JSON 模式下会剥围栏，但**不**解析 —— 解析交给调用方（它知道 schema）。 */
  async complete(input: CompleteOptions): Promise<LlmCompletion> {
    const release = await this.gate.acquire()
    try {
      return await this.withRetry(input)
    } finally {
      release()
    }
  }

  /**
   * 带工具的多轮补全。
   *
   * 循环：请求 → 有 `toolCalls` 就执行并把结果作为 `role:"tool"` 追加 →
   * 再请求。没有 `toolCalls` 就返回。
   *
   * 撞轮数上限时**返回最后一次的正文**而不是抛：那时通常已经有足够信息了，
   * 抛会让用户一条草稿都拿不到。轮数进 `rounds` 供调用方记日志。
   *
   * 工具执行失败**不抛**：把错误文本作为工具结果回给模型 ——
   * 它能据此换个问法或者说"查不到"。抛的话整轮废掉，
   * 而一个工具查不到不代表回复写不出来。
   */
  async completeWithTools(
    input: CompleteWithToolsOptions,
  ): Promise<LlmCompletion & { rounds: number; toolResults: { name: string; ok: boolean }[] }> {
    const maxRounds = input.maxRounds ?? 3
    const messages: LlmMessage[] = [...input.messages]
    const toolResults: { name: string; ok: boolean }[] = []
    let last: LlmCompletion | null = null

    for (let round = 0; round < maxRounds; round += 1) {
      const completion = await this.complete({
        messages,
        tools: input.tools,
        ...(input.json === undefined ? {} : { json: input.json }),
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      last = completion

      const calls = completion.toolCalls ?? []
      if (calls.length === 0) {
        return { ...completion, rounds: round + 1, toolResults }
      }

      // 助手那条要带上 tool_calls 原样回传 —— 否则下面的 tool 消息对不上 id
      messages.push({ role: "assistant", content: completion.text, toolCalls: calls })

      for (const call of calls) {
        let output: string
        let ok = true
        try {
          output = await input.execute(call)
        } catch (error) {
          ok = false
          output = `工具执行失败：${error instanceof Error ? error.message : String(error)}`
          this.options.logger?.warn("llm tool failed", { tool: call.name, detail: output })
        }
        toolResults.push({ name: call.name, ok })
        messages.push({ role: "tool", content: output, toolCallId: call.id })
      }
    }

    this.options.logger?.warn("llm tool rounds exhausted", { maxRounds })
    return { ...(last ?? { text: "", usage: this.usage() }), rounds: maxRounds, toolResults }
  }

  private async withRetry(input: CompleteOptions): Promise<LlmCompletion> {
    let lastError: unknown = null

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.once(input)
      } catch (error) {
        lastError = error
        const retryable = error instanceof AppError && error.context?.["retryable"] === true
        if (!retryable || attempt === this.maxRetries) throw error
        /**
         * 指数退避。基数 500ms：网关的限流窗口是秒级，
         * 更短的退避基本等于立刻再撞一次。
         */
        await this.sleep(500 * 2 ** attempt)
        this.options.logger?.warn("llm retry", {
          attempt: attempt + 1,
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new AppError("PROCESS_FAILED", "LLM 调用失败", {})
  }

  private async once(input: CompleteOptions): Promise<LlmCompletion> {
    /**
     * 超时用自己的 AbortController，并与调用方的 signal **联动**。
     *
     * 只用调用方的 signal 就没有超时；只用自己的就无法被外部取消
     * （用户关掉蒸馏页时那些在途请求会继续烧配额）。
     */
    const controller = new AbortController()
    // ★ 调用方给了 `timeoutMs` 就用它（见 `CompleteOptions.timeoutMs`）
    const timeoutMs = input.timeoutMs ?? this.timeoutMs
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = () => controller.abort()
    input.signal?.addEventListener("abort", onAbort, { once: true })

    try {
      return this.provider === "anthropic"
        ? await this.requestAnthropic(input, controller.signal)
        : await this.requestOpenAi(input, controller.signal)
    } catch (error) {
      // AbortError 归一成可识别的超时/取消：调用方要能区分它与业务失败
      if (error instanceof Error && error.name === "AbortError") {
        throw new AppError("PROCESS_FAILED", "LLM 调用超时或被取消", {
          messageKey: "errors:byCode.PROCESS_FAILED",
          // 外部取消不该重试；超时可以。用调用方 signal 的状态区分
          // ★ 报**这一次实际用的**超时，不是 client 默认 —— 否则日志里写着 90s
          // 而实际等了 300s，排查时会往错的方向找
          context: { retryable: input.signal?.aborted !== true, timeoutMs },
        })
      }
      if (error instanceof AppError) throw error
      // 网络层错误（DNS/连接重置）值得重试
      throw new AppError("PROCESS_FAILED", "LLM 网络错误", {
        messageKey: "errors:byCode.PROCESS_FAILED",
        context: {
          retryable: true,
          detail: error instanceof Error ? error.message : String(error),
        },
      })
    } finally {
      clearTimeout(timer)
      input.signal?.removeEventListener("abort", onAbort)
    }
  }

  /** 把这一次的用量并进累计（进度页要显示花了多少 token）。 */
  private accumulate(usage: LlmUsage): void {
    this.totals = {
      promptTokens: this.totals.promptTokens + usage.promptTokens,
      completionTokens: this.totals.completionTokens + usage.completionTokens,
      totalTokens: this.totals.totalTokens + usage.totalTokens,
    }
  }

  /**
   * 空正文归一成可重试的 `PARSE_FAILED`（两条协议共用）。
   *
   * 只在**没有工具调用**时才算空 —— 有 `tool_use`/`tool_calls` 时空正文是正常的
   * （模型在等工具结果）。带上 `finishReason`：`length` 是 maxTokens 太小、
   * `stop`/`end_turn` 是模型真没写正文，两者处置相反（见文件头/原 OpenAI 分支）。
   */
  private emptyContentError(
    finishReason: string,
    reasoningLength: number,
    maxTokens?: number,
  ): never {
    throw new AppError("PARSE_FAILED", "LLM 返回空内容", {
      messageKey: "errors:byCode.PARSE_FAILED",
      context: {
        retryable: true,
        finishReason,
        reasoningLength,
        maxTokens: maxTokens ?? null,
      },
    })
  }

  /** OpenAI 兼容：`POST {base}/v1/chat/completions`。 */
  private async requestOpenAi(input: CompleteOptions, signal: AbortSignal): Promise<LlmCompletion> {
    const body: Record<string, unknown> = {
      model: this.options.model,
      /**
       * 消息按 OpenAI 兼容形状转写。
       *
       * 我们内部用 `toolCalls` / `toolCallId`（驼峰），线上是
       * `tool_calls` / `tool_call_id`（下划线）—— 转写只在这一处做，
       * 业务侧不用记两套命名。
       */
      messages: input.messages.map((message) => {
        /**
         * ★ 有图时 `content` 从 string 变成多模态数组。
         *
         * 形状是 OpenAI 兼容协议的 `image_url` + data URI（实测这个网关上
         * `qwen3.7-plus` / `gpt-5.6-sol` 都认）。文本块**放第一个** ——
         * 正文里会有「[图片 1]」这类标注，模型要先读到它才知道图属于谁。
         *
         * 没有图时保持裸字符串：那是绝大多数请求，多包一层数组会让
         * 每条日志、每次重试的 body 都变大，且部分网关对两种形状的
         * 兼容程度不同（能用字符串就别用数组）。
         */
        const hasImages = message.images !== undefined && message.images.length > 0
        const content: unknown = hasImages
          ? [
              { type: "text", text: message.content },
              ...(message.images ?? []).map((image) => ({
                type: "image_url",
                image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
              })),
            ]
          : message.content
        const wire: Record<string, unknown> = { role: message.role, content }
        if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
          wire["tool_calls"] = message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.argumentsJson },
          }))
        }
        if (message.toolCallId !== undefined) wire["tool_call_id"] = message.toolCallId
        return wire
      }),
    }
    if (input.temperature !== undefined) body["temperature"] = input.temperature
    if (input.maxTokens !== undefined) body["max_tokens"] = input.maxTokens
    // 开着也仍可能带围栏（见文件头），所以下面还要剥
    if (input.json === true) body["response_format"] = { type: "json_object" }
    if (input.tools !== undefined && input.tools.length > 0) {
      body["tools"] = input.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }))
    }

    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500)
      throw new AppError("PROCESS_FAILED", `LLM 返回 ${String(response.status)}`, {
        messageKey: "errors:byCode.PROCESS_FAILED",
        context: { status: response.status, retryable: isRetryable(response.status), detail },
      })
    }

    const parsed = (await response.json()) as RawResponse
    /**
     * ★ HTTP 200 但 body 里有 error —— 实测过的形态。
     * 不查这一条会把错误当成"content 是 undefined"继续往下传，
     * 于是抽取阶段得到 0 条结论而没有任何错误。
     */
    if (parsed.error !== undefined && parsed.error !== null) {
      throw new AppError("PROCESS_FAILED", "LLM 返回业务错误", {
        messageKey: "errors:byCode.PROCESS_FAILED",
        // 业务错误不重试：同样的请求会得到同样的错误
        context: { detail: JSON.stringify(parsed.error).slice(0, 500) },
      })
    }

    const choice = parsed.choices?.[0]
    const message = choice?.message
    const content = typeof message?.content === "string" ? message.content : ""
    const toolCalls = parseToolCalls(message?.tool_calls)
    /**
     * ★ 有工具调用时**空正文是正常的**（模型在等工具结果）。
     *
     * 不加这个条件的话每次工具调用都会被当成"返回空内容"而重试 ——
     * 表现是每轮工具调用都慢三倍，而日志里只有几条 retry。
     */
    if (content.trim() === "" && toolCalls.length === 0) {
      const finishForEmpty =
        typeof choice?.finish_reason === "string" ? choice.finish_reason : "unknown"
      const reasoningLength =
        typeof message?.reasoning_content === "string" ? message.reasoning_content.length : 0
      this.emptyContentError(finishForEmpty, reasoningLength, input.maxTokens)
    }

    const usage: LlmUsage = {
      promptTokens: num(parsed.usage?.prompt_tokens),
      completionTokens: num(parsed.usage?.completion_tokens),
      totalTokens: num(parsed.usage?.total_tokens),
    }
    this.accumulate(usage)

    const reasoning =
      typeof message?.reasoning_content === "string" ? message.reasoning_content : undefined
    const finishReason =
      typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined
    return {
      text: input.json === true ? stripCodeFence(content) : content,
      usage,
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
      ...(finishReason === undefined ? {} : { finishReason }),
    }
  }

  /**
   * Anthropic Messages：`POST {base}/v1/messages`。
   *
   * ## 与 OpenAI 分支的形状差异（都在这一处收口）
   *
   * · **鉴权**：`x-api-key` + `anthropic-version`，不是 `Authorization: Bearer`；
   * · **system**：顶层 `system` 字段，不作为一条 `role:"system"` 消息；
   * · **content**：永远是 block 数组（`{type:"text"}` / `{type:"image"}` /
   *   `{type:"tool_use"}` / `{type:"tool_result"}`），不是裸字符串；
   * · **图片**：`{type:"image",source:{type:"base64",media_type,data}}`，
   *   不是 OpenAI 的 `image_url` data URI；
   * · **工具**：声明是 `{name,description,input_schema}`；助手回来的调用是
   *   content 里的 `tool_use` block（`id`/`name`/`input` 对象）；回传结果是
   *   `role:"user"` + `tool_result` block（`tool_use_id` + 文本），**不是**
   *   OpenAI 的 `role:"tool"`；
   * · **JSON 模式**：Messages API 没有 `response_format` —— 靠 prompt 约束 +
   *   我们仍 `stripCodeFence`（与 OpenAI 分支同一个兜底）；
   * · **usage**：`input_tokens`/`output_tokens`，没有 total（我们自己相加）；
   * · **结束原因**：`stop_reason`（`end_turn`/`max_tokens`/`tool_use`）。
   */
  private async requestAnthropic(
    input: CompleteOptions,
    signal: AbortSignal,
  ): Promise<LlmCompletion> {
    // system 提取成顶层；其余消息转 Anthropic block 形状。
    const systemText = input.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n")

    const messages = input.messages
      .filter((m) => m.role !== "system")
      .map((message) => toAnthropicMessage(message))

    const body: Record<string, unknown> = {
      model: this.options.model,
      // Anthropic **必填** max_tokens —— 缺省给一个足够大的兜底（与 OpenAI 分支
      // "不传就用网关默认"不同，这里不传会直接 400）。
      max_tokens: input.maxTokens ?? 4096,
      messages,
    }
    if (systemText.trim() !== "") body["system"] = systemText
    if (input.temperature !== undefined) body["temperature"] = input.temperature
    if (input.tools !== undefined && input.tools.length > 0) {
      body["tools"] = input.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }))
    }

    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/v1/messages`
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.options.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500)
      throw new AppError("PROCESS_FAILED", `LLM 返回 ${String(response.status)}`, {
        messageKey: "errors:byCode.PROCESS_FAILED",
        context: { status: response.status, retryable: isRetryable(response.status), detail },
      })
    }

    const parsed = (await response.json()) as RawAnthropicResponse
    // 与 OpenAI 分支一致：HTTP 200 但 body 是 error 信封也要当失败（不重试）。
    if (parsed.type === "error" || (parsed.error !== undefined && parsed.error !== null)) {
      throw new AppError("PROCESS_FAILED", "LLM 返回业务错误", {
        messageKey: "errors:byCode.PROCESS_FAILED",
        context: { detail: JSON.stringify(parsed.error ?? parsed).slice(0, 500) },
      })
    }

    // content blocks → 文本（拼所有 text block）+ 工具调用（tool_use block）。
    const blocks = Array.isArray(parsed.content) ? parsed.content : []
    const text = blocks
      .filter((b): b is { type: "text"; text: string } => isRecord(b) && b.type === "text")
      .map((b) => (typeof b.text === "string" ? b.text : ""))
      .join("")
    const toolCalls: LlmToolCall[] = blocks
      .filter((b): b is Record<string, unknown> => isRecord(b) && b.type === "tool_use")
      .map((b) => ({
        id: typeof b["id"] === "string" ? b["id"] : "",
        name: typeof b["name"] === "string" ? b["name"] : "",
        // Anthropic 的 `input` 是**对象**，我们对外统一成 JSON 串（与 OpenAI 一致）
        argumentsJson: JSON.stringify(b["input"] ?? {}),
      }))
      .filter((c) => c.id !== "" && c.name !== "")

    const stopReason = typeof parsed.stop_reason === "string" ? parsed.stop_reason : "unknown"
    if (text.trim() === "" && toolCalls.length === 0) {
      // Anthropic 没有单独的 reasoning 字段，传 0；stop_reason=max_tokens 对应 length。
      this.emptyContentError(stopReason, 0, input.maxTokens)
    }

    const usage: LlmUsage = {
      promptTokens: num(parsed.usage?.input_tokens),
      completionTokens: num(parsed.usage?.output_tokens),
      totalTokens: num(parsed.usage?.input_tokens) + num(parsed.usage?.output_tokens),
    }
    this.accumulate(usage)

    return {
      text: input.json === true ? stripCodeFence(text) : text,
      usage,
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
      finishReason: stopReason,
    }
  }
}
