/**
 * 数据面全链路：解析 → 规范化 → 同事务入库 → Outbox → 建索引 → 搜得到。
 *
 * 这是 B 阶段的验收测试：单独测每一层都通过、拼起来搜不到，是完全可能的
 * （比如规范化产出的 conversationId 是外部 id 而入库层忘了替换）。
 *
 * 也顺带覆盖「新消息到入库后能被搜到」这条 SLA 的**功能**部分
 * （延迟部分靠进程内信号，不在这层测）。
 */
import { describe, expect, it } from "vitest"
import { ManualClock } from "@mycontext/kernel"
import { parseMessageListPage } from "@mycontext/channels"
import {
  ChangelogRepository,
  ConsumerCursorRepository,
  ConversationRepository,
  FtsIndexRepository,
  MessageRepository,
} from "@mycontext/store"
import {
  createFtsHandler,
  FTS_CONSUMER_ID,
  normalize,
  OutboxConsumer,
  persistBatch,
} from "@mycontext/ingest"
import { toMatchExpr, toQueryTokens } from "@mycontext/retrieval"
import { openTestVault, type TestVault } from "../../helpers/vault.js"

const START = 1_785_000_000_000

/** 实测形态的响应：按会话嵌套。 */
const RAW_RESPONSE = {
  conversationMessagesList: [
    {
      openConversationId: "cid-group",
      conversationTitle: "沙箱项目群",
      conversationType: "2",
      memberCount: 12,
      messages: [
        {
          openMessageId: "m1",
          content: "沙箱环境部署完成了",
          createTime: "2026-07-28 10:53:49",
          sender: "小周",
          senderOpenDingTalkId: "DeMINE",
        },
        {
          openMessageId: "m2",
          content: "收到，我看一下会议室助手",
          createTime: "2026-07-28 10:55:02",
          sender: "小李",
          senderOpenDingTalkId: "DeLI",
          atUsers: [{ openDingTalkId: "DeMINE" }],
        },
      ],
    },
    {
      openConversationId: "cid-alert",
      conversationTitle: "线上告警机器人",
      conversationType: "2",
      memberCount: 30,
      messages: [
        {
          openMessageId: "m3",
          content: "CPU 使用率超过阈值",
          createTime: "2026-07-28 11:00:00",
          sender: "告警",
          senderOpenDingTalkId: "DeBOT",
        },
      ],
    },
  ],
}

function ingestOnce(
  vault: TestVault,
  clock: ManualClock,
  payload: unknown,
  options: { selfConfirmed?: boolean } = {},
) {
  const page = parseMessageListPage(payload)
  const batch = normalize({
    channelId: "dingtalk",
    conversations: page.conversations,
    messages: page.messages,
    rawPayload: JSON.stringify(payload),
    rawResource: "chat.message",
    selfExternalIds: new Set(["DeMINE"]),
    selfConfirmed: options.selfConfirmed ?? true,
    fetchedAt: clock.now(),
  })
  return persistBatch({ db: vault.db, clock }, batch)
}

