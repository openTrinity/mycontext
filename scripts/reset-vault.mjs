#!/usr/bin/env node
/**
 * 把一个 vault **清空到"刚登录完、还没采过"的状态**。
 *
 * ## 与 `reset-watermark.mjs` / 界面上「重新蒸馏」的区别
 *
 * 那两个都**不删数据**：
 * · `reset-watermark.mjs` 只清 `sync_cursors`，让下一轮重新采（数据靠幂等键去重）；
 * · 界面「重新蒸馏」只清 `distill_sources.last_synced_seq` + `distill_tasks`，
 *   刻意保留已有 facet（合并式更新，删了会丢掉人工确认过的结论）。
 *
 * 这个脚本是**真的删**：消息、会话、原始记录、Outbox、图谱库、forge 派生库、
 * 导出目录、媒体与头像文件。用在"数据脏了/结构变了，要从零重来一遍"的时候。
 *
 * ## ★★ 保留什么（不保留就得重新扫码登录）
 *
 * · `channels/`         —— 渠道凭据（token.json 等）。删了要重新授权；
 * · `channel_self_identity` —— 本人身份 + `confirmed_at`。删了会**拒绝蒸馏**
 *                          （那是一道刻意的闸），且要重新走确认流程；
 * · `distill_sources.scope_json` —— 用户勾的会话白名单与时间下界。
 *                          删了等于让用户重新勾一遍 92 个会话；
 * · `onboarding_progress` / `vault_settings` —— 引导进度与偏好。
 *
 * 也就是：**清数据，不清"你是谁"和"你选了什么"**。要连这些一起清就直接
 * 删整个 vault 目录（那时应用会当成新账号，重新登录即可）。
 *
 * ## ★ 三个必须按顺序做、否则会留下静默损坏的地方
 *
 * ① `messages_fts` 是 **contentless 虚表**，rowid 映射在 `messages_fts_state`。
 *    `messages_fts_state` 有 `ON DELETE CASCADE`，`messages_fts` **没有** ——
 *    先删 messages 的话映射先被级联清空，虚表里 8 万多行**永远删不掉**了
 *    （实测：删完 messages 后 `messages_fts` 仍剩 84133 行，而 state 已清零）。
 *    所以必须**先** `DELETE FROM messages_fts`，再删 messages。
 *
 * ② `knowledge_changelog.seq` 是 AUTOINCREMENT，而所有消费者游标都指向它。
 *    清表后若**重置** `sqlite_sequence` 而不清游标，新数据从 seq=1 开始，
 *    却低于游标（实测 85395）→ **所有消费者永久跳过全部新数据**（静默丢数据）。
 *    所以游标与序列必须**一起**清零。
 *
 * ③ 外键要显式打开（`PRAGMA foreign_keys=ON`）。better-sqlite3 默认是 OFF，
 *    不开的话级联不发生，`dh_inbox` 那 4 万行会变成孤儿。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/reset-vault.mjs --dry-run    # 只报告要删什么（默认建议先跑这个）
 * node scripts/reset-vault.mjs --yes        # 真的删
 * node scripts/reset-vault.mjs --yes --keep-media     # 保留已下载的媒体/头像文件
 * node scripts/reset-vault.mjs --yes --drop-search    # 一并删用户的搜索对话历史
 * node scripts/reset-vault.mjs --db <path>  # 指定 vault（默认取最近改动的那个）
 * ```
 *
 * ★ 不带 `--yes` 一律当 `--dry-run`：这个动作不可逆，不该因为敲错一次回车就发生。
 * ★ 应用必须**先退出**：库被 Electron 以 WAL 打开时删表会撞锁，
 *   而更糟的是删完之后内存里那些服务还持有旧状态。
 */
