/**
 * 数据平面**拓扑声明**（ODPS 式形状）—— `packages/ingest/src/topology.ts`。
 *
 * ## 用户原话
 *
 * 「我们需要接入生产者和消费者的架构，包括以后好扩展，其实要做成类似于
 *   odps 这种形式，帮我规划好架构并重构」
 *
 * ## 这个文件锁三件事
 *
 * ① **声明里的 id 与真实常量一致** —— 写错就会读到另一个消费者的
 *    `acked_seq`，而那是静默的（进度看起来"正常"，只是属于别人）；
 * ② **顺序是算出来的** —— 原来 `fts → distill → persona` 是手写三行，
 *    调换顺序或插一个新消费者就会悄悄破坏依赖；
 * ③ **缺席的消费者不打断整轮** —— `graph-export` 由 kl 服务侧推进，
 *    这套部署里可能压根没起。
 */
import { describe, expect, it } from "vitest"
import {
  CONSUMERS,
  DOMAINS,
  PRODUCERS,
  activeDomains,
  checkTopologyConsistency,
  resolveConsumerOrder,
  runCycle,
  type ConsumerSpec,
  type CycleRunnable,
} from "@mycontext/ingest"
import { FTS_CONSUMER_ID } from "@mycontext/ingest"
import { DISTILL_CONSUMER_ID } from "@mycontext/distill"
import { PERSONA_CONSUMER_ID } from "@mycontext/persona"

/** 造一个只记"被调过"的假 runnable。 */
function fake(
  calls: string[],
  id: string,
  report: Partial<Awaited<ReturnType<CycleRunnable["runOnce"]>>> = {},
): CycleRunnable {
  return {
    runOnce: async () => {
      calls.push(id)
      return {
        processed: 0,
        skipped: 0,
        ackedSeq: 0,
        lockedByOther: false,
        waitingForUpstream: null,
        needsFullRebuild: false,
        ...report,
      }
    },
  }
}

describe("拓扑声明：id 必须与真实常量一致", () => {
  it("★★★ 三个内部消费者的 id 与各自包导出的常量相同", () => {
    /**
     * 这是本文件最重要的一条。`consumer_cursors.consumer_id` 是 offset 的
     * 唯一真相 —— 声明里把 `distill` 写成 `distil` 不会报错，只会让
     * 依赖闸去读一个**不存在**的游标（于是不夹，蒸馏抢跑），
     * 或读到另一个消费者的进度。
     *
     * 反证：把 `CONSUMERS` 里任一个 id 改一个字母 → 这条转红。
     */
    const ids = CONSUMERS.map((spec) => spec.id)
    expect(ids).toContain(FTS_CONSUMER_ID)
    expect(ids).toContain(DISTILL_CONSUMER_ID)
    expect(ids).toContain(PERSONA_CONSUMER_ID)
  })

  it("★★ 依赖引用的都是已声明的 id（不许指向拼错的名字）", () => {
    /**
     * `graph-export` 是外部消费者，它**必须**在声明里（作为依赖目标），
     * 否则 `distill.dependsOn` 指向一个不存在的名字 —— 而
     * `resolveConsumerOrder` 对未声明的依赖是**跳过**，于是闸静默消失。
     */
    const ids = new Set(CONSUMERS.map((spec) => spec.id))
    for (const spec of CONSUMERS) {
      for (const upstream of spec.dependsOn) {
        expect(ids.has(upstream), `${spec.id} 依赖的 ${upstream} 没有声明`).toBe(true)
      }
    }
  })

  it("★★ 蒸馏声明依赖图谱导出（用户点名的那条依赖）", () => {
    const distill = CONSUMERS.find((spec) => spec.id === DISTILL_CONSUMER_ID)
    expect(distill?.dependsOn).toEqual(["graph-export"])
  })

  it("★★ required 的取舍与既有实现一致（丢了能不能补回来）", () => {
    /**
     * 蒸馏 `true`（语料丢了是永久损失）、分身 `false`（三天前没回的消息
     * 现在回也没意义）、graph-export `false`（外部消费者）。
     * 这三条与 `ingest.service.ts` 里构造 `OutboxConsumer` 时的取舍必须一致。
     */
    const by = new Map(CONSUMERS.map((spec) => [spec.id, spec]))
    expect(by.get(DISTILL_CONSUMER_ID)?.required).toBe(true)
    expect(by.get(PERSONA_CONSUMER_ID)?.required).toBe(false)
    expect(by.get("graph-export")?.required).toBe(false)
  })

  it("★★★ 只有分身那条有路由闸", () => {
    /**
     * 路由回答"这条消息属于关心范围吗" —— 只有分身需要它。
     * 给 FTS 或蒸馏加上路由等于让监听范围**限制了学习范围**，
     * 那是两个范围混成一个（用户明确要求分开）。
     */
    const routed = CONSUMERS.filter((spec) => spec.routed).map((spec) => spec.id)
    expect(routed).toEqual([PERSONA_CONSUMER_ID])
  })
})

