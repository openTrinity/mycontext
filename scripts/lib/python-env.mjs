/**
 * mycontext 的共用 Python 环境（内置解释器 + 一个 venv）。
 *
 * ## 为什么是「内置 Python + venv」而不是「本机 Python」
 *
 * kl（知识图谱）是 Python 写的。用本机 python3 在真实机器上站不住：
 *
 * · **macOS 自带的是 3.9.6，而 kl 要求 ≥3.10**（本机实测）——
 *   "有 python3"不等于"能跑 kl"；
 * · 同事机器上是 homebrew 3.13 才碰巧能用，那是运气不是设计；
 * · 打包给非开发者时更不成立：那些机器上可能根本没有 Python。
 *
 * 所以解释器随包分发（见 `python-runtime.mjs`），再用它建**一个** venv
 * 给所有 Python 需求共用（kl、forge、将来别的）。
 *
 * ## 启动时「激活」这个环境
 *
 * 应用启动时把这个 venv **激活**给所有 Python 子进程用（见 `venvEnv()`）:
 * 激活的实质就是 `bin/activate` 干的那三件事 ——
 *
 * ```sh
 * VIRTUAL_ENV=<venv>                    # 标记"当前在这个环境里"
 * PATH="<venv>/bin:$PATH"               # 裸 python/pip 命中 venv 里的
 * unset PYTHONHOME                      # 别让用户的 PYTHONHOME 顶掉它
 * ```
 *
 * 我们**注入这三个变量**而不是去 source 那个 shell 脚本，因为
 * `activate` 是给交互式 shell 写的：它要改当前 shell 的状态、还分
 * bash/zsh/fish/PowerShell 四个版本。而我们是 `spawn()` 子进程、不经过 shell，
 * 注入 env 得到的是**同一个结果**且跨平台一致。
 *
 * 环境激活之后，子进程里裸 `python`、`pip`、`kl` 都落在这个 venv 里，
 * 与在终端里 `source activate` 之后完全一样。同时我们仍然用解释器的
 * 绝对路径去 spawn —— 那是双保险：即便某个调用方漏了注入 env，
 * 解释器本身也认得自己的 site-packages（venv 的 `pyvenv.cfg` 保证这点），
 * 不会退回系统 Python。
 *
 * ## venv 放在哪
 *
 * `vendor/python/<platform>/venv`（与解释器同级）。**它入 git**（9422 个文件）
 * —— 打包给用户时不可能让他们去跑 `pnpm setup:python`。
 * 不放 `kl-graph/.venv`：那是算法团队的代码目录（上游自己的 per-project venv
 * 就叫这个名字），我们的运行时状态不该长在别人的代码里 —— 也不该在
 * `sync:kl-graph` 合并上游改动时跟着凑热闹。
 *
 * ## ★★ 打包态**没有 venv** —— 依赖压平进了解释器自己
 *
 * venv 只有 site-packages、没有标准库，它靠 `pyvenv.cfg` 的 `home =`
 * （**构建机的绝对路径**）去解释器那边借。那一行在用户机器上必然是错的，
 * 而修它意味着往 .app 内部写文件（破坏签名；Gatekeeper 隔离时根本写不进去）。
 *
 * 所以打包时 `scripts/build-python-bundle.mjs` 把 venv 的 site-packages **拷进
 * 解释器自己那份**，产物里只有 `python/`、没有 `venv/`。裸解释器本来就自定位
 * （python-build-standalone 的设计），于是零环境变量、零改写、拷到哪都能跑。
 *
 * 下面几个函数因此都要**先判有没有压平的解释器**（`hasFlattenedPython`）：
 * 有就直接用它，别去建 venv。漏了这一步的后果实测过 —— 打包好的 app 一启动
 * 就在 .app 里 `python -m venv` 并联网 pip install（而那台机器可能没网、
 * 目录也可能只读）。
 */
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import {
  bundledPythonExe,
  ensureBundledPython,
  hasBundledPython,
  pythonCacheDir,
} from "./python-runtime.mjs"

/** 共用 venv 的根。 */
export function venvDir(repoRoot) {
  return join(pythonCacheDir(repoRoot), "venv")
}

/**
 * ★ 打包态那份**压平后的自包含解释器**（`<plat>/python`，依赖装在它自己的
 * site-packages 里、没有 venv）。见文件头。
 */
function flattenedPython(repoRoot) {
  const base = join(pythonCacheDir(repoRoot), "python")
  return process.platform === "win32" ? join(base, "python.exe") : join(base, "bin", "python3")
}

/**
 * 判据：解释器在，**且**依赖真装在它自己的 site-packages 里。
 *
 * ★ 只判"解释器在"是不够的 —— 开发态 `vendor/python/<plat>/python` 也在
 * （那是建 venv 用的**基础**解释器，它的 site-packages 里只有 pip）。
 * 那样会让开发态误以为已经压平，然后拿一个没装依赖的解释器去跑 kl。
 *
 * 所以拿一个**必需依赖**当探针。用 `qdrant_client`：kl 的核心依赖，
 * `kl_server.py` 顶部就 import 它，缺了它这套环境无论如何都跑不起来。
 */
function hasFlattenedPython(repoRoot) {
  const exe = flattenedPython(repoRoot)
  if (!existsSync(exe)) return false
  const libDir = join(pythonCacheDir(repoRoot), "python", "lib")
  if (!existsSync(libDir)) return false
  for (const entry of readdirSync(libDir)) {
    if (!entry.startsWith("python")) continue
    // 目录探测而不是跑解释器：这条判据在启动路径上，spawn 一次要几百毫秒。
    if (existsSync(join(libDir, entry, "site-packages", "qdrant_client"))) return true
  }
  return false
}

/**
 * 该用哪个解释器 —— **所有** Python 子进程都用这个绝对路径。
 *
 * ★ 打包态优先返回压平后的那份（没有 venv，见文件头）。
 */
