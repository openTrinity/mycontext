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
import { FTS_CONSUMER_ID, VECTOR_CONSUMER_ID } from "@mycontext/ingest"
import { DISTILL_CONSUMER_ID } from "@mycontext/distill"
import { GRAPH_BUILD_CONSUMER_ID, GRAPH_SYNC_CONSUMER_ID } from "@mycontext/knowledge-feed"
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

  it("★★★ 蒸馏**不**依赖图谱导出 —— 它压根不读图谱（修 G13）", () => {
    /**
     * ## 这一条这一轮**换了方向**，而依据是源码
     *
     * 原来它断言 `dependsOn === ["graph-export"]`，理由写的是
     * "蒸馏引用图谱抽出的 fact"。核对之后那句话是错的：
     *
     * `packages/distill/src/consumer.ts` 的 import 只有三行
     * （kernel / store 的两个 repository / ./runner.js），handler 做的
     * 唯一一件事是把 changelog 的 seq 映射成时间窗、enqueue 进
     * `distill_tasks` —— **不 import 任何图谱**、不读 `knowledge.db`。
     *
     * 真正读 kl 图库的是 `map/playbook-chunks.ts`（只读 `chunks` 表），
     * 而它属于 **`distill-work`** 那个消费者。所以那条边贴错了消费者。
     *
     * ## 留着它的代价（不是零）
     *
     * kl 服务没起时依赖闸不生效（上游没注册就不夹），所以平时看不出来。
     * 但 kl 起着而导出慢时（导出 1 秒、建图 2 小时），`distill` 会白等一个
     * 它不需要的上游 —— 而它要的语料就在 `messages` 表里。
     *
     * 更贵的那一半是**声明说了谎**：读这一行的人会以为蒸馏读图谱，
     * 于是排查"画像缺了一段"时去查图谱，而真因在别处。
     */
    const distill = CONSUMERS.find((spec) => spec.id === DISTILL_CONSUMER_ID)
    expect(distill?.dependsOn).toEqual([])
  })

  it("★★★ 反证：蒸馏 handler 真的不 import 图谱（上一条的依据）", async () => {
    /**
     * 上一条断言的是**声明**，这一条锁的是那个声明所依据的**事实** ——
     * 否则将来有人给蒸馏 handler 加上读图谱的代码，声明就又错了，
     * 而没有任何东西会提醒他补回那条边。
     */
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("packages/distill/src/consumer.ts", "utf8")
    expect(src).not.toContain("knowledge.db")
    expect(src).not.toContain("playbook")
    // ★ 而它确实在做"切窗入队"这件事（没被顺手改成别的）
    expect(src).toContain("DistillTaskRepository")
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

  /**
   * ── ★★★ G2：**会注册游标的消费者都必须在声明里** ──────────────
   *
   * `graph-build` 与 `distill-work` 原来都**不在** `CONSUMERS` 里，而它们
   * 都会真的往 `consumer_cursors` 注册。后果不是报错，而是状态页**少两行**
   * —— 一个卡住的建图消费者在界面上根本不存在，而它恰恰是最容易卡住的
   * 那个（建图是小时级，Phase A 会全量重跑向量化）。
   */
  it("★★★ graph-build / graph-export 都在声明里（它们会真的注册游标）", () => {
    const ids = CONSUMERS.map((spec) => spec.id)
    expect(ids).toContain(GRAPH_BUILD_CONSUMER_ID)
    expect(ids).toContain(GRAPH_SYNC_CONSUMER_ID)
    /**
     * ★ `distill-work` 的 id 常量在 `distill.service.ts` 里是**私有的**
     * （`const WORK_CONSUMER_ID`，没导出），所以这里只能写字面量。
     * 那个字面量由下一条源码断言兜住。
     */
    expect(ids).toContain("distill-work")
  })

  it("★★★ `distill-work` 的字面量与 distill.service 里那个常量一致", async () => {
    /**
     * 上一条只能写字面量（那个常量没导出）。这一条去源码里核对它 ——
     * 否则 `WORK_CONSUMER_ID` 被改名之后，声明里那一行会静默指向一个
     * 不存在的游标，而表现是"work 层永远显示未注册"。
     */
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/distill.service.ts", "utf8")
    expect(src).toContain('WORK_CONSUMER_ID = "distill-work"')
  })

  it("★★ 三条依赖边：build←export、work←distill、★work←build", () => {
    /**
     * 前两条原来是**隐式**成立的（同一个 service 内的顺序调用）。
     * 声明它们让顺序从"记得写对"变成"算出来的"，且状态页能说出
     * 「建图在等导出」而不是「建图没进展」—— 两者数字同形、出路不同。
     *
     * ★ 判据的实质：建图读的是**已导出**的四件套。跑在导出前面就是拿旧
     * 快照建图，而它会照常"成功"（那是本仓库最贵的那类静默降级）。
     *
     * ## ★★★ 第三条是这一轮新加的，它**取代**了原来挂在 distill 上那条
     *
     * playbook 归纳读 kl 的 `chunks` 表（`map/playbook-chunks.ts`），
     * 而那张表要等 `kl ingest` 跑完才更新 —— 所以正确的上游是
     * **build** 而不是 export（导出完成只说明四件套是新的，两者相差小时级）。
     *
     * 建图没跑完时 chunks 是旧的或空的，于是归纳出的"工作套路"来自一份
     * 过期快照 —— 而它同样会"成功"，产出一份看起来很有底气的错误画像。
     */
    const by = new Map(CONSUMERS.map((spec) => [spec.id, spec]))
    expect(by.get(GRAPH_BUILD_CONSUMER_ID)?.dependsOn).toEqual([GRAPH_SYNC_CONSUMER_ID])
    expect(by.get("distill-work")?.dependsOn).toEqual([
      DISTILL_CONSUMER_ID,
      GRAPH_BUILD_CONSUMER_ID,
    ])
  })

  it("★★★ 拓扑序把三条边都算对了（work 排在 distill 与 build 之后）", () => {
    const order = resolveConsumerOrder()
    expect(order.indexOf(GRAPH_SYNC_CONSUMER_ID)).toBeLessThan(
      order.indexOf(GRAPH_BUILD_CONSUMER_ID),
    )
    expect(order.indexOf(DISTILL_CONSUMER_ID)).toBeLessThan(order.indexOf("distill-work"))
    // ★ 新边：work 也必须排在建图之后（它读建图产出的 chunks）
    expect(order.indexOf(GRAPH_BUILD_CONSUMER_ID)).toBeLessThan(order.indexOf("distill-work"))
  })

  it("★★ 没接线的消费者标 unwired 且说清原因（G7）", () => {
    /**
     * `local-index-vector` 有完整实现（`createVectorHandler`）而 apps 侧
     * 零引用。它既不是 bug（embedding 是远程付费调用，接不接是产品决定），
     * 也不是待办（标 planned 是一个不会兑现的承诺）。
     *
     * ★★ `unwired` 与 `absent` 必须分开：后者是"这套**部署**没起它"
     * （如 kl 服务没起，出路是起服务），前者是"这套**代码**没接它"
     * （出路是什么都不用做）。混成一个会让用户去找一个从来不存在的服务。
     */
    const vector = CONSUMERS.find((spec) => spec.id === VECTOR_CONSUMER_ID)
    expect(vector).toBeDefined()
    expect(vector?.wiring).toBe("unwired")
    expect(vector?.unwiredReason ?? "").not.toBe("")
    /**
     * ★ 没接线的**绝不能** required：标 true 会让 `retainableSeq()` 把它
     * 算进"活跃必需消费者"，而它的 acked_seq 恒 0 ⇒ changelog 永远裁不动。
     */
    expect(vector?.required).toBe(false)
  })

  it("★ 只有那一个是 unwired（不许悄悄多一个没接的）", () => {
    const unwired = CONSUMERS.filter((spec) => spec.wiring === "unwired").map((spec) => spec.id)
    expect(unwired).toEqual([VECTOR_CONSUMER_ID])
  })
})

