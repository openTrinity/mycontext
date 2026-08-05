/**
 * Python 解释器解析。
 *
 * 单独一个文件而不是并进 binaries.ts，有两个理由：
 *
 * 1. **它与「预置二进制」不是一类东西。** binaries.ts 解析的是随包分发或本机
 *    安装的**单个可执行文件**，按 `-{platform}-{arch}` 后缀定位。Python 是
 *    *宿主环境的一部分*：我们不分发它，也不关心它叫什么，只关心「能不能跑
 *    vendor/forge」——而那是个要**执行**候选才能回答的问题。
 *
 * 2. **binaries.ts 里有 opencode。** `tests/unit/agent-runtime/spawn-wiring.test.ts`
 *    用「文件里同时出现 opencode 与 spawn 调用」当门禁，防止有人绕过
 *    `buildOpencodeSpawn` 起一个无鉴权的 agent 进程。把 Python 的版本探测
 *    （一次 spawnSync）放进那个文件会触发它。那条门禁挡的是真实且严重的
 *    安全退化，所以正确的做法是让这段代码搬走，而不是把门禁调松。
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
  source: "env" | "path" | "system"
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
 * 三档解析。返回 null 表示「没有可用的解释器」。
 *
 * ★ 必须**执行**候选并读它的版本，不能只看文件在不在。
 *
 * 三种情况都是真实的：`python3` 在旧机器上可能是 3.6；`python` 可能是 2.7；
 * 而 Homebrew 与 pyenv 的 shim 可能存在但指向一个已被删掉的版本
 * （文件在、一跑就报错）。只判存在的话，这些都会在蒸馏启动时变成一条
 * 看不懂的 Python traceback，而不是一句「解释器版本太低」。
 *
 * 返回 null 而不抛错：缺 Python 是**预期状态**（我们刻意不打包解释器），
 * 蒸馏降级即可，应用其余部分照常工作。把预期状态做成异常，会让调用方
 * 到处写 try/catch 来表达「正常情况」。
 */
export function resolvePython(
  env: NodeJS.ProcessEnv = process.env,
  runVersionProbe: PythonVersionProbe = probePythonVersion,
): ResolvedPython | null {
  const candidates: { path: string; source: ResolvedPython["source"] }[] = []

  const explicit = env["MYCONTEXT_PYTHON_BIN"]
  if (explicit !== undefined && explicit !== "") {
    candidates.push({ path: explicit, source: "env" })
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
