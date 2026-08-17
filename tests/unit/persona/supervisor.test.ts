/**
 * 管控层：准入闸 / 合并窗口 / 并发上限 / LRU / kill switch。
 *
 * 全部**注入 ManualClock**：合并窗口（3s）、空闲回收（10min）
 * 靠 sleep 测不了 —— 前者会让测试变慢且不稳，后者压根等不起。
 *
 * 这一层刻意不含 LLM（需求要求「管控层足够稳定」），
 * 所以它 100% 可单测 —— 这条测试文件的存在本身就是那个设计决策的验证。
 */
import { describe, expect, it } from "vitest"
import { createLogger, ManualClock, MS_PER_MINUTE } from "@mycontext/kernel"
import {
  admit,
  DEFAULT_QUIET_MS,
  DEFAULT_TRIGGER_MODE_DIRECT,
  DEFAULT_TRIGGER_MODE_GROUP,
  MAX_DIRECT_DRAFTABLE_AGE_MS,
  MAX_GROUP_DRAFTABLE_AGE_MS,
  PersonaSupervisor,
  READ_REPLY_EXPIRY_MS,
  type AdmissionInput,
} from "@mycontext/persona"
import { ConversationRepository, MessageRepository } from "@mycontext/store"
import type { ConversationRow, MessageRow } from "@mycontext/store"
import { openTestVault, type TestVault } from "../../helpers/vault.js"

const START = 1_785_000_000_000

function message(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "m-1",
    channelId: "dingtalk",
    conversationId: "conv-1",
    externalId: "ext-1",
    senderActorId: null,
    senderExternalId: "DeOTHER",
    senderDisplayName: "小李",
    contentText: "沙箱环境好了吗",
    contentJson: null,
    quotedExternalId: null,
    threadId: null,
    sentAt: START,
    direction: "inbound",
    isSelf: false,
    origin: "human",
    hasMedia: false,
    rawRecordId: null,
    revision: 1,
    /**
     * ★ 打标之后的行（v30）。`null` = 打标之前入库的存量行 ——
     * 学习侧对 null 视为**合格**（那些行当时通过了更严的旧闸）。
     */
    learningEligible: true,
    createdAt: START,
    ...overrides,
  }
}

function conversation(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: "conv-1",
    channelId: "dingtalk",
    externalId: "cid-1",
    type: "group",
    title: "沙箱项目群",
    memberCount: 12,
    isSelfInvolved: true,
    isBotChannel: false,
    lastMessageAt: START,
    createdAt: START,
    ...overrides,
  }
}

function admission(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    message: message(),
    conversation: conversation(),
    config: { replyMode: "draft", triggerMode: "all", keywords: [] },
    mentionsSelf: false,
    killSwitchActive: false,
    now: START,
    conversationRead: false,
    turnAnswered: false,
    ...overrides,
  }
}

