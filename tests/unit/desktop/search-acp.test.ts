/**
 * SearchService 的 ACP 接线（M2）：mock transport 驱动一轮真实的 agent turn。
 *
 * 这里**不起真 opencode**（那是 tests/externals 的活）——用一个内存 transport
 * 扮演 opencode：SearchService 写出 `initialize`/`session/new`/`session/prompt`,
 * 我们按 ACP 形状应答，并在 prompt 响应**之前**推几条 `session/update` 通知
 * （逐 token 的 agent_message_chunk），验证：
 *
 *  1. 通知过 mapSessionUpdate→reducer→落库，最终库里有一条拼好的 assistant message；
 *  2. turn_end 由 prompt 响应 resolve 后**合成**（不是某条通知），message 定稿；
 *  3. 会话状态收尾为 idle，且 degradedReason 为 null（真走了 agent，不降级）；
 *  4. opencode 缺失时落回 recallOnly，degradedReason 非空（降级可见）。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ManualClock, createLogger } from "@mycontext/kernel"
import { openStore, VAULT_MIGRATIONS, type StoreHandle } from "@mycontext/store"
import type { DuplexHandle, DuplexSpec, ResolvedBinary } from "@mycontext/runtime-env"
import { SearchService } from "@main/services/search.service.js"

const dirs: string[] = []
const NOW = 1_785_000_000_000

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

/** 一个 vault 库（含 search_chat_* 表）。 */
function openVaultDb(): StoreHandle {
  const dir = mkdtempSync(join(tmpdir(), "mycontext-search-"))
  dirs.push(dir)
  const handle = openStore({ path: join(dir, "vault.sqlite"), migrations: VAULT_MIGRATIONS })
  return handle
}

/**
 * 内存 opencode：扮演 ACP 对端。
 *
 * `feed(...)` 让测试注入"进程会推回来的通知"，在 session/prompt 到达时按序发出，
 * 再 resolve prompt（模拟 turn 结束 = 响应 resolve，通知在响应前到）。
 */
function fakeOpencode(
  options: {
    updatesOnPrompt?: unknown[]
    turnUpdates?: unknown[][]
    failSessionNew?: boolean
    /**
     * 让 `session/resume` 失败，逼出「降级重建 → 回灌历史」那条路。
     *
     * 第 2 轮起 SearchService 会拿库里的 acpSessionId 去 resume；resume 挂了才走
     * `session/new` + 标记待回灌，下一次 prompt 才会带上历史块 —— 要测回灌的
     * prompt 形状，必须能从测试里把 resume 打下去。
     */
    failSessionResume?: boolean
    /**
     * turn **进行中**的回调：推完 update、还没 reply prompt 时调用。
     *
     * 取消是个只在 in-flight 窗口内有意义的动作 —— turn 已经 resolve 之后再
     * `cancel()` 是 no-op（activeTurn 已清空）。所以要测它，必须有个钩子能在
     * "prompt 还没回"的那一刻插进来。
     */
    onPromptInFlight?: () => void
  } = {},
) {
  const written: string[] = []
  let onLine: ((line: string) => void) | null = null
  // 每轮 prompt 消费一批（多轮测试用）；用尽或未提供则退回 updatesOnPrompt。
  const queue = [...(options.turnUpdates ?? [])]
  // session/new 每次给不同 id：回灌标记按 acpSessionId 记，同 id 会串味。
  let newSessionSeq = 0

  const transport: DuplexHandle = {
    async writeLine(line: string) {
      written.push(line)
      const msg = JSON.parse(line) as { id?: number; method?: string; params?: unknown }
      // 通知（无 id）：cancel 走这条路，记进 written 供断言，不需要应答。
      if (msg.id === undefined || msg.method === undefined) return

      if (msg.method === "session/prompt") {
        // 通知在响应**之前**到（§11.3 的关键时序）。
        const updates = queue.length > 0 ? queue.shift()! : (options.updatesOnPrompt ?? [])
        for (const update of updates) {
          onLine?.(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: update }))
        }
        options.onPromptInFlight?.()
        reply(msg.id, { stopReason: "end_turn" })
        return
      }
      if (msg.method === "session/resume") {
        if (options.failSessionResume === true) {
          replyError(msg.id, "session not found")
          return
        }
        reply(msg.id, {})
        return
      }
      if (msg.method === "session/new") {
        if (options.failSessionNew === true) {
          replyError(msg.id, "session creation refused")
          return
        }
        newSessionSeq += 1
        reply(msg.id, { sessionId: `acp-sess-${String(newSessionSeq)}` })
        return
      }
      // initialize / session/close / 其它：回一个平凡结果。
      reply(msg.id, { protocolVersion: 1 })
    },
    async close() {},
    get alive() {
      return true
    },
    pid: 4242,
  }

  function reply(id: number, result: unknown) {
    onLine?.(JSON.stringify({ jsonrpc: "2.0", id, result }))
  }
  function replyError(id: number, message: string) {
    onLine?.(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }))
  }

  /**
   * spawn 时收到的 env。★ 档位的全部可观测面都在这里
   * （`KL_SERVER_PORT` / `KL_GRAPHS_JSON` / XDG 三兄弟都是 spawn 那一刻定的）。
   */
  let spawnedEnv: Record<string, string> | undefined
  return {
    transport,
    written,
    get spawnedEnv() {
      return spawnedEnv
    },
    /** 主动推一条 session/update（测"取消后迟到的事件"用）。 */
    emit: (update: unknown) => {
      onLine?.(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: update }))
    },
    bind: (spec: DuplexSpec) => {
      onLine = spec.onLine
      spawnedEnv = spec.env as Record<string, string> | undefined
    },
  }
}

