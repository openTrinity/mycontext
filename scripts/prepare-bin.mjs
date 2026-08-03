#!/usr/bin/env node
/**
 * 准备随包分发/本地可用的可执行文件。
 *
 * 两类 binary，策略刻意不同：
 *
 * · **dws（必需，走 npm）**：开源版 `dingtalk-workspace-cli`（Apache-2.0）作为
 *   npm 依赖，版本由 lockfile 钉住，`pnpm install && pnpm prepare:bin` 零配置命中。
 *   二进制从包内 `assets/dws-<platform>.tar.gz` 解出（解包前按包内 checksums.txt
 *   校验 sha256），落到 gitignore 的缓存目录再拷进 resources/bin。
 *   **闭源版**由内部同学自行安装，用 `MYCONTEXT_DWS_SOURCE` 指路径（最高优先级）。
 *   详见 scripts/lib/dws-resolver.mjs 与 vendor/dws/README.md。
 *
 * · **opencode（可选，不内置）**：实测 102MB，且发版频率远高于 dws。
 *   入 git 会让仓库从 24MB 涨到 126MB，「低频更新的单文件可接受」这个结论
 *   在这个体积下不成立。缺失**不是错误**：应用降级到内置 harness，
 *   状态页明示「Agent 能力降级」。
 *
 * dws 的解析顺序：MYCONTEXT_DWS_SOURCE（闭源/显式覆盖）→ npm 包（开源版，默认）
 * → 报错并给可操作提示。不硬编码第三方发布目录名——那既会把商标带进代码库，
 * 也会在别人机器上必然失效。
 *
 * ## ★ 「准备好」的判据是**它真的能跑**，不是"文件在那儿"
 *
 * 每个落地的二进制都经 `installExecutable()`：unlink → copy → chmod → 重签 →
 * **spawn 一次 `--version`**。跑不起来就 exit 1。理由见那个函数的注释：
 * 这条链路的失效方式是"看起来一切正常"（文件在、有可执行位、签名 valid），
 * 只在真正执行时被内核杀掉，而症状会跑到几百行之外
 * （onboarding 说「未检测到有效登录态」、persona 静默降级成直连 LLM）。
 */
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { join, resolve } from "node:path"
import { verifyVendorIntegrity } from "./lib/vendor-integrity.mjs"
import { resolveDwsFromEnv, resolveDwsFromNpm } from "./lib/dws-resolver.mjs"
import { resolveOpencodeNpmBinary, resolveOpencodeBinary } from "./lib/opencode-resolver.mjs"

const root = resolve(import.meta.dirname, "..")
const binDir = join(root, "apps/desktop/resources/bin")
/**
 * 开源版 dws 的解包缓存（gitignore）。
 *
 * ★ 不放 `resources/bin` 里：那个目录是**产物区**，会被整体清掉重建；
 * 而这里是"从 npm 包解出来的中间物"，独立一个目录才让
 * 「npm 包 → 缓存 → resources/bin」这条链清楚，也免得每次清产物就重解一遍。
 */
const dwsCacheDir = join(root, ".dws-cache")
const vendorForge = join(root, "vendor/forge")
const forgeDir = join(root, "apps/desktop/resources/forge")
const larkPackageDir = join(root, "node_modules/@larksuite/cli")

/** 平台后缀：加 Windows 支持时只需把二进制放进 vendor，解析逻辑不用改。 */
function platformSuffix() {
  const arch = process.arch === "x64" ? "x64" : process.arch
  return `${process.platform}-${arch}`
}

function binaryFileName(name) {
  const suffix = platformSuffix()
  return process.platform === "win32" ? `${name}-${suffix}.exe` : `${name}-${suffix}`
}

// ---------------------------------------------------------------
// 落地一个可执行文件：拷 → 可执行位 → 重签 → **真跑一次**
// ---------------------------------------------------------------

