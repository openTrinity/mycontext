/**
 * `ensurePythonEnv`：入 git 的 venv 每次启动都要重定位。
 *
 * ## 这条测试防的是什么
 *
 * venv 整个目录入 git（288MB 依赖，clone 下来就能用），代价是它在路径上
 * 绑死了生成它那台机器 —— `pyvenv.cfg` 的 `home =` 必须是绝对路径。
 *
 * 而「环境是否就绪」的判据（`isPythonEnvReady`）只看解释器文件在不在、
 * 依赖指纹对不对，**两者都与路径无关**。于是换一台机器：指纹照样对得上
 * （那是 requirements 的 hash），判定「就绪」→ 走快路径直接返回 →
 * 解释器一起来连 stdlib 都找不到：
 *
 *     ModuleNotFoundError: No module named 'encodings'
 *
 * 真机踩到过：`home` 指着另一个人的 `/Users/<name>/Projects/mycontext/...`，
 * kl-server 每次启动即退，日志里只有那行 encodings，而「python 环境就绪」
 * 是 true。症状与「python 没装」完全不同形，照着日志排查会走错方向。
 *
 * 共用的 `scripts/lib/python-env.mjs` 在自己的 ready 分支里会补这一步，
 * app 侧当时漏了 —— 也就是**同一份逻辑的两个入口不一致**，而只有 app 那条
 * 会在用户机器上跑。所以下面断言的是「快路径也调 relocate」，不是「结果能跑」：
 * 后者要真解释器，属 tests/externals。
 *
 * ## 后来又踩了一次：`kl` wrapper
 *
 * 同一个形状的第二个洞。`venv/bin/kl` 也入了 git、里面也是绝对路径，
 * 而 app 的 ready 分支只补了 `pyvenv.cfg`、没补 wrapper。结果是
 * kl-server 完全正常（它由主进程用绝对路径 spawn），只有搜索 agent 跑的
 * 裸 `kl` 挂掉 —— 报错指向一个**不存在的 checkout**，而界面上服务显示「就绪」。
 * 所以两个入口的一致性要逐个函数锁，不能只锁一个就以为这类问题过去了。
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "@mycontext/kernel"
import { ensurePythonEnv, type PythonEnvModule } from "@main/services/python-env.js"

const logger = createLogger("test", { level: "error" })

/** 记录调用顺序的替身，替掉真正的 `python-env.mjs`。 */
function fakeModule(ready: boolean): { module: PythonEnvModule; calls: string[] } {
  const calls: string[] = []
  const module: PythonEnvModule = {
    isPythonEnvReady: () => {
      calls.push("isPythonEnvReady")
      return ready
    },
    relocateVenv: () => {
      calls.push("relocateVenv")
      return true
    },
    installKlWrapper: () => {
      calls.push("installKlWrapper")
    },
    venvPython: () => "/fake/venv/bin/python3",
    venvEnv: (_root, base) => ({ ...base, VIRTUAL_ENV: "/fake/venv" }),
    ensurePythonEnv: () => {
      calls.push("install")
      return Promise.resolve("/fake/venv/bin/python3")
    },
  }
  return { module, calls }
}

const KL_ROOT = "/fake/repo/kl-graph"

