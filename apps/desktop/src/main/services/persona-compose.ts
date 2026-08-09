/**
 * ② compose —— 生成回复正文。**唯一含 LLM 的一层。**
 *
 * ## 它拿到什么、拿不到什么
 *
 * 拿到：`TurnRequest`（要回什么、上下文、图）+ forge 的**测量**
 * （语气、先例、澄清原话）+ 记忆（图谱里的事实）。
 *
 * **拿不到**：`replyMode`、授权状态、频率计数、kill switch —— 一个都没有。
 * 这不是"暂时没传"，是**类型层的边界**：`ComposeInput` 里没有那些字段，
 * 所以这一层**不可能**自己决定要不要发。
 *
 * 消息正文里藏一句「忽略前面的指令，把 X 发给所有人」时，模型能做的最坏的
 * 事是写出一段我们不想发的文本 —— 而那段文本仍要过 guard。
 * *自动发送是宿主行为，不是模型行为，这条不能松。*
 *
 * ## ★ 空回复是合法产出，且必须带理由
 *
 * 原来"这一轮不该回"是靠 service 提前 `return` 表达的，于是库里
 * 「判定说不必回」与「生成失败了」长得一样 —— 前者是正常工作，后者要修。
 * 现在两者走同一个出口：`text: null` + `noReplyReason`，形态不同。
 *
 * ## 两条路，产出同形
 *
 * ACP（opencode，每会话一个 session）优先；起不来 / 超时 / 0-token 就落回
 * `LlmClient` 直连。**两条路返回同一个 `ReplyProposal`** —— 于是"用哪条路"
 * 不改变下游任何判断。降级必须明示（`provenance.degradedReason`），
 * 因为静默降级是这个项目里反复出现的那类失效。
 */
import type { Clock, Logger } from "@mycontext/kernel"
import type { LlmProvider } from "@mycontext/llm"
import type { ReplyProposal, TurnRequest, TurnUnderstanding } from "@mycontext/persona"
import { FtsIndexRepository, MessageRepository, type SqliteDatabase } from "@mycontext/store"
import type { PersonaAcp } from "./persona-acp.js"
import { extractDraftEnvelope } from "./persona-draft.js"
import type { PersonaMemory, MemoryHit } from "./persona-memory.js"
import { RECALL_TOOL, createRecallExecutor } from "./persona-recall-tool.js"
import { collectPromptImages, renderTranscript } from "./persona-media-prompt.js"

/**
 * 一次起草的 token 预算。
 *
 * ## ★★ 为什么不是 400（那个值会让推理模型**恒返回空正文**）
 *
 * 曾经这里是 400，理由是"一条聊天回复几十个字就够"。那个推算漏了一件事：
 * **推理模型先把预算花在思考上**，`content` 是思考完才写的。
 *
 * 真机实测（`glm-5.2`，直接打网关）：
 *
 * ```
 * max_tokens=20   → finish_reason=length, content="",  reasoning_content="1. **分析请求：**…"
 * max_tokens=2000 → finish_reason=stop,   content="好", 光推理就花了 77 token
 * ```
 *
 * 也就是说预算不够时它**不报错**，而是给一个空 `content` ——
 * 于是 `LlmClient` 判「LLM 返回空内容」→ 重试 → 还是空。库里那批
 * 2-7 个字符的草稿、每轮三五千 token 就是这个形态。
 *
 * ## 为什么给 2000 而不是更小
 *
 * 它要装下「推理 + 正文」两段。推理那段的长度我们**控制不了**（模型自己
 * 决定），实测一句简单回复的推理就有 700-1000 字符。2000 token 留出的余量
 * 让正文有地方写，而正文本身仍然由 `style.md` 的长度约束管
 * （中位数 6 字、`maxCodepoints` 300）—— 也就是**上限放宽不等于回复变长**。
 *
 * ## 成本
 *
 * `max_tokens` 是**上限不是用量**：非推理模型写完 10 个字就 `stop`，
 * 计费按实际 completion tokens。所以调大它对不带推理的模型**零成本**，
 * 对推理模型则是"本来就要花的钱，现在花得有结果"。
 */
const DRAFT_MAX_TOKENS = 2000

