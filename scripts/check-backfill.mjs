#!/usr/bin/env node
/**
 * 回溯链探针：「用户选了 180 天，这台机器会怎么补」。
 *
 * ## 为什么它必须存在（单测覆盖不到的那三件事）
 *
 * 单测用的是 `openTestVault()` 与手造的时间点，验的是**规则**。
 * 而这条链有三处只有真库能暴露：
 *
 * 1. `distill_sources.scope_json` 真的能被读出来 —— 字段名、JSON 形状、
 *    `enabled` 位。读不出来时表现是"回溯永远不启动"，与"不需要回溯"同形。
 * 2. 规划出的窗**连续、不越界**，末窗恰好停在实时路起点。有缝隙就是
 *    永久漏掉那一段历史，越界就是每轮白拉实时路已有的 7 天。
 * 3. 进度真的写得进 `sync_cursors`。写这条链时正是在这里发现
 *    `commitWindow` 是纯 UPDATE —— 行不存在时**静默 no-op**，
 *    于是"进度永远是 0"，与"回溯还没开始"完全同形。
 *
 * ## ★ 跑在 vault 的**副本**上（它会写 sync_cursors）
 *
 * 与 `check-ingest-gap.mjs` 同样连 `-wal` 一起拷：不拷的话最近的消息
 * 还在 WAL 里没 checkpoint，而"最早/最晚一条"是这里的判据之一。
 *
 * ```bash
 * node scripts/check-backfill.mjs           # 报告
 * node scripts/check-backfill.mjs --assert  # 规划不合法就 exit 1
 * ```
 *
 * `--assert` 不要求"必须有要补的"（用户可能只选了 7 天）——
 * 它只要求：**有要补的时候，规划必须是合法的**。
 */
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "esbuild"

const root = resolve(import.meta.dirname, "..")
const assertMode = process.argv.slice(2).includes("--assert")

function workspaceAlias() {
  const alias = {}
  for (const entry of readdirSync(join(root, "packages"))) {
    alias[`@mycontext/${entry}`] = join(root, "packages", entry, "src/index.ts")
  }
  return alias
}

/** 取**最近改动**的那个 vault（这台机器上有两个，旧的停在 7-30）。 */
function findVault() {
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
      const wal = `${db}-wal`
      const mtime = Math.max(statSync(db).mtimeMs, existsSync(wal) ? statSync(wal).mtimeMs : 0)
      candidates.push({ db, mtime })
    }
  }
  if (candidates.length === 0) throw new Error("没找到 vault（先登录应用并采集一次）")
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0].db
}

const outDir = mkdtempSync(join(root, "node_modules", ".mycontext-backfill-"))
const outFile = join(outDir, "check.mjs")
const copyDir = mkdtempSync(join(tmpdir(), "mycontext-backfill-vault-"))

try {
  await build({
    entryPoints: [join(root, "scripts/check-backfill-entry.ts")],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["better-sqlite3"],
    alias: workspaceAlias(),
    logLevel: "silent",
  })

  const source = findVault()
  const dbCopy = join(copyDir, "core.sqlite")
  copyFileSync(source, dbCopy)
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${source}${suffix}`)) copyFileSync(`${source}${suffix}`, `${dbCopy}${suffix}`)
  }

  const { runBackfillProbe } = await import(`file://${outFile}`)
  const report = runBackfillProbe({ dbPath: dbCopy, channelId: "dingtalk" })

  const fmt = (ms) => (ms === null ? "—" : new Date(ms).toLocaleString("sv").slice(0, 16))

  console.log(`引导选的起点      ${fmt(report.floor)}`)
  console.log(`回溯终点（now-7d）${fmt(report.ceiling)}`)
  console.log(`库里最早一条      ${fmt(report.earliestMessage)}`)
  console.log(
    `现在缺的历史      ${report.missingDays === null ? "—" : `${String(report.missingDays)} 天`}`,
  )
  console.log("")

  if (report.floor === null) {
    console.log("→ 没选过时间范围（或聊天源已关）：不需要回溯")
  } else if (report.plannedWindows === 0) {
    console.log("→ 选的范围已在实时路覆盖内，或历史已补完：没有要补的")
  } else {
    console.log(`规划窗数          ${String(report.plannedWindows)}（一轮补一个，一窗一天）`)
    console.log(
      `首窗              ${fmt(report.firstWindow.start)} → ${fmt(report.firstWindow.end)}`,
    )
    console.log(`末窗              ${fmt(report.lastWindow.start)} → ${fmt(report.lastWindow.end)}`)
    console.log(
      `预计耗时          约 ${((report.plannedWindows * 2) / 60).toFixed(1)} 小时（主循环 2 分钟一轮）`,
    )
    console.log("")
    console.log(`窗口连续无缝隙    ${report.contiguous ? "✓" : "✗ 有缝隙 = 永久漏掉那段历史"}`)
    console.log(
      `末窗不越过终点    ${report.withinCeiling ? "✓" : "✗ 越界 = 每轮白拉实时路已有的 7 天"}`,
    )
    console.log(
      `进度真的落库      ${report.progressPersists ? "✓" : "✗ 静默 no-op = 进度永远是 0"}`,
    )
    console.log(`两条游标分开      ${report.scopesDistinct ? "✓" : "✗ 会让实时水位倒退"}`)
  }

  if (!assertMode) process.exit(0)

  /**
   * 断言只在**有要补的**时候才有内容可查。
   * 没有要补的不算失败（用户可能只选了 7 天）—— 但"跑不起来"必须 exit 1。
   */
  const problems = []
  if (report.plannedWindows > 0) {
    if (!report.contiguous) problems.push("窗口有缝隙")
    if (!report.withinCeiling) problems.push("末窗越过了实时路起点")
    if (!report.progressPersists) problems.push("进度没能落库（commitWindow 静默 no-op？）")
    if (!report.scopesDistinct) problems.push("回溯与实时共用了同一条游标")
  }
  if (problems.length > 0) {
    console.error("")
    console.error(`✗ 回溯规划不合法：${problems.join("；")}`)
    process.exit(1)
  }
  console.log("")
  console.log("✓ 回溯规划合法")
} finally {
  rmSync(outDir, { recursive: true, force: true })
  rmSync(copyDir, { recursive: true, force: true })
}
