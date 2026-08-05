/**
 * PersonaAcp —— 数字分身的 opencode ACP 编排。
 *
 * ## 这一层锁的是「隔离与降级」四条
 *
 * agent 的力量与危险相互挂钩：它能读你所有聊天记录、能自动回消息、
 * 能查图谱。所以隔离与降级不是可选特性，而是这条路径能不能上线的前提。
 *
 * 1. **opencode 缺失 → `available()` 返回 false**。降级到 LlmClient 直连
 *    必须一眼可判（PersonaService.generateDraft 据此选路），不能靠调用方
 *    自己去 catch 一个模糊的错误。
 * 2. **turn 失败 → 返回 null 而不是抛**。抛出会让上层把它当成"我们自己
 *    的逻辑错"，日志里刷 error，用户看到红条。而 opencode 起不来是
 *    **能力性**问题（102MB 二进制不随包分发），生产上是常态。
 * 3. **每会话拿到自己的 acpSessionId** 并跨轮复用。丢了这个 id 每轮都
 *    要重开 session —— skill 装载、cwd 校验、握手，每次一秒起。
 * 4. **release 撤销自己的 token**。scope 是 `kind:"persona" + conversationId`，
 *    LRU 淘汰时不撤会让 MCP server 面里累积失效 token —— 而它们仍能通过
 *    verify（有效期内），也就意味着一条被淘汰的会话仍能被同名 injection 复用。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { ManualClock, createLogger } from "@mycontext/kernel"
import type { ChatItem } from "@mycontext/agent-runtime"
import type { DuplexHandle, DuplexSpec, ResolvedBinary } from "@mycontext/runtime-env"
import { PersonaAcp } from "../../../apps/desktop/src/main/services/persona-acp.js"

const NOW = 1_785_000_000_000
const logger = createLogger("test", { level: "error" })

afterEach(() => {
  vi.useRealTimers()
})

interface FakeOpencodeOptions {
  /** prompt 到达时按序推的通知（文本 chunk） */
  turnText?: readonly string[]
  /**
   * 在 `session/prompt` **响应之后**才推的 chunk —— 真进程实测的形态。
   *
   * ★ 这不是一个假造的边界情况：`scripts/probe-acp-stream.mjs` 的 dump 显示
   * 响应帧夹在 chunk 之间（第 18 行是 response，第 19-25 行还有 7 条 chunk）。
   * 库里那条 40 字符的半截草稿
   * （`{"reply": "哈哈好", "holdForReview": false,`）就是这么来的。
   */
  turnTextAfterResponse?: readonly string[]
  /**
   * 在文本 chunk **之前**推的思考与工具通知。
   *
   * 用来锁两件事：① 它们**不能**进 `chunks`（那是 settleStream 的判据，
   * 也是"半截 JSON 进草稿"的防线）；② 它们**要**进 `items`（过程可见）。
   */
  thoughts?: readonly string[]
  toolCalls?: readonly { id: string; title: string }[]
  /** 让 session/new 失败 —— 逼出错误路径 */
  failSessionNew?: boolean
}

/**
 * 内存 opencode：扮演 ACP 对端。
 *
 * 与 search-acp 那边同形（那里锁并发分派，这里锁降级） —— 但**没有共享**：
 * 这两个服务的失效模式不同（搜索单例、数字分身多 session），共用一个 fake
 * 会让新场景要往老 fake 里加分支，越加越像"通用 mock" 而不是特定场景。
 */
