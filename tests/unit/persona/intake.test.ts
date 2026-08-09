/**
 * intake（收消息 + 上下文装配）—— `TurnAssembler`。
 *
 * ## 这一组锁住三件事
 *
 * ① **改目标时看 @提及**（那是一个原实现里承认了但没修的洞）；
 * ② **"本人已回"区分分身代发** —— 混起来会静默压掉每一次跟进；
 * ③ **采集滞后未知时给 null 而不是 0** —— 不知道 ≠ 零。
 *
 * 三条都不报错，都只在真实数据上才看得见后果，所以每条都配了反面。
 */
import { describe, expect, it } from "vitest"
import { TurnAssembler } from "@mycontext/persona"
import {
  ConversationRepository,
  MessageRepository,
  PersonaConfigRepository,
} from "@mycontext/store"
import { openTestVault } from "../../helpers/vault.js"
import { ManualClock } from "@mycontext/kernel"

const NOW = Date.UTC(2026, 7, 9, 10, 0, 0)
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => logger,
} as never

function seed(opts: { kind?: "group" | "direct" } = {}) {
  const vault = openTestVault()
  new ConversationRepository(vault.db).upsert({
    id: "conv-1",
    channelId: "dingtalk",
    externalId: "cidFAKE0001==",
    type: opts.kind ?? "group",
    title: "沙箱项目群",
    memberCount: 12,
    createdAt: NOW,
  })
  return vault
}

function addMessage(
  vault: ReturnType<typeof openTestVault>,
  row: {
    id: string
    text: string
    at: number
    isSelf?: boolean
    origin?: "agent" | "human"
    sender?: string
  },
) {
  new MessageRepository(vault.db).upsertMany([
    {
      id: row.id,
      channelId: "dingtalk",
      conversationId: "conv-1",
      externalId: `ext-${row.id}`,
      senderExternalId: row.isSelf === true ? "DSELF0001" : (row.sender ?? "DFAKE0001"),
      senderDisplayName: row.isSelf === true ? "本人" : "A同学",
      contentText: row.text,
      sentAt: row.at,
      direction: row.isSelf === true ? "outbound" : "inbound",
      isSelf: row.isSelf === true,
      createdAt: row.at,
      ...(row.origin === undefined ? {} : { origin: row.origin }),
    },
  ])
}

/** 把某条消息标成「@了本人」。 */
function mention(vault: ReturnType<typeof openTestVault>, messageId: string) {
  vault.db
    .prepare(
      `INSERT INTO message_mentions (message_id, actor_external_id, is_self)
       VALUES (?, 'DSELF0001', 1)`,
    )
    .run(messageId)
}

function assembler(vault: ReturnType<typeof openTestVault>, now = NOW) {
  return new TurnAssembler({ db: vault.db, clock: new ManualClock(now), logger })
}

