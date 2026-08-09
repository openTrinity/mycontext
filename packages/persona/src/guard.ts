/**
 * ③ guard —— **唯一决策点**。
 *
 * ## 这一层回答一个问题：这条回复能不能以本人身份发出去
 *
 * 现在这个问题的答案散在七处：`admit()` 判 kill switch、`evaluatePolicy`
 * 再判一次、`SendGuard` 第三次；"本人已回"判三次且判据不同；内容审查散在
 * `bannedPhrases` / `evaluateScene` / `persona.py check` 三处；长度上限有
 * 两个值（60 / 300）。于是"为什么这条没发"要在四个文件里拼。
 *
 * 收进这里之后那个问题只有一个答案。
 *
 * ## ★ 政策与测量分离（这一层存在的根本理由）
 *
 * forge 现在同时输出测量与政策，而政策那半与"蒸馏一个人的聊天记录"无关：
 * `signals.json` 的 `alwaysDraftKinds` 是一个**硬编码常量**
 * （`["decision_request", "approval_or_commit"]`），`decide.py` 拿它无条件
 * 把 `defaultAction` 压成 `draft_gated` —— 注释原话是「no matter how
 * reliably the owner answers it in person」。那条规则**与测量结果无关**，
 * 它是一条企业级安全策略被塞进了测量引擎。
 *
 * 安全管控该由**企业要求或用户配置**决定，不该由"这个人过去怎么聊天"决定。
 * 所以：forge 给测量（`MessageClassification` / `RecipientTraits`），
 * 这一层给政策（`GuardPolicy`）。
 *
 * 一句话：**forge 说"他 92% 会答这类问题"，guard 说"92% 不等于可以替他答"**。
 * 后半句正是 forge 自己写下的话（`compose.py`：a rate is evidence, not
 * permission），只是它把执行放在了自己那边。
 *
 * ## ★ 这一层**没有** LLM
 *
 * `check` / `fresh` 是子进程，但 `persona.py` 是**零模型调用的纯 stdlib
 * Python**。所以"管控层不含 LLM、智能只在叶子"这条既有原则不破。
 *
 * ## ★ 为什么正则不搬到 TS
 *
 * `classification` 由 forge 算好给，这一层**不自己跑正则**。理由不是省事：
 * `rules.json` 里的正则是从 locale pack 原样搬来的 Python 正则，今天恰好
 * 都是基础组（JS 能编译），但上游哪天加一个 `(?i)` 或后行断言，TS 那份
 * 就会**静默匹配失败** —— 而失败形态是"风险类检测不出来 → 该拦的没拦"。
 */
import type { Clock, Logger } from "@mycontext/kernel"
import type {
  GuardPolicy,
  MessageClassification,
  RecipientTraits,
  SendDecision,
  TraitCoverage,
  TurnFreshness,
  TurnRequest,
  ReplyProposal,
} from "./contracts.js"
import {
  evaluatePolicy,
  UNEVALUATED_CONFIDENCE,
  type DecisionReason,
  type PolicyCondition,
  type RateLimit,
  type WorkHours,
} from "./policy.js"
import { evaluateScene, riskFromScene } from "./scene.js"

/**
 * 内置默认政策。**保守档**。
 *
 * `alwaysReviewAskKinds` 与 forge 的 `signals.json:propensity.alwaysDraftKinds`
 * 逐字一致 —— 那两个值本来就是政策，搬过来是**换归属而不是换取值**，
 * 所以第 2 步的行为必须完全不变。
 */
export const DEFAULT_ALWAYS_REVIEW_ASK_KINDS = ["decision_request", "approval_or_commit"] as const

/**
 * 起草层的判定动作。与 forge `decide_action` 的取值域一致。
 *
 * ★ rank 表决定「只能收紧，不能放宽」：`downgrade()` 只在目标 rank **更大**
 * 时才改动作。这条不变量比任何一条具体规则都重要 —— 缺了它，一条宽松的
 * 规则会撤销前面所有严格的判定。
 */
