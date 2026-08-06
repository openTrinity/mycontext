/**
 * 越界数据清理：把**不在用户勾选范围内**的消息及其派生物从库里删掉。
 *
 * ## 为什么需要它（只修前向路径不够）
 *
 * 前向的范围闸（`persist()` 里那道）只保证"从现在起不再采越界的"。
 * 而实测这台机器**已经**存了 46,415 条越界消息（占 55%）与 46,365 行
 * 越界 FTS 索引 —— 只修前向等于把已经发生的那次违规永久留在盘上。
 *
 * 用户改勾选（把某个会话取消）时也走这里：那时"越界"是刚刚才产生的，
 * 而用户的预期显然是"我取消了，它就不该再在里面"。
 *
 * ## ★ FK cascade 覆盖不到 FTS 虚表
 *
 * `messages` 上挂着一串 `ON DELETE CASCADE`（`message_vectors`、
 * `media_assets`、`messages_fts_state`、persona 的几张表…），而 pragma
 * `foreign_keys = ON` 是开着的（`database.ts:292`），所以删 `messages`
 * 行会自动带走它们。
 *
 * 但 **`messages_fts` 是 FTS5 虚表，不是普通表，FK 对它无效** ——
 * cascade 删掉 `messages_fts_state` 之后，`messages_fts` 里那一行会**留下**，
 * 而它存的正是可检索的内容。表现是：消息删了、状态行删了，可搜索的正文
 * 还在索引里，且 `messages_fts_state` 那一侧已经没有行能指向它，
 * 于是再也没有任何代码能把它清掉（`FtsIndexRepository.remove` 靠
 * state 表查 rowid）。所以**必须在删 messages 之前**先按 rowid 删虚表行。
 *
 * 顺序在下面的实现里是硬约束，不是风格问题。
 *
 * ## 为什么可以预演
 *
 * 删真实聊天记录不可逆。`dryRun: true` 时只数不删，让调用方（脚本 / UI）
 * 能先把数字给人看。两条路径共用同一段 SQL 判据 —— 各写一份必然漂，
 * 而漂的方向是"预演说删 3 条、实际删了 3 万条"。
 */
import { withTransaction } from "./tx.js"
import type { SqliteDatabase } from "./database.js"
import { type CollectionScope } from "./collection-scope.js"

export interface PurgeReport {
  /** 删掉（或将要删掉）的消息条数 */
  messages: number
  /** 涉及的会话数 */
  conversations: number
  /** 删掉的 FTS 索引行数 */
  ftsRows: number
  /** 删掉的向量行数 */
  vectors: number
  /** 删掉的媒体元数据行数 */
  mediaAssets: number
  /** 媒体**文件**（已下字节的）待删路径。删文件不在这一层做，见下 */
  mediaPaths: string[]
  /** 是否只是预演 */
  dryRun: boolean
}

/**
 * 清掉越界消息。
 *
 * @param scope 当前范围。`restricted === false`（不限）时直接返回空报告 ——
 *   不设限时"越界"没有定义，此时删任何东西都是错的。
 * @param options.dryRun 只数不删。
 *
 * ## 媒体文件为什么只返回路径而不删
 *
 * `store` 这一层不碰文件系统（它的全部测试都只需要一个内存库）。
 * 而媒体字节是真实文件，删它需要知道 vault 的落点 —— 那是 apps 侧的知识。
 * 所以这里把路径交出去，由调用方删；漏删的后果是磁盘上留几个孤儿文件
 * （可观测、可再清），而在这一层引入 fs 依赖的后果是整个 store 包的
 * 测试都要有真实目录。
 */
