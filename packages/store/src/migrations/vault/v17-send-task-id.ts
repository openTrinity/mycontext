/**
 * VAULT v17 — 补上「发出去的那条是哪一条」的关联键，以及第三种草稿过期。
 *
 * ## 1. `send_task_id`：真实返回里唯一有的那个 id
 *
 * 实测 `dws chat message send` 只返回 `openTaskId`，**没有** `openMessageId`：
 *
 * ```json
 * {"success": true, "result": {"openTaskId": "qQrC8yRZwg5c…"}}
 * ```
 *
 * 消息 id 要再走一跳 `chat message query-send-status --open-task-id` 才有。
 * 那一跳可能失败（网络、在途），而失败时 `sent_message_external_id` 只能留空
 * —— 此时 taskId 是**唯一**的线索：事后能拿它补查，也能回答"为什么这条标不出来"。
 *
 * 不留它的代价是那次失败无从追查（发出去了、没标上、没有任何线索）。
 *
 * ## 2. `expired_reason`：草稿**为什么消失**，与"为什么被扣下"分开
 *
 * `not_sent_reason` 装的是**扣下**的原因（`mode_not_auto` /
 * `agent_output_unstructured` / forge 的判定原话）。过期是**另一件事**，
 * 而现存实现（v16 那两条 UPDATE）**一个原因都不记** —— 实测库里 36 条
 * expired 的 `not_sent_reason` 为空、144 条仍是 `mode_not_auto`。
 *
 * 于是用户问「我的草稿怎么没了」时没有任何答案。而三种过期要给的解释完全不同：
 * 本人已经回过了 / 放太久且已读 / **对方又说了新话**。
 *
 * 复用 `not_sent_reason` 是错的：那会把扣下的原因**覆盖掉**，
 * 而两者都有用（"当时为什么没自动发" + "后来为什么过期"）。所以加一列。
 *
 * ## 3. 第三种过期：`superseded_by_newer_message`
 *
 * 已有两种（v16）：本人已回、已读且超 4 小时。
 * **缺的是**「触发之后对方又说了新话」—— 那时旧草稿回答的是过时的语境，
 * 发出去比不发更糟（答非所问，而且看起来像本人没在听）。
 *
 * ★ 判据必须是**对方的**新消息（`is_self = 0`）：本人自己发的已由第一种
 * 覆盖，混在一起会让两条规则互相掩盖，而"哪条规则生效了"是排查的入口。
 *
 * 这一条同时做**历史清理**：库里现存的 pending 草稿如果已经被新消息盖过，
 * 迁移时就标掉 —— 否则用户升级后仍会看到一批过时草稿，而它们永远不会
 * 被上面两条规则命中（本人没回、也可能还没读）。
 */
export const VAULT_0017_SEND_TASK_ID = `
ALTER TABLE dh_send_attempts
  ADD COLUMN send_task_id TEXT;

ALTER TABLE dh_drafts
  ADD COLUMN expired_reason TEXT;

UPDATE dh_drafts
   SET state = 'expired',
       expired_reason = COALESCE(expired_reason, 'superseded_by_newer_message'),
       resolved_at = COALESCE(
         resolved_at,
         CAST(strftime('%s', 'now') AS INTEGER) * 1000
       )
 WHERE state = 'pending'
   AND reply_to_external_id IS NOT NULL
   AND EXISTS (
     SELECT 1
       FROM messages trigger_message
       JOIN messages newer
         ON newer.conversation_id = trigger_message.conversation_id
        AND newer.is_self = 0
        AND newer.sent_at > trigger_message.sent_at
      WHERE trigger_message.conversation_id = dh_drafts.conversation_id
        AND trigger_message.external_id = dh_drafts.reply_to_external_id
   );
`