import { createRequire } from "node:module"
import { existsSync, readdirSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const require = createRequire(import.meta.url)
const Database = require("better-sqlite3")

const args = process.argv.slice(2)
const confirmed = args.includes("--yes")
const dryRun = !confirmed || args.includes("--dry-run")
const keepMedia = args.includes("--keep-media")
const dropSearch = args.includes("--drop-search")
const dbIndex = args.indexOf("--db")
const explicitDb = dbIndex === -1 ? null : args[dbIndex + 1]

/**
 * 要清空的表 —— **顺序有意义**（见文件头 ①）。
 *
 * 列成显式清单而不是"遍历所有表then排除"：新增一张表时，
 * 遍历式会**默认清掉**它（可能是配置表），而清单式最多是漏清一张数据表 ——
 * 前者是不可逆的数据损失，后者只是这个脚本少做了一点事。
 * 两种错都会发生，选后果小的那个。
 */
const DATA_TABLES = [
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

  // 蒸馏产物与任务（画像可从语料重建，语料正在被清）
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

  // 探针快照（含那个 last_msg_at=0 的毒丸行）
  "probe_snapshots",

  // Outbox。★ 与消费者游标一起清（文件头 ②）
  "knowledge_changelog",
]

/**
 * 用户手打的搜索对话 —— **默认保留**。
 *
 * 它不是采集来的数据，是用户自己的输入（提问历史）。"清空聊天记录"
 * 不该顺手删掉用户问过的问题。要删得显式加 `--drop-search`。
 */
const SEARCH_TABLES = [
  "sr_citations",
  "sr_search_runs",
  "sr_saved_queries",
  "search_chat_attachments",
  "search_chat_messages",
  "search_chat_sessions",
]

/** vault 目录下要删的**文件产物**（都能从库重建，或是纯缓存）。 */
function fileTargets(vaultDir) {
  const targets = [
    // 图谱库 + 抽取缓存。与 KlServerService.wipeGraphData 同一份清单。
    { path: join(vaultDir, "kl", "knowledge.db"), label: "kl/knowledge.db" },
    { path: join(vaultDir, "kl", "knowledge.db-shm"), label: "kl/knowledge.db-shm" },
    { path: join(vaultDir, "kl", "knowledge.db-wal"), label: "kl/knowledge.db-wal" },
    { path: join(vaultDir, "kl", "qdrant_data"), label: "kl/qdrant_data" },
    // ★ 不删这个的话下次建图会全部命中旧的（可能是空的）抽取结果
    { path: join(vaultDir, "kl", "extraction_cache"), label: "kl/extraction_cache" },
    // 四件套导出（GraphSync 下一轮会重新物化）
    { path: join(vaultDir, "exports", "dws"), label: "exports/dws" },
    // forge 的派生库与产物（含它自己那份 37270 条消息副本 + pulledThrough 水位）
    { path: join(vaultDir, "forge", "database"), label: "forge/database" },
    { path: join(vaultDir, "forge", "derived"), label: "forge/derived" },
    { path: join(vaultDir, "forge", "backups"), label: "forge/backups" },
  ]
  if (!keepMedia) {
    // 库里存的是绝对路径，行删了这些文件就成了孤儿 —— 一起清
    targets.push({ path: join(vaultDir, "media"), label: "media" })
    targets.push({ path: join(vaultDir, "avatars"), label: "avatars" })
  }
  return targets
}

function findVault() {
  if (explicitDb !== undefined && explicitDb !== null) return explicitDb
  const appSupport = join(homedir(), "Library", "Application Support")
  const candidates = []
  for (const appName of [
    "MyContextDevelop",
    "MyContextDev",
    "MyContext",
    "InklingsDevelop",
    "InklingsDev",
    "Inklings",
  ]) {
    const vaultsDir = join(appSupport, appName, "vaults")
    if (!existsSync(vaultsDir)) continue
    for (const entry of readdirSync(vaultsDir)) {
      const db = join(vaultsDir, entry, "core.sqlite")
      if (!existsSync(db)) continue
      // -wal 比主文件更能反映"刚刚还在写"（与 check-ingest-gap.mjs 同一个判据）
      const wal = `${db}-wal`
      const mtime = Math.max(statSync(db).mtimeMs, existsSync(wal) ? statSync(wal).mtimeMs : 0)
      candidates.push({ db, mtime })
    }
  }
  if (candidates.length === 0) {
    console.error("未找到任何 vault。先登录一次应用，或用 --db <path> 指定。")
    process.exit(1)
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0].db
}

const dbPath = findVault()
const vaultDir = join(dbPath, "..")

/**
 * 应用还开着吗 —— 用 kl 的 pidfile 探。
 *
 * 不是完美判据（kl 可能没起），但它能挡住最常见的那次事故：
 * 忘了退应用就跑这个脚本，删表撞 SQLITE_BUSY，而已经删掉的那部分不会回滚
 * （每张表一条 DELETE，不在一个事务里的话就是半清状态）。
 */
function appMaybeRunning() {
  const pidFile = join(vaultDir, "kl", "kl-server.pid")
  if (!existsSync(pidFile)) return false
  try {
    const { pid } = JSON.parse(require("node:fs").readFileSync(pidFile, "utf8"))
    if (typeof pid !== "number") return false
    process.kill(pid, 0) // 不发信号，只探活
    return true
  } catch {
    return false
  }
}

const db = new Database(dbPath)
db.pragma("foreign_keys = ON") // ★ 文件头 ③：默认是 OFF，级联不会发生

const tables = dropSearch ? [...DATA_TABLES, ...SEARCH_TABLES] : DATA_TABLES

function tableExists(name) {
  return (
    db
      .prepare(
        "SELECT count(*) AS c FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
      )
      .get(name).c > 0
  )
}

function countOf(name) {
  try {
    return db.prepare(`SELECT count(*) AS c FROM ${name}`).get().c
  } catch (error) {
    return `<读不出来: ${error instanceof Error ? error.message : String(error)}>`
  }
}

console.log(`vault: ${dbPath}`)
console.log(dryRun ? "模式: --dry-run（不做任何修改）\n" : "模式: 真删\n")

console.log("将清空的表：")
let totalRows = 0
for (const name of tables) {
  if (!tableExists(name)) {
    console.log(`  ${name.padEnd(28)} <表不存在，跳过>`)
    continue
  }
  const count = countOf(name)
  if (typeof count === "number") totalRows += count
  console.log(`  ${name.padEnd(28)} ${String(count)}`)
}

console.log("\n将删除的文件/目录：")
for (const target of fileTargets(vaultDir)) {
  console.log(`  ${target.label.padEnd(28)} ${existsSync(target.path) ? "存在" : "<不存在>"}`)
}

console.log("\n将保留（否则要重新登录/重新勾选）：")
console.log("  channels/                    渠道凭据")
console.log("  channel_self_identity        本人身份与 confirmed_at")
console.log("  distill_sources.scope_json   勾选的会话与时间下界（只清水位）")
console.log("  onboarding_progress          引导进度")
console.log("  vault_settings               偏好")
if (!dropSearch)
  console.log("  search_chat_*/sr_*           用户的搜索对话历史（--drop-search 可一并删）")
if (keepMedia) {
  console.log("  media/ avatars/              --keep-media 指定保留")
  /**
   * ★ 说清代价：`media_assets` / `contact_avatars` 里存的是**绝对路径**，
   * 表清了而文件留着 = 一堆再也没有行指向它们的孤儿文件（实测 14MB + 688KB）。
   * 重新采集时会按新的 id 重新下载，旧文件不会被复用也不会被清理。
   *
   * 仍然提供这个开关：重采几万条媒体很慢，排查问题时保留它们有价值。
   * 但"留下的是垃圾"这件事必须说出来，而不是让人以后自己发现。
   */
  console.log("    ⚠ 库里的路径行已被清空 —— 这些文件会成为孤儿（重采时重新下载，不复用）")
}

if (dryRun) {
  console.log(`\n合计 ${String(totalRows)} 行。加 --yes 才会真的执行。`)
  db.close()
  process.exit(0)
}

if (appMaybeRunning()) {
  console.error("\n✗ 检测到 kl-server 还在跑 —— 应用大概还开着。")
  console.error("  先退出应用再跑（库被占用时删表会半途失败，留下半清状态）。")
  db.close()
  process.exit(1)
}

/**
 * 全部动作在**一个事务**里。
 *
 * 半清状态比不清更糟：`messages` 空了而 `conversations` 还在、
 * 或者 Outbox 清了而游标没清（= 静默丢全部新数据，文件头 ②）。
 * 一个事务保证"要么回到干净起点，要么什么都没变"。
 *
 * 文件删除放在事务**之后**：文件系统不参与事务，先删文件再回滚 SQL
 * 会得到"库说有图、文件没了"的不一致。
 */
const wipe = db.transaction(() => {
  for (const name of tables) {
    if (!tableExists(name)) continue
    db.prepare(`DELETE FROM ${name}`).run()
  }

  /**
   * ★ Outbox 的 AUTOINCREMENT 与消费者游标一起归零（文件头 ②）。
   *
   * 顺序无关紧要（同一事务），但**两者都做**是必须的：
   * 只重置序列 → 新 seq=1 低于旧游标 → 全部新数据被静默跳过；
   * 只清游标   → 新 seq 从旧位置继续，游标 0，功能正确但数字难看。
   *
   * ★ `sqlite_sequence` 只在库里**存在** AUTOINCREMENT 表时才被创建 ——
   * 残缺/半迁移的库上它可能不在，硬删会抛 `no such table`（实测）。
   * 下面几张表同理逐个判断：这个脚本要能在一个不完整的库上**如实做完
   * 能做的部分**，而不是抛一个栈把用户留在"删了一半"的状态。
   */
  if (tableExists("sqlite_sequence")) {
    db.prepare("DELETE FROM sqlite_sequence WHERE name = 'knowledge_changelog'").run()
  }
  if (tableExists("consumer_cursors")) {
    db.prepare(
      `UPDATE consumer_cursors
          SET acked_seq = 0, last_error = NULL, last_success_at = NULL,
              needs_full_rebuild = 0, lease_owner = NULL, lease_expires_at = NULL,
              updated_at = ?`,
    ).run(Date.now())
  }

  /**
   * 采集水位清零 —— 与 `reset-watermark.mjs` 同一套字段。
   *
   * 不清的话下一轮从"当下"往后采，而库里已经没有历史了 ——
   * 那正是那个脚本文件头描述的"7 天回溯只在 watermark===0 时生效"。
   */
  if (tableExists("sync_cursors")) {
    db.prepare(
      `UPDATE sync_cursors
          SET watermark = 0, cursor = NULL, window_start = NULL, window_end = NULL,
              page_count = 0, truncated = 0, status = 'idle', last_error = NULL,
              attempts = 0, updated_at = ?`,
    ).run(Date.now())
  }

  /**
   * 蒸馏水位清零，但**保留 scope_json 与 enabled** ——
   * 那是用户勾选的范围，清了等于让他重新勾一遍（见文件头「保留什么」）。
   */
  if (tableExists("distill_sources")) {
    db.prepare(
      `UPDATE distill_sources
          SET last_synced_seq = 0, state = 'idle', last_error = NULL, updated_at = ?`,
    ).run(Date.now())
  }
})

wipe()

// FTS 自检：contentless 表被清空后 rowid 空间应当是干净的。
// 失配是**静默故障**（搜不到但不报错），所以主动查一次而不是假定成功。
// ★ 表不存在时**跳过**而不是报失败：那是"这个库还没建索引"，不是损坏。
let ftsOk = true
let ftsError = null
let ftsChecked = false
if (tableExists("messages_fts")) {
  ftsChecked = true
  try {
    db.prepare("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')").run()
  } catch (error) {
    ftsOk = false
    ftsError = error instanceof Error ? error.message : String(error)
  }
}

// WAL 里还留着刚删掉的那几百 MB —— checkpoint + VACUUM 才会真的还给磁盘
db.pragma("wal_checkpoint(TRUNCATE)")
db.exec("VACUUM")
db.close()

let removed = 0
for (const target of fileTargets(vaultDir)) {
  if (!existsSync(target.path)) continue
  rmSync(target.path, { recursive: true, force: true })
  removed += 1
}

console.log(`\n✓ 已清空 ${String(totalRows)} 行，删除 ${String(removed)} 个文件/目录。`)
if (!ftsOk) {
  // 「跑不起来/断言不成立必须报错」—— 静默成功比失败更糟
  console.error(`✗ FTS 自检失败：${ftsError}`)
  console.error("  索引可能残留孤儿行，搜索会不准。建议直接删掉整个 vault 目录重来。")
  process.exit(1)
}
// 如实区分"验过了"与"没验"：后者不该显示成一句绿色的通过。
console.log(
  ftsChecked ? "✓ FTS 自检通过（索引已干净）" : "· FTS 表不存在，跳过自检（这个库还没建过索引）",
)
console.log("")
console.log("下一步：启动应用（pnpm dev）。它会")
console.log("  1. 重新做一次完整回溯（几百次 CLI 调用，状态页能看到 messages 增长）；")
console.log("  2. 重新物化四件套导出；")
console.log("  3. 自动建图会判定「图不存在」→ 首次必建。")
console.log("")
console.log("★ 建图会重烧全部语料的 embedding（实测 3.7 万条约 3 小时，且")
console.log("  Phase A 中途退出应用会从零重来）—— 让它一次跑完，别中途重启。")
