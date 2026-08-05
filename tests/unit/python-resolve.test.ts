/**
 * Python 解释器解析的回归测试。
 *
 * ## 为什么这层必须测「执行」而不只是「存在」
 *
 * forge 是纯 stdlib Python，但它用了 f-string、`dict[str, int]` 这类语法，
 * 3.9 以下直接语法失败。而机器上叫 `python3` 的东西**不保证**是 3.9+：
 *
 *   · 旧发行版上 `python3` 可能是 3.6；
 *   · `python` 在仍有 Python 2 的机器上是 2.7；
 *   · Homebrew / pyenv 的 shim 可能存在但指向已删除的版本（文件在、一跑就错）。
 *
 * 三种情况若只判文件存在，都会在蒸馏启动时变成一条看不懂的 Python traceback，
 * 而不是一句「解释器版本太低」。所以版本探测被做成可注入的 —— 真机上装了什么
 * 不该决定测试能覆盖哪些分支。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { PYTHON_MIN_VERSION, RuntimeEnv, type PythonVersionProbe } from "@mycontext/runtime-env"

const root = resolve(import.meta.dirname, "../..")

/** 一个真实存在的文件路径 —— isFile() 得先过，才轮到版本探测。 */
const REAL_FILE = join(root, "package.json")

function makeEnv(env: Record<string, string>): RuntimeEnv {
  return new RuntimeEnv({
    binDir: join(root, "apps/desktop/resources/bin"),
    dwsChannel: "test",
    dwsConfigDir: "/tmp/mycontext-test-dws",
    env,
  })
}

/** 固定返回某个版本，不管问的是哪个候选。 */
function probeReturning(version: readonly [number, number, number] | null): PythonVersionProbe {
  return () => version
}

describe("Python 解释器解析", () => {
  it("显式指定（MYCONTEXT_PYTHON_BIN）优先于 PATH", () => {
    const resolved = makeEnv({
      MYCONTEXT_PYTHON_BIN: REAL_FILE,
      PATH: "/nonexistent",
    }).tryResolvePython(probeReturning([3, 12, 0]))
    expect(resolved).not.toBeNull()
    expect(resolved?.path).toBe(REAL_FILE)
    expect(resolved?.source).toBe("env")
  })

  it("没有任何候选时返回 null，而不是抛错", () => {
    // 缺 Python 是**预期状态**：蒸馏降级，应用其余部分照常。
    // 做成异常会让调用方到处写 try/catch 来表达「正常情况」。
    //
    // 探测器一律返回 null 而不是只清空 PATH：系统固定位置那一档
    // （/usr/bin/python3 等）是刻意的兜底，在真机上照样命中 ——
    // 所以「没有可用解释器」要靠探测失败来构造，不能靠改 PATH。
    const resolved = makeEnv({ PATH: "/nonexistent" }).tryResolvePython(probeReturning(null))
    expect(resolved).toBeNull()
  })

  /**
   * ★ 这三条是这个文件存在的理由：候选文件在，但跑起来不合格。
   */
  it("版本低于下限的候选被跳过（旧 python3）", () => {
    const resolved = makeEnv({ MYCONTEXT_PYTHON_BIN: REAL_FILE }).tryResolvePython(
      probeReturning([3, 6, 15]),
    )
    expect(resolved).toBeNull()
  })

  it("Python 2 被跳过（`python` 在老机器上就是 2.7）", () => {
    const resolved = makeEnv({ MYCONTEXT_PYTHON_BIN: REAL_FILE }).tryResolvePython(
      probeReturning([2, 7, 18]),
    )
    expect(resolved).toBeNull()
  })

  it("跑不起来的候选被跳过（坏掉的 shim：文件在、一执行就失败）", () => {
    const resolved = makeEnv({ MYCONTEXT_PYTHON_BIN: REAL_FILE }).tryResolvePython(
      probeReturning(null),
    )
    expect(resolved).toBeNull()
  })

  it("正好等于下限版本是**可用**的（3.9 是下限，不是排除线）", () => {
    // macOS 自带的 /usr/bin/python3 就是 3.9.6，而 forge 完整自测在它上面全绿。
    // 把边界判成不可用，等于在所有没装第三方 Python 的 Mac 上直接放弃蒸馏。
    const [major, minor] = PYTHON_MIN_VERSION
    const resolved = makeEnv({ MYCONTEXT_PYTHON_BIN: REAL_FILE }).tryResolvePython(
      probeReturning([major, minor, 0]),
    )
    expect(resolved).not.toBeNull()
    expect(resolved?.version).toEqual([major, minor, 0])
  })

  it("跳过不合格的候选，继续找到后面合格的那个", () => {
    // 真实形态：PATH 前面是 pyenv 的 3.6，后面才是系统的 3.11。
    // 命中第一个存在的文件就返回，会让这台机器永远用不上蒸馏。
    //
    // 两个目录里都真的放一个同名文件，靠探测器区分版本 —— 这样断言的是
    // **解析顺序**，而不是「哪个文件恰好存在」。
    const dir = mkdtempSync(join(tmpdir(), "mycontext-py-"))
    const staleDir = join(dir, "stale")
    const goodDir = join(dir, "good")
    const exe = process.platform === "win32" ? "python.exe" : "python3"
    mkdirSync(staleDir)
    mkdirSync(goodDir)
    writeFileSync(join(staleDir, exe), "")
    writeFileSync(join(goodDir, exe), "")

    const resolved = makeEnv({ PATH: [staleDir, goodDir].join(delimiter) }).tryResolvePython(
      (path) => (path.startsWith(goodDir) ? [3, 11, 0] : [3, 6, 0]),
    )

    expect(resolved?.path).toBe(join(goodDir, exe))
    expect(resolved?.source).toBe("path")
    rmSync(dir, { recursive: true, force: true })
  })

  it("报告实际版本与来源档位（状态页要靠它解释为什么降级）", () => {
    const resolved = makeEnv({ MYCONTEXT_PYTHON_BIN: REAL_FILE }).tryResolvePython(
      probeReturning([3, 13, 2]),
    )
    expect(resolved?.version).toEqual([3, 13, 2])
    expect(resolved?.source).toBe("env")
  })

  it("默认探测器在本机能找到 Python（不注入时走真实探测）", () => {
    // 这条是**集成**断言：上面全是注入的，若默认探测器本身写错了
    // （比如那段 -c 脚本有语法问题），上面 8 条依然全绿。
    const resolved = new RuntimeEnv({
      binDir: join(root, "apps/desktop/resources/bin"),
      dwsChannel: "test",
      dwsConfigDir: "/tmp/mycontext-test-dws",
    }).tryResolvePython()
    // CI 与开发机都有 Python 3.9+（macOS 自带）。真没有时这条会失败 ——
    // 那也是应该知道的事，而不是静默跳过。
    expect(resolved).not.toBeNull()
    const [major, minor] = PYTHON_MIN_VERSION
    expect(resolved!.version[0]).toBeGreaterThanOrEqual(major)
    if (resolved!.version[0] === major) {
      expect(resolved!.version[1]).toBeGreaterThanOrEqual(minor)
    }
  })
})