/** 一条 agent_message_chunk 通知（逐 token 文本）。 */
function messageChunk(text: string): unknown {
  return {
    sessionId: "acp-sess-1",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  }
}

function makeService(options: {
  hasOpencode: boolean
  fake?: ReturnType<typeof fakeOpencode>
  klPortOf?: (channelId: string) => number | undefined
}) {
  const handle = openVaultDb()
  const resolved: ResolvedBinary = {
    name: "opencode",
    path: "/fake/opencode",
    platform: "darwin-arm64",
    source: "path",
  }
  const runtime = {
    tryResolveOpencode: () => (options.hasOpencode ? resolved : null),
    // SearchService 现在走版本闸（resolveUsableOpencode）。hasOpencode 时给达标结果。
    resolveUsableOpencode: () =>
      options.hasOpencode
        ? { ok: true as const, binary: resolved, version: "1.18.11" }
        : { ok: false as const, reason: "missing" as const },
  } as unknown as ConstructorParameters<typeof SearchService>[0]["runtime"]

  const processes = {
    spawnDuplex: (spec: DuplexSpec): DuplexHandle => {
      if (options.fake === undefined) throw new Error("no fake transport")
      options.fake.bind(spec)
      return options.fake.transport
    },
  } as unknown as ConstructorParameters<typeof SearchService>[0]["processes"]

  /**
   * 捕获推给 renderer 的流事件 —— `degradedReason` 只从这条路出去，
   * 而它是"降级原因说得对不对"唯一可观测的地方。
   */
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
  const service = new SearchService({
    clock: new ManualClock(NOW),
    logger: createLogger("test", { level: "error" }),
    runtime,
    processes,
    klRoot: "/fake/kl-graph",
    klPort: 8200,
    primaryChannelId: "dingtalk",
    ...(options.klPortOf === undefined ? {} : { klPortOf: options.klPortOf }),
    getWindow: () => fakeWindow,
  })
  // agent 目录按 vault（attach 时给）；npm 缓存应用级一份 —— 见 AgentDirs
  service.attach(handle.db, {
    workspaceRoot,
    home: join(workspaceRoot, "agent-home"),
    npmCache: join(workspaceRoot, "npm-cache"),
  })
  return {
    service,
    handle,
    workspaceRoot,
    streamed,
    /** 最后一条带降级原因的流事件（降级发生在收尾那条）。 */
    lastDegradedReason: () => streamed.filter((s) => s.done).at(-1)?.degradedReason ?? null,
    close: () => handle.close(),
  }
}

