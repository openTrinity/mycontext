/**
 * @vitest-environment jsdom
 *
 * 引导第 4 步「蒸馏结果」的**信息层次**门禁。
 *
 * ## 为什么这一屏值得专门锁
 *
 * 用户的原话是「显示的我也看不懂」。而拆下来是三个具体缺陷，
 * 每一个都不会报错、也不会被别的测试发现：
 *
 * 1. **五个数字视觉权重一样**（四个 `Metric` 全是 14px + 一个等级）。
 *    但它们重要性差很远 —— 「配对」是学语气的**唯一**素材
 *    （只看自己说过的话，不知道那句在回什么，语气无从测量），
 *    而「产物个数」是纯过程量。同字号平铺 = 读者只看到一串数字。
 * 2. **「覆盖度 A」没有量表**。A 相对什么？满分是什么？界面一个字没说，
 *    而读者最容易猜错的方向是"A 是不是意味着像我了"—— 它不是，
 *    那是**覆盖率**（11 个层面测到了几个），产物自己的 fidelity.md
 *    专门写了这句区分。
 * 3. **黑话没有解释**。「配对（组）」四个字对没读过代码的人是空的。
 *
 * ## 断言的是**层次**，不是像素
 *
 * 不断言"字号是 26px"（那会因为设计系统调档位而变红，且换个档位
 * 层次仍然成立）。断言的是那几条**决定**：
 * · hero 用的是排版表里最大的那一档，而其余指标不是；
 * · 每屏只有一个 hero；
 * · 等级带量表与解释。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { I18nextProvider } from "react-i18next"
import { createI18n } from "@mycontext/i18n"
import type { ForgeStatusView, IngestSnapshot, MyContextApi } from "@mycontext/ipc-contract"
import { DistillStep } from "../../apps/desktop/src/renderer/features/onboarding/distill-step.js"

afterEach(cleanup)

/** jsdom 没有 ResizeObserver，而 Button 走 useSquircle 会用它。 */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver

/** 跑成功一轮的 forge 状态。数字取自这台机器的真实一轮（见 fidelity.md）。 */
function forge(over: Partial<ForgeStatusView> = {}): ForgeStatusView {
  return {
    available: true,
    unavailableReason: null,
    running: false,
    step: null,
    lastRunAt: 1_785_600_000_000,
    lastOk: true,
    failedStep: null,
    reason: null,
    messages: 1913,
    turns: 1552,
    asks: 331,
    files: 11,
    grade: "A",
    ...over,
  }
}

/**
 * 采集快照里跟这一屏有关的那一段。
 *
 * 只造 `backfill`（覆盖范围那句用它）与几个必填字段：
 * 这一屏不显示其余的数，给全一份真快照会让"哪几个字段真的被读了"
 * 在阅读时看不出来。
 */
function ingestSnapshot(backfill: IngestSnapshot["backfill"]): IngestSnapshot {
  return {
    running: true,
    channelId: "dingtalk",
    messages: 12075,
    conversations: 92,
    unjudged: 0,
    outboxHead: 12075,
    ftsIndexed: 12075,
    ftsLag: 0,
    probeIntervalMs: 15_000,
    probeThrottled: false,
    lastError: null,
    blockedReason: null,
    failedAttempts: 0,
    selfConfirmed: true,
    mediaAssets: 0,
    minutes: 0,
    storage: { mainBytes: 0, walBytes: 0, rawRecords: 0, rawPruned: 0, vectors: 0 },
    staleConsumers: [],
    backfill,
  }
}