const ACTION_RANK: Record<string, number> = {
  reply: 0,
  answer: 0,
  settle_ok: 0,
  handoff: 1,
  draft: 2,
  draft_gated: 2,
  silent: 3,
}

export type GateAction = "reply" | "handoff" | "draft" | "silent"

export interface GateVerdict {
  action: GateAction
  /** 命中的每一条规则（人话）。这是"为什么要你看一眼"唯一可信的来源。 */
  because: string[]
  /**
   * **决定了最终动作**的那一条理由。
   *
   * ## ★ 为什么不能用 `because[0]`
   *
   * `because[0]` 永远是那行**分类记录**（"measured default for `other_ask`
   * is answer"）—— 它记的是"我们量出这类问题的默认动作是啥"，而不是
   * "为什么拦住了这一条"。拿它当原因给用户看，会得到一句自相矛盾的话：
   * 草稿卡上写着「默认动作是 answer」，而这条恰恰没有 answer。
   *
   * 实测踩到过（这一版改出来的）：一条纯客套走 silent，`decision_reason`
   * 记的却是 "measured default for `other_ask` is answer"。
   *
   * 所以单独记下**最后一次真正改变动作**的那条 —— 它才回答"为什么"。
   * 没有任何降级时（一路 reply）为 null。
   */
  decidingReason: string | null
}

/**
 * forge 给的**建议**默认动作（`rules.json → policy.byAskKind`）。
 *
 * ## ★ 为什么叫「建议」而不是「判定」
 *
 * `byAskKind` 发布出来时**已经是政策结论**了（`decide.py:_propensity` 把
 * 测出来的答复率折成一个动作，中间还套了 `alwaysDraftKinds` 那条硬规则）。
 * 原始的 `answerRatePct` / `n` / `evidenceSufficient` **不在** `rules.json`
 * 里 —— 它们在 `<forgeRoot>/derived/features.json`。
 *
 * 所以这一层拿 `byAskKind` 当**起点**，然后用自己的政策覆盖。这是过渡形态
 * （文档 4.4 的 B 方案）：改动小、可与 Python 侧逐条对照。等对照跑稳，
 * 再评估直接读 `features.json` 自己套政策（A 方案）。
 *
 * ★ 这一段必须写清楚，否则下一个人会以为 `byAskKind` 是测量。
 */
export interface ForgeAdvice {
  byAskKind: Readonly<Record<string, string>>
  defaultAction: string
  /** 证据不足的问题类型（forge 按 `minSupport` 判的，是测量元数据）。 */
  thinAskKinds: readonly string[]
  /**
   * 产物**发布的**「永远该人工」名单。
   *
   * ★ 与 `GuardPolicy.alwaysReviewAskKinds` 取**并集**，不是二选一：
   * 政策的真源在 host，但产物可能发布一份更长的名单，而那些多出来的类型
   * 忽略掉的方向是危险的那一侧。host 的政策是**下界** —— 产物只能让它更严。
   */
  alwaysDraftKinds: readonly string[]
  /** 每个 band 的 `autoAnswer` 档位（`BAND_GUIDANCE` 的发布形态）。 */
  bands: Readonly<Record<string, { autoAnswer: string }>>
}

/**
 * 起草判定：把 forge 的**测量**套上我们的**政策**，得出「这一轮能不能自己回」。
 *
 * ## ★ 这是 `persona.py decide_action` 的 TS 版，逐条对齐
 *
 * 12 条降级原样搬过来（顺序、rank 表、reason 措辞全部保留），只有一条变化：
 * **第 12 条（`autonomy.scope === "draft_only"`）删掉了**。
 *
 * 那一条问的是"用户有没有授权自动发送"，而 host 侧本来就有更清晰的入口
 * （`replyMode === "auto"`，那是用户的显式选择）。两处表达同一件事的结果是
 * `forge.service.ts` 硬写 `draft_only` → `persona.py` 每轮 downgrade →
 * host 用 `includes("autonomy scope is draft_only")` 按**英文原文**把它顶回来。
 * 上游改一个词，自动发送就静默全失效。
 *
 * 删掉它之后 `isScopeOnlyDowngrade()` 那个补丁函数整个消失，而授权由
 * `GuardPolicy.replyMode` 唯一表达。
 *
 * ## 为什么保留 `because`
 *
 * 它是给用户看的那句人话（"risk class `commitment` — never settled by the
 * owner alone"）。只记一个 `agent_requires_review` 的话，用户看到的是一个
 * code，而他需要判断的是"这条该不该我自己看"。
 */