function fakeOpencode(options: FakeOpencodeOptions = {}) {
  const written: string[] = []
  let onLine: ((line: string) => void) | null = null
  let newSessionSeq = 0
  const transport: DuplexHandle = {
    async writeLine(line: string) {
      written.push(line)
      const msg = JSON.parse(line) as { id?: number; method?: string; params?: unknown }
      if (msg.id === undefined || msg.method === undefined) return

      if (msg.method === "session/prompt") {
        const sessionId = (msg.params as { sessionId?: string } | undefined)?.sessionId ?? ""
        const push = (text: string): void => {
          onLine?.(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId,
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
              },
            }),
          )
        }
        // 思考与工具先到（真进程也是这个顺序：先想、先调工具、再吐正文）。
        for (const text of options.thoughts ?? []) {
          onLine?.(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId,
                update: {
                  sessionUpdate: "agent_thought_chunk",
                  content: { type: "text", text },
                },
              },
            }),
          )
        }
        for (const call of options.toolCalls ?? []) {
          onLine?.(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId,
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: call.id,
                  title: call.title,
                  kind: "search",
                  status: "pending",
                },
              },
            }),
          )
        }
        for (const text of options.turnText ?? []) push(text)
        reply(msg.id, { stopReason: "end_turn" })
        /**
         * ★ 响应之后继续推 —— 真进程就是这个顺序（见 turnTextAfterResponse 的注释）。
         *
         * 用 setTimeout(0) 而不是同步推：同步推的话它们仍然在
         * `client.request` 的 await 让出之前就到了，测不出"读早了"这个 bug。
         */
        for (const [index, text] of (options.turnTextAfterResponse ?? []).entries()) {
          setTimeout(() => push(text), index + 1)
        }
        return
      }
      if (msg.method === "session/new") {
        if (options.failSessionNew === true) {
          replyError(msg.id, "session creation refused")
          return
        }
        newSessionSeq += 1
        reply(msg.id, { sessionId: `acp-p-${String(newSessionSeq)}` })
        return
      }
      if (msg.method === "session/resume") {
        reply(msg.id, {})
        return
      }
      reply(msg.id, { protocolVersion: 1 })
    },
    async close() {},
    get alive() {
      return true
    },
    pid: 4243,
  }
  function reply(id: number, result: unknown) {
    onLine?.(JSON.stringify({ jsonrpc: "2.0", id, result }))
  }
  function replyError(id: number, message: string) {
    onLine?.(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }))
  }
  return {
    transport,
    written,
    bind: (spec: DuplexSpec) => {
      onLine = spec.onLine
    },
  }
}

function makeAcp(options: {
  hasOpencode: boolean
  fake?: ReturnType<typeof fakeOpencode>
  onTrace?: (input: { conversationId: string; items: readonly ChatItem[]; done: boolean }) => void
}) {
  const resolved: ResolvedBinary = {
    name: "opencode",
    path: "/fake/opencode",
    platform: "darwin-arm64",
    source: "path",
  }
  const runtime = {
    tryResolveOpencode: () => (options.hasOpencode ? resolved : null),
    // 现在 PersonaAcp 走版本闸（resolveUsableOpencode）而不是裸 tryResolveOpencode。
    // hasOpencode 时给一个达标的结果，否则 missing —— 与旧 stub 语义一一对应。
    resolveUsableOpencode: () =>
      options.hasOpencode
        ? { ok: true as const, binary: resolved, version: "1.18.11" }
        : { ok: false as const, reason: "missing" as const },
  } as unknown as ConstructorParameters<typeof PersonaAcp>[0]["runtime"]
  const processes = {
    spawnDuplex: (spec: DuplexSpec): DuplexHandle => {
      if (options.fake === undefined) throw new Error("no fake transport")
      options.fake.bind(spec)
      return options.fake.transport
    },
  } as unknown as ConstructorParameters<typeof PersonaAcp>[0]["processes"]
  return new PersonaAcp({
    clock: new ManualClock(NOW),
    logger,
    runtime,
    processes,
    workspaceRoot: "/tmp/persona-ws-test",
    klRoot: "/fake/kl",
    klPort: 8200,
    ...(options.onTrace === undefined ? {} : { onTrace: options.onTrace }),
  })
}

describe("★ 降级信号：opencode 缺失时 available() 是 false", () => {
  it("装了 → true", () => {
    const acp = makeAcp({ hasOpencode: true, fake: fakeOpencode() })
    expect(acp.available()).toBe(true)
  })

  it("★ 没装 → false（PersonaService.generateDraft 据此走直连）", () => {
    const acp = makeAcp({ hasOpencode: false })
    /**
     * 反面：这个断言在别处很可能被写成"没装时 turn() 抛错"—— 但那时上层
     * 就必须 try/catch 一个能力性异常，容易被当成"我们的逻辑错"记 error。
     * 换成 `available()=false + turn()=null` 的形状，降级是**查询**得来的、
     * 不是从异常里推断出来的。
     */
    expect(acp.available()).toBe(false)
  })
})

