#!/usr/bin/env node
/**
 * 跑一次**完整**蒸馏（切窗 → 任务 → 守卫 → map → merge → 落库），会花钱。
 *
 * 与 check-map.mjs 的区别：那个只验 map 一段，这个走的是用户点
 * "开始蒸馏"时真正发生的整条链路。
 *
 * 用法：
 *   node scripts/check-distill.mjs                       # 最近 7 天，最多 6 个任务
 *   node scripts/check-distill.mjs --days 3 --tasks 3
 *   node scripts/check-distill.mjs --reset               # 清任务表重来
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "esbuild"

const root = resolve(import.meta.dirname, "..")
const args = process.argv.slice(2)

function flag(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : Number(args[index + 1])
}

function workspaceAlias() {
  const alias = {}
  for (const entry of readdirSync(join(root, "packages"))) {
    alias[`@mycontext/${entry}`] = join(root, "packages", entry, "src/index.ts")
  }
  return alias
}

function readEnv() {
  const path = join(root, ".env")
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim())
    if (match === null) continue
    out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "")
  }
  return out
}

function findVault() {
  const appSupport = join(homedir(), "Library", "Application Support")
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
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error("未找到 vault。先登录应用并采集一次。")
}

const env = { ...readEnv(), ...process.env }
const baseUrl = env["MYCONTEXT_LLM_BASE_URL"] ?? ""
const apiKey = env["MYCONTEXT_LLM_API_KEY"] ?? ""
const model = env["MYCONTEXT_MODEL_MAIN"] ?? "qwen3.7-plus"

if (baseUrl === "" || apiKey === "") {
  console.error("✗ 缺少 MYCONTEXT_LLM_BASE_URL / MYCONTEXT_LLM_API_KEY。")
  process.exit(1)
}

const outDir = mkdtempSync(join(root, "node_modules", ".mycontext-distillcheck-"))
const outFile = join(outDir, "check.mjs")

try {
  await build({
    entryPoints: [join(root, "scripts/check-distill-entry.ts")],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["better-sqlite3"],
    alias: workspaceAlias(),
    logLevel: "silent",
  })

  const { runDistillCheck } = await import(`file://${outFile}`)
  console.log(`模型 ${model} @ ${baseUrl}\n`)

  const report = await runDistillCheck({
    dbPath: findVault(),
    baseUrl,
    apiKey,
    model,
    days: flag("days", 7),
    windowDays: flag("window", 7),
    maxTasks: flag("tasks", 6),
    reset: args.includes("--reset"),
    now: () => Date.now(),
  })

  console.log(
    `切窗：新建 ${report.planned.created} 个任务（总共算了 ${report.planned.total} 个格子）`,
  )
  console.log(
    `跑了 ${report.ran} 个：done ${report.done} / skipped ${report.skipped} / failed ${report.failed}`,
  )
  console.log("")
  console.log("逐任务：")
  for (const task of report.perTask) {
    const tail = task.error === undefined ? "" : ` ← ${task.error}`
    console.log(
      `  ${task.facet.padEnd(10)} ${task.state.padEnd(8)} 语料 ${String(task.accepted).padStart(3)} 条 → 写库 ${task.written} 条${tail}`,
    )
  }
  console.log("")
  console.log(`画像里共 ${report.facetCount} 条结论：`)
  for (const [facet, count] of Object.entries(report.byFacet)) {
    console.log(`  ${facet.padEnd(12)} ${count}`)
  }
  console.log(`最少证据条数 ${report.minEvidence}（必须 > 0）`)
  console.log(`token 合计 ${report.costTokens}，耗时 ${report.elapsedMs}ms`)
  console.log("")
  console.log("结论抽样（人工判断质量）：")
  for (const item of report.sample) {
    console.log(
      `  · [${item.facet}] ${item.key} (${item.confidence.toFixed(2)}, ${item.evidence} 条证据)`,
    )
    console.log(`      ${item.value}`)
  }
  console.log("")
  console.log(
    `任务表进度：total ${report.progress.total} / done ${report.progress.done} / skipped ${report.progress.skipped} / failed ${report.progress.failed} / pending ${report.progress.pending}`,
  )
  if (report.progress.lastError !== null) {
    console.log(`最近失败：${report.progress.lastError}`)
  }

  /**
   * 判据是**画像里真有带证据的结论**。
   *
   * 只断言"没报错"的话，任务全 skipped 也照样绿 —— 而那正是
   * "蒸馏完成但画像是空的"，与成功长得一模一样。
   */
  if (report.facetCount === 0) {
    console.error("\n✗ 蒸馏跑完但画像里一条结论都没有。")
    process.exitCode = 1
  } else if (report.minEvidence === 0) {
    console.error("\n✗ 有结论的证据是空的 —— 守卫本该拦住它。")
    process.exitCode = 1
  } else if (report.done === 0) {
    console.error("\n✗ 没有一个任务是 done（全 skipped/failed）—— 链路有问题。")
    process.exitCode = 1
  } else {
    console.log("\n✓ 蒸馏端到端跑通（画像结论都带可验回原文的证据）")
  }
} catch (error) {
  console.error("DISTILL_CHECK_FAILED:", error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