describe("准入闸（全是确定性判断）", () => {
  it("触发条件为 all → 接纳", () => {
    expect(admit(admission())).toEqual({ ok: true })
  })

  it("kill switch 优先于一切", () => {
    expect(admit(admission({ killSwitchActive: true }))).toEqual({
      ok: false,
      reason: "kill_switch",
    })
  })

  /**
   * ★ 这一条是本轮架构改动的核心断言。
   *
   * 首版准入闸第二条是 `if (!config.listening) → not_listening`，而
   * `listening` DDL 默认 0 —— 于是**没配过的会话一律被丢**。实测后果：
   * 投递 200 条、拒 184 条，绝大多数就是这一条。也就是默认什么都不做，
   * 而这个账号有 86 个会话，逐个开开关是不可能的。
   *
   * 现在管控层是订阅者：没配过 = 用缺省，不是丢掉。
   */
  it("★ 从没配过的会话（config = null）也要被接纳 —— 不是丢掉", () => {
    // 群聊 + 缺省触发条件（mention）+ @了我 → 进队列
    expect(admit(admission({ config: null, mentionsSelf: true }))).toEqual({ ok: true })
  })

  /**
   * ★★ 没配过的**单聊**默认**不触发**。
   *
   * 缺省按会话类型分流（见 `resolveTriggerMode`）：群聊 `mention`、
   * 单聊 `none`。曾经单聊的缺省等价于"每条都回"，理由是"单聊里对方说的
   * 每句本来就是对你说的"—— 但那让**用户从没配过**的私聊在他毫不知情时
   * 就开始起草稿。"默认不动，除非我说要动"才是更稳妥的预期。
   *
   * 这条与下面那条（显式配了就照配的来）必须同时存在：只有这一条时，
   * "把单聊一律焊死"的实现也会通过。
   */
  it("★ 单聊 config = null → 不触发（没主动配过的私聊默认不打扰）", () => {
    expect(
      admit(
        admission({
          config: null,
          mentionsSelf: false,
          conversation: conversation({ type: "direct" }),
        }),
      ),
    ).toEqual({ ok: false, reason: "trigger_none" })
  })

  it("★ 单聊显式配成 all/mention → 照配的来（缺省只在没配过时生效）", () => {
    for (const triggerMode of ["all", "mention"] as const) {
      expect(
        admit(
          admission({
            config: { replyMode: "draft", triggerMode, keywords: [] },
            mentionsSelf: false,
            conversation: conversation({ type: "direct" }),
          }),
        ),
        `单聊显式 ${triggerMode} 应该进队列`,
      ).toEqual({ ok: true })
    }
  })

  /**
   * ★ 把两个缺省**常量本身**钉住。
   *
   * 上面几条测的是行为，但行为可以被别的分支改对而常量改错（例如有人把
   * 单聊缺省改成 `mention`，而 `mention` 在单聊里等价于"全回" —— 行为断言
   * 里那条"不触发"会红，但如果只有 admit 层的断言，很容易被一个
   * `if (direct) return true` 的补丁盖过去）。这条直接锁产品决定：
   * 单聊没配过 = 不触发，群聊没配过 = 只在 @我 时。
   */
  it("★ 缺省触发常量：单聊 none / 群聊 mention", () => {
    expect(DEFAULT_TRIGGER_MODE_DIRECT).toBe("none")
    expect(DEFAULT_TRIGGER_MODE_GROUP).toBe("mention")
  })

  it("群聊 + 缺省触发条件 + 没 @我 → trigger_not_matched（成本闸，不是权限闸）", () => {
    // 群里每条都过一次模型是在烧钱，所以缺省收窄到 @我
    expect(admit(admission({ config: null, mentionsSelf: false }))).toEqual({
      ok: false,
      reason: "trigger_not_matched",
    })
  })

  it("数字人自己发的消息不触发它自己（否则自问自答）", () => {
    expect(admit(admission({ message: message({ origin: "agent" }) }))).toEqual({
      ok: false,
      reason: "origin_agent",
    })
  })

  it("本人发的消息不需要回（数字人代表的就是本人）", () => {
    expect(admit(admission({ message: message({ isSelf: true }) }))).toEqual({
      ok: false,
      reason: "is_self",
    })
  })

  it("机器人群直接丢", () => {
    expect(admit(admission({ conversation: conversation({ isBotChannel: true }) }))).toEqual({
      ok: false,
      reason: "bot_channel",
    })
  })

  it("与自己的单聊直接丢", () => {
    expect(admit(admission({ conversationExclusion: "self_conversation" }))).toEqual({
      ok: false,
      reason: "self_conversation",
    })
  })

  it("is_self 未判定（null）时仍接纳 —— 那是别人的消息或还没判定，不该拦", () => {
    expect(admit(admission({ message: message({ isSelf: null }) }))).toEqual({ ok: true })
  })

  it("已读且超过 4 小时未回复的历史消息不进入回复队列", () => {
    expect(
      admit(
        admission({
          now: START + 4 * 60 * MS_PER_MINUTE + 1,
          conversationRead: true,
        }),
      ),
    ).toEqual({ ok: false, reason: "stale_message" })
  })

  it("超过 4 小时但仍未读的消息继续进入回复队列（群里还在 24 小时内）", () => {
    expect(
      admit(
        admission({
          now: START + 4 * 60 * MS_PER_MINUTE + 1,
          conversationRead: false,
        }),
      ),
    ).toEqual({ ok: true })
  })

  /**
   * ★ 未读**不等于**没有年龄上限。
   *
   * 这一组是真机故障的回归测试：历史回填把 7/13 的消息补进库，数字人给
   * 一条 **19 天前**的群消息起了草稿。当时唯一的年龄判据带
   * `conversationRead` 前置条件，而那两个群分别有 3 条 / 7 条未读 ——
   * 于是既过不了"已读"那一关，也没有别的判据拦它。
   *
   * 「已读」应该只影响**多久算过时**，不该决定**会不会过时**。
   */
  it("★ 群里 19 天前的消息即使未读也不起草（真机故障的形状）", () => {
    expect(
      admit(
        admission({
          now: START + 19 * 24 * 60 * MS_PER_MINUTE,
          conversationRead: false,
        }),
      ),
    ).toEqual({ ok: false, reason: "stale_message" })
  })

  it("群里刚过 24 小时就不再起草", () => {
    expect(
      admit(
        admission({
          now: START + MAX_GROUP_DRAFTABLE_AGE_MS + 1,
          conversationRead: false,
        }),
      ),
    ).toEqual({ ok: false, reason: "stale_message" })
  })

  it("群里 24 小时内仍然起草（跨夜回一句仍是正常社交动作）", () => {
    expect(
      admit(
        admission({
          now: START + MAX_GROUP_DRAFTABLE_AGE_MS - 60_000,
          conversationRead: false,
        }),
      ),
    ).toEqual({ ok: true })
  })

  it("★ 单聊的上限更短（4 小时）——一对一等一天才回本身就是另一个问题", () => {
    expect(
      admit(
        admission({
          conversation: conversation({ type: "direct" }),
          // 显式配 all：单聊的**缺省**是 none，不配的话会先被 trigger_none 短路，
          // 这条就验不到年龄上限了（假绿：理由对不上）。
          config: { replyMode: "draft", triggerMode: "all", keywords: [] },
          mentionsSelf: false,
          now: START + MAX_DIRECT_DRAFTABLE_AGE_MS + 1,
          conversationRead: false,
        }),
      ),
    ).toEqual({ ok: false, reason: "stale_message" })
  })

  it("单聊 4 小时内仍然起草", () => {
    expect(
      admit(
        admission({
          conversation: conversation({ type: "direct" }),
          config: { replyMode: "draft", triggerMode: "all", keywords: [] },
          mentionsSelf: false,
          now: START + MAX_DIRECT_DRAFTABLE_AGE_MS - 60_000,
          conversationRead: false,
        }),
      ),
    ).toEqual({ ok: true })
  })

  it("同会话已有更晚的本人回复时不再进入队列", () => {
    expect(admit(admission({ turnAnswered: true }))).toEqual({
      ok: false,
      reason: "already_answered",
    })
  })
})

describe("触发条件", () => {
  it("mention 模式只接纳 @我 的（群里每条都回是骚扰）", () => {
    const config = {
      listening: true,
      replyMode: "draft" as const,
      triggerMode: "mention" as const,
      keywords: [],
    }
    expect(admit(admission({ config, mentionsSelf: false })).ok).toBe(false)
    expect(admit(admission({ config, mentionsSelf: true })).ok).toBe(true)
  })

  it("keyword 模式按正文匹配", () => {
    const config = {
      listening: true,
      replyMode: "draft" as const,
      triggerMode: "keyword" as const,
      keywords: ["沙箱", "发布"],
    }
    expect(admit(admission({ config })).ok).toBe(true)
    expect(admit(admission({ config, message: message({ contentText: "今天天气不错" }) })).ok).toBe(
      false,
    )
  })

  it("keyword 模式下空关键词不匹配任何东西（防止空串命中一切）", () => {
    const config = {
      listening: true,
      replyMode: "draft" as const,
      triggerMode: "keyword" as const,
      keywords: [""],
    }
    expect(admit(admission({ config })).ok).toBe(false)
  })
})

/**
 * 把消息与会话真实落库。
 *
 * `dh_inbox.message_id` 有到 `messages(id)` 的外键 —— 这是刻意的
 * （消息被删时信箱条目也该消失），所以测试必须先 seed。
 */
function seed(vault: TestVault, entries: readonly { id: string; conversationId: string }[]): void {
  const conversations = new ConversationRepository(vault.db)
  const messages = new MessageRepository(vault.db)
  const seenConversations = new Set<string>()

  for (const entry of entries) {
    if (!seenConversations.has(entry.conversationId)) {
      seenConversations.add(entry.conversationId)
      conversations.upsert({
        id: entry.conversationId,
        channelId: "dingtalk",
        externalId: `ext-${entry.conversationId}`,
        type: "group",
        createdAt: START,
      })
    }
    messages.upsertMany([
      {
        id: entry.id,
        channelId: "dingtalk",
        conversationId: entry.conversationId,
        externalId: `msg-${entry.id}`,
        contentText: "沙箱环境好了吗",
        sentAt: START,
        direction: "inbound",
        createdAt: START,
      },
    ])
  }
}

