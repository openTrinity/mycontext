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
 * ## 全程零联网（本机平台）
 *
 * 依赖包（400M / 154 项）已经入 git，这里只是把它们从
 * `venv/lib/pythonX/site-packages/` 拷到 `python/lib/pythonX/site-packages/`。
 * 一个字节都不下载 —— 这是刻意的约束（用户机器上不该有网络依赖）。
 *
 * ## ★ 交叉打包（`--target win32-x64`）
 *
 * 本机跑不了目标平台的解释器，也没有入 git 的 win32 venv。路径改成：
 *   1. 要求 `vendor/python/<target>/python` 已由 `pnpm vendor:python --target` 落地；
 *   2. 用 `uv pip install --python-platform … --target <site-packages>` 拉
 *      **预编译 wheel**（不执行目标 python）；
 *   3. 跳过 spawn 自检（PE 在 mac 上跑不了）—— 只验目录里有关键包。
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
const targetArg = process.argv.indexOf("--target")
const plat =
  targetArg >= 0 && process.argv[targetArg + 1] ? process.argv[targetArg + 1] : platformKey()
const hostPlat = platformKey()
const isCross = plat !== hostPlat
const isWin = plat.startsWith("win32")

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

/**
 * site-packages 位置随小版本变（python3.12 → 3.13），所以扫出来而不是写死。
 *
 * Unix venv: `lib/pythonX.Y/site-packages`;
 * Windows venv: `Lib/site-packages`（没有 pythonX.Y 这一层）。
 *
 * 不能只按当前进程的 `process.platform` 猜路径：这个函数同时查开发态
 * venv 与刚复制出的裸解释器，且 Windows 的大小写目录名也不同。
 */
function findSitePackages(base) {
  for (const libName of ["lib", "Lib"]) {
    const libDir = join(base, libName)
    if (!existsSync(libDir)) continue

    const direct = join(libDir, "site-packages")
    if (existsSync(direct)) return direct

    for (const entry of readdirSync(libDir)) {
      if (!entry.toLowerCase().startsWith("python")) continue
      const candidate = join(libDir, entry, "site-packages")
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

function prunePyc(dir) {
  let pruned = 0
  function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "__pycache__") {
          rmSync(full, { recursive: true, force: true })
          pruned += 1
          continue
        }
        walk(full)
      } else if (entry.name.endsWith(".pyc")) {
        rmSync(full, { force: true })
        pruned += 1
      }
    }
  }
  walk(dir)
  return pruned
}

function uvPythonPlatform(key) {
  // uv 的 --python-platform 用的是 rustc/llvm 风格 triple，不是 node 的 plat-arch。
  const map = {
    "win32-x64": "x86_64-pc-windows-msvc",
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
  }
  return map[key]
}

// ── 交叉：用 uv 往目标解释器的 site-packages 装 wheel ────────────────
if (isCross) {
  log(`交叉构建 ${plat}（宿主 ${hostPlat}）`)
  const srcInterpreter = join(pythonCacheDir(root, plat), "python")
  if (!existsSync(srcInterpreter)) {
    fail(
      `找不到目标平台解释器：${srcInterpreter}\n` + `  先跑：pnpm vendor:python --target ${plat}`,
    )
  }
  const uvPlat = uvPythonPlatform(plat)
  if (uvPlat === undefined) fail(`未知交叉平台 ${plat}（无对应 uv --python-platform）`)

  const reqFiles = requirementFiles(root)
  if (reqFiles.length === 0) fail("找不到任何 requirements 文件")

  rmSync(outRoot, { recursive: true, force: true })
  mkdirSync(outRoot, { recursive: true })
  log(`拷解释器 ${srcInterpreter} → ${outPython}`)
  cpSync(srcInterpreter, outPython, { recursive: true, verbatimSymlinks: true })

  // Windows 布局：确保 Lib/site-packages 存在；Unix 用 findSitePackages。
  let dstSite = findSitePackages(outPython)
  if (dstSite === null && isWin) {
    dstSite = join(outPython, "Lib", "site-packages")
    mkdirSync(dstSite, { recursive: true })
  }
  if (dstSite === null) fail(`产物解释器里找不到 / 建不出 site-packages：${outPython}`)

  // 清掉解释器自带的空/半空 site-packages，再让 uv 写入。
  rmSync(dstSite, { recursive: true, force: true })
  mkdirSync(dstSite, { recursive: true })

  const uvArgs = [
    "pip",
    "install",
    "--python-version",
    "3.12",
    "--python-platform",
    uvPlat,
    "--target",
    dstSite,
    "--no-compile",
  ]
  for (const f of reqFiles) {
    uvArgs.push("-r", f)
  }
  log(`uv ${uvArgs.join(" ")}`)
  const install = spawnSync("uv", uvArgs, { stdio: "inherit", cwd: root })
  if (install.status !== 0) {
    fail(`uv pip install 交叉安装失败（exit ${String(install.status)}）`)
  }

  const pruned = prunePyc(outPython)
  log(`剔掉 ${String(pruned)} 处 __pycache__/*.pyc`)

  // 交叉无法 spawn PE：用目录探针验关键包（与 hasFlattenedPython 同口径）。
  const probePkg = join(dstSite, "qdrant_client")
  const probeAlt = join(dstSite, "fastapi")
  if (!existsSync(probePkg) && !existsSync(probeAlt)) {
    fail(
      `交叉安装后 site-packages 里找不到 qdrant_client / fastapi：${dstSite}\n` +
        `  说明 uv 没把依赖写进去，或路径布局不对。`,
    )
  }
  log(`目录探针 OK（site-packages 含关键包）`)
  log(`产物：${outRoot}（${String(sizeMb(outRoot))}MB）· ★ 未在本机执行解释器（交叉）`)
  if (!statSync(outPython).isDirectory()) fail("产物结构异常")
  process.exit(0)
}

