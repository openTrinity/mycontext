#!/usr/bin/env node
/**
 * 真跑一轮**授权 + 采集**，验证某个 DWS 二进制与本仓库的接线是否兼容。
 *
 * 换 dws（升级、或换成开源版 dingtalk-workspace-cli）时用它下结论 ——
 * `dws --help` 对得上**不足以**说明能用：响应信封或业务键变了的表现是
 * 「解析出 0 条」而不是报错。判据见 probe-dws-entry.ts 的文件头。
 *
 * 逻辑在 `probe-dws-entry.ts`（TS，与应用共享同一份包源码）；
 * 这里用 esbuild 打包后运行，与 check-docs.mjs / smoke.mjs 同一套做法。
 *
 * 用法：
 *   node scripts/probe-dws.mjs                      # 用 resources/bin 里那份
 *   node scripts/probe-dws.mjs --bin-dir /tmp/os     # 指定别的二进制目录
 *   node scripts/probe-dws.mjs --hours 48            # 放宽时间窗
 *   node scripts/probe-dws.mjs --app-dir <应用目录>   # 指定 dws profile 所在
 *
 * ★ 会真的调 DWS CLI（消耗接口配额），且要求已 `dws auth login`。
 */
import { mkdtempSync, rmSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { build } from "esbuild"

const root = resolve(import.meta.dirname, "..")
const args = process.argv.slice(2)

function flag(name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const binDir = flag("--bin-dir")
const appDir = flag("--app-dir")
const hours = Number(flag("--hours") ?? 24)

function workspaceAlias() {
  const alias = {}
  for (const entry of readdirSync(join(root, "packages"))) {
    alias[`@mycontext/${entry}`] = join(root, "packages", entry, "src/index.ts")
  }
  return alias
}

const outDir = mkdtempSync(join(root, "node_modules", ".inklings-dws-"))
const outFile = join(outDir, "probe-dws.mjs")

try {
  await build({
    entryPoints: [join(root, "scripts/probe-dws-entry.ts")],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["better-sqlite3"],
    alias: workspaceAlias(),
    logLevel: "silent",
  })

  const { runDwsProbe } = await import(`file://${outFile}`)
  console.log("开始 DWS 兼容性探针（会调用 DWS CLI，请勿中断）……\n")
  const report = await runDwsProbe({
    binDir,
    appDir,
    hours,
    onProgress: (line) => console.log(line),
  })

  console.log("")
  console.log("结果：")
  console.log(`  ${"版本".padEnd(16)} ${report.version}`)
  console.log(`  ${"auth 状态".padEnd(15)} ${report.authState}`)
  console.log(`  ${"身份字段".padEnd(15)} ${JSON.stringify(report.identity)}`)
  console.log(`  ${"resolveSelf".padEnd(14)} ${report.resolvedSelf ?? "—"}`)
  console.log(`  ${"未读会话".padEnd(15)} ${report.unreadConversations ?? "—"}`)
  console.log(`  ${"采集消息".padEnd(15)} ${report.messages} 条 / ${report.conversations} 会话`)

  if (report.ok) {
    console.log("")
    console.log("✅ 授权 / 身份 / 探针 / 采集 四段都有数字 —— 这个二进制与当前接线兼容")
  } else {
    console.log("")
    for (const issue of report.issues) console.log(`❌ ${issue}`)
    process.exitCode = 1
  }
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
