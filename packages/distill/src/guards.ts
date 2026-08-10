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
 * 一条结论的证据**是不是本人说的话** —— 落库前的第三道防线。
 *
 * ## ★★ 为什么必须有这一道（prompt 已经写了，但压不住）
 *
 * `SYSTEM_PROMPT` 第 1 条已经是「只描述**标注为「我」的那个人**」，而实测
 * 本机库（33924 条消息、273 条结论）按 `evidence_json` 回查每条证据的 `is_self`：
 *
 * | facet | is_self=1 | is_self=0 | 三张表里都查不到 |
 * | --- | --- | --- | --- |
 * | tasks | 154 | **61** | 0 |
 * | role | 151 | **16** | **12** |
 * | knowhow | 71 | 4 | 0 |
 *
 * 也就是模型把**别人的话**当成了本人的。后果在 `role` 一节里直接可见 ——
 * 同时出现两个互相矛盾的人：
 *
 * ```
 * 0.7  "前端开发，负责 Web 前端页面渲染、路由配置与 UI 呈现"
 * 0.8  "不负责前端开发实现——给出交互设计方案后由前端同学实现"
 * ```
 *
 * 而且**他/她混用**（「想合分支时她要求等」）—— 那是把群里另一个人的职责
 * 写进了本人画像。这与 `assertDistillable` 拒绝 `is_self === null` 是同一个
 * 判断的延伸：那一道保证「进 prompt 的消息本人身份已判定」，
 * **不保证一条结论的证据是本人说的**。中间这个缺口就是上面那 61 条。
 *
 * `filterDistillable` 也不能替代它：抽取需要看到别人的话（否则没有上下文，
 * 「别人找他做什么」根本无从谈起），所以语料里必须有 `is_self=0`。
 * 能拦的位置只有**结论落库前**。
 *
 * ## ★ 判据按 facet 分档，因为那五个 facet 问的问题不同
 *
 * · `role` / `workflow` / `artifacts` / `knowhow` —— 问的是「**他**怎么做」，
 *   所以要求**全部**证据都是本人的。一条别人说的话不足以证明他的做法；
 * · `tasks` —— 问的是「**别人**找他做什么」，触发句本来就是别人说的
 *   （「MR 链接 + 一句话」那句话是同事发的）。所以允许别人的证据，
 *   但要求**至少有一条本人的**：否则「别人在群里聊到某事」会被写成
 *   「他负责某事」，而那正是 61 条越界里最常见的形状。
 *
 * ## ★ 顺带拦住「引用了这一批里没有的东西」
 *
 * 实测另有 17 个证据 id 在 messages / documents / minutes 三张表里都查不到
 * （形如 `0mp0iypjcc…`）。**那些不是模型编的** —— 整个 `0mp0*` 时段在库里
 * 是 0 行，也就是它们是写入之后被 `purge-scope` 删掉的（用户收窄了采集范围）。
 * 所以那 17 条是「证据已随语料被清掉」，是一个正常状态。
 *
 * 但这道守卫仍然要拦「引用了这一批里没有的 id」，理由与
 * `resolveEvidence` 只校验序号范围是互补的：那一道保证序号落在批次内，
 * 这一道保证**映射回的 id 真的在喂给模型的那批语料里**。两道都在的时候，
 * 「模型编一个来源」这件事才没有缝可钻 —— 而这一层的证据机制存在的
 * 全部意义就是那个来源能被回验（同 `assertHasEvidence` 那条）。
 */
export type SelfAttributionVerdict =
  | { ok: true }
  | { ok: false; reason: "unknown_evidence" | "no_self_evidence" | "foreign_evidence" }

/**
 * 只需要 `is_self` —— 传整个 `MessageRow` 会让这个函数依赖 store 的类型，
 * 而它是纯判据。`undefined` = 这个 id 在语料里查不到（编造的）。
 */
export type EvidenceAuthorship = ReadonlyMap<string, boolean | null>

/**
 * 要求**全部**证据都是本人的那几个 facet。
 *
 * 不含 `tasks` —— 见上面的分档说明。`routines` 是统计型的，
 * 它的证据是本人消息的集合（`stats.ts` 自己保证），不走这里。
 */
const SELF_ONLY_FACETS: ReadonlySet<string> = new Set(["role", "workflow", "artifacts", "knowhow"])

