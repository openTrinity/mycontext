#!/usr/bin/env node
/**
 * 备好 Electron 二进制，并为「Electron 运行时」重建 better-sqlite3（跑桌面端应用用）。
 *
 * 与 rebuild-node.mjs 互斥：两者 ABI 不同，切换用途时需重新执行对应脚本。
 *
 * HOME 指向临时目录：electron-rebuild 会在 HOME 下缓存 headers，
 * 隔离掉用户环境里可能存在的旧缓存。
 */
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const require = createRequire(import.meta.url)

const binary = (name) =>
  resolve(root, "node_modules/.bin", process.platform === "win32" ? `${name}.cmd` : name)

const canLoadBetterSqlite3 = () =>
  spawnSync(
    binary("electron"),
    [
      "-e",
      "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.close()",
    ],
    {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "ignore",
    },
  ).status === 0

// pnpm 不把依赖平铺到 node_modules/<name>，必须按解析路径找 package.json。
const electronPkgPath = require.resolve("electron/package.json")
const electronVersion = JSON.parse(readFileSync(electronPkgPath, "utf8")).version

// Electron 42 起上游删掉了 postinstall，二进制改由使用方显式调 install-electron 下载。
// 因此 pnpm install 会干净地成功却留下一个只有 JS 壳的包，electron-vite 随后报
// 「Electron uninstall」。install-electron 自带幂等检查，已装则秒退。
// 这一步必须在下面的 stamp 短路之前：stamp 只记录 better-sqlite3 的 ABI，
// 一次重建 node_modules 就会清掉 dist/ 而 stamp 仍在。
if (!existsSync(join(dirname(electronPkgPath), "path.txt"))) {
  console.log(`下载 Electron ${electronVersion} 二进制…`)
  const download = spawnSync(binary("install-electron"), { cwd: root, stdio: "inherit" })
  if (download.error) throw download.error
  if (download.status !== 0) process.exit(download.status ?? 1)
}

const stampPath = join(root, "node_modules", ".mycontext-native-abi")
const stamp = `electron-${electronVersion}`

if (existsSync(stampPath) && readFileSync(stampPath, "utf8").trim() === stamp) {
  if (canLoadBetterSqlite3()) {
    console.log(`better-sqlite3 已是 Electron ABI（${stamp}），跳过重建`)
    process.exit(0)
  }
  console.warn(`better-sqlite3 的 ABI 标记已失效（${stamp}），重新构建`)
}

const electronHome = join(tmpdir(), "mycontext-electron-home")
mkdirSync(electronHome, { recursive: true })

const result = spawnSync(
  binary("electron-rebuild"),
  ["-f", "-w", "better-sqlite3", "-v", electronVersion],
  {
    cwd: root,
    env: { ...process.env, HOME: electronHome, USERPROFILE: electronHome },
    stdio: "inherit",
  },
)
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
if (!canLoadBetterSqlite3()) {
  console.error("better-sqlite3 重建后仍无法被 Electron 加载")
  process.exit(1)
}

writeFileSync(stampPath, stamp)
console.log(`better-sqlite3 已重建为 Electron ABI（${stamp}）`)
