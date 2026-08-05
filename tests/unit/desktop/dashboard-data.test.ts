/**
 * 仪表盘取数的门禁。
 *
 * ## ★ 这一组锁的是"判据"，不是"渲染"
 *
 * 仪表盘上每个数字背后都有一个判断（多少算落后？空系统与坏系统怎么分？），
 * 而这些判断**恰恰是仪表盘的全部价值** —— 数字本身各处都有，
 * 值钱的是"这个数字现在是好还是坏"。
 *
 * 判据写错的表现是：仪表盘一直显示"正常"而系统其实坏了（或者反过来，
 * 天天亮红灯于是人学会了忽略它 —— 那时真出问题也一起被忽略）。
 * 两种都是**静默**的，只有门禁能锁住。
 */
import { describe, expect, it } from "vitest"
import type {
  DistillProgressView,
  FeedInfo,
  IngestSnapshot,
  KlServerStatus,
  PersonaSnapshotView,
} from "@mycontext/ipc-contract"
import {
  LAG_BAD_THRESHOLD,
  LAG_WARN_THRESHOLD,
  describeBuildSchedule,
  describeKl,
  formatBytes,
  formatCount,
  formatEta,
  formatInterval,
  lagTone,
  readDistill,
  readIdentityBar,
  readIngest,
  readPersona,
  worstConsumer,
} from "@renderer/features/dashboard/dashboard-data.js"

describe("格式化", () => {
  /**
   * ★ 手写千分位而不是 `toLocaleString()`。
   *
   * 后者的分隔符跟随系统区域（有些区域用空格或点），于是同一个数字在
   * 不同机器上长得不一样 —— 截图对不上，门禁也没法断言。
   * 这条用例就是那个决定的锚。
   */
  it("千分位固定用逗号（不跟随系统区域）", () => {
    expect(formatCount(0)).toBe("0")
    expect(formatCount(999)).toBe("999")
    expect(formatCount(1000)).toBe("1,000")
    expect(formatCount(10385)).toBe("10,385")
    expect(formatCount(1234567)).toBe("1,234,567")
    expect(formatCount(-1500)).toBe("-1,500")
  })

  it("非有限数给破折号，而不是 NaN", () => {
    expect(formatCount(Number.NaN)).toBe("—")
    expect(formatBytes(Number.NaN)).toBe("—")
    expect(formatInterval(0)).toBe("—")
  })

  /**
   * 1024 进制 + KiB：这些数来自 SQLite 的页数，本来就是 1024 进制的。
   * 标成 MB 等于把一个精确值说成近似值。
   */
  it("字节用 1024 进制并标 KiB/MiB", () => {
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(2048)).toBe("2.0 KiB")
    expect(formatBytes(1024 * 1024 * 5)).toBe("5.0 MiB")
    // >= 10 时不再给小数（"37 MiB" 比 "37.4 MiB" 好读，且宽度稳定）
    expect(formatBytes(1024 * 1024 * 37.4)).toBe("37 MiB")
  })

  it("间隔按秒/分钟给（15s 探针要显示成「15 秒」）", () => {
    expect(formatInterval(15_000)).toBe("15 秒")
    expect(formatInterval(120_000)).toBe("2 分钟")
  })
})

describe("★ Outbox 落后量的语气（阈值刻意给得宽）", () => {
  /**
   * 阈值宽是刻意的：一轮采集能进上百条，落后几十几百只说明消费者还没跑到。
   * 给窄了会天天亮黄灯，而**一个天天报警的仪表盘等于没有仪表盘** ——
   * 人会学会忽略它，然后真出问题时也一起忽略。
   */
  it("0 = 追平（good），正常在途量不报警", () => {
    expect(lagTone(0)).toBe("good")
    expect(lagTone(1)).toBe("neutral")
    expect(lagTone(LAG_WARN_THRESHOLD - 1)).toBe("neutral")
  })

  it("跨过阈值才升级语气", () => {
    expect(lagTone(LAG_WARN_THRESHOLD)).toBe("warn")
    expect(lagTone(LAG_BAD_THRESHOLD - 1)).toBe("warn")
    expect(lagTone(LAG_BAD_THRESHOLD)).toBe("bad")
    expect(lagTone(99_999)).toBe("bad")
  })
})