export function assertSelfAttributed(
  candidate: FacetCandidate,
  authorship: EvidenceAuthorship,
): SelfAttributionVerdict {
  /**
   * 空判据时放行（与 `assertDeidentified` 同一个约定）：调用方没给语料
   * 就没法判断，而在这里硬拒会让所有单测都要构造一张表。
   * 生产路径由 runner 保证一定给（它手里就是那批 `accepted`）。
   */
  if (authorship.size === 0) return { ok: true }

  let selfCount = 0
  let foreignCount = 0
  for (const id of candidate.evidence) {
    if (!authorship.has(id)) {
      // ★ 引用了这一批语料里没有的 id：整条作废。见函数注释最后一节。
      return { ok: false, reason: "unknown_evidence" }
    }
    const isSelf = authorship.get(id)
    if (isSelf === true) selfCount += 1
    else foreignCount += 1
  }

  if (selfCount === 0) return { ok: false, reason: "no_self_evidence" }
  if (foreignCount > 0 && SELF_ONLY_FACETS.has(candidate.facet)) {
    return { ok: false, reason: "foreign_evidence" }
  }
  return { ok: true }
}

/**
 * 结论正文里**不许出现**的东西 —— 落库前的第二道防线。
 *
 * ## ★★ 为什么 prompt 不够
 *
 * `SYSTEM_PROMPT` 第 8 条已经要求脱敏（人名换角色、内部系统名换中性描述）。
 * 但实测第一版跑出的 59 条结论里**有 5 条**带着不该出现的内容：一位同事的
 * 真实花名（原话引用「我明天让某某看下」）、内部监控系统名、两个第三方产品名、
 * 以及渠道 CLI 的具体命令。
 *
 * 模型会漏。而这一层的产物（`work.md`）进 agent 的 skill 包，而 skill 包
 * **会被导出、分享、进 git** —— 真实人名与内部系统名一旦进去就不可撤回
 * （fork / 镜像 / CI 日志都留存）。所以要两道：prompt 让绝大多数一次做对，
 * 守卫兜住剩下的。与 `check:no-local-data` 那道门禁是同一个思路
 * （那条也不信"记得脱敏"，而是拿真值去比对）。
 *
 * ## ★ 判据必须由**调用方**给，不能写死在这里
 *
 * 这个包不知道谁是同事、公司叫什么。写死一张名单等于换个用户就失效，
 * 而失效的表现是静默的（守卫恒放行）。所以真实姓名由宿主从
 * `channel_self_identity` / `people` 传进来，商标名单由宿主给。
 */
export interface DeidentifyRules {
  /**
   * 不许出现的字面量（真实姓名、公司名、内部系统名、第三方商标）。
   *
   * ★ 太短的会误伤（两个字的中文名撞上普通词，见
   * `scripts/check-no-local-data.mjs` 的 `CJK_NAME_MIN_LENGTH` 那段长注释）。
   * 所以调用方**必须**自己过滤长度 —— 这一层不猜。
   */
  forbidden: readonly string[]
}

/** 一条结论的脱敏检查结果。`hits` 非空 = 该丢掉它。 */
export interface DeidentifyVerdict {
  ok: boolean
  /** 命中的字面量。**不进日志**（那是真实姓名），只用于本地判断与计数。 */
  hits: readonly string[]
}

/**
 * 结论正文里有没有不该出现的东西。
 *
 * ★ 返回判定而不是抛错：一条命中的结论应当被**丢掉并计数**，而不是让整个
 * 任务失败。整任务失败会连坐同一批里合格的结论，而那些是花了钱抽出来的。
 *
 * ★ 检查 `value` 的**序列化形式**：`tasks` 的 value 是对象
 * （`{task, from, trigger, askKind}`），人名可能藏在任何一个字段里。
 * 只查 `value.task` 会漏掉 `from`，而 `from` 恰好是最可能出现人名的字段。
 */
export function assertDeidentified(
  candidate: FacetCandidate,
  rules: DeidentifyRules,
): DeidentifyVerdict {
  if (rules.forbidden.length === 0) return { ok: true, hits: [] }
  const haystack = (
    typeof candidate.value === "string" ? candidate.value : JSON.stringify(candidate.value ?? "")
  ).toLowerCase()
  const hits = rules.forbidden.filter(
    (term) => term !== "" && haystack.includes(term.toLowerCase()),
  )
  return { ok: hits.length === 0, hits }
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
