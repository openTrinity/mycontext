/**
 * 清空 vault 的数据 —— 三条硬约束与「保留什么」的回归门禁。
 *
 * ## 为什么这一层必须有测试
 *
 * 这个函数删的是真实聊天记录，而它的失效方式**全是静默的**（见
 * `wipe-vault.ts` 文件头的三条）：FTS 虚表留下永远删不掉的可检索正文、
 * 消费者游标高于新序列导致全部新数据被跳过、外键没开留下四万行孤儿。
 * 这三样都不报错，只会让"清空之后"的库在某个维度上仍然是脏的。
 *
 * 所以这里断言的是**结果**（库里剩下什么），而不是"某条 SQL 被执行过"。
 */
import { describe, expect, it } from "vitest"
import {
  ConversationRepository,
  DistillSourceRepository,
  FtsIndexRepository,
  MessageRepository,
  SelfIdentityRepository,
  wipeVaultData,
} from "@mycontext/store"
import { openTestVault, type TestVault } from "../../helpers/vault.js"

const START = 1_700_000_000_000
const CHANNEL = "dingtalk"
const CID = "cidFAKE0001=="

/** 造一个"采了一阵"的库：会话 + 消息 + FTS 索引 + 勾选范围 + 本人身份。 */
function seed(vault: TestVault): void {
  new ConversationRepository(vault.db).upsert({
    id: "conv-1",
    channelId: CHANNEL,
    externalId: CID,
    type: "group",
    title: "群",
    memberCount: 3,
    isSelfInvolved: true,
    isBotChannel: false,
    lastMessageAt: START,
    createdAt: START,
  })
  const messages = new MessageRepository(vault.db)
  const fts = new FtsIndexRepository(vault.db)
  for (let index = 1; index <= 3; index += 1) {
    const id = `msg-${index}`
    messages.upsertMany([
      {
        id,
        channelId: CHANNEL,
        conversationId: "conv-1",
        externalId: `msgFAKE000${index}==`,
        senderActorId: null,
        senderExternalId: "DFAKE0001peer",
        senderDisplayName: "张三",
        contentText: `内容 ${index}`,
        contentJson: null,
        quotedExternalId: null,
        threadId: null,
        sentAt: START + index * 1_000,
        direction: "inbound",
        isSelf: false,
        origin: "human",
        hasMedia: false,
        rawRecordId: null,
        createdAt: START,
      },
    ])
    fts.upsert({
      messageId: id,
      conversationId: "conv-1",
      seg: `内容 ${index}`,
      contentHash: `hash-${index}`,
      indexedAt: START,
    })
  }

  // 用户勾的范围 —— **必须保留**
  new DistillSourceRepository(vault.db).upsert(
    "chat",
    { enabled: true, scope: { since: START - 86_400_000, conversationIds: [CID] } },
    START,
  )
  // 本人身份 —— **必须保留**（删了蒸馏会拒掉全部语料）
  const self = new SelfIdentityRepository(vault.db)
  self.upsert({
    channelId: CHANNEL,
    corpId: "dingFAKE0001corp",
    corpName: "示例科技",
    userId: "100200",
    displayNames: ["张三"],
    openIds: [{ kind: "openDingTalkId", value: "DFAKE0001self" }],
  })
  self.confirm(CHANNEL, START)
}

function count(vault: TestVault, table: string): number {
  return vault.db.prepare<[], { c: number }>(`SELECT count(*) AS c FROM ${table}`).get()?.c ?? 0
}

describe("★★ wipeVaultData：清数据", () => {
  it("语料、会话、索引都清空", () => {
    const vault = openTestVault()
    seed(vault)
    expect(count(vault, "messages")).toBe(3)

    wipeVaultData(vault.db, { now: START })

    expect(count(vault, "messages")).toBe(0)
    expect(count(vault, "conversations")).toBe(0)
    expect(count(vault, "messages_fts_state")).toBe(0)
    vault.close()
  })

  it("★★ 硬约束①：`messages_fts` 虚表也清零（FK cascade 对它无效）", () => {
    const vault = openTestVault()
    seed(vault)
    expect(count(vault, "messages_fts")).toBe(3)

    wipeVaultData(vault.db, { now: START })

    /**
     * 顺序写反（先删 messages）的话，cascade 会先带走 `messages_fts_state`，
     * 而虚表里那几行就永久失去了唯一的 rowid 来源 —— 可检索的正文留在
     * 索引里，且再没有任何代码能删掉它。
     */
    expect(count(vault, "messages_fts")).toBe(0)
    vault.close()
  })

  it("★ FTS 自检通过（清空后 rowid 空间干净）", () => {
    const vault = openTestVault()
    seed(vault)

    const report = wipeVaultData(vault.db, { now: START })

    expect(report.ftsIntegrityOk).toBe(true)
    expect(report.ftsError).toBeNull()
    vault.close()
  })

  it("★★ 硬约束②：changelog 序列与消费者游标一起归零", () => {
    const vault = openTestVault()
    seed(vault)
    // 假装消费者已经追到很前面
    vault.db
      .prepare(
        `INSERT INTO consumer_cursors (consumer_id, acked_seq, required, registered_at,
             stale_after_ms, needs_full_rebuild, updated_at)
         VALUES ('local-index-fts', 85395, 1, ?, 600000, 0, ?)`,
      )
      .run(START, START)

    wipeVaultData(vault.db, { now: START })

    const acked =
      vault.db
        .prepare<[], { acked_seq: number }>("SELECT acked_seq FROM consumer_cursors LIMIT 1")
        .get()?.acked_seq ?? -1
    /**
     * 不清游标的话：新数据从 seq=1 开始却低于 85395 → **所有消费者永久
     * 跳过全部新数据**。表现是采集在涨而索引/蒸馏/图谱永远收不到东西。
     */
    expect(acked).toBe(0)
    // AUTOINCREMENT 也要归零，两者必须成对
    const seq = vault.db
      .prepare<
        [],
        { seq: number }
      >("SELECT seq FROM sqlite_sequence WHERE name = 'knowledge_changelog'")
      .get()
    expect(seq).toBeUndefined()
    vault.close()
  })

  it("采集水位归零（否则下一轮从「当下」往后采，而历史已经没了）", () => {
    const vault = openTestVault()
    seed(vault)
    vault.db
      .prepare(
        `INSERT INTO sync_cursors (scope, cursor, window_start, window_end, watermark,
             page_count, truncated, status, attempts, updated_at)
         VALUES ('dingtalk:chat:l2', NULL, NULL, NULL, ?, 0, 0, 'idle', 0, ?)`,
      )
      .run(START, START)

    wipeVaultData(vault.db, { now: START })

    const watermark =
      vault.db
        .prepare<[], { watermark: number }>("SELECT watermark FROM sync_cursors LIMIT 1")
        .get()?.watermark ?? -1
    expect(watermark).toBe(0)
    vault.close()
  })
})

