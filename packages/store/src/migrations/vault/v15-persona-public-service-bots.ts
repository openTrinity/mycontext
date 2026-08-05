/**
 * VAULT v14 — 补充平台公益入口的 bot 标题。
 *
 * `公益3小时` 是平台系统服务，但标题不带“助手/机器人/通知”等通用词。
 * 只在 direct、只有明确对方消息且没有本人/未判定消息时命中，
 * 避免仅凭标题把真实群聊排除。
 */
export const VAULT_0015_PERSONA_PUBLIC_SERVICE_BOTS = `
DROP VIEW persona_conversation_exclusions;

CREATE VIEW persona_conversation_exclusions AS
WITH conversation_facts AS (
  SELECT c.id AS conversation_id,
         c.channel_id,
         c.type,
         c.title,
         c.is_bot_channel,
         SUM(CASE WHEN m.is_self = 1 THEN 1 ELSE 0 END) AS self_count,
         SUM(CASE WHEN m.is_self = 0 THEN 1 ELSE 0 END) AS other_count,
         SUM(CASE WHEN m.id IS NOT NULL AND m.is_self IS NULL THEN 1 ELSE 0 END) AS unknown_count,
         SUM(CASE WHEN m.is_self = 0 AND a.kind IN ('bot', 'system') THEN 1 ELSE 0 END)
           AS automated_other_count
    FROM conversations c
    LEFT JOIN messages m ON m.conversation_id = c.id
    LEFT JOIN actors a ON a.id = m.sender_actor_id
   GROUP BY c.id
),
classified AS (
  SELECT conversation_id,
         CASE
           WHEN is_bot_channel = 1 THEN 'bot_channel'
           WHEN other_count > 0 AND other_count = automated_other_count
             THEN 'bot_channel'
           WHEN type = 'direct'
            AND other_count > 0
            AND self_count = 0
            AND unknown_count = 0
            AND (
              trim(COALESCE(title, '')) LIKE '%助手'
              OR trim(COALESCE(title, '')) LIKE '%服务中心'
              OR trim(COALESCE(title, '')) LIKE '%小蜜'
              OR trim(COALESCE(title, '')) LIKE '%机器人%'
              OR lower(trim(COALESCE(title, ''))) LIKE '%bot%'
              OR trim(COALESCE(title, '')) LIKE '%告警%'
              OR trim(COALESCE(title, '')) LIKE '%通知%'
              OR trim(COALESCE(title, '')) GLOB '公益[0-9]*小时'
            )
             THEN 'bot_channel'
           WHEN type = 'direct'
            AND self_count > 0
            AND other_count = 0
            AND unknown_count = 0
            AND EXISTS (
              SELECT 1
                FROM channel_self_identity self_identity,
                     json_each(self_identity.display_names_json) display_name
               WHERE self_identity.channel_id = conversation_facts.channel_id
                 AND self_identity.confirmed_at IS NOT NULL
                 AND trim(CAST(display_name.value AS TEXT)) =
                     trim(COALESCE(conversation_facts.title, ''))
            )
             THEN 'self_conversation'
           ELSE NULL
         END AS reason
    FROM conversation_facts
)
SELECT conversation_id, reason
  FROM classified
 WHERE reason IS NOT NULL;

UPDATE conversations
   SET is_bot_channel = 1
 WHERE id IN (
   SELECT conversation_id
     FROM persona_conversation_exclusions
    WHERE reason = 'bot_channel'
 );

UPDATE dh_inbox
   SET state = 'dropped',
       drop_reason = (
         SELECT reason
           FROM persona_conversation_exclusions e
          WHERE e.conversation_id = dh_inbox.conversation_id
       ),
       processed_at = COALESCE(
         processed_at,
         CAST(strftime('%s', 'now') AS INTEGER) * 1000
       )
 WHERE state = 'pending'
   AND conversation_id IN (
     SELECT conversation_id FROM persona_conversation_exclusions
   );

UPDATE dh_drafts
   SET state = 'expired',
       resolved_at = COALESCE(
         resolved_at,
         CAST(strftime('%s', 'now') AS INTEGER) * 1000
       )
 WHERE state = 'pending'
   AND conversation_id IN (
     SELECT conversation_id FROM persona_conversation_exclusions
   );
`
