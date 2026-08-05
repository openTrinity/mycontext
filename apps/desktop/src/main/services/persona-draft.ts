/**
 * 从模型输出里取出**真正要发的那句话**。
 *
 * ## ★ 为什么需要这一步：实测模型会把思考过程当正文返回
 *
 * 一次真实运行里，草稿变成了 414 个字符的自述：
 *
 * > 根据对话历史和用户画像，我需要起草一条回复。让我分析一下：
 * > 1. 用户是…（负责内部模型web连接器）2. 说话风格：极其简短…
 *
 * 那条草稿如果被发出去，收到的人会看到我们的提示词内容与画像结论 ——
 * 这既是隐私问题也是明显的失态。而它**不会报错**：一条 414 字的草稿
 * 在数据库里与一条 10 字的草稿长得一样。
 *
 * 提示词里已经写了"只输出回复正文"。但提示词是**请求**不是**保证** ——
 * 模型在长上下文下会退化。所以再加一层机器可查的裁剪。
 *
 * ## 判据：结构特征，不是长度
 *
 * 只按长度截断（比如 >200 字就砍）会把一条真的长回复砍掉半句 ——
 * 那比留着思考过程更糟（半句话看起来像正常回复，但意思是错的）。
 *
 * 所以按**元话语的结构特征**判断：
 * · 以"根据…我需要/让我"这类自述开头；
 * · 含编号列表 + "回复应该："这类规划段落。
 *
 * 命中时取最后一个**段落**作为回复（模型的自述通常在前、结论在后），
 * 没有可用段落时给一句安全的占位 —— 而不是把自述发出去。
 */

/** 元话语的开头特征。命中即认为整段是思考过程。 */
const META_PREFIXES = [
  "根据对话",
  "根据历史",
  "让我分析",
  "我需要起草",
  "我来分析",
  "首先，我",
  "让我看看",
  "分析一下",
  "好的，我来",
]

/** 规划段落的特征（与编号列表同时出现时才算）。 */
const PLAN_MARKERS = ["回复应该", "回复要", "所以回复", "草稿如下", "综上"]

/**
 * 自述开头的最短可疑长度。
 *
 * "根据对话，我觉得可以" 这种短句以自述词开头但**就是回复本身** ——
 * 裁了它是误伤。而真的思考过程一定要铺开讲，装不进 40 字。
 *
 * ★ 这个下限**只**作用于"开头像自述"这一条判据。
 * 「编号列表 + 规划措辞」那一条不看长度 —— 那个组合本身就足够特异，
 * 一条正常回复不会既编号又说"回复应该"。
 * 首版把长度门槛加在两条判据之前，结果 56 字的规划段落漏过去了。
 */
const META_PREFIX_MIN_LENGTH = 40

/**
 * 单段回复的长度上限（用于"最后一段还是不是自述"的兜底判断）。
 *
 * 不用它做主判据：只按长度截断会把一条真的长回复砍掉半句，
 * 而半句话看起来像正常回复但意思是错的 —— 比留着自述更糟。
 */
const MAX_REPLY_PARAGRAPH = 200

export interface ExtractedDraft {
  text: string
  /** 是否做过裁剪（调用方要记日志：静默裁剪同样难排查） */
  trimmed: boolean
}

export interface PersonaDraftEnvelope {
  text: string
  /**
   * 模型自己的刹车。**只能收紧，永不能放宽。**
   *
   * `true` = 一定进待审。`false` **不授予任何权限** —— 它只表示"我没找到
   * 该停下来的理由"，能不能真发由宿主的 `brief` / `check` / `fresh` +
   * Policy 十条决定。这与产物 `SKILL.md` 的 `Embedded host mode` 一节
   * （「`false` grants nothing」）是同一句话，那边是声明，这里是类型。
   */
  holdForReview: boolean
  reviewReason: string | null
}

