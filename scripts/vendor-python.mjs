#!/usr/bin/env node
/**
 * 把内置 Python 运行时下载 + 精简 + 落进 `vendor/python/<platform>/`（入 git）。
 *
 * ## 为什么 Python 要入 git
 *
 * 与 `vendor/dws` 同一个理由：**开发者不该每人配一次环境**。
 * kl（知识图谱）是 Python 写的，而"本机有没有能跑它的 Python"指望不上：
 *
 * · **macOS 自带的是 3.9.6，kl 要求 ≥3.10** —— "有 python3"≠"能跑 kl"；
 * · 同事机器上是 homebrew 3.13 才碰巧能用，那是运气不是设计；
 * · 打包给非开发者时更不成立：那些机器上可能根本没有 Python。
 *
 * 所以解释器随包分发、随 git 分发：clone 下来就能跑，不需要任何前置安装。
 *
 * ## 体积：精简到 ~43MB
 *
 * 上游 `install_only` 包解开是 75MB。这个脚本砍掉运行 kl **用不到**的部分：
 *
 * | 砍掉 | 省 | 为什么安全 |
 * | --- | --- | --- |
 * | `lib/libpython3.12.dylib` | 18MB | `bin/python3.12` 是**静态链接**的（`otool -L` 无 libpython 依赖）；实测删掉后 venv 可建、numpy 这类带 `.so` 的包可装可用 |
 * | Tcl/Tk（`tcl9.0`/`tk9.0`/`libtcl*`/`_tkinter.so`） | ~7MB | GUI 库。我们只跑无界面的 kl_server / kl_cli |
 * | `lib/python3.12/test`、`idlelib`、`turtledemo` | ~7MB | 测试套件与 IDE，运行时用不到 |
 * | `include/`、`lib/pkgconfig` | ~2MB | C 扩展**编译**期才需要；我们装的是预编译 wheel |
 * | `__pycache__` | ~15MB | 首次 import 会自动重建（且它跟绝对路径绑定，带上反而没用） |
 *
 * 结果 ~43MB，与已入 git 的 `vendor/dws`（24MB）同一数量级。
 *
 * ★ **不砍** `ssl`/`sqlite3`/`ctypes`/`zlib`/`hashlib`/`venv`：
 * 分别是 pip 出网、kl 存图、原生扩展、解压、校验、建 venv 的必需项。
 * 脚本末尾会逐个 import 验一遍 —— 砍错了当场就红，而不是等到别人机器上。
 *
 * 用法：
 *   pnpm vendor:python                    # 当前平台
 *   pnpm vendor:python --target darwin-x64  # 交叉准备别的平台（发版前）
 */
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  createWriteStream,
} from "node:fs"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"
import {
  PYTHON_RELEASE,
  PYTHON_TARGETS,
  PYTHON_VERSION,
  downloadUrl,
} from "./lib/python-runtime.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const targetArg = process.argv.indexOf("--target")
const key =
  targetArg >= 0
    ? process.argv[targetArg + 1]
    : `${process.platform}-${process.arch === "x64" ? "x64" : process.arch}`

const target = PYTHON_TARGETS[key]
if (target === undefined) {
  console.error(`✗ 未知平台 ${key}。已知：${Object.keys(PYTHON_TARGETS).join("、")}`)
  process.exit(1)
}

const outDir = join(root, "vendor", "python", key)
const pythonDir = join(outDir, "python")

if (existsSync(pythonDir) && !process.argv.includes("--force")) {
  console.log(`已存在：${pythonDir}`)
  console.log("  要重新下载请加 --force。")
  process.exit(0)
}

const { file, url } = downloadUrl(target)
mkdirSync(outDir, { recursive: true })
const archive = join(outDir, file)

if (!existsSync(archive)) {
  console.log(`下载 CPython ${PYTHON_VERSION}（${key}，约 20MB）…`)
  if (!(await download(url, archive))) {
    console.error("✗ 下载失败。GitHub 在国内常被限速/超时 —— 可以：")
    console.error(`  · 挂代理后重试（脚本走系统 curl，认 HTTPS_PROXY）`)
    console.error(`  · 或手动下载后放到 ${archive}`)
    console.error(`    ${url}`)
    process.exit(1)
  }
}

/**
 * ★ 校验必须在解压**之前**，且失败要把归档删掉。
 *
 * 解压一个来源不明的 tar 就已经把文件写进磁盘了。而不删坏包的话，
 * 下次 `existsSync(archive)` 命中，会永远拿那个坏包重试。
 */
const actual = createHash("sha256")
  .update(await readFile(archive))
  .digest("hex")
if (actual !== target.sha256) {
  rmSync(archive, { force: true })
  console.error(`✗ sha256 校验失败（已删除下载文件）`)
  console.error(`  期望 ${target.sha256}`)
  console.error(`  实际 ${actual}`)
  process.exit(1)
}
console.log("✓ sha256 校验通过（对上游 release 的 SHA256SUMS）")

rmSync(pythonDir, { recursive: true, force: true })
const untar = spawnSync("tar", ["-xzf", archive, "-C", outDir], { stdio: "inherit" })
if (untar.status !== 0) {
  console.error("✗ 解压失败")
  process.exit(1)
}
rmSync(archive, { force: true })