export function venvPython(repoRoot) {
  if (hasFlattenedPython(repoRoot)) return flattenedPython(repoRoot)
  const dir = venvDir(repoRoot)
  return process.platform === "win32"
    ? join(dir, "Scripts", "python.exe")
    : join(dir, "bin", "python")
}

/**
 * **激活**这个 venv：返回带激活标记的环境变量，给 spawn 用。
 *
 * 等价于 `source <venv>/bin/activate` 的三件事（见文件头）：
 * 设 `VIRTUAL_ENV`、把 `<venv>/bin` 前插进 `PATH`、清掉 `PYTHONHOME`。
 *
 * 所有起 Python 子进程的地方都该带上它 —— 于是那个进程里裸 `python`、
 * `pip`、`kl` 全部落在这个 venv 里，与终端里 activate 过一样。
 */
export function venvEnv(repoRoot, baseEnv = process.env) {
  const separator = process.platform === "win32" ? ";" : ":"
  const env = { ...baseEnv }

  /**
   * ★ 压平态（打包）：没有 venv，所以**不设** `VIRTUAL_ENV` —— 那个变量的
   * 含义是"当前在某个 venv 里"，指向一个不存在的目录只会让工具链困惑
   * （pip 会拿它当安装目标）。裸解释器自定位，不需要任何变量。
   */
  if (hasFlattenedPython(repoRoot)) {
    const base = join(pythonCacheDir(repoRoot), "python")
    const binDir = process.platform === "win32" ? base : join(base, "bin")
    env["PATH"] = `${binDir}${separator}${baseEnv["PATH"] ?? ""}`
    delete env["PYTHONHOME"]
    delete env["PYTHONPATH"]
    return env
  }

  const dir = venvDir(repoRoot)
  const binDir = process.platform === "win32" ? join(dir, "Scripts") : join(dir, "bin")
  env["VIRTUAL_ENV"] = dir
  env["PATH"] = `${binDir}${separator}${baseEnv["PATH"] ?? ""}`
  /**
   * ★ `PYTHONHOME` 必须**删掉**而不是设成空串。
   *
   * 空串对 CPython 来说是"把 prefix 设成空"，它会去找不存在的标准库路径
   * 然后启动失败（`Could not find platform independent libraries`）——
   * 比不设更糟。activate 脚本用的也是 `unset`。
   */
  delete env["PYTHONHOME"]
  // PYTHONPATH 同理：用户环境里若有它，会抢在 venv 的 site-packages 之前。
  delete env["PYTHONPATH"]
  return env
}

/** 依赖清单：上游的 + 我们补的（见 kl-extra-requirements.txt 的说明）。 */
export function requirementFiles(repoRoot) {
  const files = [join(repoRoot, "kl-graph", "requirements.txt")]
  const extra = join(repoRoot, "scripts", "kl-extra-requirements.txt")
  if (existsSync(extra)) files.push(extra)
  return files.filter((file) => existsSync(file))
}

/** marker 路径：记"这套依赖装过了、且是这一版"。放 venv 内部，删 venv 即失效。 */
function markerPath(repoRoot) {
  return join(venvDir(repoRoot), ".mycontext-deps")
}

/**
 * 依赖指纹 = 所有 requirements 文件内容的 hash。
 *
 * 用内容而不是 mtime：git checkout 会改 mtime 但内容可能没变，
 * 那种情况下重装是白等几十秒。
 */
export function depsFingerprint(repoRoot) {
  const files = requirementFiles(repoRoot)
  if (files.length === 0) return null
  const hash = createHash("sha256")
  for (const file of files) hash.update(readFileSync(file))
  return hash.digest("hex").slice(0, 16)
}

/**
 * 环境是否已就绪（venv 在 + 依赖指纹一致）。
 *
 * 两个条件都要：只看 venv 目录存在的话，装到一半被 Ctrl-C 留下的残缺环境
 * 会被当成"装好了"，然后永远跳过重装 —— 那种状态极难自查。
 */
export function isPythonEnvReady(repoRoot) {
  /**
   * ★★ 压平态（打包）**永远就绪** —— 依赖在构建期已经装好并逐项校验过
   * （`build-python-bundle.mjs` 按 requirements 验 distribution，缺一个就 fail）。
   *
   * 不能落到下面那套判据：它找 `venv/bin/python` + `.mycontext-deps` marker，
   * 而压平态两者都不存在 → 判"没就绪" → `ensurePythonEnv` 去**建 venv 并联网
   * pip install**。实测过一次：打包好的 app 一启动就在 .app 内部
   * `python -m venv` + 装依赖（而用户机器可能没网、那个目录也可能只读）。
   */
  if (hasFlattenedPython(repoRoot)) return true
  if (!existsSync(venvPython(repoRoot))) return false
  const marker = markerPath(repoRoot)
  if (!existsSync(marker)) return false
  const expected = depsFingerprint(repoRoot)
  return expected !== null && readFileSync(marker, "utf8").trim() === expected
}

