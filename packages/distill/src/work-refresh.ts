/**
 * work 层的**攒批判据** —— 一个纯函数，因为它全是判断、没有 IO。
 *
 * ## 为什么必须攒批（而 forge 不用）
 *
 * forge 是免费的：纯本地测量、零模型调用，实测 4400 条约 5 秒。所以它可以
 * 每 6 小时全量重跑一遍，代价接近于零。
 *
 * work 层不是。它每个 facet 是一次上万 token 的模型调用，一轮四个 facet ——
 * 挂在同一个 6 小时定时器上就是**每天 4 次为同一批老语料付钱**。而这正是
 * LLM 那半当年被整个关掉的原因（`DistillService` 文件头：产出没人读、成本照付、
 * 且不报错）。接回来时原样复活那个成本模型，等于把当时的结论作废。
 *
 * ## 判据与 `knowledge-feed/auto-build.ts` 同形，是刻意的
 *
 * 那个文件解决的是完全相同的问题（建图约 2 小时，导出 10 分钟一轮，
 * 不攒批就会常态跑满 embedding 配额），而它的形状已经在生产里跑过：
 *
 * · 首次必须跑（不受阈值约束，否则新用户永远等不到产出）；
 * · 攒够条数（把单条成本摊薄）；
 * · 攒够时间**且确实有新数据**（低频用户也不该看一份三周前的画像；
 *   而没有新数据时跑一轮是纯浪费 —— 同一份语料抽出来的结论一样）；
 * · 连续失败指数退避（否则没配 key 的用户每 6 小时刷一次同样的 warn）。
 *
 * 抄形状而不抄代码：那边的输入是 `ackedSeq / lastBuiltSeq / graphExists`，
 * 语义是"图建到哪"；这边是"work 层抽到哪"。共用一个函数要塞进两套字段名，
 * 那种"看起来通用其实两个分支"的抽象比两个小函数难懂。
 *
 * ## ★ 为什么阈值比建图的 500 条低
 *
 * 建图那边一轮约 2 小时，所以要攒到 500 条才划算。work 层一轮是几十秒到
 * 几分钟，量级差两个数 —— 用同一个阈值会让它在中低频账号上几乎不触发，
 * 而画像该跟着新语料走。200 条是"够得出新结论"与"别为几条消息重抽"的折中。
 */

/** 攒够多少条新消息才值得重抽一轮 work 层。见文件头。 */
export const WORK_LAG_THRESHOLD = 200

/**
 * 攒够多久（有新数据的前提下）也重抽一轮。
 *
 * 比建图那边的 24h 长：work 层抽的是职责与工作方式，那些**按周变**
 * （换项目、接手新系统），不像作息与语气那样按天抖动。3 天是
 * "别让画像过期"与"别为一点新语料重抽"之间的折中。
 */
export const WORK_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000

/**
 * 连续失败 n 次之后至少等多久再试（索引 = 已连续失败次数，1 起）。
 *
 * 与建图那边同一组数与同一个理由：有一类失败是**立即返回**的（没配 key、
 * 模型网关 401），那时判据依然成立、下一轮再试一次 —— 一天几十次同样的 warn，
 * 而用户以为它在抽。
 *
 * ★ 退避状态只在**内存**里（进程重启清零）：失败原因多半是配置，
 * 而用户填完 key 通常会重启应用 —— 那时该立刻重试，不是继续等 2 小时。
 */
export const WORK_BACKOFF_MS = [30 * 60_000, 60 * 60_000, 2 * 60 * 60_000] as const

/** 第 n 次连续失败后的退避时长（n 从 1 起）。 */
export function workBackoffMs(failures: number): number {
  if (failures <= 0) return 0
  const index = Math.min(failures, WORK_BACKOFF_MS.length) - 1
  return WORK_BACKOFF_MS[index] ?? 0
}

