/**
 * Outbox 清理水位与租约抢占。
 *
 * 清理水位不是朴素的 `MIN(acked_seq)` —— 那有两个**对称**的失败模式，
 * 而它们的后果正好相反（静默缺数据 vs 无限增长），所以两边都要测：
 *   · 未注册的消费者：MIN 只在已注册者上取值 → 历史被裁剪 → 它后来注册时
 *     acked_seq=0，于是静默缺数据
 *   · 长期离线的消费者：MIN 永远卡在旧值 → Outbox 无限增长直到撑爆库
 *
 * ★ 全部注入 ManualClock，不用 sleep：7 天心跳与 60s 租约靠 sleep 测不了
 *   （前者压根等不起，后者会让测试变慢且不稳）。
 */
import { describe, expect, it } from "vitest"
import { ManualClock, MS_PER_DAY, MS_PER_MINUTE } from "@mycontext/kernel"
import {
  ChangelogRepository,
  ConsumerCursorRepository,
  LEASE_TTL_MS,
  RetentionRunner,
} from "@mycontext/store"
import { openTestVault } from "../../helpers/vault.js"

const START = 1_700_000_000_000

describe("清理水位", () => {
  it("只统计 required=1 且心跳未超期的消费者", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    const consumers = new ConsumerCursorRepository(vault.db, clock)

    consumers.register("local-index-fts")
    consumers.register("kl-graph")
    // 可选消费者（如裁剪自身）不参与阻塞：它落后不该让 Outbox 长成无界。
    consumers.register("retention", { required: false })

    consumers.ack("local-index-fts", 100)
    consumers.ack("kl-graph", 40)
    consumers.ack("retention", 1)

    // retention 的 acked_seq=1 最小，但它 required=0 → 不参与
    expect(consumers.retainableSeq()).toBe(40)
    vault.close()
  })

  it("心跳超期的消费者被降级且不再阻塞清理（但要能被告警列出）", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    const consumers = new ConsumerCursorRepository(vault.db, clock)

    consumers.register("local-index-fts")
    consumers.register("kl-graph")
    consumers.ack("local-index-fts", 100)
    consumers.ack("kl-graph", 10)

    // 都还活着时，落后的那个确实把水位卡在 10 —— 这是**应该**的：
    // 它只是慢，不是没了，裁掉它没消费的历史就会让它静默缺数据。
    expect(consumers.retainableSeq()).toBe(10)

    // 只有 fts 继续心跳；kl-graph 静默了 8 天（默认阈值 7 天）
    clock.advance(8 * MS_PER_DAY)
    consumers.heartbeat("local-index-fts")

    // 超期本身就让它退出水位计算（规则 1），否则 Outbox 会无限增长。
    expect(consumers.retainableSeq()).toBe(100)

    // 而 staleConsumers 把它列出来供状态页告警 —— 不是静默跳过：
    // 用户需要知道「图谱数据已经不完整了」。
    const stale = consumers.staleConsumers()
    expect(stale.map((c) => c.consumerId)).toEqual(["kl-graph"])

    // 标记后这个判断变成持久事实（不再依赖"此刻算一下心跳"），
    // 并且它恢复上线时会走全量快照而不是从旧游标增量。
    consumers.markNeedsFullRebuild("kl-graph")
    expect(consumers.get("kl-graph")?.needsFullRebuild).toBe(true)
    expect(consumers.get("kl-graph")?.required).toBe(false)
    expect(consumers.retainableSeq()).toBe(100)
    vault.close()
  })

  it("没有任何活跃必需消费者时返回 0（宁可占存储也不静默丢数据）", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    const consumers = new ConsumerCursorRepository(vault.db, clock)
    expect(consumers.retainableSeq()).toBe(0)

    consumers.register("only-optional", { required: false })
    consumers.ack("only-optional", 999)
    expect(consumers.retainableSeq()).toBe(0)
    vault.close()
  })

  it("注册时刻晚于最小保留 seq 的消费者被标 needs_full_rebuild", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    const consumers = new ConsumerCursorRepository(vault.db, clock)

    // 模拟「历史已经被裁掉了」：注册时告知当前最小保留 seq
    const late = consumers.register("kl-graph", { minRetainedSeq: 5_000 })
    expect(late.needsFullRebuild).toBe(true)
    // 它应当走全量快照而不是从 0 增量（后者会得到静默缺数据的索引）
    expect(late.ackedSeq).toBe(0)
    vault.close()
  })

  it("register 幂等：第二次调用不重置已有游标", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    const consumers = new ConsumerCursorRepository(vault.db, clock)
    consumers.register("distill")
    consumers.ack("distill", 77)
    const again = consumers.register("distill")
    expect(again.ackedSeq).toBe(77)
    vault.close()
  })
})

