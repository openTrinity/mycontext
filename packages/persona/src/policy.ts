/**
 * 自动发送的判定层（Policy）。
 *
 * **8 个条件全满足才自动发送**，任一不满足 → 进草稿箱 + **记录原因**。
 *
 * ## 为什么 decision_reason 是必填
 *
 * 静默降级是最难调试的产品行为：用户开了 auto 却总在出草稿，
 * 如果不告诉他命中了哪条（不在工作时间？置信度 0.71？命中禁止词？
 * **授权过期？**），他唯一能做的就是放弃这个功能。
 *
 * ## 条件 → 原因是编译期强制的映射
 *
 * `CONDITION_TO_REASON` 的 key 是闭合 union，
 * **新增一个 policy 条件而忘了配 reason 就是编译错误** ——
 * 不用等测试跑。这是与 `ERROR_CODES` 同一款做法。
 *
 * `has_valid_grant` 映射到两个子因（无授权 / 已过期），所以值是数组；
 * `dry_run` 刻意**不在**这张表里 —— 它是旁路（dry-run 时根本不评估条件），
 * 不是条件。含糊的口径会让"新增一个 policy 条件却忘了配 reason"无人发现。
 *
 * ## ★ 白名单已删：`replyMode: "auto"` 本身就是那次授权
 *
 * 曾经有第 9 条 `in_send_whitelist` —— 用户把某个会话设成 auto **之后**
 * 还要在另一个清单里把它勾进白名单，才真的自动发。理由是"防手滑把下拉框
 * 点成 auto 就误发"。
 *
 * 但实践上这变成了**同一个意愿要表达两遍**：用户选了「自动」，功能却不自动，
 * 而"为什么不自动"这条静默降级（`not_whitelisted`）恰恰是最难自查的。
 * 把 auto 这个**显式选择**当成授权本身，才是它本来的语义 —— 误发的真正
 * 防线是场景闸（`scene_allows_auto`：只有"答错也无不可逆后果"的场景才放行）
 * 与工作时间/频率/授权那几道，它们都还在。少一道"再确认一遍"的门，
 * 不等于少一道安全闸。
 */
import type { Clock } from "@mycontext/kernel"

export const POLICY_CONDITIONS = [
  "mode_is_auto",
  "within_work_hours",
  "scene_allows_auto",
  /** agent 根据当前语境与 forge 决策层明确表示无需人工审核 */
  "agent_allows_auto",
  "confidence_and_risk",
  "no_banned_phrase",
  "within_rate_limit",
  "kill_switch_inactive",
  /** ★ 外部强制：目标会话存在未过期的发送授权。没有它 auto 模式次日必然失效 */
  "has_valid_grant",
] as const
export type PolicyCondition = (typeof POLICY_CONDITIONS)[number]

export const DECISION_REASONS = [
  "mode_not_auto",
  "outside_work_hours",
  "scene_disallows_auto",
  "agent_requires_review",
  "low_confidence",
  "risk_not_low",
  "banned_phrase",
  "rate_limited",
  "kill_switch",
  "grant_missing",
  "grant_expired",
  /** 旁路而非条件：dry-run 时根本不评估条件 */
  "dry_run",
] as const
export type DecisionReason = (typeof DECISION_REASONS)[number]

/**
 * 条件 → 该条件不满足时的 reason。
 *
 * `Record<PolicyCondition, ...>` 让漏配变成编译错误。
 */
export const CONDITION_TO_REASON: Record<PolicyCondition, readonly DecisionReason[]> = {
  mode_is_auto: ["mode_not_auto"],
  within_work_hours: ["outside_work_hours"],
  scene_allows_auto: ["scene_disallows_auto"],
  agent_allows_auto: ["agent_requires_review"],
  confidence_and_risk: ["low_confidence", "risk_not_low"],
  no_banned_phrase: ["banned_phrase"],
  within_rate_limit: ["rate_limited"],
  kill_switch_inactive: ["kill_switch"],
  has_valid_grant: ["grant_missing", "grant_expired"],
}