/**
 * 把 venv/bin 下那些内嵌绝对路径的文本脚本改成**自定位**的形式。
 *
 * ## 为什么 `pyvenv.cfg` 之外还有一批
 *
 * `python -m venv` + pip 生成 venv 时，会把当时的绝对路径**烧进**两类文本文件：
 *
 * · **console-script 的 shebang** —— pip 装的每个带命令的包都会在 `bin/` 放一个
 *   小 py 脚本，第一行是 `#!<venv>/bin/python3`。本仓库里有 23 个
 *   （`pip` `uvicorn` `litellm` `fastapi` `tqdm` `nltk` …）。
 * · **`activate` / `activate.csh` / `activate.fish`** —— 里面 `VIRTUAL_ENV=<venv>`
 *   是绝对路径（`Activate.ps1` 本来就自定位，不用改）。
 *
 * 于是 venv 入 git 之后，这 26 个文件在**别的 checkout** 里全是坏的：shebang 指向
 * 一个不存在的解释器（`bad interpreter: No such file or directory`），
 * `source activate` 会把 `VIRTUAL_ENV` 设到别人的目录上。
 *
 * ## ★★ 为什么是「改成自定位」而不是「改写成本机路径」
 *
 * 这个函数原来的做法是**把外来路径替换成当前机器的路径**。那能让环境跑起来，
 * 但每次都会在工作区留下 26 个改动 —— 于是那批绝对路径**又被提交进 git**，
 * 换下一台机器再重演一次。实测库里就是这个结果：HEAD 里 25 个文件带
 * `/Users/you/…`、另外 2 个（`igraph` `pypinyin`）带
 * `/Users/you/…` —— 后者从入库那天起在这台机器上就是坏的。
 * 也就是说「启动时自愈」修的是症状，而**病根是这些文件里有绝对路径**。
 *
 * 所以改成写死**不含任何绝对路径**的内容：
 *
 * · shebang → `#!/bin/sh` + 一行 sh/python **polyglot**，用 `$0` 推出同目录的
 *   `python3`。它同时是合法的 sh 与合法的 Python（`''''…'''` 在 Python 里是
 *   一个字符串字面量、在 sh 里是空串拼接后跟命令），所以文件其余部分不用动。
 * · `activate`（bash/zsh/sh）→ 用 `BASH_SOURCE` / `${(%):-%x}` / `$0` 推出自身
 *   位置，`cd ..` 得到 venv 根。
 * · `activate.fish` → `status --current-filename`。
 *
 * 改完之后这些文件**与路径无关**，git 里存的就是最终形态，不再每次启动变脏。
 *
 * ## ★★ `activate.csh` 直接**删掉**（而不是改写成本机路径）
 *
 * csh 拿不到"正在被 source 的脚本"的路径 —— 实测把 tcsh 的每条路都试过：
 * `$_` 是**上一条命令**（source 前先跑 `echo warmup`，`$_` 里就是 `echo`
 * 那三个词），`$0` 是 `csh`，`$argv` 为空，也没有别的自身路径变量。
 * 真 pty 交互式下同样如此。virtualenv 上游的 csh 模板也是硬编码绝对路径，
 * 同一个原因。
 *
 * 所以它做不到自定位。但"做不到"不等于"只能留一个绝对路径" —— 该问的是
 * **这个文件有必要留吗**：
 *
 * · 全仓库**没有任何代码**引用它（`git grep activate.csh` 只命中本文件的注释）；
 * · 我们的运行路径不 source 任何 activate（注入 env，见 `venvEnv`）；
 * · 人排查时用的是 macOS 默认的 zsh、或 bash —— 两个都已经自定位了。
 *
 * 留着它的唯一效果是：**保证每台新机器第一次启动都脏一个文件**，而那正是
 * 这次要根治的病（改动被提交回 git → 换下一台再坏）。所以删掉。
 * 实测删掉之后 `pip`/`uvicorn`/`python`/`kl`/`activate`（bash+zsh）全部照常。
 *
 * 真有人要用 csh，`python -m venv` 随时能再生成一个 —— 那时它写的是**那台
 * 机器**的路径，本来就是对的。
 *
 * ## 为什么"我们不走这些文件"不构成不修的理由
 *
 * 主进程 spawn Python 一律是 `executable: <venv 解释器绝对路径>` + `-m <module>`
 * （见 kl-server.service.ts），激活也是**注入 env** 而不是 source activate
 * （见 `venvEnv`）。所以运行路径确实碰不到这些文件 —— `bin/kl` 是唯一例外，
 * 它由 PATH 命中，已经单独有 `installKlWrapper`。
 *
 * 但**人**会碰到：环境出问题时第一反应就是 `source .../activate` 然后
 * `pip list` / `pip install`，而那时得到的是 `bad interpreter` 或者一个指向
 * 陌生用户目录的 `VIRTUAL_ENV`。这跟 `kl` wrapper 报
 * `cd: <别人的 home>/...: No such file or directory` 是同一个病：
 * **报错内容指向一台不是你的机器**，没人会想到"venv 入了 git"。
 *
 * ## 只改文本、只改 bin、只在内容变了时写盘
 *
 * `git grep -I` 确认这些全是文本（没有二进制会被误改）。`site-packages`
 * 里也可能有内嵌路径（比如 `.dist-info/RECORD`），**刻意不动** —— 那些是安装
 * 元数据，不参与执行，改它反而会让 pip 的校验对不上。
 *
 * @returns 实际改动了的文件数（0 = 全都已经是自定位的）
 */
function rewriteVenvScripts(repoRoot) {
  const dir = venvDir(repoRoot)
  const binDir = process.platform === "win32" ? join(dir, "Scripts") : join(dir, "bin")
  if (!existsSync(binDir)) return 0

  let changed = 0
  for (const name of readdirSync(binDir)) {
    /**
     * `kl` 跳过 —— 它由 `installKlWrapper` 整个重新生成（内容不只有路径，
     * 还有 `cd` 到 kl 根那一行）。两个函数都写同一个文件的话，
     * 谁最后跑决定结果，那种耦合不值得。
     */
    if (name === "kl" || name === "kl.cmd") continue

    const file = join(binDir, name)

    /**
     * ★★ `activate.csh` 直接删掉 —— csh 做不到自定位，而这个文件没人用。
     * 完整理由见函数头注释那一节（tcsh 的每条路都实测过）。
     *
     * 删而不是改写：改写等于**保证每台新机器都脏一个文件**，而那正是这次
     * 要根治的病。删除也是幂等的（第二次它已经不在了，`existsSync` 挡掉）。
     */
    if (name === "activate.csh") {
      try {
        unlinkSync(file)
        changed += 1
      } catch {
        // 删不掉（只读挂载等）不是错误：这个文件不参与任何运行路径。
      }
      continue
    }

    /**
     * 软链不跟进去 —— `bin/python` 那几个是**相对**软链（入库时就处理过，
     * 见本文件 relocateVenv 的注释），readFileSync 会读到目标文件的内容，
     * 于是我们会把 stdlib 里的东西当 bin 脚本改写。
     */
    let stat
    try {
      stat = lstatSync(file)
    } catch {
      continue
    }
    if (!stat.isFile()) continue

    let text
    try {
      text = readFileSync(file, "utf8")
    } catch {
      continue // 二进制/权限问题：跳过而不是让整个启动失败
    }
    // 含 NUL 就是二进制，别碰（理论上 bin 下不该有，但 utf8 读不会报错）
    if (text.includes("\0")) continue

    const next = selfLocatingScript(name, text)
    if (next === null || next === text) continue

    writeFileSync(file, next, "utf8")
    changed += 1
  }
  return changed
}

