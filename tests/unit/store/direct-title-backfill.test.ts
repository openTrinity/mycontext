/**
 * 单聊会话名的**本地回填**：渠道给不出名字，但库里其实有。
 *
 * ## 这一组锁的是"信息就在手边却没人用"
 *
 * 飞书的单聊在消息搜索响应里没有会话名（`chat_partner` 只有 open_id，
 * `chat_name` 在 p2p 上不存在），而每条消息的 `sender_display_name`
 * **是有真名的**。实测本机飞书库 4 个单聊全无名字、而它们的 8 条消息
 * 每条都有发送者名 —— 界面上只能显示 id 尾段（`#2c78b681`），
 * 用户在采集范围里根本没法选。
 *
 * 判据是"单聊里 `is_self = 0` 的那个人"。这里的每条断言都对应一个
 * 如果判据写错就会发生的真实后果。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  ConversationRepository,
  openStore,
  VAULT_MIGRATIONS,
  type StoreHandle,
} from "@mycontext/store"

let dir: string
let store: StoreHandle
let repository: ConversationRepository

const CHANNEL = "feishu"

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mycontext-titles-"))
  store = openStore({ path: join(dir, "vault.sqlite"), migrations: VAULT_MIGRATIONS })
  repository = new ConversationRepository(store.db)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

function conversation(id: string, type: "direct" | "group", title: string | null): void {
  store.db
    .prepare(
      `INSERT INTO conversations
         (id, channel_id, external_id, type, title, member_count,
          is_self_involved, is_bot_channel, last_message_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, 1, 0, NULL, 0)`,
    )
    .run(id, CHANNEL, `ext-${id}`, type, title)
}

/** 插一条消息。`isSelf` 为 null = 还没 confirm（`is_self` 未回填）。 */
function message(opts: {
  id: string
  conversationId: string
  senderName: string | null
  isSelf: number | null
  sentAt: number
}): void {
  store.db
    .prepare(
      `INSERT INTO messages
         (id, channel_id, conversation_id, external_id, sender_external_id,
          sender_display_name, content_text, sent_at, is_self, direction, created_at)
       VALUES (?, ?, ?, ?, 'sender-x', ?, 'hi', ?, ?, 'inbound', 0)`,
    )
    .run(
      opts.id,
      CHANNEL,
      opts.conversationId,
      `ext-${opts.id}`,
      opts.senderName,
      opts.sentAt,
      opts.isSelf,
    )
}

function titleOf(id: string): string | null {
  return (
    store.db
      .prepare<[string], { title: string | null }>("SELECT title FROM conversations WHERE id = ?")
      .get(id)?.title ?? null
  )
}

describe("★★ 单聊会话名从已入库的消息里补", () => {
  it("★★ 用「不是我」那条消息的发送者名当会话名", () => {
    conversation("c1", "direct", null)
    message({ id: "m1", conversationId: "c1", senderName: "张三", isSelf: 0, sentAt: 100 })

    expect(repository.backfillDirectTitlesFromSenders(CHANNEL)).toBe(1)
    expect(titleOf("c1")).toBe("张三")
  })

  /**
   * ★★★ 不能把**我自己的**名字当会话名。
   *
   * 只有我发过消息的单聊（我发出去对方没回）里，唯一的发送者是我 ——
   * 那时必须保持 NULL。把我的名字显示成会话名比显示 id 更糟：
   * 用户会以为那是个"跟自己的对话"。
   */
  it("★★★ 只有我发过消息 → 保持 NULL（不能显示成我自己）", () => {
    conversation("c2", "direct", null)
    message({ id: "m2", conversationId: "c2", senderName: "我自己", isSelf: 1, sentAt: 100 })

    expect(repository.backfillDirectTitlesFromSenders(CHANNEL)).toBe(0)
    expect(titleOf("c2")).toBeNull()
  })

  /**
   * ★★ `is_self` 还是 NULL（**没 confirm 过**）时什么都不做。
   *
   * 那时我们还不知道"我是谁"，任何一个发送者都可能是我。宁可继续显示 id，
   * 也不要把某个名字当成对端 —— 这也解释了为什么这个方法必须在
   * `confirmSelf` **之后**调。
   */
  it("★★ 没 confirm（is_self 全 NULL）→ 一行都不改", () => {
    conversation("c3", "direct", null)
    message({ id: "m3", conversationId: "c3", senderName: "某人", isSelf: null, sentAt: 100 })

    expect(repository.backfillDirectTitlesFromSenders(CHANNEL)).toBe(0)
    expect(titleOf("c3")).toBeNull()
  })

  /** ★ 渠道给的名字优先 —— 不覆盖已有 title（也让这个方法幂等）。 */
  it("★ 已有名字不被覆盖", () => {
    conversation("c4", "direct", "渠道给的名字")
    message({ id: "m4", conversationId: "c4", senderName: "张三", isSelf: 0, sentAt: 100 })

    expect(repository.backfillDirectTitlesFromSenders(CHANNEL)).toBe(0)
    expect(titleOf("c4")).toBe("渠道给的名字")
  })

  /**
   * ★★ 只补单聊。
   *
   * 群聊里"不是我"的发送者有很多个，取其中一个当群名是纯粹的错答 ——
   * 而群名本来就有（`chat_name`），拿不到时该保持空。
   */
  it("★★ 群聊不动（取一个成员名当群名是错答）", () => {
    conversation("c5", "group", null)
    message({ id: "m5", conversationId: "c5", senderName: "李四", isSelf: 0, sentAt: 100 })

    expect(repository.backfillDirectTitlesFromSenders(CHANNEL)).toBe(0)
    expect(titleOf("c5")).toBeNull()
  })

  /** ★ 同一个对端多条消息 → 取**最近**那条（显示名会改）。 */
  it("★ 取最近一条的显示名", () => {
    conversation("c6", "direct", null)
    message({ id: "m6a", conversationId: "c6", senderName: "旧名字", isSelf: 0, sentAt: 100 })
    message({ id: "m6b", conversationId: "c6", senderName: "新名字", isSelf: 0, sentAt: 200 })

    repository.backfillDirectTitlesFromSenders(CHANNEL)
    expect(titleOf("c6")).toBe("新名字")
  })

  it("发送者名为空的不算（不能把 title 写成空串）", () => {
    conversation("c7", "direct", null)
    message({ id: "m7", conversationId: "c7", senderName: "", isSelf: 0, sentAt: 100 })

    expect(repository.backfillDirectTitlesFromSenders(CHANNEL)).toBe(0)
    expect(titleOf("c7")).toBeNull()
  })

  /** ★ 按渠道隔离：补飞书不该动到另一个渠道的行。 */
  it("★ 只补指定渠道", () => {
    conversation("c8", "direct", null)
    message({ id: "m8", conversationId: "c8", senderName: "张三", isSelf: 0, sentAt: 100 })

    expect(repository.backfillDirectTitlesFromSenders("dingtalk")).toBe(0)
    expect(titleOf("c8")).toBeNull()
  })

  it("跑两遍结果一样（幂等）", () => {
    conversation("c9", "direct", null)
    message({ id: "m9", conversationId: "c9", senderName: "张三", isSelf: 0, sentAt: 100 })

    repository.backfillDirectTitlesFromSenders(CHANNEL)
    expect(repository.backfillDirectTitlesFromSenders(CHANNEL)).toBe(0)
    expect(titleOf("c9")).toBe("张三")
  })
})
