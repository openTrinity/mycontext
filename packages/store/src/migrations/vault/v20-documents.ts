/**
 * VAULT v20 — 文档采集接线所需的列。
 *
 * ## 为什么要动 `documents`（v2 就建了这张表）
 *
 * v2 建表时文档还没有采集器，列是按"猜"定的。真接上之后有四个字段缺位：
 *
 * · `origin` —— 同一篇文档可能从**两个入口**看到（`drive recent` 个人视角 /
 *   `wiki node list` 团队视角）。不记来源的话"为什么这篇在库里"无从排查，
 *   而两个入口的覆盖面完全不同（个人最近访问 vs 知识库全量）。
 * · `extension` —— 决定 `doc read` 拿不拿得到 markdown（`adoc` 能、
 *   `axls` 表格 / `dingfm` 脑图不能）。不记的话每轮都要对表格白跑一次
 *   CLI 调用（0.3-0.8s × 几十篇），而结果永远是空。
 * · `workspace_id` —— wiki 节点属于哪个知识库。缺它就没法按知识库筛选，
 *   而"只蒸馏某几个库"是用户会提的要求。
 * · `created_at` —— v2 只有 `updated_at`。两者都要：文档列表按更新时间排，
 *   而图谱的时间轴需要"这篇什么时候建的"（一篇两年前建、昨天改的文档，
 *   在时间线上的位置与一篇昨天新建的完全不同）。
 *
 * ★ 缺 `created_at` 这一条是**真跑一轮才暴露**的：列举那 1059 篇全部落库失败，
 * 报 `table documents has no column named created_at`。而它之所以没在
 * 编译期暴露，是因为 SQL 是字符串 —— 这正是"schema 与代码分离"的固有代价，
 * 也是为什么这条链路必须有一个真跑的探针（`scripts/check-docs.mjs`）。
 *
 * ## 为什么是新版本而不是改 v2
 *
 * v2 **已发布**：改它（哪怕只改注释）会让 checksum 变化，
 * 于是每个已迁移过的 vault 启动时命中 `DB_MIGRATION_FAILED` —— 应用直接起不来。
 * 这个坑在 v18 那批真踩过一次（见 v18-draft-cap 文件头）。
 *
 * ## `ALTER TABLE ADD COLUMN` 对已有行安全
 *
 * 四列都可空、无默认值，已有行（实测 0 行 —— 从来没有写入方）自动为 NULL。
 * 顺带补两个索引：文档列表页按更新时间排，而「每轮补 N 篇正文」查的是
 * `content_text IS NULL` 那个子集。
 */
export const VAULT_0020_DOCUMENTS = `
ALTER TABLE documents ADD COLUMN origin TEXT;
ALTER TABLE documents ADD COLUMN extension TEXT;
ALTER TABLE documents ADD COLUMN workspace_id TEXT;
ALTER TABLE documents ADD COLUMN created_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(channel_id, updated_at DESC);
-- 正文抓取的工作队列：content_text IS NULL 的那些（按更新时间新→旧补）。
CREATE INDEX IF NOT EXISTS idx_documents_missing_body
  ON documents(channel_id, updated_at DESC) WHERE content_text IS NULL;
`