describe("采集 → 入库", () => {
  it("嵌套响应的两个会话与三条消息全部落库", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    const result = ingestOnce(vault, clock, RAW_RESPONSE)

    expect(result.changed.length).toBe(3)
    expect(new ConversationRepository(vault.db).count()).toBe(2)
    expect(new MessageRepository(vault.db).count()).toBe(3)
    vault.close()
  })

  it("消息的 conversation_id 是**内部 id**（不是外部 id 直接塞进去）", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    ingestOnce(vault, clock, RAW_RESPONSE)

    const conversations = new ConversationRepository(vault.db)
    const stored = conversations.findByExternalId("dingtalk", "cid-group")
    expect(stored).not.toBeNull()

    const messages = new MessageRepository(vault.db)
    const message = messages.findByExternalId("dingtalk", "m1")
    expect(message?.conversationId).toBe(stored?.id)
    // 外键成立 → 能反查回会话
    expect(conversations.findById(message?.conversationId ?? "")).not.toBeNull()
    vault.close()
  })

  it("Outbox 与规范表条数一致（同事务写入）", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    const result = ingestOnce(vault, clock, RAW_RESPONSE)
    expect(new ChangelogRepository(vault.db).count()).toBe(result.changed.length)
    vault.close()
  })

  it("重放同一页：消息不增、Outbox 不增（重叠窗口是常态）", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    ingestOnce(vault, clock, RAW_RESPONSE)

    clock.advance(60_000)
    const second = ingestOnce(vault, clock, RAW_RESPONSE)

    expect(second.changed.length).toBe(0)
    expect(second.unchanged).toBe(3)
    expect(new MessageRepository(vault.db).count()).toBe(3)
    // ★ 关键：不产生无意义的 seq，否则下游每轮都照单全收地重算
    expect(new ChangelogRepository(vault.db).count()).toBe(3)
    vault.close()
  })

  it("本人消息标 is_self + outbound；他人 inbound", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    ingestOnce(vault, clock, RAW_RESPONSE)

    const messages = new MessageRepository(vault.db)
    expect(messages.findByExternalId("dingtalk", "m1")?.isSelf).toBe(true)
    expect(messages.findByExternalId("dingtalk", "m1")?.direction).toBe("outbound")
    expect(messages.findByExternalId("dingtalk", "m2")?.isSelf).toBe(false)
    expect(messages.findByExternalId("dingtalk", "m2")?.direction).toBe("inbound")
    vault.close()
  })

  it("身份未确认时 is_self 一律 null（不猜，猜错会永久丢语料）", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    ingestOnce(vault, clock, RAW_RESPONSE, { selfConfirmed: false })

    const messages = new MessageRepository(vault.db)
    expect(messages.findByExternalId("dingtalk", "m1")?.isSelf).toBeNull()
    expect(messages.countUnjudged()).toBe(3)

    // 确认后回填
    expect(messages.backfillSelf("dingtalk", ["DeMINE"])).toBe(3)
    expect(messages.findByExternalId("dingtalk", "m1")?.isSelf).toBe(true)
    expect(messages.findByExternalId("dingtalk", "m2")?.isSelf).toBe(false)
    vault.close()
  })

  it("@我 被记录（数字人的触发条件）", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    ingestOnce(vault, clock, RAW_RESPONSE)
    const messages = new MessageRepository(vault.db)
    const m2 = messages.findByExternalId("dingtalk", "m2")
    expect(m2).not.toBeNull()
    expect(messages.hasSelfMention(m2?.id ?? "")).toBe(true)
    vault.close()
  })

  it("告警群被识别为机器人渠道（默认排除蒸馏）", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    ingestOnce(vault, clock, RAW_RESPONSE)
    const conversations = new ConversationRepository(vault.db)
    expect(conversations.findByExternalId("dingtalk", "cid-alert")?.isBotChannel).toBe(true)
    expect(conversations.findByExternalId("dingtalk", "cid-group")?.isBotChannel).toBe(false)
    vault.close()
  })

  it("会话的 last_message_at 取本批最大时间", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    ingestOnce(vault, clock, RAW_RESPONSE)
    const conversation = new ConversationRepository(vault.db).findByExternalId(
      "dingtalk",
      "cid-group",
    )
    expect(conversation?.lastMessageAt).toBe(Date.parse("2026-07-28T02:55:02.000Z"))
    vault.close()
  })
})

