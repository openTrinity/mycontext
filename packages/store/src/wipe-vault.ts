/**
 * 把一个 vault 清回「刚登录完、还没采过」的状态。
 *
 * ## ★★ 为什么在 store 层，而不是留在脚本里
 *
 * 这段逻辑原来只存在于 `scripts/reset-vault.mjs`。现在设置页也要能做同一件事
 * （用户点「清空当前渠道的数据」），而下面有**三条硬约束**：抄第二份必然漂，
 * 且漂的后果全是静默的数据损坏（不是报错）。所以判据只留一份，两个入口都调它。
 *
 * ## ★★★ 三条硬约束（每条都对应一次实测到的静默损坏）
 *
 * ① **`messages_fts` 必须最先删。** 它是 contentless FTS5 虚表，rowid 映射在
 *    `messages_fts_state`。后者挂 `ON DELETE CASCADE`，而**虚表没有** ——
 *    先删 `messages` 的话映射先被级联清空，虚表里那 8 万多行就**永远删不掉**了
 *    （实测：删完 messages 后 `messages_fts` 仍剩 84,133 行而 state 已清零）。
 *    表现是"搜得到已经删掉的聊天内容"，且没有任何代码还能清它。
 *
 * ② **`knowledge_changelog` 的 AUTOINCREMENT 与消费者游标必须一起清零。**
 *    所有消费者游标都指向那个 seq。只清表而重置序列却不清游标的话，新数据
 *    从 seq=1 开始却低于游标（实测 85,395）→ **所有消费者永久跳过全部新数据**。
 *    表现是采集在涨、而索引/蒸馏/图谱永远收不到东西。
 *
 * ③ **外键要显式打开。** better-sqlite3 默认 `foreign_keys = OFF`，不开的话
 *    级联不发生，`dh_inbox` 那 4 万行会变成孤儿。
 *
 * ## 保留什么（不保留就等于"退出登录 + 重新勾一遍"）
 *
 * · `channel_self_identity` —— 本人身份与 `confirmed_at`。删了会让蒸馏
 *   **拒掉全部语料**（那是一道刻意的闸），且要重走确认流程；
 * · `distill_sources` 的 `scope_json` / `enabled` —— 用户勾的会话与时间下界。
 *   删了等于让他重新勾一遍（实测这台机器 72 个会话）。只清水位；
 * · `onboarding_progress` / `vault_settings` —— 引导进度与偏好；
 * · `search_chat_*` / `sr_*` —— 用户**自己手打**的搜索提问历史。它不是采集来的
 *   数据，"清空聊天记录"不该顺手删掉用户问过的问题。要删得显式传 `dropSearch`。
 *
 * 也就是：**清数据，不清「你是谁」和「你选了什么」**。要连这些一起清，
 * 正确做法是删整个 vault 目录（那时应用会当成新账号，重新登录即可）。
 *
 * ## 文件产物不在这一层删
 *
 * `kl/`、`exports/`、`forge/`、`media/`、`avatars/` 都是真实文件，而 store 这一层
 * 不碰文件系统（它的全部测试只需要一个内存库）。所以这里只清库并把
 * 「该删哪些目录」交给调用方 —— 与 `purgeOutOfScopeMessages` 返回
 * `mediaPaths` 是同一条分工。
 */
import type { SqliteDatabase } from "./database.js"

/**
 * 要清空的表 —— **顺序有意义**（见文件头 ①）。
 *
 * 列成显式清单而不是"遍历 sqlite_master 再排除"：新增一张表时，遍历式会
 * **默认清掉**它（可能是配置表或凭据表），而清单式最多是漏清一张数据表。
 * 前者是不可逆的数据损失，后者只是少做了一点事 —— 两种错都会发生，
 * 选后果小的那个。
 */