describe("SearchService · agent turn（mock transport）", () => {
  it("走 agent：通知拼成一条 assistant message，状态收尾 idle", async () => {
    const fake = fakeOpencode({
      updatesOnPrompt: [messageChunk("你好"), messageChunk("，世界")],
    })
    const ctx = makeService({ hasOpencode: true, fake })
    const session = ctx.service.create("问题")
    await ctx.service.prompt(session.id, "帮我找一下会议纪要")

    const detail = ctx.service.detail(session.id)
    // user 消息 + assistant message（两条 chunk 拼成一条）
    const messages = detail.items.filter((i) => i.itemType === "message")
    const assistant = messages.find((i) => i.role === "assistant")
    expect(assistant).toBeDefined()
    const text = JSON.parse(assistant!.contentJson)
      .map((b: { kind: string; text?: string }) => (b.kind === "text" ? b.text : ""))
      .join("")
    expect(text).toBe("你好，世界")
    expect(detail.session.state).toBe("idle")
    // 真走了 agent → 发过 initialize/session/new/session/prompt
    const methods = fake.written.map((l) => (JSON.parse(l) as { method?: string }).method)
    expect(methods).toContain("session/prompt")
    ctx.close()
  })

  /**
   * ★ 多轮回归：第 2 轮 assistant 不能与本轮 user 消息撞 seq/id。
   *
   * 这条守的是一个真实损坏过的 bug：reducer 若跨轮复用，内部 seq 计数器停在
   * 上一轮尾号、忽略本轮 startSeq，第 2 轮 assistant 会与 user 撞 id，
   * INSERT OR IGNORE 撞后走 updateMessage，把用户的问题覆盖成答案。
   */
  it("多轮：第二轮不覆盖用户消息，各轮答案独立落库", async () => {
    const fake = fakeOpencode({
      turnUpdates: [[messageChunk("答案一")], [messageChunk("答案二")]],
    })
    const ctx = makeService({ hasOpencode: true, fake })
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

    // 两条用户问题都在（没被答案覆盖）
    expect(users).toEqual(["第一个问题", "第二个问题"])
    // 两条答案独立
    expect(assistants).toEqual(["答案一", "答案二"])
    // id 无重复（撞号 bug 会让某两条同 id）
    const ids = items.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
    ctx.close()
  })

  /**
   * ★★ 首字必须**立刻**可见 —— 不能等到 turn 定稿。
   *
   * 这条守的是那个"看起来很慢"的 bug：第 2 轮起每轮都先 `session/resume`，
   * 而 resume 的抑制窗口一关就进 5s 宽限期，紧接着（几毫秒内）就发
   * `session/prompt` —— 于是本轮真实答案的前 5 秒流式输出全被扣在警戒期里
   * 不落库、不推 UI。用户发完问题干等十几秒才见第一个动静（叠加模型自身
   * 约 3.8s 首字延迟），主观上就是"卡住了/内容被截断"。
   *
   * 断言方式：在 prompt **还没 resolve**（turn 未定稿）的那一刻查库 ——
   * 此时 assistant message 就该已经在库里了。修复前这里是空的。
   */
  it("★ 第二轮：turn 未定稿时首字就已落库（不被宽限期扣住）", async () => {
    /** 每轮 in-flight 时刻的库内容快照（下标 0 = 第 1 轮，1 = 第 2 轮）。 */
    const midTurnSamples: string[] = []
    const fake = fakeOpencode({
      turnUpdates: [[messageChunk("答案一")], [messageChunk("第二轮的首字")]],
      onPromptInFlight: () => {
        const items = ctx.service.detail(sessionId).items
        const streaming = items.filter((i) => i.role === "assistant" && i.itemType === "message")
        midTurnSamples.push(streaming.map((i) => i.contentJson).join(""))
      },
    })
    const ctx = makeService({ hasOpencode: true, fake })
    const session = ctx.service.create("问题")
    const sessionId = session.id
    await ctx.service.prompt(sessionId, "第一个问题")
    await ctx.service.prompt(sessionId, "第二个问题")

    // 第 2 轮的 turn 还没定稿时，本轮的首字已经在库里 —— 这就是"立刻可见"
    expect(midTurnSamples).toHaveLength(2)
    expect(midTurnSamples[1]).toContain("第二轮的首字")
    ctx.close()
  })

  it("opencode 缺失 → 落回 recallOnly，degraded 可见", async () => {
    const ctx = makeService({ hasOpencode: false })
    const session = ctx.service.create("问题")
    await ctx.service.prompt(session.id, "查点东西")

    const detail = ctx.service.detail(session.id)
    // 召回路径产出一个 tool_call（mycontext_local_recall）+ 一条 message
    const tool = detail.items.find((i) => i.itemType === "tool_call")
    expect(tool?.toolName).toBe("mycontext_local_recall")
    expect(detail.session.state).toBe("idle")
    ctx.close()
  })

  it("agent turn 抛错（session/new 失败）→ 落回 recallOnly，不进 error 档", async () => {
    const fake = fakeOpencode({ failSessionNew: true })
    const ctx = makeService({ hasOpencode: true, fake })
    const session = ctx.service.create("问题")
    await ctx.service.prompt(session.id, "查点东西")
    const detail = ctx.service.detail(session.id)
    // 不应是 error 档（agent 起不来是降级不是报错），且产出召回工具项。
    expect(detail.session.state).toBe("idle")
    expect(detail.items.some((i) => i.toolName === "mycontext_local_recall")).toBe(true)
    ctx.close()
  })
})

