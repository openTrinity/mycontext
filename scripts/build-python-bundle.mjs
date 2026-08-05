#!/usr/bin/env node
/**
 * 构建期：把打包用的 Python 树**压平成一个自包含解释器**。
 *
 * 产物：`apps/desktop/resources/python/<platform>/python/…`（gitignore，
 * 与 `resources/bin`、`resources/forge` 同性质 —— 都是构建产物目录）。
 *
 * ## ★★ 为什么打包态不能直接拷 `vendor/python/<plat>`（venv 那一层是毒）
 *
 * 开发态跑的是 `vendor/python/<plat>/venv`，而 venv **只有 site-packages、
 * 没有标准库** —— 它靠 `pyvenv.cfg` 里这一行去解释器那边借：
 *
 * ```
 * home = /Users/<构建机用户>/Projects/mycontext/vendor/python/darwin-arm64/python/bin
 * ```
 *
 * 那是**构建机的绝对路径**。实测（三组）：
 *   ① 把整棵树拷到别处 → `sys.base_prefix` **仍指向原仓库**；
 *   ② 把 home 改成不存在的路径 → 解释器直接起不来：
 *      `Could not find platform independent libraries <prefix>`；
 *   ③ 把 home 改对 → 恢复正常。
 *
 * 也就是说 venv 一定要"改指针"才能换机器。而改指针 = 往 .app 内部写文件：
 * 破坏代码签名，且 Gatekeeper 隔离（translocation）会把 app 挂到一个随机
 * 只读路径，根本写不进去。
 *
 * ## 解法：去掉 venv 那一层
 *
 * 与 `llm-gateway/src/llm-gateway-desktop` 同一个结论（它踩过同样的坑，
 * `scripts/setup-win-python.mjs` 头注释原文）：
 *
 * > `--relocatable` is named misleadingly: it lets you MOVE the venv on disk,
 * > but does not relax the base-interpreter dependency. **The fix is to drop
 * > the venv layer entirely** and ship a real, self-contained Python instead.
 *
 * 而**裸解释器本来就自定位**（python-build-standalone 的设计：`sys.prefix`
 * 跟着自己的位置走）。所以把 venv 的 `site-packages` 拷进解释器自己那份，
 * venv 就不需要了。实测（含整棵树改名以模拟 app 被挪）：
 * ```
 * 全部依赖可导入
 * base_prefix = /private/tmp/novenv-moved/python
 * ```
 * **零环境变量、零改写文件。** 体积还小一点（437M vs 443M —— 少一份
 * site-packages）。
 *
 * ## 全程零联网
 *
 * 依赖包（400M / 154 项）已经入 git，这里只是把它们从
 * `venv/lib/pythonX/site-packages/` 拷到 `python/lib/pythonX/site-packages/`。
 * 一个字节都不下载 —— 这是刻意的约束（用户机器上不该有网络依赖）。
 *
 * ## ★ 为什么要校验完整性（而不是拷完就算）
 *
 * 少一个包时**应用照样起、界面照样正常**，只是 kl 一调就崩 —— 而那时人已经
 * 在同事的机器上，没有构建日志。这是本项目里最典型的静默失败形态，所以这里
 * 按 `requirements.txt` 逐项验 distribution，缺任何一项就 fail。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join, resolve } from "node:path"
import { isPythonEnvReady, requirementFiles, venvDir } from "./lib/python-env.mjs"
import { platformKey, pythonCacheDir } from "./lib/python-runtime.mjs"

const root = resolve(import.meta.dirname, "..")
const plat = platformKey()

/** 产出目录：`resources/python/<platform>`（extraResources 的 `from`）。 */
const outRoot = join(root, "apps/desktop/resources/python", plat)
const outPython = join(outRoot, "python")

function fail(message) {
  console.error(`[build-python-bundle] 失败：${message}`)
  process.exit(1)
}

function log(message) {
  console.log(`[build-python-bundle] ${message}`)
}

/** 目录体积（MB），只为日志好看 —— 打包体积是要被追踪的数字。 */
function sizeMb(dir) {
  const result = spawnSync("du", ["-sm", dir], { encoding: "utf8" })
  const n = Number.parseInt((result.stdout ?? "").trim().split(/\s+/)[0] ?? "", 10)
  return Number.isFinite(n) ? n : 0
}

// ── ① 前置：开发态环境必须就绪 ─────────────────────────────────────
//
// 不就绪就产出，等于打一个缺依赖的包 —— 而那要到同事机器上才暴露。
if (!isPythonEnvReady(root)) {
  fail(
    "内置 Python 环境还没就绪（venv 缺失或依赖指纹不匹配）。\n" +
      "  先跑：pnpm setup:python\n" +
      "  理由：打包要从那个 venv 里取 site-packages；不就绪就产出会打出一个" +
      "缺依赖的包，而它只在运行 kl 时才崩。",
  )
}

const srcInterpreter = join(pythonCacheDir(root), "python")
if (!existsSync(srcInterpreter)) fail(`找不到内置解释器：${srcInterpreter}`)

// site-packages 的位置随小版本变（python3.12 → 3.13），所以扫出来而不是写死。
function findSitePackages(base) {
  const libDir = join(base, "lib")
  if (!existsSync(libDir)) return null
  for (const entry of readdirSync(libDir)) {
    if (!entry.startsWith("python")) continue
    const candidate = join(libDir, entry, "site-packages")
    if (existsSync(candidate)) return candidate
  }
  return null
}

const srcSitePackages = findSitePackages(venvDir(root))
if (srcSitePackages === null) fail(`venv 里找不到 site-packages：${venvDir(root)}`)

