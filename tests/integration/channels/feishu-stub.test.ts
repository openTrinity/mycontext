/**
 * 渠道无关性契约测试。
 *
 * 需求要求「每个 IM 实现的方案可以完全不一样」+ 扩展性好。
 * 这条测试把它变成可验证的断言：用一个**桩渠道**跑完整条
 * 采集 → 规范化 → 同事务入库 → Outbox 链路，断言
 * ① 三张基础表在两个渠道下**结构零差异**；
 * ② `channel_id` 隔离生效（不会互相污染）。
 *
 * 桩渠道刻意用**不同的时间格式与不同的 ID 形态**（unix 秒 + 三套 ID），
 * 因为「换渠道时哪些假设会破」才是这条测试真正要覆盖的东西 ——
 * 如果桩只是钉钉的复制品，它什么都证明不了。
 *
 * 一期只交付这个桩，不接真实飞书 API（需求本身把飞书放在一期之外）。
 */
import { describe, expect, it } from "vitest"
import { ManualClock } from "@mycontext/kernel"
import { normalize, persistBatch } from "@mycontext/ingest"
import { normalizeUnix, parseLocalTime } from "@mycontext/channels"
// ★ 用渠道**无关**的 `*Like` 契约，不是钉钉的 ParsedConversation/ParsedMessage。
// 这个文件测的就是"规范化层看不出数据来自哪个渠道"——
// 用钉钉的具体类型来标注一个飞书桩，等于把被测的那个性质悄悄改成了
// "飞书必须长得跟钉钉一样"（比如被迫填一个飞书不该有的 mentionTexts）。
import type {
  ParsedConversationLike as ParsedConversation,
  ParsedMessageLike as ParsedMessage,
} from "@mycontext/channels"
import { ChangelogRepository, ConversationRepository, MessageRepository } from "@mycontext/store"
import { openTestVault, type TestVault } from "../../helpers/vault.js"

const START = 1_785_000_000_000

/**
 * 桩渠道的原生响应形态：**故意与钉钉不同**。
 * · 时间是 unix **秒**（不是本地时间串）
 * · 会话类型是明确的字段（不用成员数推断）
 * · 一人有三套 ID，消息里用的是 open_id
 */
const STUB_RESPONSE = {
  items: [
    {
      chat_id: "oc_stub_group",
      name: "跨渠道测试群",
      chat_mode: "group",
      member_count: 8,
      items: [
        {
          message_id: "om_1",
          body: "预发环境部署完成了",
          create_time: 1_785_207_229,
          sender: { id: "ou_self", name: "小周", union_id: "on_self", user_id: "uu_self" },
        },
        {
          message_id: "om_2",
          body: "收到",
          create_time: 1_785_207_289,
          sender: { id: "ou_other", name: "小李", union_id: "on_other", user_id: "uu_other" },
          parent_id: "om_1",
        },
      ],
    },
  ],
}

/**
 * 桩渠道的解析器。
 *
 * 它产出的是**与钉钉解析器完全相同的中间形态**（ParsedConversationLike /
 * ParsedMessageLike）—— 这正是渠道无关性的落点：
 * 差异被吸收在插件里，规范化层往下看不出来自哪个渠道。
 */
function parseStubPage(payload: typeof STUB_RESPONSE): {
  conversations: ParsedConversation[]
  messages: ParsedMessage[]
} {
  const conversations: ParsedConversation[] = []
  const messages: ParsedMessage[] = []

  for (const chat of payload.items) {
    conversations.push({
      externalId: chat.chat_id,
      title: chat.name,
      // 明确字段，不靠成员数推断
      type: chat.chat_mode === "group" ? "group" : "direct",
      memberCount: chat.member_count,
    })
    for (const item of chat.items) {
      messages.push({
        externalId: item.message_id,
        conversationExternalId: chat.chat_id,
        // 主 ID 取 open_id（该渠道的约定）
        senderExternalId: item.sender.id,
        senderDisplayName: item.sender.name,
        contentText: item.body,
        contentJson: null,
        quotedExternalId: item.parent_id ?? null,
        // unix 秒 → ms，走同一个归一函数
        sentAt: normalizeUnix(item.create_time),
        mentions: [],
        hasMedia: false,
      })
    }
  }
  return { conversations, messages }
}

/** 钉钉侧的等价数据（同样的两条消息，但原生形态不同）。 */
const DINGTALK_PARSED = {
  conversations: [
    {
      externalId: "cid_group",
      title: "钉钉测试群",
      type: "group" as const,
      memberCount: 8,
    },
  ],
  messages: [
    {
      externalId: "msg_1",
      conversationExternalId: "cid_group",
      senderExternalId: "DeMINE",
      senderDisplayName: "小周",
      contentText: "预发环境部署完成了",
      contentJson: null,
      quotedExternalId: null,
      sentAt: parseLocalTime("2026-07-28 10:53:49", { offsetMinutes: 480 }),
      mentions: [],
      hasMedia: false,
    },
  ],
}

function ingest(
  vault: TestVault,
  clock: ManualClock,
  channelId: string,
  parsed: { conversations: ParsedConversation[]; messages: ParsedMessage[] },
  selfIds: string[],
) {
  return persistBatch(
    { db: vault.db, clock },
    normalize({
      channelId,
      conversations: parsed.conversations,
      messages: parsed.messages,
      rawPayload: JSON.stringify(parsed),
      rawResource: "chat.message",
      selfExternalIds: new Set(selfIds),
      selfConfirmed: true,
      fetchedAt: clock.now(),
    }),
  )
}

