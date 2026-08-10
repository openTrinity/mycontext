/**
 * work 层的攒批判据。
 *
 * ## 这里锁的是**成本**
 *
 * forge 免费（纯本地测量、零模型调用，实测 4400 条约 5 秒），所以它挂在
 * 6 小时定时器上无所谓。work 层每个 facet 是一次上万 token 的调用，一轮四个
 * —— 挂同一个定时器就是**每天 4 次为同一批老语料付钱**。
 *
 * 而那正是 LLM 那半当年被整个关掉的原因（`DistillService` 文件头：产出没人读、
 * 成本照付、且不报错）。接回来时原样复活那个成本模型，等于把当时的结论作废
 * —— 所以下面这组断言是这一层能不能开着的前提，不是优化。
 *
 * 判据形状抄 `knowledge-feed/auto-build.ts`（那边解决的是同一个问题：
 * 一次很贵的操作挂在一个很密的定时器上），所以断言也照它的分组来。
 */
import { describe, expect, it } from "vitest"
import {
  decideWorkRefresh,
  workBackoffMs,
  WORK_BACKOFF_MS,
  WORK_LAG_THRESHOLD,
  WORK_MAX_AGE_MS,
} from "@mycontext/distill"

const NOW = 1_785_000_000_000

/** 稳态：产物在、开着、有 LLM、刚跑过、没有新数据。 */
function base() {
  return {
    latestSeq: 1000,
    lastRunSeq: 1000,
    lastRunAt: NOW - 60_000,
    now: NOW,
    artifactExists: true,
    enabled: true,
    llmReady: true,
  }
}

describe("★★ 硬闸：关着或没配 key 一律不跑", () => {
  it("★★ 用户没开 work 层 → disabled", () => {
    const d = decideWorkRefresh({ ...base(), enabled: false, artifactExists: false })
    expect(d).toEqual({ run: false, reason: "disabled" })
  })

  it("★★ 没有可用的 LLM → no-llm，而不是起一轮注定失败的", () => {
    /**
     * 起了的结果是 `mapWithLlm` 抛 `CONFIG_INVALID`（那是对的：静默产 0 条
     * 会让"少配了一个 key"永远不被发现）。但那条错误该在用户**点按钮**时
     * 报给他，而不是由定时器每 6 小时往日志里刷一次。
     */
    const d = decideWorkRefresh({ ...base(), llmReady: false, artifactExists: false })
    expect(d).toEqual({ run: false, reason: "no-llm" })
  })

  it("★ 每个跳过原因都能区分（笼统的「跳过」会让没配 key 永远不被发现）", () => {
    const reasons = new Set([
      decideWorkRefresh({ ...base(), enabled: false }).reason,
      decideWorkRefresh({ ...base(), llmReady: false }).reason,
      decideWorkRefresh({ ...base() }).reason,
      decideWorkRefresh({ ...base(), latestSeq: 1050 }).reason,
    ])
    expect(reasons).toEqual(new Set(["disabled", "no-llm", "no-new-data", "below-threshold"]))
  })
})

describe("★★ 首次必须跑（否则新用户永远等不到产出）", () => {
  it("★★ 产物不在 → 立刻跑，不受条数阈值约束", () => {
    const d = decideWorkRefresh({ ...base(), artifactExists: false, latestSeq: 5, lastRunSeq: 0 })
    expect(d.run).toBe(true)
    expect(d).toMatchObject({ reason: "first-run" })
  })

  it("★★ 产物被删过（游标还在）也算首次", () => {
    /**
     * 这是 `artifactExists` 而不是 `lastRunSeq === 0` 的全部理由：产物可能被
     * 删过（换 vault、用户清过 skill 包、上一轮因置信度不足而删了它），
     * 那时游标还在。只看游标会让这些情况永远不再产出，且界面上看不出来。
     */
    const d = decideWorkRefresh({ ...base(), artifactExists: false })
    expect(d).toMatchObject({ run: true, reason: "first-run" })
  })

  it("★ 但一条语料都没有时不跑（模型只能编）", () => {
    const d = decideWorkRefresh({
      ...base(),
      artifactExists: false,
      latestSeq: 0,
      lastRunSeq: 0,
    })
    expect(d).toEqual({ run: false, reason: "no-new-data" })
  })
})