function ingestSnapshot(over: Partial<IngestSnapshot> = {}): IngestSnapshot {
  return {
    running: true,
    channelId: "dingtalk",
    messages: 10385,
    conversations: 88,
    unjudged: 0,
    outboxHead: 10500,
    ftsIndexed: 10385,
    ftsLag: 0,
    probeIntervalMs: 15_000,
    probeThrottled: false,
    lastError: null,
    blockedReason: null,
    failedAttempts: 0,
    selfConfirmed: true,
    mediaAssets: 1085,
    minutes: 37,
    storage: {
      mainBytes: 1024 * 1024 * 40,
      walBytes: 1024 * 512,
      rawRecords: 10500,
      rawPruned: 0,
      vectors: 9000,
    },
    staleConsumers: [],
    ...over,
  } as IngestSnapshot
}

describe("采集这一组", () => {
  it("正常时没有 problem", () => {
    expect(readIngest(ingestSnapshot())?.problem).toBeNull()
  })

  /**
   * ★ `blockedReason` 优先于 `lastError`。
   *
   * 被拦住时通常**也**有一个 lastError（那次失败的原文），而它多半是
   * 一句无从下手的 CLI 报错。用户能行动的是"去重新授权"，
   * 所以那句必须赢。顺序写反的表现是：真正可行动的提示被一句
   * 技术报错盖住，而两者同时存在。
   */
  it("被拦住时给可行动的那句，而不是底层报错", () => {
    const cards = readIngest(
      ingestSnapshot({ blockedReason: "session_expired", lastError: "exit 1: token invalid" }),
    )
    expect(cards?.problem).toContain("重新授权")
    expect(cards?.problem).not.toContain("exit 1")
  })

  it("退避中要在探针提示里说出来（否则「15 秒」是假的）", () => {
    const cards = readIngest(ingestSnapshot({ probeThrottled: true, probeIntervalMs: 120_000 }))
    expect(cards?.probeHint).toContain("2 分钟")
    expect(cards?.probeHint).toContain("退避")
  })

  /**
   * 采集停了仍然照常给数字。
   *
   * 用户问的是"我有多少数据"，那与"现在有没有在采"是两个问题。
   * 停了就把数字藏起来的话，他会以为数据也没了。
   */
  it("采集未运行时数字照常给，只是多一句提示", () => {
    const cards = readIngest(ingestSnapshot({ running: false }))
    expect(cards?.messages).toBe("10,385")
    expect(cards?.problem).toBe("采集未运行")
  })

  it("库体积是主库 + WAL", () => {
    // 40 MiB + 512 KiB ≈ 40.5 MiB
    expect(readIngest(ingestSnapshot())?.storage).toBe("41 MiB")
  })
})

function distillProgress(over: Partial<DistillProgressView> = {}): DistillProgressView {
  return {
    total: 0,
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
    skipped: 0,
    costTokens: 0,
    lastError: null,
    facetCount: 0,
    ...over,
  } as DistillProgressView
}

