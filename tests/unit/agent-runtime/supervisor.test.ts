/**
 * ACP session 生命周期：resume 优先、失败降级重建、淘汰即撤 token。
 *
 * ★ 降级重建是**常态而非异常**：opencode 的 session 状态在它自己的 storage 里，
 * 换机器 / 清缓存 / 升级都会让 sessionId 失效。
 * 设计上把「我们的会话」与「opencode 的 session」解耦（`acp_session_id` 可为空），
 * 所以用户看到的历史一条不少 —— 渲染的是我们的库。
 */
import { describe, expect, it, vi } from "vitest"
import { ManualClock } from "@mycontext/kernel"
import { AcpSupervisor, McpAuth, type SessionRecord } from "@mycontext/agent-runtime"

const START = 1_785_000_000_000

function setup(options: { resumeFails?: boolean } = {}) {
  const clock = new ManualClock(START)
  const mcpAuth = new McpAuth({ clock })
  const changedIds: { recordId: string; acpSessionId: string }[] = []
  const suppressionCalls: string[] = []
  let suppressionEnded = 0

  const request = vi.fn((method: string, params?: unknown) => {
    if (method === "session/resume") {
      if (options.resumeFails === true) return Promise.reject(new Error("session not found"))
      return Promise.resolve({})
    }
    if (method === "session/new") return Promise.resolve({ sessionId: "acp-new" })
    if (method === "session/close") return Promise.resolve({})
    return Promise.resolve({ method, params })
  })

  const supervisor = new AcpSupervisor({
    client: { request } as unknown as ConstructorParameters<typeof AcpSupervisor>[0]["client"],
    mcpAuth,
    mcpPort: 51234,
    onSessionIdChanged: (recordId, acpSessionId) => changedIds.push({ recordId, acpSessionId }),
    beginReplaySuppression: (recordId) => {
      suppressionCalls.push(recordId)
      return () => {
        suppressionEnded += 1
      }
    },
  })

  return {
    supervisor,
    mcpAuth,
    request,
    changedIds,
    suppressionCalls,
    endedCount: () => suppressionEnded,
  }
}

const record: SessionRecord = {
  id: "our-session-1",
  acpSessionId: "acp-existing",
  cwd: "/ws/search/our-session-1",
  kind: "search",
  scopeId: "our-session-1",
}

describe("resume 优先于 load", () => {
  it("已有 acpSessionId 时走 resume，不 new", async () => {
    const context = setup()
    const result = await context.supervisor.ensureSession(record)

    expect(result).toEqual({ acpSessionId: "acp-existing", rebuilt: false })
    const methods = context.request.mock.calls.map((call) => call[0] as string)
    expect(methods).toEqual(["session/resume"])
    // 刻意不用 load：它会 replay 全部历史，而我们的 UI 读自己的库
    expect(methods).not.toContain("session/load")
  })

  it("resume 前后进/出 replay 抑制窗口（即使它号称不 replay）", async () => {
    const context = setup()
    await context.supervisor.ensureSession(record)
    expect(context.suppressionCalls).toEqual(["our-session-1"])
    expect(context.endedCount()).toBe(1)
  })

  it("resume 时重传 mcpServers（token 会轮换，旧的已被撤销）", async () => {
    const context = setup()
    await context.supervisor.ensureSession(record)
    const params = context.request.mock.calls[0]?.[1] as { mcpServers: unknown[] }
    expect(params.mcpServers.length).toBe(1)
  })
})

describe("★ 降级重建（opencode session 失效是常态）", () => {
  it("resume 失败 → session/new + 更新我们的 id + 标记待回灌", async () => {
    const context = setup({ resumeFails: true })
    const result = await context.supervisor.ensureSession(record)

    expect(result).toEqual({ acpSessionId: "acp-new", rebuilt: true })
    expect(context.changedIds).toEqual([{ recordId: "our-session-1", acpSessionId: "acp-new" }])
    // 下次 prompt 时要把我们库里的历史作为 content block 回灌
    expect(context.supervisor.needsContextReplay("acp-new")).toBe(true)
  })

  it("回灌一次后清除标记（不会每轮都回灌）", async () => {
    const context = setup({ resumeFails: true })
    await context.supervisor.ensureSession(record)
    context.supervisor.markContextReplayed("acp-new")
    expect(context.supervisor.needsContextReplay("acp-new")).toBe(false)
  })

  it("首次建会话（acpSessionId 为 null）直接 new，不试 resume", async () => {
    const context = setup()
    const fresh: SessionRecord = { ...record, acpSessionId: null }
    const result = await context.supervisor.ensureSession(fresh)

    expect(result.rebuilt).toBe(true)
    expect(context.request.mock.calls.map((call) => call[0] as string)).toEqual(["session/new"])
    // 没有历史要 replay，所以不该进抑制窗口
    expect(context.suppressionCalls).toEqual([])
  })

  it("失败分支也正确退出抑制窗口（finally）", async () => {
    const context = setup({ resumeFails: true })
    await context.supervisor.ensureSession(record)
    expect(context.endedCount()).toBe(1)
  })
})