describe("生产者声明：两个范围各有归属", () => {
  it("★★★ 学习范围与监听范围各自有生产者（用户要的「分开两个」）", () => {
    const learning = PRODUCERS.filter((spec) => spec.scope === "learning").map((s) => s.id)
    const attention = PRODUCERS.filter((spec) => spec.scope === "attention").map((s) => s.id)
    expect(learning.length).toBeGreaterThan(0)
    expect(attention).toEqual(["attention-stream"])
  })

  it("★★★ 监听范围的生产者**不回溯**（它只记实时流）", () => {
    /**
     * 用户原话：「不过他只需要记录实时流的内容」。
     * 反证：把 `backfills` 改成 true → 这条转红，而那个改动的真实后果是
     * 一次历史回填把几万条旧消息投给分身。
     */
    const attention = PRODUCERS.find((spec) => spec.scope === "attention")
    expect(attention?.backfills).toBe(false)
  })

  it("★ 学习范围的生产者会回溯（往回挖历史是它的本职）", () => {
    const learning = PRODUCERS.filter((spec) => spec.scope === "learning")
    expect(learning.every((spec) => spec.backfills)).toBe(true)
  })
})

describe("resolveConsumerOrder：顺序是算出来的", () => {
  it("★★★ 上游排在下游之前", () => {
    const order = resolveConsumerOrder()
    expect(order.indexOf("graph-export")).toBeLessThan(order.indexOf(DISTILL_CONSUMER_ID))
  })

  it("★★★ 成环 → 抛错（而不是随便挑一个顺序）", () => {
    /**
     * 静默降级成某个顺序会让声明里的错误在运行时以**数据不一致**出现，
     * 而那比起不来糟得多。
     */
    const cyclic: ConsumerSpec[] = [
      { id: "a", domains: null, required: false, dependsOn: ["b"], routed: false, purpose: "" },
      { id: "b", domains: null, required: false, dependsOn: ["a"], routed: false, purpose: "" },
    ]
    expect(() => resolveConsumerOrder(cyclic)).toThrow(/成环/)
  })

  it("★★ 依赖一个**没声明**的消费者 → 跳过，不抛", () => {
    /**
     * `graph-export` 在 kl 服务没起的部署里不注册。抛错会让整个循环
     * 起不来 —— 而那比"少一道依赖闸"糟得多（闸本身在 `OutboxConsumer`
     * 里也做了同样的取舍：上游没注册就不夹）。
     */
    const specs: ConsumerSpec[] = [
      {
        id: "x",
        domains: null,
        required: false,
        dependsOn: ["nobody"],
        routed: false,
        purpose: "",
      },
    ]
    expect(resolveConsumerOrder(specs)).toEqual(["x"])
  })

  it("★ 每个声明的消费者都出现且只出现一次", () => {
    const order = resolveConsumerOrder()
    expect(order.length).toBe(CONSUMERS.length)
    expect(new Set(order).size).toBe(CONSUMERS.length)
  })
})