/**
 * ★ console-script 的自定位头（sh / Python **polyglot**）。
 *
 * 第二行同时是合法 sh 与合法 Python：
 * · sh 看到的是 `'''` `'` 拼出的空串，然后 `exec …`，`#` 之后是注释；
 * · Python 看到的是一个 `''''…'''` 字符串字面量（表达式语句，无副作用），
 *   于是 `exec` 那行对 Python 来说什么都不做，后面的 import 照常执行。
 *
 * 也就是说文件被 sh 执行时会把自己交给同目录的 `python3`，而被 `python3`
 * 执行时这两行是 no-op。实测覆盖：按相对/绝对路径调用、走 PATH、
 * 从任意 cwd、整棵树搬走、以及 `python3 <file>` 直跑 —— 六种全通。
 *
 * `dirname -- "$0"`：`--` 挡住以 `-` 开头的路径；`$0` 在三种调用方式下都是
 * 脚本自身路径（PATH 命中时 sh 会补成完整路径，实测确认）。
 */
const POLYGLOT_SHEBANG = [
  "#!/bin/sh",
  // 由 mycontext 改写（scripts/lib/python-env.mjs）：原来这里是生成 venv 那台机器的绝对路径。
  `''''exec "$(dirname -- "$0")/python3" "$0" "$@" # '''`,
]

/**
 * 把一个 bin 脚本变成自定位形式；不需要改就返回 null。
 *
 * 分三种：`activate`（sh 家族）、`.fish`、其余带 `#!<abs>/python*` 的
 * console-script。（`activate.csh` 不走这里 —— 它在调用方被直接删掉，
 * 见 `rewriteVenvScripts`。）
 */
function selfLocatingScript(name, text) {
  if (name === "activate") return selfLocatingActivate(text)
  if (name === "activate.fish") return selfLocatingActivateFish(text)

  /**
   * console-script：只认「第一行是指向某个 `python*` 的**绝对路径** shebang」。
   *
   * 判据要窄 —— `bin/` 下不是所有东西都是 pip 生成的 py 脚本（`kl` 是 bash，
   * 已在上面跳过；将来可能有别的）。把非 Python 脚本套上这个头会直接让它坏掉。
   */
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? undefined : text.indexOf("\n"))
  if (!/^#!\/.*\/python[\d.]*$/.test(firstLine)) return null
  return [...POLYGLOT_SHEBANG, text.slice(firstLine.length + 1)].join("\n")
}

/**
 * `activate`（bash / zsh / 其它 POSIX sh）：把 `VIRTUAL_ENV=<abs>` 换成自定位。
 *
 * 上游模板里那一段是个 `case "$(uname)"` —— Windows 下要 `cygpath` 转换，
 * 其余分支直接赋绝对路径。整段替换掉：venv 根 = 脚本所在目录的上一级。
 *
 * 三种 shell 的"自身路径"取法不同（实测 bash/zsh/sh 全通）：
 * · bash → `$BASH_SOURCE`（`$0` 在 source 时是 shell 名，不是脚本）
 * · zsh  → `${(%):-%x}`（zsh 的 prompt 展开，`%x` 是当前脚本）
 * · 其它 → `$0`（`. ./activate` 时 dash/sh 给的是脚本路径）
 *
 * 找不到那段（上游模板换了）就返回 null —— 宁可不改，也不要改坏一个
 * 每天有人 source 的文件。
 */
function selfLocatingActivate(text) {
  const block = /# on Windows[\s\S]*?\nesac\n/
  if (!block.test(text)) return null
  return text.replace(
    block,
    [
      "# venv 根由**脚本自身位置**推出 —— 原来这里是生成它那台机器的绝对路径，",
      "# 而这个 venv 入了 git（改写逻辑见 scripts/lib/python-env.mjs）。",
      'if [ -n "${BASH_SOURCE-}" ] ; then',
      '    _mycontext_self="${BASH_SOURCE}"',
      'elif [ -n "${ZSH_VERSION-}" ] ; then',
      '    _mycontext_self="${(%):-%x}"',
      "else",
      '    _mycontext_self="$0"',
      "fi",
      'VIRTUAL_ENV="$(cd -- "$(dirname -- "$_mycontext_self")/.." && pwd)"',
      "unset _mycontext_self",
      "export VIRTUAL_ENV",
      "",
    ].join("\n"),
  )
}

/** `activate.fish`：fish 有 `status --current-filename`，一行就够。 */
function selfLocatingActivateFish(text) {
  const line = /^set -gx VIRTUAL_ENV \/.*$/m
  if (!line.test(text)) return null
  return text.replace(
    line,
    "# venv 根由脚本自身位置推出（原来是生成它那台机器的绝对路径）。\n" +
      "set -gx VIRTUAL_ENV (cd (dirname (status --current-filename))/..; pwd)",
  )
}

