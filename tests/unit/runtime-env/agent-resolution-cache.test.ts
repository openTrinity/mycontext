/**
 * agent 解析结果缓存的回归测试。
 *
 * ## 为什么这一层值得单独测
 *
 * 它守的是一个**已经真实发生过**的故障，而那个故障的形态是"静默且不自愈"：
 *
 * 那个 agent 二进制 132MB，macOS 首次执行要全量校验签名，冷启动实测
 * 2.4–3.6s（热启动 ~270ms）。探针原来 5s 超时，恰好落在临界区 —— 应用启动
 * 后第一次探测超时，被上层读成"版本读不出来"，然后**连失败一起缓存住**。
 * 之后二进制早就热了，这个进程却再也不重试：UI 上"未检测到 opencode"的
 * 降级横幅一直挂着，只有重启应用才能恢复。
 *
 * 没有测试的话，这个 bug 的复现条件（"文件刚落盘 + 那一次恰好超时"）
 * 在开发机上几乎撞不到 —— 它只在同事第一次拉代码时炸。
 *
 * 所以断言的核心是 **调用次数**：失败后必须再探，成功后必须不再探。
 */
import { describe, expect, it } from "vitest"
import { createAgentResolver, type OpencodeResolution } from "@mycontext/runtime-env"

/**
 * 假的 RuntimeEnv：按脚本依次返回预设结果，并记录被问了几次。
 *
 * 只需要 `resolveUsableOpencode` 一个方法（`createAgentResolver` 收的是
 * `Pick<RuntimeEnv, …>`）——不必造整个 RuntimeEnv，那会把测试绑到
 * binDir/dwsConfigDir 这些与本层无关的构造参数上。
 */
function fakeRuntime(script: OpencodeResolution[]): {
  runtime: { resolveUsableOpencode: () => OpencodeResolution }
  calls: () => number
} {
  let calls = 0
  return {
    runtime: {
      resolveUsableOpencode: () => {
        const next = script[Math.min(calls, script.length - 1)]
        calls += 1
        // 脚本不会为空（调用方都给了至少一项）；兜底只为类型收窄。
        return next ?? { ok: false, reason: "missing" }
      },
    },
    calls: () => calls,
  }
}

const OK: OpencodeResolution = {
  ok: true,
  binary: { name: "opencode", path: "/tmp/oc", platform: "darwin-arm64", source: "bundled" },
  version: "1.18.11",
}
const UNREADABLE: OpencodeResolution = {
  ok: false,
  reason: "unreadable_version",
  binary: { name: "opencode", path: "/tmp/oc", platform: "darwin-arm64", source: "bundled" },
}

describe("createAgentResolver · 成功缓存", () => {
  it("成功后不再探测（省掉每轮 ~270ms 的 spawn）", () => {
    const { runtime, calls } = fakeRuntime([OK])
    const resolve = createAgentResolver(runtime, () => "1.18.11")
    expect(resolve().ok).toBe(true)
    expect(resolve().ok).toBe(true)
    expect(resolve().ok).toBe(true)
    expect(calls()).toBe(1)
  })

  it("缓存的是同一个对象（调用方可以按引用比较）", () => {
    const { runtime } = fakeRuntime([OK])
    const resolve = createAgentResolver(runtime, () => "1.18.11")
    expect(resolve()).toBe(resolve())
  })
})

describe("★ createAgentResolver · 失败不缓存（真实故障的回归）", () => {
  /**
   * ★ 这是整个文件的理由所在。
   *
   * 第一次假失败（冷启动超时）之后，第二次必须**重新探测**并拿到成功 ——
   * 而不是把那次抖动固化成整个进程生命周期的降级。
   */
  it("首次失败、二次成功 → 第二次调用就恢复（不用重启应用）", () => {
    const { runtime, calls } = fakeRuntime([UNREADABLE, OK])
    const resolve = createAgentResolver(runtime, () => "1.18.11")

    const first = resolve()
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.reason).toBe("unreadable_version")

    const second = resolve()
    expect(second.ok).toBe(true)
    expect(calls()).toBe(2)
  })

  it("持续失败 → 每次都重探（不静默卡在第一次的结论上）", () => {
    const { runtime, calls } = fakeRuntime([UNREADABLE])
    const resolve = createAgentResolver(runtime, () => null)
    resolve()
    resolve()
    resolve()
    expect(calls()).toBe(3)
  })

  it("missing 也不缓存（用户装上之后下一次就该认出来）", () => {
    const { runtime, calls } = fakeRuntime([{ ok: false, reason: "missing" }, OK])
    const resolve = createAgentResolver(runtime, () => "1.18.11")
    expect(resolve().ok).toBe(false)
    expect(resolve().ok).toBe(true)
    expect(calls()).toBe(2)
  })

  /**
   * 恢复之后要重新变成"不再探" —— 否则就从"永不重试"翻到了另一个极端
   * （每轮都花 270ms spawn 一次）。
   */
  it("恢复成功之后重新开始缓存", () => {
    const { runtime, calls } = fakeRuntime([UNREADABLE, OK])
    const resolve = createAgentResolver(runtime, () => "1.18.11")
    resolve() // 失败
    resolve() // 成功 → 开始缓存
    resolve()
    resolve()
    expect(calls()).toBe(2)
  })
})

describe("createAgentResolver · 探针透传", () => {
  it("把探针原样交给 resolveUsableOpencode（不自己解析版本）", () => {
    let received: unknown = null
    const probe = (): string => "1.18.11"
    const resolve = createAgentResolver(
      {
        resolveUsableOpencode: (p) => {
          received = p
          return OK
        },
      },
      probe,
    )
    resolve()
    expect(received).toBe(probe)
  })
})
