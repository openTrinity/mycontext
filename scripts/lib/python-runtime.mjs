/**
 * 内置 Python 运行时：解析、下载、校验。
 *
 * ## 为什么 mycontext 要自带 Python
 *
 * kl（知识图谱）是 Python 写的。此前的做法是"用本机 python3"，在真实机器上
 * 站不住：
 *
 * · **macOS 自带的是 3.9.6，而 kl 要求 ≥3.10**（本机实测）——
 *   "有 python3"不等于"能跑 kl"；
 * · 同事机器上是 homebrew 3.13 才碰巧能用 —— 那是运气，不是设计；
 * · 打包给非开发者时更不成立：那些机器上可能根本没有 Python。
 *
 * 所以 Python 运行时**随包分发**。解析顺序与 dws 同一套思路：
 * 显式覆盖（`KL_PYTHON`）→ 内置 → 本机 python3（仅开发态兜底）。
 *
 * ## 为什么按需下载而不是入 git
 *
 * dws 入 git 的理由是"21MB 单文件、低频更新、mac arm 开发者零配置"。
 * Python 的差别是**每平台一份**（darwin-arm64/x64、win、linux），
 * 全塞进去约 4×20MB，而仓库 `.git` 现在才 20MB。
 *
 * 而它有 dws 没有的性质：**上游有稳定公开的发布地址 + 官方 SHA256SUMS**，
 * 下载后校验的完整性保证与入 git 等价，体积上却省掉四份 blob。
 * 下载一次缓存在 `vendor/python/<platform>/`（gitignore），
 * 之后所有构建与启动都命中缓存。
 *
 * ## 为什么用 python-build-standalone
 *
 * 它是 astral（uv 的作者）维护的可移植 CPython，也是 `uv python install`
 * 用的那一套。「在别人机器上能跑的 Python」有大量平台细节（rpath、SSL 证书
 * 位置、framework 布局），自己编必然踩一遍 —— 用它们已经解决过的。
 *
 * `install_only` 变体去掉了测试与调试符号，解开约 65MB。
 */
import { createHash } from "node:crypto"
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"

/**
 * 内置 Python 的版本与各平台的校验和。
 *
 * ★ 升级步骤（四件事一起改，缺一不可）：
 * 1. 改 `release` 与 `version`；
 * 2. 从上游 release 的 **`SHA256SUMS`** 资产里取新的 hash 填进 `targets`
 *    —— 不要自己下载完算一遍再填，那等于把"下载到的是什么"当成
 *    "应该是什么"，校验就没意义了；
 * 3. 删掉本地缓存 `vendor/python/` 重新验一次；
 * 4. 更新本注释里的体积数字（如有明显变化）。
 *
 * 选 3.12 而不是最新的 3.13：kl 的依赖里有带原生扩展的包
 * （numpy/scipy/qdrant-client），3.12 的 wheel 覆盖面更全 ——
 * 3.13 上偶发要现场编译，而那需要用户机器有编译工具链。
 */
export const PYTHON_RELEASE = "20260728"
export const PYTHON_VERSION = "3.12.13"

/** platform-arch → 上游文件名后缀与官方 sha256（取自 release 的 SHA256SUMS）。 */
export const PYTHON_TARGETS = {
  "darwin-arm64": {
    triple: "aarch64-apple-darwin",
    sha256: "12d6700f7e8f222639f0ee5bbd173082c3041aeb65af8f9828e4216bc8047de6",
  },
  "darwin-x64": {
    triple: "x86_64-apple-darwin",
    sha256: "21ea90aa55057e5f1d177f1f5fb2d730704f68124ca8ff40d872a81ffdf0543e",
  },
  "linux-x64": {
    triple: "x86_64-unknown-linux-gnu",
    sha256: "fd9d70e1e1ed3f6caccb4e2eefe570aa07589c8f86ddf0e87f68a96cd14272e1",
  },
  "win32-x64": {
    triple: "x86_64-pc-windows-msvc",
    sha256: "8a0e1ded37e11f4c72b9671bf134bb478b1b2d55efe53a3d6e589b166f1bf2e1",
  },
}

