/**
 * 数据面对事件通路的接线。
 *
 * events.ts 自己已经把 consumer 的逻辑（ready 陷阱、去重、退避、退订）测透了；
 * 这里只锁**数据面这一层的两条接线**，它们是"确保所有消息都能拿到"的落点：
 *
 * ① 事件信号 → `refreshConversation` → 那个会话的正文**真的落库**
 *    （事件只是叫醒，正文走采集那条路）；
 * ② 事件通路的健康**出现在 snapshot 里**（状态页要能看出"接通但零投递"）。
 *
 * 用一个**假 events 工厂**（不起真 `dws` 子进程）+ 假 feed + 真 vault。
 */
import { describe, expect, it } from "vitest"
import { createLogger, ManualClock } from "@mycontext/kernel"
import type {
  ChannelConversationPullSpec,
  ChannelEvents,
  ChannelEventsDeps,
  ChannelPlugin,
  ChannelPullPage,
} from "@mycontext/channels"
import { ConversationRepository, DistillSourceRepository } from "@mycontext/store"
import { DataPlaneService } from "@main/services/data-plane.service.js"
import type { FeedService } from "@main/services/feed.service.js"
import { openTestVault } from "../../helpers/vault.js"

const NOW = 1_700_000_000_000

/** feed 只需要 attach/detach 是可 await 的 no-op（本测试不碰导出）。 */
const fakeFeed = {
  attach: async () => {},
  detach: async () => {},
} as unknown as FeedService

function emptyPage(messages: ChannelPullPage["messages"] = []): ChannelPullPage {
  return {
    conversations: [],
    messages,
    nextCursor: null,
    hasMore: false,
    itemCount: messages.length,
    rawPayload: "{}",
  }
}

/**
 * 假 events 通路：把 DataPlane 传进来的 onSignal 抓出来，让测试能**主动**
 * 发一条事件（模拟 stdout 收到），并能报一个可控的 health。
 */
function makeFakeEvents() {
  let captured: ChannelEventsDeps | null = null
  let started = false
  let stopped = false
  const stream: ChannelEvents = {
    start() {
      started = true
    },
    async stop() {
      stopped = true
    },
    health() {
      // 模拟"接通但零投递"：ready 但 delivered=0。
      return {
        state: started && !stopped ? "ready" : "stopped",
        lastEventAt: null,
        delivered: 0,
        reconnects: 0,
      }
    },
    /**
     * 假对账：目录 3 个 key，其中 at 是全局、o2o/group 逐会话，当前 0 个订阅
     * —— 正是实测这台机器的形状（覆盖面结构性不全）。
     */
    async audit() {
      return {
        catalog: [
          "user_im_message_receive_at",
          "user_im_message_receive_o2o",
          "user_im_message_receive_group",
        ],
        globalKeys: ["user_im_message_receive_at"],
        perConversationKeys: ["user_im_message_receive_o2o", "user_im_message_receive_group"],
        activeSubscriptions: 0,
        error: null,
      }
    },
  }
  return {
    factory: (deps: ChannelEventsDeps): ChannelEvents => {
      captured = deps
      return stream
    },
    fire: (eventId: string, conversationExternalId: string) =>
      captured?.onSignal({ eventId, conversationExternalId }),
    started: () => started,
    stopped: () => stopped,
  }
}

/**
 * 假钉钉插件：ingest 有 pullConversation（定向补拉），events 是上面的假工厂。
 * pullConversation 返回一条新消息 —— 事件叫醒后应当把它落库。
 */
function makePlugin(events: (deps: ChannelEventsDeps) => ChannelEvents) {
  const plugin = {
    meta: { id: "dingtalk" },
    ingest: {
      probe: async () => null,
      pull: async () => emptyPage(),
      pullConversation: async (spec: ChannelConversationPullSpec) =>
        emptyPage([
          {
            externalId: `ev-${spec.target.kind === "group" ? spec.target.openConversationId : "d"}`,
            conversationExternalId:
              spec.target.kind === "group" ? spec.target.openConversationId : "cid-g",
            senderExternalId: "peer",
            senderDisplayName: "小李",
            contentText: "事件叫醒后补拉到的这条",
            contentJson: null,
            quotedExternalId: null,
            sentAt: NOW + 1_000,
            mentions: [],
            hasMedia: false,
          },
        ]),
    },
    events,
  } as unknown as ChannelPlugin
  return plugin
}

function makeDataPlane(events: ReturnType<typeof makeFakeEvents>) {
  const vault = openTestVault()
  /**
   * ★ 显式写一行「不限会话」的 chat 源。
   *
   * 不写的话 `readCollectionScope` 读成「还没说过要采什么」= 一个都不采
   * （见 collection-scope.ts：清空渠道数据之后正是那个形态，默认值只能是空）。
   * 这些用例测的不是范围闸，所以要把范围明确置成"不限"。
   */
  new DistillSourceRepository(vault.db).upsert("chat", { enabled: true, scope: {} }, 0)
  new ConversationRepository(vault.db).upsert({
    id: "conv-g",
    channelId: "dingtalk",
    externalId: "cid-g",
    type: "group",
    title: "被@的群",
    memberCount: 5,
    createdAt: NOW,
  })
  const service = new DataPlaneService({
    clock: new ManualClock(NOW),
    logger: createLogger("test-dp", { level: "error" }),
    plugin: makePlugin(events.factory),
    feed: fakeFeed,
    getWindow: () => null,
    // 关定时器：只测事件接线，不让采集轮询在后台跑。
    autoStart: false,
  })
  return { vault, service }
}

