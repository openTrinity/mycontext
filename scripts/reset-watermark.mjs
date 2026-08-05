#!/usr/bin/env node
/**
 * 把采集水位清零，让下一轮重新做完整回溯。
 *
 * ## 为什么需要一个显式的运维动作
 *
 * `scheduler.nextWindow()` 里：
 *
 * ```js
 * const start = watermark === 0 ? now - INITIAL_BACKFILL_MS : watermark - WINDOW_OVERLAP_MS
 * ```
 *
 * 7 天回溯**只在 `watermark === 0` 时生效**。而信封 bug 期间采集"成功"了很多轮
 * （解析恒返回 0 条，看起来就是"这个窗没有新消息"），水位一路推到了当下。
 * 于是修好解析之后，应用只会从"当下"往后采 —— 之前那 7 天历史永远拿不回来。
 *
 * ## 为什么不在代码里自动做
 *
 * 写成「检测到 messages == 0 就自动清水位」很诱人，但那会在**真实的空账号**上
 * 造成每次启动都全量回溯（新用户、或者确实没聊天记录的账号）。
 * 回溯是几百次 CLI 调用，把它挂在一个会反复成立的条件上是不可接受的。
 *
 * 清水位是**破坏性且有成本**的动作（会重新拉取全部历史），所以做成显式脚本：
 * 谁清的、什么时候清的，在 shell history 里留痕。
 *
 * ## 安全性
 *
 * 只改 `sync_cursors`，**不删任何数据**。重新采到的消息会被幂等键
 * （`messages.(channel_id, external_id)`）挡住，不产生重复行，
 * 也不产生新的 Outbox seq —— 所以最坏情况只是浪费一些 CLI 调用。
 *
 * 用法：
 *   node scripts/reset-watermark.mjs              # 列出当前水位并清零
 *   node scripts/reset-watermark.mjs --dry-run    # 只看，不改
 *   node scripts/reset-watermark.mjs --db <path>
 */
import { createRequire } from "node:module"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const require = createRequire(import.meta.url)
const Database = require("better-sqlite3")

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const dbIndex = args.indexOf("--db")
const explicitDb = dbIndex === -1 ? null : args[dbIndex + 1]

function findVaults() {
  if (explicitDb !== undefined && explicitDb !== null) return [explicitDb]
  const appSupport = join(homedir(), "Library", "Application Support")
  const out = []
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
      const candidate = join(vaultsDir, entry, "core.sqlite")
      if (existsSync(candidate)) out.push(candidate)
    }
  }
  return out
}

const candidates = findVaults()
if (candidates.length === 0) {
  console.error("未找到任何 vault。先登录一次应用，或用 --db <path> 指定。")
  process.exit(1)
}

let touched = 0

for (const dbPath of candidates) {
  let db
  try {
    db = new Database(dbPath)
  } catch (error) {
    console.warn(`跳过 ${dbPath}：${error instanceof Error ? error.message : String(error)}`)
    continue
  }

  let rows
  try {
    rows = db.prepare("SELECT scope, watermark, status FROM sync_cursors").all()
  } catch {
    // 老 schema（没有 sync_cursors）
    db.close()
    continue
  }

  console.log(`\nvault: ${dbPath}`)
  if (rows.length === 0) {
    console.log("  （没有水位记录 —— 本来就会做完整回溯）")
    db.close()
    continue
  }

  for (const row of rows) {
    const when =
      row.watermark > 0 ? new Date(row.watermark).toISOString().replace("T", " ").slice(0, 19) : "0"
    console.log(`  ${row.scope.padEnd(24)} watermark=${when}  status=${row.status}`)
  }

  if (dryRun) {
    db.close()
    continue
  }

  // 只清水位与分页游标；`window_start/window_end` 由下一轮 beginWindow 重写。
  // status 一并复位成 idle：留着 error/truncated 会让状态页显示一个
  // 已经不成立的告警。
  const info = db
    .prepare(
      `UPDATE sync_cursors
          SET watermark = 0, cursor = NULL, page_count = 0,
              truncated = 0, status = 'idle', last_error = NULL, attempts = 0`,
    )
    .run()
  touched += info.changes
  console.log(`  → 已清零 ${info.changes} 条水位`)
  db.close()
}

if (dryRun) {
  console.log("\n(--dry-run：未做任何修改)")
  process.exit(0)
}

console.log(`\n✓ 共清零 ${touched} 条水位。`)
console.log("下一步：启动应用（pnpm dev）。它会重新做一次完整回溯 ——")
console.log("这是几百次 CLI 调用、可能要几分钟，状态页能看到 messages 增长。")