/**
 * 把一个二进制**落地成能真正跑起来的样子**。
 *
 * ## ★ 为什么不是一句 copyFileSync
 *
 * 实测（本机 darwin-arm64）：`resources/bin/dws-darwin-arm64` 被 `spawn` 时
 * 拿到 **SIGKILL**，stdout/stderr 全空 —— Node 侧看到的是 `exitCode: -1`。
 * `codesign --verify` 却说 "valid on disk"，所以光校验签名看不出问题。
 * 对它执行 `codesign --force --sign -` 之后立刻恢复正常
 * （`dws auth status` 返回 `authenticated: true`）。
 *
 * 根因在 macOS 那侧：dws / opencode 都是 `adhoc, linker-signed` 的 Mach-O
 * （`codesign -dv` 的 flags=0x20002）。这类签名的哈希只覆盖文件内容，
 * 而内核 AMFI 按 vnode 缓存验证结果。往一个**已存在**的目标路径 copy 会
 * 复用同一个 inode（实测 ino 不变），于是缓存的签名与新内容对不上 ——
 * 内核直接杀，不给任何错误输出。这就是俗称的 "Killed: 9"。
 *
 * 三道措施，各治一段：
 *
 * · **先 unlink 再拷**：拿到新 inode，绕开被污染的缓存。也顺带解决"覆盖
 *   一个正在被执行/mmap 的二进制"（应用在跑时重跑 prepare:bin 会撞上）。
 * · **重签**：把签名与落地后的这份内容重新绑定。幂等、不到一秒。
 *   Windows 上没有这套机制，跳过。
 * · **真跑一次**（下面 `assertRunnable`）—— 这条才是关键。
 *
 * ## ★ 为什么必须"真跑一次"而不是只做前两件
 *
 * 上面那两条是**按理解**修的。而这条链路的失效方式是"看起来一切正常"：
 * 二进制在、有可执行位、签名 valid，只有真正 spawn 时才被杀。表现出来是
 * onboarding 里一句「授权流程结束但未检测到有效登录态，请重试」，
 * 以及 persona 静默降级成直连 LLM —— 用户完全无从判断根因在一个
 * 拷贝步骤上（真实踩过，日志里只有 `exitCode: -1` 和空的 stderr）。
 *
 * 所以：**准备阶段就把它跑一次**。跑不起来 → exit 1，在这里硬失败。
 * 这比让它进产物、几天后在别人机器上表现成"鉴权坏了"便宜几个数量级。
 */
function installExecutable({ source, target, label }) {
  mkdirSync(binDir, { recursive: true })
  if (alreadyGood({ source, target })) return "skipped"
  // ★ 先删：新 inode 绕开内核缓存的旧签名（见上）。
  if (existsSync(target)) unlinkSync(target)
  copyFileSync(source, target)
  // vendor 里那份是 644（刻意去掉可执行位），产物这份才需要可执行。
  chmodSync(target, 0o755)
  resign(target)
  assertRunnable({ target, label })
  recordPrepared({ source, target })
  return "installed"
}

/**
 * 已经落地过、且**来源没变、且真能跑** → 跳过整个拷贝。
 *
 * ## ★ 为什么需要这条快路
 *
 * 这个脚本挂在 `pnpm dev` 前面（见 package.json 的 `dev`）。全量跑一次
 * 2.3s，绝大部分花在拷 opencode 那 138MB 上 —— 每次改一行代码重启 dev
 * 都付这个钱不合理。跳过后只剩两次 `--version`（约 0.6s）。
 *
 * ## ★ 为什么记 manifest 而不是直接比源与产物的大小
 *
 * 因为**重签会改变文件大小**（实测 dws 22144066 → 22033488，
 * opencode 138608738 → 137821040：`codesign --force` 重排签名段）。
 * 于是"源与产物大小相同"这个直觉判据**永远不成立**，跳过永远不生效。
 * 所以记的是**来源的大小**，与下次的来源比。
 *
 * ## ★ 判据必须**包含"真能跑"**
 *
 * 只比来源的话，恰恰漏掉这个脚本要防的那个故障：被内核 SIGKILL 的产物
 * 来源没变（就是从它拷来的）。所以三条缺一不可，顺序按"便宜的先"：
 * manifest 命中 → 产物在 → spawn 一次。
 *
 * 不比 hash：138MB 算一遍 sha256 比直接重拷还慢。而"大小相同但内容不同"
 * 由 `verifyVendorIntegrity` 管（它校验 vendor 源，是拷贝的**上游**）。
 */
