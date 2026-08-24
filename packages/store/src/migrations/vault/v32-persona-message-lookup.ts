/**
 * VAULT v32 — Persona 热路径消息定位索引。
 *
 * · legacy 草稿只持有 conversation_id + reply_to_external_id；缺组合索引时
 *   十几条草稿会反复扫描数十万消息。
 * · 会话列表要找单聊对方 id；部分索引让每个会话不再扫描整张消息表。
 */
export const VAULT_0032_PERSONA_MESSAGE_LOOKUP = `
CREATE INDEX idx_msg_conv_external
  ON messages(conversation_id, external_id);

CREATE INDEX idx_msg_peer_lookup
  ON messages(conversation_id, sender_external_id)
  WHERE is_self = 0 AND sender_external_id IS NOT NULL;
`
