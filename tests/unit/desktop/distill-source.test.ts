/**
 * 蒸馏源服务的门禁：会话列表**必须**合并本地表，且截断要如实上报。
 *
 * ## 为什么这条值得单独锁
 *
 * "有渠道接口了就用渠道的"是最自然的写法，而它会静默丢掉一批会话：
 * 钉钉的 `list-all-conversations` 拿不到全量单聊（`--cursor` 无效 /
 * `--limit` 硬顶 100 / `hasMore` 恒 false，见 dingtalk/conversations.ts）。
 * 实测这个账号本地 86 个会话里有 **11 个是渠道三路都不返回的** ——
 * 那是最糟的一种缺失：**消息就在本地库里，用户却在选择器里找不到它**。
 * 没有报错、没有警告，只是列表里少了几行。
 *
 * 另一半是 `truncated`：拿不全是事实，那就必须能表达出来。
 * 渠道调用失败时降级成"只有本地"，那时**一定**是截断的
 * （本地表天然只有采过消息的那部分）。
 */
import { describe, expect, it } from "vitest"
import { ManualClock, createLogger } from "@mycontext/kernel"
import type { ChannelPlugin } from "@mycontext/channels"
import { ConversationRepository } from "@mycontext/store"
import { DistillSourceService } from "../../../apps/desktop/src/main/services/distill-source.service.js"
import { openTestVault } from "../../helpers/vault.js"

const START = 1_785_000_000_000
const logger = createLogger("Test", { level: "error" })

/** 造一个只实现 `conversations` 的假插件（服务只用这一个能力）。 */
function fakePlugin(
  list: () => Promise<{
    items: {
      externalId: string
      title: string | null
      kind: "direct" | "group"
      memberCount: number | null
      lastMessageAt: number | null
    }[]
    truncated: boolean
  }>,
): ChannelPlugin {
  return { conversations: { list } } as unknown as ChannelPlugin
}

/**
 * 造一个服务实例，本地表里放两个会话。
 *
 * `cid-local-only` 是关键：各用例里渠道侧都**不返回**它
 * （模拟"渠道拿不到全量单聊"），所以它能证明合并真的发生了。
 */
function makeService(plugin: ChannelPlugin) {
  const vault = openTestVault()
  const conversations = new ConversationRepository(vault.db)
  conversations.upsert({
    id: "c1",
    channelId: "dingtalk",
    externalId: "cid-shared",
    type: "group",
    title: "两边都有的群",
    memberCount: 16,
    createdAt: START,
  })
  conversations.upsert({
    id: "c2",
    channelId: "dingtalk",
    externalId: "cid-local-only",
    type: "direct",
    title: "渠道列不出来的单聊",
    memberCount: 2,
    createdAt: START,
  })
  // 本地的最后消息时间来自真实落库的消息，比渠道给的更可信
  vault.db
    .prepare("UPDATE conversations SET last_message_at = ? WHERE external_id = ?")
    .run(START + 5000, "cid-local-only")

  const service = new DistillSourceService({
    clock: new ManualClock(START),
    logger,
    plugin,
  })
  service.attach(vault.db)
  return { service, vault }
}

describe("★ 会话列表必须合并本地表", () => {
  it("渠道没返回的本地会话仍然出现在列表里", async () => {
    const { service, vault } = makeService(
      fakePlugin(() =>
        Promise.resolve({
          items: [
            {
              externalId: "cid-shared",
              title: "两边都有的群",
              kind: "group" as const,
              memberCount: 16,
              lastMessageAt: START + 1000,
            },
            {
              externalId: "cid-remote-only",
              title: "还没采过的群",
              kind: "group" as const,
              memberCount: 8,
              lastMessageAt: START + 2000,
            },
          ],
          truncated: false,
        }),
      ),
    )

    const result = await service.conversations()
    const ids = result.items.map((item) => item.externalId).sort()
    /**
     * 三个都要在：
     * · `cid-shared` 两边都有；
     * · `cid-remote-only` 只有渠道有（还没采过 —— 用户可能正想蒸馏它）；
     * · `cid-local-only` 只有本地有（渠道拿不到全量单聊）。
     */
    expect(ids).toEqual(["cid-local-only", "cid-remote-only", "cid-shared"])
    vault.close()
  })

  it("本地的最后消息时间优先（它来自真实落库的消息）", async () => {
    const { service, vault } = makeService(
      fakePlugin(() =>
        Promise.resolve({
          items: [
            {
              externalId: "cid-local-only",
              title: "渠道也返回了",
              kind: "direct" as const,
              memberCount: null,
              // 渠道给一个更早的时间：不该覆盖本地那个
              lastMessageAt: START - 99_000,
            },
          ],
          truncated: false,
        }),
      ),
    )

    const result = await service.conversations()
    const row = result.items.find((item) => item.externalId === "cid-local-only")
    expect(row?.lastMessageAt).toBe(START + 5000)
    vault.close()
  })

  it("★ 渠道调用失败 → 降级成只用本地，并标 truncated", async () => {
    const { service, vault } = makeService(fakePlugin(() => Promise.reject(new Error("dws 挂了"))))

    const result = await service.conversations()
    // 没抛：整个选择页打不开比"只能选已采过的会话"更糟
    expect(result.items.map((item) => item.externalId).sort()).toEqual([
      "cid-local-only",
      "cid-shared",
    ])
    /**
     * 降级时**一定**是截断的。
     * 报 false 会让 UI 说"这就是全部会话"，而它其实只是本地采过的那部分。
     */
    expect(result.truncated).toBe(true)
    vault.close()
  })

  it("渠道说截断，服务就得照实传下去（不能自己抹平）", async () => {
    const { service, vault } = makeService(
      fakePlugin(() => Promise.resolve({ items: [], truncated: true })),
    )
    expect((await service.conversations()).truncated).toBe(true)
    vault.close()
  })

  it("渠道无此能力时也是截断（只有本地表）", async () => {
    const { service, vault } = makeService({} as unknown as ChannelPlugin)
    const result = await service.conversations()
    expect(result.truncated).toBe(true)
    expect(result.items).toHaveLength(2)
    vault.close()
  })
})