describe("★ 蒸馏：「还没开始」与「跑完了 0 条」必须分开", () => {
  /**
   * 这是整个仪表盘上最重要的一条判据。
   *
   * 历史上真实发生过：本人身份未确认 → 蒸馏守卫拒掉全部 9768 条语料 →
   * 任务全部"完成"、结论 0 条，而进度页显示"完成"。
   * 那个失效的可怕之处是**外观正常**。
   *
   * 若 `total === 0`（还没选范围）与 `facetCount === 0`（跑完但没产出）
   * 都显示成 0%，那个真问题会被当成"我还没开始"而永远查不出来。
   */
  it("total=0 → idle（引导去选范围），不是失败", () => {
    const cards = readDistill(distillProgress())
    expect(cards?.state).toBe("idle")
    expect(cards?.stateText).toContain("还没选")
  })

  it("跑完但 facetCount=0 → empty，且明说多半是身份未确认", () => {
    const cards = readDistill(distillProgress({ total: 20, done: 20, facetCount: 0 }))
    expect(cards?.state).toBe("empty")
    expect(cards?.stateText).toContain("身份未确认")
  })

  it("跑完且有结论 → done", () => {
    const cards = readDistill(distillProgress({ total: 20, done: 20, facetCount: 92 }))
    expect(cards?.state).toBe("done")
    expect(cards?.facets).toBe("92")
  })

  it("在跑 → running，且比例算的是 done+skipped", () => {
    const cards = readDistill(
      distillProgress({ total: 10, done: 3, skipped: 2, pending: 5, facetCount: 4 }),
    )
    expect(cards?.state).toBe("running")
    expect(cards?.ratio).toBeCloseTo(0.5)
    expect(cards?.done).toBe("5 / 10")
  })

  /** 全失败要与"跑完了"分开：前者需要人看一眼日志。 */
  it("done=0 且有失败 → failing", () => {
    const cards = readDistill(distillProgress({ total: 6, failed: 6 }))
    expect(cards?.state).toBe("failing")
    expect(cards?.stateText).toContain("6")
  })
})

function personaSnapshot(over: Partial<PersonaSnapshotView> = {}): PersonaSnapshotView {
  return {
    running: true,
    agentAvailable: true,
    killSwitch: false,
    autoReplyCount: 2,
    pendingInbox: 0,
    pendingDrafts: 3,
    residents: ["c1"],
    maxResident: 3,
    ...over,
  } as PersonaSnapshotView
}

describe("分身这一组", () => {
  it("正常时没有降级提示", () => {
    expect(readPersona(personaSnapshot())?.degraded).toBeNull()
  })

  /**
   * ★ 急停优先于其它降级。
   *
   * 三个降级可能同时成立（急停开着 + agent 不可用 + 调度没跑），
   * 而急停是**用户自己按的** —— 它必须赢，否则他按了急停、
   * 界面上却说"运行时不可用"，会以为急停没生效。
   */
  it("急停优先显示（用户按了就得让他看见）", () => {
    const cards = readPersona(
      personaSnapshot({ killSwitch: true, agentAvailable: false, running: false }),
    )
    expect(cards?.degraded).toContain("急停")
    expect(cards?.killSwitch).toBe(true)
  })

  it("常驻 agent 显示 当前/上限", () => {
    expect(readPersona(personaSnapshot({ residents: ["a", "b"], maxResident: 3 }))?.residents).toBe(
      "2 / 3",
    )
  })
})

describe("★ 最慢的消费者取最大值，不取平均", () => {
  /**
   * 平均会把"一个消费者彻底卡死"稀释成一个温和的数字：
   * 5 个消费者里 1 个落后 10000、其余 0 → 平均 2000，看起来只是有点忙。
   * 而卡死的那一个正是我们要看见的。
   */
  it("一个卡死、其余追平 → 报那个卡死的", () => {
    const info = {
      running: true,
      baseUrl: "http://127.0.0.1:1",
      tokenReady: true,
      head: 10500,
      consumers: [
        { consumerId: "local-index-fts", ackedSeq: 10500, lag: 0, needsFullRebuild: false },
        { consumerId: "distill", ackedSeq: 500, lag: 10000, needsFullRebuild: false },
        { consumerId: "persona-inbox", ackedSeq: 10500, lag: 0, needsFullRebuild: false },
      ],
    } as FeedInfo
    const worst = worstConsumer(info)
    expect(worst?.consumerId).toBe("distill")
    expect(worst?.lag).toBe(10000)
    // 且语气必须是 bad —— 若这里取了平均（3333）会是 warn
    expect(lagTone(worst?.lag ?? 0)).toBe("bad")
  })

  it("没有消费者 → null（而不是假装 0）", () => {
    expect(worstConsumer(null)).toBeNull()
    expect(
      worstConsumer({
        running: false,
        baseUrl: "",
        tokenReady: false,
        head: 0,
        consumers: [],
      } as FeedInfo),
    ).toBeNull()
  })
})