function wrap(
  status: ForgeStatusView,
  options: {
    rangeDays?: number | null
    backfill?: IngestSnapshot["backfill"]
  } = {},
) {
  const api = {
    ingest: {
      snapshot: () =>
        Promise.resolve({
          ok: true as const,
          // 缺省 = 没有要补的（`remainingMs` 为 0），不是 null —— 契约里它不可空
          data: ingestSnapshot(
            options.backfill ?? {
              since: null,
              coveredFrom: null,
              remainingMs: 0,
              stalled: null,
              activeWindow: null,
              messages: 0,
              // ★ started: false —— 缺省不能是"已完成"，否则每个不关心覆盖范围的
              //   用例都在悄悄断言那个曾经的 bug（0 条也报"采完了"）。
              started: false,
            },
          ),
        }),
      onProgress: () => () => undefined,
    },
    distill: {
      progress: () =>
        Promise.resolve({
          ok: true as const,
          data: {
            total: 0,
            pending: 0,
            running: 0,
            done: 0,
            failed: 0,
            skipped: 0,
            costTokens: 0,
            lastError: null,
            facetCount: 0,
            running_: false,
            forge: status,
          },
        }),
      start: () => Promise.resolve({ ok: true as const, data: {} }),
      reset: () => Promise.resolve({ ok: true as const, data: {} }),
      onProgress: () => () => undefined,
    },
    /**
     * ★ 第 4 步现在也显示知识图谱那条链路，所以 `kl` 必须实现。
     *
     * 缺了会在渲染中抛 `Cannot read properties of undefined (reading
     * 'serverStatus')` —— 而那时整棵树渲染失败，用例报的是"找不到 1,552"，
     * 一个**正确结论、错误理由**的失败。
     *
     * 给一份「图已建好」的状态：这一组验的是蒸馏结果的层次，
     * 图谱那块只要不抛就行（它自己的断言在下面那一组）。
     */
    kl: {
      serverStatus: () =>
        Promise.resolve({
          ok: true as const,
          data: {
            state: "ready" as const,
            reason: null,
            port: 8200,
            building: false,
            networkEgress: true,
            buildProgress: null,
          },
        }),
      graphOverview: () =>
        Promise.resolve({
          ok: true as const,
          data: {
            available: true,
            reason: null,
            entities: 2436,
            facts: 7655,
            edges: 63967,
            chunks: 12012,
            messages: 11922,
            entityTypes: [],
            factTypes: [],
            hubs: [],
          },
        }),
      onStatus: () => () => undefined,
    },
  } as unknown as MyContextApi
  ;(globalThis as { window?: { mycontext?: MyContextApi } }).window ??= {}
  ;(window as unknown as { mycontext: MyContextApi }).mycontext = api

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <I18nextProvider i18n={createI18n("zh")}>
      <QueryClientProvider client={client}>
        <DistillStep rangeDays={options.rangeDays ?? null} modelConfigured />
      </QueryClientProvider>
    </I18nextProvider>,
  )
}

/** 找到含某段文字的那个元素的最近祖先里的 className 串（用来判字号档位）。 */
function classesAround(text: string | RegExp): string {
  const node = screen.getByText(text)
  const own = node.className
  const parent = node.parentElement?.className ?? ""
  return `${own} ${parent}`
}

describe("★★ 学习结果：一个主数字 + 支撑量（不是五个一样大的格子）", () => {
  it("★ 「配对」是 hero —— 用排版表里最大的那一档", async () => {
    wrap(forge())
    /**
     * 千位分隔也一起断言：1552 → `1,552`。
     * 四位数不分隔时读者要数位数，而这一屏最大的数就是四位起。
     */
    const hero = await screen.findByText("1,552")
    expect(hero.className).toContain("typography-title-large-600")
  })

  it("★★ 其余指标**不是** hero 字号（反证：不能全都放大）", async () => {
    wrap(forge())
    await screen.findByText("1,552")
    // 语料 1913 是支撑量 —— 与 hero 同档就等于又变回"一串数字"
    for (const value of ["1,913", "331", "11"]) {
      expect(screen.getByText(value).className).not.toContain("typography-title-large-600")
    }
  })

  it("★ 每屏只有一个 hero（那是大号字成立的前提）", async () => {
    const { container } = wrap(forge())
    await screen.findByText("1,552")
    expect(container.querySelectorAll(".typography-title-large-600")).toHaveLength(1)
  })

  it("★ hero 带一句「它为什么重要」（否则只是把黑话放大）", async () => {
    wrap(forge())
    await screen.findByText("1,552")
    // 「配对」这个词本身对没读过代码的人是空的
    expect(screen.getByText(/别人说什么/)).toBeTruthy()
  })
})

describe("★★ 覆盖度：给量表，不是一个孤立的字母", () => {
  it("★ 显示「A / 满分 A」而不是只有 A", async () => {
    wrap(forge({ grade: "A" }))
    expect(await screen.findByText("A / 满分 A")).toBeTruthy()
  })

  it("★★ 明说它是覆盖率、**不是**「像不像本人」", async () => {
    /**
     * 这是读者最容易猜错的方向，而产物自己的 fidelity.md 专门写了这句区分
     * （"It is **not** a claim that the persona reads convincingly"）。
     * 界面上不说的话，A 会被读成"已经像我了"。
     */
    wrap(forge({ grade: "A" }))
    await screen.findByText("A / 满分 A")
    expect(screen.getByText(/不是.*像不像本人/)).toBeTruthy()
  })

  it("★ 量表画四档（A–D），当前那档之前的都实心", async () => {
    const { container } = wrap(forge({ grade: "B" }))
    await screen.findByText("B / 满分 A")
    const dots = container.querySelectorAll("[aria-hidden] > span")
    // D C B A 四档
    expect(dots).toHaveLength(4)
    // B 是第 3 档（从 D 数起）→ 前 3 个实心
    const filled = [...dots].filter((d) => d.className.includes("--text-accent-normal"))
    expect(filled).toHaveLength(3)
  })

  it("★ 读不到等级时不假装是某一档（全空心 + 说未知）", async () => {
    const { container } = wrap(forge({ grade: null }))
    await screen.findByText("未知")
    // 不画量表 —— 猜一个档位比说"未知"糟
    expect(container.querySelectorAll("[aria-hidden] > span")).toHaveLength(0)
  })
})

