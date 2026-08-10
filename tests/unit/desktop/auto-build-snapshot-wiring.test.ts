/**
 * 「建图最小间隔」这个设置项**到得了判据吗**。
 *
 * ## 这一组锁的是一段谁都没测过的接线
 *
 * 用户在设置里改「建图最小间隔」，那个值要走完这一条链才有意义：
 *
 * ```
 * 设置面板 → ingestIntervals.graphBuildMinIntervalMs（存 app_settings）
 *          → data-plane.intervals()
 *          → startup.ts 的 autoBuild.minIntervalMs getter
 *          → ★ buildAutoBuildSnapshot（就是这一段）
 *          → decideAutoBuild（判据）
 * ```
 *
 * 两头都锁得很细：档位与 schema 的区间对齐（`ingest-intervals-panel.test.tsx`），
 * 判据有九条（`auto-build-min-interval.test.ts`）。而**中间这一段原来是裸的** ——
 * 反证时发现：把快照里那行 `minIntervalMs` 整个删掉，
 * 全仓 1023 条测试**一条都不红**。
 *
 * ## 那种断线为什么比"功能坏了"更糟
 *
 * 判据仍然正确、设置仍然存得进库、界面仍然显示用户选的值 ——
 * 只是那个值再也到不了判据，于是永远用缺省 1h。用户把它调成 6h，
 * 建图照旧每小时跑一次，而**没有任何地方说过谎**，
 * 也没有任何一条日志异常。只是没有人把话传过去。
 *
 * ★ 这正是 CLAUDE.md §4 说的那类最贵的 bug：静默降级。
 * 与 `buildIngestRequestBody` 那次同一个形状（测试替身只看参数，
 * 于是 body 的字段名换了没人发现），所以修法也一样：
 * 把接线提成纯函数，直接对它断言。
 */
import { describe, expect, it } from "vitest"
import { buildAutoBuildSnapshot, buildForecastInput } from "@main/services/feed.service.js"

/** 建图水位（`graphSync.buildWatermark()` 的形态）。 */
const MARK = { seq: 1200, at: 1_700_000_000_000 }

/**
 * 造一组 getter。默认全部"可以建"，这样断言里只需要关心被测的那一项。
 *
 * ★ 每个 getter 都记一次调用次数：快照必须**现读**而不是缓存
 * （用户改完设置要下一轮生效，见 `FeedServiceOptions.autoBuild` 的注释）。
 */
function makeHooks(minIntervalMs?: () => number) {
  const calls = { enabled: 0, ready: 0, graphExists: 0, minInterval: 0 }
  const hooks = {
    enabled: () => {
      calls.enabled += 1
      return true
    },
    ready: () => {
      calls.ready += 1
      return true
    },
    graphExists: () => {
      calls.graphExists += 1
      return true
    },
    trigger: () => Promise.resolve(true),
    ...(minIntervalMs === undefined
      ? {}
      : {
          minIntervalMs: () => {
            calls.minInterval += 1
            return minIntervalMs()
          },
        }),
  }
  return { hooks, calls }
}

