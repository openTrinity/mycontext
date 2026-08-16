/**
 * 生产者的**运行时视图** + 覆盖面的三域表达（修 G15 + G16）。
 *
 * ## ★★★ 这个文件锁的是什么
 *
 * 消费者侧早就有完整的运行时视图，而生产者侧只有**一个全局对象**
 * （`IngestSnapshot.scope`）—— chat 与 doc 两条路累加进同一对字段。
 *
 * 三件事因此读不出来，而它们的出路完全不同：
 * ① **谁丢的** —— 「文档挡掉 300 篇」与「聊天挡掉 300 条」是同一个数字；
 * ② **范围就绪了吗** —— `scopeNotReady` 完全不可见，而它是那次
 *    "飞书一条都采不到"的根因；
 * ③ **上一轮抽干了吗** —— 要从三个不同的地方拼。
 *
 * 而 G15 那一半是覆盖面的**表达**：听记那一档的 `pendingConversations`
 * 恒 0，而 0 读起来是"都齐了" —— 真相是"这个概念不适用"。
 */
import { describe, expect, it } from "vitest"
import { PRODUCERS, buildProducerStatuses } from "@mycontext/ingest"

describe("★★★ buildProducerStatuses：声明 + 运行时合成一张表", () => {
  it("★★★ 遍历**声明**而不是运行时数据（「这一轮没跑」要显示成一行）", () => {
    /**
     * 与 `buildConsumerStatuses` 按 `CONSUMERS` 遍历同一条理由：
     * G2 那次就是"游标表里有、界面上没有" —— 一个卡住的消费者在界面上
     * 根本不存在。生产者侧同理：没跑过的域要显示成一行（计数全零），
     * 而不是整行消失。
     */
    const statuses = buildProducerStatuses()
    expect(statuses.map((s) => s.id)).toEqual(PRODUCERS.map((p) => p.id))
    // ★ 什么都不传时全部计数为零（而不是 undefined）
    for (const status of statuses) {
      expect(status.droppedOutOfScope).toBe(0)
      expect(status.droppedUnknownTime).toBe(0)
      expect(status.lastDroppedAt).toBeNull()
    }
  })

  it("★★★ `scopeReady` **不含** unset —— 否则听记/文档在全新库上永久未就绪", () => {
    /**
     * 一个"没配过 + 缺省 collect-all"的域（听记/文档）是**就绪**的：
     * 它按缺省方向采。把 unset 算进"没就绪"会让那两个域在全新库上
     * 永久显示未就绪，而它们其实正常在采 —— 一个假的告警。
     */
    const statuses = buildProducerStatuses({
      scopes: new Map([["minutes", { collectsNothing: false, unset: true, unreadable: false }]]),
    })
    const minutes = statuses.find((s) => s.id === "minutes-ingest")
    expect(minutes?.scopeReady).toBe(true)
    // ★ 但 unset 本身要报出来（界面据此说"还没配过"）
    expect(minutes?.scopeUnset).toBe(true)
  })

  it("★★★ `scopeUnreadable` 与 `scopeReady:false` 必须分开（出路不同）", () => {
    /**
     * 坏 JSON 那一档用户**自己能修**（在设置页重存一次范围），
     * 而"一条都不采"要去改勾选。两者现在都表现为"不采" ——
     * 合成一个布尔会让用户去改勾选，而问题是那行 JSON。
     */
    const statuses = buildProducerStatuses({
      scopes: new Map([["doc", { collectsNothing: true, unset: false, unreadable: true }]]),
    })
    const doc = statuses.find((s) => s.id === "doc-ingest")
    expect(doc?.scopeReady).toBe(false)
    expect(doc?.scopeUnreadable).toBe(true)
  })

  it("★★★ 按域的丢弃计数（这是 G16 的实质）", () => {
    const statuses = buildProducerStatuses({
      counters: new Map([
        ["chat-ingest", { droppedOutOfScope: 46_415, droppedUnknownTime: 0, lastDroppedAt: 1 }],
        ["doc-ingest", { droppedOutOfScope: 300, droppedUnknownTime: 12, lastDroppedAt: 2 }],
      ]),
    })
    const by = new Map(statuses.map((s) => [s.id, s]))
    // ★ 两个域的数字**不同** —— 那正是原来读不出来的事
    expect(by.get("chat-ingest")?.droppedOutOfScope).toBe(46_415)
    expect(by.get("doc-ingest")?.droppedOutOfScope).toBe(300)
    // ★★ 而"渠道没给时间"单独记（出路是去看渠道解析，不是改范围）
    expect(by.get("doc-ingest")?.droppedUnknownTime).toBe(12)
    expect(by.get("chat-ingest")?.droppedUnknownTime).toBe(0)
  })

  it("★★★ `drained` 只对会抽干的两种调度有值（watermark/stream 恒 null）", () => {
    /**
     * 三个值三种含义：true = 覆盖面完整；false = 撞了预算/截断（下界）；
     * null = 这个调度压根没有"抽干"这件事。
     *
     * ★ 对聊天报 false 会让界面说"还没采完" —— 而那是一句永远成立的废话
     * （水位那套是"只推已抽干的连续前缀"，它没有"整轮抽干"这个时刻）。
     */
    const statuses = buildProducerStatuses({
      // ★ 故意给 watermark 与 stream 也传值 —— 声明是权威，它们必须报 null
      drained: new Map([
        ["chat-ingest", true],
        ["minutes-ingest", false],
        ["doc-ingest", true],
        ["attention-stream", true],
      ]),
    })
    const by = new Map(statuses.map((s) => [s.id, s]))
    expect(by.get("chat-ingest")?.drained).toBeNull()
    expect(by.get("attention-stream")?.drained).toBeNull()
    expect(by.get("minutes-ingest")?.drained).toBe(false)
    expect(by.get("doc-ingest")?.drained).toBe(true)
  })

  it("★★★ `supportedByChannel`：只连飞书时听记那一行报 false（修 G17）", () => {
    /**
     * 飞书的 `capabilities.domains` 是 `["chat","doc"]` —— 它没有听记接口。
     * 不报的话界面会显示"听记生产者就绪、丢弃 0" —— 而用户会去查
     * "为什么一场都没采到"，那个问题没有答案。
     *
     * ★ 与 `scopeReady:false` 分开：前者的出路是"去连钉钉"。
     */
    const statuses = buildProducerStatuses({ channelDomains: ["chat", "doc"] })
    const by = new Map(statuses.map((s) => [s.id, s]))
    expect(by.get("minutes-ingest")?.supportedByChannel).toBe(false)
    expect(by.get("chat-ingest")?.supportedByChannel).toBe(true)
    expect(by.get("doc-ingest")?.supportedByChannel).toBe(true)
  })

  it("★★ 不传 channelDomains → 全部支持（不按渠道过滤，保留既有行为）", () => {
    /**
     * ★ 这一条防的是一个具体的失败模式：渠道还没授权时 `capabilities`
     * 可能拿不到，而那时若按能力过滤，整块生产者会消失 ——
     * 用户看到一个空白的卡，而真相只是"还没连渠道"。
     */
    for (const status of buildProducerStatuses()) {
      expect(status.supportedByChannel).toBe(true)
    }
  })

  it("★★ 一个生产者投多个域时，范围状态取**最严**的那个", () => {
    /**
     * 现在每个生产者都只投一个域，但声明允许多个。取最严是因为：
     * 报"就绪"而实际有一个域在丢数据，是那种"看起来没问题"的静默故障。
     */
    const statuses = buildProducerStatuses({
      producers: [
        {
          id: "multi",
          domains: ["chat", "doc"],
          scope: "learning",
          backfills: true,
          schedule: "tiered-listing",
          haltsOnScopeNotReady: false,
          purpose: "两个域",
        },
      ],
      scopes: new Map([
        ["chat", { collectsNothing: false, unset: false, unreadable: false }],
        ["doc", { collectsNothing: true, unset: false, unreadable: false }],
      ]),
    })
    expect(statuses[0]?.scopeReady).toBe(false)
  })
})