describe("★ 失败项要看得出来", () => {
  it("★★ asks = 0 时标警示色（决策层整个是默认值）", async () => {
    wrap(forge({ asks: 0 }))
    await screen.findByText("1,552")
    expect(classesAround("0")).toContain("--status-warning")
  })

  it("★ 产物 0 个也标警示（那意味着白跑一趟）", async () => {
    wrap(forge({ files: 0, asks: 5 }))
    await screen.findByText("1,552")
    expect(classesAround("0")).toContain("--status-warning")
  })

  it("★ 正常值不标警示（反证：不能恒亮）", async () => {
    wrap(forge())
    await screen.findByText("1,552")
    expect(classesAround("331")).not.toContain("--status-warning")
  })
})

/**
 * ★★ 知识图谱那条链路必须在这一屏**出现**。
 *
 * ## 为什么这是一条"看不懂"的根因
 *
 * 数字分身回一条消息用两样东西：蒸馏给**语气**、图谱给**事实**。
 * 而图谱是启动时自动建的、此前在**整个界面上不存在** —— 用户看第 4 步
 * 会以为"蒸馏就是全部"，于是"这一步在做什么"少了一半。
 *
 * 实测过一条：小吴问「你最喜欢哪个歌手」，答出「卢广仲」靠的是图谱
 * （那句在 30 条上下文窗口之外，只有图谱搜得到）。
 *
 * ## 断言"出现 + 说清它管什么"，不断言数字
 *
 * 数字是真数据（会变）。要锁的是那个**决定**：这一屏承认有两条链路，
 * 并且说清了各管什么。
 */
describe("★★ 第 4 步要说清有两条链路（怎么说 + 说过什么）", () => {
  it("★ 知识库那一块在（此前整个界面都没有它）", async () => {
    wrap(forge())
    expect(await screen.findByText("知识库")).toBeTruthy()
  })

  it("★★ 说清两条链路的分工（语气 vs 事实）", async () => {
    wrap(forge())
    await screen.findByText("知识库")
    /**
     * ★ 「你怎么说话」与「你说过什么事」这个区分是这一整块存在的理由。
     *
     * 判据挑的是**后半句**（"说过什么事"）—— 它只在这一块出现。
     * 用"怎么说话"会同时命中上面阶段条的说明（"统计怎么说话"），
     * 那样断言就不是在验这一块了。
     */
    expect(screen.getByText(/说过什么事/)).toBeTruthy()
  })

  it("★ 三个数字用人话标签，不是 entities/facts/edges", async () => {
    wrap(forge())
    await screen.findByText("知识库")
    expect(screen.getByText("认识的人和系统")).toBeTruthy()
    expect(screen.getByText("记住的结论")).toBeTruthy()
    // 「关系」这种黑话在界面上没有意义 —— 要说"它们之间的联系"
    expect(screen.getByText("它们之间的联系")).toBeTruthy()
  })

  it("★ 数字用千位分隔（63967 → 63,967）", async () => {
    wrap(forge())
    expect(await screen.findByText("63,967")).toBeTruthy()
  })
})

/**
 * ★★ 覆盖范围那一句 —— 「选了 180 天但库里只有 10 天」的唯一出口。
 *
 * ## 它锁的是一次真实的困惑
 *
 * 用户在第 3 步选了 180 天，第 4 步显示「配对 1,552 组」，而实测库里
 * 最早一条消息只到 10 天前 —— 中间 170 天从未被采集。界面上没有任何
 * 地方说得清这件事，于是"这个数是不是错的"没法回答。
 *
 * 现在实时路仍只覆盖 7 天（冷启动不能等半小时），更早的由一条独立的
 * 回溯链慢慢补。补的过程要几十分钟到几小时，而**在此期间语料不全是
 * 正常的中间态** —— 这一组断言的就是"那个中间态必须说出来"。
 */
