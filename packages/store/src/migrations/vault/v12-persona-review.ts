/**
 * VAULT v11 — 待审草稿生命周期与发送来源。
 *
 * `dh_send_attempts.source` 区分两种完全不同的语料：
 *
 * · `agent_auto`：agent 自主发送，采集回流后必须标成 origin='agent'；
 * · `user_approved`：用户在待审队列明确采用（含编辑后采用），应保留为本人语料。
 *
 * 已有记录全部来自旧的自动/数字人发送路径，按 `agent_auto` 回填最保守。
 */
export const VAULT_0012_PERSONA_REVIEW = `
ALTER TABLE dh_send_attempts
  ADD COLUMN source TEXT NOT NULL DEFAULT 'agent_auto';

CREATE INDEX idx_dh_attempts_source
  ON dh_send_attempts(source, attempted_at DESC);

-- 历史回填：升级完成时立即清掉已经被本人后续回复覆盖的待审草稿。
-- 运行期仍会在列表读取、发送前和生成完成后三处重复校验，覆盖升级后的竞态。
UPDATE dh_drafts
   SET state = 'expired',
       resolved_at = COALESCE(resolved_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
 WHERE state = 'pending'
   AND reply_to_external_id IS NOT NULL
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
`