/**
 * 一轮的结果记录（`dh_runs.decision` 列）。
 *
 * ★ `"silent"` 是**这一轮无事可做**的记录（例如判定层报 "silent"、
 * 或轮到答时已经被别人答了）——**不再对应任何 replyMode**。首版里
 * `replyMode: "silent"` 表达"这个会话别管"，现在那件事由
 * `triggerMode: "none"` 直接短路（不入 agent），Decision.silent 只保留
 * "这一轮真的没什么好答"这个含义。
 */
export type Decision = "auto_sent" | "drafted" | "silent" | "escalated" | "error"

/** 置信度门槛。0.75 不是拍的：低于它的草稿人工修改率显著上升（凭经验设，后续按数据调）。 */
export const MIN_CONFIDENCE = 0.75

/**
 * 「没有评估过置信度」的哨兵值。
 *
 * ## ★ 为什么需要一个哨兵，而不是随便给个低分
 *
 * 我们**没有**自评机制（刻意的：模型对自己输出的高估是系统性的，
 * 而一个 0.82 分事后无法审计"为什么当时判了能发"）。
 * 首版的做法是给 `confidence = 0.6` —— 一个低于 `MIN_CONFIDENCE`
 * 的假分数，于是 `confidence_and_risk` 恒不通过，自动发送恒被挡住。
 *
 * 那在没有执行器的时期是安全的，但它有两个问题：
 *
 * ① **它不是判定**。0.6 没有回答任何问题，只是一个恰好够低的数字。
 *    看日志的人会以为"模型评估过，评了 0.6" —— 而那是编的。
 * ② 接真发送时它会变成**唯一**的闸。那时要么调高这个假值
 *    （等于凭空放行一切），要么删掉这条判定（等于少一道闸）。
 *
 * 所以：显式用哨兵表示"未评估"，并把这条判定的把关责任交给
 * **场景判定**（`scene.ts`，确定性、可枚举、可审计）。
 * `confidence === UNEVALUATED_CONFIDENCE` 时不因它失败，
 * 但那时 `sceneAllowsAuto` 必须为 true —— 而后者本来就是必过的一条。
 *
 * 将来真接了自评，把它当**加分项**（更高的分可以放宽长度上限之类），
 * 不要让它取代场景。
 */
export const UNEVALUATED_CONFIDENCE = -1

/**
 * 回复模式。
 *
 * ★ 三档：`draft`（只出草稿）、`auto`（想自动发但要过全部闸）、
 * `yolo`（**不过判定闸，直接发**）。
 *
 * ## ★★ `yolo` 是什么、以及它**不是**什么
 *
 * 用户显式要的一档：类似 Claude Code 的 `bypassPermissions` —— 不审批、
 * 不过 gate。加它的理由是 `auto` 在实践中太常降级：不在工作时间、场景不在
 * 白名单、模型说"这条该你拍板"、风险判成 medium……每一条单独都合理，
 * 叠起来的结果是"我选了自动，它还是在出草稿"。yolo 让用户能明确表达
 * "这个会话我不要那层保护"。
 *
 * **它绕过的是"要不要发"的判断**（下面 `evaluatePolicy` 的旁路）：
 * 工作时间 / 场景 / 模型刹车 / 置信度与风险 / 禁止词 / 频率限制，全部不再拦。
 * 服务层还额外放宽两关（`alreadyAnswered`、`runFresh`）。
 *
 * ★ **它不绕过"发的是不是对的那条"**。`SendGuard` 里这三条仍然生效，
 * 因为绕过它们不会让功能更自动，只会制造 bug：
 *
 * · **急停（kill switch）** —— UI 上那个按钮写着「立刻停止所有自动发送」。
 *   yolo 若能穿过它，那个按钮就是在骗人。急停是总闸，不是一道审批。
 * · **按 draftId 重读库比对 contentHash** —— 它防的是"批准了 A、发出去 B"
 *   （内存里的 draft 被后续 turn 覆盖 / UI 编辑与发送有竞态）。
 *   绕过它只会让你发出**不是你想发的那条**。
 * · **@占位符校验 与 grant 被撤销** —— 前者防"发出去但没 @ 到人"（静默失败）；
 *   后者是渠道明确说过"不行"，绕过只是反复白调必然失败的命令。
 *
 * 也就是说：yolo 关掉的是**判断**，不是**正确性**。
 *
 * ## 历史：曾经还有 `smart` / `silent`
 *
 * · `smart`（"按需自动"）与 `auto` 在**能不能发**上完全相同（都要过
 *   全部闸门），差别只在"没过时算不算异常" —— 让用户在
 *   两个行为一致、只有报错口径不同的选项之间选，是在考他读没读过实现。
 *   合并到 `auto`：没过条件时退回草稿是**预期行为**。
 * · `silent`（"这个会话别管"）是**范围**问题，正确出口是触发条件里的
 *   「不触发」（`triggerMode: "none"`）—— 那一档现在直接短路 agent
 *   （见 `matchesTrigger`），比在模式里绕一圈干净。
 *
 * 存量库里可能残留 `smart` / `silent` 行：读回时被 `REPLY_MODES` 白名单
 * 拦住，退回缺省 `draft`。写路径永远只写这两个值。不做数据迁移
 * （多一份可能出错的路径）。
 */