describe("★★★ 覆盖面的三域表达（修 G15）", () => {
  it("★★★ 听记域的 `pendingConversations` 报 null 而不是 0", async () => {
    /**
     * ## 为什么 0 是错的
     *
     * 0 **读起来是"都齐了"**，而真相是"这个概念对听记不适用"
     * （`minutes_coverage` 是每渠道一行，它是全量列举，
     * 没有"某个分区抽干了"这件事）。
     *
     * 三行覆盖面并排时用户看到「文档还有 3 个空间没齐、听记还有 0 个没齐」，
     * 于是他以为听记比文档更完整 —— 而那两个数字压根不是同一种东西。
     *
     * ★ 断言走**契约 schema**（而不是造一个服务）：那是这个字段的
     * 唯一真源，而 nullable 与否是它的全部内容。
     */
    const { chatCoverageViewSchema } = await import("@mycontext/ipc-contract")
    // ★ null 必须能过 schema（原来是 z.number()，会被拒）
    const parsed = chatCoverageViewSchema.parse({
      days: [],
      localCount: 0,
      dayCount: 0,
      drainedDays: 0,
      pendingConversations: null,
      source: "derived",
      partitionKind: null,
    })
    expect(parsed.pendingConversations).toBeNull()
  })

  it("★★★ `source` 区分 accounted / derived（三行不是同一种精度）", async () => {
    /**
     * 听记那条路从 `minutes` 表**现算**，没有渠道给的 `listedTotal` ——
     * 所以"库里 12 场"是不是全部只能靠**整渠道**的 `drained` 回答。
     * 不说的话用户会以为三行是同一种精度的数字。
     */
    const { chatCoverageViewSchema } = await import("@mycontext/ipc-contract")
    for (const source of ["accounted", "derived"] as const) {
      expect(
        chatCoverageViewSchema.parse({
          days: [],
          localCount: 0,
          dayCount: 0,
          drainedDays: 0,
          pendingConversations: 0,
          source,
          partitionKind: "conversation",
        }).source,
      ).toBe(source)
    }
  })

  it("★★ `partitionKind` 给量词（3 个会话与 3 个知识库信息量不同）", async () => {
    const { chatCoverageViewSchema } = await import("@mycontext/ipc-contract")
    const base = { days: [], localCount: 0, dayCount: 0, drainedDays: 0, pendingConversations: 3 }
    expect(
      chatCoverageViewSchema.parse({ ...base, source: "accounted", partitionKind: "space" })
        .partitionKind,
    ).toBe("space")
    // ★ null 合法（听记那一档）
    expect(
      chatCoverageViewSchema.parse({ ...base, source: "derived", partitionKind: null })
        .partitionKind,
    ).toBeNull()
  })

  it("★★★ 三个域的 source/partitionKind 由**一个纯函数**决定（不许三处各写）", async () => {
    /**
     * 三处各写一个字面量会漂，而漂的表现是界面上"还有 3 个会话没齐"
     * 出现在文档那一行 —— 数字对、量词错，而没有任何东西会报错。
     */
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/distill-source.service.ts", "utf8")
    expect(src).toContain("function partitionKindOf(")
    // ★ 而它真的被用了（不是一个没人调的函数）
    expect(src).toContain("partitionKindOf(input.domain)")
  })
})
