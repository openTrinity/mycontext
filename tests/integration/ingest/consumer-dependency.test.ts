/**
 * 消费者依赖闸（`dependsOn`）—— **行为**层面，不是源码断言。
 *
 * ## 为什么必须有这个文件
 *
 * `tests/unit/store/attention-scope.test.ts` 里那几条是**源码断言**
 * （"有没有写 dependsOn / 有没有 filter"）。它们锁得住"接线还在"，
 * 但锁不住"闸真的夹住了批次" —— 而本轮我已经被源码断言骗过一次：
 * 断言"路由在投递之前出现"，而把投递改成无条件调用后它照样绿。
 *
 * 所以这里造真的 changelog 行 + 两个真的消费者游标，
 * 断言下游**只处理到上游的位置**。
 */
import { describe, expect, it } from "vitest"
import { ManualClock } from "@mycontext/kernel"
import { ChangelogRepository, ConsumerCursorRepository } from "@mycontext/store"
import { OutboxConsumer } from "@mycontext/ingest"
import { openTestVault } from "../../helpers/vault.js"

const START = Date.parse("2026-08-12T00:00:00.000Z")
const UPSTREAM = "graph-export"
const DOWNSTREAM = "distill"

/** 往 changelog 里塞 n 条（值全是编的）。 */
function seedChangelog(vault: ReturnType<typeof openTestVault>, n: number): void {
  // ★ `append` 收的是**一批**（返回 seq 数组），不是单条
  const entries = Array.from({ length: n }, (_unused, index) => {
    const i = index + 1
    return {
      op: "upsert" as const,
      entityType: "message" as const,
      entityId: `msgFAKE${String(i).padStart(4, "0")}`,
      channelId: "dingtalk",
      domain: "chat" as const,
      occurredAt: START + i * 1000,
      emittedAt: START + i * 1000,
      payloadRef: null,
      digest: `digest-${i}`,
    }
  })
  new ChangelogRepository(vault.db).append(entries)
}

/** 造一个只记「看见了哪些 seq」的下游消费者。 */
function downstream(
  vault: ReturnType<typeof openTestVault>,
  clock: ManualClock,
  seen: number[],
  dependsOn?: readonly string[],
) {
  return new OutboxConsumer({
    db: vault.db,
    clock,
    consumerId: DOWNSTREAM,
    owner: "test",
    handler: (batch) => {
      for (const row of batch) seen.push(row.seq)
      return { processed: batch.length, skipped: 0 }
    },
    ...(dependsOn === undefined ? {} : { dependsOn }),
  })
}