describe("桩渠道跑完整链路", () => {
  it("不同的原生形态（unix 秒 + 三套 ID）也能落库", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    const result = ingest(vault, clock, "feishu-stub", parseStubPage(STUB_RESPONSE), ["ou_self"])

    expect(result.changed.length).toBe(2)
    expect(new MessageRepository(vault.db).count()).toBe(2)
    // unix 秒被归一成 ms
    const message = new MessageRepository(vault.db).findByExternalId("feishu-stub", "om_1")
    expect(message?.sentAt).toBe(1_785_207_229_000)
    vault.close()
  })

  it("本人判定仍只用主 ID（不看显示名，与渠道无关）", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    ingest(vault, clock, "feishu-stub", parseStubPage(STUB_RESPONSE), ["ou_self"])
    const messages = new MessageRepository(vault.db)
    expect(messages.findByExternalId("feishu-stub", "om_1")?.isSelf).toBe(true)
    expect(messages.findByExternalId("feishu-stub", "om_2")?.isSelf).toBe(false)
    vault.close()
  })

  it("引用关系（该渠道叫 parent_id）映射到同一个字段", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    ingest(vault, clock, "feishu-stub", parseStubPage(STUB_RESPONSE), ["ou_self"])
    expect(
      new MessageRepository(vault.db).findByExternalId("feishu-stub", "om_2")?.quotedExternalId,
    ).toBe("om_1")
    vault.close()
  })
})

describe("★ 两个渠道的表结构零差异", () => {
  it("同一张 messages 表容纳两个渠道，列语义一致", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    ingest(vault, clock, "feishu-stub", parseStubPage(STUB_RESPONSE), ["ou_self"])
    ingest(vault, clock, "dingtalk", DINGTALK_PARSED, ["DeMINE"])

    const messages = new MessageRepository(vault.db)
    const stub = messages.findByExternalId("feishu-stub", "om_1")
    const dingtalk = messages.findByExternalId("dingtalk", "msg_1")

    expect(stub).not.toBeNull()
    expect(dingtalk).not.toBeNull()
    // 两边的字段集合完全相同：飞书接入不需要改表结构
    expect(Object.keys(stub ?? {}).sort()).toEqual(Object.keys(dingtalk ?? {}).sort())
    // 且都用同一套语义：本人 = true，内容一致
    expect(stub?.isSelf).toBe(true)
    expect(dingtalk?.isSelf).toBe(true)
    expect(stub?.contentText).toBe(dingtalk?.contentText)
    vault.close()
  })

  it("Outbox 条目也只是 channel_id 不同", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    ingest(vault, clock, "feishu-stub", parseStubPage(STUB_RESPONSE), ["ou_self"])
    ingest(vault, clock, "dingtalk", DINGTALK_PARSED, ["DeMINE"])

    const changes = new ChangelogRepository(vault.db).changesSince(0, 100)
    expect(new Set(changes.map((row) => row.channelId))).toEqual(
      new Set(["feishu-stub", "dingtalk"]),
    )
    // domain / entityType 与渠道无关
    expect(new Set(changes.map((row) => row.domain))).toEqual(new Set(["chat"]))
    expect(new Set(changes.map((row) => row.entityType))).toEqual(new Set(["message"]))
    vault.close()
  })
})

describe("★ channel_id 隔离", () => {
  it("同一个外部 id 在两个渠道下互不冲突", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    // 两个渠道用**相同的** external_id —— 唯一键是 (channel_id, external_id)
    const shared = {
      conversations: [
        { externalId: "same-id", title: "群", type: "group" as const, memberCount: 3 },
      ],
      messages: [
        {
          externalId: "same-msg",
          conversationExternalId: "same-id",
          senderExternalId: "sender",
          senderDisplayName: "某人",
          contentText: "内容",
          contentJson: null,
          quotedExternalId: null,
          sentAt: START,
          mentions: [],
          hasMedia: false,
        },
      ],
    }
    ingest(vault, clock, "feishu-stub", shared, [])
    ingest(vault, clock, "dingtalk", shared, [])

    // 两行而不是一行：渠道隔离生效
    expect(new MessageRepository(vault.db).count()).toBe(2)
    expect(new ConversationRepository(vault.db).count()).toBe(2)
    vault.close()
  })

  it("一个渠道的会话查询不会返回另一个渠道的行", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    ingest(vault, clock, "feishu-stub", parseStubPage(STUB_RESPONSE), ["ou_self"])
    ingest(vault, clock, "dingtalk", DINGTALK_PARSED, ["DeMINE"])

    const conversations = new ConversationRepository(vault.db)
    expect(conversations.findByExternalId("dingtalk", "oc_stub_group")).toBeNull()
    expect(conversations.findByExternalId("feishu-stub", "cid_group")).toBeNull()
    vault.close()
  })

  it("本人回填只影响指定渠道", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    // 两个渠道都先按未确认入库
    for (const [channelId, parsed] of [
      ["feishu-stub", parseStubPage(STUB_RESPONSE)],
      ["dingtalk", DINGTALK_PARSED],
    ] as const) {
      persistBatch(
        { db: vault.db, clock },
        normalize({
          channelId,
          conversations: parsed.conversations,
          messages: parsed.messages,
          rawPayload: JSON.stringify(parsed),
          rawResource: "chat.message",
          selfExternalIds: new Set<string>(),
          selfConfirmed: false,
          fetchedAt: clock.now(),
        }),
      )
    }

    const messages = new MessageRepository(vault.db)
    messages.backfillSelf("feishu-stub", ["ou_self"])
    expect(messages.findByExternalId("feishu-stub", "om_1")?.isSelf).toBe(true)
    // 钉钉那边仍是未判定 —— 回填按渠道隔离
    expect(messages.findByExternalId("dingtalk", "msg_1")?.isSelf).toBeNull()
    vault.close()
  })
})
