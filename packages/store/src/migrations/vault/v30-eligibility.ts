/**
 * VAULT v30 — **资格标签**（DWD 只打标、不筛行）。
 *
 * ## ★★★ 它修的是一处**分层错误**
 *
 * `persist()` 那道闸原来在 DWD 的**写入侧**按**一个下游**（学习侧）的口径
 * 筛掉行。而 DWD（`messages`）是**多个下游共用**的：
 *
 * | 下游 | 要什么 |
 * |---|---|
 * | fts / graph / distill | 学习范围内的 |
 * | ★ 数字分身 | 监听范围内的 —— 包括"超出学习 `until`"的新消息 |
 * | ★ 界面（消息历史） | 全部（用户要看的是完整对话） |
 *
 * 在写入侧按第一类的口径筛，另外两类就永久拿不到那些数据 ——
 * 而 ODPS 的惯例正是「**明细层只打标，筛选在消费侧**」。
 *
 * ## 这个迁移做什么
 *
 * ① `messages.learning_eligible` —— 落库时算一次"这条属于学习范围吗"；
 * ② `knowledge_changelog.eligibility` —— 位图，让消费者按标签取自己那一段；
 * ③ 两个索引 —— 消费侧那两个查询形状各一个。
 *
 * ## ★★★ 三列都**可空**，而 `NULL` 有明确语义
 *
 * `NULL` = 「这一行是打标之前入库的，我们不知道当时的资格」。
 *
 * 不能给 `DEFAULT`：
 *
 * | 给什么 | 后果 |
 * |---|---|
 * | `DEFAULT 1` | 把"已经被旧闸挡掉过的历史"说成当时合格 —— 而那些行压根不在库里，这个默认值没有意义 |
 * | `DEFAULT 0` | ★ 存量库的图谱与画像下一轮重导时**全部清空** |
 *
 * 处置由消费者决定，而判据必须显式：**learning 侧 `IS NOT 0`**
 * （存量行能进库，说明它当时通过了旧闸 —— 那道闸比现在更严）。
 *
 * ★★ 注意是 `IS NOT 0` 而**不是** `= 1` —— 后者会把 `NULL` 排除掉。
 * 两个写法在 SQL 里差一个字，而后果是"存量用户的图谱下一轮变空"。
 *
 * ## ★★ 为什么**不**加 `attention_eligible`
 *
 * 想过，不行 —— 两个范围的性质根本不同：
 *
 * | | 学习范围 | 监听范围 |
 * |---|---|---|
 * | 能怎么变 | **只增不减** | ★ **可以关掉**；`enabled_at` 只能变早 |
 * | 标签过期的方向 | 只往"更严"漂（放宽了但标签还是 0）→ **安全** | ★ **两个方向都漂** |
 * | 漂错的现象 | 放宽了但暂时没学（下一轮补） | ★ 「我关了它还在回消息」—— **用户看得见的错误行为** |
 *
 * 所以监听那侧的判据必须是 `AttentionRouter`（读 `attention_scope` 的
 * **当前值**）、每条现判 —— 一个落库那刻的快照挡不住它声称要挡的东西。
 *
 * ## 实测（本机真库，37,718 条消息 / 10,012 条 changelog）
 *
 * | 项 | 实测 |
 * |---|---|
 * | v29 → v30 迁移耗时 | **9–168 ms**（只加两列 + 两个索引，不回填） |
 * | 迁移后 `learning_eligible` 分布 | ★ **37718 行全为 NULL** |
 * | 迁移后 `eligibility` 分布 | ★ **10012 条全为 NULL** |
 * | 一次全量打标 `UPDATE`（37718 行） | **75–80 ms** |
 *
 * ★★★ 中间那两行是"为什么 `NULL` 的处置必须写对"的**量化证据**：
 * 判据写成 `= 1` 的话，这个库的学习侧下一轮拿到的是 **0 条**
 * （不是"少一些"，是全空）。
 *
 * ★ 最后一行说明"范围放宽后重新打标"不需要特殊设计 —— 80 ms 的事。
 *
 * ★★ 两个索引的实测结论与我原本的推断**不一致**（规划器都不选它们），
 * 详见下面 ③ ④ 的注释。
 *
 * ## 只加列 + 建索引，不动任何已发布迁移
 *
 * 改已发布的迁移会让 checksum 变，已迁移的 vault 启动即
 * `DB_MIGRATION_FAILED`（v18 那批真踩过）。
 */
