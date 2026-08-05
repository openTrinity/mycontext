#!/usr/bin/env node
/**
 * 核验会话列表的**真实**响应（会调 DWS CLI，消耗接口配额）。
 *
 * 为什么这个脚本必须存在：这条命令的 `--help` 与实测行为不一致
 * （`--cursor` 无效 / `--limit` 硬顶 100 / `hasMore` 恒 false），
 * 也就是说文档不可信、只有真跑才知道。单测跑的是录下来的 fixture，
 * 证明不了「渠道今天还是那个形状」。
 *
 * 用法：node scripts/check-conversations.mjs
 * 前置：应用里已完成钉钉授权（读的是应用自己的 dws-home）。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "esbuild"

const root = resolve(import.meta.dirname, "..")

function workspaceAlias() {
  const alias = {}
  for (const entry of readdirSync(join(root, "packages"))) {
    alias[`@mycontext/${entry}`] = join(root, "packages", entry, "src/index.ts")
  }
  return alias
}

/** 找应用真实的 dws-home：用别的目录等于未登录。 */
function findDwsHome() {
  const appSupport = join(homedir(), "Library", "Application Support")
  for (const appName of [
    "MyContextDevelop",
    "MyContextDev",
    "MyContext",
    "InklingsDevelop",
    "InklingsDev",
    "Inklings",
  ]) {
    const candidate = join(appSupport, appName, "channels", "dingtalk", "dws-home")
    if (existsSync(join(candidate, "token.json"))) return candidate
  }
  throw new Error("未找到已授权的 dws-home。先在应用里完成钉钉授权。")
}

/** 找 vault：用来量「本地有、渠道列不出来」的那部分。找不到就跳过那一项。 */
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
  return undefined
}

const outDir = mkdtempSync(join(root, "node_modules", ".mycontext-convcheck-"))
const outFile = join(outDir, "check.mjs")

try {
  await build({
    entryPoints: [join(root, "scripts/check-conversations-entry.ts")],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["better-sqlite3"],
    alias: workspaceAlias(),
    logLevel: "silent",
  })

  const { runConversationCheck } = await import(`file://${outFile}`)
  const report = await runConversationCheck({
    binDir: join(root, "apps/desktop/resources/bin"),
    dwsHome: findDwsHome(),
    dbPath: findVault(),
    now: () => Date.now(),
  })

  console.log("三路各自（合并前）：")
  console.log(`  list-all-conversations        ${report.windowCount}`)
  console.log(`  同上 + --exclude-muted        ${report.mutedWindowCount}`)
  console.log(`  chat group list-all（首页）   ${report.groupCount}`)
  console.log("")
  console.log(`合并后 ${report.merged}（单聊 ${report.direct} / 群聊 ${report.group}）`)
  console.log(`比单命令多出 ${report.gainOverSingleCall} 个`)
  console.log(`有最后消息时间 ${report.withTimestamp} 个（群列表那一路没有该字段）`)
  console.log(`truncated=${String(report.truncated)}  耗时 ${report.elapsedMs}ms`)
  if (report.localCount !== null) {
    console.log("")
    console.log(`本地 conversations 表 ${report.localCount} 个`)
    console.log(`其中渠道三路**都没返回**的 ${report.localOnly} 个 ← 只用渠道就会丢这些`)
  }

  /**
   * 判据是**合并有增益**，不是"有数据"。
   *
   * 只断言 merged > 0 的话，三路里挂掉两路也照样绿 —— 而那正是要防的静默退化
   * （合并结果仍然"有会话"，只是少了一大块，谁都不会注意）。
   */
  if (report.merged === 0) {
    console.error("\n✗ 一个会话都没拿到 —— 授权或命令链路有问题。")
    process.exitCode = 1
  } else if (report.gainOverSingleCall <= 0) {
    console.error("\n✗ 合并没有带来任何增益 —— exclude-muted 与群列表两路都没生效。")
    process.exitCode = 1
  } else {
    console.log("\n✓ 三路合并生效")
  }
} catch (error) {
  console.error("CONV_CHECK_FAILED:", error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
