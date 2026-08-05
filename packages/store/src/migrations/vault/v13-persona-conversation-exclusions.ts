/**
 * VAULT v12 — Persona 会话排除分类。
 *
 * 渠道会话列表不会可靠标注系统助手：真实数据里的 `BuildBot`、
 * `日历助手` 等都是普通 direct conversation，actor 也可能尚未落库。
 * 因此分类同时使用三类证据：
 *
 * · 已有 `is_bot_channel` 人工/采集标记；
 * · 所有对方消息都来自 kind=bot/system 的 actor；
 * · 单聊标题像系统助手，且只有明确的对方消息、没有本人或未判定消息。
 *
 * 自聊采用更严格的反向证据：单聊中至少一条明确本人消息，且不存在
 * 对方或未判定消息。这样不会把“暂时还没回复过的普通单聊”当成自聊。
 */
export const VAULT_0013_PERSONA_CONVERSATION_EXCLUSIONS = `
CREATE VIEW persona_conversation_exclusions AS
WITH conversation_facts AS (
  SELECT c.id AS conversation_id,
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
             THEN 'self_conversation'
           ELSE NULL
         END AS reason
    FROM conversation_facts
)
SELECT conversation_id, reason
  FROM classified
 WHERE reason IS NOT NULL;

-- 把机器人结论同步到已有的通用标记，蒸馏等非 Persona 路径也能排除它们。
UPDATE conversations
   SET is_bot_channel = 1
 WHERE id IN (
   SELECT conversation_id
     FROM persona_conversation_exclusions
    WHERE reason = 'bot_channel'
 );

-- 已经进入持久化 inbox 的历史消息不应在重启后恢复进内存队列。
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

-- 排除会话里已经生成的草稿也立即过期，避免继续出现在待审队列。
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
