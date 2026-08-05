/**
 * ★★ 用**真实信封**的 payload 跑通全链路 —— 这是本轮那个故障的回归防线。
 *
 * ## 为什么要单独一个文件，而不是改 pipeline.test.ts
 *
 * `pipeline.test.ts` 的 fixture 是从 `conversationMessagesList` **直接开始**的
 * （没有 `result` 信封），它测的是"结构对了之后链路能不能通"。那层价值仍然有效，
 * 所以不动它。
 *
 * 这个文件测的是**另一件事**：真实响应长什么样、以及那些形态能不能落库。
 * 两者的区别正是那个故障能溜过 1191 个单测的原因 ——
 * 全链路测试用的是"我以为的形状"，于是「解析器读错了字段位置」这件事
 * 在测试里根本不可能暴露。
 *
 * 每条断言都对应一个**实测过的**真实特征，见 fixtures 文件头的表格。
 */
import { describe, expect, it } from "vitest"
import { ManualClock } from "@mycontext/kernel"
import { extractMentionTexts, mentionsSelf, parseMessageListPage } from "@mycontext/channels"
import {
  ChangelogRepository,
  ConversationRepository,
  MediaAssetRepository,
  MessageRepository,
} from "@mycontext/store"
import { normalize, persistBatch } from "@mycontext/ingest"
import { REAL_LIST_ALL_PAGE, REAL_SELF_IDENTITY } from "../../fixtures/dingtalk-real-payloads.js"
import { openTestVault, type TestVault } from "../../helpers/vault.js"

const START = 1_785_300_000_000

function ingestRealPage(vault: TestVault, confirmed = true) {
  const clock = new ManualClock(START)
  // 解析器直接吃**带信封**的整个响应（重放 raw_records 时就是这个形态）
  const page = parseMessageListPage(REAL_LIST_ALL_PAGE)
  const batch = normalize({
    channelId: "dingtalk",
    conversations: page.conversations,
    messages: page.messages,
    rawPayload: JSON.stringify(REAL_LIST_ALL_PAGE),
    rawResource: "chat.message",
    selfExternalIds: new Set(REAL_SELF_IDENTITY.openIds.map((entry) => entry.value)),
    selfDisplayNames: new Set(confirmed ? REAL_SELF_IDENTITY.displayNames : []),
    selfConfirmed: confirmed,
    fetchedAt: START,
  })
  const result = persistBatch({ db: vault.db, clock }, batch)
  return { page, result }
}

