#!/usr/bin/env node
/**
 * 为「Node 运行时」重建 better-sqlite3（vitest / smoke 用）。
 *
 * 与 rebuild-electron.mjs 互斥：两者 ABI 不同，切换用途时需重新执行对应脚本。
 * stamp 文件记录当前编译目标，未切换用途时跳过重建。
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const stampPath = join(root, "node_modules", ".mycontext-native-abi")
const stamp = `node-${process.versions.modules}`

const canLoadBetterSqlite3 = () =>
  spawnSync(
    process.execPath,
    [
      "-e",
      "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.close()",
    ],
    {
      cwd: root,
      stdio: "ignore",
    },
  ).status === 0

if (existsSync(stampPath) && readFileSync(stampPath, "utf8").trim() === stamp) {
  if (canLoadBetterSqlite3()) {
    console.log(`better-sqlite3 已是 Node ABI（${stamp}），跳过重建`)
    process.exit(0)
  }
  console.warn(`better-sqlite3 的 ABI 标记已失效（${stamp}），重新构建`)
}

// pnpm rebuild 会在 .pnpm store 里就地重建，软链自动指向新产物。
const result = spawnSync("pnpm", ["rebuild", "better-sqlite3"], {
  cwd: root,
  stdio: "inherit",
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
if (!canLoadBetterSqlite3()) {
  console.error("better-sqlite3 重建后仍无法被 Node 加载")
  process.exit(1)
}

writeFileSync(stampPath, stamp)
console.log(`better-sqlite3 已重建为 Node ABI（${stamp}）`)