describe("Outbox → FTS 消费者 → 搜得到", () => {
  async function runFtsConsumer(vault: TestVault, clock: ManualClock) {
    const consumer = new OutboxConsumer({
      db: vault.db,
      clock,
      consumerId: FTS_CONSUMER_ID,
      owner: "test-worker",
      handler: createFtsHandler(vault.db, clock),
    })
    consumer.register()
    return consumer.runOnce()
  }

  it("入库的消息经消费者建好索引，四条中文查询命中", async () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    ingestOnce(vault, clock, RAW_RESPONSE)
    const report = await runFtsConsumer(vault, clock)
    expect(report.processed).toBe(3)

    const fts = new FtsIndexRepository(vault.db)
    for (const query of ["沙箱", "部署", "环境", "沙箱环境"]) {
      const hits = fts.search(toMatchExpr(toQueryTokens(query)))
      expect(hits.length, `查询「${query}」应命中`).toBeGreaterThan(0)
    }
    vault.close()
  })

  it("消费者游标推进到 Outbox 水位（lag 归零）", async () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    ingestOnce(vault, clock, RAW_RESPONSE)
    const consumer = new OutboxConsumer({
      db: vault.db,
      clock,
      consumerId: FTS_CONSUMER_ID,
      owner: "w1",
      handler: createFtsHandler(vault.db, clock),
    })
    consumer.register()
    await consumer.runOnce()
    expect(consumer.lag()).toBe(0)
    vault.close()
  })

  it("第二轮消费无新条目时不重复建索引", async () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    ingestOnce(vault, clock, RAW_RESPONSE)
    const consumer = new OutboxConsumer({
      db: vault.db,
      clock,
      consumerId: FTS_CONSUMER_ID,
      owner: "w1",
      handler: createFtsHandler(vault.db, clock),
    })
    consumer.register()
    await consumer.runOnce()
    const second = await consumer.runOnce()
    expect(second.processed).toBe(0)
    expect(new FtsIndexRepository(vault.db).count()).toBe(3)
    vault.close()
  })

  it("消息被编辑后重新入库 → 索引更新，旧内容搜不到", async () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    ingestOnce(vault, clock, RAW_RESPONSE)
    await runFtsConsumer(vault, clock)

    // 同一条消息内容被改（撤回重发/编辑）
    clock.advance(60_000)
    const edited = structuredClone(RAW_RESPONSE) as typeof RAW_RESPONSE
    const first = edited.conversationMessagesList[0]
    if (first?.messages[0] !== undefined) first.messages[0].content = "预发环境回滚了"
    ingestOnce(vault, clock, edited)
    await runFtsConsumer(vault, clock)

    const fts = new FtsIndexRepository(vault.db)
    // 「沙箱」只在被改掉的那条里出现过 → 现在搜不到
    expect(fts.search(toMatchExpr(toQueryTokens("沙箱")))).toEqual([])
    expect(fts.search(toMatchExpr(toQueryTokens("回滚"))).length).toBe(1)
    vault.close()
  })

  it("已删除的消息（隐私删除）不让消费者报错，只跳过", async () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    ingestOnce(vault, clock, RAW_RESPONSE)
    // 模拟用户删除了消息，但 Outbox 条目还在
    vault.db.prepare("DELETE FROM messages").run()

    const report = await runFtsConsumer(vault, clock)
    expect(report.processed).toBe(0)
    expect(report.skipped).toBe(3)
    // 游标仍然推进：跳过不是错误，卡住才是问题
    expect(report.ackedSeq).toBe(3)
    vault.close()
  })

  it("租约：同一消费者被别的 owner 占用时本轮跳过（不是报错）", async () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    ingestOnce(vault, clock, RAW_RESPONSE)

    const consumers = new ConsumerCursorRepository(vault.db, clock)
    consumers.register(FTS_CONSUMER_ID)
    consumers.acquireLease(FTS_CONSUMER_ID, "other-worker")

    const consumer = new OutboxConsumer({
      db: vault.db,
      clock,
      consumerId: FTS_CONSUMER_ID,
      owner: "me",
      handler: createFtsHandler(vault.db, clock),
    })
    consumer.register()
    const report = await consumer.runOnce()
    expect(report.lockedByOther).toBe(true)
    expect(report.processed).toBe(0)
    vault.close()
  })

  it("整批 handler 抛错时不推进游标（下次重放，所以处理必须幂等）", async () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    ingestOnce(vault, clock, RAW_RESPONSE)

    const consumer = new OutboxConsumer({
      db: vault.db,
      clock,
      consumerId: FTS_CONSUMER_ID,
      owner: "me",
      handler: () => {
        throw new Error("handler exploded")
      },
    })
    consumer.register()
    const report = await consumer.runOnce()
    expect(report.ackedSeq).toBe(0)
    expect(new ConsumerCursorRepository(vault.db, clock).get(FTS_CONSUMER_ID)?.lastError).toContain(
      "handler exploded",
    )
    vault.close()
  })
})
