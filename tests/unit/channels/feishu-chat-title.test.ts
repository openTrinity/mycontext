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
function p2p(opts: {
  chatId: string
  partnerOpenId: string
  senderOpenId: string
  senderName: string
  messageId: string
}) {
  return {
    message_id: opts.messageId,
    chat_id: opts.chatId,
    chat_type: "p2p",
    chat_partner: { open_id: opts.partnerOpenId },
    sender: {
      id: opts.senderOpenId,
      open_id: opts.senderOpenId,
      id_type: "user_id",
      name: opts.senderName,
    },
    create_time: String(END - 1000),
    body: { content: '{"text":"hi"}' },
  }
}

describe("飞书单聊的会话名", () => {
  it("★★ 对端发的消息 → 用它的 sender 名当会话名", () => {
    const page = parseLarkMessagePage(
      {
        items: [
          p2p({
            chatId: "oc_1",
            partnerOpenId: "ou_peer",
            senderOpenId: "ou_peer",
            senderName: "张三",
            messageId: "om_1",
          }),
        ],
      },
      END,
    )
    expect(page.conversations[0]?.title).toBe("张三")
    expect(page.conversations[0]?.type).toBe("direct")
  })

  /**
   * ★★ 判据从"等于占位串"改成"**是 null**"。
   *
   * 原来推不出名字时写一个占位字符串（`飞书会话`）进库，而落库那侧是
   * `title = COALESCE(excluded.title, conversations.title)` —— 占位是非 null 的，
   * 于是它会**覆盖掉已经拿到的真名**（同一会话下一轮里恰好只有我自己发言时）。
   * 而且改好推导也救不回存量行：新值给 null 时 COALESCE 保留旧值，
   * 旧值正是占位。实测本机 4 个飞书单聊全卡在这个状态。
   *
   * 所以改成给 null，让 COALESCE 天然保护真名；界面那侧显示 id 尾段
   * （每行不同，可区分），而不是四行一样的占位词。
   *
   * ★ 这条要守的东西没变：**不能把我自己的名字当会话名**。
   */
  it("★★ 只有我自己发的消息 → 给 null（不是占位串，也不能是我的名字）", () => {
    const page = parseLarkMessagePage(
      {
        items: [
          p2p({
            chatId: "oc_2",
            partnerOpenId: "ou_peer",
            senderOpenId: "ou_me",
            senderName: "我自己",
            messageId: "om_2",
          }),
        ],
      },
      END,
    )
    expect(page.conversations[0]?.title).toBeNull()
    expect(page.conversations[0]?.title).not.toBe("我自己")
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
          p2p({
            chatId: "oc_3",
            partnerOpenId: "ou_peer",
            senderOpenId: "ou_peer",
            senderName: "李四",
            messageId: "om_3",
          }),
          p2p({
            chatId: "oc_3",
            partnerOpenId: "ou_peer",
            senderOpenId: "ou_me",
            senderName: "我自己",
            messageId: "om_4",
          }),
        ],
      },
      END,
    )
    expect(page.conversations).toHaveLength(1)
    expect(page.conversations[0]?.title).toBe("李四")
  })

  /**
   * ## ★★★ 对端**从没发过消息**的单聊（改动前整类漏掉）
   *
   * 实测本机 4 个飞书单聊里有 3 个是这样：我发出去、对方没回。
   * 那时 `chat_partner.open_id` 在整页消息里**一次都不作为 sender 出现**，
   * 于是"sender === partner"这条判据永不成立，标题恒为占位 ——
   * 用户在采集范围里看到几行一模一样的「飞书会话」，完全没法选。
   *
   * 修法是补第二条判据：知道本人 open_id 时，取"能确定不是我"的那个发送者。
   *
   * ★ 这条用例里 sender 既**不等于** partner（对端没发言），也不等于我 ——
   * 现实里这就是"群里的第三方/机器人被搜到，但会话是单聊"这类形态。
   */
  it("★★★ 对端没发过消息、但有第三方发言 → 用「不是我」那个人的名字", () => {
    const page = parseLarkMessagePage(
      {
        items: [
          p2p({
            chatId: "oc_5",
            partnerOpenId: "ou_silent_peer",
            senderOpenId: "ou_someone_else",
            senderName: "赵六",
            messageId: "om_6",
          }),
        ],
      },
      END,
      /** 本人 open_id —— 有它才能判「不是我」 */
      "ou_me",
    )
    expect(page.conversations[0]?.title).toBe("赵六")
  })

  /**
   * ★★ 只有我自己发过消息时**仍然**回落占位。
   *
   * 这是上面那条修复的边界：不能因为"有了 selfOpenId"就把任意 sender 名
   * 拿来当会话名 —— 那会把**我自己的名字**显示成会话名（比占位更糟：
   * 用户会以为那是个跟自己的对话）。
   */
  it("★★ 只有我发过消息（sender === self）→ 仍然回落占位", () => {
    const page = parseLarkMessagePage(
      {
        items: [
          p2p({
            chatId: "oc_6",
            partnerOpenId: "ou_silent_peer",
            senderOpenId: "ou_me",
            senderName: "我自己",
            messageId: "om_7",
          }),
        ],
      },
      END,
      "ou_me",
    )
    expect(page.conversations[0]?.title).not.toBe("我自己")
  })

  /**
   * ★ `selfOpenId` 为 null（身份还没解析）时退化成改动前的行为 ——
   * 而**不是**把随便一个 sender 名当成对端名。
   */
  it("★ 不知道本人 id 时不猜：sender 既非 partner 也无从判断 → 占位", () => {
    const page = parseLarkMessagePage(
      {
        items: [
          p2p({
            chatId: "oc_7",
            partnerOpenId: "ou_silent_peer",
            senderOpenId: "ou_someone_else",
            senderName: "某人",
            messageId: "om_8",
          }),
        ],
      },
      END,
      null,
    )
    expect(page.conversations[0]?.title).not.toBe("某人")
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