describe("★★ 攒批：不为几条消息重抽一轮", () => {
  it("★★ 稳态下没有新数据 → 不跑（同一份语料抽出来的结论一样）", () => {
    expect(decideWorkRefresh(base())).toEqual({ run: false, reason: "no-new-data" })
  })

  it("★★ 有新数据但没攒够 → below-threshold", () => {
    const d = decideWorkRefresh({ ...base(), latestSeq: 1000 + WORK_LAG_THRESHOLD - 1 })
    expect(d).toEqual({ run: false, reason: "below-threshold" })
  })

  it("★★ 攒够条数 → 跑，并报出攒了多少", () => {
    const d = decideWorkRefresh({ ...base(), latestSeq: 1000 + WORK_LAG_THRESHOLD })
    expect(d).toEqual({
      run: true,
      reason: "lag-threshold",
      newMessages: WORK_LAG_THRESHOLD,
    })
  })

  it("★★ 攒够时间**且有新数据** → 跑（低频用户也不该看一份三周前的画像）", () => {
    const d = decideWorkRefresh({
      ...base(),
      latestSeq: 1005,
      lastRunAt: NOW - WORK_MAX_AGE_MS,
    })
    expect(d).toMatchObject({ run: true, reason: "max-age" })
  })

  it("★★ 攒够时间但**没有**新数据 → 仍然不跑（纯浪费）", () => {
    /**
     * 这一条是"攒够时间"那条的必要配对。少了它，一个不再活跃的账号会
     * 每 3 天为完全相同的语料付一轮钱，而结论一个字都不会变。
     */
    const d = decideWorkRefresh({ ...base(), lastRunAt: NOW - WORK_MAX_AGE_MS * 2 })
    expect(d).toEqual({ run: false, reason: "no-new-data" })
  })

  it("水位倒退（历史被裁剪）不会算出负数", () => {
    /**
     * 用 changelog 的 seq 而不是消息条数正是为了这个 —— 但即便如此，
     * 游标比当前水位大（库被换过）时也不该产出负的 newMessages。
     */
    const d = decideWorkRefresh({ ...base(), latestSeq: 10, lastRunSeq: 1000 })
    expect(d).toEqual({ run: false, reason: "no-new-data" })
  })
})

describe("★★ 失败要退避，否则会每 6 小时刷一次同样的 warn", () => {
  it("退避时长按连续失败次数递增，并在最后一档封顶", () => {
    expect(workBackoffMs(0)).toBe(0)
    expect(workBackoffMs(1)).toBe(WORK_BACKOFF_MS[0])
    expect(workBackoffMs(2)).toBe(WORK_BACKOFF_MS[1])
    expect(workBackoffMs(3)).toBe(WORK_BACKOFF_MS[2])
    // 不做无限退避：配置修好后最多等最后一档就会自己恢复
    expect(workBackoffMs(99)).toBe(WORK_BACKOFF_MS[WORK_BACKOFF_MS.length - 1])
  })

  it("★★ 退避窗口内不跑，即使判据本来成立", () => {
    const d = decideWorkRefresh({
      ...base(),
      latestSeq: 9999,
      consecutiveFailures: 1,
      lastFailureAt: NOW - 60_000,
    })
    expect(d).toEqual({ run: false, reason: "backoff" })
  })

  it("退避过了就再试", () => {
    const d = decideWorkRefresh({
      ...base(),
      latestSeq: 9999,
      consecutiveFailures: 1,
      lastFailureAt: NOW - WORK_BACKOFF_MS[0] - 1,
    })
    expect(d).toMatchObject({ run: true })
  })

  it("★★ 退避排在「首次」之前", () => {
    /**
     * 反过来的话「还没抽过 + 每次都失败」这个组合会每轮都重试 ——
     * 而那恰好是最常见的失败场景（没配 key 的新用户），
     * 于是每 6 小时烧一次失败的调用并刷一条同样的日志。
     */
    const d = decideWorkRefresh({
      ...base(),
      artifactExists: false,
      consecutiveFailures: 2,
      lastFailureAt: NOW - 1000,
    })
    expect(d).toEqual({ run: false, reason: "backoff" })
  })

  it("硬闸排在退避之前（关着的时候连退避都不必判）", () => {
    const d = decideWorkRefresh({
      ...base(),
      enabled: false,
      consecutiveFailures: 1,
      lastFailureAt: NOW - 1000,
    })
    expect(d).toEqual({ run: false, reason: "disabled" })
  })
})

describe("阈值本身", () => {
  it("★ 条数阈值比建图那边（500）低 —— work 层一轮便宜两个量级", () => {
    expect(WORK_LAG_THRESHOLD).toBeLessThan(500)
    expect(WORK_LAG_THRESHOLD).toBeGreaterThan(0)
  })

  it("★ 时间阈值比建图那边（24h）长 —— 职责与工作方式按周变，不按天抖", () => {
    expect(WORK_MAX_AGE_MS).toBeGreaterThan(24 * 60 * 60 * 1000)
  })
})
