/**
 * 自动建图的**触发策略** —— 一个纯函数，因为它全是判断、没有 IO。
 *
 * ## 为什么需要策略，而不是"导出完就建"
 *
 * `kl ingest` 是这个项目里最贵的一次操作。实测（pipeline 自报，
 * 见 `docs/M2-klgraph集成设计.md` 那张表）：
 *
 * | 阶段 | 耗时 |
 * |---|---|
 * | Phase A 切块 + 向量化（无 LLM） | **50.2 min** |
 * | Phase B LLM 抽取 | 9.7 min |
 * | fact 向量化 | **33.5 min** |
 * | 建图 | ~30 min |
 *
 * 合计约 2 小时，其中 83 min 是 embedding。
 *
 * ★ 而 kl 的 smart-resume **只在每个 chunk 都已持久化且已向量化时**才跳过
 * Phase A（`_phase_a_complete`：`persisted >= expected and embedded >= expected`）。
 * 新消息必然产生新 chunk → `expected` 变大 → 条件不成立 → Phase A 整个重跑，
 * 而 `_embed_chunks` 是**无条件全量** embed（它对已有向量不做差集）。
 *
 * 也就是说：**每来一条新消息就建一次图 = 每来一条就烧 50 分钟向量化**。
 * 导出侧是 10 分钟一轮，无条件挂上去等于常态跑满 embedding 配额。
 *
 * 所以自动建图必须**攒批**。这个文件就是"攒到什么程度才值得建"。
 *
 * ## 三个条件，任一满足即触发
 *
 * · **首次**（图还没建过）—— 引导跑完必须有图，那是"后续能用"的前提；
 * · **攒够条数**（默认 500 条）—— 一次建图摊到 500 条上才划算；
 * · **攒够时间**（默认 24h 且有新数据）—— 低频使用的人也不该看到一张
 *   一周前的图。★ 必须**同时**有新数据：没有新数据时建图是纯浪费
 *   （Phase A 会跳过，但 Phase B 仍会重跑抽取与建图）。
 *
 * ## ★ 为什么不做"距上次 N 分钟"这种纯节流
 *
 * 那只限制了频率，没有限制**总量**：一个持续聊天的账号每 N 分钟都会
 * 满足条件，于是 embedding 一直在跑。按条数攒批才真的把成本与收益绑在
 * 一起 —— 攒得越多，单条的边际成本越低。
 *
 * ## ★ 失败要退避，否则会变成每 10 分钟刷一次日志
 *
 * 有一类失败是**立即返回**的：没装 Python、没配 key、导出目录空。
 * 那时 `trigger()` 几毫秒就回 false，于是下一轮（10 分钟后）判据依然
 * 成立、再试一次 —— 一天 144 次，全是同一句 warn。
 *
 * 而这正是我在别处写过的那类失效（"静默重试会刷屏，而用户以为在建"）。
 * 所以连续失败要指数退避：1 轮 → 30 min，2 轮 → 1h，3 轮起 → 2h 封顶。
 *
 * ★ 退避状态刻意只在**内存**里（进程重启就清零）：失败的原因多半是
 * 配置（没填 key），而用户填完 key 通常会重启应用 —— 那时应该立刻重试
 * 一次，而不是继续等 2 小时。
 */

/** 攒够多少条新消息才值得建一次图。见文件头的成本表。 */
export const AUTO_BUILD_LAG_THRESHOLD = 500

/** 攒够多久（有新数据的前提下）也建一次 —— 低频用户不该看一张旧图。 */
export const AUTO_BUILD_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * 连续失败 n 次之后至少等多久再试。
 *
 * 索引 = 已经连续失败的次数（1 起）。超出长度取最后一档（2h 封顶）——
 * 不做无限退避：配置修好之后最多等 2 小时就会自己恢复，
 * 而"永远不再试"要用户自己发现并手动点，那比等 2 小时糟。
 */
export const AUTO_BUILD_BACKOFF_MS = [30 * 60_000, 60 * 60_000, 2 * 60 * 60_000] as const

/** 第 n 次连续失败后的退避时长（n 从 1 起）。 */
export function autoBuildBackoffMs(failures: number): number {
  if (failures <= 0) return 0
  const index = Math.min(failures, AUTO_BUILD_BACKOFF_MS.length) - 1
  return AUTO_BUILD_BACKOFF_MS[index] ?? 0
}