describe("★★ 覆盖范围：正在补历史时必须说出来", () => {
  it("★★ 报出三个数：选了多久 / 已采到多久 / 还差多久", async () => {
    const now = Date.now()
    wrap(forge(), {
      rangeDays: 180,
      backfill: {
        since: now - 180 * 86_400_000,
        // 库里最早那条是 30 天前 → 「已采到最近 30 天」
        coveredFrom: now - 30 * 86_400_000,
        // 还差 23 天到目标
        remainingMs: 23 * 86_400_000,
        stalled: null,
        activeWindow: null,
        messages: 500,
        started: true,
      },
    })

    // 三个数缺任何一个，这句话都回答不了"要不要等"
    // 文案已专业化（"选定 180 天，已覆盖最近 30 天，剩余 23 天…"），
    // 但断言的**意图不变**：三个数缺任何一个都回答不了"要不要等"。
    expect(await screen.findByText(/选定 180 天/)).toBeTruthy()
    expect(screen.getByText(/已覆盖最近 30 天/)).toBeTruthy()
    expect(screen.getByText(/剩余 23 天/)).toBeTruthy()
  })

  it("★★ 明确说「现在就学也可以」", async () => {
    /**
     * 不说这句的话，一个负责的用户会一直等 —— 而回溯要几小时。
     * 这是这一句里唯一**可操作**的部分。
     */
    const now = Date.now()
    wrap(forge(), {
      rangeDays: 180,
      backfill: {
        since: now - 180 * 86_400_000,
        coveredFrom: now - 30 * 86_400_000,
        remainingMs: 23 * 86_400_000,
        stalled: null,
        activeWindow: null,
        messages: 500,
        started: true,
      },
    })

    expect(await screen.findByText(/可立即开始学习/)).toBeTruthy()
  })

  /**
   * ★ 「补完了」的前提是**真的采到了东西**。
   *
   * 这个 fixture 原来是 `coveredFrom: null`（库里一条消息都没有）却断言
   * "已完整入库" —— 也就是说它**锁住的正是那个 bug**。真实故障：采集第一轮
   * 就撞登录过期进 blocked 终态、messages 表空，而引导页报"完成"。
   */
  it("★ 补完了只报一句确认，不再占三行", async () => {
    const now = Date.now()
    wrap(forge(), {
      rangeDays: 90,
      backfill: {
        since: now - 90 * 86_400_000,
        coveredFrom: now - 90 * 86_400_000,
        remainingMs: 0,
        stalled: null,
        activeWindow: null,
        messages: 900,
        started: true,
      },
    })

    expect(await screen.findByText(/选定的 90 天区间已完整入库/)).toBeTruthy()
    // 「还差」不该出现 —— 补完了却说还差多少是自相矛盾
    expect(screen.queryByText(/还差/)).toBeNull()
  })

  /**
   * ★★ 一条消息都没采到时**绝不能**说"已完成"。
   *
   * 实测踩到过（本机 2026-08-05 07:24 那个账号）：采集第一轮就撞
   * `SESSION_EXPIRED` 进 blocked 终态、游标 status=failed、watermark=0、
   * messages 表空，而引导页写着"选定的 90 天区间已完整入库"，
   * 蒸馏跟着报 0 语料 / 覆盖度 D。用户无从判断是没数据还是采集坏了。
   */
  it("★★ 还没采到任何消息时说「还没采到」，不说「已完成」", async () => {
    const now = Date.now()
    wrap(forge(), {
      rangeDays: 90,
      backfill: {
        since: now - 90 * 86_400_000,
        coveredFrom: null,
        remainingMs: 0,
        stalled: null,
        activeWindow: null,
        messages: 0,
        started: false,
      },
    })

    expect(await screen.findByText(/还没有采到任何聊天记录/)).toBeTruthy()
    expect(screen.queryByText(/已完整入库/)).toBeNull()
  })

  it("★ remainingMs 归零也算补完（不显示「还差 0 天」）", async () => {
    const now = Date.now()
    wrap(forge(), {
      rangeDays: 90,
      backfill: {
        since: now - 90 * 86_400_000,
        coveredFrom: now - 7 * 86_400_000,
        remainingMs: 0,
        stalled: null,
        activeWindow: null,
        messages: 700,
        started: true,
      },
    })

    expect(await screen.findByText(/已完整入库/)).toBeTruthy()
    expect(screen.queryByText(/还差 0 天/)).toBeNull()
  })

  it("★ 没选范围时说清学的是「已采集到的全部」", async () => {
    const now = Date.now()
    wrap(forge(), {
      rangeDays: null,
      backfill: {
        since: null,
        coveredFrom: now - 7 * 86_400_000,
        remainingMs: 0,
        stalled: null,
        activeWindow: null,
        messages: 300,
        started: true,
      },
    })

    expect(await screen.findByText(/已入库的全部会话记录/)).toBeTruthy()
  })

  it("★ 快照还没到时不占位（空框比晚 200ms 出现更显眼）", () => {
    /**
     * 这一条防的是"给个骨架屏"那种直觉：这一句只有两行高，
     * 骨架屏闪一下比它晚出现两百毫秒更容易被注意到。
     */
    wrap(forge(), { rangeDays: 180 })
    // 首帧（query 还没 resolve）时那三种文案一个都不该在
    expect(screen.queryByText(/还差/)).toBeNull()
    expect(screen.queryByText(/已全部采集完成/)).toBeNull()
    expect(screen.queryByText(/已采集到的全部语料/)).toBeNull()
  })
})

