#!/usr/bin/env node
/**
 * 备好 Electron 二进制，并为「Electron 运行时」重建 better-sqlite3（跑桌面端应用用）。
 *
 * 与 rebuild-node.mjs 互斥：两者 ABI 不同，切换用途时需重新执行对应脚本。
 *
 * ## ★★★ 为什么不用 `electron-rebuild -w better-sqlite3` 扫整棵树
 *
 * `electron-rebuild` 会沿 Node 的 module path 往上走，把
 * `$HOME/node_modules/.../better-sqlite3` 也当成要重建的副本。
 * 本机若装过别的项目的旧版，那一份没有 Electron 42+/V8 14 的兼容补丁，
 * 整次重建在那份上失败 —— 而仓库里那份其实能编过。
 *
 * 正确做法：`require.resolve` 定位**本仓库**解析到的那一份，只对它跑
 * `node-gyp rebuild`（带 electron headers）。一份、一个 ABI、不会串。
 *
 * HOME 指向临时目录：node-gyp 会在 HOME 下缓存 headers，
 * 隔离掉用户环境里可能存在的旧缓存。
 */
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const require = createRequire(import.meta.url)

/**
 * 为什么不用 node_modules/.bin 下的 .cmd shim：Node 22 在 Windows 11
 * （实测 build 26200）上直接 spawn `.cmd` 会稳定报 EINVAL（任意 .cmd 都报，
 * 而 shell:true 或 cmd.exe /c 正常）。pnpm 的 shim 内容等价于
 * `node <真实 js 入口>`，这里直接解析到 js 入口用 process.execPath 跑，
 * 行为与 shim 一致，且跨平台、跨 Node 版本稳定。
 */
const runNode = (script, args = [], opts = {}) =>
  spawnSync(process.execPath, [script, ...args], opts)

/** electron 真实二进制路径：require('electron') 在普通 node 进程里返回的就是它 */
const electronBinary = require("electron")

const canLoadBetterSqlite3 = () =>
  spawnSync(
    electronBinary,
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
// 且 Node 会从 cwd 向上找模块，用户 HOME 下若另有 better-sqlite3（常见旧版）
// 会被误用 —— 必须用 paths:[root] 钉死本仓库那一份。
const electronPkgPath = require.resolve("electron/package.json", { paths: [root] })
const electronVersion = JSON.parse(readFileSync(electronPkgPath, "utf8")).version
const betterSqlite3Dir = dirname(
  require.resolve("better-sqlite3/package.json", { paths: [root] }),
)

// Electron 42 起上游删掉了 postinstall，二进制改由使用方显式调 install-electron 下载。
// 因此 pnpm install 会干净地成功却留下一个只有 JS 壳的包，electron-vite 随后报
// 「Electron uninstall」。install-electron 自带幂等检查，已装则秒退。
// 这一步必须在下面的 stamp 短路之前：stamp 只记录 better-sqlite3 的 ABI，
// 一次重建 node_modules 就会清掉 dist/ 而 stamp 仍在。
if (!existsSync(join(dirname(electronPkgPath), "path.txt"))) {
  console.log(`下载 Electron ${electronVersion} 二进制…`)
  const download = runNode(join(dirname(electronPkgPath), "install.js"), [], {
    cwd: root,
    stdio: "inherit",
  })
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

/**
 * ★ 只重建本仓库 resolve 到的那一份（见文件头）。
 *
 * 用 `createRequire` 定位 `node-gyp/bin/node-gyp.js`，再用 `node` 跑它 ——
 * 不走 `.bin/node-gyp` 那个 shell 包装：在某些环境里 spawn 那个包装
 * 会被当成 JS 入口（Node 去 parse `#!/bin/sh` → SyntaxError）；
 * 也不走 `.cmd` shim（Windows 上 Node 直接 spawn `.cmd` 会 EINVAL）。
 */
const nodeGypJs = require.resolve("node-gyp/bin/node-gyp.js")

const result = spawnSync(process.execPath, [nodeGypJs, "rebuild", "--release"], {
  cwd: betterSqlite3Dir,
  env: {
    ...process.env,
    HOME: electronHome,
    USERPROFILE: electronHome,
    npm_config_runtime: "electron",
    npm_config_target: electronVersion,
    npm_config_disturl: "https://electronjs.org/headers",
    npm_config_arch: process.arch,
    npm_config_target_arch: process.arch,
  },
  stdio: "inherit",
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
if (!canLoadBetterSqlite3()) {
  console.error("better-sqlite3 重建后仍无法被 Electron 加载")
  process.exit(1)
}

writeFileSync(stampPath, stamp)
console.log(`better-sqlite3 已重建为 Electron ABI（${stamp}）`)
