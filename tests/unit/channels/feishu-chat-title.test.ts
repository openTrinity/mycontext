/**
 * 飞书单聊的会话名。
 *
 * ## 实测：响应里**没有**会话名
 *
 * `im +messages-search` 对单聊返回的是
 * `chat_partner: {"open_id": "ou_…"}` —— 只有 id、没有名字，
 * 而 `chat_name` / `chat.name` 在单聊上压根不存在。
 *
 * 于是每个单聊都叫「飞书会话」——用户在采集范围里看到三行一模一样的名字，
 * 完全没法选（真实截图就是这样）。
 *
 * 而 `sender.name` 是有真名的。所以单聊名取"对端发的那条消息"的 sender 名。
 */
import { describe, expect, it } from "vitest"
import { parseLarkMessagePage } from "@mycontext/channels"

const END = 1_786_200_000_000

/** 一条单聊消息（形状照实测响应，值是编的）。 */
function p2p(opts: { chatId: string; partnerOpenId: string; senderOpenId: string; senderName: string; messageId: string }) {
  return {
    message_id: opts.messageId,
    chat_id: opts.chatId,
    chat_type: "p2p",
    chat_partner: { open_id: opts.partnerOpenId },
    sender: { id: opts.senderOpenId, open_id: opts.senderOpenId, id_type: "user_id", name: opts.senderName },
    create_time: String(END - 1000),
    body: { content: '{"text":"hi"}' },
  }
}

describe("飞书单聊的会话名", () => {
  it("★★ 对端发的消息 → 用它的 sender 名当会话名", () => {
    const page = parseLarkMessagePage(
      { items: [p2p({ chatId: "oc_1", partnerOpenId: "ou_peer", senderOpenId: "ou_peer", senderName: "张三" , messageId: "om_1" })] },
      END,
    )
    expect(page.conversations[0]?.title).toBe("张三")
    expect(page.conversations[0]?.type).toBe("direct")
  })

  it("我自己发的消息 → 拿不到对端名，回落占位（不能把我的名字当会话名）", () => {
    const page = parseLarkMessagePage(
      { items: [p2p({ chatId: "oc_2", partnerOpenId: "ou_peer", senderOpenId: "ou_me", senderName: "我自己", messageId: "om_2" })] },
      END,
    )
    expect(page.conversations[0]?.title).toBe("飞书会话")
  })

  /**
   * ★★ 同一个会话跨多条消息出现时，**已经拿到的名字不能被占位冲掉**。
   *
   * 实测形态：一页里既有对端的消息也有我自己的。如果按"最后一条覆盖"，
   * 而最后一条恰好是我发的 → 名字变回占位，前面拿到的真名白丢。
   */
  it("★★ 已经拿到真名后，再遇到我自己发的消息不覆盖", () => {
    const page = parseLarkMessagePage(
      {
        items: [
          p2p({ chatId: "oc_3", partnerOpenId: "ou_peer", senderOpenId: "ou_peer", senderName: "李四", messageId: "om_3" }),
          p2p({ chatId: "oc_3", partnerOpenId: "ou_peer", senderOpenId: "ou_me", senderName: "我自己", messageId: "om_4" }),
        ],
      },
      END,
    )
    expect(page.conversations).toHaveLength(1)
    expect(page.conversations[0]?.title).toBe("李四")
  })

  it("群聊有 chat_name 时照旧用它（这条路本来是对的，不能改坏）", () => {
    const page = parseLarkMessagePage(
      {
        items: [
          {
            message_id: "om_5",
            chat_id: "oc_4",
            chat_type: "group",
            chat_name: "项目讨论组",
            sender: { id: "ou_x", open_id: "ou_x", name: "王五" },
            create_time: String(END - 1000),
            body: { content: '{"text":"hi"}' },
          },
        ],
      },
      END,
    )
    expect(page.conversations[0]?.title).toBe("项目讨论组")
    expect(page.conversations[0]?.type).toBe("group")
  })
})
