/**
 * VAULT v19 — 取消「本人已回过就作废草稿」这条规则，并加 agent 过程留痕表。
 *
 * ## 1. 恢复被「已回过」标掉的草稿
 *
 * v16/v17 有一条规则：同会话里出现时间更晚的**本人**消息 → 这一轮算结束 →
 * 把待审草稿标 `expired`。它的三处执行点（生成后丢弃 / 点发送时拒 /
 * 后台扫描作废）合起来的效果是：**用户看着一条草稿，它会自己消失，或者
 * 按下发送被告知"已过期"**。
 *
 * 那条规则的前提（"你回过了就说明不需要它了"）不成立：用户可能想补一句、
 * 换个说法，或者只是想看看 agent 会怎么答。而代价是已经花钱跑完的产出被扔掉。
 * 现在"你已回过"只影响**要不要自动发**（自动发一条冗余消息不可逆），
 * 草稿一律留着并标 `not_sent_reason = 'already_answered'`。
 *
 * 所以这里把历史上被它标掉的那些放回 `pending`。
 *
 * ★ **判据是 `expired_reason IS NULL`**：这条规则的两个 UPDATE
 * （v16 那条与 repo 里的 `expireAnsweredDrafts`）**都不写原因** ——
 * 实测库里 36 条 expired 的 `not_sent_reason` 为空（见 v17 文件头）。
 * 而 `over_draft_cap`（v18 的数量上限）与 `superseded_by_newer_message`
 * （v17）都**显式写了** `expired_reason`，所以按"原因为空"筛选恰好只命中
 * 「已回过」那一批，不会把别的规则的结果掀翻。
 *
 * `resolved_at` 一并清空：它现在不再是"处置时间"（那条草稿又回到待处理）。
 *
 * ## 2. `dh_run_trace`：agent 的思考过程
 *
 * 一行 = 一个 `ChatItem`（thinking / message / tool_call / plan / error），
 * 形状照 `search_chat_messages`（v5-search.ts）抄 —— 那套已经被搜索模块
 * 验证过，而且**落库形态与渲染形态相同**：「刷新后看到的」与「流式过程中
 * 看到的」由同一份数据驱动。两套渲染路径是 UI bug 的主要来源。
 *
 * ★ 为什么不复用 `dh_agent_runs.tool_calls_json`：它的文档形状是
 * `[{name,ms,ok}]` 摘要，装不下 thinking 正文与 toolcall 的参数/结果明细。
 *
 * `ON DELETE CASCADE`：run 被删（保留策略清理旧 run）时痕迹一起走，
 * 不留悬挂行。`UNIQUE(run_id, seq)` 让重复 append 幂等地失败而不是产出乱序。
 */
export const VAULT_0019_DRAFT_KEEP_AND_TRACE = `
UPDATE dh_drafts
   SET state = 'pending',
       resolved_at = NULL
 WHERE state = 'expired'
   AND expired_reason IS NULL;

CREATE TABLE dh_run_trace (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES dh_agent_runs(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,          -- 轮内序号，渲染顺序的唯一依据
  role         TEXT NOT NULL,             -- 'user' | 'assistant' | 'system'
  item_type    TEXT NOT NULL,             -- 'message' | 'thought' | 'tool_call' | 'plan' | 'error'
  content_json TEXT NOT NULL,             -- UnifiedContentBlock[]，渲染层解析
  tool_name    TEXT,                      -- item_type='tool_call' 时有值
  tool_status  TEXT,                      -- 'pending' | 'running' | 'success' | 'error'
  turn_id      TEXT,                      -- 同一轮共享，便于折叠与重放
  created_at   INTEGER NOT NULL,
  UNIQUE(run_id, seq)
);

CREATE INDEX idx_dh_run_trace_run ON dh_run_trace(run_id, seq);
`