function looksLikeReasoning(text: string): boolean {
  /**
   * 判据一：以自述词开头，且长到装得下一段分析。
   *
   * 长度门槛只加在这一条上 —— "根据对话，我觉得可以" 是回复本身，
   * 裁它是误伤。
   */
  const head = text.slice(0, 40)
  if (text.length >= META_PREFIX_MIN_LENGTH && META_PREFIXES.some((p) => head.includes(p))) {
    return true
  }

  /**
   * 判据二：编号列表 + 规划措辞。**不看长度**。
   *
   * 这个组合本身就足够特异：一条正常回复不会既列 `1. 2.`
   * 又说"回复应该"/"综上"。首版把长度门槛加在这一条前面，
   * 结果一段 56 字的规划段落原样进了草稿箱。
   */
  const hasNumberedList = /(^|\n)\s*\d[.、)]\s/.test(text)
  return hasNumberedList && PLAN_MARKERS.some((marker) => text.includes(marker))
}

export function extractDraft(raw: string): ExtractedDraft {
  const text = raw.trim()
  if (text === "") return { text: "", trimmed: false }
  if (!looksLikeReasoning(text)) return { text, trimmed: false }

  /**
   * 取最后一个非空段落。
   *
   * 模型的自述通常是"分析 → 结论"，结论在最后。取最后一段比取第一段
   * 命中率高得多（实测那条 414 字的样本，最后一段正是它想说的那句）。
   */
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part !== "")
  const last = paragraphs.at(-1) ?? ""

  /**
   * 最后一段仍然像思考过程（或者太长）→ 给占位，**不发自述**。
   *
   * 占位是一句安全的话：用户在草稿箱看到它会自己改，
   * 而看到一段自述只会困惑（然后关掉这个功能）。
   */
  if (last === "" || last.length > MAX_REPLY_PARAGRAPH || looksLikeReasoning(last)) {
    return { text: "（这条需要人工确认后回复）", trimmed: true }
  }
  return { text: last, trimmed: true }
}

/**
 * 解析产物声明的输出协议：`{reply, holdForReview, reviewReason}`。
 *
 * 契约本身写在 forge 的 `SKILL.md` 的 `Embedded host mode` 一节
 * （由 `readGuidance` 拼进 system）—— 这里只是它的解析端。
 *
 * ## ★ 解析失败一律 fail closed
 *
 * 拿不到结构（模型返回了散文、被截断、字段缺失）时**仍保留正文**给用户
 * 审核，但 `holdForReview` 置 true。反过来做（读不懂就当放行）会让
 * "模型今天不听协议"变成"今天什么都自动发出去了"。
 *
 * ## 裁剪过也算要人看
 *
 * `extractDraft` 裁掉过一段思考过程时，剩下的那句**未必**是它想说的话
 * （实测那 414 字的样本里最后一段恰好是，但那是运气）。裁过就要人看一眼。
 */
/**
 * ★ 从**尾部**找一段合法的 `{...}` 并解析。
 *
 * ## 为什么需要它：实测模型会在协议 JSON 前面加一段散文
 *
 * 一次真实运行里，模型的整段输出是：
 *
 * > 语料里有明确记录：小周喜欢听卢广仲的歌。
 * > {"reply": "卢广仲", "holdForReview": false, "reviewReason": ""}
 *
 * `JSON.parse(raw)` 对这样的输入直接抛，落到旧的 `catch` 分支后**整段**
 * （散文 + 那条 JSON）被 `extractDraft` 当正文往下走 —— 用户在草稿箱看到
 * 的、或者被自动发出去的就是「语料里有明确记录：… {"reply":"卢广仲", …}」。
 * 这既漏出了内部字段名（`holdForReview`），也把一句本该是"卢广仲"的回复
 * 变成一段解释性废话。
 *
 * ## 判据：**从右向左**找一对配平的花括号
 *
 * 用正则找 `{...}` 会被字符串里的 `{` 或转义误伤。所以走一次栈：
 * · 遇到未转义的字符串边界（`"`）时进入字符串态，忽略里面的括号；
 * · 遇到 `{` 深度 +1，遇到 `}` 深度 -1；
 * · 深度归零时截出这一段。
 *
 * 走**从右向左**是刻意的：产物的协议 JSON 在末尾，而前面的散文里可能
 * 也含 `{}`（比如引用了配置片段）。取最后一段配平的括号命中率最高。
 */