function setupSupervisor(
  options: {
    maxResident?: number
    maxConcurrentTurns?: number
    maxBatchSize?: number
    /** 额外要预先落库的消息（批次上限那组要造上百条） */
    extraMessages?: readonly { id: string; conversationId: string }[]
    handleBatch?: (conversationId: string, ids: readonly string[]) => Promise<void>
    /** 覆盖静默期；缺省 0（这一组验批次语义，见下面 quietMs 那处注释） */
    quietMs?: number
  } = {},
) {
  const vault = openTestVault()
  const clock = new ManualClock(START)
  // 预先落库测试里会用到的消息：dh_inbox 有到 messages 的外键。
  // 一次性 seed 比每个用例各自 seed 清楚 —— 用例关心的是调度行为，不是建表。
  seed(vault, [
    { id: "m-1", conversationId: "conv-1" },
    { id: "a", conversationId: "conv-1" },
    { id: "b", conversationId: "conv-1" },
    { id: "c", conversationId: "conv-1" },
    { id: "m-0", conversationId: "conv-1" },
    { id: "m-2", conversationId: "conv-1" },
    { id: "m-pending", conversationId: "conv-1" },
    { id: "m-done", conversationId: "conv-1" },
    { id: "m-conv-a", conversationId: "conv-a" },
    { id: "m-conv-b", conversationId: "conv-b" },
    { id: "m-conv-c", conversationId: "conv-c" },
    { id: "m-conv-bad", conversationId: "conv-bad" },
    { id: "m-conv-good", conversationId: "conv-good" },
    ...(options.extraMessages ?? []),
  ])
  const created: string[] = []
  const disposed: string[] = []
  const handled: { conversationId: string; ids: readonly string[] }[] = []

  const supervisor = new PersonaSupervisor({
    db: vault.db,
    clock,
    /**
     * ★ 这一组用例验的是**批次**语义（合并窗口、上限、LRU、并发），
     * 所以显式关掉「对方说完了」的静默期 —— 它们推进时钟的量
     * （`advance(3000)`）针对的是固定窗口那一个判据。
     *
     * 静默期本身由 mailbox 那组专门验（见 `DEFAULT_QUIET_MS` 的用例）。
     * 不关掉的话这里每个用例都要多推 6 秒，而它们想说的事与静默期无关。
     */
    quietMs: options.quietMs ?? 0,
    logger: createLogger("test", { level: "error" }),
    createAgent: (id) => {
      created.push(id)
      return Promise.resolve()
    },
    disposeAgent: (id) => {
      disposed.push(id)
      return Promise.resolve()
    },
    handleBatch:
      options.handleBatch ??
      ((conversationId, ids) => {
        handled.push({ conversationId, ids })
        return Promise.resolve()
      }),
    ...(options.maxResident === undefined ? {} : { maxResident: options.maxResident }),
    ...(options.maxConcurrentTurns === undefined
      ? {}
      : { maxConcurrentTurns: options.maxConcurrentTurns }),
    ...(options.maxBatchSize === undefined ? {} : { maxBatchSize: options.maxBatchSize }),
  })

  return { vault, clock, supervisor, created, disposed, handled }
}

describe("★ 合并窗口（连打三句只回一次）", () => {
  it("窗口未到时不派发", async () => {
    const context = setupSupervisor()
    context.supervisor.onInbound(admission())
    // 立刻 tick：还没攒够 3 秒
    expect((await context.supervisor.tick()).dispatched).toBe(0)
    expect(context.handled).toEqual([])
    context.vault.close()
  })

  it("窗口到了之后一次派发整批", async () => {
    const context = setupSupervisor()
    for (const [index, text] of ["那个", "沙箱的事", "你看一下"].entries()) {
      context.supervisor.onInbound(
        admission({ message: message({ id: `m-${index}`, contentText: text }) }),
      )
      context.clock.advance(200)
    }

    context.clock.advance(3000)
    const result = await context.supervisor.tick()
    expect(result.dispatched).toBe(1)
    // ★ 三条消息合成一批 —— 逐条回复会得到三条刷屏式回应
    expect(context.handled[0]?.ids).toEqual(["m-0", "m-1", "m-2"])
    context.vault.close()
  })
})

describe("★ 快通道与慢兜底按 message_id 去重", () => {
  it("同一条消息第二次入队返回 false", () => {
    const context = setupSupervisor()
    expect(context.supervisor.onInbound(admission())).toBe(true)
    // 兜底扫描又捞到同一条
    expect(context.supervisor.onInbound(admission())).toBe(false)
    expect(context.supervisor.mailbox.pendingCount()).toBe(1)
    context.vault.close()
  })

  it("被丢弃的消息也记进去重集合（兜底扫描不会重新捞它）", () => {
    const context = setupSupervisor()
    context.supervisor.onInbound(admission({ config: null }))
    // 第二次（这次配置开了）仍然返回 false —— 已经处置过了
    expect(context.supervisor.onInbound(admission())).toBe(false)
    context.vault.close()
  })
})

describe("丢弃原因可见", () => {
  it("drop 记原因，可按原因统计（用户要能看到「为什么没回」）", () => {
    const context = setupSupervisor()
    context.supervisor.onInbound(
      admission({ message: message({ id: "a" }), config: null, mentionsSelf: false }),
    )
    context.supervisor.onInbound(admission({ message: message({ id: "b", origin: "agent" }) }))
    context.supervisor.onInbound(
      admission({
        message: message({ id: "c" }),
        conversation: conversation({ isBotChannel: true }),
      }),
    )

    expect(context.supervisor.mailbox.dropStats()).toEqual({
      // 群聊没 @我 —— 缺省触发条件把它挡在成本闸外（不是"没开监听"）
      trigger_not_matched: 1,
      origin_agent: 1,
      bot_channel: 1,
    })
    context.vault.close()
  })
})

