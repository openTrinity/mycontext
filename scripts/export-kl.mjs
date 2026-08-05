#!/usr/bin/env node
/**
 * 导出 kl-graph 的标准四件套（不起 Electron）。
 *
 * 逻辑在 `export-kl-entry.ts`；这里用仓库已有的 esbuild 打包后运行
 * （与 smoke.mjs / replay-raw.mjs 同一套做法，不引入 tsx）。
 *
 * 用法：
 *   node scripts/export-kl.mjs                       # 落到应用的 shared/exports/dws
 *   node scripts/export-kl.mjs --out /tmp/kl-export
 *   node scripts/export-kl.mjs --db <core.sqlite>
 *
 * 之后：
 *   export KL_DWS_EXPORT_DIR=<exportDir>
 *   cd kl-graph && ./kl start && kl ingest
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { build } from "esbuild"

const root = resolve(import.meta.dirname, "..")
const args = process.argv.slice(2)
const outIndex = args.indexOf("--out")
const exportDir = outIndex === -1 ? undefined : args[outIndex + 1]
const dbIndex = args.indexOf("--db")
const dbPath = dbIndex === -1 ? undefined : args[dbIndex + 1]

function workspaceAlias() {
  const alias = {}
  for (const entry of readdirSync(join(root, "packages"))) {
    alias[`@mycontext/${entry}`] = join(root, "packages", entry, "src/index.ts")
  }
  return alias
}

const outDir = mkdtempSync(join(root, "node_modules", ".mycontext-exportkl-"))
const outFile = join(outDir, "export.mjs")

try {
  await build({
    entryPoints: [join(root, "scripts/export-kl-entry.ts")],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["better-sqlite3"],
    alias: workspaceAlias(),
    logLevel: "silent",
  })

  const { runExportKl } = await import(`file://${outFile}`)
  const report = runExportKl({ dbPath, exportDir })

  console.log(`vault:  ${report.dbPath}`)
  console.log(`导出到: ${report.exportDir}`)
  console.log("")
  for (const source of report.sources) {
    console.log(
      `  ${source.name.padEnd(10)} scopes=${source.scopes}  records=${source.records}  resources=${source.resources}`,
    )
  }
  console.log("")
  console.log(`消息 ${report.totalMessages} 条 / 听记 ${report.totalMinutes} 条`)
  console.log(`Outbox 水位 headSeq=${report.headSeq}`)
  console.log("")
  console.log("下一步（喂给图谱）：")
  console.log(`  export KL_DWS_EXPORT_DIR="${report.exportDir}"`)
  console.log("  cd kl-graph && ./kl start && kl ingest")

  if (report.totalMessages === 0) {
    console.error("\n✗ 导出 0 条消息 —— 先确认库里有数据（pnpm replay:raw 或 pnpm backfill）。")
    process.exitCode = 1
  }
} catch (error) {
  console.error("EXPORT_FAILED:", error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
