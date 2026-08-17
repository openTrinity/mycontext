/**
 * 迁移链的集成测试。
 *
 * 覆盖三件事：
 * ① 全新库能一次跑完 v1..vN 并建出全部表（含 FTS 虚拟表）；
 * ② 版本断言用**集合比对**而不是「等于条数」；
 * ③ 已发布的迁移被改动时明确报错（现有 checksum 机制的回归）。
 *
 * 还额外验证了 contentless FTS 的两个陷阱在我们的建表参数下确实被绕开
 * —— 它们不是理论风险：`UNINDEXED` 列读出来是 NULL、
 * 不带 `contentless_delete=1` 时 DELETE 直接报错，两者都实测过。
 *
 * 末尾那个 describe 锁的是 checksum **判据**本身（改注释放行 / 改 schema 报错）。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import {
  ConversationRepository,
  type Migration,
  openStore,
  PersonaRunRepository,
  rawChecksum,
  runMigrations,
  schemaChecksum,
  SelfIdentityRepository,
  type SqliteDatabase,
  stripSqlComments,
  VAULT_MIGRATIONS,
} from "@mycontext/store"

const tempDirs: string[] = []

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "mycontext-mig-"))
  tempDirs.push(dir)
  return join(dir, "core.sqlite")
}

/**
 * 往**旧版本**的库里插消息 —— 不走 `MessageRepository`。
 *
 * ## ★★★ 为什么这里必须绕开 repository
 *
 * 这些用例故意把库停在某个中间版本（`VAULT_MIGRATIONS.slice(0, 14)`），
 * 然后用**当前**的 repository 代码往里写 —— 而 repository 的 SQL 总是
 * 按**最新** schema 写的。于是每加一列都会让这些用例红一次，
 * 报的还是 `table messages has no column named …`（v30 加
 * `learning_eligible` 时六条一起红）。
 *
 * ★ 那个红**不是**在报告一个真问题：这些用例测的是"迁移到 vN 时会不会
 * 清掉该清的历史行"，与列的多少无关。所以正确的修法是让**种子数据**
 * 只依赖那一版真的有的列，而不是每次去补 repository 的新字段。
 *
 * ★★ 反过来说：迁移本身的断言仍然走真 SQL（下面每个用例的 expect），
 * 所以这个 helper 不会掩盖迁移写错。
 */