/**
 * ★ 并发上限。
 *
 * ## 这一组曾经是**恒真**的，而那掩盖了一个真 bug
 *
 * 原来的断言是 `dispatched + skippedBusy === 2` —— 一个**和**。
 * 而那个和在"真并发"与"其实是串行"两种实现下都成立，
 * 所以它没能发现：`tick` 里当时写的是 `await handleBatch(...)`，
 * 于是每个 turn 串行跑完才轮到下一个，`runningTurns` 永远只到 1，
 * `MAX_CONCURRENT_TURNS` **从未生效过**。
 *
 * 实测（探针）：给上限 3、投 4 个会话 → 并发峰值 **1**。
 *
 * 后果不只是慢：三个会话同时来消息时第三个要等前两个各一次完整的
 * 模型调用（3-8 秒/次），也就是 20 秒后才开始 —— 而目标是 15-20 秒内
 * 响应 @我。
 *
 * 所以现在断言的是**并发峰值**，不是任何一个和。
 */
describe("★ 并发上限（真并发，且超出的排队）", () => {
  /**
   * 观测并发峰值的 handleBatch。
   *
   * 用一个真的 `setTimeout` 而不是 ManualClock：这里要观测的是
   * **事件循环上真的有几个 turn 在飞**，那与虚拟时钟无关。
   * 20ms × 少量会话，对测试时长没有影响。
   */
  function peakProbe() {
    const state = { concurrent: 0, peak: 0 }
    return {
      state,
      handleBatch: async () => {
        state.concurrent += 1
        state.peak = Math.max(state.peak, state.concurrent)
        await new Promise((resolve) => setTimeout(resolve, 20))
        state.concurrent -= 1
      },
    }
  }

  it("★ 上限 3 + 4 个会话 → 并发峰值真的到 3（不是 1）", async () => {
    const probe = peakProbe()
    const context = setupSupervisor({ maxConcurrentTurns: 3, handleBatch: probe.handleBatch })
    for (const id of ["conv-a", "conv-b", "conv-c", "conv-good"]) {
      context.supervisor.onInbound(
        admission({
          message: message({ id: `m-${id}`, conversationId: id }),
          conversation: conversation({ id }),
        }),
      )
    }
    context.clock.advance(3000)
    const result = await context.supervisor.tick()

    /**
     * 峰值恰好是上限：到 3 说明真并发，只到 1 说明还是串行。
     * 这条断言在串行实现下必然失败 —— 那正是它存在的理由。
     */
    expect(probe.state.peak).toBe(3)
    // 第 4 个被上限挡住，下一轮再来
    expect(result.dispatched).toBe(3)
    expect(result.skippedBusy).toBe(1)
    context.vault.close()
  })

  it("上限 1 时确实只跑一个（上限要真的是上限）", async () => {
    const probe = peakProbe()
    const context = setupSupervisor({ maxConcurrentTurns: 1, handleBatch: probe.handleBatch })
    for (const id of ["conv-a", "conv-b"]) {
      context.supervisor.onInbound(
        admission({
          message: message({ id: `m-${id}`, conversationId: id }),
          conversation: conversation({ id }),
        }),
      )
    }
    context.clock.advance(3000)
    const result = await context.supervisor.tick()

    // 反面：不能靠"并发永远是 1"来通过上一条
    expect(probe.state.peak).toBe(1)
    expect(result.skippedBusy).toBe(1)
    context.vault.close()
  })

  it("单个会话失败不影响同轮的其他会话（并发之后这一条更要紧）", async () => {
    const done: string[] = []
    const context = setupSupervisor({
      maxConcurrentTurns: 3,
      handleBatch: (conversationId) => {
        if (conversationId === "conv-bad") return Promise.reject(new Error("boom"))
        done.push(conversationId)
        return Promise.resolve()
      },
    })
    for (const id of ["conv-bad", "conv-good"]) {
      context.supervisor.onInbound(
        admission({
          message: message({ id: `m-${id}`, conversationId: id }),
          conversation: conversation({ id }),
        }),
      )
    }
    context.clock.advance(3000)
    // tick 本身不抛 —— 并发之后一个 reject 很容易把整轮带走
    await expect(context.supervisor.tick()).resolves.toBeTruthy()
    expect(done).toEqual(["conv-good"])
    context.vault.close()
  })
})

describe("★ LRU 与空闲回收", () => {
  it("超过常驻上限时淘汰最久未使用的", async () => {
    const context = setupSupervisor({ maxResident: 2 })

    for (const id of ["conv-a", "conv-b", "conv-c"]) {
      context.supervisor.onInbound(
        admission({
          message: message({ id: `m-${id}`, conversationId: id }),
          conversation: conversation({ id }),
        }),
      )
      context.clock.advance(3100)
      await context.supervisor.tick()
    }

    // conv-a 最久未用 → 被淘汰
    expect(context.disposed).toContain("conv-a")
    expect(context.supervisor.residentConversations().map((a) => a.conversationId)).not.toContain(
      "conv-a",
    )
    context.vault.close()
  })

  it("空闲超时的会话被回收（连同它的 token）", async () => {
    const context = setupSupervisor()
    context.supervisor.onInbound(admission())
    context.clock.advance(3100)
    await context.supervisor.tick()
    expect(context.supervisor.residentConversations().length).toBe(1)

    // 空闲 11 分钟（默认阈值 10 分钟）
    context.clock.advance(11 * MS_PER_MINUTE)
    await context.supervisor.tick()
    expect(context.disposed).toContain("conv-1")
    expect(context.supervisor.residentConversations()).toEqual([])
    context.vault.close()
  })

  it("dispose 失败不影响调度继续（单会话故障隔离）", async () => {
    const vault = openTestVault()
    seed(vault, [
      { id: "m-conv-a", conversationId: "conv-a" },
      { id: "m-conv-b", conversationId: "conv-b" },
    ])
    const clock = new ManualClock(START)
    const supervisor = new PersonaSupervisor({
      db: vault.db,
      clock,
      logger: createLogger("test", { level: "error" }),
      createAgent: () => Promise.resolve(),
      disposeAgent: () => Promise.reject(new Error("dispose failed")),
      handleBatch: () => Promise.resolve(),
      maxResident: 1,
    })

    for (const id of ["conv-a", "conv-b"]) {
      supervisor.onInbound(
        admission({
          message: message({ id: `m-${id}`, conversationId: id }),
          conversation: conversation({ id }),
        }),
      )
      clock.advance(3100)
      await expect(supervisor.tick()).resolves.toBeDefined()
    }
    vault.close()
  })
})

