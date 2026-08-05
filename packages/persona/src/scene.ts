/**
 * 场景判定：这一条回复**能不能**以本人身份自动发出去。
 *
 * ## ★ 为什么是确定性规则，而不是让模型自评
 *
 * 首版 `sceneAllowsAuto` 恒 `false`、`confidence` 恒 `0.6`（低于
 * `MIN_CONFIDENCE` 0.75）—— 也就是"靠两个写死的假值挡住一切"。
 * 那在没有执行器的时期是安全的，但它不是一个判定：它没有回答任何问题。
 *
 * 接真发送时有两条路：
 *
 * ① 让模型给自己的回复打分（`confidence`），高于阈值就发；
 * ② 用可枚举的规则判断"这条**所处的场景**答错也无不可逆后果"。
 *
 * 选 ②。理由不是"规则更准"，而是**失败模式不同**：
 * 模型对自己输出的高估是系统性的（它不知道自己不知道什么），
 * 而且一个 0.82 分没法审计 —— 出事后你无法回答"为什么当时判了能发"。
 * 规则可以：`failedRules` 里写着到底哪一条没过。
 *
 * 自评不是没用，但它只配当**加分项**，不能当唯一的闸。
 *
 * ## 白名单式，不是黑名单式
 *
 * 默认 `false`，逐条放行 —— 加一条新规则只会让更少的消息被自动发。
 * 黑名单式（默认 true、命中就拒）的问题是漏写一条就等于放行，
 * 而这里放行的代价是"以本人身份说了不该说的话"，不可逆。
 *
 * ## 这不是全部的闸
 *
 * 场景过了之后还要过 policy 的另外 8 条（白名单、模式、工作时间、
 * 频率、授权、禁止词、kill switch）。场景只回答"这类消息适不适合自动"，
 * 不回答"现在允不允许发"。
 */

/**
 * 每条规则的 id。
 *
 * 用具名 id 而不是 boolean 数组：它要落进 `dh_runs` 给用户看
 * （"为什么这条没自动发" → `scene:has_question`），
 * 而一个 `[true,false,true]` 在日志里等于没写。
 */
export const SCENE_RULES = [
  "is_direct_or_mentioned",
  "no_question",
  "no_commitment",
  "within_length",
  "no_placeholder",
] as const
export type SceneRule = (typeof SCENE_RULES)[number]

export interface SceneInput {
  /** 会话类型。单聊里对方说的每句话本来就是对你说的 */
  conversationKind: "direct" | "group"
  /** 这一批消息里有没有 @我 */
  mentionsSelf: boolean
  /** 要发出去的**草稿正文**（不是收到的消息） */
  draftText: string
}

export interface SceneVerdict {
  allowsAuto: boolean
  /** 没通过的规则。全部列出，不短路 —— 与 policy 的 failedConditions 同理 */
  failedRules: SceneRule[]
}

/**
 * 草稿正文的长度上限（字符）。
 *
 * 长回复更可能出错，也更像"替本人做决定"而不是"替本人应一声"。
 *
 * 60 是按实测语料定的：这个账号本人发的 2584 条纯文本消息，
 * 中位数 **6** 字、75 分位 11 字、90 分位 24 字，`<=60` 覆盖 **94.6%**。
 * 也就是说这个上限拦掉的是他自己都很少写的那 5% 长消息 ——
 * 而那 5% 恰恰是"解释一件复杂事情"的那类，最不该自动发。
 */
export const MAX_AUTO_LENGTH = 60

/**
 * 疑问/征询类措辞。命中 → 不自动发。
 *
 * 判据是**草稿在反问或征求意见**，那意味着它没有给出答复而是把球踢回去，
 * 或者它在替本人向别人要一个承诺。两种都该本人自己说。
 *
 * ★ 问号单独判（见下），这里只列不带问号也成立的那些。
 */
const QUESTION_PHRASES = [
  "行吗",
  "可以吗",
  "好吗",
  "对吗",
  "是吗",
  "要不要",
  "能不能",
  "什么时候",
  "多少钱",
  "怎么办",
  "你看呢",
  "你觉得",
] as const

/**
 * 承诺类措辞。命中 → 不自动发。
 *
 * 这一类是**最不能**自动发的：它替本人产生了一个别人会依赖的义务。
 * 「我来处理」发出去之后，对方就真的在等你处理了 —— 而你可能根本不知道
 * 这条消息存在过。
 *
 * 注意「没问题」也在里面：它读起来像客套，实际是对一个请求的应允。
 */
