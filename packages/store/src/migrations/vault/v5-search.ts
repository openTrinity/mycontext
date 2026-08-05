/**
 * VAULT v5 — 搜索模块（`search_chat_session*`，命名由需求指定）。
 *
 * ## `acp_session_id` 可为空是本表最关键的设计
 *
 * 它把「我们的会话」与「opencode 的 session」解耦。
 * UI 渲染永远读 `search_chat_messages`，所以 opencode 换机器 / 清缓存 / 升级
 * 导致 session 失效时，**用户看到的历史一条不少** ——
 * 只是继续对话时后台静默重建 ACP session 并回灌上下文。
 *
 * 反过来（把 opencode 的 session 当唯一真源）会让「换台机器历史就没了」
 * 变成常态，而那是用户完全无法接受也无法理解的。
 *
 * ## 一行 = 一个 ChatItem
 *
 * 不是「一条消息里嵌一堆 part」：流式渲染下前者好处理得多
 * （tool_call 状态变化只更新一行），而且**落库形态与渲染形态相同** ——
 * 「刷新后看到的」与「流式过程中看到的」由同一份数据驱动。
 * 两套渲染路径是 UI bug 的主要来源。
 */
export const VAULT_0005_SEARCH = `
CREATE TABLE search_chat_sessions (
  id              TEXT PRIMARY KEY,              -- 我们的 id（UI 与路由用它）
  title           TEXT,                          -- 首条消息生成；可重命名
  -- ★ 可为空：未建 / 已失效。见文件头注释
  acp_session_id  TEXT,
  acp_cwd         TEXT NOT NULL,                 -- workspace 路径（resume 必需参数）
  harness_id      TEXT NOT NULL DEFAULT 'opencode-acp',
  model_role      TEXT NOT NULL DEFAULT 'harness.search',
  scene_id        TEXT,                          -- 最近一次命中的搜索场景
  state           TEXT NOT NULL DEFAULT 'idle',  -- 'idle'|'streaming'|'error'
  pinned          INTEGER NOT NULL DEFAULT 0,
  message_count   INTEGER NOT NULL DEFAULT 0,
  last_active_at  INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  archived_at     INTEGER
);
CREATE INDEX idx_search_sess_active
  ON search_chat_sessions(archived_at, last_active_at DESC);

CREATE TABLE search_chat_messages (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES search_chat_sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,          -- 会话内序号，渲染顺序的唯一依据
  role         TEXT NOT NULL,             -- 'user'|'assistant'|'system'
  item_type    TEXT NOT NULL,             -- 'message'|'thought'|'tool_call'|'plan'|'error'
  content_json TEXT NOT NULL,             -- UnifiedContentBlock[]
  tool_name    TEXT,                      -- item_type='tool_call' 时
  tool_status  TEXT,                      -- 'pending'|'running'|'success'|'error'
  turn_id      TEXT,                      -- 同一轮的 items 共享，便于折叠与重放
  usage_json   TEXT,                      -- token 用量
  created_at   INTEGER NOT NULL,
  -- 只防同 seq。防"同内容换新 seq"要靠 reducer 的内容 hash 去重
  UNIQUE(session_id, seq)
);
CREATE INDEX idx_search_msg_session ON search_chat_messages(session_id, seq);

-- 附件（左下角「添加文件」的产物）
CREATE TABLE search_chat_attachments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES search_chat_sessions(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES search_chat_messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                     -- 'file'|'image'
  original_name TEXT NOT NULL, path TEXT NOT NULL,
  mime TEXT, bytes INTEGER, sha256 TEXT, created_at INTEGER NOT NULL
);

-- 来源引用：答案里的 [n] → 可回跳的原始消息
CREATE TABLE sr_citations (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES search_chat_messages(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,               -- 答案里的 [1][2]
  source TEXT NOT NULL,                   -- 'local'|'kl'|'dws'
  entity_type TEXT NOT NULL,              -- 'message'|'document'|'fact'|'entity'|'community'
  entity_id TEXT, external_id TEXT,       -- external_id 用于跳转回来源应用
  conversation_id TEXT, occurred_at INTEGER,
  snippet TEXT, score REAL,
  retrieved_by_json TEXT                  -- ['local.vector','kl.ask'] 多路命中
);
CREATE INDEX idx_citations_message ON sr_citations(message_id, ordinal);

-- 召回调试（开发者模式常驻，正式版折叠）。
-- 「为什么这条排在前面」是搜索里最常被问的问题，各路排名都留下来才不用靠猜。
CREATE TABLE sr_search_runs (
  id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT,
  query TEXT NOT NULL, scene_id TEXT,
  recall_debug_json TEXT,                 -- 各路耗时/命中数/融合前后排序
  latency_ms INTEGER, cost_tokens INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX idx_search_runs_session ON sr_search_runs(session_id, created_at DESC);

CREATE TABLE sr_saved_queries (
  id TEXT PRIMARY KEY, query TEXT NOT NULL, label TEXT, created_at INTEGER NOT NULL
);
`
