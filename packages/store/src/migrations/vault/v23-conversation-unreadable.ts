/**
 * VAULT v23 — 会话的「不可读」标记。
 *
 * ## 为什么需要它（一条 CLAUDE.md 第 5 节要求的硬规则）
 *
 * 保密群在逐会话接口上是**硬拒**的（实测 `server_error_code=1001`，
 * 「该群为保密群，无法获取消息记录」，三种 `--direction` 都拒）。
 * 服务端拒绝就是拒绝 —— 不许换接口、换参数去试探。
 *
 * 但少了这个标记会有两种坏结果，而两者都是**静默的**：
 *
 * · **无限重试**：采集器每轮都会再试一次那个永远不会成功的调用。
 *   `classifyDwsError` 现在能把 1001 归成终态（`RESOURCE_FORBIDDEN`），
 *   但"这一次别重试"与"以后都别再试"是两件事，后者需要落库。
 * · **不可读被伪装成 0 条**：实测 `list-all` 会为同一个保密群返回
 *   **13 条伪消息** —— `content` 全是那句拒绝提示，而 `sender`（9 个真实
 *   姓名）/`createTime`/`openMessageId` 都是真值。伪消息已在解析层被丢掉，
 *   于是这个会话在库里表现成"0 条"，与"这个群这段时间没人说话"无法区分。
 *   而这两者对用户的含义完全不同。
 *
 * ## 为什么是两列而不是一个布尔
 *
 * `unreadable_reason` 记**为什么**读不了（`confidential` / `cross_org` 等）：
 * 前者没有任何补救动作，后者用户授权一次就能读。UI 上要说的话完全不同，
 * 而只有一个布尔的话就只能说"读不了"，用户不知道该不该去做点什么。
 *
 * `unreadable_at` 记**什么时候**判定的：上游策略会变（一个群可能被取消
 * 保密设置），所以这个标记不该是永久的死刑。有了时间戳，将来可以做
 * "超过 N 天重试一次"而不必再加一列。
 *
 * ## `ALTER TABLE ADD COLUMN` 对已有行安全
 *
 * 两列都可空、无默认值，已有行自动为 NULL（= 可读，与当前行为一致）。
 * 建部分索引而不是全表索引：不可读的会话是极少数（实测 123 个群里 1 个），
 * 而查询永远是"哪些不可读"，不会问"哪些可读"。
 */
export const VAULT_0023_CONVERSATION_UNREADABLE = `
ALTER TABLE conversations ADD COLUMN unreadable_reason TEXT;
ALTER TABLE conversations ADD COLUMN unreadable_at INTEGER;

CREATE INDEX idx_conv_unreadable ON conversations(channel_id, unreadable_reason)
  WHERE unreadable_reason IS NOT NULL;
`