export function evaluateGate(input: {
  classification: MessageClassification
  recipient: RecipientTraits
  coverage: TraitCoverage
  advice: ForgeAdvice
  policy: GuardPolicy
}): GateVerdict {
  const { classification: cls, recipient, coverage, advice, policy } = input
  const because: string[] = []
  /** 决定了最终动作的那条理由。见 `GateVerdict.decidingReason`。 */
  let decidingReason: string | null = null
  const askKind = cls.askKind ?? ""

  /**
   * 起点：forge 建议的动作。
   *
   * ★ 与 Python 侧一致，**先记一行分类记录**（"我们量出这类问题的默认动作
   * 是啥"）。它不是 downgrade —— `isScopeOnlyDowngrade` 当年要把这两类分开
   * 就是因为混在一起没法判断"到底有没有别的理由拦它"。
   */
  let action = askKind in advice.byAskKind ? advice.byAskKind[askKind] : advice.defaultAction
  if (askKind in advice.byAskKind) {
    because.push(`measured default for \`${askKind}\` is ${String(action)}`)
  } else {
    because.push("ask kind not in the measured table — defaulting to draft")
  }

  /**
   * 只降不升。见 `ACTION_RANK`。
   *
   * ★ 同时记下"**这一条真的改变了动作**"—— 那才是 `decidingReason`。
   * 只把每条理由塞进 `because` 的话，"为什么拦的"就只能靠猜第一条，
   * 而第一条永远是分类记录（见 `GateVerdict.decidingReason`）。
   */
  const downgrade = (to: string, why: string): void => {
    if ((ACTION_RANK[to] ?? 2) > (ACTION_RANK[action ?? "draft"] ?? 2)) {
      action = to
      decidingReason = why
    }
    because.push(why)
  }

  // ① rules.json 整个读不出来 —— fail closed
  if (coverage.unavailable !== null) {
    /**
     * ★ `onUnavailable` 的类型是字面量 `"review"` —— 也就是「判定不可得时
     * 只能出草稿」这件事**在类型层就不可配**。写成配置项是为了让它出现在
     * `GuardPolicy` 里（读那个类型的人应当看到这条规则存在），
     * 而把取值域锁成一个值是为了让"某天有人把它配成 allow"不可能发生。
     */
    void policy.onUnavailable
    downgrade(
      "draft",
      `rules.json unusable (${coverage.unavailable}) — nothing can be verified, so draft only`,
    )
  }
  // ② 这个 build 判不了"在问什么"
  if (!cls.askKindDetectable) {
    downgrade("draft", "this build cannot classify what is being asked")
  }
  // ③ 判不了"是拍板还是转手"
  if (!coverage.replyShapes) {
    downgrade("draft", "this build cannot tell a settle from a handoff")
  }
  /**
   * ④ ★ 政策：这类问题永远要人看。
   *
   * ★★ 取 host 政策与产物发布名单的**并集** —— host 那份是下界。
   * 只看 host 的话，产物发布一份更长的名单时那些多出来的类型会被静默忽略；
   * 只看产物的话，这条政策就又回到了 forge 手里（这次重构要消除的正是那个）。
   */
  const alwaysReview = new Set([...policy.alwaysReviewAskKinds, ...advice.alwaysDraftKinds])
  if (askKind !== "" && alwaysReview.has(askKind)) {
    downgrade("draft", `\`${askKind}\` is always the owner's call`)
  }
  // ⑤ 证据不足 —— 政策决定这时保守还是放行
  if (askKind !== "" && advice.thinAskKinds.includes(askKind)) {
    if (policy.onInsufficientEvidence === "review") {
      downgrade("draft", `\`${askKind}\` has too few examples to lean on`)
    }
  }
  /**
   * ⑥ ★ 政策：每个命中的风险类都降级。
   *
   * `never_settle` 是测出来的多数情况；一个本人**偶尔**会拍板的类别仍然
   * **不是** agent 可以替他拍板的类别 —— 所以两者 reason 不同而动作相同。
   * 这个细节必须保留：它是"为什么拦我"这句话准不准的关键。
   */
  for (const tag of cls.riskTags) {
    const why =
      policy.riskClassPolicy[tag] === "sometimes_settles"
        ? "sometimes settled by the owner, never by an agent"
        : "never settled by the owner alone"
    downgrade("draft", `risk class \`${tag}\` — ${why}`)
  }
  // ⑦ 没有风险词表 → 排除不了风险
  if (!cls.riskDetectable) {
    downgrade("draft", "no risk lexicon in this build, so risk cannot be ruled out")
  }
  // ⑧ 纯客套且不是真在问事 → 这一轮没什么要答的
  if (cls.chitchat === true && cls.genuineAsk !== true) {
    downgrade("silent", "pure acknowledgement, not an ask")
  }
  // ⑨⑩⑪ 收件人
  if (!recipient.resolved) {
    downgrade("draft", "recipient not resolved by id")
  } else {
    const band = recipient.toneBand ?? "S"
    if (recipient.sensitive) downgrade("draft", "sensitive recipient")
    if (band === "S") {
      downgrade("draft", "tone band S — most conservative handling")
    } else if (advice.bands[band]?.autoAnswer === "manual only") {
      /**
       * ★ 只判 `"manual only"`，**不判** `"draft only"` —— 与 Python 侧逐字一致。
       *
       * band C/D 的 `autoAnswer` 是 `"draft only"`，而 `decide_action` 里
       * 那个分支只比 `"manual only"`，所以 C/D **不会**在这里被降级。
       * 看起来像疏漏，但改它就是改行为 —— 这一步只搬不改。
       * 要收紧的话应当显式加进 `GuardPolicy`，而不是"顺手修一下"。
       */
      downgrade("draft", `band ${band} is manual-only`)
    }
  }
  /**
   * ⑫ **已删除**：`autonomy.scope === "draft_only"`。
   *
   * 见函数头。授权现在由 `GuardPolicy.replyMode` 唯一表达。
   */

  const mapped: Record<string, GateAction> = {
    answer: "reply",
    settle_ok: "reply",
    reply: "reply",
    handoff: "handoff",
    draft: "draft",
    draft_gated: "draft",
    silent: "silent",
  }
  return { action: mapped[action ?? "draft"] ?? "draft", because, decidingReason }
}