const COMMITMENT_PHRASES = [
  "我来",
  "我负责",
  "我处理",
  "我搞定",
  "我改",
  "我加",
  "明天给",
  "今天给",
  "稍后给",
  "马上给",
  "没问题",
  "保证",
  "一定",
  "承诺",
  "答应",
] as const

/**
 * 占位与拒答文案。命中 → 不自动发。
 *
 * 第一条来自 `extractDraft`：模型把思考过程当正文返回时它会替换成
 * 那句占位（实测踩到过一次 414 字的自述）。那句话的**语义**就是
 * "需要人看一眼"，自动发出去等于反着执行它。
 */
const PLACEHOLDER_PHRASES = [
  "这条需要人工确认后回复",
  "抱歉，我无法",
  "作为一个AI",
  "作为 AI",
  "我是一个语言模型",
] as const

/**
 * 判定。
 *
 * 全部规则都过才 `allowsAuto: true`。
 */
export function evaluateScene(input: SceneInput): SceneVerdict {
  const failed: SceneRule[] = []
  const text = input.draftText.trim()

  /**
   * ① 单聊放行；群聊必须是 @我 才行。
   *
   * 不对称是刻意的：单聊里对方说的每句话本来就是对你说的（而且钉钉单聊
   * 通常 @不了人）；群里没点到你却自动说话，风险完全不同 ——
   * 那是在一屋子人面前替本人发言。
   */
  if (input.conversationKind === "group" && !input.mentionsSelf) {
    failed.push("is_direct_or_mentioned")
  }

  /**
   * ② 不能是疑问句。
   *
   * 问号用**全角与半角都判**：中文输入法默认出全角 `？`，
   * 只判半角会让「这样行？」这类整类漏过去（实测语料里全角占绝大多数）。
   */
  if (
    text.includes("?") ||
    text.includes("？") ||
    QUESTION_PHRASES.some((phrase) => text.includes(phrase))
  ) {
    failed.push("no_question")
  }

  // ③ 不能含承诺
  if (COMMITMENT_PHRASES.some((phrase) => text.includes(phrase))) {
    failed.push("no_commitment")
  }

  /**
   * ④ 长度。
   *
   * 空正文也算不过：那时本来就没什么可发的，而"发一条空消息"
   * 比不发更糟（对方看到一条空气泡）。
   */
  if (text === "" || [...text].length > MAX_AUTO_LENGTH) {
    failed.push("within_length")
  }

  /**
   * ⑤ 不能是占位/兜底文案。
   *
   * `extractDraft` 在模型把思考过程当正文返回时会给一句
   * 「（这条需要人工确认后回复）」—— 那是**明确要求人看一眼**的信号，
   * 自动发出去正好违背它的意思。同理，模型有时会输出
   * 「抱歉，我无法…」这类拒答，那也不该以本人身份发出去。
   *
   * ★ 这一条替掉了原本设计的「近期有撤回 → 不自动发」。
   * 原因：`messages` 表**没有** `recalled_at` 列，解析层也不抽撤回事件
   * （都实测确认过）—— 那条规则的输入会恒为 0，也就是恒通过。
   * 一条恒通过的规则比没有更糟：它让"五道闸"看起来比实际严格。
   * 撤回信号要先在采集侧做出来，那时再加回这条规则。
   */
  if (PLACEHOLDER_PHRASES.some((phrase) => text.includes(phrase))) {
    failed.push("no_placeholder")
  }

  return { allowsAuto: failed.length === 0, failedRules: failed }
}

/**
 * 场景 → 风险等级。
 *
 * ## ★ 为什么这个函数存在
 *
 * policy 的 `confidence_and_risk` 要求 `risk === "low"`，而 `risk`
 * 首版是写死的 `"medium"` —— 于是那一条恒不通过。
 * 与写死 `confidence = 0.6` 同一个问题：一个假值在假装判定。
 *
 * 现在让它从**已经算过的场景规则**派生，而不是再编一个数：
 *
 * · 全部规则通过 → `low`（这正是"答错也无不可逆后果"的定义）；
 * · 只差"非 @我"或"太长" → `medium`（形式问题，不是内容危险）；
 * · 命中承诺/疑问/占位 → `high`（那三条是内容层面的危险信号）。
 *
 * 这样 `risk` 与 `sceneAllowsAuto` **同源**，不会出现
 * 「场景说能发、风险说 high」这种自相矛盾的组合。
 */
export function riskFromScene(verdict: SceneVerdict): "low" | "medium" | "high" {
  if (verdict.allowsAuto) return "low"
  const dangerous: readonly SceneRule[] = ["no_commitment", "no_question", "no_placeholder"]
  return verdict.failedRules.some((rule) => dangerous.includes(rule)) ? "high" : "medium"
}
