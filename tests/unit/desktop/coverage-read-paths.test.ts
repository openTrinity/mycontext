/**
 * 三个域的覆盖面**读出口**（G4）—— 「这段日期已有多少 / 齐没齐」。
 *
 * ## ★★★ 这一层修的是「两类能回答、一类不能」
 *
 * 用户要的是「显示出来要多少和共已经有了多少了，**不管是消息还是听记，
 * 文档等**」。而修复前：
 *
 * | 域 | 写入 | 读出口 |
 * |---|---|---|
 * | chat | `chat_coverage`(v27) ✅ | `chatCoverage` IPC ✅ |
 * | minutes | `minutes_coverage`(v24) ✅ | 只有一个 `drained` 布尔塞在快照里 ⚠️ |
 * | doc | `document_coverage`(v29) ✅ | **零调用**（聚合方法一处都没被用过）❌ |
 *
 * 「两类能回答、一类不能」是最难解释的状态 —— 用户会以为文档那栏坏了。
 *
 * ## 断言的是**数字**，不是"某个方法被调过"
 *
 * 与本仓库其余覆盖面测试同一条纪律：这里要锁的是"界面上那个数字对不对"，
 * 而覆盖面的数字错了**不报错**（只是偏了）。
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "@mycontext/kernel"
import type { ChannelPlugin } from "@mycontext/channels"
import {
  ChatCoverageRepository,
  DocumentCoverageRepository,
  MinutesCoverageRepository,
} from "@mycontext/store"
import { DistillSourceService } from "@main/services/distill-source.service.js"
import { openTestVault, type TestVault } from "../../helpers/vault.js"

const CH = "dingtalk"
const NOW = 1_785_000_000_000
/** 两个相邻的日子（覆盖面按天分桶，所以要跨两天才测得出聚合）。 */
const D1 = "2026-08-11"
const D2 = "2026-08-12"

function makeService(vault: TestVault) {
  const service = new DistillSourceService({
    plugin: { meta: { id: CH } } as unknown as ChannelPlugin,
    clock: { now: () => NOW },
    logger: createLogger("test-coverage", { level: "error" }),
    primaryChannelId: CH,
  } as unknown as ConstructorParameters<typeof DistillSourceService>[0])
  service.attach(vault.db, [])
  return service
}

/** 往 `documents` 表塞一篇（覆盖面的真值从这张表数出来）。 */
function insertDoc(
  vault: TestVault,
  id: string,
  updatedAt: number,
  workspaceId: string | null = "spaceFAKE0001",
): void {
  vault.db
    .prepare(
      `INSERT INTO documents
         (id, channel_id, external_id, origin, title, doc_type, extension, url,
          workspace_id, content_text, updated_at, created_at, fetched_at)
       VALUES (?, ?, ?, 'wiki', ?, 'ALIDOC', 'md', NULL, ?, NULL, ?, NULL, ?)`,
    )
    .run(id, CH, id, `文档 ${id}`, workspaceId, updatedAt, NOW)
}

/** 往 `minutes` 表塞一场会议。 */
function insertMinutes(vault: TestVault, id: string, startedAt: number | null): void {
  vault.db
    .prepare(
      `INSERT INTO minutes
         (id, channel_id, external_id, title, started_at, duration_sec, fetched_at)
       VALUES (?, ?, ?, ?, ?, 3600, ?)`,
    )
    .run(id, CH, id, `会议 ${id}`, startedAt, NOW)
}

/** `YYYY-MM-DD` 那天的正午（避开时区把它推到隔壁那天）。 */
function noonOf(day: string): number {
  return new Date(`${day}T12:00:00`).getTime()
}