describe("租约抢占", () => {
  it("未过期的租约不能被他人抢占", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    const consumers = new ConsumerCursorRepository(vault.db, clock)
    consumers.register("local-index-fts")

    expect(consumers.acquireLease("local-index-fts", "worker-a")).toBe(true)
    expect(consumers.acquireLease("local-index-fts", "worker-b")).toBe(false)
    // 同一个 owner 重入是允许的（重启后同名进程继续）
    expect(consumers.acquireLease("local-index-fts", "worker-a")).toBe(true)
    vault.close()
  })

  it("租约过期后可被抢占（否则崩溃的进程会让该消费者永久卡死）", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    const consumers = new ConsumerCursorRepository(vault.db, clock)
    consumers.register("local-index-fts")
    consumers.acquireLease("local-index-fts", "worker-a")

    // worker-a 崩了，没有释放租约
    clock.advance(LEASE_TTL_MS + 1)
    expect(consumers.acquireLease("local-index-fts", "worker-b")).toBe(true)
    expect(consumers.get("local-index-fts")?.leaseOwner).toBe("worker-b")
    vault.close()
  })

  it("续租只对持有者有效", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    const consumers = new ConsumerCursorRepository(vault.db, clock)
    consumers.register("local-index-fts")
    consumers.acquireLease("local-index-fts", "worker-a")

    clock.advance(20_000)
    expect(consumers.renewLease("local-index-fts", "worker-a")).toBe(true)
    expect(consumers.renewLease("local-index-fts", "worker-b")).toBe(false)

    // 续租后再等 TTL-1，worker-b 仍抢不到
    clock.advance(LEASE_TTL_MS - 1)
    expect(consumers.acquireLease("local-index-fts", "worker-b")).toBe(false)
    vault.close()
  })

  it("抢占方从 acked_seq 重放（所以消费侧写入必须幂等）", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    const consumers = new ConsumerCursorRepository(vault.db, clock)
    const changelog = new ChangelogRepository(vault.db)

    for (let index = 0; index < 5; index += 1) {
      changelog.append([
        {
          op: "upsert",
          entityType: "message",
          entityId: `m-${index}`,
          channelId: "dingtalk",
          domain: "chat",
          occurredAt: START,
          emittedAt: START,
          digest: `d-${index}`,
        },
      ])
    }

    consumers.register("local-index-fts")
    consumers.acquireLease("local-index-fts", "worker-a")
    consumers.ack("local-index-fts", 2) // 处理到 seq=2 后崩溃

    clock.advance(LEASE_TTL_MS + 1)
    expect(consumers.acquireLease("local-index-fts", "worker-b")).toBe(true)
    const resume = consumers.get("local-index-fts")?.ackedSeq ?? 0
    // 从 2 之后重放，也就是 3/4/5 —— 不是从 0 也不是跳过 3
    expect(changelog.changesSince(resume, 10).map((row) => row.seq)).toEqual([3, 4, 5])
    vault.close()
  })
})

describe("裁剪与告警", () => {
  it("裁剪到活跃消费者水位，并把超期消费者报出来", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    const consumers = new ConsumerCursorRepository(vault.db, clock)
    const changelog = new ChangelogRepository(vault.db)

    for (let index = 0; index < 50; index += 1) {
      changelog.append([
        {
          op: "upsert",
          entityType: "message",
          entityId: `m-${index}`,
          channelId: "dingtalk",
          domain: "chat",
          occurredAt: START,
          emittedAt: START,
          digest: `d-${index}`,
        },
      ])
    }

    consumers.register("local-index-fts")
    consumers.register("kl-graph")
    consumers.ack("local-index-fts", 50)
    consumers.ack("kl-graph", 20)

    clock.advance(8 * MS_PER_DAY)
    consumers.heartbeat("local-index-fts")

    // minChangelogRows 设小一点，否则测试数据量下不会真的裁剪
    const runner = new RetentionRunner(vault.db, clock, { minChangelogRows: 10 })
    const report = runner.run()

    // kl-graph 超期 → 被报出来（状态页要告警，不能静默跳过）
    expect(report.staleConsumers).toEqual(["kl-graph"])
    // 水位推进到 40（head 50 - minRows 10），而不是被 kl-graph 的 20 卡住
    expect(report.prunedChangelog).toBe(40)
    expect(changelog.count()).toBe(10)
    vault.close()
  })

  it("空闲期 WAL checkpoint 可执行（不 checkpoint 的话 WAL 只增不减）", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    const runner = new RetentionRunner(vault.db, clock)
    expect(runner.run({ checkpoint: true }).walCheckpointed).toBe(true)
    vault.close()
  })

  it("payload 满 N 天后被裁剪，但 hash 仍在（幂等不受影响）", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    vault.db
      .prepare(
        `INSERT INTO raw_records
           (id, channel_id, resource, external_id, payload, payload_hash, source, fetched_at)
         VALUES ('old', 'dingtalk', 'chat.message', 'e1', '{"a":1}', 'h1', 'dws-cli', ?)`,
      )
      .run(START)

    clock.advance(31 * MS_PER_DAY)
    const report = new RetentionRunner(vault.db, clock, { payloadRetentionDays: 30 }).run()
    expect(report.prunedPayloads).toBe(1)

    const row = vault.db
      .prepare<
        [],
        { payload: string | null; payload_hash: string; payload_pruned_at: number | null }
      >("SELECT payload, payload_hash, payload_pruned_at FROM raw_records WHERE id = 'old'")
      .get()
    expect(row?.payload).toBeNull()
    // hash 保留：幂等键与「这条我见过」的判断只需要它
    expect(row?.payload_hash).toBe("h1")
    // 让「这行为什么没有原文」可解释，而不是看起来像数据损坏
    expect(row?.payload_pruned_at).not.toBeNull()
    vault.close()
  })

  it("未满保留期的 payload 不被裁剪", () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    vault.db
      .prepare(
        `INSERT INTO raw_records
           (id, channel_id, resource, external_id, payload, payload_hash, source, fetched_at)
         VALUES ('fresh', 'dingtalk', 'chat.message', 'e2', '{"a":1}', 'h2', 'dws-cli', ?)`,
      )
      .run(START)
    clock.advance(29 * MS_PER_DAY + MS_PER_MINUTE)
    expect(new RetentionRunner(vault.db, clock).run().prunedPayloads).toBe(0)
    vault.close()
  })
})
