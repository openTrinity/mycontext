/**
 * 飞书会话列举（`im +chat-list`）。
 *
 * ## 锁的是哪个 bug
 *
 * 飞书插件原来**没有** `conversations` 能力，于是引导「学习范围」那一步走
 * `DistillSourceService.conversations()` 里 `list === undefined` 的降级分支
 * （只给本地已采的部分）。新装的机器上本地是空的 → **列表恒空**，
 * 而那条分支当时连一句日志都没有。
 *
 * 当时判成"飞书设计上不支持列会话"。核实后不成立：CLI 有 `im +chat-list`
 * 且 `--help` 自报 `Risk: read`，只是我们的白名单里没放行。
 *
 * ## fixture 照实测形状写，值全是编的
 *
 * 真实响应（2026-08，随包 CLI）逐项 8 个字段。这里结构照抄、
 * id/名字全换成明显假的（`oc_FAKE…` / 张三）—— 见 CLAUDE.md 1.2。
 */
import { describe, expect, it, vi } from "vitest"
import {
  assertAllowedLarkCommand,
  createFeishuConversations,
  parseLarkChatList,
} from "@mycontext/channels"

/** 一页响应。`chats` 传 null 可模拟"没有群"那个真实形态。 */
function page(
  chats: unknown,
  extra: { has_more?: boolean; page_token?: string | null } = {},
): unknown {
  return {
    ok: true,
    identity: "user",
    data: {
      chats,
      has_more: extra.has_more ?? false,
      page_token: extra.page_token ?? null,
    },
  }
}

function chat(id: string, mode: "p2p" | "group" | "topic", name: string, targetType?: string) {
  return {
    chat_id: id,
    chat_mode: mode,
    chat_status: "normal",
    external: false,
    name,
    ...(mode === "p2p"
      ? { p2p_target_id: "ou_FAKE0001", p2p_target_type: targetType ?? "user" }
      : {}),
    tenant_key: "FAKE000000000000",
  }
}

describe("★★ parseLarkChatList", () => {
  /**
   * ★★★ `chats` 为 `null` 不许抛 —— 实测账号没有群时就是这个形态。
   * 反证：把 `array()` 换成裸 `.map` → 必红。
   */
  it("★★★ chats 为 null → 空列表，不抛", () => {
    const parsed = parseLarkChatList(page(null))
    expect(parsed.items).toEqual([])
    expect(parsed.hasMore).toBe(false)
  })

  /** ★★ p2p → direct，group/topic → group。 */
  it("★★ chat_mode 映射成 direct / group", () => {
    const parsed = parseLarkChatList(
      page([
        chat("oc_FAKE0001", "p2p", "张三"),
        chat("oc_FAKE0002", "group", "项目群"),
        chat("oc_FAKE0003", "topic", "话题群"),
      ]),
    )
    expect(parsed.items.map((i) => [i.externalId, i.kind])).toEqual([
      ["oc_FAKE0001", "direct"],
      ["oc_FAKE0002", "group"],
      // topic 归 group：上层只有两种，而它在"要不要采"上与普通群没区别
      ["oc_FAKE0003", "group"],
    ])
  })

  /**
   * ★★ 机器人会话**照常列出**（不过滤 `p2p_target_type: bot`）。
   *
   * 实测这个账号 4 个 p2p 里 3 个是 bot。藏掉等于"4 个只显示 1 个"
   * 且无从解释，而它们的消息本来就在库里。选不选由用户定。
   */
  it("★★ 机器人单聊不被过滤", () => {
    const parsed = parseLarkChatList(
      page([
        chat("oc_FAKE0001", "p2p", "某应用", "bot"),
        chat("oc_FAKE0002", "p2p", "张三", "user"),
      ]),
    )
    expect(parsed.items).toHaveLength(2)
  })

  /**
   * ★ 成员数与最后消息时间**给 null 不猜**：这条命令不返回它们
   * （实测字段只有那 8 个）。猜一个 now 会让下游按时间窗过滤时全部命中。
   */
  it("★ memberCount / lastMessageAt 恒为 null（命令不返回）", () => {
    const parsed = parseLarkChatList(page([chat("oc_FAKE0001", "group", "项目群")]))
    expect(parsed.items[0]?.memberCount).toBeNull()
    expect(parsed.items[0]?.lastMessageAt).toBeNull()
  })

  /** ★ 没有 chat_id 的条目跳过（白名单里没有能反查它的命令）。 */
  it("★ 缺 chat_id 的条目跳过", () => {
    const parsed = parseLarkChatList(page([{ chat_mode: "group", name: "无 id 的群" }]))
    expect(parsed.items).toEqual([])
  })
})