// ---- 精简（每一项的理由见文件头的表格）----
const before = dirSize(pythonDir)
const isWin = key.startsWith("win32")
const libDir = isWin
  ? join(pythonDir, "Lib")
  : join(pythonDir, "lib", `python${PYTHON_VERSION.split(".").slice(0, 2).join(".")}`)

for (const dir of ["test", "idlelib", "turtledemo", "tkinter", "lib2to3"]) {
  rmSync(join(libDir, dir), { recursive: true, force: true })
}
rmSync(join(pythonDir, "include"), { recursive: true, force: true })
rmSync(join(pythonDir, "share"), { recursive: true, force: true })
if (!isWin) {
  const lib = join(pythonDir, "lib")
  rmSync(join(lib, "pkgconfig"), { recursive: true, force: true })
  // 静态链接的解释器不需要 dylib（见文件头表格；实测删掉后 venv/numpy 都正常）
  rmSync(join(lib, `libpython${PYTHON_VERSION.split(".").slice(0, 2).join(".")}.dylib`), {
    force: true,
  })
  // Tcl/Tk：GUI 库，无界面用不到
  for (const entry of [
    "tcl8",
    "tcl8.6",
    "tcl9.0",
    "tk9.0",
    "itcl4.3.2",
    "thread3.0.4",
    "tdbc1.1.10",
    "sqlite3.50.4",
  ]) {
    rmSync(join(lib, entry), { recursive: true, force: true })
  }
  spawnSync("bash", ["-c", `rm -f "${lib}"/lib*tcl*.dylib "${lib}"/lib*tk*.dylib`], {
    stdio: "ignore",
  })
  spawnSync("bash", ["-c", `rm -f "${libDir}"/lib-dynload/_tkinter*.so`], { stdio: "ignore" })
}
// __pycache__ 跟绝对路径绑定，带上没用；首次 import 自动重建
spawnSync(
  "bash",
  ["-c", `find "${pythonDir}" -name __pycache__ -type d -prune -exec rm -rf {} +`],
  {
    stdio: "ignore",
  },
)

const after = dirSize(pythonDir)
console.log(`✓ 精简完成：${mb(before)} → ${mb(after)}`)

/**
 * ★ 精简完必须逐个 import 验一遍。
 *
 * 砍错一个模块的后果是"在别人机器上才炸"，而那时线索只有一个 ImportError。
 * 在这里当场验，红了就知道是上一步砍多了。
 */
const exe = isWin ? join(pythonDir, "python.exe") : join(pythonDir, "bin", "python3")
const REQUIRED = ["ssl", "sqlite3", "ctypes", "zlib", "hashlib", "venv", "json", "lzma", "bz2"]
if (key === `${process.platform}-${process.arch === "x64" ? "x64" : process.arch}`) {
  const probe = spawnSync(exe, ["-c", `import ${REQUIRED.join(", ")}; print("ok")`], {
    encoding: "utf8",
  })
  if (probe.status !== 0 || !(probe.stdout ?? "").includes("ok")) {
    console.error("✗ 精简后缺少必需模块（说明上面砍多了）：")
    console.error(`  ${(probe.stderr ?? "").trim().split("\n").slice(-3).join("\n  ")}`)
    process.exit(1)
  }
  console.log(`✓ 必需模块齐全（${REQUIRED.join(" ")}）`)
} else {
  console.log(`（交叉准备 ${key}：跳过 import 验证 —— 那个平台的二进制在本机跑不了）`)
}

// 版本戳：升级时比对用（与 vendor/dws/VERSION 同一套约定）
writeFileSync(join(outDir, "VERSION"), `${PYTHON_VERSION}+${PYTHON_RELEASE}\n`, "utf8")
console.log(`✓ 完成：${pythonDir}`)
console.log(`  这个目录**入 git** —— clone 下来即可用，不需要任何前置安装。`)

/**
 * 下载。先试 `fetch`，失败退回系统 `curl`。
 *
 * ★ 为什么要 curl 兜底：GitHub release 在国内网络下 `fetch` 频繁
 * `UND_ERR_CONNECT_TIMEOUT`（本机实测），而同一个地址 curl 能过 ——
 * curl 会认 `HTTPS_PROXY`/`ALL_PROXY` 这类系统代理变量、也有自己的重试。
 * 这一步失败就等于"新机器装不上"，所以值得两条路。
 */
async function download(url, dest) {
  const temp = `${dest}.part`
  try {
    const response = await fetch(url)
    if (response.ok && response.body !== null) {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temp))
      renameSync(temp, dest)
      return true
    }
  } catch {
    // 落到 curl
  }
  rmSync(temp, { force: true })
  console.log("  fetch 失败，改用 curl（会认系统代理）…")
  const curl = spawnSync(
    "curl",
    ["-fsSL", "--retry", "3", "--retry-delay", "2", "--connect-timeout", "20", "-o", temp, url],
    { stdio: "inherit" },
  )
  if (curl.status !== 0) {
    rmSync(temp, { force: true })
    return false
  }
  renameSync(temp, dest)
  return true
}

function dirSize(dir) {
  const out = spawnSync("du", ["-sk", dir], { encoding: "utf8" })
  return Number.parseInt((out.stdout ?? "0").trim().split(/\s+/)[0] ?? "0", 10)
}
function mb(kb) {
  return `${(kb / 1024).toFixed(0)}MB`
}