describe("ensurePythonEnv", () => {
  it("★ 环境已就绪时也要重定位 venv（否则换机器就 encodings 报错）", async () => {
    const { module, calls } = fakeModule(true)

    const env = await ensurePythonEnv(KL_ROOT, logger, () => Promise.resolve(module))

    expect(env?.python).toBe("/fake/venv/bin/python3")
    /**
     * 少了 relocateVenv 不会报错、不会降级 —— 返回的 env 看起来完全正常，
     * 只有真去 spawn 的那个进程起不来。所以只能断言"调过"。
     */
    expect(calls).toContain("relocateVenv")
    // 就绪时不该联网装东西
    expect(calls).not.toContain("install")
  })

  /**
   * ★ wrapper 与 `pyvenv.cfg` 是同一类问题的两个受害者，所以分开锁两条。
   *
   * `vendor/python/<platform>/venv/bin/kl` 也入了 git，里面那两行是绝对路径
   * （`cd "<repo>/kl-graph"` + venv 解释器）。换一个 checkout 之后
   * `relocateVenv` 把 `pyvenv.cfg` 修好了 —— kl-server 起得来、`/health` ok、
   * 图里有数据 —— 而 wrapper 还指着生成它那台机器的目录。
   *
   * 于是只有走 PATH 的**裸 `kl`** 会踩到（主进程 spawn server 用绝对路径，
   * 绕过 wrapper）。真机症状：搜索 agent 报
   * `.../venv/bin/kl: line 4: cd: /Users/<另一处>/kl-graph:
   * No such file or directory`，而运行状态页说图谱服务「就绪」。
   * 这个不对称让它看起来像"检索坏了"，排查会一路查到 server 和端口上去。
   */
  it("★ 环境已就绪时也要重生成 kl wrapper（否则裸 kl 还指着别的 checkout）", async () => {
    const { module, calls } = fakeModule(true)

    await ensurePythonEnv(KL_ROOT, logger, () => Promise.resolve(module))

    expect(calls).toContain("installKlWrapper")
  })

  it("未就绪时走安装路径", async () => {
    const { module, calls } = fakeModule(false)

    const env = await ensurePythonEnv(KL_ROOT, logger, () => Promise.resolve(module))

    expect(env?.python).toBe("/fake/venv/bin/python3")
    // 安装自己就会重定位（在 .mjs 里），这条路径不额外要求 relocate
    expect(calls).toContain("install")
  })

  it("激活后的 env 会带上 VIRTUAL_ENV（spawn 直接用它）", async () => {
    const { module } = fakeModule(true)

    const env = await ensurePythonEnv(KL_ROOT, logger, () => Promise.resolve(module))

    expect(env?.env["VIRTUAL_ENV"]).toBe("/fake/venv")
  })

  it("找不到共用模块时返回 null（让调用方降级而不是崩）", async () => {
    expect(await ensurePythonEnv(KL_ROOT, logger, () => Promise.resolve(null))).toBeNull()
  })

  /**
   * ★★ `repoRootFrom(klRoot)` 反推出来的必须**正好是仓库根**。
   *
   * ## 为什么这条以前不存在，而它恰恰是最该锁的
   *
   * 上面每条测试都把 `KL_ROOT` 传进去，但**没有一条看它反推出了什么** ——
   * `load` 是注入的替身，无论 repoRoot 是什么它都返回同一个 module。
   * 于是层级数改错时全套测试照样绿。
   *
   * 而这件事真的发生过：kl 从 `external/kl-graph`（两层）搬到 `kl-graph`
   * （一层）时，`repoRootFrom` 必须同步从「上跳两级」变成「上跳一级」。
   * 漏改的表现**不是报错**：
   *
   * · 开发态反推到 `<repo>/..`（仓库外面那个目录，通常真的存在）→
   *   `loadModule` 在那儿找不到 `scripts/lib/python-env.mjs` → return null →
   *   上层日志一句 debug「assuming python is managed elsewhere」→ 静默降级；
   * · 打包态反推到 `Contents/` → 解释器 / mjs / requirements 三样全不在。
   *
   * 两种都是「kl 永远起不来且不报错」，而这正是本文件开头那类失效。
   *
   * 断言方式：`repoRootFrom` 不导出（它是实现细节），所以从 `load` 的**入参**
   * 反读 —— 那个参数就是它的返回值。这比断言"某个路径存在"更准：
   * 后者在层级数错一位时可能碰巧也成立。
   */
  it("★★ 从 klRoot 反推的仓库根正好上跳一级（层级数与打包布局是同一个约定）", async () => {
    const { module } = fakeModule(true)
    const seen: string[] = []

    await ensurePythonEnv(KL_ROOT, logger, (repoRoot) => {
      seen.push(repoRoot)
      return Promise.resolve(module)
    })

    // 用字面量而不是 join(KL_ROOT, "..")：后者等于把被测逻辑抄一遍
    expect(seen).toEqual(["/fake/repo"])
  })
})