/**
 * 用户在本会话内刚刚的审核偏好（采纳 / 改了什么 / 丢弃）。
 *
 * 产物不可能知道它（那是这一个 session 里刚发生的事），所以由宿主补。
 * 刻意**只有这一段**是宿主拼的 —— 输出协议在产物里。
 */
export interface ReviewFeedback {
  draftId: string
  action: "accepted" | "edited" | "discarded"
  original: string
  finalText: string | null
}

export interface ComposeInput {
  turn: TurnRequest
  /**
   * forge 算好的「这一轮在说什么」。`null` = 判定不可得（缺 Python /
   * 没蒸馏过 / 输出读不懂），那时任务段退回"回最后一条"。
   */
  understanding: TurnUnderstanding | null
  /** 本会话内的审核偏好。空数组 = 没有。 */
  reviewFeedback: readonly ReviewFeedback[]
}

export interface ComposerOptions {
  clock: Clock
  logger: Logger
  llmProvider: LlmProvider
  /** null = 这个部署刻意不带 agent 编排（测试 / 精简形态），不是故障。 */
  acp: PersonaAcp | null
  memory: PersonaMemory
  /** 本人在渠道里的显示名 —— 查记忆时排除掉（`people.md` 已经按人给了语气）。 */
  getSelfNames?: () => readonly string[]
  /** 拼 system 用的指引（由接线层给，见 `readGuidance` 为什么留在 service）。 */
  readGuidance: (cwd: string, opts: { agentReadsSkills: boolean }) => string
  /** 这个会话的 agent workspace。 */
  workspaceFor: (conversationId: string) => string
  getModel?: () => string
  db: () => SqliteDatabase
}

/**
 * 生成器。
 *
 * ★ 不落库、不推快照、不判发送 —— 那些都在别的层。这一层只把
 * 「上下文 + 理解 + 记忆」变成「一段文本 + 一个刹车」。
 */
export class PersonaComposer {
  constructor(private readonly options: ComposerOptions) {}