describe("★★ 真实信封 payload 的全链路（信封 bug 的回归防线）", () => {
  it("带信封的响应能解析出会话与消息（首版在这里静默返回 0）", () => {
    const page = parseMessageListPage(REAL_LIST_ALL_PAGE)
    // 首版读根对象 → conversations/messages 全为 0，且不报错
    expect(page.conversations.length).toBe(3)
    expect(page.messages.length).toBe(9)
    expect(page.itemCount).toBe(9)
  })

  it("★ singleChat 决定群聊/单聊（首版全判成 direct）", () => {
    const page = parseMessageListPage(REAL_LIST_ALL_PAGE)
    const byId = new Map(page.conversations.map((c) => [c.externalId, c]))
    expect(byId.get("cid1a9eda76d755a3ba7ccf9e==")?.type).toBe("group")
    expect(byId.get("cid63a781adb2b4372785f36a==")?.type).toBe("group")
    expect(byId.get("cid6c0d4d382ddd037f260da4==")?.type).toBe("direct")
    // 真实响应不带 memberCount → 不猜，保持 null
    expect(byId.get("cid1a9eda76d755a3ba7ccf9e==")?.memberCount).toBeNull()
  })

  it("★ hasMore=false 但 nextCursor 非空（翻页终止判据）", () => {
    const page = parseMessageListPage(REAL_LIST_ALL_PAGE)
    expect(page.hasMore).toBe(false)
    // cursor 确实非空 —— 只看它会永不终止
    expect(page.nextCursor).not.toBeNull()
  })

  it("消息、会话、发送者、Outbox 都真的落库了", () => {
    const vault = openTestVault()
    try {
      const { result } = ingestRealPage(vault)
      expect(result.changed.length).toBe(9)
      expect(new MessageRepository(vault.db).count()).toBe(9)
      expect(new ConversationRepository(vault.db).count()).toBe(3)
      // Outbox 与消息一一对应 —— 蒸馏与 kl-graph 的输入就是它
      expect(result.seqs.length).toBe(9)
      expect(new ChangelogRepository(vault.db).head()).toBe(9)
    } finally {
      vault.close()
    }
  })

  it("★ 媒体从 content 抽出来并落库（首版 hasMedia 恒为 false）", () => {
    const vault = openTestVault()
    try {
      ingestRealPage(vault)
      const media = new MediaAssetRepository(vault.db)
      // 2 张图（mediaId 前缀 @ 与 $ 各一）+ 1 个文件
      expect(media.count()).toBe(3)

      // has_media 也要跟着置位（首版查 msgType，而真实响应没这字段）
      const messages = new MessageRepository(vault.db)
      for (const externalId of [
        "msgFAKE0006xxxxxxxxxxxxxx==",
        "msgFAKE0005xxxxxxxxxxxxxx==",
        "msgFileEEE55==",
      ]) {
        expect(messages.findByExternalId("dingtalk", externalId)?.hasMedia).toBe(true)
      }
    } finally {
      vault.close()
    }
  })

  it("★ 表情标记不被当成媒体（[狗子] 这类是噪声不是资源）", () => {
    const page = parseMessageListPage(REAL_LIST_ALL_PAGE)
    const emojiOnly = page.messages.find((m) => m.externalId === "msgEmojiOnlyBBB88==")
    expect(emojiOnly?.contentText).toContain("[狗子]")
    // 判据是 mediaId=/fileId:，不是"有方括号"
    expect(emojiOnly?.media).toEqual([])
    expect(emojiOnly?.hasMedia).toBe(false)
  })

  it("媒体记的是资源 ID 与取用方式，且未下载状态可区分", () => {
    const vault = openTestVault()
    try {
      ingestRealPage(vault)
      const rows = new MediaAssetRepository(vault.db).listPending(10)
      // 一期不下载字节 → 全部 pending，且 path/sha256 为空（"有资源但没下载"可表达）
      expect(rows.length).toBe(3)
      for (const row of rows) {
        expect(row.path).toBeNull()
        expect(row.sha256).toBeNull()
        expect(row.resourceId).not.toBe("")
      }
      const kinds = rows.map((row) => row.resourceKind).sort()
      expect(kinds).toEqual(["fileId", "mediaId", "mediaId"])
      // 文件名从 `[文件] <名> fileId:` 里抽出来
      expect(rows.find((row) => row.resourceKind === "fileId")?.originalName).toBe("deploy.env")
    } finally {
      vault.close()
    }
  })

  it("★ @本人被识别（首版读 atUsers，而真实响应没这个字段）", () => {
    const vault = openTestVault()
    try {
      ingestRealPage(vault)
      const messages = new MessageRepository(vault.db)
      const mentioned = messages.findByExternalId("dingtalk", "msgMentionSelfCCC77==")
      expect(mentioned).not.toBeNull()
      // @沈云舟(澄一) → 命中本人名字集合
      expect(messages.hasSelfMention(mentioned!.id)).toBe(true)
    } finally {
      vault.close()
    }
  })

  it("★ 身份未确认时不判 @我（宁可不触发也不误触发）", () => {
    const vault = openTestVault()
    try {
      ingestRealPage(vault, false)
      const messages = new MessageRepository(vault.db)
      const mentioned = messages.findByExternalId("dingtalk", "msgMentionSelfCCC77==")
      expect(messages.hasSelfMention(mentioned!.id)).toBe(false)
      // is_self 也一律留 null（未判定），不是 false
      expect(mentioned?.isSelf).toBeNull()
    } finally {
      vault.close()
    }
  })

  it("本人发的消息判成 outbound（蒸馏语料的来源）", () => {
    const vault = openTestVault()
    try {
      ingestRealPage(vault)
      const messages = new MessageRepository(vault.db)
      const own = messages.findByExternalId("dingtalk", "msgSelfSentDDD66==")
      expect(own?.isSelf).toBe(true)
      expect(own?.direction).toBe("outbound")
      // 别人发的仍是 inbound
      const other = messages.findByExternalId("dingtalk", "msgMentionSelfCCC77==")
      expect(other?.isSelf).toBe(false)
      expect(other?.direction).toBe("inbound")
    } finally {
      vault.close()
    }
  })

  it("嵌套的 @（全角括号）与引用消息不让解析崩", () => {
    const page = parseMessageListPage(REAL_LIST_ALL_PAGE)
    const nested = page.messages.find((m) => m.externalId === "msgNestedParenAAA99==")
    // `@程砚(程砚（砚之）)` → 真名与别名都抽出来
    expect(nested?.mentionTexts).toContain("程砚")
    // 引用消息只取 openMessageId
    const quoted = page.messages.find((m) => m.externalId === "msgFAKE0002xxxxxxxxxxxxxx==")
    expect(quoted?.quotedExternalId).toBe("msgQuotedAAA1122334455==")
  })

  it("合并转发存进 content_json，不展开成独立消息行", () => {
    const vault = openTestVault()
    try {
      ingestRealPage(vault)
      const messages = new MessageRepository(vault.db)
      const forwarded = messages.findByExternalId("dingtalk", "msgForwardFFF44==")
      expect(forwarded?.contentJson).not.toBeNull()
      const parsed = JSON.parse(forwarded!.contentJson!) as { forwardMessages: unknown[] }
      expect(parsed.forwardMessages).toHaveLength(2)
      // 转发里那两条**不**成为独立行（归属会变糊 + openMessageId 撞唯一键）
      expect(messages.findByExternalId("dingtalk", "msgFAKE0004xxxxxxxxxxxxxx==")).toBeNull()
      expect(messages.count()).toBe(9)
    } finally {
      vault.close()
    }
  })

  it("重复采集同一页不产生重复行、也不产生新 Outbox seq（幂等）", () => {
    const vault = openTestVault()
    try {
      ingestRealPage(vault)
      const second = ingestRealPage(vault)
      expect(second.result.changed.length).toBe(0)
      expect(second.result.unchanged).toBe(9)
      expect(new MessageRepository(vault.db).count()).toBe(9)
      // 媒体也不重复（唯一键 + DO NOTHING）
      expect(new MediaAssetRepository(vault.db).count()).toBe(3)
      // Outbox 不因重复采集而增长 —— 否则下游每轮全量重算
      expect(new ChangelogRepository(vault.db).head()).toBe(9)
    } finally {
      vault.close()
    }
  })
})