describe("★★ createFeishuConversations 分页", () => {
  /** 命令必须在白名单里 —— 否则运行时被 `assertAllowedLarkCommand` 拦掉。 */
  it("★★ im +chat-list 已进只读白名单", () => {
    expect(() => assertAllowedLarkCommand(["im", "+chat-list"])).not.toThrow()
  })

  /**
   * ★★★ **必须显式传 `--types=p2p,group`**。
   *
   * 不传等于只要群（CLI 帮助文本："omit = groups only"），
   * 于是单聊一个都列不出来 —— 而实测这个账号的会话**全是**单聊。
   * 反证：去掉那个参数 → 必红。
   */
  it("★★★ 请求带 --types=p2p,group（不带的话单聊全丢）", async () => {
    const calls: string[][] = []
    const cli = {
      json: vi.fn(async (args: string[]) => {
        calls.push(args)
        return page([chat("oc_FAKE0001", "p2p", "张三")])
      }),
    }
    await createFeishuConversations(cli as never).list()
    expect(calls[0]).toContain("--types=p2p,group")
  })

  /**
   * ★★★ `hasMore=true` 就要继续翻 —— 只取第一页而对外说"采完了"
   * 是最典型的静默数据缺失（CLAUDE.md 第 5 节）。
   */
  it("★★★ hasMore 为真时抽干后续页", async () => {
    const pages = [
      page([chat("oc_FAKE0001", "group", "群一")], { has_more: true, page_token: "t1" }),
      page([chat("oc_FAKE0002", "group", "群二")], { has_more: true, page_token: "t2" }),
      page([chat("oc_FAKE0003", "group", "群三")]),
    ]
    let n = 0
    const tokens: (string | undefined)[] = []
    const cli = {
      json: vi.fn(async (args: string[]) => {
        const at = args.indexOf("--page-token")
        tokens.push(at === -1 ? undefined : args[at + 1])
        return pages[n++]
      }),
    }
    const result = await createFeishuConversations(cli as never).list()
    expect(result.items.map((i) => i.externalId)).toEqual([
      "oc_FAKE0001",
      "oc_FAKE0002",
      "oc_FAKE0003",
    ])
    // 游标要真的带上（第一页不带）
    expect(tokens).toEqual([undefined, "t1", "t2"])
    expect(result.truncated).toBe(false)
  })

  /**
   * ★★ `hasMore=true` 却没给游标 → 翻不下去，而这**是**截断。
   * 说成"采完了"就是静默丢数据。
   */
  it("★★ hasMore 为真但没有游标 → truncated", async () => {
    const cli = {
      json: vi.fn(async () =>
        page([chat("oc_FAKE0001", "group", "群一")], { has_more: true, page_token: null }),
      ),
    }
    const result = await createFeishuConversations(cli as never).list()
    expect(result.truncated).toBe(true)
    expect(result.items).toHaveLength(1)
  })

  /** ★ 分页边界上重复出现同一个会话要去重。 */
  it("★ 跨页重复的会话只留一份", async () => {
    const pages = [
      page([chat("oc_FAKE0001", "group", "群一")], { has_more: true, page_token: "t1" }),
      page([chat("oc_FAKE0001", "group", "群一"), chat("oc_FAKE0002", "group", "群二")]),
    ]
    let n = 0
    const cli = { json: vi.fn(async () => pages[n++]) }
    const result = await createFeishuConversations(cli as never).list()
    expect(result.items.map((i) => i.externalId)).toEqual(["oc_FAKE0001", "oc_FAKE0002"])
  })

  /**
   * ★★ 服务端 `hasMore` 恒真时不许死循环 —— 这个调用在**用户等着看列表**
   * 的路径上。到上限就停并标 truncated（诚实地说"不完整"）。
   */
  it("★★ hasMore 恒真 → 到上限停止并标 truncated", async () => {
    let n = 0
    const cli = {
      json: vi.fn(async () => {
        n += 1
        return page([chat(`oc_FAKE${String(n).padStart(4, "0")}`, "group", `群${n}`)], {
          has_more: true,
          page_token: `t${n}`,
        })
      }),
    }
    const result = await createFeishuConversations(cli as never).list()
    expect(result.truncated).toBe(true)
    // 20 页上限（见 conversations.ts 的 MAX_PAGES）
    expect(n).toBe(20)
  })
})