describe("★ 触发点过时 → 改目标，而且**看 @提及**", () => {
  /**
   * ## 这条修的是一个原实现里承认了但没修的洞
   *
   * 原注释原话：「已知缺口（review 指出，未修）：这里只筛 `is_self = 0`，
   * **不看 @提及**，而 `admit()` 在群聊的缺省 `mention` 模式下是要求被 @ 的。
   * 于是一个热闹的群里可能改到一条没 @ 本人的消息上。」
   *
   * 后果：违背用户设的触发条件（他说了"只在 @我 时管这个群"），且白烧 token。
   */
  it("★ 群聊 mention 模式：只改到**被 @** 的那条更新消息上", () => {
    const vault = seed({ kind: "group" })
    new PersonaConfigRepository(vault.db).upsert("conv-1", { triggerMode: "mention" }, NOW)
    addMessage(vault, { id: "m1", text: "@我 看下这个", at: NOW - 60_000 })
    mention(vault, "m1")
    // 之后群里又来两条 —— 但都没 @ 本人（群聊里的日常刷屏）
    addMessage(vault, { id: "m2", text: "我也觉得", at: NOW - 30_000 })
    addMessage(vault, { id: "m3", text: "哈哈", at: NOW - 10_000 })

    const turn = assembler(vault).assemble("conv-1", ["m1"])
    return turn.then((result) => {
      // 目标仍然是 m1 —— 没有被那两条无关的刷屏顶掉
      expect(result?.trigger.messageId).toBe("m1")
      vault.close()
    })
  })

  it("★ 反面：更新那条**也被 @** 了 → 改到它（这才是该改的情况）", async () => {
    const vault = seed({ kind: "group" })
    new PersonaConfigRepository(vault.db).upsert("conv-1", { triggerMode: "mention" }, NOW)
    addMessage(vault, { id: "m1", text: "@我 看下这个", at: NOW - 60_000 })
    mention(vault, "m1")
    addMessage(vault, { id: "m2", text: "哈哈", at: NOW - 30_000 })
    addMessage(vault, { id: "m3", text: "@我 还是说说吧", at: NOW - 10_000 })
    mention(vault, "m3")

    const turn = await assembler(vault).assemble("conv-1", ["m1"])
    expect(turn?.trigger.messageId).toBe("m3")
    vault.close()
  })

  it("triggerMode=all 的群：不要求被 @，改到最新那条", async () => {
    const vault = seed({ kind: "group" })
    new PersonaConfigRepository(vault.db).upsert("conv-1", { triggerMode: "all" }, NOW)
    addMessage(vault, { id: "m1", text: "看下这个", at: NOW - 60_000 })
    addMessage(vault, { id: "m2", text: "顺便还有个事", at: NOW - 10_000 })

    const turn = await assembler(vault).assemble("conv-1", ["m1"])
    expect(turn?.trigger.messageId).toBe("m2")
    vault.close()
  })

  it("单聊不受 mention 限制（钉钉单聊通常也 @不了人）", async () => {
    const vault = seed({ kind: "direct" })
    addMessage(vault, { id: "m1", text: "在吗", at: NOW - 60_000 })
    addMessage(vault, { id: "m2", text: "帮我看下这个", at: NOW - 10_000 })

    const turn = await assembler(vault).assemble("conv-1", ["m1"])
    expect(turn?.trigger.messageId).toBe("m2")
    vault.close()
  })
})

describe("★★ 「本人已回」必须区分分身代发", () => {
  /**
   * ## 为什么这一条最要紧
   *
   * 分身自己发出去的消息**也是本人 id**。把它当成"本人已经回了"会
   * **静默压掉第一次自动回复之后的每一次跟进** —— 也就是分身回了一条之后
   * 就再也不回了，而日志里一个错都没有。
   *
   * `runtime.py` 的 `recent_messages` 注释写着同一件事：
   * "a freshness check that conflates them reads the agent's own message as
   * 'the owner already answered' — which silently suppresses every follow-up."
   */
  it("★ 分身代发（origin=agent）**不算**本人已回", async () => {
    const vault = seed({ kind: "direct" })
    addMessage(vault, { id: "m1", text: "进展怎么样", at: NOW - 60_000 })
    // 分身替本人回了一条
    addMessage(vault, {
      id: "m2",
      text: "我看下",
      at: NOW - 30_000,
      isSelf: true,
      origin: "agent",
    })

    const turn = await assembler(vault).assemble("conv-1", ["m1"])
    expect(
      turn?.freshness.ownerRepliedAfter,
      "把分身自己发的当成「本人已回」会压掉每一次跟进",
    ).toBe(false)
    vault.close()
  })

  it("★ 反面：真人自己回的**算**（那时不该自动再回一条）", async () => {
    const vault = seed({ kind: "direct" })
    addMessage(vault, { id: "m1", text: "进展怎么样", at: NOW - 60_000 })
    addMessage(vault, { id: "m2", text: "我看下", at: NOW - 30_000, isSelf: true, origin: "human" })

    const turn = await assembler(vault).assemble("conv-1", ["m1"])
    expect(turn?.freshness.ownerRepliedAfter).toBe(true)
    vault.close()
  })

  it("对方又发了新消息 → newerInboundArrived", async () => {
    const vault = seed({ kind: "direct" })
    addMessage(vault, { id: "m1", text: "进展怎么样", at: NOW - 60_000 })
    addMessage(vault, { id: "m2", text: "还有个事", at: NOW - 10_000 })

    // 目标会被改到 m2，所以拿 m1 之后的事实要看改目标前的那次
    const turn = await assembler(vault).assemble("conv-1", ["m1"])
    // 改到 m2 之后，m2 之后没有更新的了
    expect(turn?.trigger.messageId).toBe("m2")
    expect(turn?.freshness.newerInboundArrived).toBe(false)
    vault.close()
  })
})