function alreadyGood({ source, target }) {
  if (!existsSync(target)) return false
  const manifest = readManifest()
  const recorded = manifest[target]
  if (recorded === undefined) return false
  if (recorded.sourceSize !== statSync(source).size) return false
  const probe = spawnSync(target, ["--version"], { encoding: "utf8", timeout: 30_000 })
  return probe.error === undefined && probe.signal === null
}

/**
 * 记「这个产物是从哪个源、多大的源拷来的」。
 *
 * 放 `resources/bin/`（gitignore 的产物目录）里 —— 删掉 bin 目录即失效，
 * 与 `pnpm setup:python` 把 marker 放进 venv 内部同一个道理：
 * marker 不该比它描述的东西活得更久。
 */
function manifestPath() {
  return join(binDir, ".prepared.json")
}

function readManifest() {
  const path = manifestPath()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    // 坏了就当没有：重拷一次的代价是 2 秒，而解析失败继续用等于信一个坏判据。
    return {}
  }
}

function recordPrepared({ source, target }) {
  const manifest = readManifest()
  manifest[target] = { source, sourceSize: statSync(source).size }
  writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
}

/**
 * 重签成 ad-hoc。macOS 专属；`codesign` 缺失时跳过而不是失败
 * —— 那说明没装 Command Line Tools，而后面的 `assertRunnable`
 * 会照样把"跑不起来"抓住，不需要在这里替它下结论。
 */
function resign(target) {
  if (process.platform !== "darwin") return
  const signed = spawnSync("codesign", ["--force", "--sign", "-", target], {
    encoding: "utf8",
  })
  if (signed.error !== undefined || signed.status !== 0) {
    console.warn(
      `  （codesign 未生效：${(signed.stderr ?? signed.error?.message ?? "").trim().slice(0, 160)}）`,
    )
  }
}

/**
 * 真跑一次，确认它**能被执行**。
 *
 * 判据刻意宽松：只要求"进程起来了且不是被信号杀掉的"。
 * 非零退出码是**允许**的 —— `dws auth status` 在未登录时就非零，
 * 那是正常业务状态，不该让 `prepare:bin` 失败。我们要抓的是
 * SIGKILL / ENOENT / EACCES 这类"这个文件根本跑不了"。
 */
function assertRunnable({ target, label }) {
  const probe = spawnSync(target, ["--version"], { encoding: "utf8", timeout: 30_000 })

  if (probe.error !== undefined) {
    fail(label, target, `无法执行：${probe.error.message}`)
  }
  if (probe.signal !== null) {
    fail(
      label,
      target,
      [
        `进程被 ${probe.signal} 杀掉（stdout/stderr 均为空是这个故障的典型表现）。`,
        "这通常是 macOS 拒绝了 ad-hoc 签名的 Mach-O。可手动确认：",
        `  codesign --force --sign - ${target} && ${target} --version`,
      ].join("\n    "),
    )
  }
}

function fail(label, target, detail) {
  console.error(`${label} 准备失败：${target}\n    ${detail}`)
  process.exit(1)
}

// ---------------------------------------------------------------
// dws：必需
// ---------------------------------------------------------------

/**
 * 找到一份可用的 dws。
 *
 * 顺序即优先级：显式指定 > npm 包。「我明确指了一个」必须盖过默认，
 * 那是内部同学用闭源版的唯一入口。
 */
function resolveDwsSource(fileName) {
  const explicit = resolveDwsFromEnv(fileName)
  if (explicit !== null) return { path: explicit, kind: "env", version: null }

  const fromNpm = resolveDwsFromNpm(dwsCacheDir, fileName)
  if (fromNpm !== null) return { path: fromNpm.path, kind: "npm", version: fromNpm.version }

  return null
}