describe("★ 单会话失败不影响整轮调度", () => {
  it("handleBatch 抛错时其它会话仍被处理", async () => {
    const handled: string[] = []
    const context = setupSupervisor({
      handleBatch: (conversationId) => {
        if (conversationId === "conv-bad") return Promise.reject(new Error("agent crashed"))
        handled.push(conversationId)
        return Promise.resolve()
      },
    })

    for (const id of ["conv-bad", "conv-good"]) {
      context.supervisor.onInbound(
        admission({
          message: message({ id: `m-${id}`, conversationId: id }),
          conversation: conversation({ id }),
        }),
      )
    }
    context.clock.advance(3100)
    await context.supervisor.tick()

    expect(handled).toEqual(["conv-good"])
    context.vault.close()
  })
})

describe("★ kill switch", () => {
  it("激活后一切入站都被丢弃", () => {
    const context = setupSupervisor()
    context.supervisor.setKillSwitch(true)
    expect(context.supervisor.onInbound(admission())).toBe(false)
    expect(context.supervisor.mailbox.dropStats()).toMatchObject({ kill_switch: 1 })
    context.vault.close()
  })

  it("激活后 tick 不派发（已入队的也不处理）", async () => {
    const context = setupSupervisor()
    context.supervisor.onInbound(admission())
    context.clock.advance(3100)
    context.supervisor.setKillSwitch(true)
    expect((await context.supervisor.tick()).dispatched).toBe(0)
    context.vault.close()
  })

  it("关掉后恢复正常", async () => {
    const context = setupSupervisor()
    context.supervisor.setKillSwitch(true)
    context.supervisor.setKillSwitch(false)
    context.supervisor.onInbound(admission())
    context.clock.advance(3100)
    expect((await context.supervisor.tick()).dispatched).toBe(1)
    context.vault.close()
  })
})

describe("★ 崩溃重启不丢待处理消息", () => {
  it("restore 把 pending 的捞回内存", async () => {
    const first = setupSupervisor()
    first.supervisor.onInbound(admission({ message: message({ id: "m-pending" }) }))
    expect(first.supervisor.mailbox.pendingCount()).toBe(1)

    // 模拟重启：同一个库，新的 supervisor（内存队列是空的）
    const clock = new ManualClock(START + 1000)
    const restarted = new PersonaSupervisor({
      db: first.vault.db,
      clock,
      logger: createLogger("test", { level: "error" }),
      createAgent: () => Promise.resolve(),
      disposeAgent: () => Promise.resolve(),
      handleBatch: () => Promise.resolve(),
      // 这个用例验的是"重启后捞回来还能派发"，与静默期无关（同 setupSupervisor）
      quietMs: 0,
    })
    expect(restarted.mailbox.pendingCount()).toBe(0)
    expect(restarted.mailbox.restore()).toBe(1)
    expect(restarted.mailbox.pendingCount()).toBe(1)

    // 恢复后能正常派发
    clock.advance(3100)
    expect((await restarted.tick()).dispatched).toBe(1)
    first.vault.close()
  })

  it("已处理的不会被 restore 捞回来", () => {
    const context = setupSupervisor()
    context.supervisor.onInbound(admission({ message: message({ id: "m-done" }) }))
    context.supervisor.mailbox.markProcessed(["m-done"])

    const clock = new ManualClock(START)
    const restarted = new PersonaSupervisor({
      db: context.vault.db,
      clock,
      logger: createLogger("test", { level: "error" }),
      createAgent: () => Promise.resolve(),
      disposeAgent: () => Promise.resolve(),
      handleBatch: () => Promise.resolve(),
    })
    expect(restarted.mailbox.restore()).toBe(0)
    context.vault.close()
  })

  it("已有本人后续回复的 pending 消息不会被 restore 捞回来", () => {
    const context = setupSupervisor({
      extraMessages: [{ id: "m-answered", conversationId: "conv-1" }],
    })
    context.supervisor.onInbound(admission({ message: message({ id: "m-answered" }) }))
    new MessageRepository(context.vault.db).upsertMany([
      {
        ...message({
          id: "m-self-reply",
          externalId: "ext-self-reply",
          sentAt: START + 1000,
          direction: "outbound",
          isSelf: true,
        }),
      },
    ])

    const restarted = new PersonaSupervisor({
      db: context.vault.db,
      clock: new ManualClock(START + 2000),
      logger: createLogger("test", { level: "error" }),
      createAgent: () => Promise.resolve(),
      disposeAgent: () => Promise.resolve(),
      handleBatch: () => Promise.resolve(),
    })

    expect(restarted.mailbox.restore()).toBe(0)
    expect(
      context.vault.db
        .prepare<
          [],
          { state: string; drop_reason: string }
        >("SELECT state, drop_reason FROM dh_inbox WHERE message_id = 'm-answered'")
        .get(),
    ).toEqual({ state: "dropped", drop_reason: "already_answered" })
    context.vault.close()
  })
})

/**
 * ★ 一个 turn 在跑时新来的消息如何累积 —— 以及累积必须有上限。
 *
 * ## 为什么要上限
 *
 * "turn 在跑 → 新消息进 pending → 下一轮一起给"这个行为是**刻意的**
 * （turn 里 agent 正在读上下文，中途插消息会让它回半截的东西）。
 * 但一个活跃群 10 分钟能来上百条，全塞进 prompt 会**爆 context** ——
 * 而爆的形态是模型返回截断的回复或直接报错，看起来像"模型不行"。
 *
 * 取**最新的** N 条而不是最早的：数字人要回的是"现在在说什么"，
 * 一小时前那条已经没人在等回复了。
 *
 * ## overflow 必须报出来
 *
 * 不报的话"合并了 200 条"与"只看了最新 30 条"在结果上分不出来 ——
 * 而后者意味着 agent 漏看了前面的上下文。
 */