describe("runCycle：按依赖序驱动", () => {
  it("★★★ 实际调用顺序 = 拓扑序（不是 map 的插入顺序）", async () => {
    /**
     * 反证：把 `runCycle` 改成 `for (const [id, r] of runnables)`（按插入序）
     * → 这条转红。而那正是"顺序又变成手写"的状态。
     *
     * ★ 故意**倒序**插入，这样"按插入序"与"按拓扑序"结果不同。
     */
    const calls: string[] = []
    const runnables = new Map<string, CycleRunnable>([
      [DISTILL_CONSUMER_ID, fake(calls, DISTILL_CONSUMER_ID)],
      ["graph-export", fake(calls, "graph-export")],
      [FTS_CONSUMER_ID, fake(calls, FTS_CONSUMER_ID)],
    ])
    await runCycle(runnables)
    expect(calls.indexOf("graph-export")).toBeLessThan(calls.indexOf(DISTILL_CONSUMER_ID))
  })

  it("★★★ 缺席的消费者记 absent 并继续（不打断整轮）", async () => {
    const calls: string[] = []
    const runnables = new Map<string, CycleRunnable>([
      [FTS_CONSUMER_ID, fake(calls, FTS_CONSUMER_ID)],
    ])
    const outcomes = await runCycle(runnables)
    const absent = outcomes.filter((o) => o.absent).map((o) => o.id)
    expect(absent).toContain(DISTILL_CONSUMER_ID)
    // FTS 仍然跑了 —— 别人缺席不影响它
    expect(calls).toEqual([FTS_CONSUMER_ID])
  })

  it("★★★ 单个消费者抛错不打断整轮，且与「没数据」可区分", async () => {
    /**
     * 一个远程消费者限流不该让纯本地的 FTS 也建不出来。
     * ★ 抛错记成 `skipped: 1` 而不是全 0 —— 后者与"这一轮没数据"同形。
     */
    const calls: string[] = []
    const boom: CycleRunnable = {
      runOnce: async () => {
        calls.push("boom")
        throw new Error("限流")
      },
    }
    const runnables = new Map<string, CycleRunnable>([
      ["graph-export", boom],
      [DISTILL_CONSUMER_ID, fake(calls, DISTILL_CONSUMER_ID)],
    ])
    const outcomes = await runCycle(runnables)
    const failed = outcomes.find((o) => o.id === "graph-export")
    expect(failed?.skipped).toBe(1)
    expect(failed?.processed).toBe(0)
    // 抛错之后下游仍然跑（闸在 OutboxConsumer 里，不在这里）
    expect(calls).toContain(DISTILL_CONSUMER_ID)
  })

  it("★★ 「在等上游」会被原样报上来（状态页要显示它）", async () => {
    const calls: string[] = []
    const runnables = new Map<string, CycleRunnable>([
      [
        DISTILL_CONSUMER_ID,
        fake(calls, DISTILL_CONSUMER_ID, { waitingForUpstream: "graph-export" }),
      ],
    ])
    const outcomes = await runCycle(runnables)
    expect(outcomes.find((o) => o.id === DISTILL_CONSUMER_ID)?.waitingForUpstream).toBe(
      "graph-export",
    )
  })
})

/**
 * ── ★★★ 接线：`ingest.service` 真的走 runCycle ─────────────────────
 *
 * 上面全绿而服务层仍是手写三行的话，这套声明就只是文档。
 */
describe("接线：runSharedConsumersOnce 走拓扑序", () => {
  it("★★★ 不再手写 fts → distill → persona 三行", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/ingest.service.ts", "utf8")
    const at = src.indexOf("async runSharedConsumersOnce(")
    expect(at).toBeGreaterThan(0)
    const body = src.slice(at, at + 2600)
    expect(body).toContain("runCycle(runnables)")
    /**
     * 反证：把那段改回连续三个 `await this.xxxConsumer.runOnce()` → 转红。
     * 判据是"函数体里没有直接 await 某个具体消费者"。
     */
    expect(body.includes("await this.ftsConsumer.runOnce()")).toBe(false)
    expect(body.includes("await this.distillConsumer.runOnce()")).toBe(false)
  })
})

