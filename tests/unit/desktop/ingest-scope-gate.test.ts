/**
 * 采集范围闸：**全局窗**那一路的越界拦截。
 *
 * ## 为什么必须有这一层测试（这是隐私边界）
 *
 * `ingest-scoped-drain.test.ts` 测的是「按勾选的会话逐个抽干」那一趟 ——
 * 它天然只碰勾选的会话。而库里越界数据的**真正来源是全局窗**：
 * `chat message list-all` 只接受时间窗（`--start/--end/--cursor/--limit`），
 * **没有会话过滤参数**，所以服务端一定会把窗内所有会话的消息都返回。
 * 也就是说"不采越界会话"这件事在渠道侧无法表达，只能在落库前拦。
 *
 * 实测（修复前，本机 vault）：84,325 条消息里 46,415 条（55%）属于用户
 * 没勾的 178 个会话；最近 1 小时新落库的 327 条里 208 条（64%）仍越界。
 * 按 CLAUDE.md 第 5 节这是隐私问题，不是"多采点没坏处"。
 *
 * 所以这里断言的是**结果**（库里只剩范围内的），而不是"某个函数被调过"。
 */
import { describe, expect, it } from "vitest"
import { createLogger, ManualClock } from "@mycontext/kernel"
import type { ChannelPlugin, ChannelPullPage, ChannelPullSpec } from "@mycontext/channels"
import {
  ConversationRepository,
  DistillSourceRepository,
  readCollectionScope,
} from "@mycontext/store"
import { IngestService } from "@main/services/ingest.service.js"
import { openTestVault, type TestVault } from "../../helpers/vault.js"

const START = 1_700_000_000_000
const CHANNEL = "dingtalk"
const PICKED = "cidFAKE0001=="
const NOT_PICKED = "cidFAKE0002=="

/** 一页里混着两个会话的消息 —— 正是 `list-all` 的真实形状。 */
function mixedPage(sentAt = START): ChannelPullPage {
  return {
    conversations: [
      { externalId: PICKED, title: "勾了的群", type: "group", memberCount: 3 },
      { externalId: NOT_PICKED, title: "没勾的群", type: "group", memberCount: 5 },
    ],
    messages: [
      {
        externalId: "msgFAKE0001==",
        conversationExternalId: PICKED,
        senderExternalId: "DFAKE0001peer",
        senderDisplayName: "张三",
        contentText: "在范围内",
        contentJson: null,
        quotedExternalId: null,
        sentAt,
        mentions: [],
        mentionTexts: [],
        hasMedia: false,
        media: [],
      },
      {
        externalId: "msgFAKE0002==",
        conversationExternalId: NOT_PICKED,
        senderExternalId: "DFAKE0002peer",
        senderDisplayName: "李四",
        contentText: "越界的内容",
        contentJson: null,
        quotedExternalId: null,
        sentAt,
        mentions: [],
        mentionTexts: [],
        hasMedia: false,
        media: [],
      },
    ],
    nextCursor: null,
    hasMore: false,
    itemCount: 2,
    rawPayload: "{}",
  }
}

function makePlugin(page: () => ChannelPullPage) {
  /** 逐会话拉取的目标 —— 断言"越界会话一次请求都不发"。 */
  const directedTargets: string[] = []
  const plugin = {
    meta: { id: CHANNEL },
    ingest: {
      probe: async () => null,
      pull: async (_spec: ChannelPullSpec) => page(),
      pullConversation: async (spec: {
        target:
          | { kind: "group"; openConversationId: string }
          | { kind: "direct"; peerOpenId: string }
      }) => {
        directedTargets.push(
          spec.target.kind === "group" ? spec.target.openConversationId : spec.target.peerOpenId,
        )
        return { ...mixedPage(), messages: [], itemCount: 0 }
      },
    },
  } as unknown as ChannelPlugin
  return { plugin, directedTargets }
}

