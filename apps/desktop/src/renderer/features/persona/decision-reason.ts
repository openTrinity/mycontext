/**
 * `decision_reason` / `DropReason` → 人话 + **下一步动作**。
 *
 * ## 为什么必须给下一步动作，而不只是翻译
 *
 * 用户开了自动回复却总在出草稿，看到一个 `grant_missing` 或
 * `low_confidence` 是没有用的 —— 他不知道该做什么，唯一能做的
 * 就是放弃这个功能。
 *
 * 而这些 reason 里绝大多数是**用户能自己解决**的（工作时间、频率、
 * 禁止词、停摆开关、去申请一次授权），另一些是「本来就该这样」
 * （只出草稿模式、判定层说该他拍板）。两者必须区分：让用户去改一个
 * 改不了的东西比不告诉他更糟，而把一个他点一下就能解决的说成
 * "功能还没做"会让他根本不去点。
 *
 * ## 为什么是纯函数 + `Record`
 *
 * `Record<DecisionReason, …>` 让**漏一个变成编译错误**。
 * policy 那边加一条 reason 时，这里不补就编译不过 ——
 * 而如果用 `switch` + default，加的那条会静默显示成兜底文案。
 *
 * 纯函数也让它可以穷举测试（所有 reason 都有非空文案 + 分类正确）。
 */
import type { DecisionReason } from "@mycontext/persona"

/**
 * 这条原因的**性质**。UI 据此决定用什么颜色与要不要给按钮。
 *
 * · `actionable` —— 用户改个设置就能解决；
 * · `not-built` —— 产品还没做，让他等（而不是让他去找一个不存在的开关）；
 * · `by-design` —— 就该这样（比如只出草稿模式），不是问题。
 */
export type ReasonKind = "actionable" | "not-built" | "by-design"

export interface ReasonExplained {
  kind: ReasonKind
  /** i18n key（文案在 persona.json 的 reasons 下） */
  labelKey: string
  /** 下一步动作的 i18n key；`by-design` 与 `not-built` 可以没有 */
  actionKey?: string
}

/**
 * 全部 decision reason 的解释。
 *
 * ★ 用 `Record` 而不是 `Partial<Record>`：漏一个是编译错误。
 */
export const DECISION_REASON_INFO: Record<DecisionReason, ReasonExplained> = {
  mode_not_auto: {
    // 这不是问题：用户自己选了"只出草稿"
    kind: "by-design",
    labelKey: "reasons.mode_not_auto",
  },
  outside_work_hours: {
    kind: "actionable",
    labelKey: "reasons.outside_work_hours",
    actionKey: "reasons.actions.editWorkHours",
  },
  scene_disallows_auto: {
    /**
     * ★ 已经是真判定，不再是"没做"。
     *
     * `evaluateScene` 的五条（群里必须 @我、不许有问号、不许含承诺、
     * ≤60 字、不许是占位文案）全都在跑。标 not-built 会让用户以为
     * 自动发送坏了，而实际上是这条草稿本身不适合自动发 —— 那两件事的
     * 处置完全不同（一个是等我们修，一个是他自己看一眼就能发）。
     */
    kind: "by-design",
    labelKey: "reasons.scene_disallows_auto",
  },
  agent_requires_review: {
    kind: "by-design",
    labelKey: "reasons.agent_requires_review",
  },
  low_confidence: {
    /**
     * 仍然是 not-built，但理由变了：我们**刻意不做**模型自评
     * （见 `UNEVALUATED_CONFIDENCE`），把关交给判定层与场景。
     * 所以这条 reason 现在基本到不了 —— 真到了说明有人接了自评。
     */
    kind: "not-built",
    labelKey: "reasons.low_confidence",
  },
  risk_not_low: {
    kind: "not-built",
    labelKey: "reasons.risk_not_low",
  },
  banned_phrase: {
    kind: "actionable",
    labelKey: "reasons.banned_phrase",
    actionKey: "reasons.actions.editBannedPhrases",
  },
  rate_limited: {
    kind: "actionable",
    labelKey: "reasons.rate_limited",
    actionKey: "reasons.actions.editRateLimit",
  },
  kill_switch: {
    kind: "actionable",
    labelKey: "reasons.kill_switch",
    actionKey: "reasons.actions.releaseKillSwitch",
  },
  grant_missing: {
    /**
     * ★ 授权入口已经做了（设置页的「申请授权」→ `requestGrant`），
     * 所以这条是 **actionable**：用户自己点一下就能解决。
     *
     * 留成 not-built 的代价很具体：用户看到"功能还没做"就不会去点那个
     * 按钮，于是自动发送永远差这一条 —— 而没有任何东西告诉他差的是它。
     */
    kind: "actionable",
    labelKey: "reasons.grant_missing",
    actionKey: "reasons.actions.requestGrant",
  },
  grant_expired: {
    // 同上：续授也是他自己点。TTL 默认 7 天，到期前 24h 就开始提醒
    kind: "actionable",
    labelKey: "reasons.grant_expired",
    actionKey: "reasons.actions.requestGrant",
  },
  dry_run: {
    kind: "by-design",
    labelKey: "reasons.dry_run",
  },
}

