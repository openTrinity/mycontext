/**
 * ACP 的 JSON-RPC 帧编解码（含**反向**帧）。
 *
 * 用 fake stdio 而不是真起 opencode：这一层测的是协议处理
 * （请求/响应配对、通知分派、反向请求应答、超时、乱序、关闭），
 * 而这些用真进程测既慢又不稳，且真进程测不出「迟到的响应」这类情况。
 *
 * 真实进程的 e2e 在 `tests/externals/`（不进门禁，见 §4.0.5）。
 */
import { describe, expect, it, vi } from "vitest"
import { AcpClient, createReverseHandlers } from "@mycontext/agent-runtime"
import type { DuplexHandle } from "@mycontext/runtime-env"
import { isAppError } from "@mycontext/kernel"

/** 假传输：记录写出去的行，并允许测试注入收到的行。 */
function fakeTransport() {
  const written: string[] = []
  const handle: DuplexHandle = {
    writeLine: (line) => {
      written.push(line)
      return Promise.resolve()
    },
    close: () => Promise.resolve(),
    alive: true,
    pid: 1234,
  }
  const parsed = (): Record<string, unknown>[] =>
    written.map((line) => JSON.parse(line) as Record<string, unknown>)
  return { handle, written, parsed }
}

describe("请求与响应配对", () => {
  it("请求带自增 id，响应按 id 归位", async () => {
    const transport = fakeTransport()
    const client = new AcpClient({ transport: transport.handle })

    const first = client.request<{ ok: boolean }>("session/new", { cwd: "/ws" })
    const second = client.request<{ n: number }>("session/list")

    const sent = transport.parsed() as unknown as { id: number; method: string }[]
    expect(sent.map((frame) => frame.method)).toEqual(["session/new", "session/list"])
    expect(sent[0]?.id).not.toBe(sent[1]?.id)

    // 刻意**乱序**回响应：id 归位不该依赖到达顺序
    client.handleLine(JSON.stringify({ jsonrpc: "2.0", id: sent[1]?.id, result: { n: 2 } }))
    client.handleLine(JSON.stringify({ jsonrpc: "2.0", id: sent[0]?.id, result: { ok: true } }))

    expect(await first).toEqual({ ok: true })
    expect(await second).toEqual({ n: 2 })
  })

  it("错误响应变成 AppError", async () => {
    const transport = fakeTransport()
    const client = new AcpClient({ transport: transport.handle })
    const promise = client.request("session/resume", { sessionId: "gone" })
    const sent = transport.parsed() as unknown as { id: number }[]
    client.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: sent[0]?.id,
        error: { code: -32000, message: "session not found" },
      }),
    )
    await expect(promise).rejects.toThrow(/session not found/)
  })

  it("超时抛 PROCESS_TIMEOUT 且标为可重试", async () => {
    const transport = fakeTransport()
    const client = new AcpClient({ transport: transport.handle, requestTimeoutMs: 10 })
    try {
      await client.request("session/prompt")
      expect.unreachable("应当超时")
    } catch (error) {
      expect(isAppError(error)).toBe(true)
      if (isAppError(error)) {
        expect(error.code).toBe("PROCESS_TIMEOUT")
        expect(error.retryable).toBe(true)
      }
    }
  })

  it("迟到的响应被丢弃而不是崩掉", async () => {
    const transport = fakeTransport()
    const client = new AcpClient({ transport: transport.handle, requestTimeoutMs: 5 })
    await client.request("x").catch(() => undefined)
    // 超时后才到的响应
    expect(() =>
      client.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })),
    ).not.toThrow()
  })

  /**
   * ★★ 按方法覆盖超时（`methodTimeouts`）。
   *
   * 存在的理由见 `AcpClientOptions.methodTimeouts`：一轮 agent turn 的耗时
   * 取决于模型决定调几次工具，那不是能预估的量，而原来它与 `initialize`
   * 这类协议动作共用一个 120s —— 实测掐掉过一次**快要成功**的长查询
   * （116s 时第 8 条检索还在跑，本地数据已经搜到了，只是没来得及归纳）。
   */
  describe("★★ 按方法覆盖超时", () => {
    it("★ null = 不设限：全局超时到点了也不拒", async () => {
      const transport = fakeTransport()
      const client = new AcpClient({
        transport: transport.handle,
        requestTimeoutMs: 10,
        methodTimeouts: { "session/prompt": null },
      })
      const promise = client.request<{ done: boolean }>("session/prompt")
      // 等到远超全局超时（10ms）—— 不设限的话这时它必须还在等
      await new Promise((r) => setTimeout(r, 60))

      const sent = transport.parsed() as unknown as { id: number }[]
      client.handleLine(JSON.stringify({ jsonrpc: "2.0", id: sent[0]?.id, result: { done: true } }))
      /**
       * ★ 60ms 后才回的响应仍然被接住。
       *
       * 这一条断了会 reject（PROCESS_TIMEOUT）—— 也就是"不设限"没生效。
       * 而生产上那个失效是静默的：用户只看到搜索降级成本地召回。
       */
      await expect(promise).resolves.toEqual({ done: true })
    })

    it("★ 同一个 client 上，没被覆盖的方法照常超时", async () => {
      const transport = fakeTransport()
      const client = new AcpClient({
        transport: transport.handle,
        requestTimeoutMs: 10,
        methodTimeouts: { "session/prompt": null },
      })
      /**
       * 这一条锁住修复**没有把所有请求都变成无限等**。
       *
       * `initialize` 卡住是真故障（子进程没起来 / 协议不匹配），
       * 它必须仍然会超时 —— 否则一个起不来的 opencode 会让调用方永久挂住。
       */
      await expect(client.request("initialize")).rejects.toThrow(/超时/)
    })

    it("覆盖成一个数字时按那个数字算（不是只能给 null）", async () => {
      const transport = fakeTransport()
      const client = new AcpClient({
        transport: transport.handle,
        requestTimeoutMs: 10_000,
        methodTimeouts: { "session/dispose": 5 },
      })
      // 全局 10s 但这个方法只给 5ms → 立刻超时
      await expect(client.request("session/dispose")).rejects.toThrow(/超时/)
    })

    it("★ 不设限的请求靠 close() 终止（永不超时 ≠ 永远挂住）", async () => {
      const transport = fakeTransport()
      const client = new AcpClient({
        transport: transport.handle,
        methodTimeouts: { "session/prompt": null },
      })
      const promise = client.request("session/prompt")
      /**
       * ★★ 这是删掉墙钟超时之后**唯一**的终止保证，所以必须锁住。
       *
       * 判据从"猜它太慢"换成了"连接确实没了" —— 而后者只有在
       * `close()` 真的拒掉在途请求时才成立。这条断了的表现是
       * 退出应用/停服务时有一个 promise 永远不 settle。
       */
      client.close()
      await expect(promise).rejects.toThrow(/已关闭/)
    })
  })

  it("关闭时拒绝所有在途请求（否则调用方永远等）", async () => {
    const transport = fakeTransport()
    const client = new AcpClient({ transport: transport.handle })
    const promise = client.request("session/prompt")
    expect(client.pendingCount).toBe(1)
    client.close()
    await expect(promise).rejects.toThrow()
    expect(client.pendingCount).toBe(0)
  })

  it("关闭后再发请求直接抛错", async () => {
    const transport = fakeTransport()
    const client = new AcpClient({ transport: transport.handle })
    client.close()
    await expect(client.request("x")).rejects.toThrow(/已关闭/)
  })
})

