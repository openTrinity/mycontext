/**
 * 消息召回 —— **搜索模块与数字人 agent 共用的那一份**。
 *
 * ## 为什么必须是共用的一份
 *
 * 这套逻辑（两档词元 + 落空放宽）原本长在 `SearchService.recallOnly` 里，
 * 是 private 且 search 专用。数字人要检索时最自然的做法是再写一遍 ——
 * 而两份实现早晚不一致，"两处检索口径不同"这种 bug 极难发现：
 * 两边都能返回结果，只是返回的不是同一批。
 *
 * 所以抽到这里，两处 import 同一个函数。
 *
 * ## ★ 两档词元不是"以防万一"
 *
 * 只用严格档时**换个词序就搜不到**：实测原文「沙箱环境部署完成了」，
 * 查「部署沙箱」/「完成部署」都是 0 命中 —— 查询里的 `署沙`/`成部`
 * 是跨词边界的 bigram，原文里根本不存在；而「部署 沙箱」能中，
 * 也就是要用户自己加空格。
 *
 * 放宽档去掉 CJK bigram、只留单字，精度略降但**只在严格档 0 结果时启用**
 * —— 没有变坏的情况。
 *
 * 实测成本（20 万行 FTS5 语料）：严格档落空只要约 0.1ms（FTS 找不到词元时
 * 几乎立刻返回），放宽档才是 12-13ms 的那一档。也就是说
 * 「命中时只跑一档」「落空时多付 0.1ms」——**不是** 2× 成本。
 *
 * ## 隔离靠 `conversationIds`
 *
 * 数字人 agent 只能看它自己那个会话。这个过滤在 SQL 层
 * （`FtsIndexRepository.search` 的 `conversationIds`），
 * 而不是"拿回来再筛" —— 后者一旦漏一处判断就是跨会话泄漏，
 * 而单聊内容泄漏到群聊 agent 是不可逆的。
 */
import type { FtsIndexRepository, MessageRepository, MessageRow } from "@mycontext/store"
import { toMatchExpr } from "./match-expr.js"
import { toQueryTokenTiers } from "./bigram.js"

/** 单次召回的条数上限。20 条够给模型上下文，又不至于挤掉对话本身。 */
export const DEFAULT_RECALL_LIMIT = 20

export interface RecallHit {
  message: MessageRow
  /** bm25 分数（越小越相关，SQLite 的约定） */
  score: number
}

export interface RecallResult {
  hits: RecallHit[]
  /**
   * 是否用了放宽档。
   *
   * 必须报出来：放宽命中时精度是降过的，UI 要明示
   * （悄悄放宽会让用户以为这就是精确结果）。
   */
  relaxed: boolean
  /** 实际用于检索的词元（排查"为什么没搜到"时唯一有用的信息） */
  tokens: string[]
}

export interface RecallOptions {
  /** 限定会话；不传 = 全库。数字人**必须**传 */
  conversationIds?: readonly string[]
  limit?: number
}

/**
 * 召回消息。
 *
 * 传 `conversationIds: []`（空数组）时返回空 —— 那是"限定在零个会话里"，
 * 与"不限定"是两件不同的事，不能当成同一种处理。
 */
export function recallMessages(
  repos: { fts: FtsIndexRepository; messages: MessageRepository },
  query: string,
  options: RecallOptions = {},
): RecallResult {
  const limit = options.limit ?? DEFAULT_RECALL_LIMIT
  const scope = options.conversationIds

  // 空数组 = 限定在零个会话 → 必然无结果。不能退化成"不限定"。
  if (scope !== undefined && scope.length === 0) {
    return { hits: [], relaxed: false, tokens: [] }
  }

  const tiers = toQueryTokenTiers(query)
  let raw: ReturnType<FtsIndexRepository["search"]> = []
  let relaxed = false
  let used: string[] = []

  for (const [tierIndex, tokens] of tiers.entries()) {
    used = [...tokens]
    raw = repos.fts.search(toMatchExpr(tokens), {
      limit,
      ...(scope === undefined ? {} : { conversationIds: scope }),
    })
    if (raw.length > 0) {
      relaxed = tierIndex > 0
      break
    }
  }

  const hits: RecallHit[] = []
  for (const hit of raw) {
    const message = repos.messages.findById(hit.messageId)
    // 消息已被删（隐私删除等）而索引还在 —— 跳过不是错误
    if (message === null) continue
    hits.push({ message, score: hit.score })
  }

  return { hits, relaxed, tokens: used }
}

/**
 * 把召回结果渲染成给模型看的文本块。
 *
 * 带序号与时间：模型要能说"根据 6 月 3 日那条"，而不是含糊地
 * "我记得有人提过" —— 后者无法验回原文。
 */
export function renderRecallForPrompt(result: RecallResult): string {
  if (result.hits.length === 0) return "（没有检索到相关消息）"
  const lines = result.hits.map((hit, index) => {
    const when = new Date(hit.message.sentAt).toISOString().slice(0, 16).replace("T", " ")
    const who = hit.message.isSelf === true ? "我" : (hit.message.senderDisplayName ?? "未知")
    // 与 map 阶段同一套中性化：召回内容同样是不可信输入
    const text = (hit.message.contentText ?? "").replace(/```/g, "｀｀｀").slice(0, 200)
    return `[${String(index + 1)}] ${when} ${who}：${text}`
  })
  // 放宽档要明示 —— 本模块的原则是「降级必须可见」
  const note = result.relaxed ? "（已放宽词序匹配，相关性可能略低）\n" : ""
  return note + lines.join("\n")
}