describe("★ 批次上限：累积不能无上限地涌进 prompt", () => {
  /** 造 n 条消息 id。 */
  function ids(count: number): { id: string; conversationId: string }[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `flood-${index}`,
      conversationId: "conv-1",
    }))
  }

  it("★ 200 条涌进来 → 只取上限那么多，且报出丢了多少", async () => {
    const flood = ids(200)
    const context = setupSupervisor({ maxBatchSize: 30, extraMessages: flood })
    for (const entry of flood) {
      context.supervisor.onInbound(admission({ message: message({ id: entry.id }) }))
    }
    context.clock.advance(3000)

    const batch = context.supervisor.mailbox.takeBatch("conv-1")
    expect(batch.entries).toHaveLength(30)
    // 不报 overflow 的话"合并了 200 条"与"只看了 30 条"分不出来
    expect(batch.overflow).toBe(170)
    const dropped = context.vault.db
      .prepare<
        [],
        { c: number }
      >("SELECT count(*) AS c FROM dh_inbox WHERE state = 'dropped' AND drop_reason = 'batch_overflow'")
      .get()?.c
    expect(dropped).toBe(170)
    context.vault.close()
  })

  it("★ 留的是**最新**的那批（数字人要回的是「现在在说什么」）", async () => {
    const flood = ids(50)
    const context = setupSupervisor({ maxBatchSize: 5, extraMessages: flood })
    for (const entry of flood) {
      context.supervisor.onInbound(admission({ message: message({ id: entry.id }) }))
    }
    context.clock.advance(3000)

    const taken = context.supervisor.mailbox.takeBatch("conv-1").entries.map((e) => e.messageId)
    // 最后 5 条，不是最前 5 条
    expect(taken).toEqual(["flood-45", "flood-46", "flood-47", "flood-48", "flood-49"])
    context.vault.close()
  })

  it("没超上限时 overflow 是 0（不能恒报一个非零值）", async () => {
    const context = setupSupervisor({ maxBatchSize: 30 })
    context.supervisor.onInbound(admission())
    context.clock.advance(3000)
    const batch = context.supervisor.mailbox.takeBatch("conv-1")
    expect(batch.entries).toHaveLength(1)
    expect(batch.overflow).toBe(0)
    context.vault.close()
  })
})

/**
 * ★ turn 反复失败要放弃，而不是永远每 8 秒重试一次。
 *
 * turn 失败时 `markProcessed` 不会被调，那批消息留在 pending 里下一轮重来。
 * 对暂时性错误（网关限流）这是对的；但对**必然失败**的输入
 * （超长、含让网关 400 的字符）它会永远重试 —— 烧配额、刷日志，
 * 而表现只是"这个会话一直没有回复"。
 */
describe("★ turn 失败计数：坏输入不能无限重试", () => {
  it("失败次数没到上限时不放弃（暂时性错误要留着重试）", async () => {
    const context = setupSupervisor({
      handleBatch: () => Promise.reject(new Error("gateway 429")),
    })
    context.supervisor.onInbound(admission())
    context.clock.advance(3000)
    await context.supervisor.tick()

    expect(context.supervisor.mailbox.failureCount("conv-1")).toBe(1)
    // 还没标 failed —— 下一轮还会重试
    const state = context.vault.db
      .prepare<[string], { state: string }>("SELECT state FROM dh_inbox WHERE message_id = ?")
      .get("m-1")
    expect(state?.state).toBe("pending")
    context.vault.close()
  })

  it("★ 连续失败到上限 → 标 failed 并记原因（于是它在日志里可见）", async () => {
    const context = setupSupervisor({
      handleBatch: () => Promise.reject(new Error("content too long")),
    })
    // 三轮：每轮都要重新入队（失败时没有 markProcessed，但内存队列已被 take 走）
    for (let round = 0; round < 3; round += 1) {
      context.supervisor.onInbound(admission({ message: message({ id: `m-${round}` }) }))
      context.clock.advance(3000)
      await context.supervisor.tick()
    }

    const row = context.vault.db
      .prepare<
        [string],
        { state: string; drop_reason: string | null }
      >("SELECT state, drop_reason FROM dh_inbox WHERE message_id = ?")
      .get("m-2")
    expect(row?.state).toBe("failed")
    /**
     * 原因要记下来 —— 放弃时**消失**是最糟的形态：
     * 用户看到"待处理 0、草稿 0"，而那条消息其实是被放弃的。
     */
    expect(row?.drop_reason).toContain("turn_failed")
    expect(row?.drop_reason).toContain("content too long")
    context.vault.close()
  })

  it("成功一次就清零（偶发失败不该累积到放弃）", async () => {
    let fail = true
    const context = setupSupervisor({
      handleBatch: () => (fail ? Promise.reject(new Error("blip")) : Promise.resolve()),
    })
    context.supervisor.onInbound(admission({ message: message({ id: "m-0" }) }))
    context.clock.advance(3000)
    await context.supervisor.tick()
    expect(context.supervisor.mailbox.failureCount("conv-1")).toBe(1)

    fail = false
    context.supervisor.onInbound(admission({ message: message({ id: "m-1" }) }))
    context.clock.advance(3000)
    await context.supervisor.tick()
    expect(context.supervisor.mailbox.failureCount("conv-1")).toBe(0)
    context.vault.close()
  })
})

/** ★ 运行参数热改：用户调完立刻生效，而不是"下次重启"。 */
describe("★ applyLimits 立刻生效", () => {
  it("把并发调到 1 之后，本轮只派发一个会话", async () => {
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const context = setupSupervisor({
      maxConcurrentTurns: 3,
      handleBatch: () => blocked,
    })
    // 热改成 1 —— 不重建 supervisor
    context.supervisor.applyLimits({ maxConcurrentTurns: 1 })

    for (const id of ["conv-a", "conv-b"]) {
      context.supervisor.onInbound(
        admission({
          message: message({ id: `m-${id}`, conversationId: id }),
          conversation: conversation({ id }),
        }),
      )
    }
    context.clock.advance(3000)

    // 不 await：第一个会话的 handleBatch 卡住了（await 会自锁）
    const ticking = context.supervisor.tick()
    await Promise.resolve()
    release?.()
    const result = await ticking

    /**
     * ★ 判据是"第二个被排队了"，而不是 dispatched 的具体值。
     *
     * 构造时给的是 3，热改成 1 —— 如果 applyLimits 没生效，两个会话会
     * 都被派发（`skippedBusy` 为 0）。所以这条断言正是在验热改。
     */
    expect(result.skippedBusy).toBe(1)
    expect(result.dispatched).toBe(1)
    context.vault.close()
  })

  it("批次上限也能热改", async () => {
    const flood = Array.from({ length: 10 }, (_, index) => ({
      id: `hot-${index}`,
      conversationId: "conv-1",
    }))
    const context = setupSupervisor({ extraMessages: flood })
    context.supervisor.applyLimits({ maxBatchSize: 3 })
    for (const entry of flood) {
      context.supervisor.onInbound(admission({ message: message({ id: entry.id }) }))
    }
    context.clock.advance(3000)
    const batch = context.supervisor.mailbox.takeBatch("conv-1")
    expect(batch.entries).toHaveLength(3)
    expect(batch.overflow).toBe(7)
    context.vault.close()
  })
})