function prepareDws() {
  const fileName = binaryFileName("dws")
  const target = join(binDir, fileName)
  const source = resolveDwsSource(fileName)

  if (source === null) {
    console.error(
      [
        `未找到 ${fileName}（当前平台：${platformSuffix()}）。`,
        "",
        "开源版随 npm 依赖分发，正常 `pnpm install` 后即可用。二选一：",
        "  1. 装依赖后重跑：pnpm install && pnpm prepare:bin",
        "  2. 用自己安装的 dws（含闭源版）：",
        "     MYCONTEXT_DWS_SOURCE=<可执行文件或其所在目录> pnpm prepare:bin",
      ].join("\n"),
    )
    process.exit(1)
  }

  mkdirSync(binDir, { recursive: true })
  const outcome = installExecutable({ source: source.path, target, label: "dws" })
  // ★ 来源必须**两种 outcome 都印**：曾经 skipped 只印「已就位」，
  // 而这个仓库的历史来源是闭源版 —— 读者会默认"还是那份闭源的"，
  // 与实际（npm 上的开源版）正好相反。复用不等于来源不重要。
  const verb = outcome === "skipped" ? "已就位" : "已准备"
  if (source.kind === "npm") {
    console.log(`${verb}（开源版 v${source.version}，来自 npm 依赖）：${target}`)
  } else {
    console.log(`${verb}：${target}\n  来源：${source.path}（MYCONTEXT_DWS_SOURCE）`)
  }
}

// ---------------------------------------------------------------
// lark-cli：官方 npm 包下载并校验的平台二进制
// ---------------------------------------------------------------

function prepareLarkCli() {
  const source = join(
    larkPackageDir,
    "bin",
    process.platform === "win32" ? "lark-cli.exe" : "lark-cli",
  )
  const target = join(binDir, binaryFileName("lark-cli"))
  if (!existsSync(source)) {
    console.error(
      [
        "未找到官方 lark-cli 平台二进制。",
        "请确认 pnpm install 没有跳过 @larksuite/cli 的 postinstall。",
        `期望位置：${source}`,
      ].join("\n"),
    )
    process.exit(1)
  }
  mkdirSync(binDir, { recursive: true })
  copyFileSync(source, target)
  chmodSync(target, 0o755)
  console.log(`已准备（官方 @larksuite/cli）：${target}`)
}

// ---------------------------------------------------------------
// forge：必需（蒸馏引擎）
// ---------------------------------------------------------------

/**
 * 把内置的 forge 源码拷进 resources。
 *
 * 与 dws 的区别在于**为什么要拷**：dws 是二进制，拷是为了加可执行位；
 * forge 是源码，拷是为了让打包态与开发态走同一条路径解析
 * （`process.resourcesPath/forge` vs 仓库内的 `resources/forge`），
 * 否则「开发能跑、打包缺文件」这类问题只会在发版后暴露。
 *
 * 解释器不在这里管：forge 只用标准库，跑它需要的 python3 由
 * packages/runtime-env 在运行时解析，缺失则降级（见那边的注释）。
 */
