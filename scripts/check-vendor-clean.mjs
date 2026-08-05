#!/usr/bin/env node
/**
 * 门禁：vendor/ 下不得出现凭据或冗余产物。
 *
 * 为什么要门禁而不是「记得别 cp -r」：上游发布目录里与可执行文件**同级**放着
 * `.dws/{token,identity,profiles,app-dev}.json`（真实凭据）、`.DS_Store`、
 * 以及与解压目录重复的 `.zip`。本仓库已经因为「目录语义混在一起」泄漏过一次
 * token（`resources/bin/.dws/`）—— 第二次不能靠记性。
 *
 * `.gitignore` 里也有对应条目（双保险），但 gitignore 只挡提交、不挡
 * 「文件躺在工作树里被某个脚本 cp 进产物」。
 */
import { readdirSync, statSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join, relative, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const vendorDir = join(root, "vendor")

/** 绝对不允许出现在 vendor/ 下的文件名（凭据）与目录名。 */
const FORBIDDEN_NAMES = new Set([
  ".dws",
  "token.json",
  "identity.json",
  "profiles.json",
  "app-dev.json",
  ".DS_Store",
])
/**
 * 执行副产物：跑 vendor/forge 就会生成。
 *
 * 单独一类而不是塞进 FORBIDDEN_NAMES —— 那条的报错说的是「凭据或系统文件」，
 * 用它来报字节码缓存会把人引到错误的方向（去查凭据泄漏，而实际只需删缓存）。
 */
const BUILD_ARTIFACT_NAMES = new Set(["__pycache__"])
/** 不允许的扩展名：.zip 与解压目录重复，白占体积且会让 diff 更不可读。 */
const FORBIDDEN_EXT = /\.(zip|tar|tgz|gz)$/i
/** 同理：.pyc 是执行副产物，不是「冗余压缩包」。 */
const BUILD_ARTIFACT_EXT = /\.pyc$/i

const hits = []

/**
 * 扫描时跳过的目录（相对 vendor/）。
 *
 * ★ `python/<platform>/venv` 是**本机运行时状态**（gitignore），里面是
 * `pip install` 装进来的 150+ 个第三方包。扫它只会产出假阳性：
 * numpy 自带的测试数据是 `.pkl.gz`（撞 FORBIDDEN_EXT 的"冗余压缩包"规则），
 * 而那是人家包的一部分、不是我们 cp 进来的冗余物。
 *
 * 本门禁要防的是「**入 git 的** vendor 内容里混进凭据/冗余归档」——
 * 一个不入 git、由包管理器生成的目录不在那个范围内。
 * 解释器本体（`python/<platform>/python`）仍然照扫，它是入 git 的。
 */
function shouldSkip(dir) {
  const rel = relative(vendorDir, dir)
  // venv 及其子树整体跳过（任意平台目录下的 venv）
  return rel.split("/").includes("venv")
}

function walk(dir) {
  if (shouldSkip(dir)) return
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    const rel = relative(root, full)
    if (FORBIDDEN_NAMES.has(entry)) {
      hits.push(`${rel}（凭据或系统文件，绝不允许进 vendor）`)
      continue
    }
    if (BUILD_ARTIFACT_NAMES.has(entry) || BUILD_ARTIFACT_EXT.test(entry)) {
      hits.push(`${rel}（执行副产物，删掉即可：find vendor -name __pycache__ -exec rm -rf {} +）`)
      continue
    }
    if (FORBIDDEN_EXT.test(entry)) {
      hits.push(`${rel}（压缩包与解压目录重复，请只保留目录）`)
      continue
    }
    if (statSync(full).isDirectory()) walk(full)
  }
}

walk(vendorDir)

/**
 * ★ 入 git 的 `pyvenv.cfg` 不得带 `home =`。
 *
 * ## 为什么这是一条门禁而不是一句注释
 *
 * 那一行是**绝对路径**，指向生成这个 venv 那台机器。提交上去有两个后果：
 *
 * · 别人机器上 `home` 是错的。`isPythonEnvReady` 只看解释器在不在 +
 *   依赖指纹对不对，**都与路径无关**，于是判定"就绪"，而解释器一起来就
 *   `ModuleNotFoundError: No module named 'encodings'` —— 连 stdlib 都找不到。
 *   真实故障：改一行 requirements 之后，别人的机器上装依赖直接死在这里，
 *   而脚本报的是「依赖安装失败……没出网 / 代理 / 磁盘满」。
 * · 顺带把某个人的家目录路径写进公共仓库。
 *
 * `relocateVenv` 在**缺这一行时会自己补**（实测：删掉后它前插一行，
 * 补完 leidenalg/sklearn/pypinyin/igraph 全部 import 正常），
 * 所以不带这一行是安全的 —— 而且 `git status` 不会再因为每次启动重写它而脏。
 *
 * 只查**已跟踪**的那份：工作区里那份被 relocate 改成本机路径是**正确**行为。
 */
const cfgRelative = "vendor/python/darwin-arm64/venv/pyvenv.cfg"
try {
  const committed = execFileSync("git", ["show", `HEAD:${cfgRelative}`], {
    cwd: root,
    encoding: "utf8",
  })
  if (/^home = /m.test(committed)) {
    hits.push(
      `${cfgRelative}（入 git 的那份带 home = 绝对路径 —— 别人机器上会 ` +
        `ModuleNotFoundError: No module named 'encodings'。` +
        `去掉那一行即可，relocateVenv 启动时会按本机补上）`,
    )
  }
} catch {
  // 文件还没入 git（新仓库 / 尚未提交 venv）：这条检查不适用，跳过。
}

if (hits.length > 0) {
  console.error(`vendor 卫生检查未通过，命中 ${hits.length} 处：`)
  for (const hit of hits) console.error(`  - ${hit}`)
  console.error("\n复制上游发布目录时必须逐文件白名单，禁止 cp -r（见 vendor/dws/README.md）")
  process.exit(1)
}

console.log("vendor 卫生检查通过：无凭据、无冗余压缩包")
