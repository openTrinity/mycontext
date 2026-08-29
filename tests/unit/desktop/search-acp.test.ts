/**
 * SearchService 的 Cursor Agent 接线：注入假 CursorSession，不打真网。
 *
 * 验证：
 *  1. 流式 text_delta → reducer → 落库拼成一条 assistant message；
 *  2. turn_end 由 session.prompt 结束时发出，状态 idle、degradedReason null；
 *  3. 无 API Key → recallOnly，degradedReason 非空；
 *  4. cancel → session.cancel()。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ManualClock, createLogger } from "@mycontext/kernel"
import { openStore, VAULT_MIGRATIONS, type StoreHandle } from "@mycontext/store"
import type { CursorSession, CursorSessionOptions } from "@mycontext/agent-runtime"
import type { ProcessRunner, RuntimeEnv } from "@mycontext/runtime-env"
import { SearchService } from "@main/services/search.service.js"

const dirs: string[] = []
const NOW = 1_785_000_000_000

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function openVaultDb(): StoreHandle {
  const dir = mkdtempSync(join(tmpdir(), "mycontext-search-"))
  dirs.push(dir)
  return openStore({ path: join(dir, "vault.sqlite"), migrations: VAULT_MIGRATIONS })
}

function fakeCursorFactory(options: {
  chunks?: string[]
  turnChunks?: string[][]
  error?: string
  onPromptInFlight?: () => void
}): {
  create: (opts: CursorSessionOptions) => CursorSession
  cancelCalls: () => number
  prompts: string[]
} {
  const queue = [...(options.turnChunks ?? [])]
  let cancelCalls = 0
  const prompts: string[] = []

  return {
    prompts,
    cancelCalls: () => cancelCalls,
    create(opts: CursorSessionOptions): CursorSession {
      const session = {
        async ensure() {},
        async prompt(message: string, turnId: string) {
          prompts.push(message)
          const chunks = queue.length > 0 ? queue.shift()! : (options.chunks ?? ["你好", "，世界"])
          options.onPromptInFlight?.()
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
        async cancel() {
          cancelCalls += 1
        },
        async close() {},
      }
      return session as unknown as CursorSession
    },
  }
}

function makeService(options: {
  hasAgentKey: boolean
  factory?: ReturnType<typeof fakeCursorFactory>
}) {
  const handle = openVaultDb()
  const streamed: { degradedReason: string | null; done: boolean }[] = []
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (_channel: string, payload: { degradedReason: string | null; done: boolean }) => {
        streamed.push({ degradedReason: payload.degradedReason, done: payload.done })
      },
    },
  } as unknown as ReturnType<ConstructorParameters<typeof SearchService>[0]["getWindow"]>

  const workspaceRoot = mkdtempSync(join(tmpdir(), "mycontext-ws-"))
  dirs.push(workspaceRoot)

  const factory = options.factory ?? fakeCursorFactory({})
  const service = new SearchService({
    clock: new ManualClock(NOW),
    logger: createLogger("test", { level: "error" }),
    runtime: {} as RuntimeEnv,
    processes: {} as ProcessRunner,
    klRoot: "/fake/kl-graph",
    klPort: 8200,
    primaryChannelId: "dingtalk",
    getWindow: () => fakeWindow,
    getCursorApiKey: () => (options.hasAgentKey ? "sk-test-cursor" : ""),
    getCursorRuntime: () => "local",
    createCursorSession: (opts) => factory.create(opts),
  })
  service.attach(handle.db, {
    workspaceRoot,
    home: join(workspaceRoot, "agent-home"),
    npmCache: join(workspaceRoot, "npm-cache"),
  })
  return {
    service,
    handle,
    streamed,
    factory,
    lastDegradedReason: () => streamed.filter((s) => s.done).at(-1)?.degradedReason ?? null,
    close: () => handle.close(),
  }
}

describe("SearchService · Cursor agent turn", () => {
  it("Agent 主路用 Cursor 默认模型，不吃网关 embedding 名", async () => {
    let seenModel: string | undefined
    const factory = fakeCursorFactory({})
    const orig = factory.create.bind(factory)
    factory.create = (opts) => {
      seenModel = opts.modelId
      return orig(opts)
    }
    const ctx = makeService({ hasAgentKey: true, factory })
    // 故意不传 getCursorModel —— 应回落 DEFAULT_CURSOR_MODEL
    const session = ctx.service.create("问题")
    await ctx.service.prompt(session.id, "查一下")
    expect(seenModel).toBe("composer-2.5")
    ctx.close()
  })

  it("走 agent：text_delta 拼成一条 assistant message，状态 idle", async () => {
    const ctx = makeService({ hasAgentKey: true })
    const session = ctx.service.create("问题")
    await ctx.service.prompt(session.id, "帮我找一下会议纪要")

    const detail = ctx.service.detail(session.id)
    const messages = detail.items.filter((i) => i.itemType === "message")
    const assistant = messages.find((i) => i.role === "assistant")
    expect(assistant).toBeDefined()
    const text = JSON.parse(assistant!.contentJson)
      .map((b: { kind: string; text?: string }) => (b.kind === "text" ? b.text : ""))
      .join("")
    expect(text).toBe("你好，世界")
    expect(detail.session.state).toBe("idle")
    expect(ctx.lastDegradedReason()).toBeNull()
    ctx.close()
  })

  it("多轮：第二轮不覆盖用户消息，各轮答案独立落库", async () => {
    const factory = fakeCursorFactory({
      turnChunks: [["答案一"], ["答案二"]],
    })
    const ctx = makeService({ hasAgentKey: true, factory })
    const session = ctx.service.create("问题")
    await ctx.service.prompt(session.id, "第一个问题")
    await ctx.service.prompt(session.id, "第二个问题")

    const items = ctx.service.detail(session.id).items
    const textOf = (i: (typeof items)[number]) =>
      JSON.parse(i.contentJson)
        .map((b: { kind: string; text?: string }) => (b.kind === "text" ? b.text : ""))
        .join("")
    const users = items.filter((i) => i.role === "user").map(textOf)
    const assistants = items
      .filter((i) => i.role === "assistant" && i.itemType === "message")
      .map(textOf)

    expect(users).toEqual(["第一个问题", "第二个问题"])
    expect(assistants).toEqual(["答案一", "答案二"])
    const ids = items.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
    ctx.close()
  })

  it("无 Agent Key → 落回 recallOnly，degraded 可见", async () => {
    const ctx = makeService({ hasAgentKey: false })
    const session = ctx.service.create("问题")
    await ctx.service.prompt(session.id, "查一下")
    expect(ctx.service.agentAvailable()).toBe(false)
    expect(ctx.lastDegradedReason()).toMatch(/Agent API Key|模型网关|本地召回/)
    const items = ctx.service.detail(session.id).items
    expect(items.some((i) => i.toolName === "mycontext_local_recall")).toBe(true)
    ctx.close()
  })

  it("in-flight 取消 → 调 session.cancel", async () => {
    let cancelDuringPrompt: (() => void) | null = null
    const factory = fakeCursorFactory({
      chunks: ["慢"],
      onPromptInFlight: () => {
        cancelDuringPrompt?.()
      },
    })
    const ctx = makeService({ hasAgentKey: true, factory })
    const session = ctx.service.create("问题")
    cancelDuringPrompt = () => ctx.service.cancel(session.id)
    await ctx.service.prompt(session.id, "长任务")
    expect(factory.cancelCalls()).toBeGreaterThanOrEqual(1)
    ctx.close()
  })

  it("无 Agent Key 但有网关 → Fallback 生成答案并明示降级", async () => {
    const { LlmClient, staticLlmProvider } = await import("@mycontext/llm")
    const llm = new LlmClient({
      baseUrl: "https://llm.test.example/v1",
      apiKey: "sk-gw",
      model: "m",
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "网关答案" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    })
    const handle = openVaultDb()
    const streamed: { degradedReason: string | null; done: boolean }[] = []
    const fakeWindow = {
      isDestroyed: () => false,
      webContents: {
        send: (_c: string, payload: { degradedReason: string | null; done: boolean }) => {
          streamed.push(payload)
        },
      },
    } as unknown as ReturnType<ConstructorParameters<typeof SearchService>[0]["getWindow"]>
    const workspaceRoot = mkdtempSync(join(tmpdir(), "mycontext-ws-"))
    dirs.push(workspaceRoot)
    const service = new SearchService({
      clock: new ManualClock(NOW),
      logger: createLogger("test", { level: "error" }),
      runtime: {} as RuntimeEnv,
      processes: {} as ProcessRunner,
      klRoot: "/fake/kl-graph",
      klPort: 8200,
      primaryChannelId: "dingtalk",
      getWindow: () => fakeWindow,
      getCursorApiKey: () => "",
      llmProvider: staticLlmProvider(llm),
      createCursorSession: () => {
        throw new Error("不应起 Cursor")
      },
    })
    service.attach(handle.db, {
      workspaceRoot,
      home: join(workspaceRoot, "agent-home"),
      npmCache: join(workspaceRoot, "npm-cache"),
    })
    const session = service.create("问题")
    await service.prompt(session.id, "问")
    const items = service.detail(session.id).items
    expect(items.some((i) => i.toolName === "mycontext_gateway_answer")).toBe(true)
    const assistant = items.find((i) => i.role === "assistant" && i.itemType === "message")
    const text = JSON.parse(assistant!.contentJson)
      .map((b: { kind: string; text?: string }) => (b.kind === "text" ? b.text : ""))
      .join("")
    expect(text).toBe("网关答案")
    expect(streamed.filter((s) => s.done).at(-1)?.degradedReason).toContain("兼容网关")
    handle.close()
  })

  it("agent turn 报错 → 落回召回并带 degraded", async () => {
    const factory = fakeCursorFactory({ error: "boom" })
    const ctx = makeService({ hasAgentKey: true, factory })
    const session = ctx.service.create("问题")
    await ctx.service.prompt(session.id, "问")
    expect(ctx.lastDegradedReason()).toMatch(/未能完成|本地召回/)
    ctx.close()
  })
})
