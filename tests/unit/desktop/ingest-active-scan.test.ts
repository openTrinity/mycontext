/**
 * L1.5 轮转扫描：按最近活跃优先扫全部会话，补探针的盲区。
 *
 * ## 为什么这一级必须有自己的测试
 *
 * 探针（L1）只调 `chat message list-unread-conversations` —— 它只返回**有未读
 * 红点**的会话。实测这台机器：探针 **23** 个，会话全集 **173** 个，
 * 覆盖率 **13.3%**；而盲区里有 **33 个会话在 48 小时内有新消息**。
 * 成因很直接：在客户端读过就没红点了，而"读过"恰恰说明那是最活跃的会话。
 *
 * 原来唯一的兜底是 L2 全量分页（2 分钟一轮），而实测它自己的召回只有
 * **89.8%**。合起来是「探针漏 87% 的会话，兜底漏 10% 的消息」——
 * 两层都不报错，表现只是"数据不全"。
 *
 * 这一级的正确性有四条独立要求，缺一条它就退化：
 * ① **判据是时间戳比对**（渠道的 `lastMessageAt` vs 库里最新一条），
 *    而不是逐会话发请求 —— 后者 173 次子进程，30 秒一轮跑不完；
 * ② **按活跃度降序**（DWS 自己不排序，实测无 sort flag 且顺序不严格）；
 * ③ **轮转**，否则命中数超预算时尾部永远轮不到；
 * ④ **尊重勾选范围 + 跳过不可读**（超范围采集是隐私问题）。
 */
