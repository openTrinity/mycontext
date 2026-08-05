/**
 * VAULT v2 — 原生留存 + 规范化。
 *
 * 分两层刻意如此：
 * · `raw_records` 存**未裁剪的原始 JSON**：任何解析 bug 都能从这里重放，
 *   不用重新去拉外部接口（而外部的历史窗口是有限的）。
 * · 其余表是规范化结果：查询走这些表，schema 由我们掌握。
 *
 * ★ 全局约束：**参与 UNIQUE 的列一律 `NOT NULL DEFAULT ''`，不允许可空。**
 *   SQLite 中 `NULL != NULL`，所以 `UNIQUE(a,b,c,d)` 在 `c IS NULL` 的行上
 *   **完全不生效** —— 实测连插 3 条同值会得到 3 行，随后的
 *   `ON CONFLICT DO UPDATE` 也不合并而是插第 4 行。
 *   幂等与增量合并这两个不变式都靠唯一键承载，所以这条不是风格问题。
 */
export const VAULT_0002_RAW_NORMALIZED = `
-- 原生不失真层。
CREATE TABLE raw_records (
  id            TEXT PRIMARY KEY,          -- ulid
  channel_id    TEXT NOT NULL,             -- 'dingtalk' | 'feishu'
  resource      TEXT NOT NULL,             -- 'chat.message'|'chat.conversation'|'contact.user'
                                           --   |'doc'|'minutes'
  -- ★ NOT NULL + 空串：平台主键（openMessageId 等）；无主键的资源
  --   （会话列表快照等）用 ''。可空会让下面的 UNIQUE 在这些行上完全失效。
  external_id   TEXT NOT NULL DEFAULT '',
  payload       TEXT,                      -- 原始 JSON；满 N 天后由保留策略置 NULL
  payload_hash  TEXT NOT NULL,             -- sha256(payload)，幂等去重键
  payload_pruned_at INTEGER,               -- 非空 = payload 已裁剪，让"为什么没有原文"可解释
  source        TEXT NOT NULL,             -- 'dws-cli'|'manual'
  superseded_by TEXT REFERENCES raw_records(id),  -- 内容变更（编辑/撤回）时指向新行
  fetched_at    INTEGER NOT NULL,
  UNIQUE(channel_id, resource, external_id, payload_hash)
);
CREATE INDEX idx_raw_fetched ON raw_records(channel_id, resource, fetched_at);
CREATE INDEX idx_raw_prunable ON raw_records(fetched_at) WHERE payload IS NOT NULL;

CREATE TABLE actors (
  id            TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL,
  external_id   TEXT NOT NULL,             -- 该渠道的主 ID（钉钉 openDingTalkId）
  kind          TEXT NOT NULL,             -- 'user'|'bot'|'system'
  display_name  TEXT,                      -- 可能是花名，★ 禁止用于 is_self 判定
  staff_id      TEXT,                      -- 工号
  is_self       INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER, last_seen_at INTEGER,
  UNIQUE(channel_id, external_id)
);
CREATE INDEX idx_actors_self ON actors(channel_id, is_self);

-- 本人身份权威表。蒸馏正确性的地基。
-- 实测三个坑决定了它必须单独存在：get-self 给权威 userId 但不给消息里用的
-- openDingTalkId；消息里本人显示花名（与 orgUserName 不一致）；
-- 按姓名搜索同名同姓会返回 5+ 个不同 ID。
CREATE TABLE channel_self_identity (
  channel_id         TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,        -- get-self 的权威 userId
  open_ids_json      TEXT NOT NULL,        -- [{kind,value}]，一人可能多 ID（飞书有三套）
  display_names_json TEXT NOT NULL,        -- ["高鹏","小周"] 仅展示，不参与判定
  corp_id            TEXT, corp_name TEXT,
  confirmed_at       INTEGER               -- NULL = 用户尚未确认 → 拒绝蒸馏
);

CREATE TABLE conversations (
  id                TEXT PRIMARY KEY,
  channel_id        TEXT NOT NULL,
  external_id       TEXT NOT NULL,         -- openConversationId
  type              TEXT NOT NULL,         -- 'direct'|'group'
  title             TEXT,
  member_count      INTEGER,
  is_self_involved  INTEGER NOT NULL DEFAULT 1,
  is_bot_channel    INTEGER NOT NULL DEFAULT 0,  -- 机器人/告警群，默认排除蒸馏
  last_message_at   INTEGER,
  created_at        INTEGER NOT NULL,
  UNIQUE(channel_id, external_id)
);
CREATE INDEX idx_conv_active ON conversations(channel_id, last_message_at DESC);

CREATE TABLE messages (
  id                  TEXT PRIMARY KEY,
  channel_id          TEXT NOT NULL,
  conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  external_id         TEXT NOT NULL,       -- openMessageId
  sender_actor_id     TEXT REFERENCES actors(id),
  -- ★ 冗余一份 sender 的外部 ID：is_self 判定是蒸馏最热的路径，不能每条都 JOIN
  --   actors；而且消息可能先到、通讯录后拉，那时 actors 里还没有这一行。
  sender_external_id  TEXT,
  sender_display_name TEXT,                -- 冗余快照（花名会变，要留住当时的样子）
  content_text        TEXT,
  content_json        TEXT,                -- 富文本/卡片结构
  quoted_external_id  TEXT,                -- 被引用消息的 openMessageId
  thread_id           TEXT,
  sent_at             INTEGER NOT NULL,    -- ★ 统一 unix ms（解析层按渠道时区归一）
  direction           TEXT NOT NULL,       -- 'inbound'|'outbound'
  -- ★ 可空且 NULL 表示「未判定」，不是 0。
  --   身份确认前把本人消息标成「他人」会**永久丢失人格语料**
  --   （之后没有任何信号能纠回来）。确认后跑一次回填 job 重算。
  is_self             INTEGER,
  -- 数字人自己发的消息标 'agent' 并**永久排除蒸馏**：auto 模式下自动回复量大，
  -- 不排除的话画像几轮内就坍缩成模型自己的口吻（自我强化漂移）。
  origin              TEXT NOT NULL DEFAULT 'human',
  has_media           INTEGER NOT NULL DEFAULT 0,
  raw_record_id       TEXT REFERENCES raw_records(id),
  revision            INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  UNIQUE(channel_id, external_id)
);
CREATE INDEX idx_msg_conv_time ON messages(conversation_id, sent_at DESC);
CREATE INDEX idx_msg_self_time ON messages(is_self, sent_at DESC);
CREATE INDEX idx_msg_sent      ON messages(sent_at DESC);

CREATE TABLE message_mentions (
  message_id        TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  actor_external_id TEXT NOT NULL,
  is_self           INTEGER NOT NULL DEFAULT 0,   -- @我 → 数字人的触发条件
  PRIMARY KEY(message_id, actor_external_id)
);
CREATE INDEX idx_mentions_self ON message_mentions(is_self, message_id);

-- 媒体：本轮只落库不检索。表先建好，二期启用采集不需要改 messages。
CREATE TABLE media_assets (
  id            TEXT PRIMARY KEY,
  message_id    TEXT REFERENCES messages(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,             -- 'image'|'file'|'audio'|'video'
  sha256        TEXT, path TEXT, mime TEXT, bytes INTEGER,
  original_name TEXT, downloaded_at INTEGER
);
CREATE INDEX idx_media_message ON media_assets(message_id);

-- 文档 / 听记：本轮建表不采集（UI 置灰标「即将支持」）。
CREATE TABLE documents (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, external_id TEXT NOT NULL,
  doc_type TEXT,                           -- 'dingdoc'|'pptx'|'xlsx'|'sheet'|'wiki'
  title TEXT, owner_actor_id TEXT, content_text TEXT, content_json TEXT,
  url TEXT, updated_at INTEGER, fetched_at INTEGER, raw_record_id TEXT,
  UNIQUE(channel_id, external_id)
);
CREATE TABLE minutes (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, external_id TEXT NOT NULL,
  title TEXT, started_at INTEGER, duration_sec INTEGER,
  summary_text TEXT, transcript_json TEXT, speakers_json TEXT,
  fetched_at INTEGER, raw_record_id TEXT,
  UNIQUE(channel_id, external_id)
);

-- 采集游标。
CREATE TABLE sync_cursors (
  scope TEXT PRIMARY KEY,                  -- 'dingtalk:chat:l2'|'dingtalk:chat:backfill:<cid>'
  -- ★ 游标语义（三个字段各管一件事，混用会静默丢消息）：
  --   window_start/window_end = 当前**正在处理**的时间窗（尚未确认完成）
  --   cursor                  = 该窗内分页的 nextCursor（首页 "0"）
  --   watermark               = **已完整落库**的时间水位；只有整个窗口的所有分页
  --                             都确认入库后才推进到 window_end
  -- 半途崩溃 → watermark 不动 → 下次整窗重跑（靠 payload_hash 幂等兜住）。
  -- 绝不允许「取一页推一次水位」：那会在崩溃时永久丢掉窗口尾部的消息。
  cursor TEXT, window_start INTEGER, window_end INTEGER,
  watermark INTEGER NOT NULL DEFAULT 0,
  page_count INTEGER NOT NULL DEFAULT 0,   -- 本窗已取页数，用于截断检测
  truncated INTEGER NOT NULL DEFAULT 0,    -- 疑似被服务端截断 → 二分切窗重取
  status TEXT NOT NULL DEFAULT 'idle',     -- 'idle'|'running'|'failed'|'done'
  last_error TEXT, attempts INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);

-- 廉价探针的快照：与上次比对决定是否值得付正文拉取的成本。
CREATE TABLE probe_snapshots (
  channel_id TEXT NOT NULL, conversation_external_id TEXT NOT NULL,
  last_msg_at INTEGER, unread_count INTEGER, observed_at INTEGER NOT NULL,
  PRIMARY KEY(channel_id, conversation_external_id)
);
`