export const REPLY_MODES = ["draft", "auto", "yolo"] as const
export type ReplyMode = (typeof REPLY_MODES)[number]

export interface WorkHours {
  /**
   * 0=周日 … 6=周六。
   *
   * ★ 用 `number[]` 而不是 `readonly number[]`：`personaRuntimeLimitsSchema`
   * （ipc-contract）里 zod 推出来的是可变数组，两处只在类型形状上分歧、
   * 语义完全相同 —— 声明成可变让两条链路的类型直接互换（否则要各写一遍
   * 转换代码，而转换代码就是新的漂移源）。
   * runtime 层的只读性由 `evaluatePolicy` 不写它来保证。
   */
  days: number[]
  /** 本地时间的小时（含），如 9 */
  startHour: number
  /** 本地时间的小时（不含），如 19 */
  endHour: number
}

export interface RateLimit {
  /** 每会话在 windowMs 内最多几条 */
  perConversation: number
  perConversationWindowMs: number
  /** 全局在 windowMs 内最多几条 */
  global: number
  globalWindowMs: number
}

export interface PolicyInput {
  replyMode: ReplyMode
  /** 场景是否允许自动发送（只有"答错也无不可逆后果"的场景才允许） */
  sceneAllowsAuto: boolean
  /** 模型是否明确判定可以直接回复；缺失/解析失败必须传 false。 */
  agentAllowsAuto: boolean
  confidence: number
  risk: "low" | "medium" | "high"
  /** 正文命中的禁止词（空数组 = 未命中） */
  bannedPhraseHits: readonly string[]
  /** 最近的发送时间戳（用于频率判定） */
  recentSendsInConversation: readonly number[]
  recentSendsGlobal: readonly number[]
  killSwitchActive: boolean
  /** 授权状态。null = 从未授权；有值时看 expiresAt */
  grant: { expiresAt: number | null; revokedAt: number | null } | null
  /** 试运行：**旁路**，不评估 8 条 */
  dryRun: boolean
  workHours: WorkHours
  rateLimit: RateLimit
}

export interface PolicyVerdict {
  decision: Decision
  /** 未自动发送时**必填** */
  reason: DecisionReason | null
  /** 全部未通过的条件（诊断用：一次看到所有拦住它的原因，而不是只看第一个） */
  failedConditions: PolicyCondition[]
}

/**
 * 判定。
 *
 * 返回**全部**未通过的条件而不是短路在第一个：用户改完"工作时间"
 * 发现还是出草稿（因为置信度也不够）会觉得我们在骗他。
 * 但 `reason` 只给第一个 —— UI 上要有个主要原因。
 */
