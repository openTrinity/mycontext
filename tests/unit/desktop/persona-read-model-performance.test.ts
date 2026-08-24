import { describe, expect, it, vi } from "vitest"
import { ManualClock, createLogger } from "@mycontext/kernel"
import { staticLlmProvider } from "@mycontext/llm"
import {
  ConversationRepository,
  MessageRepository,
  PersonaConfigRepository,
} from "@mycontext/store"
import { PersonaService } from "../../../apps/desktop/src/main/services/persona.service.js"
import { openTestVault } from "../../helpers/vault.js"

const NOW = 1_787_000_000_000
const logger = createLogger("PerformanceTest", { level: "error" })

function setup(messageCount = 200) {
  const vault = openTestVault()
  new ConversationRepository(vault.db).upsert({
    id: "conv-1",
    channelId: "dingtalk",
    externalId: "cid-PERF-FAKE",
    type: "direct",
    title: "性能测试会话",
    memberCount: 2,
    createdAt: NOW,
  })
  new MessageRepository(vault.db).upsertMany(
    Array.from({ length: messageCount }, (_, index) => ({
      id: `message-${String(index)}`,
      channelId: "dingtalk",
      conversationId: "conv-1",
      externalId: `external-${String(index)}`,
      senderExternalId: "sender-fake",
      senderDisplayName: "测试成员",
      contentText: `消息 ${String(index)}`,
      sentAt: NOW + index,
      direction: "inbound" as const,
      isSelf: false,
      createdAt: NOW + index,
    })),
  )
  const service = new PersonaService({
    clock: new ManualClock(NOW + messageCount),
    logger,
    llmProvider: staticLlmProvider(null),
    getWindow: () => null,
  })
  service.attach(vault.db)
  return { vault, service }
}

describe("Persona UI 读模型性能门禁", () => {
  it("消息数量增长时 snapshot 的 SQL 数量保持常数级", () => {
    const { vault, service } = setup()
    const prepare = vi.spyOn(vault.db, "prepare")

    const snapshot = service.snapshot()

    expect(snapshot.pendingInbox).toBeGreaterThanOrEqual(0)
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(12)
    prepare.mockRestore()
    vault.close()
  })

  it("自动回复数量继续排除动态 bot 会话", () => {
    const { vault, service } = setup(1)
    new PersonaConfigRepository(vault.db).upsert("conv-1", { replyMode: "auto" }, NOW)
    vault.db.prepare("UPDATE conversations SET title='BuildBot' WHERE id='conv-1'").run()
    service.onDelivered(["conv-1"])

    expect(service.snapshot().autoReplyCount).toBe(0)
    vault.close()
  })

  it("直接仓储写入后 snapshot 立即反映新状态", () => {
    const { vault, service } = setup(1)
    expect(service.snapshot().pendingInbox).toBe(0)
    vault.db
      .prepare(
        `INSERT INTO dh_inbox(message_id,conversation_id,state,enqueued_at)
         VALUES('message-0','conv-1','pending',?)`,
      )
      .run(NOW + 1)

    expect(service.snapshot().pendingInbox).toBe(1)
    vault.close()
  })

  it("无数据库写入的连续 UI 读取不会重复展开动态排除视图", () => {
    const { vault, service } = setup()
    const prepare = vi.spyOn(vault.db, "prepare")

    service.snapshot()
    service.conversations()
    service.drafts()
    service.snapshot()

    const exclusionQueries = prepare.mock.calls.filter(([sql]) =>
      String(sql).includes("persona_conversation_exclusions"),
    )
    expect(exclusionQueries).toHaveLength(0)
    prepare.mockRestore()
    vault.close()
  })
})
