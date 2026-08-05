/**
 * VAULT v18 — 草稿改用「每会话数量上限」，替代按时效的自动过期。
 *
 * ## 为什么从「时效过期」改成「数量封顶」
 *
 * v16/v17 有三条按时效/语境的过期规则（本人已回、已读超时、被新消息顶替）。
 * 其中「已读超时」与「被新消息顶替」在实践里制造了一个坏体验：用户还没来得及
 * 看，草稿就因为"放太久了"或"对方又说了一句"而消失了 —— 而它们本可能仍然有用。
 * 草稿是**候选**，不是待办；过期它们等于替用户做了"这条不要了"的决定。
 *
 * 改成：每个会话最多留 N 条 pending 草稿（默认 3，可在设置里 1–20 调）。
 * 超出的按 `created_at` 从旧到新裁掉。这样"草稿为什么没了"只有一个答案
 * （这个会话新草稿太多、把最旧的挤掉了），而不是三条时效规则里猜一条。
 *
 * **保留** `expireAnsweredDrafts`（本人已经回过 → 作废）：那条不是"时效"，
 * 是"用户已经自己处理了这一轮"，留着它才不会让已回的会话冒出旧草稿。
 *
 * ## 这个迁移做什么
 *
 * 一次性把每个会话超出 3 条的 pending 草稿标 `expired` +
 * `expired_reason = 'over_draft_cap'`，保留每会话**最新的 3 条**。
 * 照 v16 那个纯 backfill 迁移的形状（只 UPDATE，不改表结构）。
 *
 * 用 `ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY created_at DESC)`
 * 给每会话的 pending 草稿按新到旧编号，序号 > 3 的裁掉。SQLite 3.25+ 支持窗口
 * 函数（better-sqlite3 打包的版本远高于此）。
 *
 * ★ 默认值 3 在这里**写死**：迁移是一次性的历史清理，跑的时候还读不到用户
 * 在设置里配的 `maxDraftsPerConversation`（那是运行期的值）。运行期的裁剪由
 * `trimDraftsBeyondCap` 按用户配置的 cap 持续执行；这里只是把升级前积压的
 * 那批按默认值收敛一次。
 */
export const VAULT_0018_DRAFT_CAP = `
UPDATE dh_drafts
   SET state = 'expired',
       expired_reason = COALESCE(expired_reason, 'over_draft_cap'),
       resolved_at = COALESCE(
         resolved_at,
         CAST(strftime('%s', 'now') AS INTEGER) * 1000
       )
 WHERE id IN (
   SELECT id FROM (
     SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY conversation_id
              ORDER BY created_at DESC, id DESC
            ) AS rn
       FROM dh_drafts
      WHERE state = 'pending'
   )
    WHERE rn > 3
 );
`