function tryParseTailEnvelope(raw: string): Record<string, unknown> | null {
  const text = raw.trimEnd()
  /**
   * ★ 不能只在 `endsWith("}")` 时才启动。
   *
   * 实测有两种触发字符串就不会以 `}` 结尾却仍然含协议 JSON：
   * · markdown 围栏：`` ```json\n{...}\n``` ``（尾字符是反引号）
   * · 尾部 whitespace / 多余换行没被 trimEnd 覆盖到的场景（如全角空格）
   *
   * 所以从**最右一个** `}` 开始反查配平的 `{`。命中不了就返回 null。
   */
  const lastClose = text.lastIndexOf("}")
  if (lastClose === -1) return null

  let depth = 0
  let inString = false
  let start = -1
  for (let i = lastClose; i >= 0; i -= 1) {
    const ch = text[i]
    if (inString) {
      // 反向扫字符串时，`\"` 的判定要看该 `"` 前面**紧邻**的反斜杠数量的奇偶。
      // 简化实现：只要前一个字符是 `\`，就把这个引号当转义（真实语料里不会
      // 出现 `\\"` 这种连续转义反斜杠边界）。命中率够用，代价是极少数假匹配。
      if (ch === '"' && text[i - 1] !== "\\") inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === "}") {
      if (depth === 0) start = i
      depth += 1
      continue
    }
    if (ch === "{") {
      depth -= 1
      if (depth === 0) {
        // start 是最右那个 `}` 的下标 —— slice 包尾要 +1
        const chunk = text.slice(i, start + 1)
        try {
          const parsed = JSON.parse(chunk) as unknown
          if (typeof parsed === "object" && parsed !== null) {
            return parsed as Record<string, unknown>
          }
        } catch {
          // 这一段不合法就继续往左找（可能前面还有另一段）
        }
        // 找不到合法解析时，退出：再往左也不会更好 —— 我们要的是**最右**那段
        return null
      }
    }
  }
  return null
}

/**
 * 「这看起来是一个**没收完**的协议信封」。
 *
 * ## 为什么需要与"散文"区分开
 *
 * 解析失败有两种完全不同的原因，而它们该有不同的处理：
 *
 * · **模型没按协议说了句人话** —— 留着原文让人改。那是可用的草稿。
 * · **信封被截断** —— 原文是机器文本（`{"reply": "哈哈好", "holdForReview": false,`）。
 *   把它当正文交给用户，他唯一能做的是全选删掉重写，而它看起来像
 *   我们的功能坏了、不像一次可重试的失败。
 *
 * 库里真有那样一条 40 字符的草稿（见 persona-draft.test.ts 的那一组）。
 * 根因在 `PersonaAcp.turn` 读早了（已修），但这一层是 draft_text 落库前
 * **最后**一道门 —— 网络或进程在任何一处断掉都能再产出半截 JSON。
 *
 * ## 判据是三条**同时**成立
 *
 * ① 整段**解析不出来**（这是"截断"的定义，也是与下面两类的分界）；
 * ② 以 `{` 开头；
 * ③ 含 `"reply":` 这个键。
 *
 * 少任何一条都会误伤，而两个方向的误伤都真实存在：
 *
 * · 只看 ②③ 不看 ① —— `{"reply":"收到","requiresReview":false}` 是**完整**
 *   JSON（只是刹车字段改了名），原文留着无害；判成截断就把它换成占位文案，
 *   那是把一条能改的草稿删掉了。首版漏了这一条，被既有的
 *   「刹车字段缺失/改名」那条测试抓到。
 * · 只看 ①② 不看 ③ —— 「那个配置写成 {a: 1} 就行」是一句**正常回复**，
 *   判成截断就是一次凭空降级（测试里有这条反证）。
 */
