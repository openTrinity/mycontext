/**
 * dws 二进制解析（脚本侧；运行时侧的路径解析在 packages/runtime-env/src/binaries.ts）。
 *
 * ## 两个来源，优先级不同
 *
 * 1. **`MYCONTEXT_DWS_SOURCE`** —— 显式指定一个可执行文件或其所在目录。
 *    这是**闭源版**的唯一入口：内部同学自己装好闭源 dws，把路径给进来。
 *    最高优先级，因为"我明确指了一个"必须盖过默认。
 * 2. **npm 依赖 `dingtalk-workspace-cli`（开源版，Apache-2.0）** ——
 *    默认来源。版本由 lockfile 钉住，`pnpm install` 后必然命中。
 *
 * ## ★ 为什么开源版走 npm 而不是入 git
 *
 * 二进制解开后 61MB（比闭源那份的 21MB 还大三倍）。入 git 会让仓库随每次
 * 升级线性膨胀，而"低频更新的单文件可接受"这个结论在这个体积与发版节奏下
 * 不成立。走 npm 换来三件事：
 * · 版本由 **lockfile** 管，和其它依赖同一套流程（升级在 diff 里可见）；
 * · pnpm 自动校验 tarball 的 integrity；
 * · 别人 clone 下来 `pnpm install` 就有了，不需要额外记一条命令。
 *
 * ## ★ 为什么不用它自己的 postinstall
 *
 * 那个脚本会往**用户家目录**的 16 个 agent 目录里写 skill（先删再覆盖），
 * 还写 `~/.dws/`。我们刻意不把它放进 `onlyBuiltDependencies`（见
 * pnpm-workspace.yaml 的长注释），所以 `assets/` 里的平台归档保持原样，
 * 由这里自己解 —— 与 opencode 完全同构。
 *
 * ## 校验
 *
 * 包内自带 `assets/checksums.txt`（上游发布时生成，与 GitHub Release 同一份）。
 * 解包**前**先比 sha256：一个被篡改的归档解出来的二进制会拿到我们注入的
 * 钉钉登录态，这道校验不能省。
 */
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"

const require = createRequire(import.meta.url)

/**
 * 平台 → 包内归档名。与上游 `install.js` 的 `PLATFORM_MAP` 保持一致
 * （它用 amd64/arm64 而不是 node 的 x64/arm64，这里照抄它的拼法）。
 */
const PLATFORM_ARCHIVES = {
  "darwin-x64": "dws-darwin-amd64.tar.gz",
  "darwin-arm64": "dws-darwin-arm64.tar.gz",
  "linux-x64": "dws-linux-amd64.tar.gz",
  "linux-arm64": "dws-linux-arm64.tar.gz",
  "win32-x64": "dws-windows-amd64.zip",
  "win32-arm64": "dws-windows-arm64.zip",
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** npm 包根目录。没装（或被 --ignore-scripts 之外的原因跳过）时返回 null。 */
function packageRoot() {
  try {
    return dirname(require.resolve("dingtalk-workspace-cli/package.json"))
  } catch {
    return null
  }
}

/**
 * 从 npm 包里解出当前平台的 dws，落到 `cacheDir`。
 *
 * 幂等：目标已存在且能跑就直接复用（解包 + 校验约 1s，而这个函数挂在
 * `pnpm dev` 前面，每次改一行代码重启都付这个钱不合理）。
 *
 * @returns {{ path: string, version: string } | null} null = 包没装 / 平台不支持
 */
export function resolveDwsFromNpm(cacheDir, binaryFileName) {
  const root = packageRoot()
  if (root === null) return null

  const archiveName = PLATFORM_ARCHIVES[`${process.platform}-${process.arch}`]
  if (archiveName === undefined) return null

  const archive = join(root, "assets", archiveName)
  if (!isFile(archive)) return null

  const target = join(cacheDir, binaryFileName)
  const stamp = join(cacheDir, `.${binaryFileName}.sha256`)
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex")

  // ── 校验：包内 checksums.txt 是上游发布产物，篡改必须是硬失败 ──
  const sumsPath = join(root, "assets", "checksums.txt")
  if (!isFile(sumsPath)) {
    throw new Error(`dingtalk-workspace-cli 的 assets/checksums.txt 缺失：${sumsPath}`)
  }
  const expected = readFileSync(sumsPath, "utf8")
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === archiveName)?.[0]
  if (expected === undefined) {
    throw new Error(`checksums.txt 里没有 ${archiveName} —— 上游资产命名可能变了`)
  }
  if (expected !== digest) {
    throw new Error(
      [
        `dws 归档校验失败，拒绝解包：${archive}`,
        `  期望 ${expected}`,
        `  实际 ${digest}`,
        "不要重试后忽略 —— 先确认 node_modules 是否被改动过。",
      ].join("\n"),
    )
  }

  // 已解过同一份归档 → 复用（stamp 记的是**归档**的 hash，不是产物的：
  // 产物会被 codesign 改写，拿它比永远不相等）。
  if (isFile(target) && isFile(stamp) && readFileSync(stamp, "utf8").trim() === digest) {
    return { path: target, version: readPackageVersion(root) }
  }

  mkdirSync(cacheDir, { recursive: true })
  const staging = join(cacheDir, ".extract")
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })

  const unpack = archiveName.endsWith(".zip")
    ? spawnSync("unzip", ["-o", "-q", archive, "-d", staging], { encoding: "utf8" })
    : spawnSync("tar", ["xzf", archive, "-C", staging], { encoding: "utf8" })
  if (unpack.status !== 0) {
    rmSync(staging, { recursive: true, force: true })
    throw new Error(
      `解包失败：${(unpack.stderr ?? unpack.error?.message ?? "").trim().slice(0, 300)}`,
    )
  }

  // 归档内布局可能带一层目录，递归找 `dws` / `dws.exe`（照上游 install.js 的做法）。
  const found = findBinary(staging)
  if (found === null) {
    rmSync(staging, { recursive: true, force: true })
    throw new Error(`归档里找不到可执行文件（期望 dws / dws.exe）：${archive}`)
  }

  rmSync(target, { force: true })
  spawnSync("mv", [found, target])
  rmSync(staging, { recursive: true, force: true })
  // 记归档 hash，供下次跳过解包
  writeFileSync(stamp, `${digest}\n`, "utf8")

  return { path: target, version: readPackageVersion(root) }
}

function findBinary(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = findBinary(full)
      if (nested !== null) return nested
      continue
    }
    if (entry.name === "dws" || entry.name === "dws.exe") return full
  }
  return null
}

function readPackageVersion(root) {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "unknown"
  } catch {
    return "unknown"
  }
}

/**
 * 闭源版（或任意手工指定的 dws）：`MYCONTEXT_DWS_SOURCE` 可以是可执行文件
 * 本身，也可以是它所在的目录。
 *
 * @returns {string | null} 解析到的可执行文件绝对路径
 */
export function resolveDwsFromEnv(binaryFileName, env = process.env) {
  const raw = env["MYCONTEXT_DWS_SOURCE"]
  if (raw === undefined || raw.trim() === "") return null
  let candidate = raw.trim()
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    // 目录：先按平台后缀找，再退回上游原始名 `dws`
    for (const name of [binaryFileName, process.platform === "win32" ? "dws.exe" : "dws"]) {
      const inDir = join(candidate, name)
      if (isFile(inDir)) return inDir
    }
    return null
  }
  return isFile(candidate) ? candidate : null
}