describe("dependsOn：下游不许跑在上游前面", () => {
  it("★★★ 上游只 ack 到 3 → 下游本轮最多处理到 seq 3", async () => {
    /**
     * 这是本文件的核心。蒸馏引用图谱抽出的 fact —— 跑到图谱前面的话，
     * 那段消息的 fact 还不存在，蒸馏照常"成功"而画像里缺了那段知识，
     * 且游标已推过，**永远不会重来**。
     *
     * 反证：把骨架里的 `.filter((row) => ... row.seq <= upstreamLimit)`
     * 删掉 → 这条转红（会看到 seq 4..10）。
     */
    const vault = openTestVault()
    const clock = new ManualClock(START)
    seedChangelog(vault, 10)
    const cursors = new ConsumerCursorRepository(vault.db, clock)
    cursors.register(UPSTREAM, { required: false, minRetainedSeq: 0 })
    cursors.ack(UPSTREAM, 3)

    const seen: number[] = []
    const consumer = downstream(vault, clock, seen, [UPSTREAM])
    consumer.register()
    const report = await consumer.runOnce()

    expect(seen).toEqual([1, 2, 3])
    expect(report.ackedSeq).toBe(3)
    // ★ 必须说清"还在等谁"——否则"没新数据"与"在等图谱"不可区分
    expect(report.waitingForUpstream).toBe(UPSTREAM)
    vault.close()
  })

  it("★★★ 上游推进之后，下游接着往下走（不是永久停住）", async () => {
    const vault = openTestVault()
    const clock = new ManualClock(START)
    seedChangelog(vault, 10)
    const cursors = new ConsumerCursorRepository(vault.db, clock)
    cursors.register(UPSTREAM, { required: false, minRetainedSeq: 0 })
    cursors.ack(UPSTREAM, 3)

    const seen: number[] = []
    const consumer = downstream(vault, clock, seen, [UPSTREAM])
    consumer.register()
    await consumer.runOnce()
    cursors.ack(UPSTREAM, 10)
    const second = await consumer.runOnce()

    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(second.waitingForUpstream).toBeNull()
    vault.close()
  })

  it("★★★ 上游**没注册** → 不夹（否则是一次静默停死）", async () => {
    /**
     * kl 服务没起时 `graph-export` 不存在。夹成 0 会让蒸馏永久停在原地 ——
     * 用户看到"画像一直不更新"，而日志里一个错都没有。
     *
     * 反证：把 `if (upstream === null) continue` 改成 `upstreamLimit = 0`
     * → 这条转红。
     */
    const vault = openTestVault()
    const clock = new ManualClock(START)
    seedChangelog(vault, 5)
    const seen: number[] = []
    const consumer = downstream(vault, clock, seen, ["nobody-registered"])
    consumer.register()
    const report = await consumer.runOnce()
    expect(seen).toEqual([1, 2, 3, 4, 5])
    expect(report.waitingForUpstream).toBeNull()
    vault.close()
  })

  it("★★ 上游 ack 为 0（注册了但没跑过）→ 下游等着，不抢跑", async () => {
    /**
     * 与"没注册"刻意不同：注册了说明那个消费者**存在**，只是还没干活。
     * 此时抢跑就会产生那段缺 fact 的画像。
     */
    const vault = openTestVault()
    const clock = new ManualClock(START)
    seedChangelog(vault, 5)
    new ConsumerCursorRepository(vault.db, clock).register(UPSTREAM, {
      required: false,
      minRetainedSeq: 0,
    })
    const seen: number[] = []
    const consumer = downstream(vault, clock, seen, [UPSTREAM])
    consumer.register()
    const report = await consumer.runOnce()
    expect(seen).toEqual([])
    expect(report.waitingForUpstream).toBe(UPSTREAM)
    vault.close()
  })

  it("★★ 多个上游 → 取**最小**的那个（谁最慢跟谁）", async () => {
    /**
     * 取 max 的话就会跑到较慢的那个上游前面 —— 那个上游的产出同样缺。
     *
     * 反证：把 `upstream.ackedSeq < upstreamLimit` 改成 `>` → 这条转红。
     */
    const vault = openTestVault()
    const clock = new ManualClock(START)
    seedChangelog(vault, 10)
    const cursors = new ConsumerCursorRepository(vault.db, clock)
    for (const [id, seq] of [
      ["up-a", 7],
      ["up-b", 2],
    ] as const) {
      cursors.register(id, { required: false, minRetainedSeq: 0 })
      cursors.ack(id, seq)
    }
    const seen: number[] = []
    const consumer = downstream(vault, clock, seen, ["up-a", "up-b"])
    consumer.register()
    const report = await consumer.runOnce()
    expect(seen).toEqual([1, 2])
    expect(report.waitingForUpstream).toBe("up-b")
    vault.close()
  })

  it("★ 不声明 dependsOn → 行为与之前**完全一致**（不影响别的消费者）", async () => {
    /**
     * FTS 与分身没有上游依赖。这条锁住"加了这个能力不会改动它们的行为" ——
     * 用户明确要求「别影响别的功能」。
     */
    const vault = openTestVault()
    const clock = new ManualClock(START)
    seedChangelog(vault, 6)
    const seen: number[] = []
    const consumer = downstream(vault, clock, seen)
    consumer.register()
    const report = await consumer.runOnce()
    expect(seen).toEqual([1, 2, 3, 4, 5, 6])
    expect(report.waitingForUpstream).toBeNull()
    vault.close()
  })
})