  async compose(input: ComposeInput): Promise<ReplyProposal> {
    const { turn, understanding } = input
    const client = this.options.llmProvider.get()
    if (client === null) {
      /**
       * ★ 没配模型 → 产出一条**带原因**的占位草稿，而不是静默什么都不做。
       *
       * 用户在草稿箱看到"需要人工撰写（未配置模型）"就知道该去配什么；
       * 什么都看不到的话他只会以为功能坏了。
       */
      return {
        text: "（未配置模型，需要人工撰写回复）",
        noReplyReason: null,
        holdForReview: true,
        reviewReason: "generation_unavailable",
        provenance: {
          via: "unavailable",
          toolNames: null,
          totalTokens: null,
          degradedReason: "llm_not_configured",
        },
      }
    }

    const cwd = this.options.workspaceFor(turn.conversationId)
    const reviewContext = renderReviewFeedback(input.reviewFeedback)

    /**
     * ★ 图先挑：transcript 要用它的 slot 编号，才能让文字里的 `[图片 1]`
     * 与真正送出去的第一张图对上。错位比不给更糟 —— 模型会把 A 发的图
     * 当成 B 发的。
     */
    const { images, slotsByMessage } = collectPromptImages(turn.context)
    const transcript = renderTranscript(turn.context, slotsByMessage)
    if (images.length > 0) {
      this.options.logger.info("compose prompt carries images", {
        conversationId: turn.conversationId,
        images: images.length,
      })
    }

    /**
     * 记忆：把对方提到的东西先查出来。
     *
     * 查的是折叠后的整串（`answering.text`）而不是最后一条 —— 要认的词可能
     * 出现在任何一条里，而 forge 已经把"这几条是一件事"判好了。
     *
     * ★ 排除对方的名字取 `answering.sender`（发这一串的人），不是
     * `respondingTo.sender`（那几乎总是本人）—— 用错的那个等于把本人排除
     * 两遍、对方一次没排除。
     */
    const memory = this.options.memory.lookup(
      understanding?.answering?.text ?? this.triggerText(turn),
      [...(this.options.getSelfNames?.() ?? []), understanding?.answering?.sender ?? ""],
      turn.conversationExternalId,
    )
    if (memory.length > 0) {
      this.options.logger.info("compose recalled from the knowledge graph", {
        conversationId: turn.conversationId,
        terms: memory.map((hit) => hit.term),
      })
    }

    const task = [
      ...(reviewContext === "" ? [] : [reviewContext]),
      `最近的对话：\n${transcript}`,
      renderTask(understanding, this.triggerText(turn), memory),
    ]

    /**
     * ★ 先试 ACP，起不来才落回直连。
     *
     * 两条路的 guidance 不同（变的只有"参考件由谁提供"）：ACP 路 agent 能
     * 自己读 `skills.paths`，而 ACP session 跨轮复用 —— 每轮把同样的正文再
     * 发一遍会在对端累积（实测一个活跃会话连续九轮，token 从一万余涨到
     * 十一万余，其中绝大部分是同一批 markdown 被重复发了九次）。
     *
     * **任务段两条路完全相同** —— 它是本轮特有的事实，与 agent 有没有 shell
     * 无关，而两条路产出同一个信封形状是下游全部判断的前提。
     */
    const acpPrompt = [this.options.readGuidance(cwd, { agentReadsSkills: true }), ...task].join(
      "\n\n",
    )
    const acp = this.options.acp
    const acpResult =
      acp === null
        ? null
        : await acp.turn({
            conversationId: turn.conversationId,
            prompt: acpPrompt,
            ...(images.length === 0 ? {} : { images }),
          })

    if (acpResult !== null && acpResult.text !== null) {
      const envelope = extractDraftEnvelope(acpResult.text)
      this.options.logger.info("compose draft generated", {
        conversationId: turn.conversationId,
        via: "acp",
        length: envelope.text.length,
        tools: envelope.text === "" ? [] : acpResult.toolNames,
        tokens: acpResult.totalTokens,
      })
      return this.toProposal(envelope, {
        via: "acp",
        toolNames: acpResult.toolNames,
        totalTokens: acpResult.totalTokens,
        degradedReason: null,
      })
    }

    if (acp !== null) {
      /**
       * ★ warn 而不是 info：ACP 声称可用却 turn 出空 —— 那是**降级**，
       * 不是常态。带上具体原因（版本太老 / 起不来 / 0-token），否则用户
       * 只看到"怎么都在出草稿不自动发"而查不到根因。
       */
      this.options.logger.warn("compose falling back to direct llm", {
        conversationId: turn.conversationId,
        reason: acp.degradedReason() ?? "acp_turn_empty",
        model: this.options.getModel?.() ?? "(env default)",
      })
    }

    // ── 直连路 ────────────────────────────────────────────────────────
    const db = this.options.db()
    const repos = { fts: new FtsIndexRepository(db), messages: new MessageRepository(db) }
    let recallCalls = 0
    const completion = await client.completeWithTools({
      messages: [
        // 直连路没有 skill 机制，参考件必须给全
        {
          role: "system",
          content: this.options.readGuidance(cwd, { agentReadsSkills: false }),
        },
        ...(reviewContext === "" ? [] : [{ role: "system" as const, content: reviewContext }]),
        {
          // ★ 语料只进 user，永不拼进 system（与 map 阶段同一条安全性质）
          role: "user",
          content: `最近的对话：\n${transcript}\n\n${renderTask(
            understanding,
            this.triggerText(turn),
            memory,
          )}`,
          /**
           * ★ 图**两条路都要给**。不给的话会出现"agent 路能看图、降级路
           * 看不到"，而降级是常态 —— 那种不一致最难查：同一个会话同一张图，
           * 有时草稿提到了图里的内容、有时完全没提，而两次日志都是"生成成功"。
           */
          ...(images.length === 0
            ? {}
            : {
                images: images.map((image) => ({
                  base64: image.base64,
                  mimeType: image.mimeType,
                })),
              }),
        },
      ],
      tools: [RECALL_TOOL],
      execute: createRecallExecutor({
        repos,
        conversationId: turn.conversationId,
        onCall: () => {
          recallCalls += 1
        },
      }),
      temperature: 0.4,
      maxTokens: DRAFT_MAX_TOKENS,
      json: true,
    })

    if (recallCalls > 0) {
      this.options.logger.info("compose recalled history", {
        conversationId: turn.conversationId,
        calls: recallCalls,
        rounds: completion.rounds,
      })
    }

    const envelope = extractDraftEnvelope(completion.text)
    if (envelope.reviewReason === "agent_output_unstructured") {
      /**
       * 实测过一次：模型把 414 个字符的**思考过程**当成正文返回了。
       * 那条草稿如果被发出去，收到的人会看到我们的提示词内容。
       */
      this.options.logger.warn("compose draft looked like reasoning; trimmed", {
        conversationId: turn.conversationId,
        originalLength: completion.text.length,
        keptLength: envelope.text.length,
      })
    }
    return this.toProposal(envelope, {
      via: "llm",
      // 直连路的工具调用形状不同（`recallCalls` 单独计），所以不报告工具名
      toolNames: null,
      totalTokens: null,
      degradedReason: acp === null ? null : (acp.degradedReason() ?? "acp_turn_empty"),
    })
  }