export function purgeOutOfScopeMessages(
  db: SqliteDatabase,
  channelId: string,
  scope: CollectionScope,
  options: { dryRun?: boolean } = {},
): PurgeReport {
  const dryRun = options.dryRun === true
  const empty: PurgeReport = {
    messages: 0,
    conversations: 0,
    ftsRows: 0,
    vectors: 0,
    mediaAssets: 0,
    mediaPaths: [],
    dryRun,
  }
  // 不设限时"越界"无定义 —— 什么都不该删。
  if (!scope.restricted) return empty

  const allow = [...scope.allow]
  /**
   * 越界判据。白名单为空（用户一个都没勾 / 源关了）时**全部越界** ——
   * 此时不能拼 `NOT IN ()`：SQLite 对空 IN 列表的处理会让条件恒为真/假，
   * 而具体是哪个取决于写法。用一个显式的 `1=1` 分支，不依赖那个细节。
   */
  const outOfScopeClause =
    allow.length === 0 ? "1 = 1" : `c.external_id NOT IN (${allow.map(() => "?").join(",")})`

  /**
   * ★ 时间范围也要卡。
   *
   * 用户把下界从 180 天改到 30 天之后，30 天之前的消息同样是"越界"。
   * 只按会话清会留下一段用户已经明确排除掉的历史，而画像仍在吃它。
   *
   * `since === null`（显式不限）与 `undefined`（没配过）都不卡。
   */
  const timeClauses: string[] = []
  const timeParams: number[] = []
  if (typeof scope.since === "number") {
    timeClauses.push("m.sent_at < ?")
    timeParams.push(scope.since)
  }
  if (scope.until !== undefined) {
    timeClauses.push("m.sent_at > ?")
    timeParams.push(scope.until)
  }

  /**
   * 三类越界取**并集**：会话不在白名单里、或时间早于下界、或晚于上界。
   * 用 OR 而不是分三趟删：一条消息可能同时命中两类，分趟会重复计数。
   */
  const predicates = [outOfScopeClause, ...timeClauses]
  const where = predicates.length === 1 ? predicates[0] : predicates.join(" OR ")
  const params: unknown[] = [channelId, ...allow, ...timeParams]

  const selectIds = `
    SELECT m.id AS id, m.conversation_id AS conversation_id
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
     WHERE c.channel_id = ? AND (${where})`

  const victims = db
    .prepare<unknown[], { id: string; conversation_id: string }>(selectIds)
    .all(...params)
  if (victims.length === 0) return empty

  const ids = victims.map((row) => row.id)
  const report: PurgeReport = {
    ...empty,
    messages: ids.length,
    conversations: new Set(victims.map((row) => row.conversation_id)).size,
  }

  /**
   * 分批：SQLite 的 `SQLITE_MAX_VARIABLE_NUMBER` 默认 32766（新版）/999（旧版）。
   * 4.6 万条一次性拼进 IN 列表会直接报错，而那个错在"清理"这种一次性
   * 操作里很容易被当成"清不了"而放弃。
   */
  const CHUNK = 500
  const chunks: string[][] = []
  for (let index = 0; index < ids.length; index += CHUNK) {
    chunks.push(ids.slice(index, index + CHUNK))
  }

  const countIn = (table: string, column: string, chunk: string[]): number => {
    const ph = chunk.map(() => "?").join(",")
    return (
      db
        .prepare<
          string[],
          { c: number }
        >(`SELECT count(*) AS c FROM ${table} WHERE ${column} IN (${ph})`)
        .get(...chunk)?.c ?? 0
    )
  }

  for (const chunk of chunks) {
    const ph = chunk.map(() => "?").join(",")
    report.ftsRows += countIn("messages_fts_state", "message_id", chunk)
    report.vectors += countIn("message_vectors", "message_id", chunk)
    report.mediaAssets += countIn("media_assets", "message_id", chunk)
    const paths = db
      .prepare<
        string[],
        { path: string | null }
      >(`SELECT path FROM media_assets WHERE message_id IN (${ph}) AND path IS NOT NULL`)
      .all(...chunk)
    for (const row of paths) {
      if (row.path !== null) report.mediaPaths.push(row.path)
    }
  }

  if (dryRun) return report

  withTransaction(db, () => {
    for (const chunk of chunks) {
      const ph = chunk.map(() => "?").join(",")
      /**
       * ★★ 顺序是硬约束：**先**删 FTS 虚表行，**再**删 messages。
       *
       * 反了的话 cascade 会先带走 `messages_fts_state`，而虚表里那些行
       * 就永久失去了唯一的 rowid 来源（见文件头）—— 可检索的正文留在
       * 索引里，而没有任何代码再能删掉它。
       */
      const rowids = db
        .prepare<
          string[],
          { rowid_alias: number }
        >(`SELECT rowid_alias FROM messages_fts_state WHERE message_id IN (${ph})`)
        .all(...chunk)
      const deleteFts = db.prepare("DELETE FROM messages_fts WHERE rowid = ?")
      for (const row of rowids) deleteFts.run(row.rowid_alias)

      /**
       * `messages` 一删，下面这些靠 FK cascade 自动走：
       * `messages_fts_state` / `message_vectors` / `media_assets` /
       * `dh_message_judgements` / `dh_drafts` … （见各自的迁移 DDL）。
       *
       * 不显式删它们是刻意的：显式列一份等于把 FK 关系抄第二遍，
       * 而将来加一张挂 cascade 的表时这里不会跟着改（然后留下孤儿行）。
       */
      db.prepare(`DELETE FROM messages WHERE id IN (${ph})`).run(...chunk)
    }
  })

  return report
}