/**
 * 让入 git 的 venv 在**当前机器**上可用。
 *
 * ## 为什么需要这一步
 *
 * venv 整个目录（含 288MB 依赖）**入 git**，于是 clone 下来 / 装完包就有 ——
 * 用户不需要跑任何命令、也不需要出网。但 venv 里有几处绑着"生成它那台机器"
 * 的绝对路径，换机器就废。
 *
 * 各处的处理方式（都做到与位置无关，见下面各自的函数）：
 *
 * · `bin/python` 等软链 → 入库时就改成**相对**（`../../python/bin/python3`）；
 * · `bin/` 下 23 个 console-script 的 shebang + `activate`/`activate.fish`
 *   → 改成**自定位**形式（见 `rewriteVenvScripts`）；
 * · `bin/kl` → 由 `installKlWrapper` 生成，内容全部相对自身；
 * · `activate.csh` → **删掉**（csh 做不到自定位，而这个文件全仓库没人引用）；
 * · `pyvenv.cfg` 的 `home =` → 见下面那段。
 *
 * ## ★★ `home =` 现在**通常不写** —— 那行是工作区变脏的唯一来源
 *
 * 这个函数原来无条件把 `home = <绝对路径>` 写进 `pyvenv.cfg`。而 git 里存的是
 * **没有那一行**的版本，于是每次启动都改一次文件、`git status` 永远脏，
 * 那行绝对路径也就一直有机会被提交回去。
 *
 * 实测（在一个模拟的别人 checkout 上，三种配置各跑一遍）：
 *
 * | `pyvenv.cfg` | 结果 |
 * |---|---|
 * | **整行不写** | ✅ `prefix`/`base_prefix`/`stdlib`/`purelib` 全部正确，依赖可 import |
 * | `home = ../../python/bin`（相对） | ❌ `Could not find platform independent libraries` |
 * | `home = <绝对路径>` | ✅ 正常 |
 *
 * 也就是**整行不写反而是对的** —— 因为 `bin/python3` 是相对软链，CPython 顺着
 * 软链就能自己定位到解释器。（相对路径不行那条与原注释一致：Python 会拿
 * 构建期的 cwd 去解析它。）
 *
 * ## ★ 但不能直接假定"不写就行"—— 要**真跑一次探针**
 *
 * 上面那个结论有个前提：软链是软链。反例实测过：用 `cp -Rc` 拷这棵树会把
 * `bin/python3` **解引用成实体文件**（49968 字节），那时没有 `home` 就起不来：
 *
 * ```
 * dyld: Library not loaded: @executable_path/../lib/libpython3.12.dylib
 * ```
 *
 * 而"用户是怎么把这棵树弄到机器上的"我们管不了（clone / 拷 U 盘 / 解压）。
 * 所以判据不是"猜布局"，而是**真的起一次解释器**：能 import `encodings`
 * 就什么都不写；起不来才补 `home =`。代价是启动时一次 spawn（约几十毫秒），
 * 换来的是绝大多数机器上工作区保持干净。
 */
export function relocateVenv(repoRoot) {
  /**
   * ★ 压平态（打包）没有 venv，也就没有 `pyvenv.cfg` 要改 —— 直接返回。
   *
   * 下面那个 `existsSync(cfg)` 其实也会兜住（文件不在就 false），但显式挡一道
   * 更清楚：**这个函数在打包态绝不该写盘**。往 .app 内部写文件会破坏代码签名，
   * 而 Gatekeeper 隔离（translocation）时那还是个只读路径。
   */
  if (hasFlattenedPython(repoRoot)) return false

  const cfg = join(venvDir(repoRoot), "pyvenv.cfg")
  if (!existsSync(cfg)) return false

  /**
   * ★ bin 下的脚本先重写 —— 与 `pyvenv.cfg` 无先后依赖，但要在两个 return
   * 之前做掉。原来这个函数只改 `home =` 一行，于是下面那三条
   * `return true/false` 后面挂什么都不会执行到。
   */
  rewriteVenvScripts(repoRoot)

  const current = readFileSync(cfg, "utf8")
  const homeLine = /^home = .*$/m
  /** 去掉 `home =` 那一行之后的内容（其余行原样保留）。 */
  const withoutHome = current.replace(new RegExp(`${homeLine.source}\n?`, "m"), "")

  /**
   * ★★ 判据是「**摘掉 `home` 之后**能不能起来」，不是「当前能不能起来」。
   *
   * 这个顺序很关键，写反过测试会当场抓到（我写反过一次）：`home` 指向别人机器
   * 时，"当前状态"必然起不来 → 于是去补一行**本机**的 `home` —— 一个坏的绝对
   * 路径被换成另一个绝对路径，工作区照样脏、照样会被提交回 git。
   *
   * 而正确的问题是"这个 venv **需不需要** `home`"。所以先真的把那行去掉写进
   * 文件、再起一次解释器：
   *
   * · 能起来（常态，软链是相对的）→ 就这样，`home` 永久消失，工作区干净；
   * · 起不来（软链被解引用等非常规布局）→ 还原并补本机绝对路径。
   *
   * 代价是最多两次写盘 + 一次 spawn，且只发生在**确实有 `home` 那行**的时候
   * （常态下 git 里没有它 → 走下面的快路径，零写盘）。
   */
  if (!homeLine.test(current)) {
    // 没有 home 那行：只需确认解释器能起来。能 → 什么都不做（最常见的路径）。
    if (interpreterWorks(repoRoot)) return true
  } else {
    writeFileSync(cfg, withoutHome, "utf8")
    if (interpreterWorks(repoRoot)) return true
    // 起不来 → 还原，落到下面补绝对路径那条
    writeFileSync(cfg, current, "utf8")
  }

  /**
   * 起不来 → 补 `home =` 绝对路径（实测唯一有效的形式，相对路径不行：
   * Python 会拿构建期的 cwd 去解析它，报
   * `Could not find platform independent libraries`）。
   *
   * 走到这里说明布局非常规 —— 典型是 `bin/python3` 那个相对软链被解引用成了
   * 实体文件（`cp -Rc` 会这样，实测踩过），那时 CPython 没法自己找到解释器。
   */
  const interpreterBin = join(pythonCacheDir(repoRoot), "python", "bin")
  const desired = `home = ${interpreterBin}`
  if (homeLine.test(current)) {
    const already = current.match(homeLine)?.[0]
    // 值没变就不写盘：否则每次启动都改文件，git status 永远是脏的
    if (already === desired) return true
    writeFileSync(cfg, current.replace(homeLine, desired), "utf8")
    return true
  }
  writeFileSync(cfg, `${desired}\n${current}`, "utf8")
  return true
}