describe("★★ turn 生命周期与文本收集", () => {
  it("拼多个 chunk 成一整段文本", async () => {
    const fake = fakeOpencode({ turnText: ["好", "的，", "帮你看一下"] })
    const acp = makeAcp({ hasOpencode: true, fake })
    const result = await acp.turn({ conversationId: "c1", prompt: "回一下最新那条" })
    // ★ turn 返回结构体：文本 + 工具名 + 用量 + 过程 items（见 AcpTurnResult）。
    // 前三样原来在这一层被丢掉，于是 `dh_agent_runs` 恒为 null、"agent 调了什么"
    // 只能靠推断；items 则是「看生成过程」的数据源。
    expect(result?.text).toBe("好的，帮你看一下")
    expect(result?.toolNames, "没调工具时是空数组（结论），不是 undefined").toEqual([])
  })

  it("★ 0-token 返回**null**，不是空串", async () => {
    /**
     * 0-token 是这条链路最典型的失效：模型没配对、配额耗尽、权限拒了工具
     * 而模型放弃。空串会被上层当作"内容为空的草稿"落库，在 UI 上看起来像
     * 模型判定"无需回复" —— 用户不会去查为什么模型不说话。
     */
    const fake = fakeOpencode({ turnText: [] })
    const acp = makeAcp({ hasOpencode: true, fake })
    /**
     * ★ 0-token 时 `text` 为 null，但**整个返回值不是 null** —— items 仍要带回来
     * （过程恰恰是"为什么没产出正文"的唯一线索：工具被拒？检索空？）。
     * 上层判的是 `acpTurn?.text ?? null`。
     */
    const empty = await acp.turn({ conversationId: "c1", prompt: "x" })
    expect(empty?.text).toBeNull()
  })

  /**
   * ★★ 回归锁：`session/prompt` 的响应回来时流**还没结束**。
   *
   * ## 这条锁的是一个真实发生过的 bug，不是假想
   *
   * 库里有一条 40 字符的草稿：`{"reply": "哈哈好", "holdForReview": false,`
   * —— 一个在 `false,` 之后硬断的 JSON。它不是模型输出坏了，是我们**读早了**：
   * `turn()` 曾在 `await client.request("session/prompt")` 的下一行就
   * `chunks.join("")`，而真进程的响应帧夹在 chunk 之间到达
   * （`scripts/probe-acp-stream.mjs` 的 dump：第 18 行 response，19-25 行还有 7 条 chunk）。
   *
   * 表现是**长度/时序相关的间歇失效**：短回复时流在响应前就发完了，看起来一切正常。
   * 所以它绝不能靠"手动跑一次看看"来守 —— 必须有这条断言。
   *
   * ## 判据是**完整的那一句**，不是"长度大于零"
   *
   * `expect(text).not.toBeNull()` 在这个 bug 下是**假绿**：截断的草稿也非空。
   * 只有断言拼出完整的 JSON 才说明尾部 chunk 真的被等到了。
   */
  it("★★ 响应之后到达的 chunk 也要收进来（截断草稿的回归锁）", async () => {
    const fake = fakeOpencode({
      // 响应**之前**到的部分：正好断在库里那条坏草稿的位置
      turnText: ['{"reply": "哈哈好", "holdForReview": false,'],
      // 响应**之后**才到的尾巴
      turnTextAfterResponse: [' "reviewReason"', ': ""}'],
    })
    const acp = makeAcp({ hasOpencode: true, fake })
    const result = await acp.turn({ conversationId: "c1", prompt: "x" })
    expect(result?.text).toBe('{"reply": "哈哈好", "holdForReview": false, "reviewReason": ""}')
    // 拿到的必须是**能解析**的信封 —— 半截 JSON 的形状在这里就被挡住
    expect(() => JSON.parse(result?.text ?? "")).not.toThrow()
  })

  it("★ turn 失败**不抛**，返回 null", async () => {
    const fake = fakeOpencode({ failSessionNew: true })
    const acp = makeAcp({ hasOpencode: true, fake })
    const result = await acp.turn({ conversationId: "c1", prompt: "x" })
    expect(result).toBeNull()
  })

  it("★ 跨轮复用 acpSessionId（不重开）", async () => {
    const fake = fakeOpencode({ turnText: ["回复"] })
    const acp = makeAcp({ hasOpencode: true, fake })
    await acp.turn({ conversationId: "c1", prompt: "第一轮" })
    await acp.turn({ conversationId: "c1", prompt: "第二轮" })
    const methods = fake.written
      .map((l) => (JSON.parse(l) as { method?: string }).method)
      .filter((m): m is string => m !== undefined)
    /**
     * 第一次要 session/new；第二次应当走 session/resume，绝**不能**再来一次 new
     * —— 那意味着 skill 装载、cwd 校验、握手全重来。
     */
    expect(methods.filter((m) => m === "session/new").length).toBe(1)
    expect(methods).toContain("session/resume")
  })
})