export const VAULT_DATA_TABLES: readonly string[] = [
  // ★★ 必须最先：contentless 虚表，趁 rowid 映射还在（文件头 ①）
  "messages_fts",

  // 派生索引（都挂 FK CASCADE，但显式删更直观、也不依赖 pragma 生效）
  "messages_fts_state",
  "message_vectors",
  "vector_failures",

  // 数字人侧的运行痕迹
  "dh_inbox",
  "dh_run_trace",
  "dh_drafts",
  "dh_send_attempts",
  "dh_send_grants",
  "dh_agent_runs",
  "dh_agent_sessions",

  // 蒸馏产物与任务（画像可从语料重建，而语料正在被清）
  "distill_tasks",
  "profile_facet_revisions",
  "profile_facets",
  "profile_materializations",
  "profile_snapshots",

  // 语料本体
  "message_mentions",
  "media_assets",
  "messages",
  "minutes",
  "documents",
  "raw_records",

  // ★ conversations 在 messages 之后：前者是后者的 FK 父表
  "conversations",
  "actors",
  "contact_avatars",

  // 探针快照
  "probe_snapshots",

  // Outbox。★ 与消费者游标一起清（文件头 ②）
  "knowledge_changelog",
]

/**
 * 用户手打的搜索对话 —— **默认保留**（见文件头「保留什么」）。
 */
export const VAULT_SEARCH_TABLES: readonly string[] = [
  "sr_citations",
  "sr_search_runs",
  "sr_saved_queries",
  "search_chat_attachments",
  "search_chat_messages",
  "search_chat_sessions",
]

export interface WipeVaultReport {
  /** 每张表清掉（或将要清掉）的行数。表不存在时不出现在这里 */
  rows: Record<string, number>
  /** 合计行数 */
  totalRows: number
  /** 库里存过的媒体/头像**文件**路径 —— 由调用方删（见文件头） */
  filePaths: string[]
  /** FTS 自检结果：null = 跳过（库里没这张表）；否则是通过与否 */
  ftsIntegrityOk: boolean | null
  /** FTS 自检的失败原因 */
  ftsError: string | null
  dryRun: boolean
}

export interface WipeVaultOptions {
  /** 只数不删 */
  dryRun?: boolean
  /** 连用户自己的搜索提问历史一起清（默认不清） */
  dropSearch?: boolean
  /** 当前时间（unix ms）。显式传，不读 `Date.now()` —— 便于测试可复现 */
  now: number
}

/**
 * 清空 vault 的数据表。**不碰文件系统**（见文件头）。
 *
 * 全部动作在**一个事务**里：半清状态比不清更糟 —— `messages` 空了而
 * `conversations` 还在、或 Outbox 清了而游标没清（= 静默丢全部新数据，
 * 文件头 ②）。一个事务保证"要么回到干净起点，要么什么都没变"。
 */
