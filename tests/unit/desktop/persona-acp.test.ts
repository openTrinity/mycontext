/**
 * PersonaAcp —— Cursor Agent 编排（假 session，不打真网）。
 *
 * 锁：available()、turn 文本收集、失败返回 null、带图降级。
 */
import { afterEach, describe, expect, it } from "vitest"
import { ManualClock, createLogger } from "@mycontext/kernel"
import type { CursorSession, CursorSessionOptions } from "@mycontext/agent-runtime"
import type { ProcessRunner, RuntimeEnv } from "@mycontext/runtime-env"
import { PersonaAcp } from "../../../apps/desktop/src/main/services/persona-acp.js"

const NOW = 1_785_000_000_000
const logger = createLogger("test", { level: "error" })

afterEach(() => {})

function fakeCursorFactory(options: { chunks?: string[]; error?: string }): {
  create: (opts: CursorSessionOptions) => CursorSession
} {
  return {
    create(opts: CursorSessionOptions): CursorSession {
      return {
        async ensure() {},
        async prompt(_message: string, turnId: string) {
          const chunks = options.chunks ?? ["好", "的，", "帮你看一下"]
          for (const text of chunks) {
            opts.onEvent?.({ type: "text_delta", turnId, text })
          }
          if (options.error) {
            opts.onEvent?.({ type: "error", turnId, message: options.error })
            opts.onEvent?.({ type: "turn_end", turnId })
            return { text: "", error: options.error }
          }
          opts.onEvent?.({ type: "turn_end", turnId })
          return { text: chunks.join("") }
        },
        async cancel() {},
        async close() {},
      } as unknown as CursorSession
    },
  }
}

function makeAcp(options: {
  hasAgentKey: boolean
  factory?: ReturnType<typeof fakeCursorFactory>
  onTrace?: ConstructorParameters<typeof PersonaAcp>[0]["onTrace"]
}) {
  const factory = options.factory ?? fakeCursorFactory({})
  return new PersonaAcp({
    clock: new ManualClock(NOW),
    logger,
    runtime: {} as RuntimeEnv,
    processes: {} as ProcessRunner,
    dirs: () => ({
      workspaceRoot: "/tmp/persona-ws-test",
      home: "/tmp/persona-ws-test/agent-home",
      npmCache: "/tmp/persona-npm-cache",
    }),
    klRoot: "/fake/kl",
    klPort: 8200,
    getCursorApiKey: () => (options.hasAgentKey ? "sk-test" : ""),
    getCursorRuntime: () => "local",
    createCursorSession: (opts) => factory.create(opts),
    ...(options.onTrace === undefined ? {} : { onTrace: options.onTrace }),
  })
}

describe("★ 降级信号：无 Agent Key 时 available() 是 false", () => {
  it("有 Key → true", () => {
    expect(makeAcp({ hasAgentKey: true }).available()).toBe(true)
  })

  it("★ 无 Key → false（compose 据此走直连）", () => {
    expect(makeAcp({ hasAgentKey: false }).available()).toBe(false)
    expect(makeAcp({ hasAgentKey: false }).degradedReason()).toBe("cursor_api_key_missing")
  })
})

describe("★★ turn 生命周期与文本收集", () => {
  it("拼多个 chunk 成一整段文本", async () => {
    const acp = makeAcp({ hasAgentKey: true })
    const result = await acp.turn({ conversationId: "c1", prompt: "回一下最新那条" })
    expect(result?.text).toBe("好的，帮你看一下")
    expect(result?.toolNames).toEqual([])
  })

  it("★ 0-token 返回 text=null，不是空串", async () => {
    const factory = fakeCursorFactory({ chunks: [] })
    const acp = makeAcp({ hasAgentKey: true, factory })
    const empty = await acp.turn({ conversationId: "c1", prompt: "x" })
    expect(empty?.text).toBeNull()
  })

  it("turn 失败 → null（上层走直连）", async () => {
    const factory = fakeCursorFactory({ error: "boom" })
    const acp = makeAcp({ hasAgentKey: true, factory })
    expect(await acp.turn({ conversationId: "c1", prompt: "x" })).toBeNull()
  })

  it("带图 → null（Ruling：Cursor 路径不接多模态）", async () => {
    const acp = makeAcp({ hasAgentKey: true })
    expect(
      await acp.turn({
        conversationId: "c1",
        prompt: "看图",
        images: [{ base64: "aaaa", mimeType: "image/png", name: "a.png" }],
      }),
    ).toBeNull()
  })

  it("onTrace 收到过程 items", async () => {
    const traces: { done: boolean; count: number }[] = []
    const acp = makeAcp({
      hasAgentKey: true,
      onTrace: ({ items, done }) => {
        traces.push({ done, count: items.length })
      },
    })
    await acp.turn({ conversationId: "c1", prompt: "hi" })
    expect(traces.some((t) => t.done)).toBe(true)
  })
})
