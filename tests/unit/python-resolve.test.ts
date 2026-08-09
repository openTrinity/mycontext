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
import { PYTHON_MIN_VERSION, RuntimeEnv, bundledPythonExe } from "@mycontext/runtime-env"
import type { PythonVersionProbe } from "@mycontext/runtime-env"

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

  /**
   * ★★ 内置那一档：这几条防的是一个**已经发生过**的静默错配。
   *
   * 加这一档之前最高优先级是 PATH，而 PATH 上的 `python3` 跟本项目无关。
   * 实测（本机）：`which python3` 是**另一个项目 venv 里的 3.14.5**，
   * 于是蒸馏与 persona 判定一直跑在那个解释器上 —— 它随时可能被那个项目
   * 删掉或升级，而表现是蒸馏突然降级，没有任何东西解释为什么。
   */
  describe("内置解释器优先", () => {
    /** 铺一个假的 `vendor/python/<plat>/python/bin/python3`（内容无所谓，只要文件在）。 */
    function fakeRepo(): { repoRoot: string; exe: string; cleanup: () => void } {
      const repoRoot = mkdtempSync(join(tmpdir(), "mycontext-repo-"))
      const exe = bundledPythonExe(repoRoot)
      mkdirSync(join(exe, ".."), { recursive: true })
      writeFileSync(exe, "")
      return { repoRoot, exe, cleanup: () => rmSync(repoRoot, { recursive: true, force: true }) }
    }

    it("内置那份排在 PATH **之前**（PATH 上有个能跑的也不用它）", () => {
      const { repoRoot, exe, cleanup } = fakeRepo()
      // PATH 上放一个同样合格的候选：断言的是**顺序**，不是「只有一个能用」。
      const pathDir = mkdtempSync(join(tmpdir(), "mycontext-path-"))
      const name = process.platform === "win32" ? "python.exe" : "python3"
      writeFileSync(join(pathDir, name), "")

      const resolved = new RuntimeEnv({
        binDir: join(root, "apps/desktop/resources/bin"),
        dwsChannel: "test",
        dwsConfigDir: "/tmp/mycontext-test-dws",
        env: { PATH: pathDir },
        repoRoot,
      }).tryResolvePython(probeReturning([3, 12, 11]))

      expect(resolved?.path).toBe(exe)
      expect(resolved?.source).toBe("bundled")
      cleanup()
      rmSync(pathDir, { recursive: true, force: true })
    })

    it("MYCONTEXT_PYTHON_BIN 仍然盖过内置（逃生阀不能被堵掉）", () => {
      const { repoRoot, cleanup } = fakeRepo()
      const resolved = new RuntimeEnv({
        binDir: join(root, "apps/desktop/resources/bin"),
        dwsChannel: "test",
        dwsConfigDir: "/tmp/mycontext-test-dws",
        env: { MYCONTEXT_PYTHON_BIN: REAL_FILE, PATH: "/nonexistent" },
        repoRoot,
      }).tryResolvePython(probeReturning([3, 12, 0]))

      expect(resolved?.path).toBe(REAL_FILE)
      expect(resolved?.source).toBe("env")
      cleanup()
    })

    it("内置的**跑不起来**时退回本机（压平产物可能被拷坏）", () => {
      // `build-python-bundle.mjs` 的注释里记着实测过的形态：拷贝解引用了
      // 相对软链之后解释器 dyld 失败。那时「文件在」是真的、「能跑」是假的，
      // 所以这一档也必须探测而不是判存在。
      const { repoRoot, exe, cleanup } = fakeRepo()
      const pathDir = mkdtempSync(join(tmpdir(), "mycontext-path-"))
      const name = process.platform === "win32" ? "python.exe" : "python3"
      writeFileSync(join(pathDir, name), "")

      const resolved = new RuntimeEnv({
        binDir: join(root, "apps/desktop/resources/bin"),
        dwsChannel: "test",
        dwsConfigDir: "/tmp/mycontext-test-dws",
        env: { PATH: pathDir },
        repoRoot,
        // 内置那个探测失败，PATH 上那个合格
      }).tryResolvePython((path) => (path === exe ? null : [3, 11, 0]))

      expect(resolved?.path).toBe(join(pathDir, name))
      expect(resolved?.source).toBe("path")
      cleanup()
      rmSync(pathDir, { recursive: true, force: true })
    })

    it("不给 repoRoot 时没有内置这一档（既有调用方行为不变）", () => {
      const resolved = makeEnv({ PATH: "/nonexistent" }).tryResolvePython(
        probeReturning([3, 12, 0]),
      )
      // 系统固定位置那一档仍在，所以只断言"不是 bundled"。
      expect(resolved?.source).not.toBe("bundled")
    })

    /**
     * ★★ 两份路径实现的**防漂移门禁**。
     *
     * `packages/runtime-env/src/python.ts` 的 `bundledPythonExe()` 与
     * `scripts/lib/python-runtime.mjs` 的同名函数算的是同一个路径。
     * 不复用后者是因为它是 `.mjs`、只能异步 import，而 `bootstrapApp` 是同步的
     * （见那边注释）。两份实现必然漂移，所以用一条测试钉住 ——
     * 「注释说要同步改」在这个仓库里已经失效过一次（kl 的目录层数那处，
     * 见 `services/python-env.ts` 的 `repoRootFrom` 注释）。
     */
    it("与 scripts/lib/python-runtime.mjs 算出同一个路径", async () => {
      // 类型来自 tests/python-runtime-mjs.d.ts —— 那份刻意写了真实签名而不是
      // any，好让「上游改了返回形状」先在 tsc 上红（见它的文件头）。
      const mjs = await import("../../scripts/lib/python-runtime.mjs")
      const fake = join(tmpdir(), "mycontext-drift-check")
      expect(bundledPythonExe(fake)).toBe(mjs.bundledPythonExe(fake))
    })
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
