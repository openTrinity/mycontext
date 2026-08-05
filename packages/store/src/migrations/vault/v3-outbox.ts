/**
 * VAULT v3 — Outbox（增量知识流）。
 *
 * 一张单调递增的变更日志 + 每个消费者一行游标。
 * 三个消费者（本地索引 / 蒸馏 / 算法侧图谱）各自独立推进，互不阻塞。
 *
 * 核心不变式：**规范表与 Outbox 在同一个事务里写**。
 * 否则消费者会读到 seq 却查不到实体（先写 Outbox 后崩溃），
 * 或永久漏掉变更（先写规范表后崩溃）。
 * 「数据可见 ⇔ 变更可见」不能靠调用方自觉，所以写入只暴露一个组合函数。
 */
export const VAULT_0003_OUTBOX = `
CREATE TABLE knowledge_changelog (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,  -- 游标就是它，全局单调递增
  op          TEXT NOT NULL,                      -- 'upsert'|'delete'
  entity_type TEXT NOT NULL,                      -- 'message'|'conversation'|'actor'
                                                  --   |'document'|'minutes'|'note'
  entity_id   TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  domain      TEXT NOT NULL,                      -- 'chat'|'doc'|'minutes'|'contact'
  occurred_at INTEGER NOT NULL,                   -- 业务时间（消息发出的时间）
  emitted_at  INTEGER NOT NULL,                   -- 写入 Outbox 的时间
  payload_ref TEXT,                               -- → raw_records.id，不冗余大字段
  digest      TEXT NOT NULL                       -- 规范化内容 hash，消费者可跳过无变化项
);
CREATE INDEX idx_changelog_domain ON knowledge_changelog(domain, seq);
CREATE INDEX idx_changelog_entity ON knowledge_changelog(entity_type, entity_id);

CREATE TABLE consumer_cursors (
  consumer_id       TEXT PRIMARY KEY,   -- 'local-index-fts'|'local-index-vector'|'distill'
                                        --   |'persona-fallback'|'kl-graph'|'retention'
  acked_seq         INTEGER NOT NULL DEFAULT 0,
  -- 下面四个字段解决「清理水位被永久阻塞」与「静默缺数据」这对对称的失败模式：
  --   · 未注册的消费者：MIN() 只在已注册者上取值 → 历史被裁剪 → 它后来注册时
  --     acked_seq=0，于是**静默缺数据**
  --   · 长期离线的消费者：MIN() 永远卡在旧值 → Outbox **无限增长**直到撑爆库
  required          INTEGER NOT NULL DEFAULT 1,   -- 是否参与阻塞清理水位
  registered_at     INTEGER NOT NULL,
  heartbeat_at      INTEGER,                      -- 消费者活跃心跳
  stale_after_ms    INTEGER NOT NULL DEFAULT 604800000,  -- 7 天未心跳 → 视为离线
  needs_full_rebuild INTEGER NOT NULL DEFAULT 0,  -- 因裁剪而必须全量重建（要告警，不能静默）
  -- 租约：防两个进程同时消费同一游标。
  -- 规则（首版只有字段没有规则，崩溃后 lease 未释放会让该消费者永久卡死）：
  --   lease_expires_at < now() 时任何进程可抢占（CAS 更新 lease_owner）；
  --   TTL 60s，消费中每 20s 续租；抢占后**从 acked_seq 重放** ——
  --   所以消费侧的写入必须幂等，这是抢占安全的前提而非可选项。
  lease_owner       TEXT, lease_expires_at INTEGER,
  last_error TEXT, last_success_at INTEGER, updated_at INTEGER NOT NULL
);

-- 向量建索引的失败计数：状态页要显示「向量待建 N / 失败 M」。
-- 单独一张表而不是塞进 consumer_cursors：一批失败不能卡住整条游标
-- （远程 embedding 会限流，卡住的话纯本地的 FTS 也建不出来）。
CREATE TABLE vector_failures (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  attempts   INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  last_attempt_at INTEGER NOT NULL
);
`
