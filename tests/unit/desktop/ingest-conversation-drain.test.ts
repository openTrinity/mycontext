/**
 * 逐会话「抽干」的翻页行为。
 *
 * ## 为什么这一层必须有自己的测试
 *
 * 首版 `refreshConversation` 是**单次调用** —— 而这条路径是"落后会话唯一的
 * 补救手段"（`reconcileStaleDirected` 靠它，因为全局窗被 7 天夹子挡住，
 * 补不到落后上百天的会话）。只取第一页的表现是**静默数据缺失**：
 * 采集器照常记成功，日志里一个错都没有。
 *
 * 实测证据（真实账号，dws v1.0.52.1）：`chat message list` 每页
 * `hasMore=true`，一个群第一页 97 条而抽干 **636 条**。
 *
 * ## 三条独立的正确性要求（缺一条都会丢消息）
 *
 * ① **循环翻页**：`hasMore=true` 就得继续；
 * ② **退一秒重叠**：时间边界是 exclusive 而 `createTime` 只到秒 ——
 *    以边界那一秒当下一页起点会永久丢掉同秒的其余消息（实测各丢 24 条）；
 * ③ **id 去重 + 前进判据**：退一秒必然让边界那批重复返回，
 *    没有去重就会原地打转烧满预算。
 *
 * 这里用假插件精确复现服务端的这几个行为，断言"翻了几页、请求的时间点是什么、
 * 落库多少条"。
 */
import { describe, expect, it } from "vitest"
import { createLogger, ManualClock } from "@mycontext/kernel"
import type {
  ChannelConversationPullSpec,
  ChannelPlugin,
  ChannelPullPage,
} from "@mycontext/channels"
import {
  ConversationRepository,
  DistillSourceRepository,
  MessageRepository,
} from "@mycontext/store"
import { IngestService } from "@main/services/ingest.service.js"
import { openTestVault } from "../../helpers/vault.js"

const START = 1_700_000_000_000
const CHANNEL = "dingtalk"
const CONV = "cidFAKE0001=="

/** 一条消息。值全是编造的（形状照真实响应）。 */
function message(index: number, sentAt: number) {
  return {
    externalId: `msgFAKE${String(index).padStart(4, "0")}==`,
    conversationExternalId: CONV,
    senderExternalId: "DFAKE0001peer",
    senderDisplayName: "张三",
    contentText: `第 ${String(index)} 条`,
    contentJson: null,
    quotedExternalId: null,
    sentAt,
    mentions: [],
    mentionTexts: [],
    hasMedia: false,
    media: [],
  }
}

interface Call {
  since: number
  direction: string | undefined
}

/**
 * 造一个假渠道：`respond` 决定每次 `pullConversation` 返回什么。
 *
 * 只实现 `pullConversation`（外加一个恒空的 `pull`，因为服务构造要它）。
 */
function makePlugin(
  respond: (spec: ChannelConversationPullSpec, calls: Call[]) => ChannelPullPage,
) {
  const calls: Call[] = []
  const plugin = {
    meta: { id: CHANNEL },
    ingest: {
      probe: async () => null,
      pull: async () => ({
        conversations: [],
        messages: [],
        nextCursor: null,
        hasMore: false,
        itemCount: 0,
        rawPayload: "{}",
      }),
      pullConversation: async (spec: ChannelConversationPullSpec) => {
        calls.push({ since: spec.since, direction: spec.direction })
        return respond(spec, calls)
      },
    },
  } as unknown as ChannelPlugin
  return { plugin, calls }
}

function makeService(plugin: ChannelPlugin, clock: ManualClock) {
  const vault = openTestVault()
  /**
   * ★ 显式写一行「不限会话」的 chat 源。
   *
   * 不写的话 `readCollectionScope` 读成「还没说过要采什么」= 一个都不采
   * （见 collection-scope.ts：清空渠道数据之后正是那个形态，默认值只能是空）。
   * 这些用例测的不是范围闸，所以要把范围明确置成"不限"。
   */
  new DistillSourceRepository(vault.db).upsert("chat", { enabled: true, scope: {} }, 0)
  const service = new IngestService({
    db: vault.db,
    clock,
    logger: createLogger("test-drain", { level: "error" }),
    plugin,
    dbPath: vault.path,
    autoStart: false,
  })
  service.start()
  // 会话必须先在库里 —— `refreshConversation` 从库里读类型与对端。
  const conversations = new ConversationRepository(vault.db)
  conversations.upsert({
    id: "conv-1",
    channelId: CHANNEL,
    externalId: CONV,
    type: "group",
    title: "测试群",
    memberCount: 3,
    isSelfInvolved: true,
    isBotChannel: false,
    lastMessageAt: START,
    createdAt: START,
  })
  return { vault, service, conversations }
}