export interface WorkRefreshInput {
  /** changelog 的当前最大 seq（"语料准备到哪"） */
  latestSeq: number
  /** 上一次**成功抽完** work 层时确认到的 seq。0 = 从没抽过 */
  lastRunSeq: number
  /** 上一次成功抽完的时刻（ms）。null = 从没抽过 */
  lastRunAt: number | null
  /** 现在几点（注入，让测试可复现） */
  now: number
  /**
   * 产物是不是真的在。false = `work.md` 不存在（或被清过）。
   *
   * ★ 与 `lastRunSeq === 0` **不是**一回事：产物可能被删过（换 vault、
   * 用户清过 skill 包、上一轮判定为置信度不足而删了文件），那时游标还在。
   * 只看游标会让那些情况永远不再产出，而界面上看不出来。
   */
  artifactExists: boolean
  /** 用户是否开着 work 层（`llmFacets`） */
  enabled: boolean
  /** 有没有可用的 LLM。没有就别起一轮注定失败的（且会刷错误日志） */
  llmReady: boolean
  /** 已经**连续**失败几次（成功一次归零） */
  consecutiveFailures?: number
  /** 上一次失败的时刻（ms）。`consecutiveFailures > 0` 时必须给 */
  lastFailureAt?: number | null
  lagThreshold?: number
  maxAgeMs?: number
}

/**
 * 不跑的原因。**每一个都要能区分**，因为下一步完全不同：
 * 用户关着 vs 没配 key vs 攒得不够 vs 正在退避 —— 界面上要说不同的话，
 * 而一个笼统的"跳过"会让"没配 key"永远不被发现。
 */
export type WorkRefreshSkipReason =
  | "disabled"
  | "no-llm"
  | "no-new-data"
  | "below-threshold"
  | "backoff"

/** 跑的原因。进日志与界面，用户要知道"它为什么现在开始抽"。 */
export type WorkRefreshTriggerReason = "first-run" | "lag-threshold" | "max-age"

export type WorkRefreshDecision =
  | { run: false; reason: WorkRefreshSkipReason }
  | { run: true; reason: WorkRefreshTriggerReason; newMessages: number }

/**
 * 要不要现在重抽 work 层。
 *
 * ★ 顺序是刻意的，与 `decideAutoBuild` 一致：
 * 硬闸（开关、LLM）→ 退避 → 首次 → 攒批两条。
 *
 * **退避必须排在首次之前。** 反过来的话「还没抽过 + 每次都失败」这个组合会
 * 每轮都重试 —— 而那恰好是最常见的失败场景（没配 key 的新用户），
 * 于是每 6 小时烧一次失败的调用并刷一条同样的日志。
 */
export function decideWorkRefresh(input: WorkRefreshInput): WorkRefreshDecision {
  if (!input.enabled) return { run: false, reason: "disabled" }
  /**
   * 没有 LLM 就不起。
   *
   * 起了的结果是 `mapWithLlm` 抛 `CONFIG_INVALID`（那是对的，见它的注释：
   * 静默产 0 条会让"少配了一个 key"永远不被发现）—— 但那条错误该在用户
   * **点按钮**时报给他，而不是由定时器每 6 小时往日志里刷一次。
   */
  if (!input.llmReady) return { run: false, reason: "no-llm" }

  const failures = input.consecutiveFailures ?? 0
  if (failures > 0) {
    const since =
      input.lastFailureAt === null || input.lastFailureAt === undefined
        ? Number.POSITIVE_INFINITY
        : input.now - input.lastFailureAt
    if (since < workBackoffMs(failures)) return { run: false, reason: "backoff" }
  }

  const newMessages = Math.max(0, input.latestSeq - input.lastRunSeq)

  /**
   * ★ 首次：产物不在就抽，不管攒了多少。
   *
   * 用 `artifactExists` 而不是 `lastRunSeq === 0` —— 见那个字段的注释。
   */
  if (!input.artifactExists) {
    // 但一条语料都没有时抽是没意义的（模型只能编）
    if (input.latestSeq === 0) return { run: false, reason: "no-new-data" }
    return { run: true, reason: "first-run", newMessages }
  }

  // 产物已经在了 → 下面两条都要求**真有新数据**
  if (newMessages === 0) return { run: false, reason: "no-new-data" }

  const threshold = input.lagThreshold ?? WORK_LAG_THRESHOLD
  if (newMessages >= threshold) return { run: true, reason: "lag-threshold", newMessages }

  const maxAge = input.maxAgeMs ?? WORK_MAX_AGE_MS
  const age = input.lastRunAt === null ? Number.POSITIVE_INFINITY : input.now - input.lastRunAt
  if (age >= maxAge) return { run: true, reason: "max-age", newMessages }

  return { run: false, reason: "below-threshold" }
}