/** `check` 的结果（对草稿正文的**测量**，不是判定 —— 见文档 4.5）。 */
export interface DraftReview {
  /**
   * 产物自己的总判定。
   *
   * ★ 必须带上并且**尊重它**：`block` 是 `check` 综合了它全部规则之后的
   * 结论，而我们这边只重新解释了其中三项（风险类 / 长度 / severity）。
   * 只看那三项的话，一条被 `block` 但原因不在这三项里的草稿会被放过去 ——
   * 而"少一道闸"这件事在外观上与一切正常完全一样。
   *
   * 也就是说：这一层对 `check` 的态度是"**它说不行就不行**，它说行我们
   * 再自己看一遍"。这与 `holdForReview` 的语义一致 —— 只能收紧。
   */
  verdict: "block" | "warn" | "pass"
  /** 草稿正文本身命中的风险类。 */
  riskTags: readonly string[]
  codepoints: number
  /** forge 报的问题（`too_long` / `risk_in_draft` / `never_write` / …）。 */
  problems: readonly { kind: string; severity: string; detail: string }[]
  /** 给用户看的那几句话（`block` 时用来解释为什么被挡）。 */
  issues: readonly string[]
}

/** `fresh` 独有的那一条：采集滞后超阈值。其余两条由 intake 给。 */
export interface LagVerdict {
  stale: boolean
  reason: string | null
}

