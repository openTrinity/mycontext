/**
 * 拓扑**展示视图**的门禁 —— `buildConsumerStatuses` / `buildDomainStatuses`。
 *
 * ## ★★★ 这一组锁的是三个"在界面上同形、但出路相反"的状态
 *
 * 改动前状态页对消费者只有 `ftsLag` 一个数字与一行 `staleConsumers`。
 * 于是下面三对状况在界面上**完全一样**，而用户该做的事完全不同：
 *
 * | 看起来一样 | 实际是 | 该做什么 |
 * |---|---|---|
 * | 蒸馏没进展 | 被 graph-export 夹住（依赖闸正常工作） | 去看图谱为什么慢 |
 * | 蒸馏没进展 | 蒸馏自己卡了 | 去看蒸馏的错误 |
 * | graph-export 追平了 | 它压根没注册（没起 kl 服务） | 起服务，或忽略 |
 *
 * 所以每一条用例都在断言"这两个状态**能被区分**"，而不只是"函数返回了东西"。
 */
import { describe, expect, it } from "vitest"
import { buildConsumerStatuses, buildDomainStatuses, type ConsumerSpec } from "@mycontext/ingest"
import type { ConsumerCursorRow } from "@mycontext/store"

const NOW = 1_785_000_000_000

/** 造一行游标。只给判据用得到的字段，其余取合理缺省。 */
function cursor(input: Partial<ConsumerCursorRow> & { consumerId: string }): ConsumerCursorRow {
  return {
    ackedSeq: 0,
    required: true,
    registeredAt: NOW,
    heartbeatAt: NOW,
    staleAfterMs: 60_000,
    needsFullRebuild: false,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    lastSuccessAt: NOW,
    updatedAt: NOW,
    ...input,
  }
}

const SPECS: readonly ConsumerSpec[] = [
  {
    id: "local-index-fts",
    domains: null,
    required: true,
    dependsOn: [],
    routed: false,
    wiring: "wired",
    purpose: "全文索引",
  },
  {
    id: "graph-export",
    domains: ["chat"],
    required: false,
    dependsOn: [],
    routed: false,
    wiring: "wired",
    purpose: "喂图谱",
  },
  {
    id: "distill",
    domains: ["chat"],
    required: true,
    dependsOn: ["graph-export"],
    routed: false,
    wiring: "wired",
    purpose: "画像语料",
  },
]

function build(input: Parameters<typeof buildConsumerStatuses>[0]) {
  const statuses = buildConsumerStatuses({ consumers: SPECS, ...input })
  return new Map(statuses.map((status) => [status.id, status]))
}

describe("消费者状态：三对「同形但出路相反」的状况必须可区分", () => {
  it("★★★ 「在等上游」与「自己卡住」可区分", () => {
    /**
     * 两者的数字**完全一样**（lag 都是 700、processed 都是 0）。
     * 唯一的区别在 `waitingForUpstream`，而它只在 `runCycle` 的返回值里
     * 存在（不落库）—— 所以这一条同时锁住"lastCycle 真的被读了"。
     */
    const cursors = [cursor({ consumerId: "distill", ackedSeq: 300 })]
    const waiting = build({
      head: 1000,
      domainHeads: {},
      cursors,
      staleIds: [],
      lastCycle: [
        {
          id: "distill",
          processed: 0,
          skipped: 0,
          ackedSeq: 300,
          lockedByOther: false,
          waitingForUpstream: "graph-export",
          needsFullRebuild: false,
          absent: false,
        },
      ],
    })
    const stuck = build({ head: 1000, domainHeads: {}, cursors, staleIds: [] })

    expect(waiting.get("distill")?.waitingForUpstream).toBe("graph-export")
    expect(stuck.get("distill")?.waitingForUpstream).toBeNull()
    // ★ 而 lag 两者相同 —— 这正是"光看 lag 分不出来"的证据
    expect(waiting.get("distill")?.lag).toBe(stuck.get("distill")?.lag)
  })

  it("★★★ 「没注册」与「已追平」可区分，且 absent 不报一个大 lag", () => {
    /**
     * `graph-export` 由 kl 服务侧推进，没起服务时它**压根不注册**。
     *
     * ★ 判据是"游标里有没有这一行"，**不是**"上一轮跑没跑" ——
     * 它不在 `runCycle` 的 runnables 里（那个 map 只有 vault 内的三个），
     * 所以"上一轮没跑"对它恒成立，拿那个当判据会让一个正常工作的外部
     * 消费者永远显示"不存在"。
     */
    const statuses = build({
      head: 8000,
      domainHeads: {},
      // 只有 fts 注册了；graph-export / distill 没有
      cursors: [cursor({ consumerId: "local-index-fts", ackedSeq: 8000 })],
      staleIds: [],
    })
    const absent = statuses.get("graph-export")
    const caughtUp = statuses.get("local-index-fts")

    expect(absent?.absent).toBe(true)
    expect(caughtUp?.absent).toBe(false)
    /**
     * ★★ absent 时 lag 报 0 而不是 8000：一个没注册的消费者"落后 8000 条"
     * 是一句没有意义的话（它压根不该追）。界面靠 `absent` 说明情况，
     * 而不是靠一个大数字 —— 后者会让用户去查一个不存在的积压。
     */
    expect(absent?.lag).toBe(0)
    expect(caughtUp?.lag).toBe(0)
  })

  it("★★ 「需要全量重建」与「只是落后」可区分", () => {
    /**
     * `needsFullRebuild` = 历史已被裁剪，增量**补不回来**。它与"落后很多"
     * 的出路不同：后者等一会儿就好，前者必须走全量（可能要问用户）。
     */
    const statuses = build({
      head: 1000,
      domainHeads: {},
      cursors: [
        cursor({ consumerId: "distill", ackedSeq: 0, needsFullRebuild: true }),
        cursor({ consumerId: "local-index-fts", ackedSeq: 300 }),
      ],
      staleIds: [],
    })
    expect(statuses.get("distill")?.needsFullRebuild).toBe(true)
    expect(statuses.get("local-index-fts")?.needsFullRebuild).toBe(false)
  })
})

