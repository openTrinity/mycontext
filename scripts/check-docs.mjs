#!/usr/bin/env node
/**
 * 真跑一轮**文档采集**（会真的调 DWS CLI，消耗接口配额）。
 *
 * 逻辑在 `check-docs-entry.ts`（TS，与应用共享同一份包源码）；
 * 这里用 esbuild 打包后运行，与 backfill.mjs / smoke.mjs 同一套做法。
 *
 * 用法：
 *   node scripts/check-docs.mjs                # 列举 + 补 5 篇正文
 *   node scripts/check-docs.mjs --bodies 20    # 多补几篇
 *   node scripts/check-docs.mjs --db <path>
 *
 * ★ 判据是**数字**而不是"跑完没报错"：这条链路的三种失效
 * （不递归 → 列到 0 篇 / 后缀过滤错 → 白烧调用 / 时间格式少吃一种
 * → updated_at 全为 null）**都不抛异常**。见 check-docs-entry 的文件头。
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { build } from "esbuild"

const root = resolve(import.meta.dirname, "..")
const args = process.argv.slice(2)
const bodiesIndex = args.indexOf("--bodies")
const bodies = bodiesIndex === -1 ? 5 : Number(args[bodiesIndex + 1])
const dbIndex = args.indexOf("--db")
const dbPath = dbIndex === -1 ? undefined : args[dbIndex + 1]
/**
 * 应用目录（内含 dws/ profile）。跑在 vault 副本上时必须指对 ——
 * 否则 DWS 用的是一个空 profile，报 not_authenticated。
 */
const cfgIndex = args.indexOf("--app-dir")
const dwsConfigDir = cfgIndex === -1 ? undefined : args[cfgIndex + 1]

function workspaceAlias() {
  const alias = {}
  for (const entry of readdirSync(join(root, "packages"))) {
    alias[`@mycontext/${entry}`] = join(root, "packages", entry, "src/index.ts")
  }
  return alias
}

const outDir = mkdtempSync(join(root, "node_modules", ".mycontext-docs-"))
const outFile = join(outDir, "check-docs.mjs")

try {
  await build({
    entryPoints: [join(root, "scripts/check-docs-entry.ts")],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["better-sqlite3"],
    alias: workspaceAlias(),
    logLevel: "silent",
  })

  const { runDocsProbe } = await import(`file://${outFile}`)
  console.log("开始文档采集（会调用 DWS CLI，请勿中断）……\n")
  const report = await runDocsProbe({
    dbPath,
    bodies,
    dwsConfigDir,
    onProgress: (line) => console.log(line),
  })

  console.log("")
  console.log(
    `列举 ${report.listed} 篇（truncated=${report.truncated}），落库变化 ${report.changed}`,
  )
  console.log(`本轮补到正文 ${report.bodiesFetched} 篇`)
  console.log("")
  console.log("库内计数：")
  console.log(`  ${"documents 总数".padEnd(18)} ${report.total}`)
  console.log(`  ${"其中有正文".padEnd(18)} ${report.withBody}`)
  console.log(`  ${"其中有 updated_at".padEnd(16)} ${report.withUpdatedAt}`)
  console.log(`  来源分布：${JSON.stringify(report.byOrigin)}`)
  console.log(`  后缀分布：${JSON.stringify(report.byExtension)}`)
  if (report.samples.length > 0) {
    console.log("")
    console.log("正文抽样（最长 5 篇）：")
    for (const s of report.samples) {
      console.log(
        `  ${String(s.chars).padStart(6)} 字  [${s.extension ?? "?"}]  ${s.title.slice(0, 40)}`,
      )
    }
  }

  /**
   * ★ 三条断言，各对应一种**静默**失效（见文件头）。
   * 断言不通过时非零退出 —— 「跑完了」不等于「采对了」。
   */
  const problems = []
  if (report.total === 0) {
    problems.push("documents 表为 0 —— 列举整段没生效（而不是「这个账号没有文档」）")
  }
  if (report.total > 0 && report.withBody === 0) {
    problems.push("一篇正文都没取到 —— doc read 那一跳断了，或后缀白名单把全部挡掉了")
  }
  if (report.total > 0 && report.withUpdatedAt === 0) {
    problems.push("updated_at 全为 null —— 时间解析没吃到实际格式（下游按时间窗过滤会全漏）")
  }
  if (problems.length > 0) {
    console.log("")
    for (const p of problems) console.log(`❌ ${p}`)
    process.exitCode = 1
  } else {
    console.log("")
    console.log("✅ 列举 / 正文 / 时间解析 三段都有数字")
  }
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