function klStatus(over: Partial<KlServerStatus> = {}): KlServerStatus {
  return {
    state: "stopped",
    reason: null,
    port: null,
    building: false,
    networkEgress: false,
    buildProgress: null,
    ...over,
  } as KlServerStatus
}

describe("图谱状态压成一句人话", () => {
  it("ready → 就绪（good）", () => {
    const view = describeKl(klStatus({ state: "ready", port: 8200 }))
    expect(view.text).toBe("就绪")
    expect(view.tone).toBe("good")
  })

  /**
   * ★ failed 时必须**带上原因**。
   *
   * 这条路径上真实见过的原因是 `kl-server 进程退出（code=3）`（端口被
   * 孤儿占着）与 embedding 维度不匹配 —— 两者都只能从原文认出来。
   * 换成我们自己编的"启动失败"就等于把唯一的线索丢了。
   */
  it("failed → 显示 server 给的原因，不是笼统的「失败」", () => {
    const view = describeKl(klStatus({ state: "failed", reason: "kl-server 进程退出（code=3）" }))
    expect(view.text).toContain("code=3")
    expect(view.tone).toBe("bad")
  })

  it("建图中 → 把 kl 的阶段名翻成人话 + 给出比例", () => {
    const a = describeKl(
      klStatus({
        state: "ready",
        building: true,
        buildProgress: { phase: "phase_a", percent: 0.3 },
      }),
    )
    expect(a.text).toContain("切块与向量化")
    expect(a.progressRatio).toBeCloseTo(0.3)

    const b = describeKl(
      klStatus({
        state: "ready",
        building: true,
        buildProgress: { phase: "phase_b", percent: 0.7 },
      }),
    )
    expect(b.text).toContain("抽取与建图")
  })

  /**
   * kl 加了新阶段时不能显示成空白 —— 显示原字串（英文）也比空白好：
   * 至少用户能把它贴给我们。
   */
  it("未知阶段名照原样显示（不显示空白）", () => {
    const view = describeKl(
      klStatus({
        state: "ready",
        building: true,
        buildProgress: { phase: "phase_c", percent: 0.5 },
      }),
    )
    expect(view.text).toContain("phase_c")
  })

  it("没集成 kl → 未集成（muted，不是错误）", () => {
    const view = describeKl(null)
    expect(view.text).toBe("未集成")
    expect(view.tone).toBe("muted")
  })
})

/**
 * ★★ `readIdentityBar` 的四个判定。
 *
 * ## 为什么这一组值得存在
 *
 * 这一条是用户在真机上提的第一条反馈（「应该说有的选渠道，然后显示我的
 * 名称，还有渠道的头像，还有数字分身的名称和形象照片」）—— 原来整页
 * 都看不到"这是谁的数据、谁在替我回消息"。
 *
 * ## ★ 一个纯函数，两个消费者
 *
 * 判定结果现在被**两个**组件读：
 * · `identity-bar.tsx` 取 `personaNamed` / `selfState`（"我 → 我的分身"）；
 * · `scope-chip.tsx` 取 `connectedChannelIds` / `showChannelPicker`
 *   （页头那枚渠道范围筹码 —— 第二轮反馈把渠道从身份卡移了上去，
 *   因为它是**整页的取值范围**，不是"我"的一个属性）。
 *
 * 判定留在同一个函数里是刻意的：拆成两份之后"算不算已连接"会在两处
 * 慢慢判得不一样，而那种不一致的形态是"页头说有两个渠道、卡里只认一个"。
 *
 * 而这四个判定写错的形态**全是静默的**：
 * · 把 `expired` 的渠道算成已连接 → 用户切过去看到空数据，
 *   而他会以为是我们丢了数据（真相是那个渠道的登录过期了）；
 * · 给一个只有一项的下拉 → 假的可配置性（点开只有自己）；
 * · 分身没名字却不给入口 → 草稿署名回落到兜底文案「数字分身」，
 *   而那个回落在这一页上看不出来；
 * · 身份"待确认"被当成灰字而不是警告 → 蒸馏会拒掉**全部**语料且不报错。
 */
