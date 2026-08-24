import { describe, expect, it } from "vitest"
import { openTestVault } from "../../helpers/vault.js"

describe("Persona 消息查询索引", () => {
  it("legacy 草稿与单聊联系人查询使用专用组合索引", () => {
    const vault = openTestVault()
    const columns = (name: string): string[] =>
      vault.db
        .prepare<[], { name: string }>(`PRAGMA index_info('${name}')`)
        .all()
        .map((row) => row.name)

    expect(columns("idx_msg_conv_external")).toEqual(["conversation_id", "external_id"])
    expect(columns("idx_msg_peer_lookup")).toEqual(["conversation_id", "sender_external_id"])
    const peerSql = vault.db
      .prepare<
        [],
        { sql: string }
      >("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_msg_peer_lookup'")
      .get()?.sql
    expect(peerSql).toContain("WHERE is_self = 0 AND sender_external_id IS NOT NULL")
    vault.close()
  })
})
