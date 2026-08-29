#!/usr/bin/env node
/**
 * 在 macOS / Linux 上交叉打 Windows x64 包（unpacked `win-unpacked`）。
 *
 * 顺序刻意固定（每一步失败就停）：
 *   1. vendor:python --target win32-x64   （解释器；无则下载）
 *   2. prepare-bin --target win32-x64     （dws / lark / forge）
 *   3. build-python-bundle --target …    （uv 交叉装 wheel → 压平产物）
 *   4. 换上 better-sqlite3 的 win32 Electron 预编译 .node
 *      （node-gyp **不能**交叉编译；没有预编译就硬失败）
 *   5. electron-vite build
 *   6. electron-builder --win --dir（npmRebuild=false，避免再触发 gyp）
 *   7. 还原本机 better-sqlite3 .node（别把 win 的 .node 留给接下来的 mac 开发）
 *
 * ★ 本机验不了 PE：Python / 二进制的「真能跑」留给 Windows 真机或 CI。
 * ★ 无 Wine 时 electron-builder 关了 signAndEditExecutable（见 yml）。
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"

const root = resolve(fileURLToPath(import.meta.url), "..", "..")
const TARGET = "win32-x64"
const require = createRequire(import.meta.url)

function run(label, command, args) {
  console.log(`\n══ ${label} ══`)
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    shell: false,
  })
  if (result.status !== 0) {
    const err = new Error(`${label} 失败（exit ${String(result.status)}）`)
    err.exitCode = result.status ?? 1
    throw err
  }
}

function runNode(label, script, extraArgs = []) {
  run(label, process.execPath, [join(root, script), ...extraArgs])
}

/**
 * Electron 的 NODE_MODULE_VERSION（ABI）。better-sqlite3 预编译文件名用
 * `electron-v{abi}`。对不上就 dlopen 失败 —— 不能猜。
 */
function electronAbi() {
  const electronPath = dirname(require.resolve("electron/package.json"))
  const probe = spawnSync(
    process.execPath,
    [join(electronPath, "cli.js"), "-e", "process.stdout.write(process.versions.modules)"],
    {
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 30_000,
    },
  )
  const abi = (probe.stdout ?? "").trim()
  if (probe.status !== 0 || !/^\d+$/.test(abi)) {
    console.error("✗ 读不到 Electron ABI（process.versions.modules）")
    process.exit(1)
  }
  return abi
}

/**
 * 把 better-sqlite3 的 win32-x64 Electron 预编译 .node 落到 build/Release，
 * 返回「还原本机 .node」的函数。
 */
