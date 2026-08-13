/**
 * VAULT v29 — 文档的覆盖面记账（补齐"三类数据"的最后一类）。
 *
 * ## 用户要的
 *
 * 「要说明现在已有那部分日期的那部分业务数据，以及显示出来要多少和
 *   共已经有了多少了，**不管是消息还是听记，文档等**」
 *
 * 消息那半在 v27（`chat_coverage`），听记那半在 v24（`minutes_coverage`）。
 * 文档那半**一直缺着** —— 于是界面对文档只能给一个总条数，说不出
 * "这段日期齐没齐"。而"两类能回答、一类不能"是最难解释的状态：
 * 用户会以为文档那栏坏了。
 *
 * ## ★★★ 同样**不存**"共需多少"那个分母
 *
 * 与 v24 / v27 一字不差的理由：渠道的文档列表接口只给 `hasMore` /
 * `nextCursor`，不给"某个知识库共有多少篇"。要百分比就只能编，
 * 而这个项目已经为编分母吃过一次（仪表盘那句假的「才学了 0.0%」）。
 *
 * 所以只存能观测到的三件事，判据落在 `drained` 上：
 * · `drained = 1` → 这一天翻到了 `hasMore=false`，`local_count` **就是**全部；
 * · `drained = 0` → 还在回溯，`local_count` 是**下界**。
 *
 * ## ★★ 按 (space, 天) 而不是 (文档, 天)
 *
 * 这是与 `chat_coverage` 唯一的形状差异，理由在**分页的粒度**上：
 * 聊天是按会话翻页的（一个会话一条游标），所以"齐没齐"是关于会话的话；
 * 文档是按**空间**（知识库 / 云盘目录）翻页的，一篇文档不存在"翻页翻完了"
 * 这件事。
 *
 * 硬套成 per-document 会要求调用方回答"哪些文档齐了" —— 而那个信息在
 * 一页翻完的那一刻并不存在（没出现的文档可能是那天真没更新，
 * 也可能压根不在这一页）。那正是 v27 里 `markDaysDrained` 只 UPDATE
 * 不 INSERT 的同一个坑。
 *
 * ★ `space_external_id` 允许是空串：有些来源（散落的云盘文件）没有空间概念。
 * 空串是"这个渠道的默认空间"，而不是"未知" —— 后者会需要 NULL，
 * 而 NULL 进不了 `WITHOUT ROWID` 的主键。
 *
 * ## ★ `day_bucket` 用**文档的更新时间**分桶
 *
 * 与 `toDocumentChangelogEntry` 的 `occurredAt` 同一个判据
 * （`updatedAt ?? createdAt ?? fetchedAt`）：用抓取时间分桶会让三个月前
 * 改的文档全部落到今天，于是"这段日期有多少"永远只有今天那一格有数。
 *
 * ## 只加表，不动任何已发布迁移
 *
 * 改已发布的迁移会让 checksum 变，已迁移的 vault 启动即
 * `DB_MIGRATION_FAILED`（v18 那批真踩过）。
 */
export const VAULT_0029_DOCUMENT_COVERAGE = `
CREATE TABLE document_coverage (
  channel_id TEXT NOT NULL,
  -- 空间（知识库 / 云盘目录）的 external_id。'' = 这个渠道的默认空间。
  -- ★ 不用 NULL：WITHOUT ROWID 的主键列不能为 NULL，而"未知空间"这个状态
  -- 我们并不需要（拿不到空间就是默认空间）。
  space_external_id TEXT NOT NULL,
  -- 'YYYY-MM-DD'（按写入侧的本地时区算好再存，读侧不再换算）
  day_bucket TEXT NOT NULL,
  -- 库里这一天有多少篇（真值：我们自己数的）
  local_count INTEGER NOT NULL DEFAULT 0,
  -- 这一轮渠道列了多少篇。★ 没抽干时它是**下界**不是总数。
  -- NULL = 这一轮没走列表（比如只按 changelog 增量更新了一篇）。
  listed_total INTEGER,
  -- 1 = 这一天翻到 hasMore=false（可以认为齐了）；0 = 还在回溯
  -- ★ 没有默认 1：默认"齐了"会把"不知道"伪装成"采完了"（v24/v27 同一个取舍）。
  drained INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, space_external_id, day_bucket)
) WITHOUT ROWID;

-- 「这段日期齐不齐」按天跨空间聚合（MIN(drained) / SUM(local_count)）；
-- 主键前缀是 channel_id+space，帮不上按天的范围扫 → 单独一条。
CREATE INDEX IF NOT EXISTS idx_document_coverage_day
  ON document_coverage(channel_id, day_bucket);

-- 「哪个空间还没抽干」——少数行，部分索引（与 v24/v27 同一个手法）。
CREATE INDEX IF NOT EXISTS idx_document_coverage_not_drained
  ON document_coverage(channel_id, space_external_id) WHERE drained = 0;
`