import { describe, expect, it } from "vitest"
import { createLogger, ManualClock } from "@mycontext/kernel"
import type {
  ChannelConversationItem,
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

function emptyPage(): ChannelPullPage {
  return {
    conversations: [],
    messages: [],
    nextCursor: null,
    hasMore: false,
    itemCount: 0,
    rawPayload: "{}",
  }
}

/**
 * 造一个假渠道。
 *
 * `directory` 是渠道**说**的会话目录（含 `lastMessageAt`）；
 * `pulled` 记录哪些会话真的被定向补拉过 —— 断言全靠它。
 */
function makePlugin(directory: ChannelConversationItem[]) {
  const pulled: string[] = []
  let directoryCalls = 0
  const plugin = {
    meta: { id: CHANNEL },
    conversations: {
      list: async () => {
        directoryCalls += 1
        return { items: directory, truncated: false }
      },
    },
    ingest: {
      probe: async () => null,
      pull: async () => emptyPage(),
      pullConversation: async (spec: ChannelConversationPullSpec) => {
        const id =
          spec.target.kind === "group" ? spec.target.openConversationId : spec.target.peerOpenId
        pulled.push(id)
        return {
          ...emptyPage(),
          messages: [
            {
              externalId: `msgFAKE${String(pulled.length).padStart(4, "0")}==`,
              conversationExternalId: id,
              senderExternalId: "DFAKE0001peer",
              senderDisplayName: "张三",
              contentText: "你好",
              contentJson: null,
              quotedExternalId: null,
              sentAt: START + pulled.length * 1_000,
              mentions: [],
              mentionTexts: [],
              hasMedia: false,
              media: [],
            },
          ],
          itemCount: 1,
        }
      },
    },
  } as unknown as ChannelPlugin
  return { plugin, pulled, calls: () => directoryCalls }
}

function item(
  externalId: string,
  lastMessageAt: number | null,
  title = "群",
): ChannelConversationItem {
  return { externalId, title, kind: "group", memberCount: 3, lastMessageAt }
}

/**
 * 装配。`ours` 给"库里这个会话最新一条的时间"（不给 = 库里一条都没有）。
 */
function setup(
  directory: ChannelConversationItem[],
  ours: Record<string, number> = {},
  scoped: string[] = [],
) {
  const clock = new ManualClock(START)
  const { plugin, pulled, calls } = makePlugin(directory)
  const vault = openTestVault()
  const service = new IngestService({
    db: vault.db,
    clock,
    logger: createLogger("test-scan", { level: "error" }),
    plugin,
    dbPath: vault.path,
    autoStart: false,
  })
  service.start()

  const conversations = new ConversationRepository(vault.db)
  const messages = new MessageRepository(vault.db)
  for (const entry of directory) {
    conversations.upsert({
      id: `conv-${entry.externalId}`,
      channelId: CHANNEL,
      externalId: entry.externalId,
      type: "group",
      title: entry.title,
      memberCount: entry.memberCount,
      isSelfInvolved: true,
      isBotChannel: false,
      lastMessageAt: entry.lastMessageAt,
      createdAt: START,
    })
    const at = ours[entry.externalId]
    if (at !== undefined) {
      messages.upsertMany([
        {
          id: `msg-${entry.externalId}`,
          channelId: CHANNEL,
          conversationId: `conv-${entry.externalId}`,
          externalId: `msgOURS${entry.externalId}`,
          senderExternalId: "DFAKE0001peer",
          senderDisplayName: "张三",
          contentText: "旧消息",
          sentAt: at,
          direction: "inbound",
          origin: "human",
          createdAt: at,
        },
      ])
    }
  }
  /**
   * 采集范围。
   *
   * ★ `scoped` 为空时也要写一行 —— 只是**不带** `conversationIds`
   * （那才是"不限会话"）。完全不写的话 `readCollectionScope` 现在读成
   * 「还没说过要采什么」= 一个都不采（见 collection-scope.ts 那段：
   * 清空渠道数据之后正是这个形态，默认值只能是空）。
   */
  new DistillSourceRepository(vault.db).upsert(
    "chat",
    {
      enabled: true,
      scope: {
        since: START - 86_400_000,
        ...(scoped.length > 0 ? { conversationIds: scoped } : {}),
      },
    },
    START,
  )
  return { vault, service, pulled, calls, conversations }
}

describe("★★ 轮转扫描：补探针的 87% 盲区", () => {
  it("★ 渠道说有新消息而库里没有 → 定向补拉", async () => {
    // A 落后（渠道 > 库里）；B 已追平（相等）
    const { vault, service, pulled } = setup(
      [item("cidFAKE0001==", START + 5_000), item("cidFAKE0002==", START + 1_000)],
      { "cidFAKE0001==": START + 1_000, "cidFAKE0002==": START + 1_000 },
    )

    await service.tickActiveScan()

    expect(pulled).toEqual(["cidFAKE0001=="])
    vault.close()
  })

  it("★★ 库里一条都没有的会话也算落后（那是最该补的一类）", async () => {
    // 实测有 3 个会话我们一条消息都没有，而探针报未读 1/35/35
    const { vault, service, pulled } = setup([item("cidFAKE0009==", START + 5_000)], {})

    await service.tickActiveScan()

    expect(pulled).toEqual(["cidFAKE0009=="])
    vault.close()
  })

  it("★★ 按最近活跃**降序**补（DWS 自己不排序）", async () => {
    /**
     * 实测 `chat list-all-conversations` 没有 sort flag，返回顺序大体降序
     * 但不严格（99 个相邻对里 22 个逆序）。所以排序必须在我们这边做。
     * 这里刻意按**升序**喂进去，断言补拉顺序是降序。
     */
    const { vault, service, pulled } = setup([
      item("cidOLD00001==", START + 1_000),
      item("cidMID00001==", START + 5_000),
      item("cidNEW00001==", START + 9_000),
    ])

    await service.tickActiveScan()

    expect(pulled).toEqual(["cidNEW00001==", "cidMID00001==", "cidOLD00001=="])
    vault.close()
  })

  it("★ 单轮不超预算，且轮转让尾部不被饿死", async () => {
    // 预算 5 个；给 7 个全落后 → 两轮应覆盖全部 7 个
    const directory = Array.from({ length: 7 }, (_, i) =>
      item(`cidFAKE000${String(i)}==`, START + (7 - i) * 1_000),
    )
    const { vault, service, pulled } = setup(directory)

    await service.tickActiveScan()
    const firstRound = [...pulled]
    await service.tickActiveScan()

    expect(firstRound).toHaveLength(5)
    expect(new Set(pulled).size).toBe(7)
    vault.close()
  })

  it("★★ 勾选过范围时只扫勾选的（超范围采集是隐私问题）", async () => {
    const { vault, service, pulled } = setup(
      [item("cidPICKED01==", START + 9_000), item("cidNOTPICK1==", START + 8_000)],
      {},
      ["cidPICKED01=="],
    )

    await service.tickActiveScan()

    expect(pulled).toEqual(["cidPICKED01=="])
    vault.close()
  })

  it("★ 判定不可读的会话跳过（保密群识别过就不再碰）", async () => {
    const { vault, service, pulled, conversations } = setup([
      item("cidSECRET01==", START + 9_000),
      item("cidNORMAL01==", START + 8_000),
    ])
    conversations.markUnreadable(CHANNEL, "cidSECRET01==", "confidential", START)

    await service.tickActiveScan()

    expect(pulled).toEqual(["cidNORMAL01=="])
    vault.close()
  })

  it("渠道没给最后消息时间的会话跳过（无从判断是否落后）", async () => {
    const { vault, service, pulled } = setup([item("cidFAKE0001==", null)])

    await service.tickActiveScan()

    expect(pulled).toEqual([])
    vault.close()
  })

  it("全部追平 → 一次补拉都不发（稳态开销接近零）", async () => {
    const { vault, service, pulled } = setup(
      [item("cidFAKE0001==", START + 1_000), item("cidFAKE0002==", START + 2_000)],
      { "cidFAKE0001==": START + 1_000, "cidFAKE0002==": START + 2_000 },
    )

    await service.tickActiveScan()

    expect(pulled).toEqual([])
    vault.close()
  })

  it("★ 会话目录带缓存 —— 三路合并实测 4.8s，比扫描周期还长", async () => {
    const { vault, service, calls } = setup([item("cidFAKE0001==", START + 5_000)])

    await service.tickActiveScan()
    await service.tickActiveScan()
    await service.tickActiveScan()

    // 三轮只取一次目录（TTL 2 分钟内）
    expect(calls()).toBe(1)
    vault.close()
  })
})