export function evaluatePolicy(input: PolicyInput, clock: Clock): PolicyVerdict {
  // dry-run 是旁路：根本不评估条件。
  if (input.dryRun) {
    return { decision: "drafted", reason: "dry_run", failedConditions: [] }
  }

  /**
   * ── yolo：**旁路**，与 dry-run 同一性质（不评估条件），不是一个新条件。
   *
   * ★ 顺序：在 `dryRun` **之后**。dry-run 是"绝不真发"的开关，优先级更高 ——
   * yolo 不该穿过它（否则 `--dry-run` 就不再是安全的了）。
   *
   * ★ 刻意**不**进 `POLICY_CONDITIONS` / `CONDITION_TO_REASON`：那张表的意义是
   * "新增一个条件而忘配 reason 就编译错误"，把旁路混进去会让这个口径变糊
   * （文件头已经为 `dry_run` 立过同一条规矩）。
   *
   * 绕过的是"要不要发"的判断；"发的是不是对的那条"仍由 SendGuard 保证
   * （急停 / 重读库比对 hash / @占位符 / grant 被撤销）—— 见 `REPLY_MODES` 注释。
   */
  if (input.replyMode === "yolo") {
    return { decision: "auto_sent", reason: null, failedConditions: [] }
  }

  const now = clock.now()
  const failed: PolicyCondition[] = []
  /** 每个失败条件对应的具体 reason（同一条件可能有多个子因）。 */
  const reasons: DecisionReason[] = []

  /**
   * `auto` 想自动发，`draft` 不想。就这两种，见文件头。
   *
   * ★ 选了 `auto` 就是那次授权本身 —— 不再需要另一份白名单再确认一遍
   * （见文件头「白名单已删」）。真正的误发防线是下面的场景 / 工作时间 /
   * 频率 / 授权几道闸。
   */
  const wantsAuto = input.replyMode === "auto"
  if (!wantsAuto) {
    failed.push("mode_is_auto")
    reasons.push("mode_not_auto")
  }

  if (!withinWorkHours(now, input.workHours)) {
    failed.push("within_work_hours")
    reasons.push("outside_work_hours")
  }

  if (!input.sceneAllowsAuto) {
    failed.push("scene_allows_auto")
    reasons.push("scene_disallows_auto")
  }

  if (!input.agentAllowsAuto) {
    failed.push("agent_allows_auto")
    reasons.push("agent_requires_review")
  }

  // 置信度与风险合成一个条件，但两个子因分开报 —— 用户要知道是哪个。
  /**
   * ★ 「未评估」不算低置信度。
   *
   * 我们没有自评机制，所以这个数是哨兵而不是分数（见 `UNEVALUATED_CONFIDENCE`）。
   * 把它当成"低于门槛"会让这条判定变成**唯一**挡住自动发送的东西，
   * 而它挡住的理由是假的 —— 真正该挡的是场景（`scene_allows_auto`，
   * 上面那一条），那才是可枚举、可审计的。
   *
   * 一旦真接了自评，`confidence` 会是真实分数，这个分支自然不再命中。
   */
  const evaluated = input.confidence !== UNEVALUATED_CONFIDENCE
  if (evaluated && input.confidence < MIN_CONFIDENCE) {
    failed.push("confidence_and_risk")
    reasons.push("low_confidence")
  } else if (input.risk !== "low") {
    failed.push("confidence_and_risk")
    reasons.push("risk_not_low")
  }

  if (input.bannedPhraseHits.length > 0) {
    failed.push("no_banned_phrase")
    reasons.push("banned_phrase")
  }

  if (!withinRateLimit(now, input)) {
    failed.push("within_rate_limit")
    reasons.push("rate_limited")
  }

  if (input.killSwitchActive) {
    failed.push("kill_switch_inactive")
    reasons.push("kill_switch")
  }

  // ★ 外部强制的授权门。
  const grantReason = evaluateGrant(input.grant, now)
  if (grantReason !== null) {
    failed.push("has_valid_grant")
    reasons.push(grantReason)
  }

  if (failed.length === 0) {
    return { decision: "auto_sent", reason: null, failedConditions: [] }
  }

  // 只剩 draft / auto —— 没过条件就出草稿，让人审
  const primary = reasons[0] ?? "mode_not_auto"
  return { decision: "drafted", reason: primary, failedConditions: failed }
}