describe("★★★ 文档域的覆盖面读出口（原来完全没有）", () => {
  it("从 documents 表数出真值，按天分桶", () => {
    const vault = openTestVault()
    const service = makeService(vault)
    insertDoc(vault, "docFAKE0001", noonOf(D1))
    insertDoc(vault, "docFAKE0002", noonOf(D2))
    insertDoc(vault, "docFAKE0003", noonOf(D2))

    const view = service.chatCoverage({
      channelId: CH,
      fromDay: D1,
      toDay: D2,
      domain: "doc",
    })

    /**
     * ★ 3 篇分两天：D1 一篇、D2 两篇。
     *
     * 反证：把 `documentCoverage` 里的 `rebuildFromDocuments` 去掉 ⇒
     * 这一条变成 0 篇 / 0 天（表里没人写过 local_count）—— 而那正是
     * 修复前的状态：表在写、`local_count` 永远是 0。
     */
    expect(view.localCount).toBe(3)
    expect(view.dayCount).toBe(2)
    expect(view.days.map((day) => [day.dayBucket, day.localCount])).toEqual([
      [D1, 1],
      [D2, 2],
    ])
    vault.close()
  })

  it("★★ 分桶用**业务时间**（updated_at）而不是抓取时间", () => {
    const vault = openTestVault()
    const service = makeService(vault)
    // 三个月前更新的文档 —— fetched_at 是今天（NOW）
    const old = noonOf("2026-05-10")
    insertDoc(vault, "docFAKE0004", old)

    const inOldRange = service.chatCoverage({
      channelId: CH,
      fromDay: "2026-05-10",
      toDay: "2026-05-10",
      domain: "doc",
    })
    const inToday = service.chatCoverage({
      channelId: CH,
      fromDay: D1,
      toDay: D2,
      domain: "doc",
    })

    /**
     * 用 `fetched_at` 分桶的话这一篇会落到今天那一格 —— 于是
     * "这段日期有多少"永远只有今天有数，而三个月前那一格是空的。
     * 那与"三个月前真的没有文档"完全同形。
     */
    expect(inOldRange.localCount).toBe(1)
    expect(inToday.localCount).toBe(0)
    vault.close()
  })

  it("★ 空间（workspace_id）为 NULL → 归到默认空间，不丢", () => {
    const vault = openTestVault()
    const service = makeService(vault)
    insertDoc(vault, "docFAKE0005", noonOf(D2), null)

    const view = service.chatCoverage({
      channelId: CH,
      fromDay: D1,
      toDay: D2,
      domain: "doc",
    })

    /**
     * v29 约定空串是默认空间（NULL 进不了 `WITHOUT ROWID` 的主键）。
     * 写成 NULL 会让这些行整条 INSERT 静默失败一部分 —— 于是散落的
     * 云盘文件在覆盖面上凭空消失。
     */
    expect(view.localCount).toBe(1)
    vault.close()
  })
})

describe("★★★ 听记域的覆盖面读出口", () => {
  it("从 minutes 表按 started_at 分桶", () => {
    const vault = openTestVault()
    const service = makeService(vault)
    insertMinutes(vault, "minFAKE0001", noonOf(D1))
    insertMinutes(vault, "minFAKE0002", noonOf(D2))

    const view = service.chatCoverage({
      channelId: CH,
      fromDay: D1,
      toDay: D2,
      domain: "minutes",
    })

    expect(view.localCount).toBe(2)
    expect(view.dayCount).toBe(2)
    vault.close()
  })

  it("★★ `started_at` 为 NULL 的会议**不落到今天**（归哪天都是编的）", () => {
    const vault = openTestVault()
    const service = makeService(vault)
    insertMinutes(vault, "minFAKE0003", noonOf(D2))
    insertMinutes(vault, "minFAKE0004", null)

    const view = service.chatCoverage({
      channelId: CH,
      fromDay: D1,
      toDay: D2,
      domain: "minutes",
    })

    /**
     * 一场没有开始时间的会议归到哪一天都是编的。少算一行让界面说
     * "这天没有"，那是诚实的 —— 而把它塞进今天会让今天那一格虚高。
     */
    expect(view.localCount).toBe(1)
    vault.close()
  })

  it("★★★ 还没跑过一轮时 drained 取 false（不把「不知道」说成「没问题」）", () => {
    const vault = openTestVault()
    const service = makeService(vault)
    insertMinutes(vault, "minFAKE0005", noonOf(D2))
    // 刻意**不**写 minutes_coverage —— 模拟"采集还没跑过一轮"

    const view = service.chatCoverage({
      channelId: CH,
      fromDay: D1,
      toDay: D2,
      domain: "minutes",
    })

    /**
     * `drainedDays: 0` ⇒ 界面说"还在回溯"（诚实）。
     * 取 true 会说"已采完" —— 而我们压根不知道齐没齐，那是把一个
     * 我们不知道的事讲成事实（本仓库最贵的那类错误）。
     *
     * 反证：把 `overall?.drained ?? false` 改成 `?? true` ⇒ 这条转红。
     */
    expect(view.drainedDays).toBe(0)
    expect(view.days.every((day) => !day.drained)).toBe(true)
    vault.close()
  })

  it("★★ 整轮抽干过 → 这些天都算齐（那个事实的粒度就是整个渠道）", () => {
    const vault = openTestVault()
    const service = makeService(vault)
    insertMinutes(vault, "minFAKE0006", noonOf(D1))
    insertMinutes(vault, "minFAKE0007", noonOf(D2))
    new MinutesCoverageRepository(vault.db).record(CH, {
      drained: true,
      earliestStartedAt: noonOf(D1),
      listedTotal: 2,
      at: NOW,
    })

    const view = service.chatCoverage({
      channelId: CH,
      fromDay: D1,
      toDay: D2,
      domain: "minutes",
    })

    /**
     * 听记采集是**全量列举**（没有时间窗语义），所以"抽干"只对整轮成立
     * —— 不存在"某一天抽干了"。摊到每一天不是造假，而是那个事实的
     * 真实粒度就是整个渠道。
     */
    expect(view.drainedDays).toBe(2)
    vault.close()
  })
})