export interface GuardOptions {
  clock: Clock
  logger: Logger
}

/** 运行期从库里读的那几样（工作时间 / 频率 / 禁止词 / 授权 / 急停）。 */
export interface RuntimeGates {
  workHours: WorkHours
  rateLimit: RateLimit
  bannedPhrases: readonly string[]
  recentSendsInConversation: readonly number[]
  recentSendsGlobal: readonly number[]
  killSwitchActive: boolean
  grant: { expiresAt: number | null; revokedAt: number | null } | null
}

/**
 * 唯一决策点。
 *
 * 输入是**事实**（TurnRequest 的语境 + ReplyProposal 的正文 + forge 的测量
 * + 库里的运行期状态），输出是一个 `SendDecision`。这个类**不查库、不起进程**
 * —— 那些由调用方（接线层）准备好传进来，为的是让它 100% 可穷举单测。
 */
export class PersonaGuard {
  constructor(private readonly options: GuardOptions) {}

  /**
   * 判这一轮。
   *
   * ## 顺序
   *
   * ① 起草判定（`evaluateGate`）—— 这一轮该不该由 agent 回；
   * ② 模型自己的刹车（只能收紧）；
   * ③ 草稿正文复核（`check` 的测量 + 我们的场景规则 + 禁止词）；
   * ④ 新鲜度（intake 的两条 + `fresh` 独有的滞后那条）；
   * ⑤ `evaluatePolicy` 的九条（模式 / 工作时间 / 频率 / 授权 / 急停 / …）。
   *
   * ★ 空正文在 ③ 之前就短路成 `drop`：没有正文时后面每一条都在判一个
   * 不存在的东西，而那些 reason 会误导排查。
   */
  decide(input: {
    turn: TurnRequest
    proposal: ReplyProposal
    gate: GateVerdict | null
    review: DraftReview | null
    lag: LagVerdict | null
    policy: GuardPolicy
    runtime: RuntimeGates
  }): SendDecision {
    const { turn, proposal, gate, review, lag, policy, runtime } = input
    const reasons: DecisionReason[] = []
    const failedConditions: PolicyCondition[] = []
    let humanReason: string | null = null

    /**
     * ★ 判定不可得（`gate === null`）**绝不表示通过**。
     *
     * 缺 Python、还没蒸馏过、脚本输出读不懂 —— 全都是 null，全都要 fail
     * closed。把它当通过会让"没装 Python"变成"自动发送全放行"，
     * 而那个错误在界面上与一切正常完全一样。
     */
    const gateAllowsAuto = gate !== null && gate.action === "reply"
    if (gate === null) {
      humanReason = "review_gate_unavailable"
    } else if (!gateAllowsAuto) {
      humanReason = gate.because[0]?.trim().slice(0, 160) ?? `gate_${gate.action}`
    }

    /**
     * 判定层说这一轮没什么要答的 → `drop`。
     *
     * 这与"生成失败"必须分开记：前者是正常工作，后者要修。
     */
    if (gate !== null && gate.action === "silent") {
      return {
        action: "drop",
        primaryReason: null,
        allReasons: [],
        detail: { failedConditions: [], failedSceneRules: [], humanReason },
      }
    }

    // 没有正文 → 无从判断"发什么"。短路，避免后面每条都在判一个不存在的东西。
    const text = proposal.text ?? ""
    if (text.trim() === "") {
      return {
        action: "drop",
        primaryReason: null,
        allReasons: [],
        detail: {
          failedConditions: [],
          failedSceneRules: [],
          humanReason: proposal.noReplyReason ?? humanReason,
        },
      }
    }

    /**
     * ② 模型只能收紧，不能放宽。
     *
     * `gate` 是判定层的结论，`proposal.holdForReview` 是模型自己的刹车。
     * 两者**或**起来：模型说要人看就一定要人看，而模型说不用并不能让
     * 判定层的 draft 变成 reply。产物 SKILL.md 里写着同一句话
     * （「`false` grants nothing」）。
     */
    let holdForReview = !gateAllowsAuto || proposal.holdForReview
    if (proposal.holdForReview && humanReason === null) humanReason = proposal.reviewReason

    /**
     * ③ 草稿正文复核。三条判据**并列**，失效原因互不相关：
     *
     * · `review`（forge 的 check）—— 按这个人的实测习惯 + 风险词表；
     * · `scene`（我们的确定性白名单）—— 不许有问号 / 不许含承诺 / 长度；
     * · `bannedPhrases`（用户自己配的词）。
     *
     * forge 没蒸出风险词表时 check 会放行，而 scene 的五条仍然拦得住 ——
     * 这才是"纵深"的意思。
     */
    if (review === null) {
      // 判定不可得 → 要人看（与 gate 的 null 同一口径）
      holdForReview = true
      humanReason ??= "review_gate_unavailable"
    } else {
      /**
       * ★ 产物说 `block` 就是 block —— 先尊重它的总判定，再自己看细项。
       *
       * 漏了这一步的表现：一条被 `check` 挡下、但原因不在我们重新解释的
       * 那三项里的草稿会被放过去。而"少一道闸"在外观上与一切正常一样。
       * `issues[0]` 是给用户看的那句话（"states a commitment"）。
       */
      if (review.verdict === "block") {
        holdForReview = true
        humanReason ??= review.issues[0] ?? "draft_review_blocked"
      }
      if (review.riskTags.length > 0) {
        holdForReview = true
        humanReason ??= `draft states a decision on ${review.riskTags.join(", ")}`
      }
      if (review.codepoints > policy.maxAutoSendCodepoints) {
        holdForReview = true
        humanReason ??= `${String(review.codepoints)} characters, over the ${String(
          policy.maxAutoSendCodepoints,
        )} send limit`
      }
      const blocked = review.problems.find((problem) => problem.severity === "block")
      if (blocked !== undefined) {
        holdForReview = true
        humanReason ??= blocked.detail
      }
    }

    const scene = evaluateScene({
      conversationKind: turn.conversationKind,
      mentionsSelf: turn.mentionsSelf,
      // ★ 判的是"我们准备说的这句话"，不是"别人说的那句"
      draftText: text,
    })

    /**
     * ④ 新鲜度。三条判据，**来源不同**：
     *
     * · 本人已回 / 有更新消息 —— intake 算好放在 `TurnRequest.freshness`
     *   （原来这两条各判了三遍且判据不一致，见 intake 的注释）；
     * · 采集滞后 —— 只有 `fresh` 判得了（阈值在 `rules.json` 里，
     *   host 抄一份就又是一个"两个真源"）。
     *
     * ★ 这三条**只挡自动发，不丢草稿**。"你已经回过了"不代表这条草稿没
     * 价值（可能想补一句、换个说法）—— 那是曾经把已跑完、已花钱的产出
     * 整个扔掉的老行为。
     */
    const freshnessBlocks = this.freshnessBlocksAutoSend(turn.freshness, lag)

    /**
     * ⑤ policy 的九条。走真正的 `evaluatePolicy`，不自己判一遍。
     *
     * `confidence` 传哨兵：我们**没有**自评机制，而一个编出来的分数会让
     * "为什么当时判了能发"事后无法审计。把关交给场景判定（确定性、可枚举）。
     */
    const verdict = evaluatePolicy(
      {
        replyMode: policy.replyMode,
        sceneAllowsAuto: scene.allowsAuto,
        agentAllowsAuto: !holdForReview,
        confidence: UNEVALUATED_CONFIDENCE,
        risk: riskFromScene(scene),
        bannedPhraseHits: runtime.bannedPhrases.filter((phrase) => text.includes(phrase)),
        recentSendsInConversation: runtime.recentSendsInConversation,
        recentSendsGlobal: runtime.recentSendsGlobal,
        killSwitchActive: runtime.killSwitchActive,
        grant: runtime.grant,
        dryRun: false,
        workHours: runtime.workHours,
        rateLimit: runtime.rateLimit,
      },
      this.options.clock,
    )
    reasons.push(...(verdict.reason === null ? [] : [verdict.reason]))
    failedConditions.push(...verdict.failedConditions)

    /**
     * ★ `yolo` 旁路那两关（已回过 / 新鲜度）。
     *
     * 它们不在 `evaluatePolicy` 里，所以 policy 的 yolo 旁路管不到 ——
     * 漏了这一步的表现是"选了 yolo 还是在出草稿"，而那正是用户加这一档
     * 要摆脱的东西。跳过的代价要说清：可能回一条已经被后续消息盖过的话。
     */
    const yolo = policy.replyMode === "yolo"
    const canSend = verdict.decision === "auto_sent" && (yolo || !freshnessBlocks.blocked)

    /**
     * ★ 新鲜度挡住时，`primaryReason` 说的是**新鲜度**，而不是 policy 那边
     * 顺带记下的 `agent_requires_review`。
     *
     * 这两个 reason 指向完全不同的下一步：`not_fresh` 是"这条已经过时了，
     * 你可能想自己看一眼要不要补发"，而 `agent_requires_review` 是
     * "判定层觉得该你拍板"。记错的表现是用户去改一个改不了的东西。
     *
     * ## ★★ 但 `humanReason` 用 `??=`：判定闸的原因**优先**
     *
     * 顺序不能反。`review_gate_unavailable`（缺 Python / 没蒸馏过）比
     * "这条不新鲜了"更**根本** —— 前者说明整个判定层没在工作，是用户
     * 真正要去修的东西；后者只是这一轮的时序。
     *
     * 实测踩到过（这一版）：gate 为 null 时草稿卡上写的是 `freshness_unknown`
     * —— 那会让用户去查采集滞后，而真正的问题是判定层压根没跑起来。
     */
    if (!canSend && !yolo && freshnessBlocks.blocked) {
      // ★ `??=`：已经有更根本的原因（判定闸不可得 / 模型刹车）就不覆盖它
      humanReason ??= freshnessBlocks.reason
      return {
        action: "draft",
        primaryReason: freshnessBlocks.code,
        allReasons: [
          ...new Set([
            ...(freshnessBlocks.code === null ? [] : [freshnessBlocks.code]),
            ...reasons,
          ]),
        ],
        detail: {
          failedConditions,
          failedSceneRules: scene.failedRules,
          humanReason,
        },
      }
    }

    return {
      action: canSend ? "send" : "draft",
      primaryReason: canSend
        ? null
        : (reasons[0] ?? freshnessBlocks.code ?? "agent_requires_review"),
      allReasons: canSend
        ? []
        : [
            ...new Set([
              ...reasons,
              ...(freshnessBlocks.code === null ? [] : [freshnessBlocks.code]),
            ]),
          ],
      detail: { failedConditions, failedSceneRules: scene.failedRules, humanReason },
    }
  }