describe("★★ 设置里的「建图最小间隔」要真的到判据", () => {
  /**
   * ★★ 这一条就是那段断线的直接反面。
   *
   * 反证：删掉快照里的 `minIntervalMs` 那一行 → 必须红。
   * （删掉之前全仓一条都不红，那正是加这一组的理由。）
   */
  it("★★ 配了 6h → 快照里就是 6h（不是缺省的 1h）", () => {
    const SIX_HOURS = 6 * 60 * 60 * 1000
    const { hooks } = makeHooks(() => SIX_HOURS)

    const snapshot = buildAutoBuildSnapshot(hooks, MARK)

    expect(snapshot.minIntervalMs).toBe(SIX_HOURS)
    // ★ 反面：不能是缺省值 —— 断线之后的表现恰好就是那个
    expect(snapshot.minIntervalMs).not.toBe(60 * 60 * 1000)
  })

  /**
   * ★★ **现读**：每次取快照都要重新调那个 getter。
   *
   * 缓存住的话用户改完设置要重启才生效，而"改了没反应"会被当成功能坏了
   * （`RuntimeEnv` 的 `dwsBinOverride` 踩过同一个坑）。
   */
  it("★★ 每次取快照都重新读设置（改完下一轮生效）", () => {
    let current = 15 * 60_000
    const { hooks, calls } = makeHooks(() => current)

    expect(buildAutoBuildSnapshot(hooks, MARK).minIntervalMs).toBe(15 * 60_000)
    // 用户在设置里改成 2h
    current = 2 * 60 * 60 * 1000
    expect(buildAutoBuildSnapshot(hooks, MARK).minIntervalMs).toBe(2 * 60 * 60 * 1000)
    expect(calls.minInterval).toBe(2)
  })

  /**
   * ★ 没给 getter 时**省略**这个字段，而不是给一个 `undefined`。
   *
   * 两者在 `decideAutoBuild` 里行为相同（`?? AUTO_BUILD_MIN_INTERVAL_MS`），
   * 但省略能让"没配过"与"配了个 undefined"在快照里长得不一样 ——
   * 而后者通常是接线出错的痕迹。
   */
  it("★ 没配 → 字段不出现（留给判据用缺省）", () => {
    const { hooks } = makeHooks()
    const snapshot = buildAutoBuildSnapshot(hooks, MARK)
    expect("minIntervalMs" in snapshot).toBe(false)
  })

  /** ★ 其余四项也要真的接上（水位来自参数，三个状态来自 getter）。 */
  it("★ 水位与三个状态一并接上", () => {
    const { hooks, calls } = makeHooks(() => 60_000)
    const snapshot = buildAutoBuildSnapshot(hooks, MARK)

    expect(snapshot.lastBuiltSeq).toBe(MARK.seq)
    expect(snapshot.lastBuiltAt).toBe(MARK.at)
    expect(snapshot.enabled).toBe(true)
    expect(snapshot.ready).toBe(true)
    expect(snapshot.graphExists).toBe(true)
    // 三个都是现读
    expect(calls).toMatchObject({ enabled: 1, ready: 1, graphExists: 1 })
  })

  /**
   * ★★ 三个状态**各自**接到自己那一路上。
   *
   * 这条防的是"接串了"：`enabled` 接到 `ready` 上之类。串了之后
   * 判据仍然会给出一个看起来合理的原因码，但那个原因码指向错的东西 ——
   * 而原因码正是用户唯一能看到的解释（`graph ingest skipped {reason}`）。
   */
  it("★★ 三个状态不能接串（各返回不同值时能区分）", () => {
    const snapshot = buildAutoBuildSnapshot(
      {
        enabled: () => true,
        ready: () => false,
        graphExists: () => false,
        trigger: () => Promise.resolve(true),
      },
      MARK,
    )
    expect(snapshot.enabled).toBe(true)
    expect(snapshot.ready).toBe(false)
    expect(snapshot.graphExists).toBe(false)
  })

  /**
   * ★ 首次建图那一档：水位为空时 `lastBuiltAt` 必须是 **null** 而不是 0。
   *
   * 判据里 `lastBuiltAt !== null` 是冷却的前置 —— 传 0 的话
   * `now - 0` 是个巨大的正数，冷却判定会"恰好通过"，
   * 而那不是我们想表达的意思（见 `decideAutoBuild` 里那段注释）。
   */
  it("★ 从没建过 → lastBuiltAt 是 null，不是 0", () => {
    const { hooks } = makeHooks(() => 60_000)
    const snapshot = buildAutoBuildSnapshot(hooks, { seq: 0, at: null })
    expect(snapshot.lastBuiltAt).toBeNull()
    expect(snapshot.lastBuiltAt).not.toBe(0)
  })
})

describe("★★★ 预测层的接线（界面倒计时的来源）", () => {
  /**
   * ★★★ 这一组与上面那组并列：一个喂**判据**（真的建不建），
   * 这个喂**预测**（界面说还要等多久）。两者必须读同一批值。
   *
   * 反证时发现预测这一段也是裸的：把传 `minIntervalMs` 那一行删掉，
   * 全仓 1068 条测试一条都不红。而漏传的后果是**界面按缺省 1h 倒计时** ——
   * 用户在设置里改成 6h，那句话还说 1 小时，且没有任何地方报错。
   *
   * 这正是那句自相矛盾的话的一半来源（另一半是 `forecastAutoBuild` 缺
   * `min-interval` 分支）：
   *
   * ```
   * 增量 25,477 / 500 条（还差 0 条） · 或 约 23 小时后按时间触发
   * ```
   */
  const MARK = { seq: 1200, at: 1_700_000_000_000 }
  const NOW = 1_700_000_600_000
  const HEAD = 9999

  function hooks(minIntervalMs?: number) {
    return {
      enabled: () => true,
      ready: () => true,
      graphExists: () => true,
      trigger: () => Promise.resolve(true),
      ...(minIntervalMs === undefined ? {} : { minIntervalMs: () => minIntervalMs }),
    }
  }

  /** ★★★ 配的冷却要到预测层 —— 不到就按缺省 1h 倒计时。 */
  it("★★★ 配了 6h → 预测输入里就是 6h", () => {
    const SIX_HOURS = 6 * 3_600_000
    expect(buildForecastInput(hooks(SIX_HOURS), MARK, HEAD, NOW).minIntervalMs).toBe(SIX_HOURS)
  })

  /** ★ 没配 → 省略该字段，交给判据用缺省（与 snapshot 同一口径）。 */
  it("★ 没配 → 字段不出现", () => {
    expect("minIntervalMs" in buildForecastInput(hooks(), MARK, HEAD, NOW)).toBe(false)
  })

  /**
   * ★★ `ackedSeq` 用的是 changelog 的 **head**，不是导出游标。
   *
   * 界面那个数字要回答「还差多少条会触发建图」，而导出是 10 分钟一轮的
   * 中间步骤 —— 拿导出游标会让数字在导出前后跳一下，看起来像倒退。
   */
  it("★★ ackedSeq 取 head（不是水位 seq）", () => {
    const input = buildForecastInput(hooks(), MARK, HEAD, NOW)
    expect(input.ackedSeq).toBe(HEAD)
    expect(input.lastBuiltSeq).toBe(MARK.seq)
  })

  /** ★ 水位与三个状态一并接上，且都是现读。 */
  it("★ 水位与状态接上", () => {
    const input = buildForecastInput(hooks(60_000), MARK, HEAD, NOW)
    expect(input.lastBuiltAt).toBe(MARK.at)
    expect(input.now).toBe(NOW)
    expect(input.enabled).toBe(true)
    expect(input.ready).toBe(true)
    expect(input.graphExists).toBe(true)
  })
})