export function wipeVaultData(db: SqliteDatabase, options: WipeVaultOptions): WipeVaultReport {
  const dryRun = options.dryRun === true
  const tables =
    options.dropSearch === true ? [...VAULT_DATA_TABLES, ...VAULT_SEARCH_TABLES] : VAULT_DATA_TABLES

  const exists = (name: string): boolean =>
    (db
      .prepare<
        [string],
        { c: number }
      >("SELECT count(*) AS c FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
      .get(name)?.c ?? 0) > 0

  const rows: Record<string, number> = {}
  let totalRows = 0
  for (const name of tables) {
    if (!exists(name)) continue
    const count = db.prepare<[], { c: number }>(`SELECT count(*) AS c FROM ${name}`).get()?.c ?? 0
    rows[name] = count
    totalRows += count
  }

  /**
   * 媒体与头像的**文件**路径。库里存的是绝对路径，行删了而文件留着就是
   * 一堆再也没有行指向它们的孤儿（实测 14MB + 688KB）。所以在删行**之前**
   * 先把路径读出来交给调用方。
   *
   * ★ 两张表的列名**不同**（`media_assets.path` / `contact_avatars.local_path`）
   * —— 照着其中一个写另一个会在运行时抛 `no such column`，而这个函数是
   * 「清空数据」的唯一入口，抛在这里等于按钮整个不可用。所以逐表显式写。
   */
  const filePaths: string[] = []
  for (const [table, column] of [
    ["media_assets", "path"],
    ["contact_avatars", "local_path"],
  ] as const) {
    if (!exists(table)) continue
    const found = db
      .prepare<
        [],
        { path: string | null }
      >(`SELECT ${column} AS path FROM ${table} WHERE ${column} IS NOT NULL`)
      .all()
    for (const row of found) {
      if (row.path !== null && row.path !== "") filePaths.push(row.path)
    }
  }

  if (dryRun) {
    return { rows, totalRows, filePaths, ftsIntegrityOk: null, ftsError: null, dryRun }
  }

  // ★ 文件头 ③：默认是 OFF，不开的话级联不发生
  db.pragma("foreign_keys = ON")

  const wipe = db.transaction(() => {
    for (const name of tables) {
      if (!exists(name)) continue
      db.prepare(`DELETE FROM ${name}`).run()
    }

    /**
     * ★ Outbox 的 AUTOINCREMENT 与消费者游标**一起**归零（文件头 ②）。
     *
     * 两者都要做：只重置序列 → 新 seq=1 低于旧游标 → 全部新数据被静默跳过；
     * 只清游标 → 新 seq 从旧位置继续，功能正确但数字难看。
     *
     * ★ `sqlite_sequence` 只在库里**存在** AUTOINCREMENT 表时才被创建，
     * 残缺/半迁移的库上它可能不在（硬删会抛 `no such table`，实测）。
     * 下面几张同理逐个判断：这个函数要能在一个不完整的库上**如实做完能做的
     * 部分**，而不是抛一个栈把调用方留在"删了一半"的状态。
     */
    if (exists("sqlite_sequence")) {
      db.prepare("DELETE FROM sqlite_sequence WHERE name = 'knowledge_changelog'").run()
    }
    if (exists("consumer_cursors")) {
      db.prepare(
        `UPDATE consumer_cursors
            SET acked_seq = 0, last_error = NULL, last_success_at = NULL,
                needs_full_rebuild = 0, lease_owner = NULL, lease_expires_at = NULL,
                updated_at = ?`,
      ).run(options.now)
    }

    /**
     * 采集水位清零。不清的话下一轮从"当下"往后采，而库里已经没有历史了
     * —— 回溯只在 `watermark === 0` 时才启动。
     */
    if (exists("sync_cursors")) {
      db.prepare(
        `UPDATE sync_cursors
            SET watermark = 0, cursor = NULL, window_start = NULL, window_end = NULL,
                page_count = 0, truncated = 0, status = 'idle', last_error = NULL,
                attempts = 0, updated_at = ?`,
      ).run(options.now)
    }

    /**
     * 蒸馏水位清零，但**保留 `scope_json` 与 `enabled`** —— 那是用户勾选的
     * 范围，清了等于让他重新勾一遍（见文件头「保留什么」）。
     */
    if (exists("distill_sources")) {
      db.prepare(
        `UPDATE distill_sources
            SET last_synced_seq = 0, state = 'idle', last_error = NULL, updated_at = ?`,
      ).run(options.now)
    }
  })
  wipe()

  /**
   * FTS 自检：contentless 表被清空后 rowid 空间应当是干净的。
   *
   * 主动查一次而不是假定成功 —— 失配是**静默故障**（搜不到但不报错）。
   * 表不存在时报 `null`（跳过）而不是 `true`：如实区分"验过了"与"没验"。
   */
  let ftsIntegrityOk: boolean | null = null
  let ftsError: string | null = null
  if (exists("messages_fts")) {
    try {
      db.prepare("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')").run()
      ftsIntegrityOk = true
    } catch (error) {
      ftsIntegrityOk = false
      ftsError = error instanceof Error ? error.message : String(error)
    }
  }

  return { rows, totalRows, filePaths, ftsIntegrityOk, ftsError, dryRun }
}