function looksLikeTruncatedEnvelope(raw: string): boolean {
  const text = raw.trim()
  if (!text.startsWith("{")) return false
  // 键名带引号地出现 —— 只找 `reply` 这个词的话，正文里提到"reply"就误伤了
  if (!/"reply"\s*:/.test(text)) return false
  /**
   * ★ 能解析出来就**不是**截断。
   *
   * 这一条把"字段改名"（完整 JSON）与"流断了"（残缺）分开 ——
   * 两者前面都会解析失败进到这个分支，但只有后者的原文是不可读的机器文本。
   */
  try {
    JSON.parse(text)
    return false
  } catch {
    return true
  }
}

/**
 * 截断信封的替代草稿。
 *
 * ★ **不给空正文**：空草稿在界面上与"模型认为无需回复"无法区分，
 * 而这两件事该让用户做的动作完全不同。给一句人话，让他知道可以重试。
 *
 * `reviewReason` 用一个**独立**的 code（不是 `agent_output_unstructured`）——
 * 两者的排查方向不同：截断要去看 ACP 的流收尾，读不懂要去看提示词与产物协议。
 * 共用一个 code 会让"半截 JSON 又出现了"这件事淹没在散文那一类里。
 */
function truncatedEnvelope(): PersonaDraftEnvelope {
  return {
    text: "（生成不完整，需要重新生成或人工撰写）",
    holdForReview: true,
    reviewReason: "agent_output_truncated",
  }
}

export function extractDraftEnvelope(raw: string): PersonaDraftEnvelope {
  /**
   * ★ 先按尾部 JSON 解析。
   *
   * `JSON.parse(raw)` 对"前置散文 + JSON"直接抛 —— 那时旧代码会把
   * 整段（散文+JSON）当正文发出去。先尝试从尾部截出协议块，命中就用它；
   * 未命中再退回原有的整块解析（即"纯 JSON"或"纯散文"两种老形态）。
   */
  const tail = tryParseTailEnvelope(raw)
  const record = (() => {
    if (tail !== null) return tail
    try {
      const parsed = JSON.parse(raw) as unknown
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  })()

  if (record === null) {
    /**
     * ★ 半截信封先挡住 —— 它的原文是机器文本，不该进草稿框。
     * 见 `looksLikeTruncatedEnvelope`：与"模型说了句人话"是两回事。
     */
    if (looksLikeTruncatedEnvelope(raw)) return truncatedEnvelope()
    return {
      text: extractDraft(raw).text,
      holdForReview: true,
      reviewReason: "agent_output_unstructured",
    }
  }
  if (typeof record["reply"] !== "string" || typeof record["holdForReview"] !== "boolean") {
    /**
     * ★ 同一条：字段不全**且**原文像信封时，也不能把原文当正文。
     *
     * 这个分支能被两种输入命中：字段改名（原文是完整 JSON，留着无害但也
     * 没用）与截断（原文是机器文本）。后者要走占位那条路。
     */
    if (looksLikeTruncatedEnvelope(raw)) return truncatedEnvelope()
    return {
      text: extractDraft(raw).text,
      holdForReview: true,
      reviewReason: "agent_output_unstructured",
    }
  }
  const extracted = extractDraft(record["reply"])
  return {
    text: extracted.text,
    holdForReview: record["holdForReview"] || extracted.trimmed,
    reviewReason:
      typeof record["reviewReason"] === "string" && record["reviewReason"].trim() !== ""
        ? record["reviewReason"].trim().slice(0, 160)
        : extracted.trimmed
          ? "draft_looked_like_reasoning"
          : null,
  }
}