describe("DataPlaneService × 事件通路接线", () => {
  it("★ 事件叫醒 → 定向补拉 → 正文真的落库（事件不落库，正文走采集）", async () => {
    const events = makeFakeEvents()
    const { vault, service } = makeDataPlane(events)
    await service.attach(vault.db, vault.path)

    // 起 attach 时事件流应已 start。
    expect(events.started()).toBe(true)

    const before = countMessages(vault.db)
    // 模拟 stdout 收到一条「@我」事件（会话 cid-g 有动静）。
    events.fire("e1", "cid-g")
    // onSignal → refreshConversation 是异步的，等它跑完。
    await new Promise((r) => setTimeout(r, 20))

    const after = countMessages(vault.db)
    expect(after).toBeGreaterThan(before)

    await service.detach()
    expect(events.stopped()).toBe(true)
    vault.close()
  })

  it("事件通路健康出现在 snapshot（能看出'接通但零投递'）", async () => {
    const events = makeFakeEvents()
    const { vault, service } = makeDataPlane(events)
    await service.attach(vault.db, vault.path)

    const snap = service.snapshot()
    expect(snap.eventStream).not.toBeNull()
    expect(snap.eventStream?.state).toBe("ready")
    // ready 且 delivered=0 = 接通但零投递（记忆里那个陷阱的可观测面）。
    expect(snap.eventStream?.delivered).toBe(0)

    await service.detach()
    // 停机后再取快照：未登录分支里 eventStream 为 null。
    expect(service.snapshot().eventStream).toBeNull()
    vault.close()
  })

  /**
   * ★ 订阅**覆盖面**要出现在快照里。
   *
   * 这一条锁的不是"通路通不通"（上一条锁了），而是"通了也只覆盖哪些会话"：
   * 钉钉只有 at 是一个订阅覆盖全部群，单聊/指定群要逐会话订阅。不摊开的话
   * 「事件通路正常」会被误读成「所有消息都秒级到」。
   */
  it("★ 订阅覆盖面（event list + status 对账）出现在 snapshot", async () => {
    const events = makeFakeEvents()
    const { vault, service } = makeDataPlane(events)
    await service.attach(vault.db, vault.path)
    // audit 是 attach 后异步算的（刻意不 await，不拖慢登录）——等它落下来。
    await new Promise((r) => setTimeout(r, 20))

    const audit = service.snapshot().eventStream?.audit
    expect(audit).toBeDefined()
    expect(audit?.catalog).toHaveLength(3)
    // at 是全局覆盖，o2o/group 要逐会话 —— 这个区分是"覆盖面"的全部意义。
    expect(audit?.globalKeys).toEqual(["user_im_message_receive_at"])
    expect(audit?.perConversationKeys).toHaveLength(2)
    // 实测这台机器 0 个活跃订阅：也就是连 @我 都没订上，全靠轮询。
    expect(audit?.activeSubscriptions).toBe(0)

    await service.detach()
    vault.close()
  })
})

function countMessages(db: ReturnType<typeof openTestVault>["db"]): number {
  return db.prepare<[], { c: number }>("SELECT count(*) AS c FROM messages").get()?.c ?? 0
}

/**
 * 采集周期可配。
 *
 * 锁三条：① 默认探针 **10s**（用户点名要的默认值）；② 保存只覆盖给了的字段
 * （改一项不该把其余擦回缺省 —— zod partial 的显式 undefined 曾在别处踩过）；
 * ③ 保存后**真的生效**（重挂采集，快照里的 probeIntervalMs 跟着变）。
 */
describe("DataPlaneService × 采集周期可配", () => {
  it("默认探针周期是 10s", async () => {
    const events = makeFakeEvents()
    const { vault, service } = makeDataPlane(events)
    await service.attach(vault.db, vault.path)

    expect(service.intervals().probeBaseMs).toBe(10_000)

    await service.detach()
    vault.close()
  })

  it("★ 只改一项 → 其余不被擦回缺省，且保存后生效", async () => {
    const events = makeFakeEvents()
    const { vault, service } = makeDataPlane(events)
    await service.attach(vault.db, vault.path)

    await service.intervalsSave({ pullMs: 60_000 })
    let after = service.intervals()
    expect(after.pullMs).toBe(60_000)
    // 上一步没给的那些必须还是缺省（不是 undefined、不是 0）。
    expect(after.probeBaseMs).toBe(10_000)
    expect(after.minutesMs).toBe(30 * 60_000)

    /**
     * ★ 再改探针，且**显式传 undefined** 给其余字段 —— 这正是 zod `.partial()`
     * 在 IPC 那一层产出的形状（键存在、值为 undefined）。裸 spread 会让它把
     * 上一步存的 60s 覆盖成 undefined → 落库成 null → 读回来变缺省。
     * 所以这里必须用显式 undefined，否则这条断言测不到 `pickDefined`。
     */
    await service.intervalsSave({
      probeBaseMs: 30_000,
      pullMs: undefined,
      probeMaxMs: undefined,
      minutesMs: undefined,
    })
    after = service.intervals()
    expect(after.probeBaseMs).toBe(30_000)
    expect(after.pullMs).toBe(60_000)

    // ★ 真的生效：快照读的是 IngestService 里那份，重挂后应当是新值。
    expect(service.snapshot().probeIntervalMs).toBe(30_000)

    await service.detach()
    vault.close()
  })
})
