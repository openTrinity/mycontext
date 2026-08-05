/**
 * 蒸馏的准入守卫。
 *
 * 放在一个文件里而不是散在各 map 函数里，是因为「哪条语料能进画像」
 * 这个判断只要有一处漏了，画像就被污染，而且**不可逆** ——
 * 污染后的结论会作为下一轮的基线继续放大。
 */
import { AppError } from "@mycontext/kernel"
import type { ConversationRow, MessageRow } from "@mycontext/store"

export const DISTILL_REJECT_REASONS = [
  "identity_unconfirmed",
  "self_generated",
  "bot_channel",
  "empty_content",
  "distill_disabled",
] as const
export type DistillRejectReason = (typeof DISTILL_REJECT_REASONS)[number]

export type DistillVerdict = { ok: true } | { ok: false; reason: DistillRejectReason }

/**
 * 判断一条消息能否进入蒸馏。
 *
 * 签名带 `conv` 是必要的：`is_bot_channel` 定义在 conversations 表上，
 * 不在 messages 上 —— 只传 message 会在实施时取不到值。
 */
export function assertDistillable(
  message: MessageRow,
  conversation: ConversationRow,
  options: { distillEnabled?: boolean } = {},
): DistillVerdict {
  /**
   * 1. 本人判定只用 ID，且**未判定时拒绝**。
   *
   * 实测本人在群里显示花名（与组织内姓名不一致），且同名同姓 search
   * 返回 5+ 个不同 ID —— 姓名匹配会灾难性误判。
   * `is_self = null` 表示"还没判定"，此时把它当成任一边都是猜。
   */
  if (message.isSelf === null) return { ok: false, reason: "identity_unconfirmed" }

  /**
   * 2. 数字人自产消息**永久排除**。
   *
   * auto 模式下自动回复量大，不排除的话画像会在几轮内坍缩到模型自己的口吻
   * （自我强化漂移）—— 而且这个过程是渐进的，没有任何一刻会"报错"。
   */
  if (message.origin === "agent") return { ok: false, reason: "self_generated" }

  /**
   * 3. 机器人/告警群排除。
   *
   * 实测存在高频告警机器人，会严重污染 routines（活跃时段被告警拉平）
   * 与 expertise（一堆运维术语被当成本人的专业领域）两个 facet。
   */
  if (conversation.isBotChannel) return { ok: false, reason: "bot_channel" }

  if (message.contentText === null || message.contentText.trim() === "") {
    return { ok: false, reason: "empty_content" }
  }

  // 用户在 UI 上把这个会话的蒸馏关掉了
  if (options.distillEnabled === false) return { ok: false, reason: "distill_disabled" }

  return { ok: true }
}

/** 只保留可蒸馏的消息，并返回被拒的计数（进度页要显示"跳过了多少、为什么"）。 */
export function filterDistillable(
  messages: readonly MessageRow[],
  conversationById: ReadonlyMap<string, ConversationRow>,
  options: { distillEnabledByConversation?: ReadonlyMap<string, boolean> } = {},
): { accepted: MessageRow[]; rejected: Record<DistillRejectReason, number> } {
  const rejected: Record<DistillRejectReason, number> = {
    identity_unconfirmed: 0,
    self_generated: 0,
    bot_channel: 0,
    empty_content: 0,
    distill_disabled: 0,
  }
  const accepted: MessageRow[] = []

  for (const message of messages) {
    const conversation = conversationById.get(message.conversationId)
    if (conversation === undefined) continue
    const enabled = options.distillEnabledByConversation?.get(message.conversationId)
    const verdict = assertDistillable(
      message,
      conversation,
      enabled === undefined ? {} : { distillEnabled: enabled },
    )
    if (verdict.ok) accepted.push(message)
    else rejected[verdict.reason] += 1
  }

  return { accepted, rejected }
}

export interface FacetCandidate {
  facet: string
  scope: "global" | "conversation" | "contact"
  /** global 时必须是空串（不是 null）—— 见 profile_facets 的唯一键注释 */
  scopeRef: string
  key: string
  value: unknown
  confidence: number
  /** 证据：message_id 列表。**空数组一律拒绝入库** */
  evidence: string[]
  source: "llm" | "stat" | "user"
}

/**
 * 无证据的结论一律拒绝入库。
 *
 * 这是可信度与可审计的**底线，不是可配置项**：
 * 用户在审阅页点开一条结论要能看到"这是从哪几句话得出的"。
 * 允许无证据的结论进来，等于允许模型往画像里写它想出来的东西。
 */
export function assertHasEvidence(candidate: FacetCandidate): void {
  if (candidate.evidence.length === 0) {
    throw new AppError(
      "DISTILL_NO_EVIDENCE",
      `结论 ${candidate.facet}/${candidate.key} 没有原文依据，拒绝写入画像`,
      {
        messageKey: "errors:byCode.DISTILL_NO_EVIDENCE",
        context: { facet: candidate.facet, key: candidate.key, scope: candidate.scope },
      },
    )
  }
}

/**
 * 规范化 scopeRef：global 一律空串。
 *
 * 单独一个函数是为了让「不允许 null」这条有个可搜索的落点 ——
 * 可空列参与 UNIQUE 时那些行的唯一性完全不生效（实测），
 * 而 global 恰恰是画像的主要来源。
 */
export function normalizeScopeRef(
  scope: FacetCandidate["scope"],
  scopeRef: string | null | undefined,
): string {
  if (scope === "global") return ""
  const value = scopeRef ?? ""
  if (value === "") {
    throw new AppError("CONFIG_INVALID", `scope=${scope} 时必须提供 scopeRef`)
  }
  return value
}