function swapBetterSqlite3WinNode() {
  const pkgRoot = dirname(require.resolve("better-sqlite3/package.json"))
  const version = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version
  const abi = electronAbi()
  const releaseDir = join(pkgRoot, "build", "Release")
  const nodePath = join(releaseDir, "better_sqlite3.node")
  if (!existsSync(nodePath)) {
    console.error(`✗ 本机 better-sqlite3.node 不存在：${nodePath}（先 pnpm native:electron）`)
    process.exit(1)
  }

  const backupDir = mkdtempSync(join(tmpdir(), "mycontext-bs3-"))
  const backupNode = join(backupDir, "better_sqlite3.node")
  copyFileSync(nodePath, backupNode)

  /**
   * ★ npm 上的版本与 GitHub Release 预编译不一定对齐。
   * 实测：Electron 43 → ABI 148，npm 最新 12.x 是 12.11.1（无 v148 win 预编译），
   * 而 GitHub 上有未进 npm 的 v12.12.0 预编译。所以按「本机版本 → 邻近 patch」试下载。
   */
  const versionCandidates = [version, "12.12.0", "12.11.1"]
  const staging = mkdtempSync(join(tmpdir(), "mycontext-bs3-dl-"))
  let archive = null
  let usedUrl = null
  console.log(`\n══ better-sqlite3 win prebuild（ABI ${abi}）══`)
  for (const ver of [...new Set(versionCandidates)]) {
    const asset = `better-sqlite3-v${ver}-electron-v${abi}-win32-x64.tar.gz`
    const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${ver}/${asset}`
    const dest = join(staging, asset)
    console.log(`  试 ${url}`)
    const curl = spawnSync(
      "curl",
      ["-fsSL", "--retry", "2", "--retry-delay", "1", "--connect-timeout", "20", "-o", dest, url],
      { stdio: "pipe", encoding: "utf8" },
    )
    if (curl.status === 0 && existsSync(dest) && readFileSync(dest).byteLength > 1000) {
      archive = dest
      usedUrl = url
      break
    }
    rmSync(dest, { force: true })
  }
  if (archive === null) {
    console.error(
      [
        `✗ 找不到 electron-v${abi} 的 win32-x64 预编译（试过 ${versionCandidates.join(", ")}）。`,
        "  选项：等 better-sqlite3 发预编译，或在 Windows 真机上打包（可本地 node-gyp）。",
      ].join("\n"),
    )
    process.exit(1)
  }
  console.log(`  命中 ${usedUrl}`)
  const unpack = spawnSync("tar", ["xzf", archive, "-C", staging], { encoding: "utf8" })
  if (unpack.status !== 0) {
    console.error("✗ 解压 better-sqlite3 预编译失败")
    process.exit(1)
  }
  // 归档内通常是 build/Release/better_sqlite3.node
  const candidates = [
    join(staging, "build", "Release", "better_sqlite3.node"),
    join(staging, "better_sqlite3.node"),
  ]
  const winNode = candidates.find((p) => existsSync(p))
  if (winNode === undefined) {
    console.error("✗ 预编译归档里找不到 better_sqlite3.node")
    process.exit(1)
  }
  mkdirSync(releaseDir, { recursive: true })
  copyFileSync(winNode, nodePath)
  console.log(
    `  已换上 win32 .node（${createHash("sha256").update(readFileSync(nodePath)).digest("hex").slice(0, 12)}…）`,
  )
  rmSync(staging, { recursive: true, force: true })

  return () => {
    copyFileSync(backupNode, nodePath)
    rmSync(backupDir, { recursive: true, force: true })
    console.log("  已还原本机 better-sqlite3.node")
  }
}

console.log(
  `MyContext Windows 交叉打包（目标 ${TARGET}，宿主 ${process.platform}-${process.arch}）`,
)

runNode("vendor python", "scripts/vendor-python.mjs", ["--target", TARGET])
runNode("prepare bin", "scripts/prepare-bin.mjs", ["--target", TARGET])
runNode("python bundle", "scripts/build-python-bundle.mjs", ["--target", TARGET])

const winPy = join(root, "apps/desktop/resources/python", TARGET, "python")
if (!existsSync(winPy)) {
  console.error(`✗ 压平产物不存在：${winPy}`)
  process.exit(1)
}

const restoreNative = swapBetterSqlite3WinNode()
let exitCode = 0
try {
  run("electron-vite build", "pnpm", [
    "--filter",
    "@mycontext/desktop",
    "exec",
    "electron-vite",
    "build",
  ])
  run("electron-builder", "pnpm", [
    "exec",
    "electron-builder",
    "--win",
    "--x64",
    "--dir",
    "--config",
    "apps/desktop/electron-builder.yml",
    "-c.npmRebuild=false",
  ])
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
  exitCode = err instanceof Error && "exitCode" in err ? Number(err.exitCode) || 1 : 1
} finally {
  try {
    restoreNative()
  } catch (restoreErr) {
    console.error("✗ 还原 better-sqlite3.node 失败——请手动 pnpm native:electron", restoreErr)
    exitCode = 1
  }
}

if (exitCode !== 0) process.exit(exitCode)

console.log(`\n✓ Windows 包：${join(root, "apps/desktop/release/win-unpacked")}`)
console.log("  未签名；请在 Windows 上验证启动与 kl / dws。")