function setup(options: { picked?: string[]; since?: number; page?: () => ChannelPullPage } = {}) {
  const clock = new ManualClock(START + 60_000)
  const { plugin, directedTargets } = makePlugin(options.page ?? (() => mixedPage()))
  const vault = openTestVault()
  const service = new IngestService({
    db: vault.db,
    clock,
    logger: createLogger("test-scope-gate", { level: "error" }),
    plugin,
    dbPath: vault.path,
    autoStart: false,
  })
  service.start()

  // 两个会话都在库里（目录不受范围限制 —— 否则取消勾选就再也勾不回来）
  const conversations = new ConversationRepository(vault.db)
  for (const externalId of [PICKED, NOT_PICKED]) {
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

  if (options.picked !== undefined) {
    new DistillSourceRepository(vault.db).upsert(
      "chat",
      {
        enabled: true,
        scope: {
          ...(options.since === undefined ? {} : { since: options.since }),
          conversationIds: options.picked,
        },
      },
      START,
    )
  }
  return { vault, service, clock, directedTargets }
}

/** 库里某个会话的消息条数（按 external_id）。 */
function countIn(vault: TestVault, externalId: string): number {
  return (
    vault.db
      .prepare<[string], { c: number }>(
        `SELECT count(*) AS c FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
          WHERE c.external_id = ?`,
      )
      .get(externalId)?.c ?? 0
  )
}

describe("★★ 全局窗的越界消息在落库前被丢掉（隐私边界）", () => {
  it("勾了 A 没勾 B：A 落库、B 一条都不落", async () => {
    const { vault, service } = setup({ picked: [PICKED] })

    await service.tickPull()

    expect(countIn(vault, PICKED)).toBe(1)
    expect(countIn(vault, NOT_PICKED)).toBe(0)
    vault.close()
  })

  it("★ 越界的会话**目录**仍然保留（否则取消勾选后再也勾不回来）", async () => {
    const { vault, service } = setup({ picked: [PICKED] })

    await service.tickPull()

    // 会话行还在：引导页要能把它列为可选项，定向补拉要靠它判类型
    const row = new ConversationRepository(vault.db).findByExternalId(CHANNEL, NOT_PICKED)
    expect(row).not.toBeNull()
    vault.close()
  })

  it("没配范围（老库 / 跳过引导）→ 不设限，两个都落库", async () => {
    const { vault, service } = setup({})

    await service.tickPull()

    expect(countIn(vault, PICKED)).toBe(1)
    expect(countIn(vault, NOT_PICKED)).toBe(1)
    vault.close()
  })

  it("★★ 配了范围但一个都没勾 → 一条都不采（不是「不限」）", async () => {
    const { vault, service } = setup({ picked: [] })

    await service.tickPull()

    expect(countIn(vault, PICKED)).toBe(0)
    expect(countIn(vault, NOT_PICKED)).toBe(0)
    vault.close()
  })

  it("★ chat 源被关掉 → 一条都不采（修复前这被当成「不限」= 采全部）", async () => {
    const { vault, service } = setup({ picked: [PICKED] })
    new DistillSourceRepository(vault.db).upsert(
      "chat",
      { enabled: false, scope: { conversationIds: [PICKED] } },
      START,
    )

    await service.tickPull()

    expect(countIn(vault, PICKED)).toBe(0)
    vault.close()
  })

  it("★ 时间下界也卡：早于 since 的消息不落库", async () => {
    const old = START - 30 * 86_400_000
    const { vault, service } = setup({
      picked: [PICKED],
      since: START - 86_400_000,
      page: () => mixedPage(old),
    })

    await service.tickPull()

    // 会话在白名单里，但消息早于用户选的下界
    expect(countIn(vault, PICKED)).toBe(0)
    vault.close()
  })

  it("整页都越界时不写 raw_records（整页原始响应含越界正文）", async () => {
    const { vault, service } = setup({ picked: [] })

    await service.tickPull()

    const raws =
      vault.db.prepare<[], { c: number }>("SELECT count(*) AS c FROM raw_records").get()?.c ?? 0
    expect(raws).toBe(0)
    vault.close()
  })

  it("丢弃条数进快照（不能静默 —— 否则与「这段时间没消息」同形）", async () => {
    const { vault, service } = setup({ picked: [PICKED] })

    await service.tickPull()

    const snapshot = service.snapshot()
    expect(snapshot.scope.restricted).toBe(true)
    expect(snapshot.scope.allowed).toBe(1)
    /**
     * ★ 断言"至少 1"而不是精确值：一轮 `tickPull` 里有**多条**路径会调
     * `ingest.pull`（主窗、对账、回填、补空洞），而这个假插件对每次调用
     * 都返回同一页混合数据 —— 于是每条跑到的路径各丢一条。
     *
     * 精确值会把"这一轮恰好跑了几条路径"焊进断言，而那是调度细节，
     * 改了预算或顺序就会假失败。这里要证明的是**丢弃被计入了**。
     */
    expect(snapshot.scope.droppedOutOfScope).toBeGreaterThanOrEqual(1)
    expect(snapshot.scope.lastDroppedAt).not.toBeNull()
    vault.close()
  })

  it("不限时 allowed 报 null 而不是 0（0 会被读成「许可零个」）", async () => {
    const { vault, service } = setup({})

    await service.tickPull()

    expect(service.snapshot().scope.restricted).toBe(false)
    expect(service.snapshot().scope.allowed).toBeNull()
    vault.close()
  })
})

describe("★★ 定向补拉（探针/事件/对账/常驻）不碰越界会话", () => {
  it("越界会话：一次定向请求都不发（不只是不落库）", async () => {
    const { vault, service, directedTargets } = setup({ picked: [PICKED] })

    const changed = await service.refreshConversation(NOT_PICKED)

    expect(changed).toBe(0)
    expect(directedTargets).toHaveLength(0)
    vault.close()
  })

  it("范围内的会话照常补拉", async () => {
    const { vault, service, directedTargets } = setup({ picked: [PICKED] })

    await service.refreshConversation(PICKED)

    expect(directedTargets).toEqual([PICKED])
    vault.close()
  })

  it("★ 自己刚发出的那条例外：越界会话也要能秒级拉回来显示", async () => {
    const { vault, service, directedTargets } = setup({ picked: [PICKED] })

    await service.refreshConversation(NOT_PICKED, { reason: "self-sent" })

    // 请求发了（用户正盯着等它出现），但落库仍过 persist 的闸
    expect(directedTargets).toEqual([NOT_PICKED])
    expect(countIn(vault, NOT_PICKED)).toBe(0)
    vault.close()
  })
})

describe("范围权威（readCollectionScope）的三态", () => {
  it("表里没这一行 = 没配过 → 不设限", () => {
    const vault = openTestVault()
    expect(readCollectionScope(vault.db).restricted).toBe(false)
    vault.close()
  })

  it("配了空数组 = 一个都不勾 → restricted 且 allow 为空", () => {
    const vault = openTestVault()
    new DistillSourceRepository(vault.db).upsert(
      "chat",
      { enabled: true, scope: { conversationIds: [] } },
      START,
    )
    const scope = readCollectionScope(vault.db)
    expect(scope.restricted).toBe(true)
    expect(scope.allow.size).toBe(0)
    vault.close()
  })

  it("没写 conversationIds 键 = 不限会话（只配了时间）", () => {
    const vault = openTestVault()
    new DistillSourceRepository(vault.db).upsert(
      "chat",
      { enabled: true, scope: { since: START } },
      START,
    )
    const scope = readCollectionScope(vault.db)
    expect(scope.restricted).toBe(false)
    expect(scope.since).toBe(START)
    vault.close()
  })

  it("★ 坏 JSON 按最严处理（判据不可靠时采全部是隐私问题）", () => {
    const vault = openTestVault()
    new DistillSourceRepository(vault.db).upsert("chat", { enabled: true, scope: {} }, START)
    vault.db.prepare("UPDATE distill_sources SET scope_json = '{oops' WHERE kind = 'chat'").run()
    const scope = readCollectionScope(vault.db)
    expect(scope.restricted).toBe(true)
    expect(scope.allow.size).toBe(0)
    vault.close()
  })
})
