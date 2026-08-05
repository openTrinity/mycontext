#!/usr/bin/env node
/**
 * 重放 `raw_records` 里已存的原始响应 —— **零外部调用**。
 *
 * 实际逻辑在 `replay-raw-entry.ts`（TS，与应用共享同一份包源码）。
 * Node 不能直接执行 TS，这里用仓库已有的 esbuild 打包到临时文件后运行，
 * 不额外引入 tsx / vite-node 这类运行时依赖（与 smoke.mjs 同一套做法）。
 *
 * 用法：
 *   node scripts/replay-raw.mjs                 # 重放（自动挑数据最多的 vault）
 *   node scripts/replay-raw.mjs --dry-run       # 只解析并统计，不写库
 *   node scripts/replay-raw.mjs --db <path>     # 指定 vault
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { build } from "esbuild"

const root = resolve(import.meta.dirname, "..")
const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const dbIndex = args.indexOf("--db")
const dbPath = dbIndex === -1 ? undefined : args[dbIndex + 1]

/** 工作区包全部内联；native 模块必须外置。与 smoke.mjs 一致地从文件系统推导。 */
function workspaceAlias() {
  const alias = {}
  for (const entry of readdirSync(join(root, "packages"))) {
    alias[`@mycontext/${entry}`] = join(root, "packages", entry, "src/index.ts")
  }
  return alias
}

// 产物必须落在仓库内：external 的 better-sqlite3 要靠 node_modules 解析。
const outDir = mkdtempSync(join(root, "node_modules", ".mycontext-replay-"))
const outFile = join(outDir, "replay.mjs")

try {
  await build({
    entryPoints: [join(root, "scripts/replay-raw-entry.ts")],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["better-sqlite3"],
    alias: workspaceAlias(),
    logLevel: "silent",
  })

  const { runReplay } = await import(`file://${outFile}`)
  const report = await runReplay({ dryRun, dbPath })

  console.log(`vault: ${report.dbPath}`)
  console.log(
    report.selfConfirmed
      ? `身份已确认：${report.selfNames.join(" / ")}（is_self 与「@我」都会判定）`
      : "⚠️ 身份未确认 → is_self 与「@我」一律留 null（未判定）。\n" +
          "   确认身份后再跑一次即可回填 —— 猜错会永久污染画像，所以这里不猜。",
  )
  console.log("")
  console.log(`解析：${report.pages} 页 → 会话 ${report.parsedConversations} 行（含重复）、`)
  console.log(`      消息 ${report.parsedMessages} 条、媒体 ${report.parsedMedia} 个`)

  if (dryRun) {
    console.log("\n(--dry-run：未写库)")
  } else {
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
    console.log(`  ${"其中「@我」".padEnd(19)} ${report.selfMentions}`)
    console.log(`  ${"FTS 已建索引".padEnd(18)} ${report.ftsIndexed}`)

    if (report.counts.messages === 0) {
      console.error(
        "\n✗ 重放后 messages 仍为 0 —— 解析链路还有问题。" +
          "\n  先修解析，不要去跑真实回溯（那只会白烧 CLI 调用）。",
      )
      process.exitCode = 1
    } else {
      console.log("\n✓ 重放完成。若要拿回更早的历史（水位已推过头），下一步：")
      console.log("  node scripts/reset-watermark.mjs   然后启动应用跑一轮回溯")
    }
  }
} catch (error) {
  console.error("REPLAY_FAILED:", error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