// ── 本机平台：从入 git 的 venv 压平 ─────────────────────────────────
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

const srcSitePackages = findSitePackages(venvDir(root))
if (srcSitePackages === null) fail(`venv 里找不到 site-packages：${venvDir(root)}`)

rmSync(outRoot, { recursive: true, force: true })
mkdirSync(outRoot, { recursive: true })
log(`拷解释器 ${srcInterpreter} → ${outPython}`)
cpSync(srcInterpreter, outPython, { recursive: true, verbatimSymlinks: true })

const dstSitePackages = findSitePackages(outPython)
if (dstSitePackages === null) fail(`产物解释器里找不到 site-packages：${outPython}`)
log(`压平依赖 ${srcSitePackages} → ${dstSitePackages}`)
cpSync(srcSitePackages, dstSitePackages, { recursive: true, verbatimSymlinks: true })

const pruned = prunePyc(outPython)
log(`剔掉 ${String(pruned)} 处 __pycache__/*.pyc`)

const exe = join(outPython, process.platform === "win32" ? "python.exe" : "bin/python3")
if (!existsSync(exe)) fail(`产物里没有解释器可执行文件：${exe}`)

const selfCheck = spawnSync(exe, ["-c", "import sys; print(sys.base_prefix); print(sys.prefix)"], {
  encoding: "utf8",
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
    # requirements 文件统一按 UTF-8 读取；Windows 默认编码可能是 cp1252，
    # 会在包含非 ASCII 注释的清单上把构建误判为失败。
    for line in pathlib.Path(f).read_text(encoding="utf-8").splitlines():
        line = line.split("#")[0].strip()
        if not line or line.startswith("-"):
            continue
        # ★★ 先切掉 PEP 508 的环境标记（分号之后那段），并且按它决定要不要验。
        #
        # 不切的后果（实测 2026-08-10，打包在这里失败）：
        # kl-graph/requirements.txt 里有一行
        #     tzdata; sys_platform == "win32"
        # 整条被当成包名，于是在 macOS 上永远报「缺依赖：tzdata; sys_platform」
        # —— 而那个包本来就不该装（它只在 Windows 上需要）。
        #
        # 判据不是"忽略带标记的行"，而是用当前解释器求值那个标记：
        # 忽略的话会漏掉真正该验的平台相关依赖（比如
        # pywin32 在 Windows 上打包时要验）。
        #
        # ★ 这段活在 JS 模板字符串里 —— 注释里不许出现反引号（会提前终止模板，
        #   表现是 node 报一个指向 Python 注释行的 SyntaxError）。
        spec, _, marker = line.partition(";")
        if marker.strip():
            try:
                from packaging.markers import Marker
                if not Marker(marker.strip()).evaluate():
                    continue
            except ImportError:
                # packaging 不在 bundle 里 → 保守跳过带标记的行（宁可漏验，
                # 不要误报一个"缺了本来就不该装的包"）
                continue
        name = spec.split("==")[0].split(">=")[0].split("<")[0].split("[")[0].strip()
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