/**
 * 探针：venv 的解释器**现在**能不能起来。
 *
 * `import encodings` 是最低门槛 —— 它是 CPython 启动时第一个要加载的 stdlib
 * 模块，`home` 错的时候报的就是 `ModuleNotFoundError: No module named
 * 'encodings'`（真机踩过）。能 import 它就说明 stdlib 定位对了。
 *
 * 用 `-S` 跳过 site-packages：我们只关心**解释器本身**能不能起来，
 * 而 site 的加载会去读一堆 `.pth`（`litellm` 之类有慢的），没必要在启动路径上等。
 *
 * 任何异常（解释器文件不在、spawn 失败、超时）都返回 false —— 让调用方
 * 走"补 `home =`"那条保守路径。宁可多写一行配置，也不要让环境起不来。
 */
function interpreterWorks(repoRoot) {
  const python = venvPython(repoRoot)
  if (!existsSync(python)) return false
  try {
    const probe = spawnSync(python, ["-S", "-c", "import encodings"], {
      stdio: "ignore",
      timeout: 10_000,
    })
    return probe.status === 0
  } catch {
    return false
  }
}

/**
 * 准备好共用 Python 环境：内置解释器 → venv → 依赖。幂等。
 *
 * @returns venv 解释器的绝对路径；失败 → null（调用方降级并明示原因）
 */
export async function ensurePythonEnv(repoRoot, log = () => {}) {
  /**
   * ★★ 压平态（打包）：直接用那个自包含解释器，**什么都不做**。
   *
   * 提前返回而不是靠下面 `isPythonEnvReady` 那个分支：那里还会
   * `relocateVenv()` + `installKlWrapper()`，两个都要**往 .app 内部写文件**
   * —— 破坏代码签名，且 Gatekeeper 隔离（translocation）时那是只读路径。
   * 压平态压根没有 pyvenv.cfg 要改，wrapper 也不需要（kl 由主进程用绝对路径
   * spawn；skill 里的裸 `kl` 靠 PATH 前插命中 —— 见 `venvEnv`）。
   */
  if (hasFlattenedPython(repoRoot)) return flattenedPython(repoRoot)

  if (isPythonEnvReady(repoRoot)) {
    /**
     * ★ 已就绪也要补一次 wrapper。
     *
     * marker 只记"依赖装过了"，而 wrapper 是另一件事：它可能被删掉、
     * 或者由更早的版本生成（路径变了）。重写一次几乎零成本（一个小文件），
     * 换来的是"环境就绪"这个判断真的意味着 kl 能跑。
     */
    relocateVenv(repoRoot)
    installKlWrapper(repoRoot, () => {})
    return venvPython(repoRoot)
  }

  // ① 内置解释器（按需下载 + 官方 sha256 校验）
  const base = hasBundledPython(repoRoot)
    ? bundledPythonExe(repoRoot)
    : await ensureBundledPython(repoRoot, log)
  if (base === null) return null

  // ② venv（用内置解释器建 —— 于是 venv 里的 Python 版本由我们决定）
  if (!existsSync(venvPython(repoRoot))) {
    log("创建共用 Python venv…")
    const create = spawnSync(base, ["-m", "venv", venvDir(repoRoot)], { stdio: "inherit" })
    if (create.status !== 0) {
      log("创建 venv 失败。")
      return null
    }
  }

  /**
   * ★ 装依赖**之前**必须重定位一次 —— 否则装不动。
   *
   * ## 为什么这一行不能省（真实故障）
   *
   * venv 整个入 git，包括 `pyvenv.cfg`。而那个文件里的 `home =` 是
   * **绝对路径**，提交上来的那份指向生成它那台机器
   * （实测库里那份是 `/Users/you/Projects/mycontext/...`）。
   *
   * 于是任何**别的**机器上：
   *
   * · 依赖指纹一致时走 ready 分支 —— 那里有 relocate，正常；
   * · 而指纹**变了**（有人往 requirements 加了一行）就走到这里，
   *   开始用 venv 的解释器装东西 —— 它读那个坏的 `home`，
   *   解析出 `sys.base_prefix = '/install'`，然后
   *   `ModuleNotFoundError: No module named 'encodings'` —— 连 stdlib
   *   都找不到，pip 一个字都装不进去。
   *
   * 症状极具误导性：脚本报的是「依赖安装失败……常见原因：没出网 / 代理 /
   * 磁盘满」，而真实原因是一个路径。**每次改 requirements 都会在所有
   * 别人的机器上触发一次**，而改 requirements 恰恰是"补依赖"的正常动作。
   *
   * 幂等且只在值变了时写盘，所以放在这里没有代价。
   */
  relocateVenv(repoRoot)

  // ③ 依赖
  const files = requirementFiles(repoRoot)
  if (files.length === 0) {
    log("找不到 requirements（kl-graph 没同步下来？跑 pnpm sync:kl-graph）。")
    return null
  }
  const reqArgs = files.flatMap((file) => ["-r", file])
  log(`安装 Python 依赖（首次约 1 分钟、需出网）…`)

  /**
   * 优先 uv（Rust 解析器，这一坨 280MB 的依赖差距是分钟级的），退回 pip。
   *
   * 内置解释器**自带 pip**（实测 pip 26.1.2），所以退路一定可用 ——
   * 不必像"本机 python + uv 建的 venv"那样还要先 ensurepip。
   */
  const uv = spawnSync("uv", ["--version"], { encoding: "utf8" })
  if (uv.status === 0) {
    const run = spawnSync("uv", ["pip", "install", ...reqArgs], {
      stdio: "inherit",
      env: venvEnv(repoRoot),
    })
    if (run.status === 0) return finish(repoRoot, log)
    log("uv 安装失败，退回 pip 重试…")
  }
  const pip = spawnSync(
    venvPython(repoRoot),
    ["-m", "pip", "install", "--disable-pip-version-check", ...reqArgs],
    { stdio: "inherit" },
  )
  if (pip.status !== 0) {
    log("依赖安装失败（上面是 uv/pip 的原始输出）。常见原因：没出网 / 代理 / 磁盘满。")
    return null
  }
  return finish(repoRoot, log)
}