export const VAULT_0030_ELIGIBILITY = `
-- ① DWD 的资格标签。
--    NULL = 打标之前入库的（语义见文件头）；1 = 在学习范围内；0 = 不在。
--    ★ 落库时算一次而不是查询时算：查询时算会让"范围一改、历史行的语义
--      跟着变"，而 purge 与「只增不减」都依赖"现在该不该给下游"这个物化值。
ALTER TABLE messages ADD COLUMN learning_eligible INTEGER;

-- ② changelog 的资格位图（bit 0 = learning）。
--    ★ 用位图而不是一个布尔列：将来加第二个维度时不用再改一次表结构，
--      而消费者那侧的判据形状（(eligibility & ?) = ? 这种）不变。
--    ★★ 为什么不拆成两个 domain（chat / chat-attention）：那会让一条消息
--      可能进两个域 → seq 翻倍 → 去重成为每个下游的责任，
--      而"一条消息一个 seq"是下游都在依赖的性质。
ALTER TABLE knowledge_changelog ADD COLUMN eligibility INTEGER;

-- ③ 消费侧按标签取那一段的索引。
--    顺序 (domain, eligibility, seq)：eligibility 是低基数（2 个值 + NULL），
--    放中间让它成为等值前缀，seq 仍然能走有序扫描。
--
--    ★★★ 实测（真库 37718 条消息 / 10012 条 changelog）：**规划器不选它**。
--
--      WHERE domain = ? AND ((eligibility & 1) != 0 OR eligibility IS NULL) AND seq > ?
--      → SEARCH knowledge_changelog USING INDEX idx_changelog_domain (domain=? AND seq>?)
--
--    原因是那个 OR：(eligibility & 1) != 0 OR eligibility IS NULL 不是等值
--    约束，规划器用不上中间那一列，于是退回**已有的** idx_changelog_domain
--    —— 而那个索引对这条查询已经够了（domain 等值 + seq 有序，200 行 ≤1ms）。
--
--    ★ 换成等值形状（eligibility = 1）时它**确实**会被选中（实测：
--      SEARCH ... USING INDEX idx_changelog_domain_elig (domain=? AND
--      eligibility=? AND seq>?)）—— 但我们不能用等值，那会排除 NULL，
--      而 NULL 是存量库的全部（实测该库 10012 条 changelog **全为 NULL**）。
--
--    ★★ 所以留着它是为了"将来标签回填之后 / 位图有更多维度时"，
--    现在它不承担那条查询。**保留而不删**的理由：它很小、且删它要再发一次
--    迁移。但注释必须说实话 —— 否则下一个人会拿"有索引"当性能结论。
CREATE INDEX IF NOT EXISTS idx_changelog_domain_elig
  ON knowledge_changelog(domain, eligibility, seq);

-- ④ 学习侧语料查询的索引。
--    ★★ 那两个消费者的输入是**表**而不是 changelog 的那一条，
--      所以 ③ 那个索引对它们无效 —— 它们要在自己的 SQL 里筛
--      （见 corpus-predicate.ts）。漏了那一处的后果是图谱含越界数据，
--      而且不报错。
--
--    ★★★ 实测：这两条查询也**不走这个索引** —— 它们各自走已有的索引：
--
--      graph-export（按会话）→ SEARCH messages USING INDEX idx_msg_conv_time
--      forge pull（按时间窗）→ SEARCH messages USING INDEX idx_msg_sent
--
--    因为 learning_eligible IS NOT 0 同样不是等值约束，而两条查询各自的
--    **前导列**（conversation_id / sent_at）已经把行数收得足够小（各 ≤1ms）。
--    也就是说这个索引现在的作用是 0。
--
--    ★ 那"全表扫"的那条呢：SELECT count(*) ... WHERE 语料谓词 实测是
--      SCAN messages，37591 行 112ms —— 但**没有生产代码跑这个形状**
--      （它是我为了看分布临时写的）。真实的两条都带前导列。
--
--    ★★ 保留理由同 ③：小、且删要再发一版迁移。但**不许**拿它当
--    "语料查询已经优化过"的依据。
CREATE INDEX IF NOT EXISTS idx_messages_learning
  ON messages(channel_id, learning_eligible, sent_at);
`
