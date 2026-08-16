/**
 * 生产者骨架的门禁 —— **同一组闸门用例对三个域各跑一遍**。
 *
 * ## ★★★ 这个文件存在的理由
 *
 * 三个域的范围闸原来有**三份**实现，而其中两份已经漂出真实的隐私缺陷：
 *
 * · **文档那份压根没有闸** —— `runDocuments()` 第一行是 `documents.list({})`，
 *   全程不看范围；
 * · **聊天那份的时间闸被会话闸挡住了** —— 过滤整段包在
 *   `if (scope.restricted)` 里，而 `restricted` 的语义是"设了**会话**白名单"。
 *   于是「配了 since、没配 conversationIds」这个组合下 `since` 完全失效，
 *   而那正是**飞书那一行的真实形状**（`syncTimeWindowToSources` 刻意不带
 *   `conversationIds`）。
 *
 * 两个缺陷的形状相同：判据有三份，其中一份漂了。所以这里的纪律是
 * **一组用例驱动三个域** —— 任何一条判据被改坏，三个域一起红。
 *
 * ## 断言的是**结果**（哪些进了库 / 丢了几条），不是"某个函数被调过"
 *
 * 断言"调过 xx"锁的是实现；而这里要锁的是"越界数据不在库里"这个事实。
 */
import { describe, expect, it } from "vitest"
import { createLogger, ManualClock } from "@mycontext/kernel"
import { DistillSourceRepository, type ScopedDomain } from "@mycontext/store"
import { ProducerRunner, type DomainProducer } from "@mycontext/ingest"
import { openTestVault, type TestVault } from "../../helpers/vault.js"

const CH = "dingtalk"
const NOW = 1_785_000_000_000
const DAY = 86_400_000

/** 一个最小的 item：只有 runner 真的会读的两个标量。 */
interface Item {
  id: string
  partition: string | null
  at: number | null
}

/**
 * 造一个**记账式**的适配器 —— 它不真的落库，只记下"runner 交给我哪些"。
 *
 * ★ 不真落库是刻意的：这一层要验的是**闸门**，而不是三个 `persist*`
 * 各自的事务语义（那些各有自己的测试）。用真库会让每条用例都要造
 * 会话外键、raw 记录、幂等键 —— 而那些与闸门无关的脚手架会淹掉判据。
 */
function makeProducer(domain: ScopedDomain) {
  const persisted: Item[][] = []
  const accounted: { partitionId: string; dayBucket: string; delta: number }[] = []
  const producer: DomainProducer<Item> = {
    domain,
    partitionOf: (item) => item.partition,
    occurredAtOf: (item) => item.at,
    persist: (items) => {
      persisted.push([...items])
      return { changed: items.length, unchanged: 0 }
    },
    account: (input) => {
      accounted.push({
        partitionId: input.partitionId,
        dayBucket: input.dayBucket,
        delta: input.delta,
      })
    },
  }
  return { producer, persisted, accounted }
}

function makeRunner(vault: TestVault) {
  return new ProducerRunner({
    db: vault.db,
    clock: new ManualClock(NOW),
    channelId: CH,
    logger: createLogger("test-producer", { level: "error" }),
  })
}

/** 往 `distill_sources` 写一行范围。 */
function setScope(
  vault: TestVault,
  domain: ScopedDomain,
  scope: { since?: number; until?: number; conversationIds?: string[] },
  enabled = true,
): void {
  new DistillSourceRepository(vault.db).upsert(domain, { enabled, scope }, NOW)
}

/** 三个域共用的那一组闸门用例。 */
const DOMAINS: readonly ScopedDomain[] = ["chat", "minutes", "doc"]