/** 写 marker 收尾。 */
function finish(repoRoot, log) {
  installKlWrapper(repoRoot, log)
  const fingerprint = depsFingerprint(repoRoot)
  if (fingerprint !== null) writeFileSync(markerPath(repoRoot), `${fingerprint}\n`, "utf8")
  log("Python 环境就绪。")
  return venvPython(repoRoot)
}

/**
 * 把 `kl` 命令装进 venv 的 bin。
 *
 * ## 为什么必须自己生成一个
 *
 * 上游自带的 `kl-graph/kl` **硬编码**了 `${SCRIPT_DIR}/.venv/bin/python`
 * —— 那是它自己那套 per-project venv 的路径，而我们的解释器在
 * `vendor/python/<platform>/venv`。用它的话报
 * `No such file or directory: kl-graph/.venv/bin/python`（实测）。
 *
 * 而 `kl-graph/` 是算法团队的代码、**不该改**（改了会在 `sync:kl-graph`
 * 合并上游时变成冲突，且算法团队看不到）。所以在我们自己的地盘生成一个同名
 * wrapper。
 *
 * 放 venv 的 bin 里而不是别处：那个目录已经在激活后的 `PATH` 首段，
 * 于是 agent 跑裸 `kl` 时**先命中这一个**，不需要额外的 PATH 布线。
 *
 * 内容与上游等价（cd 到 kl 根 + 跑 kl_cli.py），只把解释器换成我们的。
 * `cd` 保留：kl_cli.py 会按相对路径找 `kl_graph/` 包。
 *
 * ★ 导出（而不是留作模块私有）：app 的启动路径也要能单独调它 ——
 * wrapper 里那两个路径是**绝对**的，而 venv 入了 git，于是换一台机器
 * clone 下来 wrapper 还指着上一台机器的 checkout（实测：搜索 agent 跑裸 `kl`
 * 报 `cd: /Users/<另一处>/kl-graph: No such file or directory`）。
 * 详见 `apps/desktop/src/main/services/python-env.ts` 就绪分支的注释。
 */