/**
 * ★★ 蒸馏出新画像之后，常驻会话必须重装 workspace。
 *
 * ## 拦的是一个 10 分钟的静默窗口（实测踩到过）
 *
 * `acquire()` 对已常驻的会话直接返回，**不调** `createAgent` —— 而装
 * skill 就在 `createAgent` 里。所以蒸馏完成后，正在聊的那些会话会继续
 * 用蒸馏前的 workspace，直到 idle（10 分钟）或 LRU 把它淘汰掉。
 *
 * 那 10 分钟里 agent 读的是旧画像（或者压根还没有画像时的兜底文案），
 * 而**界面上看不出任何区别**：用户刚点完「重新蒸馏」，以为已经生效了。
 *
 * 实测的形态：forge 跑出 grade A、11 个文件都在磁盘上，而 10 个 agent
 * workspace 里的 `.opencode/skills` 全是 0，回复照旧走
 * `built-in fallback guidance`。
 */
describe("★★ 画像换代后重装 workspace（蒸完就能用）", () => {
  /** 让一个会话进入常驻：投一条消息 + 过合并窗口 + tick。 */
  async function makeResident(context: ReturnType<typeof setupSupervisor>, id: string) {
    context.supervisor.onInbound(
      admission({
        message: message({ id: `m-${id}`, conversationId: id }),
        conversation: conversation({ id }),
      }),
    )
    context.clock.advance(3000)
    await context.supervisor.tick()
  }

  it("常驻会话在换代后的下一轮重新建一次 workspace", async () => {
    const context = setupSupervisor({
      extraMessages: [{ id: "m-again", conversationId: "conv-a" }],
    })
    await makeResident(context, "conv-a")
    expect(context.created).toEqual(["conv-a"])

    // 蒸馏成功 → 换代
    context.supervisor.markProfileChanged()

    // 下一条消息：会话仍然常驻，但必须重装
    context.supervisor.onInbound(
      admission({
        message: message({ id: "m-again", conversationId: "conv-a" }),
        conversation: conversation({ id: "conv-a" }),
      }),
    )
    context.clock.advance(3000)
    await context.supervisor.tick()

    // ★ 关键：createAgent 被调了第二次（那一步里才会装 skill）
    expect(context.created).toEqual(["conv-a", "conv-a"])
    context.vault.close()
  })

  it("★ 没换代时不重复建（否则每条消息都白做一次 IO）", async () => {
    const context = setupSupervisor({
      extraMessages: [{ id: "m-again", conversationId: "conv-a" }],
    })
    await makeResident(context, "conv-a")
    context.supervisor.onInbound(
      admission({
        message: message({ id: "m-again", conversationId: "conv-a" }),
        conversation: conversation({ id: "conv-a" }),
      }),
    )
    context.clock.advance(3000)
    await context.supervisor.tick()
    /**
     * 反面断言：不加这一条的话"每次都重建"也能让上面那条绿 ——
     * 而每次重建意味着每条消息都拷一遍几十 KB 的 skill 包。
     */
    expect(context.created).toEqual(["conv-a"])
    context.vault.close()
  })

  it("★ 重装**不**经过 dispose（那会打断在途的 turn）", async () => {
    const context = setupSupervisor({
      extraMessages: [{ id: "m-again", conversationId: "conv-a" }],
    })
    await makeResident(context, "conv-a")
    context.supervisor.markProfileChanged()
    context.supervisor.onInbound(
      admission({
        message: message({ id: "m-again", conversationId: "conv-a" }),
        conversation: conversation({ id: "conv-a" }),
      }),
    )
    context.clock.advance(3000)
    await context.supervisor.tick()
    /**
     * ★ 用 release 实现"换代"是最直觉的写法，但它要 `disposeAgent`
     * （撤 MCP token）—— 对一个正在生成草稿的会话做那件事会打断它。
     * `createAgent` 本身幂等，所以刷新不需要先销毁。
     */
    expect(context.disposed).toEqual([])
    context.vault.close()
  })

  it("连点两次「重新蒸馏」只会重装一次（换代是幂等的）", async () => {
    const context = setupSupervisor({
      extraMessages: [{ id: "m-again", conversationId: "conv-a" }],
    })
    await makeResident(context, "conv-a")
    context.supervisor.markProfileChanged()
    context.supervisor.markProfileChanged()
    context.supervisor.onInbound(
      admission({
        message: message({ id: "m-again", conversationId: "conv-a" }),
        conversation: conversation({ id: "conv-a" }),
      }),
    )
    context.clock.advance(3000)
    await context.supervisor.tick()
    expect(context.created).toEqual(["conv-a", "conv-a"])
    context.vault.close()
  })
})

/**
 * ★★ 「不触发」（`triggerMode: "none"`）—— 用户对某个会话说"别管它"。
 *
 * ## 它替掉的是什么
 *
 * 在它存在之前，"这个会话别管"只能靠 `replyMode: "silent"` 表达 ——
 * 而那让**范围**问题挤进了**模式**里：silent 与"不触发"都让会话不出草稿，
 * 于是有两条等价路径而用户无从判断该用哪个。现在模式只管"出草稿还是自动发"，
 * 范围由触发条件管。
 *
 * ## 三条性质，每条都对应一种会静默出错的写法
 *
 * ① 它必须**真的**拦住（不是显示成拦住）；
 * ② 它的原因要与 `trigger_not_matched` **分开** —— 前者是用户明确的意愿
 *    （不该出现在"为什么没回"的排查列表里），后者是"条件配着但这条没命中"
 *    （用户可能想调条件）。合成一个会让后者被前者的量淹掉；
 * ③ 它要排在**贵的判据之前** —— 一个明说了别管的会话不该再去查
 *    exclusion 与 mention 表。
 */