/**
 * ★★ 图片随 prompt 一起送（agent 能"看到"图的唯一通道）。
 *
 * ## 为什么必须是 prompt 里的 image block，而不是「给路径让它自己读」
 *
 * opencode 自己的 `read` 工具**在 deny 名单里**（`DENY_ALL_PERMISSION` 的
 * `"*": "deny"`）。放行它等于让 agent 能读 workspace 里全部文件（画像、
 * 别的 skill）—— 见 `tests/externals/opencode-permission.test.ts` 的文件头：
 * 「读画像 → webfetch 到攻击者服务器」是一条纯读路径的外传通道。
 *
 * 图由我们塞进 prompt，agent 不获得任何新的文件访问能力。
 *
 * ## 形状是从 opencode 二进制里挖出来的，不是猜的
 *
 * 它的 ACP prompt 分派代码：
 * ```js
 * case"image": if(n.data) return [{type:"file", url:`data:${n.mimeType};base64,${n.data}`, …}]
 * ```
 * 字段名是 `data`（不是 `base64`）、`mimeType`（不是 `mime`）。这一层的
 * 字段名踩过一次（`{kind}` vs `{type}` → `Invalid params -32602`），
 * 所以锁住它。
 */
describe("★★ prompt 里的图片块", () => {
  /** 取出这一轮 `session/prompt` 的 prompt 数组。 */
  function promptBlocks(fake: ReturnType<typeof fakeOpencode>): Record<string, unknown>[] {
    for (const line of fake.written) {
      const msg = JSON.parse(line) as {
        method?: string
        params?: { prompt?: Record<string, unknown>[] }
      }
      if (msg.method === "session/prompt") return msg.params?.prompt ?? []
    }
    return []
  }

  it("★ 不传 images 时只有一个文本块（没有图的会话不该多出任何东西）", async () => {
    const fake = fakeOpencode({ turnText: ["好"] })
    const acp = makeAcp({ hasOpencode: true, fake })
    await acp.turn({ conversationId: "c1", prompt: "在吗" })
    const blocks = promptBlocks(fake)
    expect(blocks.length).toBe(1)
    expect(blocks[0]?.["type"]).toBe("text")
  })

  it("★★ 传了 images → 每张一个 {type:'image'} 块，字段是 data + mimeType", async () => {
    const fake = fakeOpencode({ turnText: ["看到了"] })
    const acp = makeAcp({ hasOpencode: true, fake })
    await acp.turn({
      conversationId: "c1",
      prompt: "看这个 [图片 1]",
      images: [
        { base64: "AAAA", mimeType: "image/png", name: "a.png" },
        { base64: "BBBB", mimeType: "image/jpeg", name: "b.jpg" },
      ],
    })
    const blocks = promptBlocks(fake)
    expect(blocks.length, "文本块 + 2 张图").toBe(3)
    const images = blocks.filter((block) => block["type"] === "image")
    expect(images.length).toBe(2)
    /**
     * ★ 字段名必须与对端一致。写成 `base64`/`mime` 时 opencode 的
     * `if(n.data)` 分支不命中 → 那张图被**静默丢弃**（不报错、只是看不到）。
     */
    expect(images[0]?.["data"]).toBe("AAAA")
    expect(images[0]?.["mimeType"]).toBe("image/png")
    expect(images[1]?.["mimeType"]).toBe("image/jpeg")
  })

  it("★★ 文本块必须在**第一个** —— 图的归属靠正文里的 [图片 N] 建立", async () => {
    const fake = fakeOpencode({ turnText: ["嗯"] })
    const acp = makeAcp({ hasOpencode: true, fake })
    await acp.turn({
      conversationId: "c1",
      prompt: "他人: 看这个 [图片 1]",
      images: [{ base64: "AAAA", mimeType: "image/png", name: "a.png" }],
    })
    /**
     * ★ 反证：把图片块拼在文本前面时这里必红。
     *
     * 顺序反过来的后果不是报错，而是模型先看到一张无标注的图 ——
     * 它不知道那是谁发的、对应哪句话。而"把 A 的图当成 B 发的"
     * 在群聊里会直接产出一条答错人的回复。
     */
    expect(promptBlocks(fake)[0]?.["type"]).toBe("text")
  })
})