export function installKlWrapper(repoRoot, log = () => {}) {
  const klRoot = join(repoRoot, "kl-graph")
  if (!existsSync(join(klRoot, "kl_cli.py"))) return

  /**
   * ★★ 压平态（打包）：`venv/bin/` **不存在**，写它会 ENOENT。
   *
   * 打包实测抓到过：状态页显示「Python 环境没准备好（内置解释器下载失败或
   * 依赖装不上）。跑 `pnpm setup:python`…」，而真实原因完全不是那个 ——
   * 日志里是
   * ```
   * python environment preparation threw
   * {"detail":"ENOENT: … open '…/vendor/python/darwin-arm64/venv/bin/kl'"}
   * ```
   * app 的启动路径（`python-env.ts` 的就绪分支）会无条件调这个函数，
   * 而压平态压根没有那个目录。那句异常被 catch 成"环境不可用"，于是
   * **一个完全健康的环境被报成坏的**，还给出一条在打包态根本没法执行的建议。
   *
   * 这里判而不是让调用方判：调用方有两处（app 启动路径 + `ensurePythonEnv`
   * 的 ready 分支），在函数自己这里挡住才不会漏第三处 —— 与上面那条
   * `kl_cli.py` 不在就 return 是同一个模式。
   *
   * 压平态也**不需要**这个 wrapper：见下面 `flattenedKlWrapperDir` ——
   * 裸 `kl` 由解释器自己的 bin 目录提供（那里已在 PATH 首段）。
   */
  if (hasFlattenedPython(repoRoot)) {
    installFlattenedKlWrapper(repoRoot, klRoot, log)
    return
  }

  const binDir =
    process.platform === "win32"
      ? join(venvDir(repoRoot), "Scripts")
      : join(venvDir(repoRoot), "bin")

  if (process.platform === "win32") {
    /**
     * Windows 用 .cmd：PATH 上的 `kl` 会命中它。
     * `%~dp0` 是"这个脚本所在目录"（带尾斜杠），于是同样与位置无关。
     * `bin\..\..\..\..\..` = 仓库根（bin ← venv ← <plat> ← python ← vendor）。
     */
    const cmd = join(binDir, "kl.cmd")
    const cmdContent = [
      "@echo off",
      "rem 由 mycontext 生成（scripts/lib/python-env.mjs）——不要手改。",
      "rem 路径全部相对自身：这个文件入 git，绝对路径换台机器就废。",
      'set "_bin=%~dp0"',
      'cd /d "%_bin%..\\..\\..\\..\\..\\kl-graph" || exit /b 1',
      '"%_bin%python.exe" kl_cli.py %*',
      "",
    ].join("\r\n")
    // 幂等：内容没变就不写（见下面 `kl` 那条的理由）。
    if (!(existsSync(cmd) && readFileSync(cmd, "utf8") === cmdContent)) {
      writeFileSync(cmd, cmdContent, "utf8")
    }
    return
  }
  const wrapper = join(binDir, "kl")
  const content = [
    "#!/bin/bash",
    "# 由 mycontext 生成（scripts/lib/python-env.mjs）——不要手改。",
    "# 上游的 kl-graph/kl 硬编码了它自己的 .venv 路径，在这里不成立。",
    "#",
    "# ★★ 路径全部**相对自身**推出，文件里没有任何绝对路径。",
    "#",
    "# 这个 wrapper 跟整个 venv 一起入 git。写绝对路径的话，别人 clone 下来",
    "# 它指的是**生成它那台机器**的目录 —— 实测症状：搜索 agent 跑裸 `kl` 报",
    "# `cd: <别人的 home>/kl-graph: No such file or directory`，",
    "# 而 kl-server 自己好得很（主进程用绝对路径 spawn，绕过 wrapper）。",
    "# 那个不对称让它看起来像「检索坏了」而不是「wrapper 路径错了」。",
    "#",
    "# ★ 上面那句示例写成 `<别人的 home>` 而不是真的绝对路径 —— 否则",
    "# 「grep 一下这个文件里还有没有绝对路径」会被自己的注释绊住（试过，",
    "# 新加的那条测试当场报 kl 有残留，而它其实是干净的）。",
    "#",
    "# 层数：bin ← venv ← <platform> ← python ← vendor ← 仓库根 = 5 级。",
    '_self="${BASH_SOURCE[0]}"',
    "# 软链要跟到底 —— 有人可能把 kl 链到 /usr/local/bin 图省事。",
    'while [ -L "$_self" ]; do _self="$(readlink "$_self")"; done',
    '_bin="$(cd -- "$(dirname -- "$_self")" && pwd)"',
    '_repo="$(cd -- "$_bin/../../../../.." && pwd)"',
    'cd "$_repo/kl-graph" || exit 1',
    "# 同目录的 python 是相对软链（../../python/bin/python3），也与位置无关。",
    'exec "$_bin/python" kl_cli.py "$@"',
    "",
  ].join("\n")

  /**
   * ★ 幂等：内容一样就不写盘。
   *
   * 这个文件**入 git**，而这个函数在**每次应用启动**时都会被调（见
   * `python-env.ts` 的就绪分支）。无条件写的话每次启动都动一次工作区 ——
   * `git status` 永远脏，而那正是"绝对路径又被提交回去"的机制。
   *
   * 压平态那个分支（`installFlattenedKlWrapper`）本来就有这个判断，
   * venv 这条路原来漏了 —— 被新加的幂等测试抓到。
   */
  if (existsSync(wrapper) && readFileSync(wrapper, "utf8") === content) return

  writeFileSync(wrapper, content, { encoding: "utf8", mode: 0o755 })
  log(`已生成 kl 命令：${wrapper}`)
}

/**
 * 压平态（打包）的 `kl` wrapper —— 放解释器**自己**的 bin 里。
 *
 * ## ★★ 为什么压平态也需要一个 wrapper
 *
 * `venvEnv` 在压平态把解释器的 `bin/` 前插进 PATH，而那个目录里
 * **没有 `kl`**（实测 `ls .../python/bin | grep kl` → 空）。也就是原来注释里
 * 说的"裸 `kl` 靠 PATH 前插命中"在压平态是**空话**：搜索 agent 的 skill 里
 * 跑 `kl` 会 `command not found`，而 kl-server 自己好得很（主进程用绝对路径
 * spawn）。这个不对称正是上游那个 bug 的形状 —— 看起来像"检索坏了"。
 *
 * ## ★ 写盘安全性
 *
 * 与被我们刻意避开的 `relocateVenv` 不同，这一次写盘是**可失败的**：
 * · 写成功（.app 可写）→ 裸 `kl` 可用；
 * · 写失败（Gatekeeper 隔离 / 只读挂载）→ 吞掉异常，kl-server 仍然完全正常，
 *   只有 agent 里的裸 `kl` 不可用。
 *
 * 所以它**绝不能抛** —— 抛出去就会被上层 catch 成"整个 Python 环境不可用"，
 * 那正是这次要修的那个假报警（一个健康的环境被报成坏的）。
 *
 * 幂等：内容一样就不写，避免每次启动都动 .app 里的文件（改动会让已有的
 * 代码签名失效；虽然现在没签名，但别养这个习惯）。
 */
function installFlattenedKlWrapper(repoRoot, klRoot, log) {
  if (process.platform === "win32") return // Windows 还没有压平态产物

  const binDir = join(pythonCacheDir(repoRoot), "python", "bin")
  if (!existsSync(binDir)) return
  const wrapper = join(binDir, "kl")
  const python = flattenedPython(repoRoot)
  const content = [
    "#!/bin/bash",
    "# 由 mycontext 生成（scripts/lib/python-env.mjs）——不要手改。",
    "# 打包态：解释器是压平的自包含那份，没有 venv。",
    `cd "${klRoot}" || exit 1`,
    `exec "${python}" kl_cli.py "$@"`,
    "",
  ].join("\n")

  try {
    // 幂等：内容没变就不写（别每次启动都动 .app 里的文件）。
    if (existsSync(wrapper) && readFileSync(wrapper, "utf8") === content) return
    writeFileSync(wrapper, content, { encoding: "utf8", mode: 0o755 })
    log(`已生成 kl 命令：${wrapper}`)
  } catch {
    /**
     * ★ 吞掉：.app 只读（Gatekeeper 隔离）时写不进去，而那**不是**错误 ——
     * kl-server 走绝对路径，完全不受影响。抛出去会被上层 catch 成
     * "Python 环境不可用"，把一个健康的环境报成坏的。
     */
  }
}
