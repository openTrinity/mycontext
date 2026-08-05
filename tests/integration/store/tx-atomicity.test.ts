/**
 * 事务原子性。
 *
 * 「规范表与 Outbox 同事务写入」是整条增量链路的地基：
 * 破了它之后消费者会读到 seq 却查不到实体（先写 Outbox 后崩溃），
 * 或永久漏掉变更（先写规范表后崩溃）。两者都表现为
 * 「数据看起来采到了，实际缺一段」，而且没有任何东西会报错。
 *
 * 因此这里注入一个在 Outbox 写入时抛错的桩，断言消息**也**回滚了 ——
 * 不能出现「有实体无变更」。
 */
import { describe, expect, it } from "vitest"
import {
  ChangelogRepository,
  ConversationRepository,
  MessageRepository,
  withTransaction,
} from "@mycontext/store"
import { openTestVault } from "../../helpers/vault.js"

const NOW = 1_700_000_000_000

function message(id: string) {
  return {
    id,
    channelId: "dingtalk",
    conversationId: "conv-1",
    externalId: `ext-${id}`,
    senderExternalId: "sender-a",
    contentText: "内容",
    sentAt: NOW,
    direction: "inbound" as const,
    createdAt: NOW,
  }
}

describe("规范表与 Outbox 同事务", () => {
  it("Outbox 写入抛错时消息也回滚（不留「有实体无变更」）", () => {
    const vault = openTestVault()
    new ConversationRepository(vault.db).upsert({
      id: "conv-1",
      channelId: "dingtalk",
      externalId: "cid-1",
      type: "group",
      createdAt: NOW,
    })
    const messages = new MessageRepository(vault.db)

    expect(() =>
      withTransaction(vault.db, () => {
        messages.upsertMany([message("m-1")])
        // 模拟 Outbox 写入失败（磁盘满、约束冲突等）
        throw new Error("changelog write failed")
      }),
    ).toThrow(/changelog write failed/)

    expect(messages.count()).toBe(0)
    expect(new ChangelogRepository(vault.db).count()).toBe(0)
    vault.close()
  })

  it("成功路径：消息与变更条目同时可见", () => {
    const vault = openTestVault()
    new ConversationRepository(vault.db).upsert({
      id: "conv-1",
      channelId: "dingtalk",
      externalId: "cid-1",
      type: "group",
      createdAt: NOW,
    })
    const messages = new MessageRepository(vault.db)
    const changelog = new ChangelogRepository(vault.db)

    withTransaction(vault.db, () => {
      const result = messages.upsertMany([message("m-1")])
      changelog.append(
        result.changed.map((row) => ({
          op: "upsert" as const,
          entityType: "message" as const,
          entityId: row.id,
          channelId: row.channelId,
          domain: "chat" as const,
          occurredAt: row.sentAt,
          emittedAt: NOW,
          digest: "d1",
        })),
      )
    })

    expect(messages.count()).toBe(1)
    expect(changelog.head()).toBe(1)
    // 「数据可见 ⇔ 变更可见」：拿到 seq 就一定查得到实体。
    const entry = changelog.changesSince(0, 10)[0]
    expect(entry).toBeDefined()
    if (entry !== undefined) expect(messages.findById(entry.entityId)).not.toBeNull()
    vault.close()
  })

  it("外键失败也整体回滚（会话不存在时不该留下孤儿消息）", () => {
    const vault = openTestVault()
    const messages = new MessageRepository(vault.db)
    expect(() =>
      withTransaction(vault.db, () => {
        messages.upsertMany([message("m-orphan")])
      }),
    ).toThrow()
    expect(messages.count()).toBe(0)
    vault.close()
  })
})
