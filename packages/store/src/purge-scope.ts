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
import type { CollectionRequest } from "./collection-request.js"

/**
 * 清理的判据 —— ★★★ 是**采集面**（学习 ∪ 监听），不是学习范围。
 *
 * ## 为什么这一处必须换（v4 §3.3；漏了它是一个真的删数据的 bug）
 *
 * DWD 只打标不筛行之后，库里**故意**留着一类行：
 * 「只因监听范围而入库的」（`learning_eligible = 0`）。它们是分身要盯的
 * 新消息，而它们**本来就不在学习白名单里**。
 *
 * 而这个函数原来拿**学习范围**当判据 —— 于是它会把那些行判成"越界"
 * 并**真删**（连带 FTS / 向量 / 媒体）。表现：用户监听的那个群，
 * 每次保存一次范围就被清空一次，而分身随即失去上下文。**且不报错。**
 *
 * 判据换成采集面之后语义才自洽：**"我们本就不该去拉的"才叫越界**
 * —— 那与 `readCollectionRequest` 是同一句话，也是唯一真正的隐私边界。
 */
export type PurgeCriterion = Pick<
  CollectionRequest,
  "restricted" | "allow" | "attentionScoped" | "since" | "until"
>

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
  scope: PurgeCriterion,
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
  /**
   * ★ 片段与它的参数**成对**推进同一个数组。
   *
   * 原来是 `timeClauses` / `timeParams` 两个数组、最后按顺序拼 ——
   * 而上界那一格现在要多带一串 `NOT IN` 参数，两数组的写法就要求
   * "记得把它插在正确的位置"。占位符错位在 SQLite 里**不报错**
   * （类型是动态的），它只会静默地拿会话 id 去比 `sent_at`：
   * 于是清理条件变成恒假或恒真 —— 后者会删掉全部消息。
   */
  const timeParts: { clause: string; params: unknown[] }[] = []
  if (typeof scope.since === "number") {
    timeParts.push({ clause: "m.sent_at < ?", params: [scope.since] })
  }
  if (scope.until !== undefined) {
    /**
     * ★★★ 上界**只卡"不是只因监听而在面内"的那些会话**。
     *
     * ★ 判据是"**在**监听范围里"，不是"只在监听范围里" —— 一个既学也盯的
     * 会话（默认形态）同样要豁免。见 `attentionScoped` 的注释。
     *
     * 与 `isWithinCollectionWindow` 完全同一条判据（那是前向闸，这是回溯清理，
     * 两处必须同口径 —— 不同口径的方向是"闸放进来的行被清理删掉"，
     * 于是采集与清理互相拆台，每轮都在删刚采的）。
     *
     * 具体形态：用户选「学到 7 月 30 日」，同时让分身盯着某个群。
     * 那个群 8 月的新消息**该留**（用户的两个选择都没要求删它），
     * 而不带这个例外的话它们全部命中 `sent_at > until` → 被删。
     */
    const watched = [...scope.attentionScoped]
    timeParts.push(
      watched.length === 0
        ? { clause: "m.sent_at > ?", params: [scope.until] }
        : {
            clause:
              `(m.sent_at > ? AND c.external_id NOT IN` + ` (${watched.map(() => "?").join(",")}))`,
            params: [scope.until, ...watched],
          },
    )
  }

  /**
   * 三类越界取**并集**：会话不在白名单里、或时间早于下界、或晚于上界。
   * 用 OR 而不是分三趟删：一条消息可能同时命中两类，分趟会重复计数。
   */
  const predicates = [outOfScopeClause, ...timeParts.map((part) => part.clause)]
  const where = predicates.length === 1 ? predicates[0] : predicates.join(" OR ")
  const params: unknown[] = [channelId, ...allow, ...timeParts.flatMap((part) => part.params)]

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

/** 文档侧的清理报告。★ 与消息那份分开：派生物完全不同（见下）。 */
export interface DocumentPurgeReport {
  /** 删掉（或将要删掉）的文档篇数 */
  documents: number
  /** 涉及的空间数 */
  spaces: number
  /** 删掉的覆盖面记账行数 */
  coverageRows: number
  dryRun: boolean
}

/**
 * 清掉**越界文档**（不在空间白名单里、或超出时间范围的）。
 *
 * ## ★★★ 为什么这个函数必须与"加空间白名单"同时做
 *
 * 前向的范围闸只保证"从现在起不再采越界的"。而用户**第一次收窄空间**时，
 * 库里已有的越界文档**不会消失** —— 于是：
 *
 * · 配置说"只学 3 个知识库"，而库里有 7 个知识库的文档；
 * · 那些文档已经进了 changelog → 进了图谱与画像语料。
 *
 * `purge-scope.ts` 的文件头对消息写过同一句话（"只修前向路径不够"），
 * 而那条判据对文档**同样成立**。半个隐私修复比没修更糟：用户以为
 * 收窄生效了。
 *
 * ## ★★ 派生物清单（这是与消息侧唯一的实质差别）
 *
 * 我逐个核对过 `documents` 的下游：
 *
 * | 派生物 | 怎么处理 |
 * |---|---|
 * | `document_coverage` | **必须显式删** —— 它按 `(channel_id, space, day)` 独立主键，**没有** FK 指向 documents，所以 cascade 覆盖不到 |
 * | FTS 索引 | **不存在** —— `messages_fts` 只索引消息（v5-search），文档没有对应虚表 |
 * | 向量 | **不存在** —— `message_vectors` 只挂消息 |
 * | changelog 里的 `doc` 行 | **不删** —— 那是 append-only 的变更日志，删它会让消费者的 `acked_seq` 指向空洞。它由 `RetentionRunner` 按保留策略裁 |
 *
 * ★ 只有第一项需要动手，而它恰恰是**最容易漏**的那种（没有 FK 保护、
 * 漏了不报错，表现是"覆盖面说这天有 12 篇、库里 0 篇"）。
 *
 * @param scope 当前**文档域**的范围（`readDomainScope(db, "doc")`）。
 * @param options.dryRun 只数不删。
 */