describe("★★ wipeVaultData：不清「你是谁」和「你选了什么」", () => {
  it("★ 本人身份与 confirmed_at 保留（删了蒸馏会拒掉全部语料）", () => {
    const vault = openTestVault()
    seed(vault)

    wipeVaultData(vault.db, { now: START })

    const self = new SelfIdentityRepository(vault.db).get(CHANNEL)
    expect(self).not.toBeNull()
    expect(self?.confirmedAt).not.toBeNull()
    vault.close()
  })

  it("★ 用户勾的会话与时间下界保留（只清水位）", () => {
    const vault = openTestVault()
    seed(vault)

    wipeVaultData(vault.db, { now: START })

    const chat = new DistillSourceRepository(vault.db).list().find((row) => row.kind === "chat")
    expect(chat?.enabled).toBe(true)
    expect(chat?.scope.conversationIds).toEqual([CID])
    expect(chat?.scope.since).toBe(START - 86_400_000)
    // 水位清零了 —— 那是要重蒸的部分
    expect(chat?.lastSyncedSeq).toBe(0)
    vault.close()
  })

  it("★ 用户自己的搜索提问历史默认保留（那不是采集来的数据）", () => {
    const vault = openTestVault()
    seed(vault)
    vault.db
      .prepare(
        `INSERT INTO search_chat_sessions (id, title, acp_cwd, harness_id, model_role,
             state, pinned, message_count, last_active_at, created_at)
         VALUES ('s-1', '我问过的问题', '/tmp', 'h', 'main', 'idle', 0, 0, ?, ?)`,
      )
      .run(START, START)

    wipeVaultData(vault.db, { now: START })

    expect(count(vault, "search_chat_sessions")).toBe(1)
    vault.close()
  })

  it("显式 dropSearch 才连搜索历史一起清", () => {
    const vault = openTestVault()
    seed(vault)
    vault.db
      .prepare(
        `INSERT INTO search_chat_sessions (id, title, acp_cwd, harness_id, model_role,
             state, pinned, message_count, last_active_at, created_at)
         VALUES ('s-1', '我问过的问题', '/tmp', 'h', 'main', 'idle', 0, 0, ?, ?)`,
      )
      .run(START, START)

    wipeVaultData(vault.db, { now: START, dropSearch: true })

    expect(count(vault, "search_chat_sessions")).toBe(0)
    vault.close()
  })
})

describe("wipeVaultData：预演与幂等", () => {
  it("预演只数不删", () => {
    const vault = openTestVault()
    seed(vault)

    const report = wipeVaultData(vault.db, { now: START, dryRun: true })

    expect(report.dryRun).toBe(true)
    expect(report.totalRows).toBeGreaterThan(0)
    expect(report.rows["messages"]).toBe(3)
    // 库没动
    expect(count(vault, "messages")).toBe(3)
    // 预演不做自检（没清，谈不上"清干净了没有"）
    expect(report.ftsIntegrityOk).toBeNull()
    vault.close()
  })

  it("幂等：再清一次合计 0 行", () => {
    const vault = openTestVault()
    seed(vault)
    wipeVaultData(vault.db, { now: START })

    const second = wipeVaultData(vault.db, { now: START })

    expect(second.totalRows).toBe(0)
    vault.close()
  })

  it("媒体文件路径交给调用方删（store 层不碰文件系统）", () => {
    const vault = openTestVault()
    seed(vault)
    vault.db
      .prepare(
        `INSERT INTO media_assets (id, message_id, kind, resource_id, resource_kind,
             original_name, path, bytes, downloaded_at)
         VALUES ('m-1', 'msg-1', 'image', 'r-1', 'photo', NULL, '/tmp/fake/a.jpg', 10, ?)`,
      )
      .run(START)

    const report = wipeVaultData(vault.db, { now: START })

    expect(report.filePaths).toContain("/tmp/fake/a.jpg")
    vault.close()
  })
})