describe("★★ 三个域互不干扰（同一个方法、三张表）", () => {
  it("★★★ 各域只数自己那张表的数据", () => {
    const vault = openTestVault()
    const service = makeService(vault)
    // 文档 2 篇、听记 1 场、消息覆盖面 5 条 —— 三个不同的数字
    insertDoc(vault, "docFAKE0006", noonOf(D2))
    insertDoc(vault, "docFAKE0007", noonOf(D2))
    insertMinutes(vault, "minFAKE0008", noonOf(D2))
    new ChatCoverageRepository(vault.db).bump(CH, {
      conversationExternalId: "cidFAKE0001==",
      dayBucket: D2,
      delta: 5,
      at: NOW,
    })

    const range = { channelId: CH, fromDay: D1, toDay: D2 }
    /**
     * ★ 三个数字必须**各不相同**才测得出串台。全设成一样的话
     * "文档那栏读了消息的表"这个 bug 会照样绿。
     */
    expect(service.chatCoverage({ ...range, domain: "doc" }).localCount).toBe(2)
    expect(service.chatCoverage({ ...range, domain: "minutes" }).localCount).toBe(1)
    expect(service.chatCoverage({ ...range, domain: "chat" }).localCount).toBe(5)
    vault.close()
  })

  it("★★ 不传 domain → 走 chat（既有调用方不传它）", () => {
    const vault = openTestVault()
    const service = makeService(vault)
    insertDoc(vault, "docFAKE0008", noonOf(D2))
    new ChatCoverageRepository(vault.db).bump(CH, {
      conversationExternalId: "cidFAKE0002==",
      dayBucket: D2,
      delta: 7,
      at: NOW,
    })

    /**
     * `domain` 在契约里有 `.default("chat")`，但那个默认值只在**解析时**
     * 生效。服务层直接被调用时（单测、以及任何绕过 parse 的路径）
     * 拿到的是 undefined —— 所以实现里的分支判断必须让 undefined 落到 chat。
     *
     * 反证：把实现里那两个 `if` 改成 `if (input.domain !== "chat")` 之类的
     * 反向判据 ⇒ 这一条会读到文档的数字（1）而不是消息的（7）。
     */
    const view = service.chatCoverage({
      channelId: CH,
      fromDay: D1,
      toDay: D2,
    } as Parameters<typeof service.chatCoverage>[0])
    expect(view.localCount).toBe(7)
    vault.close()
  })

  it("★ 库没挂上时三个域都返回空而不是抛（设置页在登录前也渲染）", () => {
    const service = new DistillSourceService({
      plugin: { meta: { id: CH } } as unknown as ChannelPlugin,
      clock: { now: () => NOW },
      logger: createLogger("test-coverage", { level: "error" }),
      primaryChannelId: CH,
    } as unknown as ConstructorParameters<typeof DistillSourceService>[0])

    for (const domain of ["chat", "minutes", "doc"] as const) {
      const view = service.chatCoverage({ channelId: CH, fromDay: D1, toDay: D2, domain })
      expect(view.localCount).toBe(0)
      expect(view.dayCount).toBe(0)
    }
  })
})

describe("★★ 文档覆盖面的 pendingSpaces 映射到契约里那个共用字段", () => {
  it("★ 没抽干的空间数进 pendingConversations（名字共用、语义按域）", () => {
    const vault = openTestVault()
    const service = makeService(vault)
    const repo = new DocumentCoverageRepository(vault.db)
    // 两个空间，一个抽干、一个没抽干
    repo.bump(CH, {
      spaceExternalId: "spaceFAKE0001",
      dayBucket: D2,
      delta: 1,
      drained: true,
      at: NOW,
    })
    repo.bump(CH, {
      spaceExternalId: "spaceFAKE0002",
      dayBucket: D2,
      delta: 1,
      drained: false,
      at: NOW,
    })

    const view = service.chatCoverage({
      channelId: CH,
      fromDay: D1,
      toDay: D2,
      domain: "doc",
    })

    /**
     * ★ 契约里那个字段叫 `pendingConversations`，而文档域里它的含义是
     * "还有几个**空间**没抽干"。名字共用是因为三个域共用一个 schema
     * （换名字要动既有调用方），而"还有几个分区没齐"这个问题是同一个。
     *
     * ★ 这一条同时锁住 `MIN(drained)` 那条判据：两个空间里一个没齐，
     * 这一天就不能算齐（用 MAX 会让 91 个会话里 90 个齐了就报"已采完"）。
     */
    const day = view.days.find((item) => item.dayBucket === D2)
    expect(day?.pendingConversations).toBe(1)
    expect(day?.drained).toBe(false)
    vault.close()
  })
})
