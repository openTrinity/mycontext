/**
 * VAULT v7 — 数字人模块（`dh_*`）。
 *
 * ## 默认 off + 默认 draft 是刻意的
 *
 * 数字人以本人身份发消息，误发的社交成本**不可逆**。
 * 让用户在看过草稿质量后再逐会话开 auto，比默认开着让他事后灭火要好。
 *
 * ## ★ dh_send_grants 是外部约束的建模，不是我们的可选项
 *
 * 实测来源应用的 `chmod --help` 原文：「chat.* scope **每次执行都需要用户在
 * 宿主 UI 中确认，模型无法静默绕过**」，`--ttl` **默认只有 24h**。
 *
 * 不建这张表的后果：用户开了 auto，**次日起每次发送都失败或弹窗**，
 * 而其余 7 条 policy 全都通过了 → `decision_reason` 也解释不了为什么没发出去。
 * 这是"功能昨天还好好的"这类最难排查的故障。
 *
 * ## `expires_at` 是本地推算值，宿主侧撤销我们感知不到
 *
 * 所以正确性**不依赖本地 TTL**：`send` 返回权限类错误时立刻标 `revoked_at`
 * + 降级为 draft + **不重试**。本地 TTL 只是优化（提前拦住必然失败的调用、
 * 驱动续授提醒）。
 */
export const VAULT_0007_PERSONA = `
-- 每会话的监听与回复配置
CREATE TABLE dh_conversation_configs (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  listening    INTEGER NOT NULL DEFAULT 0,      -- ★ 默认不监听
  reply_mode   TEXT NOT NULL DEFAULT 'draft',   -- 'auto'|'draft'|'silent'
  trigger_mode TEXT NOT NULL DEFAULT 'mention', -- 'all'|'mention'|'keyword'
  keywords_json TEXT,
  distill_enabled INTEGER NOT NULL DEFAULT 1,
  persona_note TEXT,                            -- 用户对本会话的额外指示 → 进 spec.md
  updated_at   INTEGER NOT NULL
);

-- 全局设置（工作时间、频率上限、禁止词、kill switch、embedding 预算）
CREATE TABLE dh_settings (
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL
);

-- 入站信箱：内存队列的持久化镜像，崩溃重启不丢待处理消息
CREATE TABLE dh_inbox (
  message_id      TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'pending',  -- pending|processing|done|dropped
  -- 命中即丢弃并记原因：用户能在日志里看到"为什么没回"
  drop_reason     TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  enqueued_at     INTEGER NOT NULL, processed_at INTEGER
);
CREATE INDEX idx_dh_inbox_state ON dh_inbox(state, enqueued_at);

-- 每会话 Agent 的 session 绑定（与搜索同构：acp id 可空 + 可重建）
CREATE TABLE dh_agent_sessions (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  acp_session_id  TEXT, acp_cwd TEXT NOT NULL,
  profile_snapshot_version INTEGER,              -- 用的哪版画像（可复现）
  rolling_summary TEXT,                          -- 超窗后的滚动摘要
  turn_count      INTEGER NOT NULL DEFAULT 0,
  last_active_at  INTEGER, evicted_at INTEGER    -- LRU 回收时间（可观测）
);

-- 每 turn 一条：运行日志 / Dashboard 统计 / 试运行对比都读这张表
CREATE TABLE dh_agent_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL, trigger_message_id TEXT,
  scene_id TEXT, model TEXT,
  input_summary TEXT,
  tool_calls_json TEXT,                          -- [{name,ms,ok}]
  draft_text TEXT, confidence REAL, risks_json TEXT,
  decision TEXT NOT NULL,        -- 'auto_sent'|'drafted'|'silent'|'escalated'|'error'
  -- ★ 未自动发送时**必填**：静默降级是最难调试的产品行为。
  --   用户开了 auto 却总在出草稿，不告诉他命中了哪条（不在工作时间？
  --   置信度 0.71？命中禁止词？授权过期？）他唯一能做的就是放弃这个功能。
  decision_reason TEXT,
  latency_ms INTEGER, cost_tokens INTEGER, error TEXT,
  is_dry_run INTEGER NOT NULL DEFAULT 0,         -- 试运行留痕
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_dh_runs_conv ON dh_agent_runs(conversation_id, created_at DESC);

-- 草稿箱
CREATE TABLE dh_drafts (
  id TEXT PRIMARY KEY, run_id TEXT REFERENCES dh_agent_runs(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL, reply_to_external_id TEXT,
  text TEXT NOT NULL, edited_text TEXT,
  state TEXT NOT NULL DEFAULT 'pending',         -- pending|sent|discarded|expired
  citations_json TEXT, not_sent_reason TEXT,
  created_at INTEGER NOT NULL, resolved_at INTEGER
);
CREATE INDEX idx_dh_drafts_state ON dh_drafts(state, created_at DESC);

-- 发送授权状态（外部强制的那一层）
CREATE TABLE dh_send_grants (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL,                 -- 'chat.message:send'
  agent_code      TEXT NOT NULL DEFAULT 'wukong',
  grant_type      TEXT NOT NULL,                 -- 'once'|'session'|'timed'|'permanent'
  perm_params_json TEXT NOT NULL,                -- {"openCid":"cid..."} 原始授权维度
  ttl             TEXT,                          -- '24h'|'7d'（我们请求的值）
  granted_at      INTEGER NOT NULL,
  -- 本地推算值。宿主侧手动撤销我们感知不到 → 正确性不依赖它，见文件头注释
  expires_at      INTEGER,
  revoked_at      INTEGER,
  last_verified_at INTEGER,                      -- 上次真发成功的时间
  UNIQUE(conversation_id, scope, agent_code)
);
CREATE INDEX idx_dh_grants_expiry ON dh_send_grants(expires_at);

-- 发送意图与幂等（SendGuard 的落点）
CREATE TABLE dh_send_attempts (
  -- ★ 必须原样作为 send 命令的 --uuid 传入：实测该参数「相同 uuid 在 24h 内
  --   不会重复发送」→ 服务端幂等是崩溃重启重发的**第二道**防线，
  --   不是本地占位符
  idempotency_key TEXT PRIMARY KEY,
  draft_id TEXT, conversation_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,        -- 'group'|'user'|'open_id'（三选一必填）
  target_external_id TEXT NOT NULL,
  at_external_ids TEXT,             -- 逗号分隔；正文必须含对应占位符
  -- 发送前按 draft_id 重读库并比对它：**发的必须是被批准的那条**
  content_hash TEXT NOT NULL,
  grant_id TEXT REFERENCES dh_send_grants(id),
  state TEXT NOT NULL,              -- 'reserved'|'sent'|'failed'|'blocked_no_grant'
  sent_message_external_id TEXT,
  used_dry_run INTEGER NOT NULL DEFAULT 0,
  error TEXT, attempted_at INTEGER NOT NULL, sent_at INTEGER
);
CREATE INDEX idx_dh_attempts_conv ON dh_send_attempts(conversation_id, attempted_at DESC);
`
