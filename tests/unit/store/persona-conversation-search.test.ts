/**
 * `MessageRepository` 的两个会话内查询：群成员归并 + like 搜索。
 *
 * 都是"会话设置弹窗"要的数据，且都只有真库能验的性质：
 * · 成员是**发过言的人**（不是花名册），按发言数降序，花名取最近一次的；
 * · 搜索是**字面子串** + 会话内 + 时间正序 + 带 id（跳转要用）+ 转义通配符。
 */
import { describe, expect, it } from "vitest"
import { ConversationRepository, MessageRepository } from "@mycontext/store"
import { openTestVault } from "../../helpers/vault.js"

const NOW = 1_785_306_600_000

function seed(
  vault: ReturnType<typeof openTestVault>,
  convId: string,
  msgs: {
    id: string
    sender: string
    name: string
    text: string
    isSelf?: boolean
    at?: number
  }[],
): void {
  new ConversationRepository(vault.db).upsert({
    id: convId,
    channelId: "dingtalk",
    externalId: `cid-${convId}`,
    type: "group",
    title: convId,
    createdAt: NOW,
  })
  new MessageRepository(vault.db).upsertMany(
    msgs.map((m, i) => ({
      id: m.id,
      channelId: "dingtalk",
      conversationId: convId,
      externalId: `ext-${m.id}`,
      senderExternalId: m.sender,
      senderDisplayName: m.name,
      contentText: m.text,
      sentAt: m.at ?? NOW + i,
      direction: m.isSelf ? ("outbound" as const) : ("inbound" as const),
      isSelf: m.isSelf ?? false,
      createdAt: m.at ?? NOW + i,
    })),
  )
}

describe("★ groupMembers：发过言的人，按发言数降序", () => {
  it("从消息发送者归并，count 是发言次数，降序", () => {
    const vault = openTestVault()
    seed(vault, "g1", [
      { id: "a1", sender: "u_a", name: "小李", text: "1" },
      { id: "a2", sender: "u_a", name: "小李", text: "2" },
      { id: "a3", sender: "u_a", name: "小李", text: "3" },
      { id: "b1", sender: "u_b", name: "小王", text: "1" },
    ])
    const members = new MessageRepository(vault.db).groupMembers("g1")
    expect(members).toEqual([
      { externalId: "u_a", displayName: "小李", messageCount: 3 },
      { externalId: "u_b", displayName: "小王", messageCount: 1 },
    ])
    vault.close()
  })

  it("★ 本人不算成员（is_self=1 排除）", () => {
    const vault = openTestVault()
    seed(vault, "g1", [
      { id: "m1", sender: "self", name: "我", text: "hi", isSelf: true },
      { id: "m2", sender: "u_a", name: "小李", text: "hi" },
    ])
    const members = new MessageRepository(vault.db).groupMembers("g1")
    expect(members.map((m) => m.externalId)).toEqual(["u_a"])
    vault.close()
  })

  it("★ 花名取**最近一次**用的那个（花名会变）", () => {
    const vault = openTestVault()
    seed(vault, "g1", [
      { id: "m1", sender: "u_a", name: "老名字", text: "旧", at: NOW },
      { id: "m2", sender: "u_a", name: "新名字", text: "新", at: NOW + 10_000 },
    ])
    const members = new MessageRepository(vault.db).groupMembers("g1")
    expect(members[0]?.displayName).toBe("新名字")
    vault.close()
  })
})

describe("★ searchInConversation：字面子串 + 会话内 + 时间正序 + 带 id", () => {
  it("命中的消息带 id（跳转要用），按时间正序", () => {
    const vault = openTestVault()
    seed(vault, "g1", [
      { id: "m1", sender: "u_a", name: "小李", text: "沙箱环境好了吗", at: NOW + 2 },
      { id: "m2", sender: "u_a", name: "小李", text: "今天天气不错", at: NOW + 1 },
      { id: "m3", sender: "u_a", name: "小李", text: "沙箱又炸了", at: NOW + 3 },
    ])
    const hits = new MessageRepository(vault.db).searchInConversation("g1", "沙箱")
    expect(hits.map((h) => h.id)).toEqual(["m1", "m3"])
    expect(hits[0]).toMatchObject({ id: "m1", contentText: "沙箱环境好了吗" })
    vault.close()
  })

  it("★ 只搜**这个**会话（不串到别的会话）", () => {
    const vault = openTestVault()
    seed(vault, "g1", [{ id: "m1", sender: "u_a", name: "小李", text: "沙箱在 g1" }])
    seed(vault, "g2", [{ id: "m2", sender: "u_b", name: "小王", text: "沙箱在 g2" }])
    const hits = new MessageRepository(vault.db).searchInConversation("g1", "沙箱")
    expect(hits.map((h) => h.id)).toEqual(["m1"])
    vault.close()
  })

  it("★★ LIKE 通配符要转义（搜 `50%` 不该匹配到「50 块」这种）", () => {
    const vault = openTestVault()
    seed(vault, "g1", [
      { id: "m1", sender: "u_a", name: "小李", text: "完成了 50% 了" },
      // 含 "50" 但不含 "50%"：不转义时 `50%` 会变成 `%50%%` 命中它
      { id: "m2", sender: "u_a", name: "小李", text: "花了 50 块钱" },
    ])
    const hits = new MessageRepository(vault.db).searchInConversation("g1", "50%")
    // 只命中真的含 "50%" 的那条
    expect(hits.map((h) => h.id)).toEqual(["m1"])
    vault.close()
  })

  it("空查询返回空（不是返回全部）", () => {
    const vault = openTestVault()
    seed(vault, "g1", [{ id: "m1", sender: "u_a", name: "小李", text: "随便" }])
    expect(new MessageRepository(vault.db).searchInConversation("g1", "   ")).toEqual([])
    vault.close()
  })
})