describe("★★ readIdentityBar：渠道 / 分身 / 身份三态", () => {
  const authorized = (id: string) => ({ id, status: { state: "authorized" } })

  it("只有一个已连接渠道 → **不**给切换器（一项的下拉是假的可配置性）", () => {
    const view = readIdentityBar({
      channels: [authorized("dingtalk")],
      personaName: "小小周",
      selfConfirmed: true,
    })
    expect(view.connectedChannelIds).toEqual(["dingtalk"])
    expect(view.showChannelPicker).toBe(false)
  })

  it("★ 两个已连接渠道 → 才给切换器（这是上一条的反面）", () => {
    /**
     * 少了这一条，"永远不给切换器"那个实现也能过上面那条 ——
     * 而那时第二个渠道接上之后用户没有任何办法切过去。
     */
    const view = readIdentityBar({
      channels: [authorized("dingtalk"), authorized("feishu")],
      personaName: "小小周",
      selfConfirmed: true,
    })
    expect(view.connectedChannelIds).toEqual(["dingtalk", "feishu"])
    expect(view.showChannelPicker).toBe(true)
  })

  it("★ `expired` / `unauthorized` 不算已连接", () => {
    /**
     * `expired` 那个状态下采集已经停了。把它列成一个可选项等于让用户
     * 以为切过去还有数据 —— 而他看到空数据时会以为是我们丢了数据。
     */
    const view = readIdentityBar({
      channels: [
        authorized("dingtalk"),
        { id: "feishu", status: { state: "expired" } },
        { id: "wecom", status: { state: "unauthorized" } },
      ],
      personaName: "小小周",
      selfConfirmed: true,
    })
    expect(view.connectedChannelIds).toEqual(["dingtalk"])
    // 一个 authorized + 两个不算 → 仍然不给切换器
    expect(view.showChannelPicker).toBe(false)
  })

  it("一个渠道都没连 → 空数组，也不给切换器", () => {
    const view = readIdentityBar({
      channels: [{ id: "dingtalk", status: { state: "unauthorized" } }],
      personaName: "",
      selfConfirmed: null,
    })
    expect(view.connectedChannelIds).toEqual([])
    expect(view.showChannelPicker).toBe(false)
  })

  it("★ 分身没名字 → `personaNamed: false`（那时要给「去起个名字」）", () => {
    expect(
      readIdentityBar({ channels: [], personaName: "", selfConfirmed: true }).personaNamed,
    ).toBe(false)
  })

  it("★ 反面：一串空格也算没名字", () => {
    /**
     * 判据用 `trim()` 而不是 `=== ""` —— 与设置页那个「名字为空不许保存」
     * 的守卫同源（那边也是 trim）。两处判据不同会出现"引导里过不去、
     * 这里显示有名字"这种更难查的不一致。
     */
    expect(
      readIdentityBar({ channels: [], personaName: "   ", selfConfirmed: true }).personaNamed,
    ).toBe(false)
  })

  it("分身有名字 → true", () => {
    expect(
      readIdentityBar({ channels: [], personaName: "小小周", selfConfirmed: true }).personaNamed,
    ).toBe(true)
  })

  it("★ 身份三态各自可分（未读到 ≠ 待确认）", () => {
    /**
     * `null`（还没读到）与 `false`（读到了、但没确认）**必须分开**：
     * 后者要显示成警告色 —— 那个状态下蒸馏会拒掉全部语料且不报错，
     * 而前者只是一瞬间的加载态，报警是狼来了。
     */
    const base = { channels: [], personaName: "x" }
    expect(readIdentityBar({ ...base, selfConfirmed: null }).selfState).toBe("unknown")
    expect(readIdentityBar({ ...base, selfConfirmed: true }).selfState).toBe("confirmed")
    expect(readIdentityBar({ ...base, selfConfirmed: false }).selfState).toBe("unconfirmed")
  })
})