export interface AutoBuildInput {
  /** 本轮导出确认到的 seq（也就是"数据已经准备到哪"） */
  ackedSeq: number
  /** 上一次**成功建图**时确认到的 seq。0 = 从没建过 */
  lastBuiltSeq: number
  /** 上一次成功建图的时刻（ms）。null = 从没建过 */
  lastBuiltAt: number | null
  /** 现在几点（注入，让测试可复现） */
  now: number
  /** 图库里有没有东西。false = 还没建过图（或被清过） */
  graphExists: boolean
  /** 用户是否开着自动建图 */
  enabled: boolean
  /**
   * 现在能不能开一轮新的建图。
   *
   * ★ 实际判据只有一个：`!klServer.status().building`（上一轮没在跑）。
   * 装配处见 `startup.ts` 的 `autoBuild.ready`。所以它为 false 时的原因码是
   * `build-in-progress` 而不是笼统的"没就绪" —— 见那个枚举值的注释。
   */
  ready: boolean
  /**
   * 已经**连续**失败几次（成功一次就归零）。0 = 上一次是成功的或还没试过。
   * 见文件头"失败要退避"。
   */
  consecutiveFailures?: number
  /** 上一次失败的时刻（ms）。`consecutiveFailures > 0` 时必须给 */
  lastFailureAt?: number | null
  lagThreshold?: number
  maxAgeMs?: number
}

export type AutoBuildDecision =
  | { build: false; reason: AutoBuildSkipReason }
  | { build: true; reason: AutoBuildTriggerReason; newMessages: number }

/**
 * 不建的原因。**每一个都要能区分**，因为它们的下一步完全不同：
 * 用户关了开关 vs kl 没就绪 vs 攒得还不够 —— 界面上要说不同的话。
 */
export type AutoBuildSkipReason =
  | "disabled"
  /**
   * 上一轮建图**还在跑** —— 不是"环境没准备好"。
   *
   * ★ 名字从 `not-ready` 改过来：那个词在日志里读起来像"kl 起不来"，
   * 而真实含义是"它正忙着建上一轮"（判据是 `!klServer.status().building`）。
   * 实测一轮建图 16 分钟，而导出是 10 分钟一轮 —— 于是这条会连着刷好几次：
   * ```
   * 13:07:50 graph ingest skipped {"reason": "not-ready"}
   * 13:17:51 graph ingest skipped {"reason": "not-ready"}
   * 13:42:57 graph ingest skipped {"reason": "not-ready"}
   * ```
   * 看起来像"一直没就绪"（要去查 Python/端口），而实际上一切正常、
   * 那一轮正在出结果（同一份日志末尾就是
   * `graph build finished {entities: 1637, facts: 3471}`）。
   *
   * 一个把人引向错误方向的原因码比没有原因码更糟，所以改名而不是加注释。
   */
  | "build-in-progress"
  | "no-new-data"
  | "below-threshold"
  /** 上一次（或连续几次）建图失败了，正在退避 —— 与"攒得不够"是两件事 */
  | "backoff"

/** 建的原因。进日志与界面，用户要知道"它为什么现在开始建" */
export type AutoBuildTriggerReason = "first-build" | "lag-threshold" | "max-age"

/**
 * 要不要现在建图。
 *
 * ★ 顺序是刻意的：先看开关与就绪（那两个是硬闸），再看"首次"
 * （首次必须建，不受阈值约束），最后才是攒批的两个条件。
 *
 * 反过来的话首次建图会被"攒够 500 条"挡住 —— 而一个刚跑完引导、
 * 只采了 200 条消息的新用户就永远等不到图，那正是"用不了"的形态。
 */
export function decideAutoBuild(input: AutoBuildInput): AutoBuildDecision {
  if (!input.enabled) return { build: false, reason: "disabled" }
  if (!input.ready) return { build: false, reason: "build-in-progress" }

  /**
   * ★ 退避排在**首次之前**。
   *
   * 反过来的话"图还没建过 + 建图总是失败"这个组合会每轮都重试 ——
   * 而那恰好是最常见的失败场景（没配 key 的新用户）。
   */
  const failures = input.consecutiveFailures ?? 0
  if (failures > 0) {
    const since =
      input.lastFailureAt === null
        ? Number.POSITIVE_INFINITY
        : input.now - (input.lastFailureAt ?? 0)
    if (since < autoBuildBackoffMs(failures)) return { build: false, reason: "backoff" }
  }

  const newMessages = Math.max(0, input.ackedSeq - input.lastBuiltSeq)

  /**
   * ★ 首次：图不存在就建，不管攒了多少。
   *
   * `graphExists` 而不是 `lastBuiltSeq === 0`：图库可能被"清空重来"删过，
   * 那时游标还在（我们记过），但图真的没了。只看游标会让那种情况
   * 永远不自动重建。
   */
  if (!input.graphExists) {
    // 但一条数据都没有时建图没有意义（kl 会报"没数据"）
    if (input.ackedSeq === 0) return { build: false, reason: "no-new-data" }
    return { build: true, reason: "first-build", newMessages }
  }

  // 图已经在了 → 下面两条都要求**真有新数据**
  if (newMessages === 0) return { build: false, reason: "no-new-data" }

  const threshold = input.lagThreshold ?? AUTO_BUILD_LAG_THRESHOLD
  if (newMessages >= threshold) {
    return { build: true, reason: "lag-threshold", newMessages }
  }

  const maxAge = input.maxAgeMs ?? AUTO_BUILD_MAX_AGE_MS
  const age = input.lastBuiltAt === null ? Number.POSITIVE_INFINITY : input.now - input.lastBuiltAt
  if (age >= maxAge) {
    return { build: true, reason: "max-age", newMessages }
  }

  return { build: false, reason: "below-threshold" }
}