  /**
   * 新鲜度是否挡住自动发送。
   *
   * ## ★ 滞后那一关**由 `fresh` 子进程判**，不在这里
   *
   * `TurnFreshness.collectionLagMs` 是 intake 算好的**事实**，而阈值比较在
   * `fresh` 那边（`rules.json` 的 `freshness.maxLagSeconds` /
   * `unknownLagIsStale`）—— host 抄一份阈值就又是一个"两个真源"。
   *
   * 所以这个方法**不读** `collectionLagMs`：它读 `lag`（那次判定的结论）。
   * `lag === null`（判定跑不成）按不安全处理，与
   * `unknownLagIsStale` 同一口径 —— 把"完全不知道"当成"恰好完全同步"，
   * 正是在最要紧的那一刻让两者长得一样。
   *
   * ★ 早先这里的注释写的是"`collectionLagMs === null` 按不安全处理"，
   * 而这个方法从来没读过那个字段 —— 行为是安全的（`lag === null` 挡住了），
   * 但那句话会让下一个人以为有一道 host 侧的滞后闸。已改正。
   *
   * ## ★ `code` 为什么不是 `DecisionReason`
   *
   * `DECISION_REASONS` 是 **policy 那九条**的闭合 union，而新鲜度不在
   * policy 里（它由 intake 的事实 + `fresh` 的滞后判定合成）。硬塞进去
   * 会破坏 `CONDITION_TO_REASON` 那张表的意义 —— 那张表的价值就是
   * "新增一个 policy 条件而忘配 reason 就编译错误"，混进非 policy 的取值
   * 会让这个口径变糊（`dry_run` / `yolo` 当年为此刻意留在表外）。
   *
   * 所以用一组**独立**的 code。它们照样落进 `dh_runs.decision_reason`
   * （那一列是 TEXT，本来就存人话），而 UI 的 `decision-reason.ts` 按
   * 未登记值原样显示 —— 显示一个陌生的枚举串仍然好过显示一句错话。
   */
  private freshnessBlocksAutoSend(
    freshness: TurnFreshness,
    lag: LagVerdict | null,
  ): { blocked: boolean; code: FreshnessBlockCode | null; reason: string | null } {
    /**
     * ★ 本人已回 → 不自动发，但**草稿照样落**。
     *
     * "你已经回过了"不代表这条草稿没价值（可能想补一句、换个说法）——
     * 曾经这里把已跑完、已花钱的产出整个扔掉，用户永远看不到它。
     */
    if (freshness.ownerRepliedAfter) {
      return { blocked: true, code: "already_answered", reason: "already_answered" }
    }
    if (freshness.newerInboundArrived) {
      return {
        blocked: true,
        code: "not_fresh",
        reason: "superseded_by_newer_message",
      }
    }
    /**
     * 判定不可得 → **不发**。这是唯一直接挡在真发送前面的一关，
     * 读不懂输出就不该往下走。
     */
    if (lag === null) {
      return { blocked: true, code: "not_fresh", reason: "freshness_unknown" }
    }
    if (lag.stale) {
      return { blocked: true, code: "not_fresh", reason: lag.reason ?? "stale" }
    }
    return { blocked: false, code: null, reason: null }
  }
}

