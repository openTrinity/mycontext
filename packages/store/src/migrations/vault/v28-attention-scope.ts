/**
 * VAULT v28 — 数字分身的**监听范围**（关心范围）。
 *
 * ## 为什么它必须是一张独立的表
 *
 * 用户原话：「至少要分开两个吧，给用户的引导，学习的范围和监听范围」。
 *
 * 现状是**监听范围没有自己的存储**：分身关心哪些会话是从
 * `dh_conversation_configs.reply_mode/trigger_mode` **反推**出来的 ——
 * "配了非 silent 的那些会话就是它关心的"。那个反推有三个问题：
 *
 * ① 它把「范围」与「怎么回」混成一件事。用户想说"这个群我要它盯着，
 *    但先只出草稿"，那是范围内 + 草稿模式；而反推法只能表达一个维度。
 * ② 没有时间起点。学习范围有 `since`（往回学多久），监听范围需要的是
 *    **另一个语义**：从什么时候开始盯（默认"开启那一刻"，因为它只管实时流）。
 * ③ 没有"只增不减"的落点。用户要求范围只能增多，而 `reply_mode` 改成
 *    `silent` 天然是一次缩小 —— 那两件事必须能分开做。
 *
 * ## ★★★ 它与学习范围的关键差别：**只记实时流，不回溯**
 *
 * 用户原话：「不过他只需要记录实时流的内容」。所以这张表里没有
 * `until`，也没有回溯游标 —— `since` 的语义是"从这一刻起的新消息"，
 * 而不是"往回挖到这一天"。判据落在 `enabled_at`：早于它的消息一律
 * 不属于监听范围，即使那个会话在名单里。
 *
 * 这条不变式让「监听范围」永远不会触发一次历史回溯 —— 而那正是
 * 用户要把两个范围分开的原因：学习是"挖历史"，监听是"盯当下"。
 *
 * ## 只加表，不动已发布迁移（改了 checksum 就起不来，v18 踩过）
 */
export const VAULT_0028_ATTENTION_SCOPE = `
CREATE TABLE attention_scope (
  channel_id TEXT NOT NULL,
  -- 会话的 external_id（与 distill_sources.scope_json 的白名单同一套 id 空间）
  conversation_external_id TEXT NOT NULL,
  -- ★ 从这一刻起的新消息才算在范围内（unix ms）。
  -- 监听范围**不回溯**，所以这是一条硬边界而不是"建议起点"。
  enabled_at INTEGER NOT NULL,
  -- 1 = 在监听范围内。★ 不删行、只置 0：那是"只增不减"的审计痕迹，
  -- 也让"曾经关心过"与"从没关心过"可区分（后者查不到行）。
  active INTEGER NOT NULL DEFAULT 1,
  -- 谁加进来的：'user'（显式勾选）| 'learning'（跟随学习范围自动并入）
  -- ★ 记来源是为了让界面能说清"这个群为什么在名单里"。
  source TEXT NOT NULL DEFAULT 'user',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, conversation_external_id)
) WITHOUT ROWID;

-- 路由要频繁问"这个会话在不在范围内"——按 active 建部分索引
CREATE INDEX IF NOT EXISTS idx_attention_active
  ON attention_scope(channel_id, conversation_external_id) WHERE active = 1;

/*
 * 监听范围的**实时流覆盖面**：分身在这个范围里实际收到/放行了多少条。
 *
 * ★ 与 chat_coverage（v27）刻意分开而不是加一列：
 * 那张表记的是「采集采到了多少」（可以回溯、可以抽干），
 * 这张记的是「分身在实时流里见到了多少」——它**没有** drained 概念
 * （实时流永远没有"抽干"那一刻），也不该被回填补齐（补出来的不是它见过的）。
 * 混成一张表就要给一半的行留空 drained，而那种"某些行的某列没有意义"
 * 是最容易被读错的形状。
 */
CREATE TABLE attention_coverage (
  channel_id TEXT NOT NULL,
  day_bucket TEXT NOT NULL,                 -- 'YYYY-MM-DD'（本地时区，写入侧算好）
  -- 路由判定"在范围内"的条数
  routed_count INTEGER NOT NULL DEFAULT 0,
  -- 路由判定"不在范围内"而丢弃的条数。★ 必须记：只记放行的话
  -- "范围设窄了" 与 "那段时间没消息" 不可区分。
  skipped_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, day_bucket)
) WITHOUT ROWID;
`
