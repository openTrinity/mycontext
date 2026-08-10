/**
 * work 层的**第二类语料**：文档与会议纪要。
 *
 * ## 为什么聊天记录不够
 *
 * work 层要抽的是职责范围、工作流程、输出物偏好、经验结论
 * （见 `llm-map.ts` 的 `LLM_FACETS`）。这四样在聊天里出现得**零散**：
 * 一个人在群里说「这块我看看」，看不出他负责哪个系统；而他写的技术方案
 * 第一段就写着「本文涉及 user-center 的注册链路」。
 *
 * 也就是说这一层的证据密度在文档里最高，而 vault 里早就有
 * （`documents` / `minutes` 两张表，v2 迁移就建了，`knowledge-feed` 已经在导出）。
 * forge 完全不读它们（它只投影 `messages`），所以这是 work 层独有的输入。
 *
 * ## ★★ 最危险的一件事：文档**不带作者**
 *
 * `messages.is_self` 是采集侧判定并回填的，而 `documents` 与 `minutes`
 * **没有等价字段**：
 *
 * · `documents.owner_actor_id` 在 schema 里存在，但**全仓库没有任何代码写它**
 *   （grep 过：只有建表语句提到它）—— 也就是它恒为 NULL；
 * · `minutes.speakers_json` 里的 `owner` 是**会议的组织者/分享者**，
 *   不是"这段话是谁说的"。
 *
 * 所以「本人写的文档」这件事**当前无法从库里判定**。而这正是
 * `guards.assertDistillable` 拒绝 `is_self === null` 的那个理由的同一形状：
 * 把别人写的规范当成本人定的规矩，产出的是一份自信且错误的画像，
 * 而之后没有任何信号能纠回来。
 *
 * ★ 结论：文档语料一律标成 **`authorship: "unknown"`**，并在 prompt 里
 * 明确告诉模型「这些不一定是他写的，只能作为他所处环境的背景」。
 * 不猜、不按标题匹配姓名（同名同姓在花名册里是常态）、也不静默当成本人的。
 *
 * 这让文档只能支撑**较弱**的结论（他所在领域的术语、他团队的规范），
 * 而「他定过什么规矩」仍然只能从他自己的消息里抽 —— 那是有 `is_self` 的。
 * 弱一点但真实，好过强一点但可能是别人的。
 */
import type { SqliteDatabase } from "@mycontext/store"

/**
 * 一段送进 prompt 的工作语料。
 *
 * 与 `MessageRow` 刻意不同构：那个有 `isSelf` / `senderDisplayName`，
 * 而这里最重要的信息恰恰是「作者未知」。共用一个类型会让 `unknown`
 * 这件事变成一个可以忘记检查的可选字段。
 */
export interface WorkCorpusItem {
  /** 稳定 id，用于证据回验（`documents.id` / `minutes.id`） */
  id: string
  kind: "document" | "minutes_summary"
  title: string
  text: string
  /** 文档/会议的时间（unix ms）；null = 库里没有 */
  at: number | null
  /**
   * 作者归属。当前**恒为 `unknown`** —— 见文件头。
   *
   * 留成字段而不是省掉：等采集侧真的回填了 `owner_actor_id`
   * （那是一次采集侧的改动，不是这里能决定的），这里就能出现 `self`，
   * 而所有下游已经在按这个字段分级使用了。
   */
  authorship: "self" | "unknown"
}

/** 单条语料进 prompt 的截断长度。文档正文动辄上万字，会挤掉其他所有语料。 */
const MAX_CHARS_PER_ITEM = 1200

/**
 * 取一个时间窗内的文档与纪要摘要。
 *
 * ★ 只取**有正文**的：`content_text IS NULL` 表示"没取到正文"而不是
 * "文档是空的"（与 `media_assets.path` 同一口径，见 `DocumentRepository`）。
 * 把标题当正文用会让模型从一堆文件名里编结论。
 *
 * ★ 只取纪要的 `summary_text`，**不取 `transcript_json`**。转写是逐句发言，
 * 一场会几万字且发言人归属靠 `nickName` 字符串 —— 那是姓名匹配，正是
 * 本仓库反复踩过的坑。摘要是整场的浓缩，且不声称某句话是谁说的。
 */
export function readWorkCorpus(
  db: SqliteDatabase,
  input: {
    channelId: string
    /** 时间窗（unix ms）。与消息用同一个窗，保证 facet 的时间范围一致 */
    start: number
    end: number
    limit: number
  },
): WorkCorpusItem[] {
  const items: WorkCorpusItem[] = []

  /**
   * 文档按 `updated_at` 过滤。`NULL` 的**排除**而不是当成 0：
   * 当成 0 会让它落进每一个窗口（0 比任何 start 都小 → 永远不匹配，
   * 或者反过来永远匹配，取决于比较方向），两种都是错的，而且静默。
   */
  const docs = db
    .prepare<
      [string, number, number, number],
      { id: string; title: string | null; content_text: string | null; updated_at: number | null }
    >(
      `SELECT id, title, content_text, updated_at
         FROM documents
        WHERE channel_id = ?
          AND content_text IS NOT NULL AND content_text != ''
          AND updated_at IS NOT NULL AND updated_at >= ? AND updated_at < ?
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .all(input.channelId, input.start, input.end, input.limit)

  for (const row of docs) {
    const text = (row.content_text ?? "").trim()
    if (text === "") continue
    items.push({
      id: row.id,
      kind: "document",
      title: (row.title ?? "").trim(),
      text: text.slice(0, MAX_CHARS_PER_ITEM),
      at: row.updated_at,
      // ★ 恒为 unknown —— 见文件头。
      authorship: "unknown",
    })
  }

  const minutes = db
    .prepare<
      [string, number, number, number],
      { id: string; title: string | null; summary_text: string | null; started_at: number | null }
    >(
      `SELECT id, title, summary_text, started_at
         FROM minutes
        WHERE channel_id = ?
          AND summary_text IS NOT NULL AND summary_text != ''
          AND started_at IS NOT NULL AND started_at >= ? AND started_at < ?
        ORDER BY started_at DESC
        LIMIT ?`,
    )
    .all(input.channelId, input.start, input.end, input.limit)

  for (const row of minutes) {
    const text = (row.summary_text ?? "").trim()
    if (text === "") continue
    items.push({
      id: row.id,
      kind: "minutes_summary",
      title: (row.title ?? "").trim(),
      text: text.slice(0, MAX_CHARS_PER_ITEM),
      at: row.started_at,
      authorship: "unknown",
    })
  }

  return items
}