// ── ② 拷解释器 ───────────────────────────────────────────────────
rmSync(outRoot, { recursive: true, force: true })
mkdirSync(outRoot, { recursive: true })
log(`拷解释器 ${srcInterpreter} → ${outPython}`)
// dereference:false —— 解释器内部有相对软链（bin/python3 → python3.12），
// 解开会把同一个二进制复制多份（+40MB）而且失去"改一处即生效"的语义。
cpSync(srcInterpreter, outPython, { recursive: true, verbatimSymlinks: true })

// ── ③ 把 venv 的 site-packages 压平进解释器自己那份 ────────────────
const dstSitePackages = findSitePackages(outPython)
if (dstSitePackages === null) fail(`产物解释器里找不到 site-packages：${outPython}`)
log(`压平依赖 ${srcSitePackages} → ${dstSitePackages}`)
cpSync(srcSitePackages, dstSitePackages, { recursive: true, verbatimSymlinks: true })

// ── ④ 剔掉 __pycache__ / *.pyc ────────────────────────────────────
//
// 它们是**路径相关**的编译缓存（.pyc 里烧着源文件的绝对路径），拷到别的机器
// 上无效还占体积。而且仓库有一条门禁（check:vendor-clean）盯着 vendor 里的
// __pycache__ —— 产物目录不在它管辖范围，但同一个理由成立。
let pruned = 0
function prune(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "__pycache__") {
        rmSync(full, { recursive: true, force: true })
        pruned += 1
        continue
      }
      prune(full)
    } else if (entry.name.endsWith(".pyc")) {
      rmSync(full, { force: true })
      pruned += 1
    }
  }
}
prune(outPython)
log(`剔掉 ${String(pruned)} 处 __pycache__/*.pyc`)

// ── ⑤ ★ 自包含性验证：不设任何环境变量,能不能自己跑起来 ────────────
//
// 这是"去掉 venv"这个决定的**唯一**验收点。base_prefix 必须落在产物目录里 ——
// 落在仓库里就说明还在依赖构建机（正是我们要消灭的那件事）。
const exe = join(outPython, process.platform === "win32" ? "python.exe" : "bin/python3")
if (!existsSync(exe)) fail(`产物里没有解释器可执行文件：${exe}`)

const selfCheck = spawnSync(exe, ["-c", "import sys; print(sys.base_prefix); print(sys.prefix)"], {
  encoding: "utf8",
  // ★ 显式清掉这三个：构建机的 shell 里可能有它们，而我们要验的恰恰是
  // "什么都不给的情况下它自己知道自己在哪"。
  env: { ...process.env, PYTHONHOME: undefined, PYTHONPATH: undefined, VIRTUAL_ENV: undefined },
  timeout: 30_000,
})
if (selfCheck.status !== 0) {
  fail(`产物解释器起不来：${(selfCheck.stderr ?? "").slice(-500)}`)
}
const [basePrefix = ""] = (selfCheck.stdout ?? "").trim().split("\n")
if (!basePrefix.startsWith(outPython) && !resolve(basePrefix).startsWith(resolve(outPython))) {
  fail(
    `产物解释器的 base_prefix 不在产物目录里：\n` +
      `  实际 ${basePrefix}\n  期望以 ${outPython} 开头\n` +
      `  这意味着它仍然依赖构建机上的路径 —— 换机器就会起不来。`,
  )
}
log(`自包含性 OK（base_prefix=${basePrefix}）`)

// ── ⑥ ★ 依赖完整性：按 requirements 逐项验 ────────────────────────
//
// 少一个包时应用照样起、界面照样正常,只是 kl 一调就崩 —— 见文件头。
const reqFiles = requirementFiles(root)
if (reqFiles.length === 0) fail("找不到任何 requirements 文件")

const verify = spawnSync(
  exe,
  [
    "-c",
    `
import importlib.metadata as md, pathlib, sys
files = sys.argv[1:]
want = []
for f in files:
    for line in pathlib.Path(f).read_text().splitlines():
        line = line.split("#")[0].strip()
        if not line or line.startswith("-"):
            continue
        name = line.split("==")[0].split(">=")[0].split("<")[0].split("[")[0].strip()
        if name:
            want.append(name)
have = {d.metadata["Name"].lower().replace("_", "-") for d in md.distributions() if d.metadata["Name"]}
missing = [w for w in want if w.lower().replace("_", "-") not in have]
print("REQ", len(want))
print("HAVE", len(have))
print("MISSING", ",".join(missing))
`,
    ...reqFiles,
  ],
  { encoding: "utf8", timeout: 60_000 },
)
if (verify.status !== 0) fail(`依赖校验跑不起来：${(verify.stderr ?? "").slice(-500)}`)

const out = verify.stdout ?? ""
const missing = (/^MISSING (.*)$/m.exec(out)?.[1] ?? "").trim()
const reqCount = /^REQ (\d+)$/m.exec(out)?.[1] ?? "?"
const haveCount = /^HAVE (\d+)$/m.exec(out)?.[1] ?? "?"
if (missing !== "") {
  fail(
    `压平后缺依赖：${missing}\n` +
      `  这会让应用照常启动、但 kl 一调就崩（而那时人在别人的机器上）。\n` +
      `  先跑 pnpm setup:python 补齐，再重新打包。`,
  )
}
log(`依赖完整性 OK（requirements ${reqCount} 条 / 已装 ${haveCount} 个 distribution）`)

log(`产物：${outRoot}（${String(sizeMb(outRoot))}MB）`)
if (!statSync(outPython).isDirectory()) fail("产物结构异常")
