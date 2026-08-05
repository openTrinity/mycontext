/**
 * VAULT v13 — 收紧自聊识别。
 *
 * v12 仅凭“direct + 当前库里只有本人消息”识别自聊，但渠道历史窗口可能不完整：
 * 普通单聊如果只同步到了本人发出的那几条，也会满足这个条件。
 *
 * 因此自聊还必须满足：会话标题精确匹配该渠道已确认身份里的一个本人显示名。
 * bot 分类规则保持不变。
 */
export const VAULT_0014_PERSONA_SELF_CONVERSATION = `
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
`
