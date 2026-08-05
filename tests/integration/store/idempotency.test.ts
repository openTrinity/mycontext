/**
 * 幂等性的集成测试。
 *
 * 采集刻意让两层轮询的时间窗重叠（对抗时钟偏差与服务端延迟），
 * 所以「重复拉到同一条」是**常态**而非异常路径 —— 幂等不是优化，是正确性。
 *
 * ★ 其中一条专门盯 `external_id=''` 的行：SQLite 中 `NULL != NULL`，
 *   可空列参与 UNIQUE 时那些行的唯一性**完全不生效**（实测重放 3 次得到 3 行）。
 *   这条测试就是为了防止有人在后续迁移里把它改回可空。
 */
import { describe, expect, it } from "vitest"
import { RawRecordRepository, MessageRepository, ConversationRepository } from "@mycontext/store"
import { openTestVault, type TestVault } from "../../helpers/vault.js"

function rawRecord(overrides: Partial<Parameters<RawRecordRepository["insertMany"]>[0][0]> = {}) {
  return {
    id: "raw-1",
    channelId: "dingtalk",
    resource: "chat.message",
    externalId: "msg-ext-1",
    payload: '{"content":"hi"}',
    payloadHash: "hash-1",
    source: "dws-cli",
    fetchedAt: 1_700_000_000_000,
    ...overrides,
  }
}

function seedConversation(vault: TestVault): string {
  const conversations = new ConversationRepository(vault.db)
  conversations.upsert({
    id: "conv-1",
    channelId: "dingtalk",
    externalId: "cid-1",
    type: "group",
    title: "测试群",
    createdAt: 1_700_000_000_000,
  })
  return "conv-1"
}

describe("raw_records 幂等", () => {
  it("同一批重放 3 次仍只有 1 行", () => {
    const vault = openTestVault()
    const raws = new RawRecordRepository(vault.db)

    for (let round = 0; round < 3; round += 1) {
      const result = raws.insertMany([rawRecord({ id: `raw-${round}` })])
      // 第一轮插入成功，之后两轮因幂等键冲突被跳过。
      expect(result.inserted.length).toBe(round === 0 ? 1 : 0)
      expect(result.skipped).toBe(round === 0 ? 0 : 1)
    }
    expect(raws.count()).toBe(1)
    vault.close()
  })

  /**
   * 无平台主键的资源（会话列表快照等）用空串。
   * 若这一列可空，下面这三次插入会得到 **3 行** —— 幂等直接失效。
   */
  it("external_id 为空串时重放 3 次仍只有 1 行", () => {
    const vault = openTestVault()
    const raws = new RawRecordRepository(vault.db)

    for (let round = 0; round < 3; round += 1) {
      raws.insertMany([
        rawRecord({
          id: `snapshot-${round}`,
          resource: "chat.conversation.list",
          externalId: "",
          payloadHash: "snapshot-hash",
        }),
      ])
    }
    expect(raws.count()).toBe(1)
    vault.close()
  })

  it("内容变化产生新行（供修订链），内容相同不产生", () => {
    const vault = openTestVault()
    const raws = new RawRecordRepository(vault.db)
    raws.insertMany([rawRecord({ id: "v1", payloadHash: "h1" })])
    raws.insertMany([rawRecord({ id: "v2", payloadHash: "h2", payload: '{"content":"edited"}' })])
    raws.insertMany([rawRecord({ id: "v2-again", payloadHash: "h2" })])
    expect(raws.count()).toBe(2)
    vault.close()
  })
})

describe("messages 幂等与变更检测", () => {
  const base = (overrides: Record<string, unknown> = {}) => ({
    id: "msg-1",
    channelId: "dingtalk",
    conversationId: "conv-1",
    externalId: "msg-ext-1",
    senderExternalId: "sender-a",
    contentText: "沙箱环境部署完成了",
    sentAt: 1_700_000_000_000,
    direction: "inbound" as const,
    createdAt: 1_700_000_000_000,
    ...overrides,
  })

  it("重放 3 次：1 行，且只有第一次算「变更」", () => {
    const vault = openTestVault()
    seedConversation(vault)
    const messages = new MessageRepository(vault.db)

    const first = messages.upsertMany([base()])
    expect(first.changed.length).toBe(1)
    expect(first.unchanged).toBe(0)

    for (let round = 0; round < 2; round += 1) {
      const again = messages.upsertMany([base({ id: `msg-retry-${round}` })])
      // ★ 这一条是 Outbox 正确性的关键：重叠窗口不该产生无意义的变更条目，
      //   否则下游（建索引 / 蒸馏 / 图谱）会每轮都照单全收地重算。
      expect(again.changed.length).toBe(0)
      expect(again.unchanged).toBe(1)
    }
    expect(messages.count()).toBe(1)
    vault.close()
  })

  it("内容被编辑时算变更且 revision 递增", () => {
    const vault = openTestVault()
    seedConversation(vault)
    const messages = new MessageRepository(vault.db)
    messages.upsertMany([base()])
    const edited = messages.upsertMany([base({ contentText: "沙箱环境部署失败了" })])

    expect(edited.changed.length).toBe(1)
    expect(edited.changed[0]?.revision).toBe(2)
    expect(edited.changed[0]?.contentText).toBe("沙箱环境部署失败了")
    vault.close()
  })

  it("upsert 返回的是库里那一行（不是回显入参）", () => {
    const vault = openTestVault()
    seedConversation(vault)
    const messages = new MessageRepository(vault.db)
    messages.upsertMany([base({ id: "original-id" })])
    // 换一个 id 但同一个 external_id：冲突分支会保留原 id。
    const second = messages.upsertMany([base({ id: "different-id", contentText: "改了" })])
    // 下游拿到的必须是真实的行 id，否则会去查一个不存在的记录。
    expect(second.changed[0]?.id).toBe("original-id")
    vault.close()
  })

  it("is_self 的三态：null 不塌缩成 false，且判定过不被覆盖回 null", () => {
    const vault = openTestVault()
    seedConversation(vault)
    const messages = new MessageRepository(vault.db)

    messages.upsertMany([base()])
    expect(messages.findById("msg-1")?.isSelf).toBeNull()

    // 身份确认后回填
    const updated = messages.backfillSelf("dingtalk", ["sender-a"])
    expect(updated).toBe(1)
    expect(messages.findById("msg-1")?.isSelf).toBe(true)

    // 后续采集又送来一条不带 is_self 的同消息 → 不能把已判定的值抹回 null
    messages.upsertMany([base({ contentText: "内容变了触发 upsert", isSelf: null })])
    expect(messages.findById("msg-1")?.isSelf).toBe(true)
    vault.close()
  })

  it("回填只按 sender_external_id 匹配，不看显示名", () => {
    const vault = openTestVault()
    seedConversation(vault)
    const messages = new MessageRepository(vault.db)
    // 同名不同 ID：实测按姓名搜索会返回 5+ 个不同 ID，姓名匹配会灾难性误判。
    messages.upsertMany([
      base({
        id: "m-self",
        externalId: "e-self",
        senderExternalId: "id-self",
        senderDisplayName: "高鹏",
      }),
      base({
        id: "m-other",
        externalId: "e-other",
        senderExternalId: "id-other",
        senderDisplayName: "高鹏",
      }),
    ])
    messages.backfillSelf("dingtalk", ["id-self"])
    expect(messages.findById("m-self")?.isSelf).toBe(true)
    expect(messages.findById("m-other")?.isSelf).toBe(false)
    vault.close()
  })
})
