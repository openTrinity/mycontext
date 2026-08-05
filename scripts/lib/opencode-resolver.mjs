/**
 * opencode 二进制解析（脚本侧；运行时侧在 packages/runtime-env/src/binaries.ts）。
 *
 * ## ★ 现在的真源是 npm 依赖，不再是"本机装的那份"
 *
 * `opencode-ai` 在 npm 上：主包是个 ~8KB 的启动器，真二进制走
 * `optionalDependencies` 的平台包（`opencode-darwin-arm64` 等，实测 138MB）。
 * `package.json` 里精确钉了版本，`pnpm install` 会把对应平台那份装进
 * `node_modules/.pnpm/opencode-<plat>-<arch>@<ver>/node_modules/.../bin/opencode`。
 *
 * 这样**版本由 lockfile 决定，与用户本机装了什么无关** —— 那正是我们要的：
 * 低版本 opencode（<1.2.23）的 ACP 前端调本地 server 时不带鉴权头，
 * 会被我们注入的 `OPENCODE_SERVER_PASSWORD` 401 掉（`session/new` 报 -32603），
 * 而 lockfile 钉住的版本永远在门槛之上。
 *
 * ## 为什么不靠 opencode 自己的 postinstall
 *
 * 它的 `bin/opencode.exe` 是个占位脚本，靠 `postinstall.mjs` 换成真二进制。
 * 而 pnpm 默认**不跑** optionalDependency 的 install 脚本（实测：
 * `Ignored build scripts: opencode-ai`）—— 跑那个占位脚本只会打印
 * "postinstall 没跑"然后 exit 1。所以我们**绕过启动器**，直接找平台包里的
 * 真二进制并（由 prepare-bin）拷进 `resources/bin/`，与 `dws` 完全同一条路径逻辑。
 *
 * ## 平台包的挑选（照搬 opencode postinstall 的判据）
 *
 * x64 上分 `baseline`（无 AVX2）与普通两种；linux 还分 musl。arm64 只有一种。
 * 这里复刻它的选择顺序，避免在老 CPU 上装了会 SIGILL 的普通版。
 *
 * ## 解析顺序
 *
 *   1. MYCONTEXT_OPENCODE_BIN  显式指定的**文件**，最高优先级（联调换版本用）
 *   2. npm 平台包            真源，`pnpm install` 后必然命中
 *   3. ~/.opencode/bin       本机装的那份（仅当上面都没有时的兜底）
 *   4. PATH 里的 opencode
 *
 * 都没有 → 返回 null。对**准备脚本**是硬失败（见 prepare-bin.mjs），
 * 对**运行时**是降级到内置 harness（见 binaries.ts）。
 */
import { createRequire } from "node:module"
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, join } from "node:path"

const require = createRequire(import.meta.url)

const EXE = process.platform === "win32" ? "opencode.exe" : "opencode"

function isExecutableFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * 当前平台对应的**平台包名候选**，按优先级排列。
 *
 * 与 opencode 的 `postinstall.mjs::packageNames()` 同一套判据 ——
 * 保持一致才不会在老 CPU（无 AVX2）上挑到会崩的普通版。
 */
function platformPackageNames() {
  const platformMap = { darwin: "darwin", linux: "linux", win32: "windows" }
  const archMap = { x64: "x64", arm64: "arm64", arm: "arm" }
  const platform = platformMap[process.platform] ?? process.platform
  const arch = archMap[process.arch] ?? process.arch
  const base = `opencode-${platform}-${arch}`

  if (arch !== "x64") {
    // arm64 / arm：linux 上有 musl 变体，其余只有一种。
    if (platform === "linux") return [base, `${base}-musl`]
    return [base]
  }

  // x64：baseline = 无 AVX2 的保守版。挑不准时**优先 baseline**
  // （在支持 AVX2 的机器上跑 baseline 只是慢一点，反过来会 SIGILL）。
  const baseline = !supportsAvx2()
  if (platform === "linux") {
    if (isMusl()) {
      return baseline
        ? [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base]
        : [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`]
    }
    return baseline
      ? [`${base}-baseline`, base, `${base}-baseline-musl`, `${base}-musl`]
      : [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`]
  }
  // darwin / windows x64
  return baseline ? [`${base}-baseline`, base] : [base, `${base}-baseline`]
}

function supportsAvx2() {
  if (process.arch !== "x64") return false
  try {
    if (process.platform === "linux") {
      return /(^|\s)avx2(\s|$)/i.test(readFileSync("/proc/cpuinfo", "utf8"))
    }
    if (process.platform === "darwin") {
      const cp = require("node:child_process")
      const out = cp.spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], {
        encoding: "utf8",
        timeout: 1500,
      })
      return out.status === 0 && (out.stdout || "").trim() === "1"
    }
  } catch {
    return false
  }
  // windows x64：探测成本高，保守当作不支持 → 走 baseline（能跑，慢一点）。
  return false
}

function isMusl() {
  if (process.platform !== "linux") return false
  try {
    if (existsSync("/etc/alpine-release")) return true
    const cp = require("node:child_process")
    const out = cp.spawnSync("ldd", ["--version"], { encoding: "utf8" })
    return `${out.stdout || ""}${out.stderr || ""}`.toLowerCase().includes("musl")
  } catch {
    return false
  }
}

/**
 * 从 npm 平台包里找那个真二进制。
 *
 * ## ★ 必须**从 `opencode-ai` 的上下文**解析，不能从这里直接 resolve
 *
 * `hoist=false` 下，平台包（`opencode-darwin-arm64`）只是 `opencode-ai` 的
 * optionalDependency，**不是**根的依赖 —— 从本文件 `require.resolve` 它必然
 * `MODULE_NOT_FOUND`（实测）。而从 `opencode-ai/package.json` 所在目录建一个
 * `createRequire` 再 resolve 就能命中 `.pnpm/<pkg>@<ver>/node_modules/<pkg>/`。
 *
 * 用 `require.resolve` 而不是拼路径：pnpm 的软链布局下拼路径必然错。
 *
 * @returns {string | null} 真二进制的绝对路径
 */
export function resolveOpencodeNpmBinary() {
  const sourceBinary = process.platform === "win32" ? "opencode.exe" : "opencode"
  let fromLauncher
  try {
    // 平台包挂在 opencode-ai 名下，所以要从它的上下文解析。
    fromLauncher = createRequire(require.resolve("opencode-ai/package.json"))
  } catch {
    return null
  }
  for (const name of platformPackageNames()) {
    try {
      const pkgJson = fromLauncher.resolve(`${name}/package.json`)
      const bin = join(dirname(pkgJson), "bin", sourceBinary)
      if (isExecutableFile(bin)) return bin
    } catch {
      // 这个平台包没装（不是当前平台，或 --no-optional）——试下一个候选。
    }
  }
  return null
}

/**
 * @returns {{ path: string, kind: "env" | "npm" | "home" | "path" } | null}
 */
export function resolveOpencodeBinary(env = process.env) {
  const explicit = env["MYCONTEXT_OPENCODE_BIN"]
  if (explicit !== undefined && explicit !== "" && isExecutableFile(explicit)) {
    return { path: explicit, kind: "env" }
  }

  const npmBin = resolveOpencodeNpmBinary()
  if (npmBin !== null) return { path: npmBin, kind: "npm" }

  const home = join(homedir(), ".opencode", "bin", EXE)
  if (isExecutableFile(home)) return { path: home, kind: "home" }

  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (dir === "") continue
    const candidate = join(dir, EXE)
    if (existsSync(candidate) && isExecutableFile(candidate)) {
      return { path: candidate, kind: "path" }
    }
  }

  return null
}