describe.each(DOMAINS)("★★★ 范围闸（域 = %s）", (domain) => {
  it("★★★ 时间下界生效，**即使没配会话白名单**（这修的是飞书那个缺口）", () => {
    const vault = openTestVault()
    const runner = makeRunner(vault)
    const { producer, persisted } = makeProducer(domain)
    // ★ 只写 since，**不写 conversationIds** —— 正是 syncTimeWindowToSources 的形状
    setScope(vault, domain, { since: NOW - 30 * DAY })

    const result = runner.run(producer, [
      { id: "in", partition: "p1", at: NOW - 3 * DAY },
      { id: "old", partition: "p1", at: NOW - 100 * DAY },
    ])

    /**
     * ★★★ 这是本文件最重要的一条。
     *
     * 旧实现把时间闸包在 `if (scope.restricted)` 里，而 `restricted` 的语义
     * 是"设了**会话**白名单" —— 这里没设，所以 `restricted === false`，
     * 于是那道时间闸整个被跳过。实测（旧代码）：100 天前那条照样落库。
     *
     * 反证：把 `run()` 里的时间闸包回 `if (scope.restricted)` ⇒ 三个域一起红。
     */
    expect(persisted[0]?.map((item) => item.id)).toEqual(["in"])
    expect(result.droppedOutOfScope).toBe(1)
    vault.close()
  })

  it("★★ 时间上界也卡（选了历史区间的用户不该持续收到今天的数据）", () => {
    const vault = openTestVault()
    const runner = makeRunner(vault)
    const { producer, persisted } = makeProducer(domain)
    setScope(vault, domain, { since: NOW - 100 * DAY, until: NOW - 30 * DAY })

    runner.run(producer, [
      { id: "inRange", partition: "p1", at: NOW - 50 * DAY },
      { id: "tooNew", partition: "p1", at: NOW - DAY },
    ])

    expect(persisted[0]?.map((item) => item.id)).toEqual(["inRange"])
    vault.close()
  })

  it("★ 没设界（用户选了不限）→ 全放行", () => {
    const vault = openTestVault()
    const runner = makeRunner(vault)
    const { producer, persisted } = makeProducer(domain)
    setScope(vault, domain, {})

    const result = runner.run(producer, [
      { id: "a", partition: "p1", at: NOW - 3 * DAY },
      { id: "b", partition: "p1", at: NOW - 500 * DAY },
    ])

    // ★ 不限就是不限 —— 不该顺手收窄
    expect(persisted[0]).toHaveLength(2)
    expect(result.droppedOutOfScope).toBe(0)
    vault.close()
  })

  it("★★ 源被显式关掉 → 整批丢弃且报 scopeNotReady", () => {
    const vault = openTestVault()
    const runner = makeRunner(vault)
    const { producer, persisted } = makeProducer(domain)
    setScope(vault, domain, {}, false)

    const result = runner.run(producer, [{ id: "a", partition: "p1", at: NOW }])

    expect(persisted).toHaveLength(0)
    expect(result.droppedOutOfScope).toBe(1)
    expect(result.scopeNotReady).toBe(true)
    vault.close()
  })

  it("★★★ 空批时**不**报 scopeNotReady（否则安静的频道永远推不动水位）", () => {
    const vault = openTestVault()
    const runner = makeRunner(vault)
    const { producer } = makeProducer(domain)
    setScope(vault, domain, {}, false)

    const result = runner.run(producer, [])

    /**
     * 空批本来就没东西可丢。报 `scopeNotReady` 会让调用方停止推水位 ——
     * 于是一个安静的频道（真的没有新数据）永远推不动水位，那是活锁。
     *
     * 反证：把 `scopeNotReady: items.length > 0` 改成恒 true ⇒ 这条转红。
     */
    expect(result.scopeNotReady).toBe(false)
    vault.close()
  })

  describe("渠道没给业务时间的那些（occurredAt = null）", () => {
    it("★★ 设了界 → 挡掉（判据不可靠时走隐私那一侧）", () => {
      const vault = openTestVault()
      const runner = makeRunner(vault)
      const { producer, persisted } = makeProducer(domain)
      setScope(vault, domain, { since: NOW - 30 * DAY })

      const result = runner.run(producer, [
        { id: "dated", partition: "p1", at: NOW - 3 * DAY },
        { id: "undated", partition: "p1", at: null },
      ])

      expect(persisted[0]?.map((item) => item.id)).toEqual(["dated"])
      // ★ 单独计数：它与"超出日期"的出路不同（后者去改范围、前者查渠道解析）
      expect(result.droppedUnknownTime).toBe(1)
      vault.close()
    })

    it("★★★ 没设界 → 放行（此时挡掉它是**凭空丢数据**）", () => {
      const vault = openTestVault()
      const runner = makeRunner(vault)
      const { producer, persisted } = makeProducer(domain)
      setScope(vault, domain, {})

      runner.run(producer, [{ id: "undated", partition: "p1", at: null }])

      /**
       * 这一条是上一条的**必要配对**。只写上一条的话，最省事的实现是
       * "时间未知一律挡" —— 而那会让「用户选了不限」的场景静默少掉一批
       * 数据（渠道对某类数据就是不给时间）。
       */
      expect(persisted[0]).toHaveLength(1)
      vault.close()
    })
  })
})