/**
 * 准入闸的丢弃原因。
 *
 * 与 decision reason 分开：那些是"生成了但没自动发"，
 * 这些是"根本没进队列"。混在一起会让用户以为数字人试过了。
 *
 * ★ 这里**没有** `not_listening`：`listening` 概念已删（管控层收所有消息）。
 * 留着它会让"用户没管过这个会话"看起来仍是一个丢弃理由。
 */
export const DROP_REASON_KEYS: Record<string, string> = {
  bot_channel: "drops.bot_channel",
  self_conversation: "drops.self_conversation",
  already_answered: "drops.already_answered",
  stale_message: "drops.stale_message",
  batch_overflow: "drops.batch_overflow",
  origin_agent: "drops.origin_agent",
  is_self: "drops.is_self",
  trigger_not_matched: "drops.trigger_not_matched",
  kill_switch: "drops.kill_switch",
}

/**
 * 不由 policy 判定、但会写进 `not_sent_reason` 的那些原因。
 *
 * ★ 与 `DECISION_REASON_INFO` 分开：那张表的键是 `DecisionReason`
 * （`PolicyCondition` 推出来的枚举，`Record` 保证漏一个是编译错误）。
 * 这些原因是**在 policy 之外**决定的（生成完之后才知道），硬塞进那个
 * 枚举会让 policy 的条件表出现几个没有对应条件的成员。
 *
 * 不登记的后果是它们**原样显示成裸串**（`already_answered` 这种），
 * 那正是"没有意义的纯文本"。
 */
const EXTRA_REASON_INFO: Record<string, ReasonExplained> = {
  /**
   * 你已经自己回过这一轮了 → 不自动发，但草稿留着可以手动发。
   *
   * `by-design` 而不是 `actionable`：这不是一个要修的问题，说清就够。
   */
  already_answered: {
    kind: "by-design",
    labelKey: "reasons.already_answered",
  },
}

/**
 * 查一条 reason 的解释。
 *
 * 未知 reason（比如我们自己塞的 `generation_failed`）返回 null ——
 * 调用方原样显示那个串。**不给兜底文案**：兜底会把"模型调用失败"
 * 这类真错误显示成一句无意义的客套，而那正是需要被看到的。
 */
export function explainDecisionReason(reason: string | null): ReasonExplained | null {
  if (reason === null) return null
  return DECISION_REASON_INFO[reason as DecisionReason] ?? EXTRA_REASON_INFO[reason] ?? null
}

/**
 * 能力降级的原因 → 顶部横幅的那句话。
 *
 * ## ★ 为什么与 decision reason 分开一张表
 *
 * 上面那些是**单条草稿**为什么没自动发（用户可以逐条看）；这里是
 * **整个模块**的能力少了一块，影响每一次生成。两者的读者动作不同：
 * 前者是"这条我手动发一下"，后者是"我得去装个东西 / 配个东西"。
 *
 * ## ★ 为什么必须按原因分文案
 *
 * 原来只有一句"未配置模型 —— 去设置里配好 LLM"。而实测同事的状态是
 * `opencode_version_unreadable`：他的模型**配好了**
 * （日志 `llm holder reconfigured, model: gpt-5.6-sol`），横幅却让他去配模型。
 * 让用户去改一个改不了的东西比不告诉他更糟 —— 这条与
 * `DECISION_REASON_INFO` 文件头写的是同一个道理。
 *
 * `opencode_too_old` 带着版本号（`opencode_too_old:1.1.0<1.2.23`），
 * 所以用前缀匹配而不是全等。
 */
export function explainDegradedReason(reason: string, t: (key: string) => string): string {
  if (reason === "llm_not_configured") return t("degradedReasons.llmNotConfigured")
  if (reason === "opencode_missing") return t("degradedReasons.agentMissing")
  if (reason === "opencode_version_unreadable") return t("degradedReasons.agentUnreadable")
  if (reason.startsWith("opencode_too_old")) return t("degradedReasons.agentTooOld")
  /**
   * 未登记 → 原样显示那个串。
   *
   * **不回退到"未配置模型"那句**：那正是这次要修掉的行为 ——
   * 一句听起来合理但错的话，会让用户按它去做一件没用的事，
   * 而显示一个陌生的枚举串至少能被搜到、能被问出来。
   */
  return reason
}