describe("★★★ 生产者声明：只有「往 DWD 写的东西」（v4 §6.3）", () => {
  it("★★★ `attention-stream` **不在** PRODUCERS 里 —— 它是消费者", () => {
    /**
     * ## 这一条这一轮**换了方向**，判据是"输入是什么"
     *
     * | | chat-ingest | attention-stream |
     * |---|---|---|
     * | 输入 | 渠道 CLI（**外部**） | ★ `messages` / changelog（**我们自己的表**） |
     * | 输出 | `messages` + changelog | 一个判定 + 投递 |
     *
     * 输入是我们自己的表 = **消费者**。而它已经是消费者形状
     * （`persona-inbox` 就是它 —— 有游标、有租约、有 `routed: true`），
     * 所以 `PRODUCERS` 里那一行是**重复声明**。
     *
     * ★ 代价已经显形三处：自检判据① 要开 filter 特例、它的 `scopeReady`
     * 读的是学习范围（v3 引入的 bug）、它的 dropped 恒 0 而真值在
     * `attention_coverage.skipped_count` 里。
     */
    expect(PRODUCERS.map((spec) => spec.id)).not.toContain("attention-stream")
    // ★ 而那件事本身仍在做 —— 由 persona-inbox 那个消费者（带路由闸）
    expect(CONSUMERS.find((spec) => spec.id === PERSONA_CONSUMER_ID)?.routed).toBe(true)
  })

  it("★★★ 所有生产者都**会回溯**（往回挖历史是采集的本职）", () => {
    /**
     * ★ 摘掉 `attention-stream` 之后这张表内部同质：全都是"从渠道拉、
     * 往 DWD 写"的东西，而它们都要能回溯（`backfills: true`）。
     *
     * 反证：新加一个 `backfills: false` 的生产者 → 这条转红，
     * 而那时该问的是"它到底是不是生产者"（不回溯的东西通常是消费者）。
     */
    expect(PRODUCERS.every((spec) => spec.backfills)).toBe(true)
  })

  it("★★★ `scope` 字段已删（所有生产者受同一个采集面管）", () => {
    /**
     * 它原来区分"受哪个范围管"。而采集面现在是**并集**
     * （`readCollectionRequest` = 学习范围 ∪ 监听范围），
     * 所以那个字段没有区分度了。
     *
     * ★ 而它的存在正是自检判据① 需要 filter 特例的原因 ——
     * 一张声明表需要跳过某几行才能自检，就是分类错了。
     */
    for (const spec of PRODUCERS) {
      expect((spec as { scope?: unknown }).scope).toBeUndefined()
    }
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
      {
        id: "a",
        domains: null,
        required: false,
        dependsOn: ["b"],
        routed: false,
        wiring: "wired",
        purpose: "",
      },
      {
        id: "b",
        domains: null,
        required: false,
        dependsOn: ["a"],
        routed: false,
        wiring: "wired",
        purpose: "",
      },
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
        wiring: "wired",
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
      domains: [{ id: "doc", kind: "collectable", producedBy: "active", purpose: "文档" }],
      producers: [],
      consumers: [],
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("doc")
  })

  it("★★★ 标 absent 却必须写清原因（否则「没做」与「坏了」同形）", () => {
    const problems = checkTopologyConsistency({
      domains: [{ id: "contact", kind: "legacy-only", producedBy: "absent", purpose: "通讯录" }],
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
      domains: [
        {
          id: "contact",
          kind: "legacy-only",
          producedBy: "absent",
          purpose: "通讯录",
          absentReason: "PII",
        },
      ],
      producers: [],
      consumers: [
        {
          id: "x",
          domains: ["contact"],
          required: false,
          dependsOn: [],
          routed: false,
          wiring: "wired",
          purpose: "测试",
        },
      ],
    })
    expect(problems.some((p) => p.includes("contact"))).toBe(true)
  })

  /**
   * ── ★★★ 判据⑤：库里注册过的消费者都必须在声明里（这条修的是 G2）──
   *
   * 把拓扑变成**数据**的代价是"漏一行不会编译失败"，而 G2 正是这么发生的。
   * 这条判据是唯一能在**结构上**防止它复发的东西：它拿"库里实际有哪些 id"
   * 去比对声明，而不是靠人记得两边一起改。
   */
  it("★★★ 游标表里有一个没声明的消费者 → 被抓到", () => {
    const problems = checkTopologyConsistency({
      registeredConsumerIds: ["local-index-fts", "某个没声明的消费者"],
    })
    expect(problems.some((p) => p.includes("某个没声明的消费者"))).toBe(true)
  })

  it("★★★ 真实的六个 id 全都能通过（反证：删掉声明里任一行就红）", () => {
    /**
     * ★ 这里列的是**会真的注册游标**的全部 id（我 grep 过
     * `cursors.register(` 的每一个调用点）。`local-index-vector` 不在其中
     * —— 它没接线（`wiring: "unwired"`），所以从不注册。
     *
     * 反证：把 `CONSUMERS` 里 `graph-build` 那一行删掉 ⇒ 这条转红。
     * 而在这一轮改动**之前**，这条用例本来就是红的（那正是 G2）。
     */
    const problems = checkTopologyConsistency({
      registeredConsumerIds: [
        FTS_CONSUMER_ID,
        DISTILL_CONSUMER_ID,
        PERSONA_CONSUMER_ID,
        GRAPH_SYNC_CONSUMER_ID,
        GRAPH_BUILD_CONSUMER_ID,
        "distill-work",
      ],
    })
    expect(problems).toEqual([])
  })

  it("★★ 反向**不报**：声明了但库里没有是正常状态", () => {
    /**
     * `graph-export` 在没起 kl 服务的部署里就不注册；
     * `local-index-vector` 压根没接线。两者分别由 `absent`（运行时）
     * 与 `wiring`（声明）表达 —— 把它们也报成问题会让自检永远是红的，
     * 而"一条老是红的门禁"会被人加 skip，然后它就永远不响了。
     */
    expect(checkTopologyConsistency({ registeredConsumerIds: [] })).toEqual([])
  })

  it("★★ unwired 必须写 unwiredReason（否则「没接」与「坏了」同形）", () => {
    const problems = checkTopologyConsistency({
      consumers: [
        {
          id: "x",
          domains: null,
          required: false,
          dependsOn: [],
          routed: false,
          wiring: "unwired",
          purpose: "测试",
        },
      ],
    })
    expect(problems.some((p) => p.includes("unwiredReason"))).toBe(true)
  })

  it("★★★ 判据①**不再**需要 filter 特例（那个特例本身就是分类错了的信号）", () => {
    /**
     * ## 这一条这一轮**换了方向**
     *
     * 原来判据① 是 `producers.filter(p => p.scope === "learning")` ——
     * 那个 filter 存在的**唯一**理由是 `attention-stream` 在同一张表里
     * 而它不写 changelog。
     *
     * 而一张声明表需要"跳过某几行"才能自检，**本身就是分类错了的信号**。
     * `attention-stream` 已经摘掉了（它是消费者 —— 输入是我们自己的表），
     * 于是这张表内部同质、filter 可以删。
     *
     * ★ 现在的判据是"标 active 的域必须有生产者投它"，不带任何例外。
     * 反证：给一个 active 的域不配生产者 → 报一条（下面那两条已锁）。
     */
    const problems = checkTopologyConsistency({
      domains: [{ id: "chat", kind: "collectable", producedBy: "active", purpose: "聊天" }],
      producers: [
        {
          id: "chat-ingest",
          domains: ["chat"],
          backfills: true,
          schedule: "watermark",
          haltsOnScopeNotReady: true,
          purpose: "拉消息",
        },
      ],
      consumers: [],
    })
    // ★ 有生产者投它 → 干净（不需要判它的 scope 是什么）
    expect(problems).toHaveLength(0)
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