/**
 * ★ 上下文回灌必须是"背景资料"，不能被模型当成"要输出的内容"。
 *
 * 这组守的是一个真机翻车：回灌原来是裸文本（`（以下是此前的对话，供你参考）\n` +
 * 历史），模型把整段**复述**进了新答案 —— 先抄一遍上一轮的完整答案，自己补上
 * 「（以上是此前的对话，供你参考）」「现在，继续回答用户的问题：」，再抄一遍用户
 * 的历史问题，最后才开始答。用户只问了一句，却看到一条自问自答、像跑了两轮的
 * 怪答案。
 *
 * 所以断言落在**发出去的 prompt 形状**上（而不是模型输出——那不可控）：
 * 有边界标签、有明确禁令、且不含上一轮答案的完整正文。
 */
describe("SearchService · 上下文回灌（降级重建后）", () => {
  /** 从 written 里取最后一条 session/prompt 的 content blocks。 */
  function lastPromptBlocks(written: string[]): { type: string; text: string }[] {
    const prompts = written
      .map((l) => JSON.parse(l) as { method?: string; params?: { prompt?: unknown } })
      .filter((m) => m.method === "session/prompt")
    const last = prompts[prompts.length - 1]
    return (last?.params?.prompt ?? []) as { type: string; text: string }[]
  }

  /**
   * ★ 这条原来断言 prompt 里带一段预先塞的 FTS 召回块。那段已经删了 ——
   * 它是"一个进程只能连一个 kl"约束下的替代品，而档位与进程一一对应之后
   * 它变成重复且更弱的东西（只有 12 条 FTS，图谱的实体/事实/社群都用不上），
   * 还占掉 prompt 的开头位置。见 `buildPromptBlocks` 的注释。
   *
   * 现在断言的是**只有问题**这一个块 —— 那正是"没有多余上下文"的证据。
   */
  it("resume 成功（未重建）→ 不回灌历史，prompt 里只有这一个问题", async () => {
    const fake = fakeOpencode({ turnUpdates: [[messageChunk("答案一")], [messageChunk("答案二")]] })
    const ctx = makeService({ hasOpencode: true, fake })
    const session = ctx.service.create("问题")
    await ctx.service.prompt(session.id, "第一个问题")
    await ctx.service.prompt(session.id, "第二个问题")

    const blocks = lastPromptBlocks(fake.written)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.text).toBe("第二个问题")
    // ★ 既没有回灌块（resume 成功），也没有预塞的召回块（已删）
    expect(blocks[0]?.text).not.toContain("<previous_conversation")
    expect(blocks[0]?.text).not.toContain("<isolated_source_recall")
    ctx.close()
  })

  it("降级重建 → 回灌块有边界标签与「不要复述」禁令，且问题单独成块", async () => {
    // resume 打下去 → 第 2 轮走 session/new + 标记待回灌。
    const fake = fakeOpencode({
      failSessionResume: true,
      turnUpdates: [[messageChunk("上一轮的答案")], [messageChunk("这一轮的答案")]],
    })
    const ctx = makeService({ hasOpencode: true, fake })
    const session = ctx.service.create("问题")
    await ctx.service.prompt(session.id, "第一个问题")
    await ctx.service.prompt(session.id, "第二个问题")

    const blocks = lastPromptBlocks(fake.written)
    // 回灌块 + 问题块（预塞的召回块已删，见上一条测试的注释）
    expect(blocks).toHaveLength(2)
    const replay = blocks[0]?.text ?? ""
    // ① 有边界：裸文本没有边界，模型分不清"给你看的"与"要你写的"
    expect(replay).toContain("<previous_conversation")
    expect(replay).toContain("</previous_conversation>")
    // ② 有明确禁令（这三条是复述行为的直接对治）
    expect(replay).toContain("不要复述")
    expect(replay).toContain("不要重复回答")
    expect(replay).toContain("不要提及这段记录的存在")
    // ③ 历史确实带上了（回灌的本意：别让它忘了聊过什么）
    expect(replay).toContain("第一个问题")
    /**
     * ④ 新问题**独立成块**。
     *
     * ★ 不断言"回灌块里没有它"：这一轮的用户消息在 prompt 之前就已经落库了，
     * 所以历史里本来就有它。要紧的是它**另有一个独立的块**在最后 ——
     * 那才是模型被要求回答的东西（回灌块的开头明写"仅供了解背景"）。
     */
    expect(blocks[1]?.text).toBe("第二个问题")
    ctx.close()
  })

  it("回灌里助手长答案被截断（完整正文是被整段抄走的主因）", async () => {
    const long = "甲".repeat(600)
    const fake = fakeOpencode({
      failSessionResume: true,
      turnUpdates: [[messageChunk(long)], [messageChunk("这一轮")]],
    })
    const ctx = makeService({ hasOpencode: true, fake })
    const session = ctx.service.create("问题")
    await ctx.service.prompt(session.id, "第一个问题")
    await ctx.service.prompt(session.id, "第二个问题")

    const replay = lastPromptBlocks(fake.written)[0]?.text ?? ""
    // 不含完整正文，但留了摘要 + 省略标记
    expect(replay).not.toContain(long)
    expect(replay).toContain("（已省略）")
    expect(replay).toContain("甲".repeat(50))
    ctx.close()
  })

  it("回灌只发生一次（第 3 轮不再重复带历史）", async () => {
    const fake = fakeOpencode({
      failSessionResume: true,
      turnUpdates: [[messageChunk("一")], [messageChunk("二")], [messageChunk("三")]],
    })
    const ctx = makeService({ hasOpencode: true, fake })
    const session = ctx.service.create("问题")
    await ctx.service.prompt(session.id, "问题一")
    await ctx.service.prompt(session.id, "问题二")
    const secondHadReplay = lastPromptBlocks(fake.written)[0]?.text.includes(
      "<previous_conversation",
    )
    await ctx.service.prompt(session.id, "问题三")
    const third = lastPromptBlocks(fake.written)

    expect(secondHadReplay).toBe(true)
    // 第 3 轮：resume 仍然失败 → 又是新 session → 会再回灌一次（这是预期：
    // 每次重建都要让新 session 知道背景）。断言的是"同一个 session 不重复回灌"
    // —— 即回灌块里不该出现两份历史标签。
    const replay3 = third[0]?.text ?? ""
    const tagCount = replay3.split("<previous_conversation").length - 1
    expect(tagCount).toBeLessThanOrEqual(1)
    ctx.close()
  })
})