describe("★★ 触发条件「不触发」", () => {
  it("★★ 真的拦住 —— 即使是单聊、即使 @了我", () => {
    /**
     * 单聊与 @我 是两条**放行**路径（`matchesTrigger` 里单聊直接 return true）。
     * 「不触发」必须比它们都强，否则"别管这个会话"在最该生效的场景失效。
     */
    expect(
      admit(
        admission({
          config: { replyMode: "draft", triggerMode: "none", keywords: [] },
          conversation: conversation({ type: "direct" }),
          mentionsSelf: true,
        }),
      ),
    ).toEqual({ ok: false, reason: "trigger_none" })
  })

  it("★★ 原因是 trigger_none，不是 trigger_not_matched（两者语义不同）", () => {
    const verdict = admit(
      admission({
        config: { replyMode: "draft", triggerMode: "none", keywords: [] },
        mentionsSelf: false,
      }),
    )
    expect(verdict).toEqual({ ok: false, reason: "trigger_none" })
    // 反面：条件配着但没命中，仍然是 trigger_not_matched
    expect(
      admit(
        admission({
          config: { replyMode: "draft", triggerMode: "mention", keywords: [] },
          mentionsSelf: false,
        }),
      ),
    ).toEqual({ ok: false, reason: "trigger_not_matched" })
  })

  it("★★ 排在贵判据之前：已读超时的会话也报 trigger_none", () => {
    /**
     * `stale_message` 与 `already_answered` 都在 `matchesTrigger` 之前，
     * 而「不触发」要比它们**更**早 —— 否则一个"别管"的会话会被报成
     * "消息太旧了"，而那是一个会让人去查时间的错误原因。
     *
     * ★ 时间必须真的超过 `READ_REPLY_EXPIRY_MS`（4 小时）。
     * 反证时发现原来写的是 1 小时 —— 那时 `stale_message` 压根不成立，
     * 于是"把这个判断挪到最后"仍然全绿：断言在验一个不存在的竞争。
     * 这属于[断言的前提没成立]那一类，比断言写错更难发现。
     */
    expect(
      admit(
        admission({
          config: { replyMode: "draft", triggerMode: "none", keywords: [] },
          conversationRead: true,
          now: START + READ_REPLY_EXPIRY_MS + 60_000,
        }),
      ),
    ).toEqual({ ok: false, reason: "trigger_none" })
  })

  it("★★ 也排在 already_answered 之前", () => {
    expect(
      admit(
        admission({
          config: { replyMode: "draft", triggerMode: "none", keywords: [] },
          turnAnswered: true,
        }),
      ),
    ).toEqual({ ok: false, reason: "trigger_none" })
  })

  it("★★ 也排在会话级排除之前（那一条要查 store 的分类视图）", () => {
    expect(
      admit(
        admission({
          config: { replyMode: "draft", triggerMode: "none", keywords: [] },
          conversationExclusion: "bot_channel",
        }),
      ),
    ).toEqual({ ok: false, reason: "trigger_none" })
  })

  it("★ kill switch 仍然优先（急停是全局的，比逐会话设置更强）", () => {
    expect(
      admit(
        admission({
          config: { replyMode: "draft", triggerMode: "none", keywords: [] },
          killSwitchActive: true,
        }),
      ),
    ).toEqual({ ok: false, reason: "kill_switch" })
  })

  it("★ 其余三种触发条件不受影响（反证：别顺手把它们也拦了）", () => {
    for (const [mode, mentions, expected] of [
      ["all", false, true],
      ["mention", true, true],
      ["mention", false, false],
    ] as const) {
      const verdict = admit(
        admission({
          config: { replyMode: "draft", triggerMode: mode, keywords: [] },
          mentionsSelf: mentions,
        }),
      )
      expect(verdict.ok, `${mode} + mentions=${String(mentions)}`).toBe(expected)
    }
  })
})

/**
 * ★★ 「对方还在说」的静默期 —— 防止起草期间被新消息作废。
 *
 * ## 这一组来自一次真机失效
 *
 * 一串 4 条、跨 70 余秒的连发：固定窗口（3 秒）在第一条到达 3 秒后就放行，
 * 而一轮起草要 4–6 秒 —— 于是下一条消息必然在起草期间到达，刚生成的草稿
 * 立刻被标 `superseded_by_newer_message`。实测那一串产出 2 条草稿、
 * **两条都被作废**，用户侧看到的是"最新这几条压根没起草"。
 *
 * 所以合并有两个条件，都要满足：最老那条等够窗口 + 最新那条静默够久。
 */
/** 与 `setupSupervisor` 相同，但**开着**静默期（用生产默认值）。 */
function setupSupervisorQuiet(): ReturnType<typeof setupSupervisor> {
  return setupSupervisor({ quietMs: DEFAULT_QUIET_MS })
}

describe("★ 静默期（对方连发时不在中途起草）", () => {
  it("★ 对方还在连发 → 不取批次（哪怕最老那条早就等够了）", () => {
    const context = setupSupervisorQuiet()
    context.supervisor.onInbound(admission({ message: message({ id: "a" }) }))
    // 最老那条已经远超合并窗口
    context.clock.advance(10_000)
    context.supervisor.onInbound(admission({ message: message({ id: "b" }) }))
    // 但最新那条只静默了 1 秒 —— 对方还在打字
    context.clock.advance(1000)

    expect(context.supervisor.mailbox.takeBatch("conv-1").entries).toHaveLength(0)
  })

  it("★ 对方停下来之后 → 一次取走整串（这才是该合并的那一批）", () => {
    const context = setupSupervisorQuiet()
    for (const id of ["a", "b", "c"]) {
      context.supervisor.onInbound(admission({ message: message({ id }) }))
      context.clock.advance(2000) // 每 2 秒一条：固定窗口挡不住，静默期能
    }
    expect(context.supervisor.mailbox.takeBatch("conv-1").entries).toHaveLength(0)

    context.clock.advance(6100) // 说完了
    const batch = context.supervisor.mailbox.takeBatch("conv-1")
    expect(batch.entries.map((e) => e.messageId)).toEqual(["a", "b", "c"])
  })

  it("只有一条时也要等静默期（代价：首次响应变慢，换不被打断）", () => {
    const context = setupSupervisorQuiet()
    context.supervisor.onInbound(admission({ message: message({ id: "a" }) }))
    context.clock.advance(3100) // 过了固定窗口，但没过静默期
    expect(context.supervisor.mailbox.takeBatch("conv-1").entries).toHaveLength(0)
    context.clock.advance(3000)
    expect(context.supervisor.mailbox.takeBatch("conv-1").entries).toHaveLength(1)
  })

  it("quietMs: 0 关掉这个判据（退回只看固定窗口）", () => {
    const context = setupSupervisor() // 那个 helper 里 quietMs = 0
    context.supervisor.onInbound(admission({ message: message({ id: "a" }) }))
    context.clock.advance(3100)
    expect(context.supervisor.mailbox.takeBatch("conv-1").entries).toHaveLength(1)
  })
})
