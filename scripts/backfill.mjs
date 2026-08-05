#!/usr/bin/env node
/**
 * 跑一轮**真实回溯** —— 会真的调 DWS CLI（消耗接口配额），不是重放。
 *
 * 逻辑在 `backfill-entry.ts`（TS，与应用共享同一份包源码）；
 * 这里用仓库已有的 esbuild 打包后运行，不引入 tsx（与 smoke.mjs 同一套做法）。
 *
 * 用法：
 *   node scripts/backfill.mjs                     # 默认最多 40 轮 / 每轮 600 页
 *   node scripts/backfill.mjs --rounds 10
 *   node scripts/backfill.mjs --pages 200         # 单轮翻页预算
 *   node scripts/backfill.mjs --db <path>
 *
 * 前置：`node scripts/reset-watermark.mjs`（否则只会从当前水位往后采）。
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { build } from "esbuild"

const root = resolve(import.meta.dirname, "..")
const args = process.argv.slice(2)
const roundsIndex = args.indexOf("--rounds")
const maxRounds = roundsIndex === -1 ? 40 : Number(args[roundsIndex + 1])
const pagesIndex = args.indexOf("--pages")
/**
 * 单轮翻页预算，默认 600。
 *
 * 实测 7 天历史每页满 50 条、连续 8 页 `hasMore` 仍为 true ——
 * 预算给 50 会让每轮都在半路耗尽、一个窗都抽不干、水位永不前进（活锁）。
 * 600 页 × 50 条 = 3 万条，足够覆盖一次 7 天回溯。
 */
const pagesPerRound = pagesIndex === -1 ? 600 : Number(args[pagesIndex + 1])
const dbIndex = args.indexOf("--db")
const dbPath = dbIndex === -1 ? undefined : args[dbIndex + 1]
/**
 * 应用目录（内含 dws/ profile）。跑在 vault 副本上时必须指对 ——
 * 否则 DWS 用的是一个空 profile，报 exit 2 / not_authenticated。
 */
const appIndex = args.indexOf("--app-dir")
const appDir = appIndex === -1 ? undefined : args[appIndex + 1]

function workspaceAlias() {
  const alias = {}
  for (const entry of readdirSync(join(root, "packages"))) {
    alias[`@mycontext/${entry}`] = join(root, "packages", entry, "src/index.ts")
  }
  return alias
}

const outDir = mkdtempSync(join(root, "node_modules", ".mycontext-backfill-"))
const outFile = join(outDir, "backfill.mjs")

try {
  await build({
    entryPoints: [join(root, "scripts/backfill-entry.ts")],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["better-sqlite3"],
    alias: workspaceAlias(),
    logLevel: "silent",
  })

  const { runBackfill } = await import(`file://${outFile}`)
  console.log("开始真实回溯（会调用 DWS CLI，请勿中断）……\n")
  const report = await runBackfill({
    dbPath,
    maxRounds,
    pageSize: 50,
    // ★ 与 pageSize 是两个不同的量（见 backfill-entry 的注释）。
    // 大回溯要允许一轮翻很多页，否则永远抽不干第一个窗 → 水位永不前进。
    maxPagesPerRound: pagesPerRound,
    appDir,
    onProgress: (line) => console.log(line),
  })

  const fmt = (ms) =>
    ms === 0 ? "0（未采过）" : new Date(ms).toISOString().replace("T", " ").slice(0, 19)

  console.log("")
  console.log(`vault: ${report.dbPath}`)
  console.log(`轮数 ${report.rounds} / CLI 调用 ${report.cliCalls} 次`)
  console.log(`水位 ${fmt(report.watermarkStart)} → ${fmt(report.watermarkEnd)}`)
  console.log(`落库：新增/变更 ${report.changed} 条，未变化 ${report.unchanged} 条`)
  console.log("")
  console.log("库内计数：")
  for (const [table, count] of Object.entries(report.counts)) {
    console.log(`  ${table.padEnd(20)} ${count}`)
  }
  const byType = Object.entries(report.conversationsByType)
    .map(([type, count]) => `${type}=${count}`)
    .join(" ")
  console.log(`  ${"会话类型分布".padEnd(18)} ${byType}`)
  console.log(`  ${"FTS 已建索引".padEnd(18)} ${report.ftsIndexed}`)
  if (!report.selfConfirmed) {
    console.log("")
    console.log("⚠️ 身份未确认 → is_self 与「@我」留 null。在应用状态页点「确认身份」即可回填。")
  }

  if (report.counts.messages === 0) {
    console.error("\n✗ 回溯后 messages 仍为 0 —— 采集链路有问题。")
    process.exitCode = 1
  }
} catch (error) {
  console.error("BACKFILL_FAILED:", error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