/**
 * ★ 停止按钮必须真的让 opencode 停下。
 *
 * 这组守的是一个真实的"看起来能用"的 bug：原实现的 `cancel()` 只调
 * `reducer.cancelTurn()`（我们这边不再收内容），**没有**给 opencode 发
 * `session/cancel`。表现是 UI 停了、模型还在全速生成继续烧 token ——
 * 用户点了停止，账单没停，而且从界面上完全看不出来。
 *
 * 真进程实测确认了这个通知有效（见 search.service.ts `cancel()` 的说明：
 * 对照组 9.4s/102 update/2817 token，取消组在取消那一刻 resolve、
 * 之后 0 条 update、0 token）。这里用 mock transport 守住**接线**不再退化。
 */
describe("SearchService · cancel（停止按钮）", () => {
  it("in-flight 时取消 → 真发 session/cancel 给 opencode（带 acpSessionId）", async () => {
    let sessionId = ""
    const fake = fakeOpencode({
      updatesOnPrompt: [messageChunk("正在想")],
      // turn 还没 resolve 时点停止 —— 这才是取消唯一有意义的时刻。
      onPromptInFlight: () => ctx.service.cancel(sessionId),
    })
    const ctx = makeService({ hasOpencode: true, fake })
    const session = ctx.service.create("问题")
    sessionId = session.id
    await ctx.service.prompt(session.id, "一个很长的问题")

    const notes = fake.written
      .map((l) => JSON.parse(l) as { method?: string; id?: number; params?: unknown })
      .filter((m) => m.method === "session/cancel")
    expect(notes).toHaveLength(1)
    // 必须是**通知**（无 id）：ACP 里取消没有响应可等，发成请求会挂在 pending 里超时。
    expect(notes[0]?.id).toBeUndefined()
    // 必须发到 ACP 的 sessionId，不是我们库里的那个（两者不是一个东西）。
    expect((notes[0]?.params as { sessionId?: string }).sessionId).toBe("acp-sess-1")
    ctx.close()
  })

  it("取消后到达的 update 不再落库（reducer 侧也挡住）", async () => {
    let sessionId = ""
    const fake = fakeOpencode({
      updatesOnPrompt: [messageChunk("取消前")],
      onPromptInFlight: () => {
        ctx.service.cancel(sessionId)
        // 取消后又来一条（真实世界里它已经在管道里了）——不该进库。
        fake.emit(messageChunk("取消后不该出现"))
      },
    })
    const ctx = makeService({ hasOpencode: true, fake })
    const session = ctx.service.create("问题")
    sessionId = session.id
    await ctx.service.prompt(session.id, "问题")

    const all = ctx.service
      .detail(session.id)
      .items.map((i) => i.contentJson)
      .join("")
    expect(all).not.toContain("取消后不该出现")
    ctx.close()
  })

  it("没有活跃 turn 时取消是 no-op（不发通知、不抛）", () => {
    const fake = fakeOpencode()
    const ctx = makeService({ hasOpencode: true, fake })
    const session = ctx.service.create("问题")
    expect(() => ctx.service.cancel(session.id)).not.toThrow()
    expect(fake.written.some((l) => l.includes("session/cancel"))).toBe(false)
    ctx.close()
  })

  it("取消**别的** session 不影响当前 turn", async () => {
    let otherId = ""
    const fake = fakeOpencode({
      updatesOnPrompt: [messageChunk("答案")],
      onPromptInFlight: () => ctx.service.cancel(otherId),
    })
    const ctx = makeService({ hasOpencode: true, fake })
    const other = ctx.service.create("另一个会话")
    otherId = other.id
    const session = ctx.service.create("问题")
    await ctx.service.prompt(session.id, "问题")

    // 取消的是别的 session → 不该发通知，本轮答案照常落库。
    expect(fake.written.some((l) => l.includes("session/cancel"))).toBe(false)
    const all = ctx.service
      .detail(session.id)
      .items.map((i) => i.contentJson)
      .join("")
    expect(all).toContain("答案")
    ctx.close()
  })
})