/**
 * 新鲜度挡下来的原因码。
 *
 * 两个值分开是刻意的：`already_answered` 是**预期行为**（本人自己回了，
 * 不需要修任何东西），`not_fresh` 指向"这条已经过时/库落后了"。
 * 合成一个会让前者出现在"为什么功能不工作"的排查列表里。
 */
export type FreshnessBlockCode = "already_answered" | "not_fresh"

/** 缺省政策（保守档）。 */
export function defaultGuardPolicy(replyMode: GuardPolicy["replyMode"]): GuardPolicy {
  return {
    replyMode,
    alwaysReviewAskKinds: [...DEFAULT_ALWAYS_REVIEW_ASK_KINDS],
    riskClassPolicy: {},
    onInsufficientEvidence: "review",
    onUnavailable: "review",
    /**
     * ★ 长度上限统一到一个值。
     *
     * 原来有两个：`MAX_AUTO_LENGTH = 60`（scene.ts，按本人语料 94.6% 分位定的）
     * 与 `maxCodepoints = 300`（forge 配置的硬上限）。两个值判同一件事，
     * 而"哪个生效"取决于走到哪条路 —— 那是最难查的那类不一致。
     *
     * 取 300 作为**这一层**的上限：scene 的 60 仍然独立生效（它是
     * "这类场景适不适合自动"的一部分），而这里是"正文本身超没超硬上限"。
     * 两者语义不同，所以不合并成一个数 —— 但各自只有一处定义。
     */
    maxAutoSendCodepoints: 300,
  }
}