/**
 * 回填进度的**可观察性** —— 进度条、当前区间、已入库条数。
 *
 * ## 为什么这三样值得单独锁
 *
 * 上面那组断言的是"中间态要说出来"（选了多久 / 已覆盖多久 / 还差多久）。
 * 但那三个数**每几分钟才变一次**，于是「正在推进」与「卡住了」在界面上
 * 完全同形 —— 而这条链路真的活锁过（窗宽固定 7 天而一窗的消息数超过
 * 单轮预算）。
 *
 * 补的这三样是"看得出在动"的那一半：区间每轮往左移、条数每几秒就涨。
 * 少了它们，用户面对一个静止的"还差 38 天"无从判断要不要重启应用。
 */
describe("★★ 回填进度：看得出在动", () => {
  const now = Date.now()
  const backfilling = {
    since: now - 90 * 86_400_000,
    coveredFrom: now - 30 * 86_400_000,
    remainingMs: 60 * 86_400_000,
    stalled: null,
    // 正在拉的那一窗（真实链路里它每轮往更早移动）
    activeWindow: { start: now - 32 * 86_400_000, end: now - 30 * 86_400_000 },
    messages: 12_345,
    // 正在回填 ⇒ 采集当然已经开始（见 `started` 在契约里的注释）
    started: true,
  }

  it("★ 报出当前正在回填的时间区间（静止数字之外的动态信号）", async () => {
    wrap(forge(), { rangeDays: 90, backfill: backfilling })
    expect(await screen.findByText(/当前回填区间/)).toBeTruthy()
  })

  it("★ 报出已入库条数，且带千分位", async () => {
    wrap(forge(), { rangeDays: 90, backfill: backfilling })
    // 12345 → "12,345"（不用 toLocaleString 的区域设置，见 formatDay 注释）
    expect(await screen.findByText(/12,345 条/)).toBeTruthy()
  })

  it("★ 进度条带可读的 aria 值（读屏用户看不到条形）", async () => {
    wrap(forge(), { rangeDays: 90, backfill: backfilling })
    const bar = await screen.findByRole("progressbar")
    // 已覆盖 30 / 选定 90 ≈ 33%
    expect(bar.getAttribute("aria-valuenow")).toBe("33")
  })

  it("★ 没有在跑的窗时不编一个区间出来（只报条数）", async () => {
    wrap(forge(), {
      rangeDays: 90,
      backfill: { ...backfilling, activeWindow: null },
    })
    expect(await screen.findByText(/12,345 条/)).toBeTruthy()
    expect(screen.queryByText(/当前回填区间/)).toBeNull()
  })

  it("★★ 旧主进程的快照缺这两个键时不崩（引导流程不能卡死）", async () => {
    /**
     * 开发态热更只 reload 渲染层，主进程还是旧的 —— 那时快照里没有
     * `messages` / `activeWindow`。而这一屏崩掉等于把用户卡在引导里出不去。
     */
    const legacy = {
      since: now - 90 * 86_400_000,
      coveredFrom: now - 30 * 86_400_000,
      remainingMs: 60 * 86_400_000,
      stalled: null,
    } as unknown as IngestSnapshot["backfill"]
    wrap(forge(), { rangeDays: 90, backfill: legacy })
    // 主文案照常出现，两个新元素静默省略
    expect(await screen.findByText(/选定 90 天/)).toBeTruthy()
    expect(screen.queryByText(/当前回填区间/)).toBeNull()
  })
})
