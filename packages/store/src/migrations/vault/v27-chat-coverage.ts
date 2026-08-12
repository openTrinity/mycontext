/**
 * VAULT v27 — 聊天的覆盖面记账（「这段日期我到底有多少」）。
 *
 * ## 用户要的
 *
 * 「要说明现在已有那部分日期的那部分业务数据，以及显示出来要多少和
 *   共已经有了多少了，不管是消息还是听记，文档等」
 *
 * 听记那半已经有了（`minutes_coverage`，v24）。这一条补聊天那半。
 *
 * ## ★★★ 「共需多少」这个分母**拿不到真值** —— 所以不存它
 *
 * 渠道 API 不提供"某会话某天共有多少条"（`packages/channels/src/types.ts`
 * 只有 `hasMore` / `nextCursor`）。要一个百分比就只能编分母，而这个项目
 * 已经因为编分母吃过一次：仪表盘那句红字「才学了 0.0%」是假的，
 * 它拿一个没推过的游标当分子。
 *
 * 所以这张表照 `minutes_coverage` 的先例，只存**能观测到的三件事**：
 *
 * · `local_count` —— 库里这一天有多少条（我们数出来的，真值）；
 * · `listed_total` —— 这一轮渠道列出了多少条（渠道说的，可能翻页翻不全）；
 * · `drained` —— 这一轮翻到 `hasMore=false` 了吗（1 = 这天可以认为齐了）。
 *
 * 界面因此能说「这段日期已采完 / 还在回溯」，而**不编百分比**。
 * `drained=1` 时 `local_count` 就是那天的全部；`drained=0` 时它是下界 ——
 * 两种情况用户看到的文案不同，而不是同一个可疑的数字。
 *
 * ## 为什么按 (会话, 天) 而不是只按天
 *
 * 用户的问题实际是"这个群这段时间齐不齐"。只按天聚合的话，一个会话
 * 抽干了、另一个没抽干，那一天会被记成"没抽干"——于是永远显示
 * "还在回溯"，即使 91 个会话里只有 1 个卡住。按会话存，聚合是
 * `MIN(drained)`（有一个没齐就不算齐），而**哪个**没齐也能问出来。
 *
 * ★ 天用 `day_bucket`（`YYYY-MM-DD` 文本，本地时区）而不是时间戳区间：
 * 主键要能被 upsert 命中，而"这条消息属于哪一天"这个判断只该做一次
 * （在写入侧），不该让每个读的人各算一遍时区。
 *
 * ## 为什么是新表而不是塞进 sync_cursors
 *
 * 与 v24 同一个结论：`sync_cursors` 的三个字段是为「时间窗 + 水位」
 * 设计的，它的文件头明确写着混用会静默丢消息。覆盖面**没有水位**语义。
 *
 * ## 只加表，不动任何已发布迁移
 *
 * 改已发布的迁移会让 checksum 变，已迁移的 vault 启动即
 * `DB_MIGRATION_FAILED`（v18 那批真踩过）。
 */
export const VAULT_0027_CHAT_COVERAGE = `
CREATE TABLE chat_coverage (
  channel_id TEXT NOT NULL,
  -- 会话的 external_id。★ 与 distill_sources.scope_json 里的白名单同一套 id。
  conversation_external_id TEXT NOT NULL,
  -- 'YYYY-MM-DD'（按写入侧的本地时区算好再存，读侧不再换算）
  day_bucket TEXT NOT NULL,
  -- 库里这一天有多少条（真值：我们自己数的）
  local_count INTEGER NOT NULL DEFAULT 0,
  -- 这一轮渠道一共列了多少条。★ 与 local_count 不同：这个是"渠道说有多少"，
  -- 而它在没抽干时是**下界**，不是总数。NULL = 这一轮没走列表（只有实时流）。
  listed_total INTEGER,
  -- 1 = 这一天翻到 hasMore=false（可以认为齐了）；0 = 还在回溯
  -- ★ 没有默认 1：默认"齐了"会把"不知道"伪装成"采完了"（v24 同一个取舍）。
  drained INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, conversation_external_id, day_bucket)
) WITHOUT ROWID;

-- 「这段日期齐不齐」是按天跨会话聚合的（MIN(drained) / SUM(local_count)），
-- 主键的前缀是 channel_id+会话，帮不上按天的范围扫 → 单独一条。
CREATE INDEX IF NOT EXISTS idx_chat_coverage_day
  ON chat_coverage(channel_id, day_bucket);

-- 「哪些会话还没抽干」——少数行，部分索引（与 v24 的 truncated 同一个手法）。
CREATE INDEX IF NOT EXISTS idx_chat_coverage_not_drained
  ON chat_coverage(channel_id, conversation_external_id) WHERE drained = 0;
`
