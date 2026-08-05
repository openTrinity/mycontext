#!/usr/bin/env node
/**
 * 用**真实语料 + 真实模型**跑一次 map 阶段（会消耗 LLM 配额）。
 *
 * 单测用注入的假 fetch，只能证明"我们按自己以为的形状处理响应"。
 * 而这个网关的实测行为与文档不一致（`json_object` 仍可能带 ```围栏、
 * 多一个 `reasoning_content`）—— 那两条只有真调才知道。
 *
 * 用法：
 *   node scripts/check-map.mjs                 # 默认最近 30 天取 80 条
 *   node scripts/check-map.mjs --limit 40
 *   node scripts/check-map.mjs --days 7
 *
 * 前置：`.env` 里配好 `MYCONTEXT_LLM_BASE_URL` / `MYCONTEXT_LLM_API_KEY`
 * / `MYCONTEXT_MODEL_MAIN`，且 vault 里已有采过的消息。
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

/** 读 .env。不用 dotenv：只要三个键，而且这里不该有副作用（不写 process.env）。 */
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
  console.error("✗ 缺少 MYCONTEXT_LLM_BASE_URL / MYCONTEXT_LLM_API_KEY —— 无法真调模型。")
  process.exit(1)
}

const outDir = mkdtempSync(join(root, "node_modules", ".mycontext-mapcheck-"))
const outFile = join(outDir, "check.mjs")

try {
  await build({
    entryPoints: [join(root, "scripts/check-map-entry.ts")],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["better-sqlite3"],
    alias: workspaceAlias(),
    logLevel: "silent",
  })

  const { runMapCheck } = await import(`file://${outFile}`)
  console.log(`模型 ${model} @ ${baseUrl}\n`)

  const report = await runMapCheck({
    dbPath: findVault(),
    baseUrl,
    apiKey,
    model,
    limit: flag("limit", 80),
    days: flag("days", 30),
    now: () => Date.now(),
  })

  console.log("语料：")
  console.log(`  窗口内可蒸馏 ${report.windowMessages} 条 → 过守卫后 ${report.accepted} 条`)
  console.log(`  其中本人发的 ${report.selfMessageCount} 条，跨 ${report.conversationCount} 个会话`)
  const rejectLine = Object.entries(report.rejected)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(" ")
  console.log(`  被守卫拒：${rejectLine === "" ? "无" : rejectLine}`)
  console.log("")
  console.log(`统计侧（不调模型）：${report.statCandidates} 条 [${report.statKeys.join(", ")}]`)
  console.log("")
  console.log(`LLM 侧：调用 ${report.llmCalls} 次 → ${report.llmCandidates} 条结论`)
  console.log(
    `  丢弃：无有效证据 ${report.droppedNoEvidence} 条，结构不对 ${report.droppedBadShape} 条`,
  )
  console.log(`  最少证据条数 ${report.minEvidence}（必须 > 0）`)
  console.log(
    `  token：prompt ${report.tokens.prompt} / completion ${report.tokens.completion} / 合计 ${report.tokens.total}`,
  )
  console.log(`  耗时 ${report.elapsedMs}ms`)
  console.log("")
  console.log("抽出来的结论（人工判断质量）：")
  for (const item of report.sample) {
    console.log(`  · ${item.key} (${item.confidence}, ${item.evidence} 条证据)`)
    console.log(`      ${item.value}`)
  }

  /**
   * 判据是**抽出了带证据的结论**，不是"没报错"。
   *
   * 只断言 llmCalls > 0 的话，模型返回空 items 也照样绿 —— 而那正是
   * "跑完了什么都没抽出来"，与成功长得一模一样（kl 那条测试刚栽过同一个坑）。
   */
  if (report.accepted === 0) {
    console.error("\n✗ 过守卫后一条语料都没有 —— 检查身份是否已确认（is_self 全为 null？）。")
    process.exitCode = 1
  } else if (report.llmCandidates === 0) {
    console.error("\n✗ 调了模型但一条结论都没抽出来 —— 提示词或解析有问题。")
    process.exitCode = 1
  } else if (report.minEvidence === 0) {
    console.error("\n✗ 有结论的证据是空的 —— 守卫本该拦住它，说明链路有洞。")
    process.exitCode = 1
  } else {
    console.log("\n✓ map 阶段真实跑通（结论都带可验回原文的证据）")
  }
} catch (error) {
  console.error("MAP_CHECK_FAILED:", error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