function prepareForge() {
  if (!existsSync(join(vendorForge, "forge", "__main__.py"))) {
    console.error(
      [
        "未找到内置的 forge 引擎：vendor/forge/forge/__main__.py",
        "蒸馏依赖它。若是有意移除，请同步改掉 distill 相关服务。",
      ].join("\n"),
    )
    process.exit(1)
  }

  // 拷贝**前**校验完整性：forge 是会被 spawn 执行的源码，
  // 被改过还继续拷等于把未审查的代码送进产物。
  const result = verifyVendorIntegrity(root, ["vendor/forge/SHA256SUMS"])
  if (!result.ok) {
    console.error("forge 完整性校验失败，拒绝拷贝：")
    for (const issue of result.issues) console.error(`  - ${issue}`)
    process.exit(1)
  }

  rmSync(forgeDir, { recursive: true, force: true })
  mkdirSync(forgeDir, { recursive: true })
  // 只拷运行需要的：引擎 + 模板。README / SHA256SUMS / 上游文档是给仓库读者的，
  // 进产物只是白占体积。
  for (const entry of ["forge", "templates"]) {
    cpSync(join(vendorForge, entry), join(forgeDir, entry), { recursive: true })
  }
  // __pycache__ 会随开发态执行生成；拷进产物会带上另一台机器的字节码路径。
  rmSync(join(forgeDir, "forge", "__pycache__"), { recursive: true, force: true })
  rmSync(join(forgeDir, "forge", "sources", "__pycache__"), {
    recursive: true,
    force: true,
  })
  console.log(`已准备（内置 forge ${readForgeVersion()}）：${forgeDir}`)
}

function readForgeVersion() {
  const path = join(vendorForge, "VERSION")
  if (!existsSync(path)) return "unknown"
  return readFileSync(path, "utf8").trim()
}

// ---------------------------------------------------------------
// opencode：从 npm 平台包拷进 resources/bin（与 dws 同一条路径逻辑）
// ---------------------------------------------------------------

/**
 * 把 npm 平台包里的 opencode 真二进制拷进 `resources/bin/opencode-<plat>-<arch>`。
 *
 * ## ★ 为什么走 resources/bin 而不是运行时直接读 node_modules
 *
 * 打包态没有 `node_modules`（electron-vite 把 JS bundle 了，pnpm 的软链
 * 布局也进不了 asar）。而 `dws` / `forge` / `kl` 全都走
 * `resources/bin`（`process.resourcesPath/bin`）—— opencode 跟上同一条，
 * dev 与打包就共用一套解析（见 `binaries.ts` 的 `bundled` 档）。
 *
 * ## ★ 为什么"没装"是硬失败，不再是"可选"
 *
 * 版本已经钉进 `package.json`，`pnpm install` 必然把当前平台那份装上。
 * 走到这里还找不到，只有两种可能：装的时候带了 `--no-optional`
 * （静默跳过平台包，只剩 8KB 启动器），或平台包安装脚本被别的东西拦了。
 * 两种都会让打出来的包**没有 Agent 能力却看起来正常**，所以在准备阶段
 * 就 exit 1 —— 与 dws 缺失同等对待。
 */
function prepareOpencode() {
  const target = join(binDir, binaryFileName("opencode"))
  const source = resolveOpencodeNpmBinary()

  if (source === null) {
    console.error(
      [
        `未找到 opencode 平台二进制（期望产物：${target}）。`,
        `当前平台：${platformSuffix()}`,
        "opencode 走 npm 依赖（package.json 已钉版本），排查：",
        "  1. 是否跑过 `pnpm install`（不带 --no-optional）？",
        "     平台包（opencode-<plat>-<arch>）是 optionalDependency，",
        "     --no-optional 会**静默**跳过它，只留 8KB 启动器。",
        "  2. 联调换版本可用：MYCONTEXT_OPENCODE_BIN=<path> 跳过 bundle 直接指向本机二进制。",
      ].join("\n"),
    )
    process.exit(1)
  }

  const outcome = installExecutable({ source, target, label: "opencode" })
  // 与 dws 同理：来源两种 outcome 都印（见 prepareDws 的注释）。
  console.log(
    `${outcome === "skipped" ? "已就位" : "已准备"}（npm opencode-ai）：${target}\n  来源：${source}`,
  )
}

// ---------------------------------------------------------------
// opencode：诊断（本机是否另有一份，仅信息，不影响 bundle）
// ---------------------------------------------------------------

function reportOpencode() {
  const resolved = resolveOpencodeBinary()
  if (resolved === null) return
  if (resolved.kind !== "npm") {
    console.log(`（另检测到 opencode，来源：${resolved.kind}）：${resolved.path}`)
  }
}

prepareDws()
prepareLarkCli()
prepareForge()
prepareOpencode()
reportOpencode()
