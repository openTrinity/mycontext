#!/usr/bin/env node
/**
 * 解析并确认本人身份 + 回填 is_self 与「@我」（会调 DWS CLI）。
 *
 * 为什么需要：身份未确认时每条消息的 `is_self` 都是 null，蒸馏守卫会以
 * `identity_unconfirmed` 拒掉**全部**语料 —— 表现是"蒸馏跑完一条结论都没有"
 * 且不报错。实测这个 vault 的 9768 条消息全部如此。
 *
 * 用法：node scripts/confirm-self.mjs
 * 前置：应用里已完成钉钉授权。
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

/** 找应用的数据目录：dws-home 与 vault 必须来自**同一个**目录，否则等于未登录。 */
function findAppDir() {
  const appSupport = join(homedir(), "Library", "Application Support")
  for (const appName of [
    "MyContextDevelop",
    "MyContextDev",
    "MyContext",
    "InklingsDevelop",
    "InklingsDev",
    "Inklings",
  ]) {
    const dir = join(appSupport, appName)
    if (existsSync(join(dir, "channels", "dingtalk", "dws-home", "token.json"))) return dir
  }
  throw new Error("未找到已授权的数据目录。先在应用里完成钉钉授权。")
}

function findVault(appDir) {
  const vaultsDir = join(appDir, "vaults")
  if (!existsSync(vaultsDir)) throw new Error("没有 vaults 目录 —— 先登录一次应用。")
  for (const entry of readdirSync(vaultsDir)) {
    const candidate = join(vaultsDir, entry, "core.sqlite")
    if (existsSync(candidate)) return candidate
  }
  throw new Error("没找到 core.sqlite。")
}

const outDir = mkdtempSync(join(root, "node_modules", ".mycontext-self-"))
const outFile = join(outDir, "confirm.mjs")

try {
  await build({
    entryPoints: [join(root, "scripts/confirm-self-entry.ts")],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["better-sqlite3"],
    alias: workspaceAlias(),
    logLevel: "silent",
  })

  const appDir = findAppDir()
  const { runConfirmSelf } = await import(`file://${outFile}`)
  const report = await runConfirmSelf({
    dbPath: findVault(appDir),
    binDir: join(root, "apps/desktop/resources/bin"),
    dwsHome: join(appDir, "channels", "dingtalk", "dws-home"),
    sharedRoot: join(appDir, "shared"),
    now: () => Date.now(),
  })

  console.log("解析到的本人身份：")
  console.log(`  userId      ${report.userId}`)
  console.log(`  显示名      ${report.displayNames.join(" / ")}`)
  console.log(`  openIds     ${report.openIds.map((id) => `${id.kind}=${id.value}`).join(" ")}`)
  console.log(`  组织        ${report.corpName ?? "(未提供)"}`)
  console.log("")
  console.log(`回填：is_self ${report.backfilled} 条，「@我」${report.mentionsBackfilled} 条`)
  console.log(
    `回填后：本人 ${report.after.self} / 他人 ${report.after.other} / 未判定 ${report.after.unknown}`,
  )
  console.log(`耗时 ${report.elapsedMs}ms`)

  /**
   * 判据是**未判定归零**，不是"回填了 > 0 条"。
   *
   * 只断言 backfilled > 0 的话，回填一半也算通过 —— 而剩下那一半会被
   * 守卫静默拒掉，蒸馏的语料就少了一块且没人知道。
   */
  if (report.after.self === 0) {
    console.error("\n✗ 回填后一条本人消息都没有 —— openId 与 sender_external_id 对不上。")
    process.exitCode = 1
  } else if (report.after.unknown > 0) {
    console.error(`\n✗ 仍有 ${report.after.unknown} 条未判定 —— 那些会被蒸馏守卫静默拒掉。`)
    process.exitCode = 1
  } else {
    console.log("\n✓ 身份已确认，全部消息都有 is_self 判定")
  }
} catch (error) {
  console.error("CONFIRM_SELF_FAILED:", error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
