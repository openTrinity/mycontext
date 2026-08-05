/**
 * 「按用户勾选的会话逐个抽干」这一趟。
 *
 * ## 为什么这一层必须有测试
 *
 * 引导页那个会话勾选框曾经**完全没有采集方在读** —— 采集只读了
 * `scope.since`，`conversationIds` 只有蒸馏侧在用（"采全量、蒸的时候才过滤"）。
 *
 * 实测这台机器的后果是两个方向同时错：用户勾了 44 个会话而库里只有 3 个有数据；
 * 同时库里 99% 的消息属于**没勾选**的会话。后者按 CLAUDE.md 第 5 节是
 * **隐私问题**（超出用户选定范围采集），不是"多采点没坏处"。
 *
 * 所以这里断言两件事：勾选的会被逐个抽干；**没勾选的一次请求都不发**。
 */
import { describe, expect, it } from "vitest"
import { createLogger, ManualClock } from "@mycontext/kernel"
import type {
  ChannelConversationPullSpec,
  ChannelPlugin,
  ChannelPullPage,
  ChannelPullSpec,
} from "@mycontext/channels"
import { ConversationRepository, DistillSourceRepository } from "@mycontext/store"
import { IngestService } from "@main/services/ingest.service.js"
import { openTestVault } from "../../helpers/vault.js"

const START = 1_700_000_000_000
const CHANNEL = "dingtalk"
/** 三个会话：前两个会被勾选，第三个不勾（隐私断言用）。 */
const PICKED_A = "cidFAKE0001=="
const PICKED_B = "cidFAKE0002=="
const NOT_PICKED = "cidFAKE0003=="

function emptyGlobalPage(): ChannelPullPage {
  return {
    conversations: [],
    messages: [],
    nextCursor: null,
    hasMore: false,
    itemCount: 0,
    rawPayload: "{}",
  }
}

function makePlugin() {
  /** 逐会话拉取的目标记录 —— 断言"谁被请求过"。 */
  const targets: string[] = []
  const plugin = {
    meta: { id: CHANNEL },
    ingest: {
      probe: async () => null,
      // 全局窗恒空：这条用例只关心逐会话那一趟
      pull: async (_spec: ChannelPullSpec) => emptyGlobalPage(),
      pullConversation: async (spec: ChannelConversationPullSpec) => {
        const id =
          spec.target.kind === "group" ? spec.target.openConversationId : spec.target.peerOpenId
        targets.push(id)
        return {
          ...emptyGlobalPage(),
          messages: [
            {
              externalId: `msgFAKE${String(targets.length).padStart(4, "0")}==`,
              conversationExternalId: id,
              senderExternalId: "DFAKE0001peer",
              senderDisplayName: "张三",
              contentText: "你好",
              contentJson: null,
              quotedExternalId: null,
              sentAt: START + targets.length * 1_000,
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
  return { plugin, targets }
}

function setup(picked: string[]) {
  const clock = new ManualClock(START)
  const { plugin, targets } = makePlugin()
  const vault = openTestVault()
  const service = new IngestService({
    db: vault.db,
    clock,
    logger: createLogger("test-scoped", { level: "error" }),
    plugin,
    dbPath: vault.path,
    autoStart: false,
  })
  service.start()

  const conversations = new ConversationRepository(vault.db)
  for (const externalId of [PICKED_A, PICKED_B, NOT_PICKED]) {
    conversations.upsert({
      id: `conv-${externalId}`,
      channelId: CHANNEL,
      externalId,
      type: "group",
      title: "群",
      memberCount: 3,
      isSelfInvolved: true,
      isBotChannel: false,
      lastMessageAt: START,
      createdAt: START,
    })
  }
  // 引导页写下的范围：时间下界 + 勾选的会话
  new DistillSourceRepository(vault.db).upsert(
    "chat",
    { enabled: true, scope: { since: START - 86_400_000, conversationIds: picked } },
    START,
  )
  return { vault, service, targets, conversations }
}

describe("★ 采集以 conversationIds 驱动（隐私 + 完整性）", () => {
  it("勾选的会话被逐个抽干", async () => {
    const { vault, service, targets } = setup([PICKED_A, PICKED_B])

    await service.tickPull()

    expect(new Set(targets)).toEqual(new Set([PICKED_A, PICKED_B]))
    vault.close()
  })

  it("★★ 没勾选的会话：一次请求都不发（超范围采集是隐私问题）", async () => {
    const { vault, service, targets } = setup([PICKED_A, PICKED_B])

    await service.tickPull()

    expect(targets).not.toContain(NOT_PICKED)
    vault.close()
  })

  it("判定不可读的会话即使被勾选也跳过", async () => {
    const { vault, service, targets, conversations } = setup([PICKED_A, PICKED_B])
    conversations.markUnreadable(CHANNEL, PICKED_A, "confidential", START)

    await service.tickPull()

    expect(targets).not.toContain(PICKED_A)
    expect(targets).toContain(PICKED_B)
    vault.close()
  })

  it("一个都没勾 → 这一趟整体跳过（全局窗已覆盖）", async () => {
    const { vault, service, targets } = setup([])

    await service.tickPull()

    expect(targets).toHaveLength(0)
    vault.close()
  })

  it("★ 勾选数超过单轮预算时轮转，尾部的会话不会永远轮不到", async () => {
    // 预算是每轮 3 个；勾 5 个 → 两轮应覆盖全部 5 个
    const extra = ["cidFAKE0004==", "cidFAKE0005=="]
    const { vault, service, targets, conversations } = setup([
      PICKED_A,
      PICKED_B,
      NOT_PICKED,
      ...extra,
    ])
    for (const externalId of extra) {
      conversations.upsert({
        id: `conv-${externalId}`,
        channelId: CHANNEL,
        externalId,
        type: "group",
        title: "群",
        memberCount: 3,
        isSelfInvolved: true,
        isBotChannel: false,
        lastMessageAt: START,
        createdAt: START,
      })
    }

    await service.tickPull()
    const firstRound = [...targets]
    await service.tickPull()

    // 单轮不超预算
    expect(firstRound.length).toBeLessThanOrEqual(3)
    // 两轮之后全部 5 个都被请求过（轮转生效，尾部没被饿死）
    expect(new Set(targets).size).toBe(5)
    vault.close()
  })
})