function page(messages: ReturnType<typeof message>[], hasMore: boolean): ChannelPullPage {
  return {
    conversations: [],
    messages,
    nextCursor: null,
    hasMore,
    itemCount: messages.length,
    rawPayload: "{}",
  }
}

describe("★ 逐会话抽干：不再只取第一页", () => {
  it("hasMore=true 时继续翻，直到服务端说没有了", async () => {
    const clock = new ManualClock(START)
    /**
     * 三页：前两页各 3 条且 `hasMore=true`，第三页 1 条且 `hasMore=false`。
     * 共 **7** 条唯一消息 —— 逐页显式列出而不是用下标算，
     * 算错的话断言会跟着一起错（这条用例第一版就是这么写错的）。
     */
    const pages: ChannelPullPage[] = [
      page([message(1, START + 1_000), message(2, START + 2_000), message(3, START + 3_000)], true),
      page(
        [message(4, START + 11_000), message(5, START + 12_000), message(6, START + 13_000)],
        true,
      ),
      page([message(7, START + 21_000)], false),
    ]
    const { plugin, calls } = makePlugin((_spec, seen) => pages[seen.length - 1] ?? pages[2]!)
    const { vault, service } = makeService(plugin, clock)

    const changed = await service.refreshConversation(CONV)

    // 翻了 3 页(不是 1 页 —— 首版单次调用就停在这里)
    expect(calls).toHaveLength(3)
    // 7 条全部落库
    expect(changed).toBe(7)
    expect(new MessageRepository(vault.db).count()).toBe(7)
    vault.close()
  })

  it("★ 每页起点往回让一秒 —— 否则同秒消息永久丢失", async () => {
    const clock = new ManualClock(START)
    const { plugin, calls } = makePlugin((_spec, seen) =>
      seen.length === 1
        ? page([message(1, START + 5_000), message(2, START + 9_000)], true)
        : page([message(3, START + 20_000)], false),
    )
    const { vault, service } = makeService(plugin, clock)

    await service.refreshConversation(CONV)

    // 第二页的起点 = 第一页最新时间 - 1000ms（不是等于最新时间）
    expect(calls[1]?.since).toBe(START + 9_000 - 1_000)
    vault.close()
  })

  it("方向是 newer（与 since 的语义一致）", async () => {
    const clock = new ManualClock(START)
    const { plugin, calls } = makePlugin(() => page([message(1, START + 1_000)], false))
    const { vault, service } = makeService(plugin, clock)

    await service.refreshConversation(CONV)

    expect(calls[0]?.direction).toBe("newer")
    vault.close()
  })

  it("★ 整页都是见过的 → 停下，不原地打转烧满预算", async () => {
    const clock = new ManualClock(START)
    // 服务端永远返回同一批消息且永远说 hasMore=true（病态响应）
    const { plugin, calls } = makePlugin(() =>
      page([message(1, START + 5_000), message(2, START + 6_000)], true),
    )
    const { vault, service } = makeService(plugin, clock)

    const changed = await service.refreshConversation(CONV)

    // 第二页发现一条新的都没有 → 停。远小于 60 页预算。
    expect(calls.length).toBeLessThanOrEqual(2)
    expect(changed).toBe(2)
    vault.close()
  })

  it("时间不前进 → 停（防死循环）", async () => {
    const clock = new ManualClock(START)
    // 每页都返回**更旧**的消息且 hasMore=true：newest 不会推进
    let index = 0
    const { plugin, calls } = makePlugin(() => {
      index += 1
      // 时间恒定在 since 之前 → nextAt <= cursorAt
      return page([message(index, START - 100_000)], true)
    })
    const { vault, service } = makeService(plugin, clock)

    await service.refreshConversation(CONV)

    expect(calls.length).toBeLessThanOrEqual(2)
    vault.close()
  })
})

describe("★ 不可读会话：明确记成不可读，而不是 0 条", () => {
  it("list-all 的伪消息 → 会话被标记 unreadable", async () => {
    const clock = new ManualClock(START)
    const { plugin } = makePlugin(() => ({
      ...page([], false),
      // 解析层已把伪消息丢掉，只把"这个会话被拒"这个事实传上来
      refusedConversations: [CONV],
    }))
    const { vault, service, conversations } = makeService(plugin, clock)

    await service.refreshConversation(CONV)

    const map = conversations.unreadableByExternalId(CHANNEL)
    expect(map.get(CONV)).toBe("confidential")
    vault.close()
  })

  it("已标记不可读的会话 → 一次请求都不发", async () => {
    const clock = new ManualClock(START)
    const { plugin, calls } = makePlugin(() => page([message(1, START)], false))
    const { vault, service, conversations } = makeService(plugin, clock)
    conversations.markUnreadable(CHANNEL, CONV, "confidential", START)

    const changed = await service.refreshConversation(CONV)

    expect(calls).toHaveLength(0)
    expect(changed).toBe(0)
    vault.close()
  })
})