/**
 * 授权判定。
 *
 * ## ★ 「没有授权记录」**不再**是失败
 *
 * 原来 `grant === null → grant_missing`，于是自动发送必须先有一条本地
 * 授权记录。实测那个前提不成立：`chat chmod chat.message:send` 在这个
 * 环境上授不下来（服务端返回 `scope未配置授权规则: chat.message:send`，
 * 而 `chat.group:destroy` 同样失败 —— 说明整套 chmod 规则没开，
 * 不是我们参数拼错），而 `chat message send --dry-run` **干净通过**、
 * 没有任何权限抱怨。
 *
 * 硬性要求一个拿不到的东西，结果是把一个实测可用的功能永久焊死。所以：
 *
 * · `null`（从没授权过）→ **通过**，让真发一次的返回说话；
 * · 有记录但被**撤销**了 → 仍然拦（那是渠道明确说过"不行"）；
 * · 有记录但**过期**了 → 仍然拦（本地推算值，但过期是我们能看出的信号）。
 *
 * `expiresAt` 本来就只是**优化**（提前拦住必然失败的调用），
 * 正确性一直来自「真发一次看返回什么」（见 send-guard）。
 * 这个改动只是让那句话在代码里真正成立。
 */
function evaluateGrant(
  grant: PolicyInput["grant"],
  now: number,
): "grant_missing" | "grant_expired" | null {
  // ★ 没有记录不算失败 —— 见上
  if (grant === null) return null
  if (grant.revokedAt !== null) return "grant_missing"
  // permanent 授权的 expiresAt 为 null
  if (grant.expiresAt !== null && grant.expiresAt <= now) return "grant_expired"
  return null
}

/** 工作时间判定。用本地时区（用户说的"9 点"是他自己的 9 点）。 */
export function withinWorkHours(nowMs: number, hours: WorkHours): boolean {
  const date = new Date(nowMs)
  if (!hours.days.includes(date.getDay())) return false
  const hour = date.getHours()
  return hour >= hours.startHour && hour < hours.endHour
}

function withinRateLimit(now: number, input: PolicyInput): boolean {
  /**
   * ★ 上限为 0 = **这一关关闭**，直接放行。
   *
   * 必须在计数比较之前短路：`count >= 0` 恒成立，不短路的话 0 会从
   * "不限"变成"永远限流"（最坏的反向 bug —— 用户想放开却被彻底堵死，
   * 而 UI 上看起来一切正常）。两关各自独立：单会话关了、全局仍可限。
   */
  if (input.rateLimit.perConversation > 0) {
    const conversationCount = input.recentSendsInConversation.filter(
      (at) => now - at < input.rateLimit.perConversationWindowMs,
    ).length
    if (conversationCount >= input.rateLimit.perConversation) return false
  }

  if (input.rateLimit.global > 0) {
    const globalCount = input.recentSendsGlobal.filter(
      (at) => now - at < input.rateLimit.globalWindowMs,
    ).length
    if (globalCount >= input.rateLimit.global) return false
  }

  return true
}

/** 默认设置。默认值刻意保守：误发的社交成本不可逆。 */
export const DEFAULT_WORK_HOURS: WorkHours = {
  days: [1, 2, 3, 4, 5],
  startHour: 9,
  endHour: 19,
}

/**
 * 频率上限默认值：单会话 **1 分钟 5 条**、全局 **1 小时 100 条**。
 *
 * 比最初的 2 条 /10 分钟、20 条 /1 小时宽得多 —— 那套过严，正常一轮对话
 * 里补一两句就撞上了，而它降级成草稿又指向一个当时不存在的设置入口。
 * 现在入口有了（设置页），默认放到"几乎不碍事、但连发十条仍会兜住"。
 * 想彻底关掉把条数设 0（见 `withinRateLimit` 的 0 短路）。
 */
export const DEFAULT_RATE_LIMIT: RateLimit = {
  perConversation: 5,
  perConversationWindowMs: 60 * 1000,
  global: 100,
  globalWindowMs: 60 * 60 * 1000,
}