/**
 * ── ★★★ 声明的自检：漏一行 / 多一个空域必须被抓到 ────────────────
 *
 * ## 为什么这一组是必需的（两个已经真的发生过的错）
 *
 * 把拓扑变成**数据**的代价是：数据错了不会像代码那样编译失败。
 *
 * ① `PRODUCERS` 曾经**漏了 `doc-ingest`** —— 而 `normalizer.ts:289` 一直在
 *    产 `doc` 域。拓扑视图会画出"这个域有数据、却没有任何生产者"；
 * ② `contact` 域在 `CHANGELOG_DOMAINS` 里声明了，却**没有生产者**。
 *    视图会显示"通讯录 0 条"，读起来像坏了 —— 而事实是我们不采
 *    （PII 类命令不进白名单，CLAUDE.md §5）。
 *
 * 两个错误都不报错、都只在**界面上**显形，而那时已经在用户眼前了。
 */
describe("拓扑自检：声明与事实必须一致", () => {
  it("★★★ 当前的声明是自洽的（没有空 active 域、没有未声明的域）", () => {
    expect(checkTopologyConsistency()).toEqual([])
  })

  it("★★★ 标 active 却没有生产者 → 被抓到", () => {
    /**
     * 这是错误 ①（漏声明生产者）的形状。反证的意义在于：
     * 若这条不红，那么删掉 `PRODUCERS` 里任意一行都不会有人发现。
     */
    const problems = checkTopologyConsistency({
      domains: [{ id: "doc", producedBy: "active", purpose: "文档" }],
      producers: [],
      consumers: [],
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("doc")
  })

  it("★★★ 标 absent 却必须写清原因（否则「没做」与「坏了」同形）", () => {
    const problems = checkTopologyConsistency({
      domains: [{ id: "contact", producedBy: "absent", purpose: "通讯录" }],
      producers: [],
      consumers: [],
    })
    expect(problems.some((p) => p.includes("absentReason"))).toBe(true)
  })

  it("★★ 消费者声明消费一个没有生产者的域 → 被抓到", () => {
    /**
     * 这种声明会让界面显示"某消费者在消费 contact，lag 0" ——
     * 而它永远收不到任何一条。用户读到的是"它追平了"。
     */
    const problems = checkTopologyConsistency({
      domains: [{ id: "contact", producedBy: "absent", purpose: "通讯录", absentReason: "PII" }],
      producers: [],
      consumers: [
        {
          id: "x",
          domains: ["contact"],
          required: false,
          dependsOn: [],
          routed: false,
          purpose: "测试",
        },
      ],
    })
    expect(problems.some((p) => p.includes("contact"))).toBe(true)
  })

  it("★★ `attention-stream` 不算 changelog 生产者（它产的是路由判断）", () => {
    /**
     * ★ 判据落在"只数 `scope: learning` 的生产者"。把 attention 算进来的话，
     * 一个只有 attention 生产者的域会看起来"有人在产"，
     * 而 changelog 里其实永远是空的 —— 那正是这套自检要防的形状。
     */
    const problems = checkTopologyConsistency({
      domains: [{ id: "chat", producedBy: "active", purpose: "聊天" }],
      producers: [
        {
          id: "attention-stream",
          domains: ["chat"],
          scope: "attention",
          backfills: false,
          purpose: "路由",
        },
      ],
      consumers: [],
    })
    expect(problems).toHaveLength(1)
  })

  it("★ activeDomains() 只给真的有生产者的那三个", () => {
    expect(activeDomains()).toEqual(["chat", "minutes", "doc"])
  })

  it("★★★ contact 标 absent，并说清是安全边界而不是排期", () => {
    /**
     * 措辞判据：`absentReason` 不能读起来像"暂未实现"。通讯录属 PII，
     * 相关命令按 CLAUDE.md §5 不进白名单 —— 那不是排期问题。
     * 标成 planned 反而是一个不会兑现的承诺。
     */
    const contact = DOMAINS.find((domain) => domain.id === "contact")
    expect(contact?.producedBy).toBe("absent")
    expect(contact?.absentReason).toContain("白名单")
  })
})