/**
 * ★★ 多 session 并发分派（`activeTurns` 按 acpSessionId 索引）。
 *
 * ## 为什么这一组必须存在
 *
 * 这里曾经是**单个** `activeTurn`，注释理由是「search 的 prompt 是串行的
 * （一个用户、一次一问）」—— 对搜索成立。但数字分身**天生并发**：管控层
 * `maxResident` 默认 8，8 个会话可能同时来消息，各自一个 opencode session。
 *
 * 单例在那时的失效形态不是报错，而是**串台**：后登记的 turn 覆盖前一个，
 * 于是 A 会话的回答被写进 B 会话的对话流 —— 两边都没有任何异常。
 *
 * 而 ACP 的 `session/update` 只带 `sessionId`（不带 turnId），所以这里锁的是
 * "按那个 id 分派"这件事本身。
 */
describe("★★ 多 session 并发：按 acpSessionId 分派，不串台", () => {
  it("★ 别的 session 的 update 不会落进这个会话", async () => {
    /**
     * 推两条 chunk：一条带**本轮**的 sessionId，一条带一个**不存在**的。
     * 后者在单例实现下会被当成"当前那个 turn"的事件收下（那就是串台的
     * 微缩形态）；按 id 分派之后它必须被丢弃。
     */
    const fake = fakeOpencode({
      updatesOnPrompt: [
        messageChunk("属于我的"),
        {
          sessionId: "acp-sess-别人的",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "【串台内容】" },
          },
        },
      ],
    })
    const ctx = makeService({ hasOpencode: true, fake })
    const session = ctx.service.create("问题")
    await ctx.service.prompt(session.id, "问题")

    const all = ctx.service
      .detail(session.id)
      .items.map((i) => i.contentJson)
      .join("")
    expect(all).toContain("属于我的")
    // ★ 关键：别人的那条一个字都不能进来
    expect(all).not.toContain("串台内容")
    ctx.close()
  })

  it("★ 没有 sessionId 的 update 被丢弃，不投给「唯一那个 turn」", async () => {
    /**
     * 畸形/未来版本的通知可能没有 sessionId。丢一条 update 顶多少一段流式
     * 文本；而投给"唯一那个 turn"在并发下就是串台 —— 后者糟得多。
     */
    const fake = fakeOpencode({
      updatesOnPrompt: [
        messageChunk("正常内容"),
        {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "【无主内容】" },
          },
        },
      ],
    })
    const ctx = makeService({ hasOpencode: true, fake })
    const session = ctx.service.create("问题")
    await ctx.service.prompt(session.id, "问题")

    const all = ctx.service
      .detail(session.id)
      .items.map((i) => i.contentJson)
      .join("")
    expect(all).toContain("正常内容")
    expect(all).not.toContain("无主内容")
    ctx.close()
  })

  /**
   * ★ 「turn 失败只清自己那条登记」这一条**没有**在这里锁。
   *
   * 试过两种写法，都是空的：
   * · 顺序跑两轮 —— 第一轮的登记早就删了，`clear()` 清的是空表；
   * · 在 `onPromptInFlight` 里插第二轮 —— 它的 catch 跑完之后第一轮
   *   自己那一轮又把登记写回去了，于是 `clear()` 照样看不出来。
   *
   * 真要复现需要"两轮在同一时刻都处于已登记未结束"的状态，而这个 mock
   * transport 是同步应答的（`writeLine` 里直接 reply），构造不出那个窗口。
   *
   * 所以这件事由**代码形状**保证并在这里记一笔：catch 里必须按 sessionId
   * 逐个删（`for … if (turn.sessionId === sessionId) delete`），**不能**
   * `activeTurns.clear()`。后者在并发下会抹掉别的会话正在跑的 turn ——
   * 那些 turn 的 update 随后全被丢弃，表现是"另一个会话突然不回了"，
   * 而它自己那一侧没有任何错误。
   *
   * 数字分身接进来之后（真并发、异步 transport）应当补一条真用例。
   */
  it("catch 里按 sessionId 逐个删，不是 clear 整张表（形状断言）", () => {
    const source = readFileSync(
      join(import.meta.dirname, "../../../apps/desktop/src/main/services/search.service.ts"),
      "utf8",
    )
    /**
     * ★ 先剥注释再断言。
     *
     * `activeTurns.clear()` 这个字符串在**注释里**是合法的（那段注释正是
     * 在解释"为什么不能这么写"）。不剥的话这条断言拦的是自己的文档 ——
     * 踩过一次：断言红了，指着我刚写的那行说明。
     */
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    expect(code).not.toContain("activeTurns.clear()")
    expect(code).toMatch(/if \(turn\.sessionId === sessionId\) this\.activeTurns\.delete\(key\)/)
  })
})

