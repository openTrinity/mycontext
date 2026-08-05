/**
 * VAULT v4 — 检索索引（可随时重建，不进备份体积统计）。
 *
 * ## 为什么是独立 FTS 表 + 写入侧 bigram，而不是 external-content
 *
 * 实测（better-sqlite3 12.11.1 / SQLite 3.53.2）：
 * · `tokenize='unicode61'` 存「沙箱环境部署完成了」后 `MATCH '沙箱'` 命中 **0**
 *   —— unicode61 不切 CJK，整句被当成**一个 token**，只有整串精确匹配才命中。
 * · `tokenize='trigram'` 下 `MATCH '沙箱环'` 命中，但 `MATCH '沙箱'` 仍为 0
 *   （trigram 要求 ≥3 字符）。而中文两字词（沙箱/部署/发布）是搜索里最高频的形态。
 * · 写入时做应用侧 bigram 切分（`沙 沙箱 箱 箱环 …`）后，
 *   `沙箱`/`环境`/`部署`/`沙箱环境` **全部命中**。
 *
 * 而 `content='messages'`（external content）同步的是**原文**，
 * 应用侧根本没有插手分词的位置 —— 所以必须放弃 external-content 模式。
 *
 * ## 为什么是 contentless（content=''）
 *
 * 四组实测（2 万条中文，含 WAL checkpoint）：
 *   contentful 6412KB / **contentless 3336KB** / 存原文 3332KB / detail='none' 2352KB
 * contentless 只有 contentful 的 52%，且与存原文几乎一样大 ——
 * bigram 串对用户零展示价值（snippet 应从 `messages.content_text` 取原句），
 * 存两份纯浪费。`bm25()` 在 contentless 下**正常**（-2.392，与 contentful 一致）。
 * `detail='none'` 虽然更小，但 `bm25()` **全为 0**、排序完全失效 → **不可用**。
 *
 * ## contentless 的两个陷阱（都已实测）
 *
 * 1. **UNINDEXED 列读出来是 NULL** → 不能靠 `message_id UNINDEXED` 存映射，
 *    必须走 rowid ↔ `messages_fts_state` 的显式映射表。
 * 2. `DELETE FROM fts WHERE rowid=?` 直接报「cannot DELETE from contentless
 *    fts5 table」→ 建表**必须**带 `contentless_delete=1`（SQLite ≥3.43）。
 *    消息撤回/编辑会触发重建，所以这是必需参数而非可选优化。
 */
export const VAULT_0004_INDEX = `
CREATE VIRTUAL TABLE messages_fts USING fts5(
  seg,                        -- 应用侧 bigram 化后的可检索串（不是原文）
  tokenize='unicode61',       -- 对已切好的串来说 unicode61 足够
  content='',                 -- ★ contentless：体积减半，bm25 仍可用
  contentless_delete=1        -- ★ 否则无法 DELETE（实测直接报错）
);

-- rowid ↔ message_id 的**唯一**映射来源。
-- （原设计靠 FTS 的 UNINDEXED 列，实测在 contentless 下读出来是 NULL。）
CREATE TABLE messages_fts_state (
  rowid_alias     INTEGER PRIMARY KEY AUTOINCREMENT,  -- = messages_fts 的 rowid
  message_id      TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,          -- 作用域过滤走这里（有索引），不放进 FTS
  content_hash    TEXT NOT NULL,          -- 决定是否需要重建该行
  indexed_at      INTEGER NOT NULL
);
CREATE INDEX idx_fts_state_conv ON messages_fts_state(conversation_id);

CREATE TABLE message_vectors (
  message_id  TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  dim         INTEGER NOT NULL,
  -- ★ 默认 int8 量化。实测 1024 维 5 万条：float32 = 195MB / 35.7ms，
  --   int8 = 49MB / 38.6ms —— 内存降到 1/4 而耗时几乎不变（+8%）。
  --   同样内存预算下常驻上限从 5 万提到 20 万条。
  embedding   BLOB NOT NULL,
  quant       TEXT NOT NULL DEFAULT 'int8',   -- 'int8'|'float32'
  scale       REAL,                            -- int8 反量化系数（每行独立）
  model       TEXT NOT NULL,                   -- 换模型/换维度后「要重建哪些行」一目了然
  embedded_at INTEGER NOT NULL
);
CREATE INDEX idx_vectors_model ON message_vectors(model, dim);
`
