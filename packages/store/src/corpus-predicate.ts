/**
 * 语料谓词 —— kl-graph 与 forge **共用**的那一份「哪些消息算语料」。
 *
 * ## 用户原话
 *
 * 「或许 kl-graph 和 forge 的语料都可以合并」
 *
 * ## 为什么是"共用谓词"而不是"合并成一个导出器"
 *
 * 两个消费者的 **sink** 天生不同：kl 要一份全量 `records.jsonl` 快照
 * （他们的 loader 没有增量入口，追加会让同一条消息出现两行且不去重，
 * 见 `graph-sync.ts` 文件头），forge 要按时间窗切的 `distill_tasks`。
 * 把它们物理合并会让一方的形状迁就另一方。
 *
 * 但「**哪些消息算语料**」必须只有一个答案 —— 而在这次修复前它有两个：
 *
 * | | kl-graph | forge |
 * |---|---|---|
 * | 空正文 | `content_text <> ''` | `trim(content_text) <> ''` |
 *
 * ★ 而且**两侧都不完整**：SQLite 的 `trim(x)` 只去空格，不去换行/制表，
 * 所以 forge 那句也放过了只含 `\n` 的消息。共用谓词显式给字符集修掉了它。
 *
 * 实测（SQLite,5 条样本）：纯空白消息（`"   "` / `"\n\t "`）在 kl 侧被选中、
 * forge 侧被排除 —— 图谱里会多一个由空消息生成的节点，而蒸馏找不到对应语料。
 *
 * ★ 但**在本机真库上这个分歧影响 0 行**（钉钉 vault 37180 条，三种谓词
 * 选中数完全相同）—— 也就是说它是**潜在**的不一致，不是当前已发生的。
 * 这个区别要说清：夸大成"库里已经错了"会让人以为需要一次数据修复，
 * 而实际需要的只是把判据收成一处（下面这件事）。
 *
 * ## 所以这里导出的是 SQL 片段，两侧都必须用它
 *
 * 判据只有一处定义 ⇒ 改它就是同时改两侧 ⇒ 漂移在**结构上不可能**，
 * 而不是靠一道测试去发现漂移（发现总是发生在造成不一致之后）。
 *
 * ★ 为什么不做成一个"返回消息列表"的共享函数：两侧的查询形状不同
 * （kl 按会话逐个查、forge 按时间窗查、还有 LIMIT/ORDER 的差别）。
 * 共享**谓词**是它们真正重合的那一层；再往上共享就会开始互相迁就。
 */

/**
 * 「这条消息算语料吗」的 SQL 谓词（不含表别名）。
 *
 * 三条判据：
 * · 正文非空 —— `trim` 之后为空的也算空（纯空白消息没有任何语义，
 *   进了图谱只会生成一个空节点）；
 * · 排除数字人自产（`origin = 'agent'`）—— 不排的话它自己发的话会被当
 *   本人语料再蒸一遍 → **自我强化漂移**（越来越像自己的输出而不是像本人）。
 *
 * ★ 不含 `channel_id` / 时间窗 / 会话白名单：那三样是**范围**
 * （`readCollectionScope`），由调用方按各自的查询形状拼。
 * 混进来会让这个常量变成"某个具体查询"，从而不再可共用。
 */
/**
 * ★★★ `trim` 必须**显式给字符集**。
 *
 * SQLite 的 `trim(x)` 只去**空格**，不去 `\n` / `\t` / `\r`（实测：
 * `trim(char(10)||char(9)||' ')` 返回 `"\n\t"` 而不是 `""`）。
 * 所以 forge 原来那句 `trim(content_text) <> ''` 也**没有**挡住
 * 只含换行/制表的消息 —— 我一开始以为只有 kl 侧有问题，实际两侧都漏，
 * 只是漏的形状不同（kl 连纯空格都不挡，forge 不挡换行制表）。
 *
 * 第二个参数是要去掉的字符集合：空格 / 制表 / 换行 / 回车。
 * 用 `char()` 拼而不是写字面转义：SQL 字符串里的 `\n` 是两个字符，
 * 不是换行 —— 那种写法看起来对、实际什么都没去掉。
 */
const BLANK_CHARS = "char(32)||char(9)||char(10)||char(13)"

export const CORPUS_MESSAGE_PREDICATE = `content_text IS NOT NULL AND trim(content_text, ${BLANK_CHARS}) <> '' AND origin <> 'agent'`

/**
 * 带表别名的版本 —— 给有 JOIN 的查询用（如 `messages m`）。
 *
 * ★ 提供这个而不是让调用方自己字符串替换：`replace` 会把
 * `content_text` 里的子串也换掉，而那种错误只在有 JOIN 的那条查询上出现。
 */
export function corpusMessagePredicate(alias: string): string {
  const prefix = alias === "" ? "" : `${alias}.`
  return (
    `${prefix}content_text IS NOT NULL` +
    ` AND trim(${prefix}content_text, ${BLANK_CHARS}) <> ''` +
    ` AND ${prefix}origin <> 'agent'`
  )
}