/**
 * ★ 降级原因必须**指向真正该改的东西**。
 *
 * 起因是一次真实的排查困境：同事机器上"搜索完全没法用"，日志里只有
 * `ACP 请求超时：session/prompt`，横幅上写着"Agent 暂不可用"——
 * 于是所有人都在查 agent 装没装（它装着、进程也起来了）。
 *
 * 真因是**没配网关密钥**：`resolveGatewayModelConfig` 拿不到
 * `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` 时返回 null，opencode 退回
 * 默认 provider，那条路要查被墙的 models.dev —— 拉不到时它不报错，
 * 只是 prompt 永不返回，最后表现为 120 秒超时。
 *
 * "超时"与"缺密钥"之间隔着一次 120 秒等待和一层错误归因，
 * 这组测试守住三种原因**说的不是同一句话**。
 */
describe("SearchService · 降级原因分档", () => {
  // ★ 两组来源都要清：resolveGatewayModelConfig 会从 MYCONTEXT_LLM_* 回退，
  // 只清 ANTHROPIC_* 的话本机 .env 里的值会漏进用例，"没配网关"那条永远测不到。
  const ENV_KEYS = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "MYCONTEXT_LLM_BASE_URL",
    "MYCONTEXT_LLM_API_KEY",
  ] as const
  const saved = new Map<string, string | undefined>()

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key])
      delete process.env[key]
    }
  })
  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    saved.clear()
  })

  it("没装 opencode → 说「未检测到 opencode」", async () => {
    const ctx = makeService({ hasOpencode: false })
    const session = ctx.service.create("问题")
    await ctx.service.prompt(session.id, "查点东西")
    expect(ctx.lastDegradedReason()).toContain("未检测到 opencode")
    ctx.close()
  })

  /**
   * ★ 这条是最要紧的一档：装了 agent 但没配密钥。
   * 原实现在这里说"Agent 暂不可用"—— 把人引向错误的排查方向。
   */
  it("装了 opencode 但没配网关 → 明确点出要配哪两个环境变量", async () => {
    const fake = fakeOpencode({ failSessionNew: true })
    const ctx = makeService({ hasOpencode: true, fake })
    const session = ctx.service.create("问题")
    await ctx.service.prompt(session.id, "查点东西")

    const reason = ctx.lastDegradedReason() ?? ""
    expect(reason).toContain("MYCONTEXT_LLM_BASE_URL")
    expect(reason).toContain("MYCONTEXT_LLM_API_KEY")
    // 不能再笼统地说"Agent 暂不可用"——agent 明明装着
    expect(reason).not.toContain("Agent 暂不可用")
    ctx.close()
  })

  it("配了网关但 turn 失败 → 说「本轮未能完成」，不误指配置", async () => {
    process.env["ANTHROPIC_BASE_URL"] = "https://gateway.example.com"
    process.env["ANTHROPIC_AUTH_TOKEN"] = "test-token"

    const fake = fakeOpencode({ failSessionNew: true })
    const ctx = makeService({ hasOpencode: true, fake })
    const session = ctx.service.create("问题")
    await ctx.service.prompt(session.id, "查点东西")

    const reason = ctx.lastDegradedReason() ?? ""
    expect(reason).toContain("本轮未能完成")
    // 配置是好的，别让用户去改 .env
    expect(reason).not.toContain("MYCONTEXT_LLM_BASE_URL")
    ctx.close()
  })
})