describe("通知分派", () => {
  it("无 id 的消息作为通知分派（事件流入口）", () => {
    const onNotification = vi.fn()
    const transport = fakeTransport()
    const client = new AcpClient({ transport: transport.handle, onNotification })

    client.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionUpdate: "agent_message_chunk", text: "hi" },
      }),
    )
    expect(onNotification).toHaveBeenCalledWith("session/update", {
      sessionUpdate: "agent_message_chunk",
      text: "hi",
    })
  })

  it("非 JSON 行只记日志不抛错（外部进程会打诊断输出）", () => {
    const transport = fakeTransport()
    const client = new AcpClient({ transport: transport.handle })
    expect(() => client.handleLine("INFO starting up")).not.toThrow()
    expect(() => client.handleLine("")).not.toThrow()
  })
})

describe("★ 反向请求（不实现会让所有工具调用被静默拒绝）", () => {
  it("白名单工具的授权请求回 always", async () => {
    const transport = fakeTransport()
    const handlers = createReverseHandlers({ kind: "search" })
    const client = new AcpClient({
      transport: transport.handle,
      reverseHandlers: {
        "session/request_permission": (params) =>
          handlers.requestPermission(params as { toolName: string }),
      },
    })

    client.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "session/request_permission",
        params: { toolName: "mycontext_local_recall" },
      }),
    )
    // 等一个 microtask：handler 是 async 的
    await Promise.resolve()
    await Promise.resolve()

    const reply = transport.parsed().at(-1) as unknown as { id: number; result: unknown }
    expect(reply.id).toBe(99)
    expect(reply.result).toEqual({ outcome: "selected", optionId: "always" })
  })

  it("非白名单工具回 cancelled", async () => {
    const transport = fakeTransport()
    const handlers = createReverseHandlers({ kind: "search" })
    const client = new AcpClient({
      transport: transport.handle,
      reverseHandlers: {
        "session/request_permission": (params) =>
          handlers.requestPermission(params as { toolName: string }),
      },
    })
    client.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "session/request_permission",
        params: { toolName: "bash" },
      }),
    )
    await Promise.resolve()
    await Promise.resolve()
    const reply = transport.parsed().at(-1) as unknown as { result: unknown }
    expect(reply.result).toEqual({ outcome: "cancelled" })
  })

  it("写文件请求回 JSON-RPC 错误（handler 抛 FORBIDDEN）", async () => {
    const transport = fakeTransport()
    const handlers = createReverseHandlers({ kind: "persona" })
    const client = new AcpClient({
      transport: transport.handle,
      reverseHandlers: {
        "fs/write_text_file": () => handlers.writeTextFile(),
      },
    })
    client.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 7, method: "fs/write_text_file", params: {} }),
    )
    await Promise.resolve()
    await Promise.resolve()
    const reply = transport.parsed().at(-1) as unknown as { id: number; error: { message: string } }
    expect(reply.id).toBe(7)
    expect(reply.error.message).toContain("不允许写文件")
  })

  /**
   * 未实现的反向方法必须**回** method-not-found 而不是静默不回：
   * 不回的话对端会一直等，而这个"卡住"极难归因到"我们没实现某个反向方法"。
   */
  it("未注册的反向方法回 -32601 而不是静默不回", async () => {
    const transport = fakeTransport()
    const client = new AcpClient({ transport: transport.handle, reverseHandlers: {} })
    client.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "session/unknown" }))
    await Promise.resolve()
    await Promise.resolve()
    const reply = transport.parsed().at(-1) as unknown as { id: number; error: { code: number } }
    expect(reply.id).toBe(5)
    expect(reply.error.code).toBe(-32601)
  })
})

describe("通知发送", () => {
  it("notify 不带 id（不期待响应）", async () => {
    const transport = fakeTransport()
    const client = new AcpClient({ transport: transport.handle })
    await client.notify("session/cancel", { sessionId: "s1" })
    const sent = transport.parsed()[0] ?? {}
    expect(sent["id"]).toBeUndefined()
    expect(sent["method"]).toBe("session/cancel")
  })
})