describe("★ release 撤 token（不撤会让被淘汰的 scope 仍可复用）", () => {
  it("release 后再 turn 会重开 session（因为 sessionIds 已清）", async () => {
    const fake = fakeOpencode({ turnText: ["回"] })
    const acp = makeAcp({ hasOpencode: true, fake })
    await acp.turn({ conversationId: "c1", prompt: "x" })
    acp.release("c1")
    await acp.turn({ conversationId: "c1", prompt: "y" })
    const newCount = fake.written
      .map((l) => (JSON.parse(l) as { method?: string }).method)
      .filter((m) => m === "session/new").length
    expect(newCount).toBe(2)
  })
})

/**
 * agent 过程可见（thinking / 正文 / tool 调用组）。
 *
 * 这一组锁的是两条**互相制约**的不变量。少任何一条都会退回到一个已经踩过的坑：
 *
 * · 过程要收进 `items`（否则「正在处理」那个面板只能显示一句静态废话）；
 * · 过程**绝不能**混进 `chunks` —— `settleStream` 靠 `chunks.join("")` 判
 *   "流稳了没有"，而那正是"半截 JSON 进草稿"的防线。混进去还会让模型的
 *   内心独白被拼进要发出去的正文。
 */
describe("★★ agent 过程：收进 items，但绝不污染要发送的正文", () => {
  it("★★ thinking 与 tool 调用**不进**草稿正文", async () => {
    const fake = fakeOpencode({
      thoughts: ["先看看他问的是哪个环境", "应该查一下部署记录"],
      toolCalls: [{ id: "t1", title: "查部署记录" }],
      turnText: ["沙箱昨天已经好了"],
    })
    const acp = makeAcp({ hasOpencode: true, fake, onTrace: () => {} })

    const result = await acp.turn({ conversationId: "c1", prompt: "x" })

    /**
     * ★ 正文**只有** text_delta 拼出来的那一段。
     *
     * 反证：把 thought/tool 的文本也 push 进 chunks 时，这里会变成
     * 「先看看他问的是哪个环境…沙箱昨天已经好了」—— 那句内心独白会被
     * 当成要发给对方的话发出去。
     */
    expect(result?.text).toBe("沙箱昨天已经好了")
    expect(result?.text).not.toContain("先看看")
    expect(result?.text).not.toContain("查部署记录")
  })

  it("★★ 过程收进 items：thinking + tool_call + 正文都在", async () => {
    const fake = fakeOpencode({
      thoughts: ["先确认是哪个环境"],
      toolCalls: [{ id: "t1", title: "查部署记录" }],
      turnText: ["沙箱昨天已经好了"],
    })
    const acp = makeAcp({ hasOpencode: true, fake, onTrace: () => {} })

    const result = await acp.turn({ conversationId: "c1", prompt: "x" })
    const types = (result?.items ?? []).map((item) => item.itemType)

    // 三类都要有 —— 少哪一类，UI 上那一类就整块消失。
    expect(types, `items 里缺东西：${JSON.stringify(types)}`).toContain("thought")
    expect(types).toContain("tool_call")
    expect(types).toContain("message")
    // 工具名要带上（渲染层靠它选图标与标题）
    expect((result?.items ?? []).some((item) => item.toolName === "查部署记录")).toBe(true)
  })

  it("★ onTrace 在轮末被调一次 done=true（UI 据此收起动效）", async () => {
    const seen: boolean[] = []
    const fake = fakeOpencode({ thoughts: ["嗯"], turnText: ["好"] })
    const acp = makeAcp({
      hasOpencode: true,
      fake,
      onTrace: ({ done }) => void seen.push(done),
    })

    await acp.turn({ conversationId: "c1", prompt: "x" })

    expect(seen.length, "onTrace 一次都没被调 —— 过程根本没推出去").toBeGreaterThan(0)
    expect(seen.at(-1), "最后一次必须是 done=true").toBe(true)
    // 中间那些是流式增量（done=false）
    expect(seen.filter((done) => !done).length).toBeGreaterThan(0)
  })
})
