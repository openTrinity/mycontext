/**
 * VAULT v15 — Persona 回复轮次的硬过期与历史积压清理。
 *
 * Persona 是实时回复系统，不是历史消息补答器。首次注册 consumer 或游标重放时，
 * 数天前的消息可能集中进入 dh_inbox；若仍生成草稿，会让待审队列看起来像
 * “还有工作”，实际那些回复早已失去语境。
 *
 * 只有“完整未读快照明确为已读 + 超过 4 小时 + 本人未回复”才过期。
 * 未读或读状态未知的消息保留，避免误删仍需处理的事项。
 */
export const VAULT_0016_PERSONA_REPLY_EXPIRY = `
UPDATE dh_inbox
   SET state = 'dropped',
       drop_reason = 'already_answered',
       processed_at = COALESCE(
         processed_at,
         CAST(strftime('%s', 'now') AS INTEGER) * 1000
       )
 WHERE state = 'pending'
   AND EXISTS (
     SELECT 1
       FROM messages trigger_message
       JOIN messages reply
         ON reply.conversation_id = trigger_message.conversation_id
        AND reply.is_self = 1
        AND reply.sent_at > trigger_message.sent_at
      WHERE trigger_message.id = dh_inbox.message_id
   );

UPDATE dh_inbox
   SET state = 'dropped',
       drop_reason = 'stale_message',
       processed_at = COALESCE(
         processed_at,
         CAST(strftime('%s', 'now') AS INTEGER) * 1000
       )
 WHERE state = 'pending'
   AND EXISTS (
     SELECT 1
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN probe_snapshots p
         ON p.channel_id = c.channel_id
        AND p.conversation_external_id = c.external_id
      WHERE m.id = dh_inbox.message_id
        AND m.sent_at < CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 14400000
        AND p.unread_count = 0
        AND p.observed_at >= m.sent_at
        AND NOT EXISTS (
          SELECT 1
            FROM messages reply
           WHERE reply.conversation_id = m.conversation_id
             AND reply.is_self = 1
             AND reply.sent_at > m.sent_at
        )
   );

UPDATE dh_drafts
   SET state = 'expired',
       resolved_at = COALESCE(
         resolved_at,
         CAST(strftime('%s', 'now') AS INTEGER) * 1000
       )
 WHERE state = 'pending'
   AND EXISTS (
     SELECT 1
       FROM messages trigger_message
       JOIN messages reply
         ON reply.conversation_id = trigger_message.conversation_id
        AND reply.is_self = 1
        AND reply.sent_at > trigger_message.sent_at
      WHERE trigger_message.conversation_id = dh_drafts.conversation_id
        AND trigger_message.external_id = dh_drafts.reply_to_external_id
   );

UPDATE dh_drafts
   SET state = 'expired',
       resolved_at = COALESCE(
         resolved_at,
         CAST(strftime('%s', 'now') AS INTEGER) * 1000
       )
 WHERE state = 'pending'
   AND EXISTS (
       SELECT 1
         FROM messages trigger_message
         JOIN conversations c ON c.id = trigger_message.conversation_id
         JOIN probe_snapshots p
           ON p.channel_id = c.channel_id
          AND p.conversation_external_id = c.external_id
        WHERE trigger_message.conversation_id = dh_drafts.conversation_id
          AND trigger_message.external_id = dh_drafts.reply_to_external_id
          AND trigger_message.sent_at <
              CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 14400000
          AND p.unread_count = 0
          AND p.observed_at >= trigger_message.sent_at
          AND NOT EXISTS (
            SELECT 1
              FROM messages reply
             WHERE reply.conversation_id = trigger_message.conversation_id
               AND reply.is_self = 1
               AND reply.sent_at > trigger_message.sent_at
          )
     );
`