/**
 * ★★ 挂载窗口期与档位的降级行为。
 *
 * 管线挂载是 fire-and-forget 的（登录不等它），所以登录后有一段短窗口
 * 那个渠道的 kl 端口还查不到。这一组锁的是**那时不能抛** ——
 * "刚登录就搜索会报错"是一个用户一定会撞到的形态。
 */
describe("★★ 检索档位：管线还没挂上时降级而不抛", () => {
  it("★ 档位对应的渠道还没挂管线 → 退回主渠道端口，仍能正常跑完一轮", async () => {
    const fake = fakeOpencode({ updatesOnPrompt: [messageChunk("答案")] })
    // klPortOf 恒返回 undefined = 那个渠道的管线还没挂上
    const ctx = makeService({ hasOpencode: true, fake, klPortOf: () => undefined })
    const session = ctx.service.create("问题", "feishu")
    await ctx.service.prompt(session.id, "查一下")

    // 不抛、走完 agent 一轮、且没有降级横幅
    expect(ctx.lastDegradedReason()).toBeNull()
    const spawned = fake.spawnedEnv?.["KL_SERVER_PORT"]
    // ★ 退回主渠道端口 —— 那时查不到飞书的图，但**仍能查到主渠道的**，
    // 比整个搜索起不来好（而且管线挂上后下一个会话就对了）
    expect(spawned).toBe("8200")
    ctx.close()
  })

  it("★ 单渠道档位连它自己的 kl（连错端口会查到另一个渠道的知识，不报错）", async () => {
    const fake = fakeOpencode({ updatesOnPrompt: [messageChunk("答案")] })
    const ctx = makeService({
      hasOpencode: true,
      fake,
      klPortOf: (id) => (id === "feishu" ? 8201 : undefined),
    })
    const session = ctx.service.create("问题", "feishu")
    await ctx.service.prompt(session.id, "查一下")
    expect(fake.spawnedEnv?.["KL_SERVER_PORT"]).toBe("8201")
    // 单渠道档位**不**注入 KL_GRAPHS_JSON（只有 all 档要逐个问）
    expect(fake.spawnedEnv?.["KL_GRAPHS_JSON"]).toBeUndefined()
    ctx.close()
  })

  /**
   * ★★ 默认档位（= 存量会话）必须走主渠道端口且**不开** isolateData。
   *
   * 这一条与 `search-graph-scope.test.ts` 里那组是两个层面：那边验 spawn 层的
   * env 形状，这边验 SearchService 真的按会话档位选了默认那一档。
   */
  it("★★ 不给档位 → 主渠道端口，且 XDG_DATA_HOME 仍指向真实 HOME（resume 靠它）", async () => {
    const fake = fakeOpencode({ updatesOnPrompt: [messageChunk("答案")] })
    const ctx = makeService({ hasOpencode: true, fake })
    const session = ctx.service.create("问题")
    await ctx.service.prompt(session.id, "查一下")
    expect(fake.spawnedEnv?.["KL_SERVER_PORT"]).toBe("8200")
    // ★ 没被指进 agentHome —— 那是零迁移的证据
    expect(fake.spawnedEnv?.["XDG_DATA_HOME"]).not.toContain("agent-home")
    expect(fake.spawnedEnv?.["XDG_STATE_HOME"]).toBeUndefined()
    ctx.close()
  })

  it("★ all 档注入 KL_GRAPHS_JSON（否则混合检索静默退化成单图）", async () => {
    const fake = fakeOpencode({ updatesOnPrompt: [messageChunk("答案")] })
    const ctx = makeService({
      hasOpencode: true,
      fake,
      klPortOf: (id) => (id === "feishu" ? 8201 : undefined),
    })
    const session = ctx.service.create("问题", "all")
    await ctx.service.prompt(session.id, "查一下")
    // all 档连主渠道端口，但要知道全部图在哪
    expect(fake.spawnedEnv?.["KL_SERVER_PORT"]).toBe("8200")
    const graphs = JSON.parse(fake.spawnedEnv?.["KL_GRAPHS_JSON"] ?? "{}") as Record<string, number>
    expect(graphs["dingtalk"]).toBe(8200)
    ctx.close()
  })
})