describe("★ 采集滞后：不知道 ≠ 零", () => {
  /**
   * ★★ 这是三种 stale 里唯一在数据本身看不出来的那一种。
   *
   * 库落后于平台时，"最新那行"确实是我们**有**的最新一行 —— 而更新的可能
   * 存在只是还没采回来。把"不知道"当成 0 是在最要紧的那一刻让
   * "恰好完全同步"与"完全不知道"长得一样。
   */
  it("★ 没有水位 → null（**不是** 0）", async () => {
    const vault = seed({ kind: "direct" })
    addMessage(vault, { id: "m1", text: "在吗", at: NOW - 60_000 })

    const turn = await assembler(vault).assemble("conv-1", ["m1"])
    expect(turn?.freshness.collectionLagMs, "读不出水位时给 0 等于谎报「完全同步」").toBeNull()
    vault.close()
  })

  it("有水位 → 算出真实滞后（判据与 forge 的 collection_lag 同源）", async () => {
    const vault = seed({ kind: "direct" })
    addMessage(vault, { id: "m1", text: "在吗", at: NOW - 60_000 })
    vault.db
      .prepare("INSERT INTO sync_cursors (scope, watermark, updated_at) VALUES (?, ?, ?)")
      .run("dingtalk:chat:l2", NOW - 5_000, NOW)

    const turn = await assembler(vault).assemble("conv-1", ["m1"])
    expect(turn?.freshness.collectionLagMs).toBe(5_000)
    vault.close()
  })

  it("watermark 为 0 当成没有（那是 DDL 的缺省值，不是「刚好同步」）", async () => {
    const vault = seed({ kind: "direct" })
    addMessage(vault, { id: "m1", text: "在吗", at: NOW - 60_000 })
    vault.db
      .prepare("INSERT INTO sync_cursors (scope, watermark, updated_at) VALUES (?, 0, ?)")
      .run("dingtalk:chat:l2", NOW)

    const turn = await assembler(vault).assemble("conv-1", ["m1"])
    expect(turn?.freshness.collectionLagMs).toBeNull()
    vault.close()
  })
})

describe("★ 上下文与 @提及只查一次", () => {
  it("mentionsSelf 从 message_mentions 读，下游共用这个值", async () => {
    const vault = seed({ kind: "group" })
    new PersonaConfigRepository(vault.db).upsert("conv-1", { triggerMode: "all" }, NOW)
    addMessage(vault, { id: "m1", text: "@我 看下", at: NOW - 10_000 })
    mention(vault, "m1")

    const turn = await assembler(vault).assemble("conv-1", ["m1"])
    expect(turn?.mentionsSelf).toBe(true)
    vault.close()
  })

  it("上下文条数由 IntakePolicy 决定（不是各处硬编码）", async () => {
    const vault = seed({ kind: "direct" })
    for (let i = 0; i < 10; i += 1) {
      addMessage(vault, { id: `m${String(i)}`, text: `第 ${String(i)} 条`, at: NOW - 10_000 + i })
    }
    const custom = new TurnAssembler({
      db: vault.db,
      clock: new ManualClock(NOW),
      logger,
      policy: { contextMessages: 3 },
    })
    const turn = await custom.assemble("conv-1", ["m9"])
    expect(turn?.context).toHaveLength(3)
    expect(custom.effectivePolicy.contextMessages).toBe(3)
    vault.close()
  })

  it("单聊解析对端 openDingTalkId（不拿会话 cid 顶替）", async () => {
    const vault = seed({ kind: "direct" })
    addMessage(vault, { id: "m1", text: "在吗", at: NOW - 10_000 })

    const turn = await assembler(vault).assemble("conv-1", ["m1"])
    // ★ 是对端的 id，不是 conversations.external_id（那是 cidFAKE0001==）
    expect(turn?.peerOpenId).toBe("DFAKE0001")
    expect(turn?.peerOpenId).not.toBe("cidFAKE0001==")
    vault.close()
  })

  it("群聊 peerOpenId 为 null（群里没有「对端」这个概念）", async () => {
    const vault = seed({ kind: "group" })
    new PersonaConfigRepository(vault.db).upsert("conv-1", { triggerMode: "all" }, NOW)
    addMessage(vault, { id: "m1", text: "看下", at: NOW - 10_000 })

    const turn = await assembler(vault).assemble("conv-1", ["m1"])
    expect(turn?.peerOpenId).toBeNull()
    vault.close()
  })

  it("会话行不存在 → null（不装配一个指向不存在会话的轮次）", async () => {
    const vault = seed({ kind: "direct" })
    const turn = await assembler(vault).assemble("no-such-conversation", ["m1"])
    expect(turn).toBeNull()
    vault.close()
  })
})