/** 当前平台的 target key。 */
export function platformKey() {
  const arch = process.arch === "x64" ? "x64" : process.arch
  return `${process.platform}-${arch}`
}

/** 内置 Python 的缓存根（gitignore）。 */
export function pythonCacheDir(repoRoot) {
  return join(repoRoot, "vendor", "python", platformKey())
}

/**
 * 内置解释器路径。
 *
 * 上游包解开后是 `python/bin/python3`（win 是 `python/python.exe`）——
 * 顶层那个 `python/` 目录是它自带的，不是我们加的。
 */
export function bundledPythonExe(repoRoot) {
  const base = join(pythonCacheDir(repoRoot), "python")
  return process.platform === "win32" ? join(base, "python.exe") : join(base, "bin", "python3")
}

export function hasBundledPython(repoRoot) {
  return existsSync(bundledPythonExe(repoRoot))
}

/** 上游下载地址。 */
export function downloadUrl(target) {
  const file = `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE}-${target.triple}-install_only.tar.gz`
  return {
    file,
    url: `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}/${file}`,
  }
}

/** 算文件的 sha256（流式，不把 20MB 读进内存）。 */
async function sha256Of(path) {
  const hash = createHash("sha256")
  hash.update(await readFile(path))
  return hash.digest("hex")
}

/**
 * 确保内置 Python 就绪。已就绪 → 立刻返回路径，不联网。
 *
 * @param repoRoot 仓库根
 * @param log 单参日志函数（脚本里传 console.log，服务里传 logger）
 * @returns 解释器路径；当前平台不支持或下载/校验失败 → null
 */
export async function ensureBundledPython(repoRoot, log = () => {}) {
  if (hasBundledPython(repoRoot)) return bundledPythonExe(repoRoot)

  const key = platformKey()
  const target = PYTHON_TARGETS[key]
  if (target === undefined) {
    log(`不支持的平台 ${key}：请用 KL_PYTHON 指向一个 >=3.10 的 Python。`)
    return null
  }

  const { file, url } = downloadUrl(target)
  const cacheDir = pythonCacheDir(repoRoot)
  mkdirSync(cacheDir, { recursive: true })
  const archive = join(cacheDir, file)

  // 下载（断点续传不做：20MB 失败重来一次比维护 range 请求划算）
  if (!existsSync(archive)) {
    log(`下载内置 Python ${PYTHON_VERSION}（约 20MB，仅首次）…`)
    const response = await fetch(url)
    if (!response.ok || response.body === null) {
      log(`下载失败：HTTP ${String(response.status)} ${url}`)
      return null
    }
    const temp = `${archive}.part`
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temp))
    renameSync(temp, archive)
  }

  /**
   * ★ 校验必须在解压**之前**。
   *
   * 解压一个来源不明的 tar 就已经把文件写进磁盘了 —— 那时再发现 hash 不对
   * 已经晚了。而且 hash 不对时要把归档**删掉**：留着的话下次
   * `existsSync(archive)` 命中，会永远拿那个坏包重试。
   */
  const actual = await sha256Of(archive)
  if (actual !== target.sha256) {
    rmSync(archive, { force: true })
    log(`校验失败（已删除下载文件）：期望 ${target.sha256}，实际 ${actual}`)
    return null
  }
  log(`校验通过（${(statSync(archive).size / 1024 / 1024).toFixed(1)}MB），解压…`)

  // tar 用系统的：Node 没有内置 tar，而 macOS/Linux/Win10+ 都自带 bsdtar。
  const untar = spawnSync("tar", ["-xzf", archive, "-C", cacheDir], { stdio: "inherit" })
  if (untar.status !== 0) {
    log("解压失败（tar 非零退出）。")
    return null
  }

  if (!hasBundledPython(repoRoot)) {
    log(`解压后仍找不到解释器：${bundledPythonExe(repoRoot)}（上游包结构变了？）`)
    return null
  }
  // 归档留着没用（65MB 已解开），删掉省空间。
  rmSync(archive, { force: true })
  return bundledPythonExe(repoRoot)
}
