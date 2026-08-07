/**
 * VAULT v25 — 搜索会话的**检索档位**。
 *
 * ## 这一列决定"这个会话去问哪几个图谱"
 *
 * 多渠道之后一个 vault 下有多个物理隔离的图库（一渠道一份，各自一个 kl）。
 * 而"这次搜索该覆盖哪些渠道"是**用户的意图**，不是全局配置：同一个人
 * 上一分钟在查工作群的技术决策（只钉钉），下一分钟在查文档（只飞书）。
 * 所以它必须**按会话**存 —— 存成全局设置的话，切档位会把已有会话的语义
 * 也一起改掉，而那些会话的历史回答是按旧档位得出的。
 *
 * ## ★★ 默认与回填都必须是 `dingtalk`，不能是 `all`
 *
 * `DEFAULT 'dingtalk'` 同时管两件事：新行的缺省、以及**已有行的回填值**
 * （`ALTER TABLE ADD COLUMN ... NOT NULL DEFAULT` 会把存量行填成这个默认）。
 *
 * 给 `all` 的后果是一次**现有行为回归**：所有旧会话恢复后突然开始检索飞书
 * 的语料。用户没做任何操作，而那些会话的答案会变 —— 且看不出为什么变。
 * 填 `dingtalk` 则是"旧会话保持原来的行为"，零迁移。
 *
 * ## 为什么是 TEXT 而不是枚举表
 *
 * 档位的取值域跟着"接了哪些渠道"走（`dingtalk` / `feishu` / `all` / …），
 * 而那是代码里的事实。做成外键表要在每次加渠道时插一行数据迁移，
 * 而收益只有"数据库层面拒绝错值"—— 而写入口只有一个（`SearchSessionRepository`），
 * 那里做校验更直接。
 *
 * ## `ALTER TABLE ADD COLUMN` 带 NOT NULL + DEFAULT 对已有行安全
 *
 * SQLite 允许这个组合（不允许的是 NOT NULL 且**无**默认值）。已有行被填成
 * 默认值，不需要单独的 UPDATE 语句。
 */
export const VAULT_0025_SEARCH_GRAPH_SCOPE = `
ALTER TABLE search_chat_sessions ADD COLUMN graph_scope TEXT NOT NULL DEFAULT 'dingtalk';
`