describe("MCP 注入", () => {
  it("走 remote 形态指向本机 MCP server（工具的唯一注入通道）", async () => {
    const context = setup()
    await context.supervisor.ensureSession({ ...record, acpSessionId: null })
    const params = context.request.mock.calls[0]?.[1] as {
      mcpServers: { type: string; url: string; headers: { name: string; value: string }[] }[]
    }
    const server = params.mcpServers[0]
    // ★ 必须是 "http"：实测 "remote" 被 ACP 线上 schema 拒（-32602）。
    // 见 supervisor.ts 的 McpServerSpec 注释 —— 那是读源码会读错的一处。
    expect(server?.type).toBe("http")
    expect(server?.url).toBe("http://127.0.0.1:51234/mcp")
    expect(server?.headers[0]?.name).toBe("Authorization")
    expect(server?.headers[0]?.value.startsWith("Bearer ")).toBe(true)
  })

  /**
   * ★ M2.8：搜索第一期 kl 走 opencode **skill**（`kl` CLI），不注入宿主 MCP 工具。
   *
   * `hostToolsEnabled:false` → `mcpServersFor` 返回空数组。关掉的是"注入哪些工具",
   * **不是** `type:"http"` 那个字段值（那个有真进程测试守着，恒不变）——
   * 空数组和一个 http server 是同一段代码的两个分支。
   */
  it("hostToolsEnabled:false 时 mcpServers 为空数组（skill-only）", async () => {
    const clock = new ManualClock(START)
    const request = vi.fn((method: string, _params?: unknown) => {
      if (method === "session/new") return Promise.resolve({ sessionId: "acp-new" })
      return Promise.resolve({})
    })
    const supervisor = new AcpSupervisor({
      client: { request } as unknown as ConstructorParameters<typeof AcpSupervisor>[0]["client"],
      mcpAuth: new McpAuth({ clock }),
      mcpPort: 51234,
      hostToolsEnabled: false,
      onSessionIdChanged: () => {},
      beginReplaySuppression: () => () => {},
    })
    await supervisor.ensureSession({ ...record, acpSessionId: null })
    const params = request.mock.calls[0]?.[1] as { mcpServers: unknown[] }
    expect(params.mcpServers).toEqual([])
  })

  /**
   * ★ token 按 scopeId 签发：共用 token 会让 local_recall 对任一 agent
   * 全库可见 → 群聊里的一句 injection 就能召回单聊内容。
   */
  it("不同 scope 拿到不同 token", async () => {
    const context = setup()
    await context.supervisor.ensureSession({
      ...record,
      acpSessionId: null,
      kind: "persona",
      scopeId: "conv-a",
    })
    await context.supervisor.ensureSession({
      ...record,
      id: "our-2",
      acpSessionId: null,
      kind: "persona",
      scopeId: "conv-b",
    })

    const tokens = context.request.mock.calls.map((call) => {
      const params = call[1] as { mcpServers: { headers: { value: string }[] }[] }
      return params.mcpServers[0]?.headers[0]?.value
    })
    expect(tokens[0]).not.toBe(tokens[1])
    expect(context.mcpAuth.activeCount()).toBe(2)
  })
})

describe("★ dispose 必须自己撤 token", () => {
  /**
   * 实测 closeSession（acp/service.ts:339-348）只做 session.remove +
   * registeredMcp.delete + sessionSnapshots.delete + abortBackingSession，
   * **没有 mcp.disconnect** —— 不主动撤的话，被淘汰会话的连接与 token
   * 会存活到进程退出（连接泄漏 + token 永不轮换）。
   */
  it("close 之后 token 立即失效", async () => {
    const context = setup()
    await context.supervisor.ensureSession({ ...record, acpSessionId: null })
    expect(context.mcpAuth.activeCount()).toBe(1)

    await context.supervisor.dispose({ ...record, acpSessionId: "acp-new" })
    expect(context.mcpAuth.activeCount()).toBe(0)
  })

  it("session/close 失败也要撤 token（token 泄漏比僵尸 session 更危险）", async () => {
    const context = setup()
    await context.supervisor.ensureSession({ ...record, acpSessionId: null })
    context.request.mockImplementation((method: string) => {
      if (method === "session/close") return Promise.reject(new Error("already gone"))
      return Promise.resolve({})
    })

    await expect(
      context.supervisor.dispose({ ...record, acpSessionId: "acp-new" }),
    ).resolves.toBeUndefined()
    expect(context.mcpAuth.activeCount()).toBe(0)
  })

  it("acpSessionId 为 null 时也撤 token（可能建过又失败了）", async () => {
    const context = setup()
    await context.supervisor.ensureSession({ ...record, acpSessionId: null })
    await context.supervisor.dispose({ ...record, acpSessionId: null })
    expect(context.mcpAuth.activeCount()).toBe(0)
  })
})