describe("★★ 分区闸（只有按分区切的域才有）", () => {
  it("★★★ 配了白名单 → 名单外的分区被丢", () => {
    const vault = openTestVault()
    const runner = makeRunner(vault)
    const { producer, persisted } = makeProducer("chat")
    setScope(vault, "chat", { conversationIds: ["cidFAKE0001=="] })

    runner.run(producer, [
      { id: "picked", partition: "cidFAKE0001==", at: NOW },
      { id: "notPicked", partition: "cidFAKE0002==", at: NOW },
    ])

    expect(persisted[0]?.map((item) => item.id)).toEqual(["picked"])
    vault.close()
  })

  it("★★★ `partitionOf` 返回 null（不按分区切的域）→ 分区闸**跳过**", () => {
    const vault = openTestVault()
    const runner = makeRunner(vault)
    const { producer, persisted } = makeProducer("minutes")
    // 白名单里有东西，但听记的 partitionOf 恒 null
    setScope(vault, "minutes", { conversationIds: ["cidFAKE0001=="] })

    runner.run(producer, [{ id: "meeting", partition: null, at: NOW }])

    /**
     * ★ `null` 必须走"跳过"而不是"拿空串查白名单"。
     *
     * 后者会让**所有**听记都被判成"不在名单里"（空串肯定不在白名单里）
     * → 听记整个停采，而日志里只有一句"丢了 N 条"。
     *
     * 反证：把 `partition !== null` 那个判断去掉（改成 `?? ""`）⇒ 这条转红。
     */
    expect(persisted[0]).toHaveLength(1)
    vault.close()
  })

  it("★★ 配了白名单但**一个都没勾** → 一条都不采 + scopeNotReady", () => {
    const vault = openTestVault()
    const runner = makeRunner(vault)
    const { producer, persisted } = makeProducer("chat")
    setScope(vault, "chat", { conversationIds: [] })

    const result = runner.run(producer, [{ id: "a", partition: "p1", at: NOW }])

    /**
     * 「我一个都不要」不能被执行成「全都要」。而这个状态也要报
     * `scopeNotReady` —— 用户之后勾上时那些消息还应该能被采到
     * （否则得手动重置水位，而那个入口在设置页深处）。
     */
    expect(persisted).toHaveLength(0)
    expect(result.scopeNotReady).toBe(true)
    vault.close()
  })
})

describe("★★★ scopeNotReady 的两种「整批被丢」必须可区分", () => {
  it("范围**没配好** → true（调用方不许推水位）", () => {
    const vault = openTestVault()
    const runner = makeRunner(vault)
    const { producer } = makeProducer("chat")
    // 刻意**不**写 distill_sources —— chat 的缺省是 collect-nothing

    const result = runner.run(producer, [{ id: "a", partition: "p1", at: NOW }])

    expect(result.scopeNotReady).toBe(true)
    vault.close()
  })

  it("★★★ 范围**有效**、只是这一批恰好全越界 → false（照常推水位）", () => {
    const vault = openTestVault()
    const runner = makeRunner(vault)
    const { producer, persisted } = makeProducer("chat")
    setScope(vault, "chat", { conversationIds: ["cidFAKE0001=="] })

    const result = runner.run(producer, [{ id: "other", partition: "cidFAKE0002==", at: NOW }])

    /**
     * ★★★ 这两条的**区别**是这一整段设计的关键。
     *
     * 两者都是"整批被丢"，但：
     * · 范围没配好 ⇒ 水位不能推（推了那批消息永远回不来）；
     * · 范围有效、这批全越界 ⇒ **必须**推水位 —— 否则一个"只勾了 1 个群"
     *   的用户会因为别的群的消息而永远推不动水位（那是活锁）。
     *
     * 混成一个布尔会二选一地踩中其中一个 —— 而两个都是静默故障。
     *
     * 反证：把 `kept.length === 0` 那个分支的 `scopeNotReady` 改成 true
     * ⇒ 这条转红。
     */
    expect(persisted).toHaveLength(0)
    expect(result.droppedOutOfScope).toBe(1)
    expect(result.scopeNotReady).toBe(false)
    vault.close()
  })
})

