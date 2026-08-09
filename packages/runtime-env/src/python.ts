/**
 * Python 解释器解析。
 *
 * 单独一个文件而不是并进 binaries.ts，有两个理由：
 *
 * 1. **它与「预置二进制」不是一类东西。** binaries.ts 解析的是按
 *    `-{platform}-{arch}` 后缀定位的**单个可执行文件**。Python 是一棵树
 *    （解释器 + 标准库），而「这棵树能不能跑 vendor/forge」是个要**执行**
 *    候选才能回答的问题 —— binaries.ts 那套判存在的逻辑答不了。
 *
 * 2. **binaries.ts 里有 opencode。** `tests/unit/agent-runtime/spawn-wiring.test.ts`
 *    用「文件里同时出现 opencode 与 spawn 调用」当门禁，防止有人绕过
 *    `buildOpencodeSpawn` 起一个无鉴权的 agent 进程。把 Python 的版本探测
 *    （一次 spawnSync）放进那个文件会触发它。那条门禁挡的是真实且严重的
 *    安全退化，所以正确的做法是让这段代码搬走，而不是把门禁调松。
 *
 * ## ★ 解释器现在**随包分发**（这一段曾经写的是相反的话）
 *
 * 原来的注释说「我们不分发它，也不关心它叫什么」，而那是 kl 进来之前的事实。
 * 现在 `vendor/python/` 里有一个我们钉版本的 CPython（入 git，打包时压平进
 * `Resources/`），所以解析的第一目标是**它**，本机的只作兜底 ——
 * 见 `resolvePython` 里那一档的注释。
 */
import { statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { delimiter, join } from "node:path"

/**
 * forge 引擎能跑的最低 Python 版本。
 *
 * 3.9 是实测下限（macOS 自带 /usr/bin/python3 就是 3.9.6，vendor/forge 的
 * 768 项自测在它上面全绿）。定成常量而不是散在判断里：这个数字是**契约**，
 * 随 vendor/forge 升级而变，改的时候要能一眼找到。
 */
export const PYTHON_MIN_VERSION: readonly [number, number] = [3, 9]

export interface ResolvedPython {
  /** 绝对路径 */
  path: string
  /** 实际版本，如 [3, 9, 6] —— 状态页要显示，诊断「为什么降级」全靠它 */
  version: readonly [number, number, number]
  /** 从哪一档解析出来的 */
  source: "bundled" | "env" | "path" | "system"
}

/**
 * 候选名。
 *
 * 顺序有意义：`python3` 优先于 `python` —— 在仍存在 Python 2 的机器上，
 * `python` 可能是 2.7，而那会在 forge 的第一个 f-string 上炸掉，
 * 报的是语法错误而不是「版本太低」。
 */
const PYTHON_EXES =
  process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"]

/**
 * 系统固定位置。
 *
 * 这一档不是冗余：GUI 应用进程继承的 PATH 常常被裁剪过（不经过 shell 的
 * rc 文件），于是开发者在终端里 `which python3` 有结果，而应用里没有。
 */
const PYTHON_SYSTEM_PATHS =
  process.platform === "win32"
    ? []
    : ["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3"]

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * 探测一个候选解释器的版本。可注入：测试要能构造「3.6」「Python 2」
 * 「文件在但跑不起来」这些情况，而它们在真机上取决于装了什么。
 */
export type PythonVersionProbe = (path: string) => readonly [number, number, number] | null

/**
 * 默认探测：执行候选并读版本号。
 *
 * 用 `sys.version_info` 而不是 `--version`：后者在 Python 2 上打到 **stderr**
 * 而 3.x 打到 stdout，解析要分两种情况；而这段脚本在 2.7 上会直接语法失败
 * （`print` 是语句），失败即淘汰 —— 正是我们要的结果。
 */
export function probePythonVersion(path: string): readonly [number, number, number] | null {
  const result = spawnSync(path, ["-c", "import sys;print('%d.%d.%d'%sys.version_info[:3])"], {
    encoding: "utf8",
    // 卡住的 shim 不能拖住启动：宁可当它不存在。
    timeout: 5_000,
  })
  if (result.status !== 0 || typeof result.stdout !== "string") return null
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(result.stdout.trim())
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * 内置解释器的可执行文件路径（纯字符串拼接，不碰磁盘）。
 *
 * ## ★★ 为什么这一层只要 base 解释器，不需要 venv
 *
 * forge 与 persona.py 是**纯标准库**（逐文件扫过 `vendor/forge` 全树与
 * `templates/persona/scripts/persona.py`：只有 stdlib 加 forge 自己拷进去的
 * `imruntime.py`，零三方包）。所以它们不需要 kl 那套「venv + 280MB 依赖 +
 * 可能联网安装」的异步准备流程，只需要一个**能跑的 3.9+ 解释器路径** ——
 * 而那是同步就能算出来的。
 *
 * ## ★ 开发态与打包态是**同一个**相对路径
 *
 * 两种形态下 `vendor/python/<plat>/python/` 都是那个自定位的 base 解释器：
 * · 开发态 —— 入 git 的那份（43MB 精简后，site-packages 里只有 pip）；
 * · 打包态 —— `build-python-bundle.mjs` 压平出来的那份（依赖装进了它自己的
 *   site-packages），落点 `Resources/vendor/python/<plat>`（镜像仓库布局）。
 *
 * 于是这里不必区分形态：多出来的 site-packages 对纯 stdlib 的调用方无害。
 * 与之相对，`scripts/lib/python-env.mjs` 的 `venvPython()` **必须**区分 ——
 * kl 要的是「装了依赖的那个」，而开发态那份 base 解释器里没有依赖。
 *
 * ## ★ 这个路径在仓库里有第二份实现，两边由测试钉住
 *
 * `scripts/lib/python-runtime.mjs` 的 `bundledPythonExe()` 算的是同一个路径。
 * 不复用它是因为**它是 .mjs 且只能异步 import**（主进程那边靠
 * `new Function` 藏起来的 `import()` 绕开 Vite 静态分析，见
 * `services/python-env.ts` 的注释），而这条路径要在同步的 `bootstrapApp` 里用。
 *
 * 两份实现会漂移，所以拿一条测试比对它们的输出（见
 * `tests/unit/python-resolve.test.ts`）—— 用门禁而不是注释来防，
 * 因为「注释说要同步改」在这个仓库里已经失效过一次（kl 的目录层数那处）。
 */
export function bundledPythonExe(repoRoot: string): string {
  const arch = process.arch === "x64" ? "x64" : process.arch
  const base = join(repoRoot, "vendor", "python", `${process.platform}-${arch}`, "python")
  return process.platform === "win32" ? join(base, "python.exe") : join(base, "bin", "python3")
}

/**
 * 四档解析。返回 null 表示「没有可用的解释器」。
 *
 * ★ 必须**执行**候选并读它的版本，不能只看文件在不在。
 *
 * 三种情况都是真实的：`python3` 在旧机器上可能是 3.6；`python` 可能是 2.7；
 * 而 Homebrew 与 pyenv 的 shim 可能存在但指向一个已被删掉的版本
 * （文件在、一跑就报错）。只判存在的话，这些都会在蒸馏启动时变成一条
 * 看不懂的 Python traceback，而不是一句「解释器版本太低」。
 *
 * 内置那一档也照样探测：压平产物可能被 `build-python-bundle.mjs` 之外的路径
 * 弄坏（拷贝解引用软链等，那个脚本的注释里记着实测过的 dyld 失败），
 * 而「文件在但起不来」正是我们要区分出来的那一类。
 *
 * ## ★★ 为什么内置排在 PATH **之前**
 *
 * 原来最高优先级的是 PATH，而 PATH 上的 `python3` 跟本项目毫无关系。
 * 实测（本机）：`which python3` 是**另一个项目 venv 里的 3.14.5**，
 * 于是蒸馏与 persona 判定一直跑在那个解释器上 —— 它随时可能被那个项目
 * 删掉或升级，而表现会是蒸馏突然降级、且没有任何东西解释为什么。
 * 内置那份（3.12.11）就在盘上、版本由我们钉、随包分发到用户机器，
 * 没有理由让它排在一个偶然的 PATH 命中之后。
 *
 * `MYCONTEXT_PYTHON_BIN` 仍然最高 —— 那是逃生阀（想用自己的环境时）。
 *
 * 返回 null 而不抛错：解释器不可用是**预期状态**（内置那份可能被裁掉、
 * 或平台还没准备），蒸馏降级即可，应用其余部分照常工作。把预期状态做成
 * 异常，会让调用方到处写 try/catch 来表达「正常情况」。
 */
export function resolvePython(
  env: NodeJS.ProcessEnv = process.env,
  runVersionProbe: PythonVersionProbe = probePythonVersion,
  /**
   * 仓库根（打包态是 `Resources/`，它镜像仓库布局）。给了才有内置那一档 ——
   * 不给时行为与加这一档之前完全一致，于是既有调用方（测试）不受影响。
   */
  repoRoot?: string | undefined,
): ResolvedPython | null {
  const candidates: { path: string; source: ResolvedPython["source"] }[] = []

  const explicit = env["MYCONTEXT_PYTHON_BIN"]
  if (explicit !== undefined && explicit !== "") {
    candidates.push({ path: explicit, source: "env" })
  }
  if (repoRoot !== undefined && repoRoot !== "") {
    candidates.push({ path: bundledPythonExe(repoRoot), source: "bundled" })
  }
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (dir === "") continue
    for (const exe of PYTHON_EXES) candidates.push({ path: join(dir, exe), source: "path" })
  }
  for (const path of PYTHON_SYSTEM_PATHS) candidates.push({ path, source: "system" })

  const [minMajor, minMinor] = PYTHON_MIN_VERSION
  for (const candidate of candidates) {
    if (!isFile(candidate.path)) continue
    const version = runVersionProbe(candidate.path)
    if (version === null) continue
    const [major, minor] = version
    if (major < minMajor || (major === minMajor && minor < minMinor)) continue
    return { path: candidate.path, version, source: candidate.source }
  }

  return null
}