export function purgeOutOfScopeDocuments(
  db: SqliteDatabase,
  channelId: string,
  scope: Pick<CollectionScope, "restricted" | "allow" | "since" | "until">,
  options: { dryRun?: boolean } = {},
): DocumentPurgeReport {
  const dryRun = options.dryRun === true
  const empty: DocumentPurgeReport = { documents: 0, spaces: 0, coverageRows: 0, dryRun }

  /**
   * ★★ 空间白名单 + 时间窗，两个条件**并列**（不是嵌套）。
   *
   * 这一条与 `admitByScope` 是同一个教训：把时间闸包在
   * `if (scope.restricted)` 里面，会让「配了 since、没配白名单」这个组合下
   * `since` 完全失效 —— 而那正是非主渠道的真实形状。
   */
  const clauses: string[] = []
  const params: unknown[] = [channelId]

  const allow = [...scope.allow]
  if (scope.restricted) {
    /**
     * ★ `COALESCE(workspace_id, '')`：散落的云盘文件没有空间概念，
     * 库里那一列是 NULL。而白名单里对应的是空串（与 `admitByScope` 的
     * `item.workspaceId ?? ""` 同一个判据）—— 两处不一致会让那些文件
     * 要么永远被删、要么永远删不掉。
     */
    clauses.push(
      allow.length === 0
        ? "1 = 1"
        : `COALESCE(workspace_id, '') NOT IN (${allow.map(() => "?").join(",")})`,
    )
    params.push(...allow)
  }
  /**
   * ★★ 业务时间用 `COALESCE(updated_at, created_at, fetched_at)` ——
   * 与 `toDocumentChangelogEntry` 的 `occurredAt` 以及
   * `document_coverage.rebuildFromDocuments` 的分桶**同一个判据**。
   *
   * 三处漂了的话，"闸门放行的""覆盖面记账的""这里删掉的"会是三批不同的行，
   * 而三边的数字都"看起来对"。
   */
  const occurredAt = "COALESCE(updated_at, created_at, fetched_at)"
  if (typeof scope.since === "number") {
    clauses.push(`${occurredAt} < ?`)
    params.push(scope.since)
  }
  if (scope.until !== undefined) {
    clauses.push(`${occurredAt} > ?`)
    params.push(scope.until)
  }

  /**
   * ★ 一个条件都没有 = 不设限 → 直接返回空报告。
   *
   * 与消息那侧同一条：不设限时"越界"**没有定义**，此时删任何东西都是错的。
   */
  if (clauses.length === 0) return empty

  const where = clauses.join(" OR ")
  const victims = db
    .prepare<
      unknown[],
      { id: string; space: string }
    >(`SELECT id, COALESCE(workspace_id, '') AS space FROM documents WHERE channel_id = ? AND (${where})`)
    .all(...params)

  if (victims.length === 0) return empty

  const spaces = new Set(victims.map((row) => row.space))
  /**
   * ★ 覆盖面行数**先数出来**（在删之前）：删完再数会得到 0，
   * 而 dryRun 与真删必须报同一个数字 —— 否则"预演说删 3 行、
   * 实际删了 3 万行"那类事故就有了空间。
   */
  const coverageRows = countCoverageRows(db, channelId, spaces, scope)
  const report: DocumentPurgeReport = {
    documents: victims.length,
    spaces: spaces.size,
    coverageRows,
    dryRun,
  }
  if (dryRun) return report

  withTransaction(db, () => {
    const ids = victims.map((row) => row.id)
    const CHUNK = 500
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK)
      const ph = chunk.map(() => "?").join(",")
      db.prepare(`DELETE FROM documents WHERE id IN (${ph})`).run(...chunk)
    }
    /**
     * ★★★ 覆盖面行**必须显式删** —— 它没有 FK 指向 documents。
     *
     * 漏掉的表现：界面说"这个空间 8 月 12 日有 12 篇"，而库里 0 篇 ——
     * 一个永远追不平的进度（`local_count` 是累加的，删了实体也不会回退）。
     */
    for (const space of spaces) {
      db.prepare(
        "DELETE FROM document_coverage WHERE channel_id = ? AND space_external_id = ?",
      ).run(channelId, space)
    }
  })

  return report
}

/** 数一下这些空间在覆盖面表里有多少行（dryRun 与真删共用，避免两个数字）。 */
function countCoverageRows(
  db: SqliteDatabase,
  channelId: string,
  spaces: ReadonlySet<string>,
  _scope: Pick<CollectionScope, "restricted">,
): number {
  if (spaces.size === 0) return 0
  const ph = [...spaces].map(() => "?").join(",")
  try {
    return (
      db
        .prepare<
          unknown[],
          { c: number }
        >(`SELECT count(*) AS c FROM document_coverage WHERE channel_id = ? AND space_external_id IN (${ph})`)
        .get(channelId, ...spaces)?.c ?? 0
    )
  } catch {
    /**
     * ★ 表不存在（v29 之前的库）→ 报 0 而不是抛：这个数字是**观测量**，
     * 而删文档是正事。抛错会让一次正确的隐私清理整个失败。
     */
    return 0
  }
}