describe("★★ 覆盖面记账", () => {
  it("★★★ 只记**留下来的**（否则进度永远追不平）", () => {
    const vault = openTestVault()
    const runner = makeRunner(vault)
    const { producer, accounted } = makeProducer("chat")
    setScope(vault, "chat", { since: NOW - 30 * DAY })

    runner.run(producer, [
      { id: "in", partition: "p1", at: NOW - 3 * DAY },
      { id: "old", partition: "p1", at: NOW - 100 * DAY },
    ])

    /**
     * 记范围外的会让覆盖面与实体表永久对不上：说这天有 2 条、库里只有 1 条
     * （另一条被闸门挡了），界面于是显示"还差 1 条" —— 而那一条是用户
     * 明确不要的。一个永远追不平的进度比没有进度更糟。
     */
    expect(accounted).toHaveLength(1)
    expect(accounted[0]?.delta).toBe(1)
    vault.close()
  })

  it("★★ 按 (分区, 天) 分组 —— 同一天同一分区合成一格", () => {
    const vault = openTestVault()
    const runner = makeRunner(vault)
    const { producer, accounted } = makeProducer("chat")
    setScope(vault, "chat", {})

    runner.run(producer, [
      { id: "a", partition: "p1", at: NOW },
      { id: "b", partition: "p1", at: NOW + 1000 },
      { id: "c", partition: "p2", at: NOW },
    ])

    // p1 两条合成一格、p2 一条 —— 两格
    expect(accounted).toHaveLength(2)
    expect(accounted.find((row) => row.partitionId === "p1")?.delta).toBe(2)
    expect(accounted.find((row) => row.partitionId === "p2")?.delta).toBe(1)
    vault.close()
  })

  it("★★★ 分区 id 里含空格 / 冒号 / 连字符时都不会把 dayBucket 切错", () => {
    const vault = openTestVault()
    const runner = makeRunner(vault)
    const { producer, accounted } = makeProducer("chat")
    setScope(vault, "chat", {})

    /**
     * ★★★ 内部把 (分区, 天) 拼成一个字符串 key 再 `split` 取回来。
     * 分隔符若是一个**可能出现在 id 里**的字符，`split` 会把 id 切成两半
     * —— 于是 `dayBucket` 拿到 id 的后半段，这一天的数据被记到一个不存在的
     * 日期上，而两个数字都会「看起来对」。
     *
     * ★ 三种字符都试：空格（知识库名字里带空格是常态）、冒号（`a:b` 形状的
     * id）、连字符（它同时出现在 `YYYY-MM-DD` 里，是最容易被误选的分隔符）。
     * 实现用的是 `\u0000`（NUL）—— 它不可能出现在渠道给的 id 里。
     *
     * 反证：把实现里的 `\u0000` 换成 `" "`（或 `":"`、`"-"`）⇒ 对应那一条转红。
     */
    const ids = ["space with space", "colon:in:id", "dash-in-id"]
    runner.run(
      producer,
      ids.map((partition, index) => ({ id: `a${index}`, partition, at: NOW })),
    )

    expect(accounted.map((row) => row.partitionId).sort()).toEqual([...ids].sort())
    for (const row of accounted) {
      expect(row.dayBucket).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    vault.close()
  })

  it("★ 记账抛错不影响落库（覆盖面是派生物，采集是正事）", () => {
    const vault = openTestVault()
    const runner = makeRunner(vault)
    const { producer, persisted } = makeProducer("chat")
    setScope(vault, "chat", {})
    const boom: DomainProducer<Item> = {
      ...producer,
      account: () => {
        throw new Error("记账挂了")
      },
    }

    const result = runner.run(boom, [{ id: "a", partition: "p1", at: NOW }])

    // 数据仍然进库了 —— 记账失败不该拖垮采集
    expect(persisted[0]).toHaveLength(1)
    expect(result.changed).toBe(1)
    vault.close()
  })
})

/**
 * ── ★★★ 接线：三条采集路**真的**共用同一个闸 ────────────────────
 *
 * 上面全绿而服务层仍各写一份的话，这套骨架就只是一个没人用的库。
 * 而"各写一份"正是那两个隐私缺口的成因，所以这一条锁的是**结构**：
 * 三条路都必须经过 `admitByScope`，且不许再出现"自己拼判据"的写法。
 */
describe("接线：采集路共用同一个闸", () => {
  it("★★★ `ProducerRunner` 真的被生产代码用了（修 G10）", async () => {
    /**
     * ## 这一条这一轮**换了方向**，理由如下
     *
     * 原来它数 `admitByScope<` 的出现次数（要求 ≥ 2）。那个判据在
     * "各写一份判据"的年代是对的，但它有一个反向的坏处：
     * **整段走 runner 之后调用点会变少**，于是它拦住了正确的修复。
     *
     * 而 G10 的真实形状是：`ProducerRunner` 有 32 条门禁而生产代码
     * **零引用** —— 它只出现在一句注释里。所以现在锁的是那件事：
     * 那一层必须真的在跑。
     */
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/ingest.service.ts", "utf8")
    // ★ 构造了一个实例（而不是只 import 了类型）
    expect(src).toContain("new ProducerRunner({")
    // ★★ 而且真的**跑**了它 —— 至少两条路（文档与听记）
    const runs = src.match(/this\.producers\.run</g) ?? []
    expect(runs.length).toBeGreaterThanOrEqual(2)
  })

  it("★★★ 聊天那条路仍然共用判据（它不整段走 runner，但闸只有一份）", async () => {
    /**
     * ## 为什么聊天**刻意**不整段走 runner
     *
     * 它推进一个**不可回退的水位**（`commitProgress` / `confirmedEnd` /
     * `splitIfTruncated` 那套不变式），而水位算错是这条链路上最贵的错误
     * （永久漏采或永久重拉）。另两个域每轮从头列举，"这一轮白丢"的代价
     * 只是一轮 CLI 调用 —— 风险完全不同。
     *
     * ★ 但**判据**必须只有一份：那两个隐私缺口（文档没有闸、聊天的时间闸
     * 被会话闸挡住）的形状都是"判据有多份、其中一份漂了"。
     * 所以聊天那条路调 `admitByScope`，与 runner 内部同一个函数。
     */
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/ingest.service.ts", "utf8")
    expect(src).toContain("admitByScope<")
    /**
     * ★ 而它**不许**自己实现一份 —— 那两个词同时出现在一个手写的
     * filter 里就是那个缺陷的形状（下一条锁的是嵌套那一半）。
     */
    expect(src).not.toContain("isOccurredAtInScope(")
  })

  it("★★★ 三条路的丢弃计数进**同一个**按域计数器（G16 的前提）", async () => {
    /**
     * ## 为什么这一条必须锁住
     *
     * 聊天那条路不整段走 runner，所以它很容易"顺手"只加一份本地计数 ——
     * 那时 `buildProducerStatuses` 里 chat 那一行永远是 0，
     * 而它恰恰是量级最大的那个域（实测越界过 46,415 条）。
     *
     * 判据：那条路必须调 `noteDroppedFor`（runner 的公开记账入口）。
     */
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/ingest.service.ts", "utf8")
    expect(src).toContain('noteDroppedFor("chat"')
    /**
     * ★★ 而改范围时那份计数要清 —— 与两个旧字段同一条判据。
     * 漏掉会让同一件事在界面上有两个互相矛盾的数字。
     */
    expect(src).toContain("this.producers.resetCounters()")
  })

  it("★★★ runner **不调用**任何水位方法（4c 的纪律）", async () => {
    /**
     * ## 这一条锁的是"没有动那段最难的代码"
     *
     * 聊天那条路整段搬进 runner 的风险是水位算错 —— 而那是这条链路上
     * 最贵的错误（永久漏采或永久重拉）。所以 4c 只共用**判据与记账**。
     *
     * ## ★★ 断言必须区分「注释里提到」与「真的调用」
     *
     * 我第一版写的是 `not.toContain("commitProgress")` —— 而它当场转红，
     * 因为 runner 的注释里**正在解释**"为什么不碰水位"就提到了那几个名字。
     *
     * 那个失败是对的：一个连注释都不许提的判据会逼人删掉解释。
     * 所以判据改成**调用形状**（`.commitProgress(` 这种），
     * 而注释里的反引号引用不受影响。
     */
    const { readFileSync } = await import("node:fs")
    const runner = readFileSync("packages/ingest/src/producer.ts", "utf8")
    for (const invariant of [
      "commitProgress",
      "confirmedEnd",
      "splitIfTruncated",
      "resetIncrementalWatermark",
    ]) {
      // ★ `.xxx(` = 真的在调它；注释里写的是 `` `xxx` ``（反引号），不匹配
      expect(runner, `runner 不许调水位方法：${invariant}`).not.toContain(`.${invariant}(`)
    }
    /**
     * ★ 而 runner **也不许** import scheduler（那是水位的家）——
     * 没有那个 import，上面四条在结构上就不可能被违反。
     */
    expect(runner).not.toContain("scheduler.js")
  })

  it("★★★ `scopeNotReady` 只有 watermark 那个生产者声明要停（其余每轮重列）", async () => {
    /**
     * `scopeNotReady` 修的是一次真实事故：采集器比范围行先跑（实测差 1 秒），
     * 那一轮拉到的 9 条全被丢，而**水位照常前移** —— 之后 since 之后
     * 没有新消息就永远不再拉。用户看到"已采集 0"，日志里一个错都没有。
     *
     * ★ 关键在"水位照常前移"这一步。另两个域每轮从头列举，
     * "这一轮白丢"的代价只是一轮 CLI 调用 —— 下一轮范围就绪了会再列一遍。
     *
     * 所以这个字段只有 chat 为 true，而它必须**由声明表达**
     * （散在三个 tick 里的 if 让"为什么听记不需要它"只能靠读代码回答）。
     */
    const { PRODUCERS } = await import("@mycontext/ingest")
    const halting = PRODUCERS.filter((p) => p.haltsOnScopeNotReady).map((p) => p.id)
    expect(halting).toEqual(["chat-ingest"])
    // ★ 而它恰好就是唯一那个 watermark 调度的（两个字段必须一致）
    const watermark = PRODUCERS.filter((p) => p.schedule === "watermark").map((p) => p.id)
    expect(watermark).toEqual(halting)
  })

  it("★★★ 不许再出现「时间闸包在 restricted 里」那个形状", async () => {
    /**
     * ## 这条锁的是那个真实缺陷的**形状**，不是某一行代码
     *
     * 缺陷是：`isSentAtInScope` 被写在 `if (scope.restricted)` 的内部。
     * 而 `restricted` 的语义是"设了**会话**白名单" —— 两者是独立的两道闸。
     *
     * 判据落在"`isSentAtInScope` 这个名字还在采集服务里出现吗"：
     * 它现在的正确位置是 `admitByScope` 内部（那里叫 `isOccurredAtInScope`），
     * 采集服务不该再直接调它。这样"有人又内联了一份时间闸"会被抓到。
     *
     * ★ 用源码断言而不是行为断言，是因为这一条锁的是**结构**
     * （判据只有一处）—— 而行为那侧已经由
     * `ingest-scope-gate.test.ts` 里那两条真数据用例锁住了。
     */
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/ingest.service.ts", "utf8")
    const persistAt = src.indexOf("private persist(")
    expect(persistAt).toBeGreaterThan(0)
    const persistBody = src.slice(persistAt, persistAt + 6000)
    expect(persistBody).toContain("admitByScope")
    // 内联的时间闸不该再有
    expect(persistBody.includes("isSentAtInScope")).toBe(false)
  })
})