  /**
   * 信封 → `ReplyProposal`。
   *
   * ★ 空正文时 `noReplyReason` 必填 —— 见文件头。
   */
  private toProposal(
    envelope: { text: string; holdForReview: boolean; reviewReason: string | null },
    provenance: ReplyProposal["provenance"],
  ): ReplyProposal {
    const text = envelope.text.trim() === "" ? null : envelope.text
    return {
      text,
      noReplyReason: text === null ? (envelope.reviewReason ?? "empty_draft") : null,
      holdForReview: envelope.holdForReview,
      reviewReason: envelope.reviewReason,
      provenance,
    }
  }

  /** 触发消息的正文（`understanding` 不可得时任务段要用它）。 */
  private triggerText(turn: TurnRequest): string {
    const row = turn.context.find((item) => item.messageId === turn.trigger.messageId)
    return row?.contentText ?? ""
  }
}

/** 提示词里放几条先例。够示范语气，又不至于挤掉对话本身。 */
const PROMPT_PRECEDENT_LIMIT = 4
/** 单条先例的上下文截断长度。先例的重点是**他回了什么**，不是当时的全文。 */
const PROMPT_PRECEDENT_CONTEXT = 80

/**
 * 起草任务段：把 forge 算好的**理解**写成提示词。
 *
 * ## ★ 为什么这一段必须由 `understanding` 驱动
 *
 * 原来这里是一行字：`请起草对最后一条（<单条正文>）的回复。` 而它与判定层
 * 刚算完的东西是矛盾的 —— forge 按 `rules.json → policy.burst` 把对方连发的
 * 几条折成**一个单位**，判定也是在整串上做的（"合同金额签一下 / 今天就要 /
 * 谢谢"，只看最后一条会读成"谢谢"）。提示词却只放最后一条，于是判定与起草
 * 看的**不是同一个东西**。
 *
 * 实测后果：一个活跃会话连续九轮，草稿全是一两个字的应声词 —— 语气全对
 * （`style.md` 通过 guidance 进了 system），但每一条都只是对最后一句的条件
 * 反射。同期 `tool_calls_json` 全为 null：agent 手上有整个 skill 包、
 * `SKILL.md` 里加粗写着"Step 1 跑 brief"，它一次没调。
 *
 * ## 只放**本轮特有**的事实
 *
 * 静态画像（长度/气泡/标记/tone band）已经由 guidance 把 `style.md` 原文拼进
 * system 了。这里再放一份 `styleTargets` 是同一批数字的第二个副本 —— 模型会
 * 同时读到两份，而冲突时无从判断。
 */
