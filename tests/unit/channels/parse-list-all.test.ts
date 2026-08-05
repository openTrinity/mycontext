/**
 * `list-all` 嵌套分页解析。
 *
 * 用真实形态的 fixture：实测返回 `conversationMessagesList[].messages[]`
 * **按会话嵌套**，按平铺处理只会拿到第一组 —— 表现是"只有部分群的消息进来了"，
 * 看起来像权限问题而不是解析问题。
 */
import { describe, expect, it } from "vitest"
import { looksTruncated, parseMessageListPage } from "@mycontext/channels"

/** 按实测结构构造：两个会话，各带消息。 */
const NESTED_PAGE = {
  conversationMessagesList: [
    {
      openConversationId: "cid-group",
      conversationTitle: "沙箱项目群",
      conversationType: "2",
      memberCount: 12,
      messages: [
        {
          openMessageId: "msg-1",
          content: "沙箱环境部署完成了",
          createTime: "2026-07-28 10:53:49",
          sender: "小周",
          senderOpenDingTalkId: "DeMINE",
          atUsers: [{ openDingTalkId: "DeOTHER" }],
        },
        {
          openMessageId: "msg-2",
          content: "收到，我看一下",
          createTime: "2026-07-28 10:55:02",
          sender: "小李",
          senderOpenDingTalkId: "DeLI",
          quotedMessage: { openMessageId: "msg-1" },
        },
      ],
    },
    {
      openConversationId: "cid-direct",
      conversationTitle: "小王",
      conversationType: "1",
      memberCount: 2,
      messages: [
        {
          openMessageId: "msg-3",
          content: "下班了吗",
          createTime: "2026-07-28 19:02:00",
          sender: "小王",
          senderOpenDingTalkId: "DeWANG",
        },
      ],
    },
  ],
  nextCursor: "cursor-page-2",
}

describe("嵌套结构", () => {
  it("两个会话的消息都被解析出来（不是只拿第一组）", () => {
    const page = parseMessageListPage(NESTED_PAGE)
    expect(page.messages.map((m) => m.externalId)).toEqual(["msg-1", "msg-2", "msg-3"])
    expect(page.conversations.map((c) => c.externalId)).toEqual(["cid-group", "cid-direct"])
  })

  it("会话类型与成员数正确", () => {
    const page = parseMessageListPage(NESTED_PAGE)
    expect(page.conversations[0]).toMatchObject({ type: "group", memberCount: 12 })
    expect(page.conversations[1]).toMatchObject({ type: "direct", memberCount: 2 })
  })

  it("每条消息带回它所属的会话（下游要用它建外键）", () => {
    const page = parseMessageListPage(NESTED_PAGE)
    expect(page.messages[0]?.conversationExternalId).toBe("cid-group")
    expect(page.messages[2]?.conversationExternalId).toBe("cid-direct")
  })

  it("时间被归一成 unix ms（不是留着原串）", () => {
    const page = parseMessageListPage(NESTED_PAGE)
    expect(page.messages[0]?.sentAt).toBe(Date.parse("2026-07-28T02:53:49.000Z"))
  })

  it("发送者用 openDingTalkId，显示名单独留一份", () => {
    const page = parseMessageListPage(NESTED_PAGE)
    // is_self 判定只能用 ID：实测本人在群里显示花名「小周」
    expect(page.messages[0]?.senderExternalId).toBe("DeMINE")
    expect(page.messages[0]?.senderDisplayName).toBe("小周")
  })

  it("@人 与引用被解析出来（数字人的触发条件与上下文）", () => {
    const page = parseMessageListPage(NESTED_PAGE)
    expect(page.messages[0]?.mentions).toEqual([{ actorExternalId: "DeOTHER" }])
    expect(page.messages[1]?.quotedExternalId).toBe("msg-1")
  })

  it("nextCursor 传出；首页标记 '0' 视为结束（避免死循环）", () => {
    expect(parseMessageListPage(NESTED_PAGE).nextCursor).toBe("cursor-page-2")
    expect(parseMessageListPage({ ...NESTED_PAGE, nextCursor: "0" }).nextCursor).toBeNull()
    expect(parseMessageListPage({ ...NESTED_PAGE, nextCursor: null }).nextCursor).toBeNull()
  })
})

describe("容错（少解析出一个字段是静默数据缺失，比抛错难查）", () => {
  it("下划线命名的字段也认", () => {
    const page = parseMessageListPage({
      conversation_messages_list: [
        {
          open_conversation_id: "cid-x",
          messages: [{ open_message_id: "m-x", content: "hi", create_time: "2026-07-28 10:00:00" }],
        },
      ],
    })
    expect(page.messages[0]?.externalId).toBe("m-x")
  })

  it("平铺形态（单会话查询）也支持", () => {
    const page = parseMessageListPage({
      openConversationId: "cid-y",
      messages: [{ openMessageId: "m-y", content: "hi", createTime: "2026-07-28 10:00:00" }],
    })
    expect(page.messages[0]?.conversationExternalId).toBe("cid-y")
  })

  it("缺 openMessageId 的条目被跳过（没有幂等键就无法安全入库）", () => {
    const page = parseMessageListPage({
      conversationMessagesList: [
        {
          openConversationId: "cid-z",
          messages: [
            { content: "no id", createTime: "2026-07-28 10:00:00" },
            { openMessageId: "ok", content: "yes", createTime: "2026-07-28 10:00:01" },
          ],
        },
      ],
    })
    expect(page.messages.map((m) => m.externalId)).toEqual(["ok"])
  })

  /**
   * ★ 时间解析失败必须**跳过**，不能默认成 0 或当前时间。
   * 前者让消息落到 1970（图谱时间维度失真），后者让历史消息看起来是刚发的。
   * 两种错都是静默的。
   */
  it("时间解析失败的条目被跳过（不落成 1970 也不落成现在）", () => {
    const page = parseMessageListPage({
      conversationMessagesList: [
        {
          openConversationId: "cid-t",
          messages: [
            { openMessageId: "bad-time", content: "x", createTime: "昨天下午" },
            { openMessageId: "no-time", content: "y" },
            { openMessageId: "good", content: "z", createTime: "2026-07-28 10:00:00" },
          ],
        },
      ],
    })
    expect(page.messages.map((m) => m.externalId)).toEqual(["good"])
  })

  it("unix 时间戳字段优先于字符串（更可靠，无时区歧义）", () => {
    const page = parseMessageListPage({
      conversationMessagesList: [
        {
          openConversationId: "cid-u",
          messages: [
            {
              openMessageId: "m-u",
              content: "x",
              createTimestamp: 1_785_207_229_147,
              createTime: "2000-01-01 00:00:00",
            },
          ],
        },
      ],
    })
    expect(page.messages[0]?.sentAt).toBe(1_785_207_229_147)
  })

  it("空/畸形输入返回空结果而不是抛错", () => {
    for (const bad of [null, undefined, {}, [], "text", 42]) {
      const page = parseMessageListPage(bad)
      expect(page.messages).toEqual([])
      expect(page.conversations).toEqual([])
    }
  })
})

describe("截断检测", () => {
  it("达到 limit 的 90% 即认为可能被截断（limit 语义未明确，按最保守处理）", () => {
    expect(looksTruncated(45, 50)).toBe(true)
    expect(looksTruncated(50, 50)).toBe(true)
    expect(looksTruncated(44, 50)).toBe(false)
  })

  it("limit 为 0 时不判定（避免除零式的误判）", () => {
    expect(looksTruncated(0, 0)).toBe(false)
  })
})
