/**
 * VAULT v24 — 听记的覆盖面记账。
 *
 * ## 为什么需要它：抽干之后"抽没抽干"必须能被问出来
 *
 * 首版 `runMinutes` 只取列表首页（`--limit 50`），也就是**第 51 场之前的
 * 会议永远采不到**。而这个缺失没有任何出口：不落库、不上报、不记日志。
 * 状态页的听记计数会稳定停在 50，与"这个账号一共 50 场会"完全同形 ——
 * 正是 CLAUDE.md 第 4 节说的那类静默降级。
 *
 * 抽干本身是采集侧的改动，但"这一轮抽干了吗"是个**事实**，得存下来：
 * · 状态页要显示它（日志用户看不到，而这一条恰恰是用户会问的）；
 * · 它跨重启有效 —— 应用刚起来还没跑第一轮时，上一轮的结论仍然是
 *   当前最好的答案。存在内存里的话每次重启都退化成"未知"。
 *
 * ## 为什么是新表，而不是在 `sync_cursors` 里开一个 scope
 *
 * 那张表的三个字段（`window_start`/`window_end`/`watermark`）是为
 * **「时间窗 + 水位」**设计的，而它的文件头明确写着这三个字段混用会
 * 静默丢消息。听记**没有水位**（`minutes list all` 的 `--start/--end` 是
 * 可选筛选而非水位语义），硬塞进去就要把 `watermark` 挪作他用 ——
 * 那会污染一套已经很容易搞错的语义。
 *
 * 一张两列小表（实际只有一行：一个渠道一行）语义干净：
 * `drained = 0` 就是"上一轮没抽干"，没有第二种读法。
 *
 * ## `minutes` 那两列：为什么不靠解析 `transcript_json`
 *
 * 转写抽干之后 `transcript_json` 里已经带了 `hasNext` 与 `pages`
 * （见 dingtalk/minutes.ts 的 `body`）。但状态页要问的是
 * **「有几场会的转写没抽干」** —— 那是一个跨行的聚合，
 * 用 SQLite 的 JSON 函数去 `json_extract` 每一行既慢又要求那一列
 * 永远是合法 JSON（它是我们自己写的，但历史行不是这个形状）。
 *
 * 单独两列让这个问题变成 `count(*) WHERE transcript_truncated = 1`。
 *
 * · `transcript_pages` —— 实际抽了几页。NULL = 老数据（那时只取第一页）。
 * · `transcript_truncated` —— 1 = 撞了上限、没抽干。
 *
 * ★ 两列都可空、无默认值，所以已有行自动为 NULL。NULL 的语义是
 * **「不知道」**而不是"抽干了"—— 老数据确实只有第一页，但我们没法区分
 * 「第一页就是全部」与「还有后续页」，因为那个信息当时没存下来。
 * 不给默认值 0 是刻意的：那会把"不知道"伪装成"抽干了"。
 *
 * ## `ALTER TABLE ADD COLUMN` 对已有行安全
 *
 * 与 v20 / v23 同一个结论。不能改 v8（`media-minutes`，已发布）——
 * 改它 checksum 就变，已迁移的 vault 启动时命中 `DB_MIGRATION_FAILED`，
 * 应用直接起不来（v18 那批真踩过，见 v18-draft-cap 文件头）。
 */
export const VAULT_0024_MINUTES_COVERAGE = `
ALTER TABLE minutes ADD COLUMN transcript_pages INTEGER;
ALTER TABLE minutes ADD COLUMN transcript_truncated INTEGER;

-- 「转写没抽干」的那些会议：状态页要 count，而它们是少数 → 部分索引。
CREATE INDEX IF NOT EXISTS idx_minutes_transcript_truncated
  ON minutes(channel_id) WHERE transcript_truncated = 1;

-- 列表抽干的记账。一个渠道一行（当前只有钉钉），所以没有额外索引。
CREATE TABLE minutes_coverage (
  channel_id TEXT PRIMARY KEY,
  -- 1 = 上一轮把 minutes list all 翻到 hasMore=false；0 = 撞了页数预算
  drained INTEGER NOT NULL DEFAULT 0,
  -- 已覆盖到的最早会议时间（unix ms）。NULL = 库里还没有会议。
  -- ★ 与 backfill 的 coveredFrom 同一个角色：它让"还差多少"可被看见。
  earliest_started_at INTEGER,
  -- 上一轮一共列了多少条（跨全部页）。与 minutes 表的行数不同：
  -- 那个是累积值，这个是"这一轮渠道说它有多少"。
  listed_total INTEGER NOT NULL DEFAULT 0,
  -- 上一轮什么时候跑的。让"这个结论有多旧"可判断。
  last_run_at INTEGER NOT NULL
);
`