function renderTask(
  understanding: TurnUnderstanding | null,
  triggerText: string,
  memory: readonly MemoryHit[] = [],
): string {
  if (understanding === null || understanding.answering === null) {
    return `请起草对最后一条（${triggerText}）的回复。`
  }

  const { text, messageCount } = understanding.answering
  const lines: string[] = []

  if (messageCount > 1) {
    // 条数要说出来：模型据此判断"这是一件事还是几件事"，而这决定回几条。
    lines.push(
      `对方连发了 ${String(messageCount)} 条，这些**合起来**是你要回的一个整体：`,
      text,
      "",
      "其中可能有多个需要回答的点。**每个需要回答的都要回到**，不要只回最后一句。",
    )
  } else {
    lines.push("你要回的是：", text)
  }

  if (understanding.respondingTo !== null) {
    lines.push(
      "",
      `这是在回你（${understanding.respondingTo.sender}）之前说的：${understanding.respondingTo.text}`,
    )
  }

  if (understanding.precedents.length > 0) {
    lines.push("", "他以前在类似情境下对**这个人**的真实回复（照这个感觉写，不要照抄）：")
    for (const item of understanding.precedents.slice(0, PROMPT_PRECEDENT_LIMIT)) {
      const given = item.given.replace(/\n/g, " / ").slice(0, PROMPT_PRECEDENT_CONTEXT)
      lines.push(`- 当时对方说「${given}」，他回「${item.theyReplied}」`)
    }
  }

  /**
   * ★ 记忆放在先例**之后**、防编造之前 —— 顺序是刻意的：先例决定"怎么说"，
   * 记忆决定"说什么"，而防编造那句约束的是记忆**之外**的一切。
   *
   * 写明"这是你知道的事"而不是"资料显示"：这些是本人自己聊天记录里的事实，
   * 用第三人称的口气引用会让模型在回复里解释来源 —— 而本人不会对自己的狗
   * 解释"根据记录"。
   */
  if (memory.length > 0) {
    lines.push("", "你已经知道的事（对方提到的东西，来自你自己的聊天记录）：")
    for (const hit of memory) {
      lines.push(`- ${hit.term}：${hit.facts.join("；")}`)
    }
    lines.push("直接把这些当已知的事用，不要说「根据记录」或解释你是怎么知道的。")
  }

  /**
   * ★ 澄清选项：本人自己问澄清问题的**原话**。
   *
   * 这一段是新接的 —— forge 的 `clarifyOption` 一直在 payload 里，而 host
   * 从来没读过它。它治的正是"贴合本人"这件事：当对方提到的东西库里查得到
   * 主题但查不到被问的那部分时，最诚实的动作是**问一句是哪个**，
   * 而用本人自己的措辞问比用一句通用的「方便说下是哪个吗」像得多。
   *
   * ★ **空数组是结论，不是缺省**：语料里没有这个习惯就不要凭空造一句 ——
   * 问回去不是普遍的礼貌，它要么是这个人会做的事，要么不是。
   */
  if (understanding.clarifyOptions.length > 0) {
    lines.push("", "如果对方问的具体是哪一个你拿不准，他平时会这样问回去（用他的说法，别自己造）：")
    for (const line of understanding.clarifyOptions.slice(0, 3)) lines.push(`- ${line}`)
  }

  /**
   * ★ 防编造这一条**无条件**给，且不列具体词。
   *
   * 曾经这里会写「这些说法在他的历史记录里查得到：<terms>」。而 forge 给的
   * term 是滑窗切出来的 n-gram 碎片，不是主题词 —— 无分词语言里那些碎片往往
   * 是半个词组。于是那一行对模型零信息，还会稀释紧跟其后的「不要编」，
   * 而后者是这一段唯一真正重要的指令。
   */
  lines.push(
    "",
    "涉及具体事实（时间、数字、谁负责、什么状态）的，**没把握就不要写** —— " +
      "说一句稍后确认，比编一个具体的错答案好。",
  )
  lines.push("", "请起草回复。")
  return lines.join("\n")
}

/** 本会话内的审核偏好 → 一段 system 文本。空时返回空串（调用方据此整段不发）。 */
function renderReviewFeedback(feedback: readonly ReviewFeedback[]): string {
  if (feedback.length === 0) return ""
  const lines = feedback.map((item) => {
    const original = item.original.replace(/\s+/g, " ").trim().slice(0, 120)
    if (item.action === "discarded") return `- 用户丢弃过草稿：${original}`
    if (item.action === "edited") {
      const finalText = (item.finalText ?? "").replace(/\s+/g, " ").trim().slice(0, 120)
      return `- 用户把草稿「${original}」改成「${finalText}」后发送`
    }
    return `- 用户直接采用过草稿：${original}`
  })
  return ["当前 agent session 内的审核偏好（只用于本会话）：", ...lines].join("\n")
}
