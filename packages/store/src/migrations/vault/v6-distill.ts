/**
 * VAULT v6 — 蒸馏（画像的唯一真源）。
 *
 * ## DB 为权威源，Markdown 为渲染产物
 *
 * 三条硬约束同时成立才需要这个设计：
 * ① 「全量支持增量维护的多维度 profile」→ 需要按
 *    `(facet, scope, scope_ref, key)` **精确定位与合并**，md 做不到（只能整段 diff）；
 * ② 「无证据的结论不允许进入画像」→ 需要 `evidence_json`（message_id 列表）
 *    + `revision`，md 存不下这个而不失可读性；
 * ③ Agent harness 最自然的读取方式是**读文件** → 必须有 md 形态给它。
 *
 * 所以 `profile_facets` 是唯一真源，Materializer 把它渲染成只读 md 包塞进
 * agent 的 workspace。md 被 agent 意外写坏也无所谓 —— 下一轮 materialize 覆盖回来。
 * **改画像永远改 DB，不改 md。**
 *
 * ## ★ scope_ref 必须 NOT NULL DEFAULT ''
 *
 * 首版设计成可空（"global 时为 NULL"），而 SQLite 中 `NULL != NULL` ——
 * 于是 UNIQUE 在**所有 global facet 上完全失效**（实测连插 3 条得 3 行，
 * ON CONFLICT 也不合并而是插第 4 行）。而 global 恰恰是 profile.md 的主要来源
 * → 每轮蒸馏都在堆重复行，合并时的 existing 查询随机命中一条，**画像不可复现**。
 */
export const VAULT_0006_DISTILL = `
CREATE TABLE profile_facets (
  id           TEXT PRIMARY KEY,
  -- identity|persona|tone|expertise|relations|routines|rules
  facet        TEXT NOT NULL,
  scope        TEXT NOT NULL,   -- 'global'|'conversation'|'contact'
  -- ★ NOT NULL + 空串表示 global。可空会让下面的 UNIQUE 在 global 行上完全失效。
  scope_ref    TEXT NOT NULL DEFAULT '',
  key          TEXT NOT NULL,   -- 'catchphrases'|'formality'|'response_latency_p50' …
  value_json   TEXT NOT NULL,
  confidence   REAL NOT NULL DEFAULT 0.5,
  -- ★ [messageId...]。**空数组 = 拒绝入库**（可信度与可审计的底线，不是可配置项）
  evidence_json TEXT NOT NULL,
  source       TEXT NOT NULL,   -- 'llm'|'stat'|'user' ← user 手改优先级最高
  -- 冲突时保留双结论（借鉴 colleague-skill merger 的三态设计）
  conflict_json TEXT,
  revision     INTEGER NOT NULL DEFAULT 1,
  window_start INTEGER, window_end INTEGER,
  updated_at   INTEGER NOT NULL,
  -- ★ 精确定位 = 增量合并的前提
  UNIQUE(facet, scope, scope_ref, key)
);
CREATE INDEX idx_facet_scope ON profile_facets(scope, scope_ref);

-- 历史版本（改前留档，可回滚可审计）
CREATE TABLE profile_facet_revisions (
  facet_id TEXT NOT NULL REFERENCES profile_facets(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  value_json TEXT NOT NULL, confidence REAL, evidence_json TEXT,
  replaced_at INTEGER NOT NULL,
  PRIMARY KEY(facet_id, revision)
);
-- 为什么 CASCADE 而不是保留孤儿：facet 被删（用户在审阅页删掉一条结论）后
-- 留着版本链没有消费者会读它，只会让「审计链断裂」在无人察觉的情况下发生。
-- 真正需要长期审计的是 profile_snapshots（已发布快照，不随 facet 删除消失）。

-- 发布快照：agent 读的是「已发布的」，不是「正在演进的」
CREATE TABLE profile_snapshots (
  id TEXT PRIMARY KEY, version INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL,           -- 'draft'|'published'|'archived'
  summary_md TEXT, facets_json TEXT NOT NULL,
  message_count INTEGER, cost_tokens INTEGER,
  created_at INTEGER NOT NULL, published_at INTEGER
);

-- map-reduce 任务表（可暂停续跑，Onboarding 的分段蒸馏进度读这里）
CREATE TABLE distill_tasks (
  id TEXT PRIMARY KEY, facet TEXT NOT NULL, scope TEXT NOT NULL,
  scope_ref TEXT NOT NULL DEFAULT '',   -- ★ 与 profile_facets 一致：空串表示 global
  window_start INTEGER NOT NULL, window_end INTEGER NOT NULL,
  state TEXT NOT NULL,            -- 'pending'|'running'|'done'|'failed'|'skipped'
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  input_message_count INTEGER, cost_tokens INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_distill_state ON distill_tasks(state, created_at);

-- Materializer 的产物索引（哪个 md 由哪些 facet revision 渲染而来）
CREATE TABLE profile_materializations (
  id TEXT PRIMARY KEY,
  -- ★ UNIQUE：否则同一路径堆多行，无法判定哪行是当前值
  target_path TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL, scope_ref TEXT NOT NULL DEFAULT '',
  source_facet_ids_json TEXT NOT NULL, content_hash TEXT NOT NULL,
  rendered_at INTEGER NOT NULL
);
`