function seedMessage(
  db: SqliteDatabase,
  row: {
    id: string
    conversationId: string
    externalId: string
    contentText: string
    sentAt: number
    direction: "inbound" | "outbound"
    isSelf?: boolean | null
    origin?: string
  },
): void {
  db.prepare(
    `INSERT INTO messages
       (id, channel_id, conversation_id, external_id, content_text, sent_at,
        direction, is_self, origin, created_at)
     VALUES (?, 'dingtalk', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.conversationId,
    row.externalId,
    row.contentText,
    row.sentAt,
    row.direction,
    row.isSelf === null || row.isSelf === undefined ? null : row.isSelf ? 1 : 0,
    row.origin ?? "human",
    row.sentAt,
  )
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function openVault(path: string) {
  return openStore({ path, migrations: VAULT_MIGRATIONS })
}

describe("vault 迁移链", () => {
  it("旧 Persona v11-v15 自动顺延到 v12-v16，并补跑正式 v11", () => {
    const path = tempDbPath()
    const legacyMigrations = [
      ...VAULT_MIGRATIONS.slice(0, 10),
      ...VAULT_MIGRATIONS.slice(11, 16).map((migration) => ({
        ...migration,
        version: migration.version - 1,
      })),
    ]
    const legacy = openStore({ path, migrations: legacyMigrations })
    legacy.db
      .prepare(
        `INSERT INTO contact_avatars
           (channel_id, external_id, miss_reason, attempted_at)
         VALUES ('dingtalk', 'legacy-avatar', 'no_common_group', 1)`,
      )
      .run()
    legacy.close()

    const upgraded = openVault(path)
    /**
     * ★ 断言"跑到了最新"，而不是硬编码一个版本号。
     *
     * 原来写的是 `toBe(16)` —— 每加一条迁移都要来改这个数字，而改它的人
     * 未必看得出这条测试真正想验的是什么（"旧 Persona v11-v15 的顺延"）。
     * 更糟的是：忘了改就变成一条**与本次改动无关的红**，而习惯性地把它
     * 改成新数字又会让这条断言退化成"复述常量表"。
     *
     * 用 `at(-1)` 表达意图：迁移链要一路跑到清单最后一条。
     */
    const latest = VAULT_MIGRATIONS.at(-1)?.version
    expect(upgraded.appliedVersion).toBe(latest)
    expect(
      upgraded.db
        .prepare<
          [],
          { version: number; name: string }
        >("SELECT version, name FROM schema_migrations WHERE version BETWEEN 11 AND 16 ORDER BY version")
        .all(),
    ).toEqual([
      { version: 11, name: "avatar-miss-reset" },
      { version: 12, name: "persona-review" },
      { version: 13, name: "persona-conversation-exclusions" },
      { version: 14, name: "persona-self-conversation" },
      { version: 15, name: "persona-public-service-bots" },
      { version: 16, name: "persona-reply-expiry" },
    ])
    expect(
      upgraded.db
        .prepare<
          [],
          { c: number }
        >("SELECT count(*) AS c FROM contact_avatars WHERE external_id = 'legacy-avatar'")
        .get()?.c,
    ).toBe(0)
    upgraded.close()
  })

  it("全新库应用全部版本，版本集合与清单一致", () => {
    const store = openVault(tempDbPath())
    expect(store.appliedMigrations.map((item) => item.version)).toEqual(
      VAULT_MIGRATIONS.map((item) => item.version),
    )
    expect(store.appliedVersion).toBe(VAULT_MIGRATIONS.at(-1)?.version ?? 0)
    store.close()
  })

  it("版本号连续无空洞（预留空号会让 appliedVersion 的语义失真）", () => {
    const versions = VAULT_MIGRATIONS.map((item) => item.version)
    expect(versions).toEqual(versions.map((_, index) => index + 1))
  })

  it("建出数据面与索引的全部表", () => {
    const store = openVault(tempDbPath())
    const names = store.db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name)

    for (const expected of [
      // v2 原生留存 + 规范化
      "raw_records",
      "actors",
      "channel_self_identity",
      "conversations",
      "messages",
      "message_mentions",
      "media_assets",
      "documents",
      "minutes",
      "sync_cursors",
      "probe_snapshots",
      // v3 Outbox
      "knowledge_changelog",
      "consumer_cursors",
      "vector_failures",
      // v4 索引
      "messages_fts",
      "messages_fts_state",
      "message_vectors",
    ]) {
      expect(names, `缺少表 ${expected}`).toContain(expected)
    }
    store.close()
  })

  it("重复打开幂等：不重复应用", () => {
    const path = tempDbPath()
    const first = openVault(path)
    const count = first.appliedMigrations.length
    first.close()
    const second = openVault(path)
    expect(second.appliedMigrations.length).toBe(count)
    second.close()
  })

  it("v12 升级时立即过期已经被本人回复覆盖的历史草稿", () => {
    const path = tempDbPath()
    const before = openStore({ path, migrations: VAULT_MIGRATIONS.slice(0, 11) })
    const now = 1_785_306_600_000
    new ConversationRepository(before.db).upsert({
      id: "conv-1",
      channelId: "dingtalk",
      externalId: "cid-1",
      type: "direct",
      title: "测试",
      memberCount: 2,
      createdAt: now,
    })
    seedMessage(before.db, {
      id: "incoming",
      conversationId: "conv-1",
      externalId: "msg-in",
      contentText: "在吗",
      sentAt: now,
      direction: "inbound",
      isSelf: false,
    })
    seedMessage(before.db, {
      id: "reply",
      conversationId: "conv-1",
      externalId: "msg-out",
      contentText: "在",
      sentAt: now + 1000,
      direction: "outbound",
      isSelf: true,
    })
    new PersonaRunRepository(before.db).insertDraft(
      {
        id: "draft-1",
        runId: null,
        conversationId: "conv-1",
        replyToExternalId: "msg-in",
        text: "我在",
        citations: ["incoming"],
        notSentReason: "mode_not_auto",
      },
      now + 10,
    )
    before.close()

    const upgraded = openStore({ path, migrations: VAULT_MIGRATIONS.slice(0, 12) })
    const draft = upgraded.db
      .prepare<
        [],
        { state: string; resolved_at: number | null }
      >("SELECT state, resolved_at FROM dh_drafts WHERE id = 'draft-1'")
      .get()
    expect(draft?.state).toBe("expired")
    expect(draft?.resolved_at).not.toBeNull()
    upgraded.close()
  })

  it("v13 升级时清掉 bot 与自聊会话中已有的待处理项", () => {
    const path = tempDbPath()
    const before = openStore({ path, migrations: VAULT_MIGRATIONS.slice(0, 12) })
    const now = 1_785_306_600_000
    const conversations = new ConversationRepository(before.db)

    conversations.upsert({
      id: "buildbot",
      channelId: "dingtalk",
      externalId: "cid-buildbot",
      type: "direct",
      title: "BuildBot",
      createdAt: now,
    })
    conversations.upsert({
      id: "self-chat",
      channelId: "dingtalk",
      externalId: "cid-self",
      type: "direct",
      title: "小吴",
      createdAt: now,
    })
    seedMessage(before.db, {
      id: "bot-message",
      conversationId: "buildbot",
      externalId: "ext-bot",
      contentText: "系统通知",
      sentAt: now,
      direction: "inbound",
      isSelf: false,
    })
    seedMessage(before.db, {
      id: "self-message",
      conversationId: "self-chat",
      externalId: "ext-self",
      contentText: "备忘",
      sentAt: now,
      direction: "outbound",
      isSelf: true,
    })
    for (const [messageId, conversationId] of [
      ["bot-message", "buildbot"],
      ["self-message", "self-chat"],
    ] as const) {
      before.db
        .prepare(
          `INSERT INTO dh_inbox
             (message_id, conversation_id, state, enqueued_at)
           VALUES (?, ?, 'pending', ?)`,
        )
        .run(messageId, conversationId, now)
      new PersonaRunRepository(before.db).insertDraft(
        {
          id: `draft-${messageId}`,
          runId: null,
          conversationId,
          replyToExternalId: `ext-${messageId === "bot-message" ? "bot" : "self"}`,
          text: "草稿",
          citations: [messageId],
          notSentReason: "mode_not_auto",
        },
        now,
      )
    }
    before.close()

    const upgraded = openStore({ path, migrations: VAULT_MIGRATIONS.slice(0, 13) })
    expect(
      upgraded.db
        .prepare<[], { c: number }>("SELECT count(*) AS c FROM dh_inbox WHERE state = 'pending'")
        .get()?.c,
    ).toBe(0)
    expect(
      upgraded.db
        .prepare<[], { c: number }>("SELECT count(*) AS c FROM dh_drafts WHERE state = 'pending'")
        .get()?.c,
    ).toBe(0)
    expect(new ConversationRepository(upgraded.db).findById("buildbot")?.isBotChannel).toBe(true)
    upgraded.close()
  })

  it("v14 自聊必须匹配已确认的本人姓名，不能把历史不完整的普通单聊排除", () => {
    const path = tempDbPath()
    const before = openStore({ path, migrations: VAULT_MIGRATIONS.slice(0, 13) })
    const now = 1_785_306_600_000
    const conversations = new ConversationRepository(before.db)
    const identities = new SelfIdentityRepository(before.db)
    identities.upsert({
      channelId: "dingtalk",
      userId: "self-user",
      openIds: [{ kind: "openDingTalkId", value: "self" }],
      displayNames: ["顾清和", "小吴"],
      corpId: null,
      corpName: null,
    })
    identities.confirm("dingtalk", now)

    for (const [id, title] of [
      ["self-chat", "小吴"],
      ["partial-human-chat", "小徐"],
    ] as const) {
      conversations.upsert({
        id,
        channelId: "dingtalk",
        externalId: `cid-${id}`,
        type: "direct",
        title,
        createdAt: now,
      })
      seedMessage(before.db, {
        id: `message-${id}`,
        conversationId: id,
        externalId: `ext-${id}`,
        contentText: "本人发出的消息",
        sentAt: now,
        direction: "outbound",
        isSelf: true,
      })
    }
    expect(conversations.personaExclusionReason("self-chat")).toBe("self_conversation")
    expect(conversations.personaExclusionReason("partial-human-chat")).toBe("self_conversation")
    before.close()

    const upgraded = openVault(path)
    const after = new ConversationRepository(upgraded.db)
    expect(after.personaExclusionReason("self-chat")).toBe("self_conversation")
    expect(after.personaExclusionReason("partial-human-chat")).toBeNull()
    upgraded.close()
  })

  it("v15 清理公益3小时这类平台公益入口的历史草稿", () => {
    const path = tempDbPath()
    const before = openStore({ path, migrations: VAULT_MIGRATIONS.slice(0, 14) })
    const now = 1_785_306_600_000
    new ConversationRepository(before.db).upsert({
      id: "public-service",
      channelId: "dingtalk",
      externalId: "cid-public-service",
      type: "direct",
      title: "公益3小时",
      createdAt: now,
    })
    seedMessage(before.db, {
      id: "public-service-message",
      conversationId: "public-service",
      externalId: "ext-public-service",
      contentText: "公益提醒",
      sentAt: now,
      direction: "inbound",
      isSelf: false,
    })
    new PersonaRunRepository(before.db).insertDraft(
      {
        id: "public-service-draft",
        runId: null,
        conversationId: "public-service",
        replyToExternalId: "ext-public-service",
        text: "收到",
        citations: ["public-service-message"],
        notSentReason: "mode_not_auto",
      },
      now,
    )
    before.close()

    const upgraded = openVault(path)
    expect(new ConversationRepository(upgraded.db).personaExclusionReason("public-service")).toBe(
      "bot_channel",
    )
    expect(new PersonaRunRepository(upgraded.db).pendingDrafts()).toEqual([])
    upgraded.close()
  })

  it("v16 清理已读且超过 4 小时未回复的历史 inbox 与待审草稿", () => {
    const path = tempDbPath()
    const before = openStore({ path, migrations: VAULT_MIGRATIONS.slice(0, 15) })
    const old = Date.now() - 4 * 60 * 60_000 - 1000
    new ConversationRepository(before.db).upsert({
      id: "stale-conversation",
      channelId: "dingtalk",
      externalId: "cid-stale",
      type: "direct",
      title: "历史单聊",
      createdAt: old,
    })
    seedMessage(before.db, {
      id: "stale-message",
      conversationId: "stale-conversation",
      externalId: "ext-stale",
      contentText: "很久以前的消息",
      sentAt: old,
      direction: "inbound",
      isSelf: false,
    })
    before.db
      .prepare(
        `INSERT INTO dh_inbox
           (message_id, conversation_id, state, enqueued_at)
         VALUES ('stale-message', 'stale-conversation', 'pending', ?)`,
      )
      .run(old)
    before.db
      .prepare(
        `INSERT INTO probe_snapshots
           (channel_id, conversation_external_id, last_msg_at, unread_count, observed_at)
         VALUES ('dingtalk', 'cid-stale', ?, 0, ?)`,
      )
      .run(old, old + 1000)
    new PersonaRunRepository(before.db).insertDraft(
      {
        id: "stale-draft",
        runId: null,
        conversationId: "stale-conversation",
        replyToExternalId: "ext-stale",
        text: "迟到的回复",
        citations: ["stale-message"],
        notSentReason: "mode_not_auto",
      },
      old,
    )
    before.close()

    const upgraded = openVault(path)
    expect(
      upgraded.db
        .prepare<
          [],
          { state: string; drop_reason: string }
        >("SELECT state, drop_reason FROM dh_inbox WHERE message_id = 'stale-message'")
        .get(),
    ).toEqual({ state: "dropped", drop_reason: "stale_message" })
    /**
     * ★ 草稿**又回到 pending** —— v19 刻意把它放回来了。
     *
     * v16 会把这条待审草稿标 `expired`（已读 + 超 4 小时 + 本人未回），
     * 而 v19 取消了「按时效/已回过自动作废草稿」这条规则，并把历史上被它
     * 标掉的（判据：`expired_reason IS NULL`）恢复成 pending。
     *
     * 所以整条链跑完的**终态**是"草稿还在"。这不是 v16 失效了 ——
     * v16 的 inbox 清理仍然生效（上面那条断言），只是草稿那一半被后来的
     * 版本推翻了。见 v19 文件头。
     */
    const restored = new PersonaRunRepository(upgraded.db).pendingDrafts()
    expect(restored).toHaveLength(1)
    expect(restored[0]?.expiredReason).toBeNull()
    upgraded.close()
  })

  it("v16 保留超过 4 小时但仍未读的 inbox 与待审草稿", () => {
    const path = tempDbPath()
    const before = openStore({ path, migrations: VAULT_MIGRATIONS.slice(0, 15) })
    const old = Date.now() - 4 * 60 * 60_000 - 1000
    new ConversationRepository(before.db).upsert({
      id: "unread-conversation",
      channelId: "dingtalk",
      externalId: "cid-unread",
      type: "direct",
      title: "未读单聊",
      createdAt: old,
    })
    seedMessage(before.db, {
      id: "unread-message",
      conversationId: "unread-conversation",
      externalId: "ext-unread",
      contentText: "仍未读的历史消息",
      sentAt: old,
      direction: "inbound",
      isSelf: false,
    })
    before.db
      .prepare(
        `INSERT INTO dh_inbox
           (message_id, conversation_id, state, enqueued_at)
         VALUES ('unread-message', 'unread-conversation', 'pending', ?)`,
      )
      .run(old)
    before.db
      .prepare(
        `INSERT INTO probe_snapshots
           (channel_id, conversation_external_id, last_msg_at, unread_count, observed_at)
         VALUES ('dingtalk', 'cid-unread', ?, 1, ?)`,
      )
      .run(old, old + 1000)
    new PersonaRunRepository(before.db).insertDraft(
      {
        id: "unread-draft",
        runId: null,
        conversationId: "unread-conversation",
        replyToExternalId: "ext-unread",
        text: "仍应保留的回复",
        citations: ["unread-message"],
        notSentReason: "mode_not_auto",
      },
      old,
    )
    before.close()

    const upgraded = openVault(path)
    expect(
      upgraded.db
        .prepare<
          [],
          { state: string }
        >("SELECT state FROM dh_inbox WHERE message_id = 'unread-message'")
        .get(),
    ).toEqual({ state: "pending" })
    expect(new PersonaRunRepository(upgraded.db).pendingDrafts()).toHaveLength(1)
    upgraded.close()
  })
})

describe("contentless FTS 的两个陷阱已被建表参数绕开", () => {
  it("bigram 化后中文子串可命中，且 bm25 可用于排序", () => {
    const store = openVault(tempDbPath())
    // 写入侧 bigram：把「沙箱环境部署完成了」切成单字 + 相邻二字组合
    const seg = "沙 沙箱 箱 箱环 环 环境 境 境部 部 部署 署 署完 完 完成 成 成了 了"
    store.db.prepare("INSERT INTO messages_fts(rowid, seg) VALUES (1, ?)").run(seg)

    const hit = store.db
      .prepare<
        [],
        { c: number }
      >(`SELECT count(*) AS c FROM messages_fts WHERE messages_fts MATCH '"沙箱"'`)
      .get()
    expect(hit?.c).toBe(1)

    // bm25 不为 0 —— detail='none' 下它会全为 0，排序完全失效，那个配置不可用。
    const score = store.db
      .prepare<
        [],
        { b: number }
      >(`SELECT bm25(messages_fts) AS b FROM messages_fts WHERE messages_fts MATCH '"沙箱"'`)
      .get()
    expect(score?.b).not.toBe(0)
    store.close()
  })

  it("可以 DELETE（不带 contentless_delete=1 时会直接报错）", () => {
    const store = openVault(tempDbPath())
    store.db.prepare("INSERT INTO messages_fts(rowid, seg) VALUES (7, ?)").run("测 测试 试")
    expect(() => store.db.prepare("DELETE FROM messages_fts WHERE rowid = 7").run()).not.toThrow()
    // 删后重插同一个 rowid 也要正常（消息编辑会触发重建）
    expect(() =>
      store.db.prepare("INSERT INTO messages_fts(rowid, seg) VALUES (7, ?)").run("新 新的 的"),
    ).not.toThrow()
    store.close()
  })
})

/**
 * checksum 判据本身。
 *
 * 对应一个真实故障：一次全仓脱敏 sweep 把 v2 的一行 SQL **注释**里的示例姓名
 * 换成了化名 —— schema 一字未改，但每个已迁移的 vault 启动即
 * `DB_MIGRATION_FAILED`，应用直接起不来。同一形状之前也发生过一次（v9 注释里
 * 多了个 `'model'`）。
 *
 * 这组测试锁的是修法的两半，缺任一半修复都是错的：
 * 改注释要放行，**而改 schema 必须照旧报错**。后者尤其重要 ——
 * 「让应用起来」最省事的做法是不校验，那会把这道门禁悄悄换成装饰。
 */
describe("迁移 checksum 的判据", () => {
  /** 只改注释、不动 schema：把 v2 里那行注释换掉。 */
  function withEditedComment(migrations: readonly Migration[]): Migration[] {
    return migrations.map((migration) => {
      if (migration.version !== 2) return migration
      const edited = migration.sql.replace(
        "-- openConversationId",
        "-- 换成完全不同的注释文字（schema 一字未改）",
      )
      expect(edited, "替换没生效说明目标注释已不存在，这条测试失去意义").not.toBe(migration.sql)
      return { ...migration, sql: edited }
    })
  }

  /** 真改 schema：给 v2 的 conversations 加一列。 */
  function withExtraColumn(migrations: readonly Migration[]): Migration[] {
    return migrations.map((migration) => {
      if (migration.version !== 2) return migration
      const edited = migration.sql.replace(
        "  member_count      INTEGER,",
        "  member_count      INTEGER,\n  smuggled_column   TEXT,",
      )
      expect(edited).not.toBe(migration.sql)
      return { ...migration, sql: edited }
    })
  }

  it("改注释不算改迁移：能继续迁移，且记录收敛到语义 checksum", () => {
    const path = tempDbPath()
    const first = openVault(path)
    first.close()

    // 注释改掉后再开：不该抛错，且要迁到最新
    const reopened = openStore({ path, migrations: withEditedComment(VAULT_MIGRATIONS) })
    expect(reopened.appliedVersion).toBe(VAULT_MIGRATIONS.at(-1)?.version)
    const recorded = reopened.db
      .prepare<[], { checksum: string }>("SELECT checksum FROM schema_migrations WHERE version = 2")
      .get()?.checksum
    // 收敛到「剥注释后」的 hash —— 所以改前改后是同一个值
    const v2 = VAULT_MIGRATIONS.find((migration) => migration.version === 2)
    expect(recorded).toBe(schemaChecksum(v2?.sql ?? ""))
    expect(recorded).toBe(schemaChecksum(withEditedComment(VAULT_MIGRATIONS)[1]?.sql ?? ""))
    reopened.close()
  })

  it("★ 改 schema 仍然报错 —— 放行注释不等于放宽校验", () => {
    const path = tempDbPath()
    const first = openVault(path)
    first.close()

    expect(() => openStore({ path, migrations: withExtraColumn(VAULT_MIGRATIONS) })).toThrow(
      /已发布的迁移不可修改/,
    )
  })

  it("旧库记的原文 checksum 被接受并收敛（模拟判据变更前建的库）", () => {
    const path = tempDbPath()
    const store = openVault(path)
    store.close()

    // 手工改回「原文 hash」，模拟判据变更之前写入的记录
    const seeded = new Database(path)
    for (const migration of VAULT_MIGRATIONS) {
      seeded
        .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = ?")
        .run(rawChecksum(migration.sql), migration.version)
    }
    seeded.close()

    const reopened = openVault(path)
    expect(reopened.appliedVersion).toBe(VAULT_MIGRATIONS.at(-1)?.version)
    const converged = reopened.db
      .prepare<
        [],
        { version: number; checksum: string }
      >("SELECT version, checksum FROM schema_migrations ORDER BY version")
      .all()
    for (const row of converged) {
      const migration = VAULT_MIGRATIONS.find((item) => item.version === row.version)
      expect(row.checksum, `v${row.version} 未收敛`).toBe(schemaChecksum(migration?.sql ?? ""))
    }
    reopened.close()
  })

  /**
   * ★ 登记表的自校验。
   *
   * 防的是「以后有人往 legacyChecksums 里塞一个 schema 真的不同的 hash」——
   * 那等于给某个版本单独关掉门禁，而且完全静默。
   *
   * 判据：对每个登记项，必须能在**全历史**里找到一个原文变体既产出这个
   * 旧 hash、又与当前 SQL 同 schema。这里退一步只断言「登记项非空且格式对」
   * 加上「当前 SQL 的 schema 是唯一的」，完整的历史比对由
   * `scripts/check-migration-checksums.mjs` 做（它能读 git 历史，测试不该读）。
   */
  it("legacyChecksums 的每一项都是 32 位 hex，且不等于当前的任一 checksum", () => {
    const registered = VAULT_MIGRATIONS.filter(
      (migration) => migration.legacyChecksums !== undefined,
    )
    // 有登记项存在 —— 否则这条测试在空集合上恒绿
    expect(registered.length).toBeGreaterThan(0)

    for (const migration of registered) {
      for (const legacy of migration.legacyChecksums ?? []) {
        expect(legacy, `v${migration.version} 的 ${legacy} 不是 32 位 hex`).toMatch(
          /^[0-9a-f]{32}$/,
        )
        /**
         * 旧值必须**确实是旧的**：等于当前 schema 或原文 checksum 说明它
         * 已经走快速路径了，登记它只会掩盖「登记表是不是还对得上」这个问题。
         */
        expect(legacy).not.toBe(schemaChecksum(migration.sql))
        expect(legacy).not.toBe(rawChecksum(migration.sql))
      }
    }
  })

  /**
   * 剥注释必须按词法做。
   *
   * 迁移里有 5 处 SQL 字符串字面量内部含 `--`（v2/v4/v5/v7，形如 `',     -- '`），
   * 一个 `replace(/--.*$/gm, "")` 会把字面量从中间截断 → 产出语法不合法的 SQL。
   * 而它只在「恰好有这种字面量」的迁移上出错，看起来像随机失败。
   */
  it("字符串字面量与引号标识符里的注释符不被剥掉", () => {
    const sql = [
      "CREATE TABLE t (",
      "  a TEXT DEFAULT '-- 这不是注释',   -- 这才是注释",
      "  b TEXT DEFAULT 'x /* 也不是 */ y',",
      '  "c--d" INTEGER,',
      "  e TEXT DEFAULT 'it''s -- fine'",
      ");",
    ].join("\n")
    const stripped = stripSqlComments(sql)

    expect(stripped).toContain("'-- 这不是注释'")
    expect(stripped).toContain("'x /* 也不是 */ y'")
    expect(stripped).toContain('"c--d"')
    expect(stripped).toContain("'it''s -- fine'")
    expect(stripped).not.toContain("这才是注释")

    // 剥完仍是合法 SQL，且列一个不少
    const db = new Database(":memory:")
    db.exec(stripped)
    expect(
      db
        .prepare<[], { name: string }>("PRAGMA table_info(t)")
        .all()
        .map((row) => row.name),
    ).toEqual(["a", "b", "c--d", "e"])
    db.close()
  })

  it("空白重排也不算改迁移（缩进调整不该打挂已有库）", () => {
    const migrations: Migration[] = [
      { version: 1, name: "init", sql: "CREATE TABLE a (x INTEGER, y TEXT);" },
    ]
    const db = new Database(":memory:")
    runMigrations(db, { migrations })

    const reindented: Migration[] = [
      { version: 1, name: "init", sql: "CREATE  TABLE a (\n  x INTEGER,\n  y TEXT\n);\n" },
    ]
    expect(() => runMigrations(db, { migrations: reindented })).not.toThrow()
    // 但加一列仍然报错
    const changed: Migration[] = [
      { version: 1, name: "init", sql: "CREATE TABLE a (x INTEGER, y TEXT, z REAL);" },
    ]
    expect(() => runMigrations(db, { migrations: changed })).toThrow(/已发布的迁移不可修改/)
    db.close()
  })

  /**
   * ★ 规范化不许伸进字符串字面量。
   *
   * 「去掉 `(),;` 两侧空白」这条规则如果用正则对剥完注释的结果跑，就会把
   * `DEFAULT 'a, b'` 与 `DEFAULT 'a,b'` 算成同一个 hash —— 那是两个**不同的
   * 默认值**，把它们判成相同等于漏掉一次真实的 schema 改动。
   */
  it("字面量内部的空白算 schema 的一部分（'a, b' ≠ 'a,b'）", () => {
    const withSpace = "CREATE TABLE a (x TEXT DEFAULT 'a, b');"
    const withoutSpace = "CREATE TABLE a (x TEXT DEFAULT 'a,b');"
    expect(schemaChecksum(withSpace)).not.toBe(schemaChecksum(withoutSpace))

    // 而字面量**外部**的空白仍然该被忽略
    expect(schemaChecksum(withSpace)).toBe(
      schemaChecksum("CREATE  TABLE a (\n  x TEXT DEFAULT 'a, b'\n) ;"),
    )
  })

  it("当前清单里每条迁移的 schemaChecksum 互不相同（规范化没把不同 SQL 折成同一个）", () => {
    /**
     * 防的是规范化写坏的一类形态：比如先折空白再剥注释，会让 `--` 之后的
     * 全部内容被当注释吃掉 —— 于是所有迁移算出同一个 hash。那**不报错**，
     * 只是让校验彻底失效。
     */
    const checksums = VAULT_MIGRATIONS.map((migration) => schemaChecksum(migration.sql))
    expect(new Set(checksums).size).toBe(VAULT_MIGRATIONS.length)
    // 规范化后仍是非空的实际 SQL，不是被吃空了
    for (const migration of VAULT_MIGRATIONS) {
      expect(stripSqlComments(migration.sql)).toMatch(/CREATE|ALTER|UPDATE|INSERT|DELETE/)
    }
  })
})
