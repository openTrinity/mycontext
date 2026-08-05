/**
 * 会话列表的门禁。
 *
 * ## 这些断言防的是什么
 *
 * `chat list-all-conversations` 的 `--help` 描述与实测行为**不一致**
 * （`--cursor` 无效 / `--limit` 硬顶 100 / `hasMore` 恒 false / 无 nextCursor 字段，
 * 见 fixtures 里 REAL_CONVERSATION_LIST 的注释）。照文档写的翻页循环
 * 会「跑一页就停」并且**看起来完全正常** —— 拿到 100 条，无错误，无警告。
 *
 * 所以这里断言的不是"能解析"，而是三条**不可退化**的性质：
 * 1. 不靠 `hasMore` / `--cursor` 翻会话列表（靠了就等于只拿首页却自称完整）；
 * 2. 窗口拉满时必须上报 `truncated`（静默截断是这个项目里出过的那类 bug）；
 * 3. 群列表**要**真翻页（它的游标是好的，不翻就白丢 60 个群）。
 *
 * 每条都验证过可被证伪：把实现改回"读 hasMore 翻页"会让第 1、3 条同时红。
 */
import { describe, expect, it } from "vitest"
import { createDingTalkConversations, unwrapEnvelope } from "@mycontext/channels"
import {
  REAL_CONVERSATION_LIST,
  REAL_CONVERSATION_LIST_EXCLUDE_MUTED,
  REAL_GROUP_LIST_PAGE1,
  REAL_GROUP_LIST_PAGE2,
} from "../../fixtures/dingtalk-real-payloads.js"

/** 记录每次调用的完整 argv，然后按命令回放对应的真实 payload。 */
function createFakeCli(options?: { groupPages?: readonly unknown[] }) {
  const calls: string[][] = []
  const groupPages = options?.groupPages ?? [REAL_GROUP_LIST_PAGE1, REAL_GROUP_LIST_PAGE2]
  let groupCall = 0

  return {
    calls,
    cli: {
      json: <T>(args: readonly string[]): Promise<T> => {
        calls.push([...args])
        if (args[1] === "group") {
          const page = groupPages[Math.min(groupCall, groupPages.length - 1)]
          groupCall += 1
          return Promise.resolve(unwrapEnvelope(page, args) as T)
        }
        const payload = args.includes("--exclude-muted")
          ? REAL_CONVERSATION_LIST_EXCLUDE_MUTED
          : REAL_CONVERSATION_LIST
        return Promise.resolve(unwrapEnvelope(payload, args) as T)
      },
    },
  }
}