/**
 * 「下一次自动建图什么时候/在什么条件下发生」—— 给界面用的预测。
 *
 * ## ★ 为什么要单独一个函数，而不是让 UI 自己算
 *
 * 判据有三条（首次 / 攒够条数 / 攒够时间）且有优先级与退避，
 * UI 自己算必然与 `decideAutoBuild` 漂移 —— 那时界面说的
 * 「还差 300 条」与实际触发条件不是一回事，而这种偏差没人查得出来。
 * 两者共用同一批常量与同一套判据，是让"显示"与"行为"同源。
 *
 * ## ★ 与 `KlServerStatus.buildProgress` 的区别（那个刻意不渲染）
 *
 * 那个字段是**上游 kl 自报的百分比**，实测只有 Phase A 是真回调、
 * Phase B 恒为 40%，且停 server 时会卡在 stale 值上 —— 所以它被明确
 * 禁止用于任何用户可见的进度（见 contract.ts 里那段长注释与
 * `kl-panel-build-state.test.tsx` 的门禁）。
 *
 * 本函数**不碰**那个字段。它算的是「触发条件还差多少」，输入全是
 * 我们自己库里的水位（`ackedSeq` / `lastBuiltSeq` / `lastBuiltAt`）——
 * 那些是确定的、单调的、我们自己写的。所以它可以显示。
 *
 * @returns `etaMs` = 距下次触发还有多久；null 表示"不由时间决定"
 *   （已满足条件、被关闭、或只差条数而条数不随时间必然增长）。
 */
export function forecastAutoBuild(input: AutoBuildInput): {
  /** 当前判定（与真实触发同源） */
  decision: AutoBuildDecision
  /** 距下次「攒够时间」触发还有多久（ms）。null = 不由时间决定 */
  etaMs: number | null
  /** 还差多少条到条数阈值。0 = 已达到 */
  messagesToThreshold: number
  /** 生效的条数阈值（回显给界面，免得两处写死不同的数） */
  lagThreshold: number
  /** 生效的时间阈值 */
  maxAgeMs: number
} {
  const decision = decideAutoBuild(input)
  const lagThreshold = input.lagThreshold ?? AUTO_BUILD_LAG_THRESHOLD
  const maxAgeMs = input.maxAgeMs ?? AUTO_BUILD_MAX_AGE_MS
  const newMessages = Math.max(0, input.ackedSeq - input.lastBuiltSeq)
  const messagesToThreshold = Math.max(0, lagThreshold - newMessages)

  /**
   * 已经要建了 / 关掉了 / 正在建 → 没有"还要等多久"这回事。
   * 返回 null 而不是 0：0 会被界面显示成「即将开始」，而"被关闭"
   * 与"马上开始"是完全不同的两件事。
   */
  if (decision.build) return { decision, etaMs: 0, messagesToThreshold, lagThreshold, maxAgeMs }
  if (decision.reason === "disabled" || decision.reason === "build-in-progress") {
    return { decision, etaMs: null, messagesToThreshold, lagThreshold, maxAgeMs }
  }

  /**
   * 退避中：下次重试的时刻是确定的（`lastFailureAt + backoff`），
   * 这是最该显示倒计时的情形 —— 否则界面上只是"没在建"，
   * 而用户不知道是坏了还是在等。
   */
  if (decision.reason === "backoff") {
    const failures = input.consecutiveFailures ?? 0
    const at = input.lastFailureAt ?? null
    const eta = at === null ? null : Math.max(0, at + autoBuildBackoffMs(failures) - input.now)
    return { decision, etaMs: eta, messagesToThreshold, lagThreshold, maxAgeMs }
  }

  /**
   * `no-new-data`：时间到了也不会建（`max-age` 那条要求同时有新数据）。
   * 所以这里**没有**倒计时 —— 给一个会走到 0 却什么都不发生的倒计时
   * 比不给更糟。
   */
  if (decision.reason === "no-new-data") {
    return { decision, etaMs: null, messagesToThreshold, lagThreshold, maxAgeMs }
  }

  // below-threshold：有新数据但没攒够 → 到 maxAge 那一刻会因"攒够时间"触发。
  const eta = input.lastBuiltAt === null ? 0 : Math.max(0, input.lastBuiltAt + maxAgeMs - input.now)
  return { decision, etaMs: eta, messagesToThreshold, lagThreshold, maxAgeMs }
}