/**
 * 自动构建的调度文案。
 *
 * ## 为什么每个 reason 都要单独锁一条
 *
 * `AutoBuildSkipReason` 的注释里记着一次真实教训：`build-in-progress`
 * 曾叫 `not-ready`，于是日志读起来像"kl 起不来"（要去查 Python/端口），
 * 而实际是上一轮正忙着出结果。文案把人引向错误方向比不给文案更糟，
 * 所以"这几种情况说的不是同一句话"必须被锁住。
 *
 * 另一条：`etaMs === null` 与 `=== 0` 语义不同（等下去不会开始 vs 即将开始），
 * 而"显示一个走到 0 却什么都不发生的倒计时"是最容易被报成 bug 的形态。
 */
describe("★ describeBuildSchedule：每种状态说不同的话", () => {
  const base = {
    enabled: true,
    reason: "below-threshold",
    willBuild: false,
    pendingMessages: 120,
    messagesToThreshold: 380,
    lagThreshold: 500,
    maxAgeMs: 86_400_000,
    etaMs: 3_600_000,
    lastBuiltAt: 1_785_000_000_000,
    syncIntervalMs: 600_000,
  }

  it("没接自动构建 → null（不占位）", () => {
    expect(describeBuildSchedule(null)).toBeNull()
  })

  it("关闭 → 明确说「已关闭」并提示需手动", () => {
    const d = describeBuildSchedule({ ...base, enabled: false, reason: "disabled" })
    expect(d?.text).toContain("已关闭")
    expect(d?.tone).toBe("muted")
  })

  it("★ 正在建 → 说「上一轮仍在进行」，不能说成「未就绪」", () => {
    const d = describeBuildSchedule({ ...base, reason: "build-in-progress" })
    expect(d?.text).toContain("仍在进行")
    // 这两个词会把人引去查环境 —— 那正是改名要避免的
    expect(d?.text).not.toContain("未就绪")
    expect(d?.text).not.toContain("失败")
  })

  it("已达条件 → 说下一轮开始", () => {
    const d = describeBuildSchedule({ ...base, willBuild: true, reason: "lag-threshold" })
    expect(d?.text).toContain("已达触发条件")
  })

  it("退避中 → 带重试倒计时且语气是 warn", () => {
    const d = describeBuildSchedule({ ...base, reason: "backoff", etaMs: 1_800_000 })
    expect(d?.tone).toBe("warn")
    expect(d?.text).toContain("退避")
    expect(d?.text).toContain("30 分钟")
  })

  it("★ 无增量 → 不给倒计时（时间到了也不会建）", () => {
    const d = describeBuildSchedule({ ...base, reason: "no-new-data", etaMs: null })
    expect(d?.text).toContain("无增量")
    // 不能出现"后"这种倒计时措辞 —— 那个倒计时走到 0 也不会发生任何事
    expect(d?.text).not.toMatch(/后(重试|按时间)/)
  })

  it("攒得不够 → 同时报条数进度与时间兜底", () => {
    const d = describeBuildSchedule(base)
    expect(d?.text).toContain("120")
    expect(d?.text).toContain("500")
    expect(d?.text).toContain("还差 380")
    expect(d?.text).toContain("按时间触发")
  })
})

describe("formatEta", () => {
  it("一律带「约」—— 触发要等下一轮同步，精确倒计时是做不到的承诺", () => {
    expect(formatEta(3_600_000)).toBe("约 1 小时")
    expect(formatEta(1_500_000)).toBe("约 25 分钟")
    expect(formatEta(172_800_000)).toBe("约 2 天")
  })

  it("不到一分钟不说「约 0 分钟」", () => {
    expect(formatEta(30_000)).toBe("不到 1 分钟")
  })

  it("非法值给 —，不给 NaN", () => {
    expect(formatEta(Number.NaN)).toBe("—")
    expect(formatEta(-1)).toBe("—")
  })
})