describe("消费者状态：声明部分要一起给（界面靠它解释「要紧吗」）", () => {
  it("★★ `required` 来自声明，不是来自游标", () => {
    /**
     * ★ 判据在**声明**（`ConsumerSpec.required`）而不是游标那一列。
     *
     * 游标里那列是 `register()` 写进去的，而它可能是旧版本写的
     * （比如某个消费者曾经是 required、后来改了）。声明才是当前的意图，
     * 而这个字段决定界面要不要让用户着急（true = 落后时历史不能裁）。
     */
    const statuses = build({
      head: 100,
      domainHeads: {},
      // 故意让游标里的 required 与声明**相反**
      cursors: [
        cursor({ consumerId: "distill", required: false }),
        cursor({ consumerId: "graph-export", required: true }),
      ],
      staleIds: [],
    })
    expect(statuses.get("distill")?.required).toBe(true)
    expect(statuses.get("graph-export")?.required).toBe(false)
  })

  it("★ `domains: null`（消费全部）在视图里是空数组", () => {
    /**
     * 契约里这个字段是数组（zod schema 里没有 null 那一档）。
     * 空数组的含义由界面文案表达（"全部域"），而不是塞一个 null
     * 让每个消费方各判一次。
     */
    const statuses = build({ head: 0, domainHeads: {}, cursors: [], staleIds: [] })
    expect(statuses.get("local-index-fts")?.domains).toEqual([])
    expect(statuses.get("distill")?.domains).toEqual(["chat"])
  })

  it("★★ stale 与 lastError 都摊到每个消费者上", () => {
    const statuses = build({
      head: 100,
      domainHeads: {},
      cursors: [cursor({ consumerId: "distill", ackedSeq: 50, lastError: "限流" })],
      staleIds: ["distill"],
    })
    expect(statuses.get("distill")?.stale).toBe(true)
    expect(statuses.get("distill")?.lastError).toBe("限流")
    expect(statuses.get("local-index-fts")?.stale).toBe(false)
  })

  it("★★★ lag 从**游标**算，不从上一轮结果算", () => {
    /**
     * 进程刚起时 `lastCycle` 是空的，而游标里的进度仍然有效。
     * 若 lag 从上一轮结果取，重启后界面会显示"全部落后 0 条" —— 那是假的。
     */
    const statuses = build({
      head: 1000,
      domainHeads: {},
      cursors: [cursor({ consumerId: "distill", ackedSeq: 400 })],
      staleIds: [],
      // 刚重启：没有上一轮
      lastCycle: [],
    })
    expect(statuses.get("distill")?.lag).toBe(600)
    expect(statuses.get("distill")?.ackedSeq).toBe(400)
  })
})

describe("域状态：「没做」与「做了没数据」必须可区分", () => {
  it("★★★ contact 报 absent + 原因，而不是一个 0", () => {
    /**
     * 显示 `head: 0` 而不说明原因，用户读到的是"通讯录采到了 0 条"
     * （像是坏了）。事实是我们**不采**（PII 类命令不进白名单）。
     */
    const domains = new Map(
      buildDomainStatuses({ domainHeads: { chat: 8000 } }).map((d) => [d.id, d]),
    )
    const contact = domains.get("contact")
    expect(contact?.producedBy).toBe("absent")
    expect(contact?.absentReason).not.toBeNull()
    expect(contact?.head).toBe(0)
  })

  it("★★ active 域没有数据时 head 为 0，且**不带** absentReason", () => {
    /**
     * 这才是"做了没数据"那一档：`minutes` 有生产者，只是这个库里还没有
     * 会议。它与 contact 的区别必须在数据里，而不是靠界面猜。
     */
    const domains = new Map(
      buildDomainStatuses({ domainHeads: { chat: 100 } }).map((d) => [d.id, d]),
    )
    const minutes = domains.get("minutes")
    expect(minutes?.producedBy).toBe("active")
    expect(minutes?.absentReason).toBeNull()
    expect(minutes?.head).toBe(0)
  })

  it("★ 水位按域取，缺的域给 0（不是 undefined）", () => {
    const domains = new Map(
      buildDomainStatuses({ domainHeads: { chat: 8000, doc: 12 } }).map((d) => [d.id, d]),
    )
    expect(domains.get("chat")?.head).toBe(8000)
    expect(domains.get("doc")?.head).toBe(12)
    expect(domains.get("minutes")?.head).toBe(0)
  })

  it("★★ 库里出现一个**没声明**的域时不崩（headByDomain 是宽 Record）", () => {
    /**
     * `knowledge_changelog.domain` 是 TEXT 列，历史库里可能有我们现在
     * 不认识的值。这一层只按声明的域查表，多出来的键被忽略 ——
     * 而不是把类型收窄成 DataDomain 然后在调用处写一次 `as`
     * （那会盖住"库里真有一个没声明的域"这个真实信号）。
     */
    const domains = buildDomainStatuses({ domainHeads: { chat: 1, mystery: 999 } })
    expect(domains.map((d) => d.id)).toEqual(["chat", "minutes", "doc", "contact"])
  })
})