describe("dingtalk conversation list", () => {
  it("三路合并：会话窗口 + exclude-muted 窗口 + 全量群列表", async () => {
    const { cli, calls } = createFakeCli()
    const result = await createDingTalkConversations(cli).list()

    // 三个 id 来自会话窗口、1 个来自 exclude-muted 窗口、2+1 个来自群列表两页
    expect(result.items).toHaveLength(7)

    const commands = calls.map((argv) => argv.slice(0, 3).join(" "))
    expect(commands).toContain("chat list-all-conversations --limit")
    expect(commands).toContain("chat group list-all")
    // exclude-muted 那一路必须真的跑了：实测它能多带出 13 个会话
    expect(calls.some((argv) => argv.includes("--exclude-muted"))).toBe(true)
  })

  it("★ 不用 hasMore/--cursor 翻会话列表：fixture 的 hasMore 恒 false 也不能只当一页", async () => {
    const { cli, calls } = createFakeCli()
    await createDingTalkConversations(cli).list()

    const conversationCalls = calls.filter((argv) => argv[1] === "list-all-conversations")
    /**
     * 会话列表**恰好**调两次（主窗口 + exclude-muted），且**都不带 --cursor**。
     *
     * 带了就说明实现又在拿那个无效游标翻页 —— 实测每个 cursor 值返回逐字
     * 相同的首页，于是"翻页"变成了原地打转外加一次多余的子进程调用。
     */
    expect(conversationCalls).toHaveLength(2)
    for (const argv of conversationCalls) {
      expect(argv).not.toContain("--cursor")
    }
  })

  it("★ 群列表必须真翻页：nextCursor 是数字，hasMore 是可信的", async () => {
    const { cli, calls } = createFakeCli()
    await createDingTalkConversations(cli).list()

    const groupCalls = calls.filter((argv) => argv[1] === "group")
    expect(groupCalls).toHaveLength(2)
    // 第一页不带游标，第二页带上一页返回的数字游标（转成串）
    expect(groupCalls[0]).not.toContain("--cursor")
    expect(groupCalls[1]).toContain("--cursor")
    expect(groupCalls[1]).toContain("1782315723736")
  })

  it("nextCursor 归零即终止 —— 否则会拿同一页翻到预算耗尽", async () => {
    // 两页都声明 hasMore:true 但游标一直是 0：实现必须自己停
    const stuck = {
      ...REAL_GROUP_LIST_PAGE2,
      result: { ...REAL_GROUP_LIST_PAGE2.result, hasMore: true, nextCursor: 0 },
    }
    const { cli, calls } = createFakeCli({ groupPages: [stuck] })
    await createDingTalkConversations(cli).list()

    expect(calls.filter((argv) => argv[1] === "group")).toHaveLength(1)
  })

  it("★ 窗口拉满就上报 truncated —— 静默截断比报错更糟", async () => {
    // 造一个"正好等于上限"的首页：这是渠道拿不全时唯一能观测到的信号
    const full = {
      ...REAL_CONVERSATION_LIST,
      result: {
        ...REAL_CONVERSATION_LIST.result,
        conversations: Array.from({ length: 100 }, (_, index) => ({
          ...REAL_CONVERSATION_LIST.result.conversations[0],
          openConversationId: `cidSynthetic${String(index)}==`,
        })),
      },
    }
    const calls: string[][] = []
    const cli = {
      json: <T>(args: readonly string[]): Promise<T> => {
        calls.push([...args])
        if (args[1] === "group")
          return Promise.resolve(unwrapEnvelope(REAL_GROUP_LIST_PAGE2, args) as T)
        return Promise.resolve(unwrapEnvelope(full, args) as T)
      },
    }
    const result = await createDingTalkConversations(cli).list()
    expect(result.truncated).toBe(true)

    // 反面：首页没拉满就不该上报截断（否则这个标记退化成恒真，等于没有）
    const { cli: small } = createFakeCli()
    expect((await createDingTalkConversations(small).list()).truncated).toBe(false)
  })

  it("时间用 ISO 解析：混用消息接口的解析函数会得到 NaN 而不是报错", async () => {
    const { cli } = createFakeCli()
    const result = await createDingTalkConversations(cli).list()

    const single = result.items.find(
      (item) => item.externalId === "cidD3a716b38b52346a4df6f5bc31edd6b588a03bb8f21=",
    )
    expect(single?.kind).toBe("direct")
    expect(single?.lastMessageAt).toBe(Date.parse("2026-07-29T17:16:15.863+08:00"))
    // 每一项要么是有限数要么是 null —— NaN 会让排序结果随机
    for (const item of result.items) {
      if (item.lastMessageAt !== null) expect(Number.isFinite(item.lastMessageAt)).toBe(true)
    }
  })

  it("groupType 的五种取值只有 SINGLE_CHAT 算单聊", async () => {
    const { cli } = createFakeCli()
    const result = await createDingTalkConversations(cli).list()

    // UNKNOWN_TYPE（系统通知）也是群：它有 19 个成员，不是单聊
    const unknown = result.items.find((item) => item.externalId === "cid939d6ce04bc5d4c7ed5224==")
    expect(unknown?.kind).toBe("group")
    expect(result.items.filter((item) => item.kind === "direct")).toHaveLength(1)
  })

  it("群列表来源的最后消息时间是 null —— 那是事实，不能编一个", async () => {
    const { cli } = createFakeCli()
    const result = await createDingTalkConversations(cli).list()

    // 这个群只出现在群列表里（会话窗口没有它），而群列表没有 lastMsgCreateAt
    const groupOnly = result.items.find((item) => item.externalId === "cidB21bfe4e9bfae84a9eec62==")
    expect(groupOnly).toBeDefined()
    expect(groupOnly?.lastMessageAt).toBeNull()
    expect(groupOnly?.memberCount).toBe(17675)
  })

  it("合并不擦掉已知字段：两路都有时保留非空的那个", async () => {
    /**
     * 同一个 id 在会话窗口（有时间）与群列表（有成员数、无时间）里都出现。
     * 后写覆盖会把时间擦成 null —— 那会让它在排序里掉到最后，
     * 看起来像"这个群很久没消息了"。
     */
    const sharedId = "cid3e1cf7dac23168f7cad940=="
    const groupWithSameId = {
      ...REAL_GROUP_LIST_PAGE2,
      result: {
        ...REAL_GROUP_LIST_PAGE2.result,
        groups: [
          {
            ...REAL_GROUP_LIST_PAGE1.result.groups[0],
            openConversationId: sharedId,
            memberCount: 16,
          },
        ],
      },
    }
    const { cli } = createFakeCli({ groupPages: [groupWithSameId] })
    const result = await createDingTalkConversations(cli).list()

    const shared = result.items.find((item) => item.externalId === sharedId)
    expect(shared?.lastMessageAt).toBe(Date.parse("2026-07-29T20:31:04.258+08:00"))
    expect(shared?.title).toBe("连接器产研交流群")
  })
})
