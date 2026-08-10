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
  classifyGraphReason,
  describeBuildSchedule,
  describeBuildVolume,
  describeKl,
  formatBytes,
  formatCount,
  formatEta,
  formatInterval,
  lagTone,
  readDistill,
  readIdentityBar,
  readIdentityProblem,
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
    // 抽干了、没有转写截断 → `minutesHint` 应当是 null（一切正常时不说话）
    minutesCoverage: { drained: true, earliestStartedAt: null, transcriptTruncated: 0 },
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

  /**
   * ★★ 权限类终态**不能**提示"去授权" —— 这句原来说的是
   * 「钉钉侧需要一次授权确认」，而它把用户指向了一个无效动作。
   *
   * 实测（一次真实刷屏事故）：`ENTERPRISE_NOT_AUTHORIZED` 的含义是
   * **当前这份渠道客户端**对这个企业没开通能力。按提示重新扫码，
   * 扫完问题一动不动 —— 要换的是客户端而不是登录态。
   *
   * ★ 与上面 `session_expired` 那条**相反**：那里 `lastError` 必须输，
   * 这里 `lastError` 必须赢。因为分类器已经按具体错误码给了精确文案
   * （"请到设置里换一份客户端"），比任何通用兜底都有信息量。
   */
  it("★★ 权限终态优先用分类器的精确文案（它知道该换客户端）", () => {
    const cards = readIngest(
      ingestSnapshot({
        blockedReason: "permission_required",
        lastError: "当前渠道客户端对这个企业没有开通该能力，请在设置里换一份客户端",
      }),
    )
    expect(cards?.problem).toContain("客户端")
    // ★ 反面：绝不能是那句会把人带去反复扫码的话
    expect(cards?.problem).not.toContain("需要一次授权确认")
  })

  /**
   * ★ 没有 `lastError` 时的兜底也不能说"授权"。
   *
   * 权限类终态有多种成因（客户端缺能力、跨组织未确认、PAT 缺 scope），
   * 说错方向比说得笼统更糟 —— 用户会按错误的指引反复尝试。
   */
  it("★ 权限终态无 lastError → 兜底文案不提「授权」", () => {
    const cards = readIngest(
      ingestSnapshot({ blockedReason: "permission_required", lastError: null }),
    )
    expect(cards?.problem).not.toBeNull()
    expect(cards?.problem).not.toContain("授权")
    expect(cards?.problem).toContain("权限")
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

  /**
   * ★★ 渠道未连接 → 必须说清"这些是历史数据"。
   *
   * ## 为什么这条是必要的，而不是锦上添花
   *
   * 引导的完成判据是「四步都走过」（`onboarding.isDismissed()`），
   * 与「**现在**授权还有效吗」无关 —— 那是刻意的设计。于是登录态过期后
   * 整个应用照常打开：仪表盘 8 万条消息、数字分身有名有像，
   * 而设置页同时写着「未连接」。两个画面互相矛盾，且**没有任何一处**
   * 说明这些数字是过去采的、现在一条新消息都进不来。
   *
   * 实测就是这个形态（本机 84,367 条 + 「未连接」）。用户据此判断
   * "采集正常"于是不去重新授权，数据从此停在过去 —— 静默降级（§4）。
   */
  it("★★ 渠道未连接 → staleData 且提示说明是历史数据", () => {
    const cards = readIngest(ingestSnapshot(), false)
    expect(cards?.staleData).toBe(true)
    expect(cards?.problem).toBe("钉钉未连接 —— 以下是历史数据，现在不会有新消息进来")
    // 数字仍要给：用户问的是"我有多少数据"（与上一条同理）
    expect(cards?.messages).toBe("10,385")
  })

  /**
   * ★ 「未连接」要排在 `!running` **之前** —— 它是原因，后者只是表现。
   *
   * 两者常常同时成立。先说"采集未运行"会把用户推去查采集器，
   * 而要做的事在设置页。
   */
  it("★ 未连接 + 采集未运行 → 报未连接（原因优先于表现）", () => {
    const cards = readIngest(ingestSnapshot({ running: false }), false)
    expect(cards?.problem).toContain("未连接")
  })

  /**
   * ★ 还在查（null）时**不下结论**。
   *
   * 传 false 会让已连接的账号在首帧闪一下"历史数据"，
   * 而那种一闪而过的错误状态比慢 200ms 更让人怀疑数据出了问题。
   */
  it("★ 连接状态未知（null）时不标 staleData", () => {
    expect(readIngest(ingestSnapshot(), null)?.staleData).toBe(false)
    expect(readIngest(ingestSnapshot(), null)?.problem).toBeNull()
    // 已连接同理
    expect(readIngest(ingestSnapshot(), true)?.staleData).toBe(false)
  })

  it("库体积是主库 + WAL", () => {
    // 40 MiB + 512 KiB ≈ 40.5 MiB
    expect(readIngest(ingestSnapshot())?.storage).toBe("41 MiB")
  })

  /**
   * ★★ 听记覆盖面 —— 「有多少」与「是不是全部」是两个问题。
   *
   * 首版列表只取首页，于是 `minutes` 这个计数会稳定停在 50，
   * 与"这个账号一共 50 场会"在界面上无法区分。这一组锁的是那个出口。
   */
  it("一切正常时不说话（抽干了 + 没有转写截断）", () => {
    expect(readIngest(ingestSnapshot())?.minutesHint).toBeNull()
  })

  it("★ 列表没抽干 → 说「还有更早的会没采到」", () => {
    const cards = readIngest(
      ingestSnapshot({
        minutesCoverage: { drained: false, earliestStartedAt: null, transcriptTruncated: 0 },
      }),
    )
    expect(cards?.minutesHint).toContain("未抽干")
  })

  /**
   * ★ 两种不完整**分开说**：处置不同（等下一轮 vs 要用户动手）。
   * 合成一句"覆盖不全"会让用户不知道该做什么。
   */
  it("★ 转写截断单独说，且能与列表未抽干同时出现", () => {
    const only = readIngest(
      ingestSnapshot({
        minutesCoverage: { drained: true, earliestStartedAt: null, transcriptTruncated: 3 },
      }),
    )
    expect(only?.minutesHint).toContain("3 场会")
    expect(only?.minutesHint).not.toContain("未抽干")

    const both = readIngest(
      ingestSnapshot({
        minutesCoverage: { drained: false, earliestStartedAt: null, transcriptTruncated: 2 },
      }),
    )
    expect(both?.minutesHint).toContain("未抽干")
    expect(both?.minutesHint).toContain("2 场会")
  })

  /**
   * ★ 还没跑过一轮（null）时**不说话**。
   *
   * 那时是"未知"，而编一句"没问题"正是这次要消灭的那类静默。
   */
  it("★ 还没跑过一轮（null）→ 不说话（未知 ≠ 没问题）", () => {
    expect(readIngest(ingestSnapshot({ minutesCoverage: null }))?.minutesHint).toBeNull()
  })

  /**
   * ★ 字段缺失（旧主进程 + 热重载过的渲染层）不能白屏。
   *
   * 这一条挡的是一次真实的失败：只判 `=== null` 时 `undefined` 会走进
   * `coverage.drained` 并抛 `Cannot read properties of undefined` ——
   * 而那会让整个面板渲染不出来（不只是少一行提示）。
   */
  it("★ 快照里没有这个字段时不崩（旧主进程 + 新渲染层）", () => {
    const legacy = ingestSnapshot()
    delete (legacy as { minutesCoverage?: unknown }).minutesCoverage
    expect(() => readIngest(legacy)).not.toThrow()
    expect(readIngest(legacy)?.minutesHint).toBeNull()
    // 别的数字照常给 —— 少一个字段不该影响整块
    expect(readIngest(legacy)?.messages).toBe("10,385")
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
 * ★★ 未确认时那条红字**指向哪个入口**。
 *
 * ## 为什么这个判据值得单独锁
 *
 * 身份未确认有两个成因，正确动作在**不同页面**上：
 *
 * · **继承来的登录态**（最常见）：渠道登录态按系统用户共享，新注册的应用
 *   账号一进来就显示"已连接"，于是用户没有理由去点重新授权 → 落身份行的
 *   `onAuthorized` 从不触发。这时要去**渠道页**采纳，「解析身份」按钮
 *   解决不了它。
 * · **解析失败/歧义**：这时才该去解析并确认。
 *
 * 从前一律说"去设置里确认一下"。那不是"文案不精确"，而是**把人指向一个
 * 按了没用的按钮** —— 而未确认期间蒸馏拒掉全部语料，用户在错误的地方
 * 反复尝试时画像一直是空的。这类错误没有任何报错，只能靠门禁锁住。
 */
describe("★★ readIdentityProblem：红字指向哪个入口", () => {
  it("已确认 / 还在读 → 不说话", () => {
    // ★ `unknown` 是加载态，报警是狼来了（与 readIdentityBar 那条三态是一对）
    expect(readIdentityProblem({ selfState: "unknown", adoptable: null })).toBeNull()
    expect(readIdentityProblem({ selfState: "confirmed", adoptable: null })).toBeNull()
    // 即使有可采纳的登录态，已确认就不该再提
    expect(
      readIdentityProblem({
        selfState: "confirmed",
        adoptable: { corpName: "示例集团", userName: "王强" },
      }),
    ).toBeNull()
  })

  it("★ 有可采纳的登录态 → 指向渠道页，并说清是哪个组织", () => {
    const problem = readIdentityProblem({
      selfState: "unconfirmed",
      adoptable: { corpName: "示例集团", userName: "王强" },
    })
    expect(problem).toEqual({ kind: "adopt", corpName: "示例集团", userName: "王强" })
  })

  it("没有可采纳的登录态 → 指向解析入口", () => {
    expect(readIdentityProblem({ selfState: "unconfirmed", adoptable: null })).toEqual({
      kind: "resolve",
    })
  })

  it("★ 还没查出来（undefined）→ 按「去解析」处理，不是不说话", () => {
    /**
     * `undefined` = 那个查询还在跑 / 没启用。此时**仍要报警** ——
     * 身份未确认这件事已经确定了（`selfState` 说的），不确定的只是
     * "该指向哪里"。沉默会让这条唯一的出口在加载期间消失。
     *
     * 指向解析入口是更保守的选择：那条路对两种成因都至少是可尝试的。
     */
    expect(readIdentityProblem({ selfState: "unconfirmed", adoptable: undefined })).toEqual({
      kind: "resolve",
    })
  })

  /**
   * ★★★ 「真的同名歧义」必须与「只是还没解析」分开 —— 这两者在库里**同形**
   * （都是"没有身份行"），而给用户的引导相反。
   *
   * ## 修复前的真实症状
   *
   * 界面对**所有**未确认都显示「检测到同名的多个账号——确认一下哪个是你」。
   * 而走到那里的成因至少四种，只有一种是同名歧义：刚清过数据、
   * 上次解析失败过、还没绑身份都会走到这里。于是用户去找一个**不存在的
   * 重名同事**，而真正该做的事（去授权 / 采纳 / 重试）一个字都没提。
   *
   * 这与 §4「不要用一句话盖住没验证过的分支」同一条：那句文案在断言一件
   * 系统压根没检测过的事实（它只知道"没确认"，不知道"为什么"）。
   */
  it("★★ identityState=ambiguous → 才说同名歧义", () => {
    expect(
      readIdentityProblem({
        selfState: "unconfirmed",
        adoptable: null,
        identityState: "ambiguous",
      }),
    ).toEqual({ kind: "ambiguous" })
  })

  it("★★ identityState=unresolved → 说「重试解析」，不说同名歧义", () => {
    expect(
      readIdentityProblem({
        selfState: "unconfirmed",
        adoptable: null,
        identityState: "unresolved",
      }),
    ).toEqual({ kind: "resolve" })
  })

  /**
   * ★★ 没绑身份 → **不说话**（不是"换一句话说"）。
   *
   * 这一档的正确动作是"去授权"，而那件事已经有人在说、而且说得更好：
   * 引导页上方那个授权面板本身就写着「为当前账号授权一次，才能确定
   * 「你」是谁」并带按钮；仪表盘那条 `staleData` 说「钉钉未连接 ——
   * 以下是历史数据」。在它们下面再挂一个"还没授权"的框是同一件事说两遍，
   * 而重复的提示会稀释真正需要注意的那两档（同名歧义、解析失败）。
   *
   * ★ 断言 null 而不是某个 kind：可见性由那两处负责，
   * 删掉它们中任何一个之前要先把这句话搬过去。
   */
  it("★★ identityState=unbound → 不说话（授权面板与 staleData 已经在说了）", () => {
    expect(
      readIdentityProblem({
        selfState: "unconfirmed",
        adoptable: null,
        identityState: "unbound",
      }),
    ).toBeNull()
    // 即使有可采纳的登录态也不说：没授权时"采纳"也无从谈起
    expect(
      readIdentityProblem({
        selfState: "unconfirmed",
        adoptable: { corpName: "示例集团", userName: "王强" },
        identityState: "unbound",
      }),
    ).toBeNull()
  })

  /**
   * ★ `unconfirmed`（有身份行、只是没 confirm）仍走原来的两分法。
   *
   * 那一档 adopt 与 resolve 的区分依然有效 —— 新增的三档没有把它盖掉。
   */
  it("identityState=unconfirmed → 仍按有没有可采纳的登录态分叉", () => {
    expect(
      readIdentityProblem({
        selfState: "unconfirmed",
        adoptable: { corpName: "示例集团", userName: "王强" },
        identityState: "unconfirmed",
      }),
    ).toEqual({ kind: "adopt", corpName: "示例集团", userName: "王强" })
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
    minIntervalMs: 3_600_000,
    etaMs: 3_600_000,
    lastBuiltAt: 1_785_000_000_000,
    syncIntervalMs: 600_000,
  }

  /**
   * ★★★ 这一组锁的是一句**自相矛盾**的话。
   *
   * 冷却那一档（`min-interval`）原来没有分支，掉进 `below-threshold` 的
   * 兜底，于是界面真的显示过（实测原文）：
   *
   * ```
   * 自动构建 · 增量 25,477 / 500 条（还差 0 条） · 或 约 23 小时后按时间触发
   * ```
   *
   * · 「还差 0 条」= `max(0, 500 - 25477)` —— 读起来像卡住了；
   * · 「23 小时」= 24h 兜底的倒计时，而真正要等的是冷却剩余
   *   （那一刻实测距上次建成 37 分钟、冷却 1 小时 → 还有约 23 **分钟**）。
   *
   * 差 60 倍，且把用户指向两个都错的结论：「要等一整天」或「条数没攒够」。
   */
  it("★★★ 冷却中 → 说「已达标 · 冷却中」，不许说「还差 N 条」", () => {
    const d = describeBuildSchedule({
      ...base,
      reason: "min-interval",
      pendingMessages: 25_477,
      // 条数早就够了 → 这个值是 0，而它正是那句「还差 0 条」的来源
      messagesToThreshold: 0,
      etaMs: 23 * 60_000,
    })
    expect(d?.text).toContain("已达标")
    // ★ 反面：不能再出现那两句误导
    expect(d?.text).not.toContain("还差")
    expect(d?.text).not.toContain("按时间触发")
  })

  /**
   * ★★ 倒计时必须是**冷却剩余**，不是 24h 兜底。
   *
   * 判据锁在"分钟"上：24h 那个会被 `formatEta` 格式成「约 23 小时」，
   * 而冷却剩余是「约 23 分钟」。这一条如果只断言"有倒计时"就抓不住 60 倍差。
   */
  it("★★ 倒计时是冷却剩余（分钟级），不是 24h 兜底（小时级）", () => {
    const d = describeBuildSchedule({
      ...base,
      reason: "min-interval",
      pendingMessages: 25_477,
      messagesToThreshold: 0,
      etaMs: 23 * 60_000,
    })
    expect(d?.text).toMatch(/23\s*分钟/)
    expect(d?.text).not.toMatch(/小时后/)
  })

  /**
   * ★★ 要说出那个冷却是**可配置**的，且报的是**生效值**。
   *
   * 用户把它改成 6h 之后这句话必须跟着变 —— 界面自己写一个 1h 常量的话
   * 就又是"两处各写一份、必然分叉"（那正是 minIntervalMs 要回显的理由）。
   */
  it("★★ 报生效的冷却值并指向设置（改成 6h 就说 6 小时）", () => {
    const d = describeBuildSchedule({
      ...base,
      reason: "min-interval",
      messagesToThreshold: 0,
      minIntervalMs: 6 * 3_600_000,
      etaMs: 60_000,
    })
    expect(d?.text).toMatch(/6\s*小时/)
    expect(d?.text).toContain("设置")
    /**
     * ★★ 配置值**不带「约」** —— 它不是估算。
     *
     * 实测撞到过「最小间隔 约 1 小时，可在设置里改」：「约」与「可在设置里改」
     * 放在一起自相矛盾（用户自己配的那个数不该是约数）。
     * 而倒计时那半句仍然该带"约"（那确实是估算）。
     */
    expect(d?.text).not.toMatch(/最小间隔 约/)
  })

  it("没接自动构建 → null（不占位）", () => {
    expect(describeBuildSchedule(null)).toBeNull()
  })

  it("★ 首次等够初始跨度 → 说「正在积累前期数据」+ 倒计时，不说成卡住", () => {
    const d = describeBuildSchedule({
      ...base,
      reason: "awaiting-initial-window",
      etaMs: 4 * 24 * 60 * 60 * 1000, // 还差 4 天
    })
    expect(d?.text).toContain("正在积累前期数据")
    expect(d?.text).toContain("第一张图谱")
    // 有倒计时
    expect(d?.text).toMatch(/后/)
    expect(d?.tone).toBe("muted")
    // ★ 反面：不该拼成 below-threshold 那句"还差 N 条"
    expect(d?.text).not.toContain("还差")
  })

  it("★ 首次等跨度但拿不到最早时刻（etaMs=null）→ 不给假倒计时", () => {
    const d = describeBuildSchedule({ ...base, reason: "awaiting-initial-window", etaMs: null })
    expect(d?.text).toContain("正在积累前期数据")
    // 没有"约 N 后"这种会走到 0 也不建的假倒计时
    expect(d?.text).not.toMatch(/约.*后生成/)
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

describe("★★ describeBuildVolume：这一轮建了多少（不是图里有多少）", () => {
  /**
   * ★★ 这一组存在的理由：**绝对值回答不了"刚才那一轮干了什么"**。
   *
   * 界面上「实体 618 / 事实 814」说的是图里有多少。而增量建图下一轮可能
   * 只新增几十个实体、总数几乎不变 —— 于是每轮看起来都像没跑，
   * 而那恰恰让人以为增量没生效。
   *
   * 实测一轮的真实形态（上游 `/status.ingest`）：
   * `36613 发现 / 2589 跳过 / 34024 处理 / 2949 切块`。
   */
  const base = {
    entities: 12,
    facts: 30,
    edges: 400,
    unitsDiscovered: 36_613,
    unitsSkipped: 2589,
    unitsProcessed: 34_024,
    chunksCreated: 2949,
  }

  it("没建过 → null（不占位）", () => {
    expect(describeBuildVolume(null)).toBeNull()
  })

  /** ★★ 三段都要有：新增了什么、处理了多少、增量省了多少。 */
  it("★★ 同时说清新增 / 处理量 / 增量省下的", () => {
    const text = describeBuildVolume(base) ?? ""
    expect(text).toContain("+12")
    expect(text).toContain("34,024")
    expect(text).toContain("2,949")
    expect(text).toContain("2,589")
  })

  /**
   * ★★★ 净增**允许负数并带符号显示**。
   *
   * `fresh` 重建先清空、或上游合并了重复实体，都会让某项减少。
   * 夹到 0 会把"合并生效了"显示成"没变化" —— 而那是两件完全不同的事。
   */
  it("★★★ 净增为负 → 原样显示（不夹到 0）", () => {
    const text = describeBuildVolume({ ...base, entities: -5 }) ?? ""
    expect(text).toContain("-5")
    expect(text).not.toContain("+-5")
  })

  /**
   * ★★ 全 0 → 说「本轮没有新增」，不许拼成「+0 实体 · +0 事实」。
   *
   * 后者读起来像坏了，而它其实是正常状态（语料全命中缓存）。
   */
  it("★★ 三项都是 0 → 说「没有新增」而不是一串 +0", () => {
    const text = describeBuildVolume({ ...base, entities: 0, facts: 0, edges: 0 }) ?? ""
    expect(text).toContain("没有新增")
    expect(text).not.toContain("+0")
  })

  /**
   * ★★ 跳过数要说清它**是好事**（已抽过 = 省了 LLM 调用）。
   *
   * 光报一个「跳过 2,589」会被读成"漏了 2589 条"—— 那是数据缺失的语气，
   * 而这里恰恰相反。
   */
  it("★★ 跳过那句要说明原因（不能只报数字）", () => {
    const text = describeBuildVolume(base) ?? ""
    expect(text).toMatch(/跳过[^·]*已抽过|已抽过/)
  })

  /** ★ 没有跳过（首次全量）→ 不提那一段，别占一句废话。 */
  it("★ unitsSkipped 为 0 → 不出现「跳过」", () => {
    const text = describeBuildVolume({ ...base, unitsSkipped: 0 }) ?? ""
    expect(text).not.toContain("跳过")
  })

  /** ★ 上游没给处理量（老版本 / 拿不到）→ 只说新增，不编数字。 */
  it("★ unitsProcessed 为 0 → 不出现「处理」那一段", () => {
    const text = describeBuildVolume({ ...base, unitsProcessed: 0, chunksCreated: 0 }) ?? ""
    expect(text).not.toContain("处理")
    expect(text).toContain("+12")
  })
})

describe("★★★ classifyGraphReason：只有「要动手」的才常驻在版面上", () => {
  /**
   * ★★★ 这一组锁的是**版面上有几行常驻文字**。
   *
   * 我这一轮往「它认识的人与事」顶部堆了四行，把图挤下去大半屏。而
   * `graph.reason` 的四种来源里有三种是**进度或入口的复述**——
   * 它们与旁边那颗按钮说的是同一件事（按钮上写着「同步中…」/「首次同步」），
   * 常驻等于把同一句话说两遍。
   *
   * ## ★★ 判据必须用结构化事实，不能匹配文案
   *
   * 最直接的写法是 `reason.includes("正在建图")` —— 那会在**改文案的那天**
   * 静默失效，而失效的表现是"黄条又常驻了"，没有任何报错，
   * 也没人会想到来改这个判据。所以判据是 `building` / `available`
   * （主进程给的事实，与措辞无关）。
   */
  it("★ 没有 reason → none（不占位）", () => {
    expect(classifyGraphReason({ reason: null, building: false, available: true })).toBe("none")
    expect(classifyGraphReason({ reason: "   ", building: false, available: true })).toBe("none")
  })

  /**
   * ★★★ 正在建图 → progress（收进 popover）。
   *
   * 两种文案都要判成 progress —— 缺库那个窗口与有库时上游给的话不同，
   * 而它们是同一件事。★ 判据是 `building`，所以**换文案也不会失效**。
   */
  it("★★★ 正在建图 → progress（两种文案都是）", () => {
    for (const reason of [
      "正在建图 —— 这一轮完成后就会有内容，不用重新点",
      "正在建图 —— 数字会随进度增长",
    ]) {
      expect(classifyGraphReason({ reason, building: true, available: false })).toBe("progress")
    }
  })

  /**
   * ★★★ **换掉措辞也不许失效** —— 这一条锁的是"判据不看文案"。
   *
   * 反证时验过：把判据写成 `reason.includes("正在建图")` 之后，
   * 上面那两条仍然全绿（它们的文案里就有那四个字）。而真正的风险是
   * **上游改了措辞**：那时 `includes` 落空 → 建图中的进度说明被判成
   * "要动手" → 黄条又常驻，且没有任何报错。
   *
   * ★ 所以这一条刻意给一个**完全不含关键词**的 reason，
   * 并把 `available` 设成 true（否则会落到"还没建过"那一档，
   * 依然掩盖 building 判据的缺失 —— 我第一版就是这么写的，反证不红）。
   */
  it("★★★ building 为真时换任何措辞都是 progress（判据不看文案）", () => {
    expect(
      classifyGraphReason({ reason: "上游换了一句完全不同的话", building: true, available: true }),
    ).toBe("progress")
  })

  /**
   * ★★★ 还没建过 → progress。
   *
   * 那是**入口**而不是问题：旁边那颗「首次同步」就是下一步，
   * 再说一遍没有信息量。判据是 `available===false && building===false`。
   */
  it("★★★ 还没建过图 → progress（那颗按钮就是入口）", () => {
    expect(
      classifyGraphReason({
        reason: "还没建过图（点「重新建图」开始，它会出网）",
        building: false,
        available: false,
      }),
    ).toBe("progress")
  })

  /**
   * ★★★ 半成品 → actionable，**必须常驻**。
   *
   * `facts=0` 意味着 Phase B 的 LLM 抽取没成功 —— 要用户重试或换网关。
   * 收进 popover 等于把一个待办藏起来。
   *
   * ★ 与"还没建过"可分的关键：这一档 `available===true`
   * （有实体，只是没抽出事实）。
   */
  it("★★★ 有内容却仍有话说（facts=0 / 读失败）→ actionable", () => {
    expect(
      classifyGraphReason({
        reason: "实体已建好，但事实一条都没抽出来 —— Phase B 的 LLM 抽取没成功",
        building: false,
        available: true,
      }),
    ).toBe("actionable")
    expect(
      classifyGraphReason({ reason: "读图谱失败：xxx", building: false, available: true }),
    ).toBe("actionable")
  })

  /**
   * ★★ 建图中**优先于**其它判据。
   *
   * 建图跑到一半时 `available` 可能已经是 true（部分实体已落），
   * 那时若先判 available 就会把进度说成"要动手"——而用户什么都不用做。
   */
  it("★★ 建图中 + 已有内容 → 仍然是 progress（building 优先）", () => {
    expect(
      classifyGraphReason({
        reason: "正在建图 —— 数字会随进度增长",
        building: true,
        available: true,
      }),
    ).toBe("progress")
  })
})