describe("资料源列表如实标注采集器状态", () => {
  it("只有 chat / minutes / doc 是 ready，其余都是 planned", async () => {
    const { service, vault } = makeService({} as unknown as ChannelPlugin)
    const rows = service.list()
    const ready = rows
      .filter((row) => row.status === "ready")
      .map((row) => row.kind)
      .sort()
    /**
     * ★ 这条锁的是**诚实**：只有这三类真的打通并实测过
     * （9541 条消息 / 20 条听记 / 1058 篇文档落库）。多标一个 ready
     * 就等于给用户一个不会兑现的承诺 —— 勾了却永远等不到数据，而且不报错。
     *
     * `doc` 是最新接上的那一类：`drive recent` + `wiki node list` 列举 →
     * `doc read --node` 取 Markdown（实测 1058 篇落库、正文可取）。
     */
    expect(ready).toEqual(["chat", "doc", "minutes"])
    /**
     * 反面：其余的必须是 `planned` 而不是别的值。
     *
     * 只断言 ready 的那一组时，"status 恒为 ready"这个 bug 会让
     * 上面那条红、但"status 恒为某个第三种值"却照样绿。
     */
    const planned = rows.filter((row) => row.status === "planned")
    expect(planned.length).toBe(rows.length - ready.length)
    expect(planned.length).toBeGreaterThan(0)
    vault.close()
  })

  it("未登录（未 attach）时返回全部未启用而不是抛错", () => {
    const service = new DistillSourceService({
      clock: new ManualClock(START),
      logger,
      plugin: {} as unknown as ChannelPlugin,
    })
    // 设置页在登录前也可能渲染 —— 那时抛错会让整页打不开
    const rows = service.list()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => !row.enabled)).toBe(true)
  })
})

describe("保存与重置", () => {
  it("保存后能读回（含时间范围与会话白名单）", () => {
    const { service, vault } = makeService({} as unknown as ChannelPlugin)
    service.save({
      kind: "chat",
      enabled: true,
      scope: { since: START, chatKinds: ["group"], conversationIds: ["cid-shared"] },
    })
    const row = service.list().find((item) => item.kind === "chat")
    expect(row?.enabled).toBe(true)
    expect(row?.scope.since).toBe(START)
    expect(row?.scope.conversationIds).toEqual(["cid-shared"])
    vault.close()
  })

  it("★ reset 只清水位，不动 enabled 与 scope", () => {
    const { service, vault } = makeService({} as unknown as ChannelPlugin)
    service.save({ kind: "chat", enabled: true, scope: { since: START } })
    vault.db.prepare("UPDATE distill_sources SET last_synced_seq = 42 WHERE kind = 'chat'").run()

    service.reset("chat")

    const row = service.list().find((item) => item.kind === "chat")
    expect(row?.lastSyncedSeq).toBe(0)
    /**
     * 重置水位是"从头再蒸一遍"，不是"取消这个源"。
     * 顺手把 enabled 清掉会让用户点了重置之后再也不采了 ——
     * 而那看起来像"重置把功能关了"。
     */
    expect(row?.enabled).toBe(true)
    expect(row?.scope.since).toBe(START)
    vault.close()
  })
})
