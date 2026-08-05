/**
 * VAULT v9 — 引导进度 + 蒸馏资料源。
 *
 * ## 为什么「引导进度」必须落库而不是看"有没有授权"
 *
 * 首版判据是 `已登录 && !dismissed && !hasAnyAuthorized()`。
 * 在只有"授权"一步时它是对的；但引导现在有 4 步
 * （授权 / 数字人 / 蒸馏源 / 蒸馏进度），于是**授权成功就等于跳过后三步** ——
 * 实测症状：`vault_settings` 里没有任何 onboarding 键（说明没被 dismiss），
 * 但 `dws auth status` 返回 authenticated → 引导直接不出现。
 *
 * 「授权完成」与「引导完成」是两件事，所以引导需要自己的进度记录。
 * 每步一行而不是一个 JSON blob：
 * · 单步重跑只更新那一行（blob 要读改写，并发下会互相覆盖）；
 * · `payload_json` 让每步存自己的产物（数字人名字 / 选了哪些源），
 *   而下一次重跑时那些选择应当**还在**（用户重走引导不该从零填）。
 *
 * ## 为什么蒸馏源单独一张表
 *
 * 它是**用户的选择**（哪些会话 / 什么时间范围 / 哪几类数据），
 * 与 `distill_tasks`（执行状态）是不同的生命周期：
 * 任务跑完会被清理或归档，而选择要一直留着（下一轮增量蒸馏还要用）。
 * 混在一张表里会让"清理已完成任务"顺手把用户的选择也删掉。
 */
export const VAULT_0009_ONBOARDING = `
-- 引导进度：每步一行。
CREATE TABLE onboarding_progress (
  -- 'channel' | 'persona' | 'sources' | 'distill'
  step        TEXT PRIMARY KEY,
  -- 'pending' | 'done' | 'skipped'
  --   skipped 与 pending 必须可区分：用户明确跳过某步之后，
  --   重新进引导时该步应当显示"已跳过"而不是"还没做"。
  state       TEXT NOT NULL DEFAULT 'pending',
  -- 该步的产物（数字人名字/形象、选了哪些源…）。重跑引导时用它回填表单。
  payload_json TEXT,
  updated_at  INTEGER NOT NULL
);

-- 蒸馏资料源：用户选了哪些数据、什么范围。
CREATE TABLE distill_sources (
  -- 'chat' | 'minutes' | 'doc' | 'mail' | 'calendar' | 'todo'
  --   | 'attendance' | 'ding' | 'drive'
  kind        TEXT PRIMARY KEY,
  enabled     INTEGER NOT NULL DEFAULT 0,
  /*
   * 范围：{ since, until, chatKinds: ['direct'|'group'], conversationIds: [...] }
   *
   * 存 JSON 而不是拆成列：各数据源的范围维度**不一样**
   * （聊天有会话白名单，日历只有时间范围，考勤按月）。
   * 拆列会得到一张一半是 NULL 的宽表，而"这一列对这个源有没有意义"
   * 只能靠读代码知道。
   */
  scope_json  TEXT,
  /*
   * ★ 增量水位：已蒸馏到哪个 Outbox seq。
   *
   * 重新走引导时靠它区分「重置」与「增量」：
   * · 增量 —— 从这个 seq 之后的消息继续（天然去重，不重复烧 LLM）；
   * · 重置 —— 置 0 并清掉相关 facet（用户明确要求重来）。
   *
   * 不复用 consumer_cursors：那张表是**消费者**级的（一个 distill 消费者），
   * 而这里要的是**每个源**各自的水位（聊天蒸馏完了、邮箱还没开）。
   */
  last_synced_seq INTEGER NOT NULL DEFAULT 0,
  -- 'idle' | 'running' | 'failed'；失败原因给 UI 显示，不静默重试
  state       TEXT NOT NULL DEFAULT 'idle',
  last_error  TEXT,
  updated_at  INTEGER NOT NULL
);
`