/**
 * ★ 身份确认后的回填 —— 这决定「历史消息能不能被蒸馏与触发」。
 *
 * 采集通常发生在身份确认**之前**（用户装好就开始采，确认是后来才点的按钮）。
 * 那时 `is_self` 全是 null、`selfDisplayNames` 是空集，于是：
 * · 蒸馏守卫的 `identity_unconfirmed` 拒掉全部语料；
 * · 一条「@我」都不会落 → 历史消息永远不触发数字人。
 *
 * 两者都必须能回填，否则"先采后确认"这条最常见的路径下历史数据等于废的。
 */
describe("★ 身份确认后的回填", () => {
  it("is_self 与 direction 一起回填（两个字段不能互相矛盾）", () => {
    const vault = openTestVault()
    try {
      // 未确认时采集：is_self 全 null，direction 全 inbound
      ingestRealPage(vault, false)
      const messages = new MessageRepository(vault.db)
      expect(messages.countUnjudged()).toBe(9)

      const backfilled = messages.backfillSelf("dingtalk", [REAL_SELF_IDENTITY.openIds[0]!.value])
      expect(backfilled).toBe(9)
      expect(messages.countUnjudged()).toBe(0)

      const own = messages.findByExternalId("dingtalk", "msgSelfSentDDD66==")
      expect(own?.isSelf).toBe(true)
      // ★ direction 必须跟着改 —— 只回填 is_self 会留下 is_self=1 且 inbound 的行
      expect(own?.direction).toBe("outbound")

      const other = messages.findByExternalId("dingtalk", "msgMentionSelfCCC77==")
      expect(other?.isSelf).toBe(false)
      expect(other?.direction).toBe("inbound")
    } finally {
      vault.close()
    }
  })

  it("★ 历史消息的「@我」也能回填（否则永远不触发数字人）", () => {
    const vault = openTestVault()
    try {
      ingestRealPage(vault, false)
      const messages = new MessageRepository(vault.db)
      const mentioned = messages.findByExternalId("dingtalk", "msgMentionSelfCCC77==")
      // 未确认时：一条 mention 都没有
      expect(messages.hasSelfMention(mentioned!.id)).toBe(false)

      // 模拟 confirmSelf 的回填：候选 → 抽取 → 比对本人名字
      const selfNames = new Set(REAL_SELF_IDENTITY.displayNames)
      const selfId = REAL_SELF_IDENTITY.openIds[0]!.value
      const hits = messages
        .listMentionBackfillCandidates("dingtalk", 1000)
        .filter((row) => mentionsSelf(extractMentionTexts(row.contentText), selfNames))
        .map((row) => ({ messageId: row.id, selfExternalId: selfId }))
      expect(messages.backfillSelfMentions(hits)).toBeGreaterThan(0)

      expect(messages.hasSelfMention(mentioned!.id)).toBe(true)
      // 别人被 @ 的那条不该被判成「@我」
      const nested = messages.findByExternalId("dingtalk", "msgNestedParenAAA99==")
      expect(messages.hasSelfMention(nested!.id)).toBe(false)
    } finally {
      vault.close()
    }
  })

  it("回填幂等：跑两次不产生重复 mention 行", () => {
    const vault = openTestVault()
    try {
      ingestRealPage(vault, false)
      const messages = new MessageRepository(vault.db)
      const selfNames = new Set(REAL_SELF_IDENTITY.displayNames)
      const selfId = REAL_SELF_IDENTITY.openIds[0]!.value
      const collect = () =>
        messages
          .listMentionBackfillCandidates("dingtalk", 1000)
          .filter((row) => mentionsSelf(extractMentionTexts(row.contentText), selfNames))
          .map((row) => ({ messageId: row.id, selfExternalId: selfId }))

      messages.backfillSelfMentions(collect())
      const countAfterFirst = vault.db
        .prepare("SELECT count(*) AS c FROM message_mentions")
        .get() as { c: number }
      // 第二次：候选查询已排除有本人 mention 的行 → 无事可做
      expect(collect()).toHaveLength(0)
      messages.backfillSelfMentions(collect())
      const countAfterSecond = vault.db
        .prepare("SELECT count(*) AS c FROM message_mentions")
        .get() as { c: number }
      expect(countAfterSecond.c).toBe(countAfterFirst.c)
    } finally {
      vault.close()
    }
  })
})
