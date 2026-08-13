/**
 * 覆盖面（v27 聊天 / v29 文档）的门禁 —— **五条判据只有一份实现**。
 *
 * ## ★★★ 这个文件存在的理由
 *
 * 两张表形状同构，而它们的读写有五处判据，每一处抄错都是一次**静默的数字
 * 错误**（不报错，只是界面上的数字偏了）：
 *
 * ① `local_count` 累加而非覆盖 —— 一天的数据跨多轮进来；
 * ② `listed_total` 传 null 时**保留**旧值（实时流那条路不走列表）；
 * ③ `drained` 覆盖（它是"这一轮的结论"）；
 * ④ 按天聚合用 `MIN(drained)` 而不是 MAX —— 有一个分区没齐就不算齐；
 * ⑤ `markDaysDrained` 只 UPDATE 不 INSERT —— 不凭空造行。
 *
 * 它们现在在 `CoverageRepositoryBase` 里只有一份，所以**同一组用例
 * 对两张表都跑一遍**：任何一条判据被改坏，两边一起红。
 */
import { describe, expect, it } from "vitest"
import {
  ChatCoverageRepository,
  DocumentCoverageRepository,
  toDayBucket,
  toSpaceKey,
} from "@mycontext/store"
import { openTestVault } from "../../helpers/vault.js"

const CH = "dingtalk"
const DAY = "2026-08-12"
const NOW = 1_785_000_000_000

/**
 * 两张表各造一个"统一接口"的适配器。
 *
 * ★ 用一个共同的形状去驱动两个仓储，而不是把用例写两遍：写两遍的话
 * 一边改了另一边没改就不会有人发现 —— 而那正是这套共用基类要防的事。
 */
const SUBJECTS = [
  {
    name: "chat_coverage（v27）",
    open: (vault: ReturnType<typeof openTestVault>) => {
      const repo = new ChatCoverageRepository(vault.db)
      return {
        bump: (
          partitionId: string,
          delta: number,
          extra: { listedTotal?: number | null; drained?: boolean } = {},
        ) =>
          repo.bump(CH, {
            conversationExternalId: partitionId,
            dayBucket: DAY,
            delta,
            ...extra,
            at: NOW,
          }),
        markDrained: (partitionId: string, drained: boolean) =>
          repo.markDrained(CH, {
            conversationExternalId: partitionId,
            dayBucket: DAY,
            drained,
            at: NOW,
          }),
        days: () => repo.listDays(CH, DAY, DAY),
        summary: () => repo.summarize(CH, DAY, DAY),
        markDaysDrained: () => repo.markDaysDrained(CH, DAY, DAY, NOW),
        rows: (partitionId: string) => repo.listByConversation(CH, partitionId),
      }
    },
  },
  {
    name: "document_coverage（v29）",
    open: (vault: ReturnType<typeof openTestVault>) => {
      const repo = new DocumentCoverageRepository(vault.db)
      return {
        bump: (
          partitionId: string,
          delta: number,
          extra: { listedTotal?: number | null; drained?: boolean } = {},
        ) =>
          repo.bump(CH, {
            spaceExternalId: partitionId,
            dayBucket: DAY,
            delta,
            ...extra,
            at: NOW,
          }),
        markDrained: (partitionId: string, drained: boolean) =>
          repo.markDrained(CH, {
            spaceExternalId: partitionId,
            dayBucket: DAY,
            drained,
            at: NOW,
          }),
        days: () => repo.listDays(CH, DAY, DAY),
        summary: () => repo.summarize(CH, DAY, DAY),
        markDaysDrained: () => repo.markDaysDrained(CH, DAY, DAY, NOW),
        rows: (partitionId: string) => repo.listBySpace(CH, partitionId),
      }
    },
  },
] as const

for (const subject of SUBJECTS) {
  describe(`覆盖面共用判据：${subject.name}`, () => {
    it("★★★ ① local_count **累加**而不是覆盖（一天的数据跨多轮进来）", () => {
      /**
       * 覆盖的后果：一天的数据会跨多轮采进来（回溯翻页 + 实时流），
       * 每轮覆盖会让计数在轮次之间**反复跳回小值** —— 用户看到的是
       * "已采 300 条"下一分钟变成"已采 12 条"。
       */
      const vault = openTestVault()
      const repo = subject.open(vault)
      repo.bump("p1", 10)
      repo.bump("p1", 5)
      expect(repo.rows("p1")[0]?.localCount).toBe(15)
      vault.close()
    })

    it("★★★ ② listedTotal 传 null 时**保留**旧值（实时流不走列表）", () => {
      /**
       * 实时流那条路不走列表，它**不知道**渠道说有多少条。让它把一个已知的
       * 值清成 NULL 就是丢信息 —— 而丢了之后"渠道说有 200 条、我们有 50"
       * 这个对比就再也做不出来了。
       */
      const vault = openTestVault()
      const repo = subject.open(vault)
      repo.bump("p1", 10, { listedTotal: 200 })
      repo.bump("p1", 1) // 不带 listedTotal
      expect(repo.rows("p1")[0]?.listedTotal).toBe(200)
      vault.close()
    })

    it("★★★ ③ drained **覆盖**（它是「这一轮的结论」）", () => {
      /**
       * 上一轮抽干过、这一轮没抽干（比如撞了页数预算）→ 必须显示没抽干。
       * 用 `OR` 保留历史结论的话，一个曾经齐过的分区会永远显示"已采完"，
       * 而它现在正缺数据。
       */
      const vault = openTestVault()
      const repo = subject.open(vault)
      repo.bump("p1", 10, { drained: true })
      expect(repo.rows("p1")[0]?.drained).toBe(true)
      repo.markDrained("p1", false)
      expect(repo.rows("p1")[0]?.drained).toBe(false)
      vault.close()
    })

    it("★★★ ④ 按天聚合用 MIN(drained)：一个分区没齐，这一天就不算齐", () => {
      /**
       * 用 MAX 的后果：91 个会话里 90 个齐了就报"已采完"，
       * 而那正是静默数据缺失的样子 —— 用户以为齐了，于是不再等回溯。
       */
      const vault = openTestVault()
      const repo = subject.open(vault)
      repo.bump("p1", 10, { drained: true })
      repo.bump("p2", 5, { drained: false })
      const [day] = repo.days()
      expect(day?.drained).toBe(false)
      expect(day?.localCount).toBe(15)
      vault.close()
    })

    it("★★★ ⑤ markDaysDrained 只 UPDATE 已有行，**不凭空造行**", () => {
      /**
       * 一天没有任何行时造一行会把"这天没数据"与"这天采完了 0 条"混成同一个
       * 东西 —— 前者是事实、后者是结论。少一行让界面说"没有数据"，
       * 那是诚实的。
       */
      const vault = openTestVault()
      const repo = subject.open(vault)
      // 一行都没有 → 标记应当影响 0 行，且聚合仍然为空
      expect(repo.markDaysDrained()).toBe(0)
      expect(repo.days()).toHaveLength(0)
      // 有行之后才会被标
      repo.bump("p1", 3)
      expect(repo.markDaysDrained()).toBe(1)
      expect(repo.days()[0]?.drained).toBe(true)
      vault.close()
    })

    it("★★ 汇总里**没有**百分比字段（分母拿不到真值）", () => {
      /**
       * 渠道 API 不提供"某分区某天共有多少条"。要百分比就只能编，
       * 而这个项目已经因为编分母吃过一次（仪表盘那句假的「才学了 0.0%」）。
       *
       * 能诚实说的是「已采到 N 条，X 天已采完」。
       */
      const vault = openTestVault()
      const repo = subject.open(vault)
      repo.bump("p1", 7, { drained: true })
      const summary = repo.summary()
      expect(Object.keys(summary).sort()).not.toContain("percent")
      expect(Object.keys(summary).sort()).not.toContain("total")
      expect(summary.localCount).toBe(7)
      expect(summary.drainedDays).toBe(1)
      vault.close()
    })
  })
}

describe("★★ 文档覆盖面：空间键与重建", () => {
  it("★★★ workspace_id 为 null → 空串（默认空间），不是「未知」", () => {
    /**
     * v29 的主键是 `WITHOUT ROWID`，NULL 进不了主键。而"拿不到空间"这件事
     * 的语义就是"默认空间"，不是"未知" —— 后者需要一个我们并不需要的第三态。
     */
    expect(toSpaceKey(null)).toBe("")
    expect(toSpaceKey(undefined)).toBe("")
    expect(toSpaceKey("wikiFAKE01")).toBe("wikiFAKE01")
  })

  it("★★★ rebuildFromDocuments 幂等，且按**更新时间**分桶而不是抓取时间", () => {
    /**
     * ## 为什么必须有重建
     *
     * `bumpSpace()` 只在**新文档写进库**那一刻累加，而文档的守卫条件很严
     * （四列都没变就判重）。所以存量库里 `local_count` 会永远是 0 ——
     * 界面说"这段日期 0 篇"而库里有几百篇。
     *
     * ## 为什么按 updated_at 分桶
     *
     * 与 `toDocumentChangelogEntry` 的 occurredAt 同一个判据。用 fetched_at
     * 会让三个月前改的文档全落到今天，于是"这段日期有多少"永远只有今天
     * 那一格有数 —— 而那个数字看起来完全正常。
     */
    const vault = openTestVault()
    const updatedAt = NOW - 30 * 86_400_000
    vault.db
      .prepare(
        `INSERT INTO documents
           (id, channel_id, external_id, origin, title, workspace_id,
            updated_at, created_at, fetched_at)
         VALUES (?, ?, ?, 'wiki', '设计稿', ?, ?, ?, ?)`,
      )
      .run("doc-1", CH, "docFAKE01", "wikiFAKE01", updatedAt, updatedAt, NOW)

    const repo = new DocumentCoverageRepository(vault.db)
    expect(repo.rebuildFromDocuments(CH, NOW)).toBe(1)
    // ★ 落在**更新时间**那一天，而不是 fetched_at（今天）
    const oldDay = toDayBucket(updatedAt)
    expect(repo.listDays(CH, oldDay, oldDay)[0]?.localCount).toBe(1)
    expect(repo.listDays(CH, toDayBucket(NOW), toDayBucket(NOW))).toHaveLength(0)

    // ★ 幂等：重跑不翻倍（覆盖而不是累加）
    repo.rebuildFromDocuments(CH, NOW)
    expect(repo.listDays(CH, oldDay, oldDay)[0]?.localCount).toBe(1)
    vault.close()
  })

  it("★★ 重建不清掉采集侧记的 listedTotal（那是另一侧的结论）", () => {
    const vault = openTestVault()
    const repo = new DocumentCoverageRepository(vault.db)
    const day = toDayBucket(NOW)
    repo.bump(CH, {
      spaceExternalId: "wikiFAKE01",
      dayBucket: day,
      delta: 0,
      listedTotal: 42,
      at: NOW,
    })
    vault.db
      .prepare(
        `INSERT INTO documents
           (id, channel_id, external_id, origin, title, workspace_id,
            updated_at, created_at, fetched_at)
         VALUES (?, ?, ?, 'wiki', '设计稿', ?, ?, ?, ?)`,
      )
      .run("doc-1", CH, "docFAKE01", "wikiFAKE01", NOW, NOW, NOW)
    repo.rebuildFromDocuments(CH, NOW)
    expect(repo.listBySpace(CH, "wikiFAKE01")[0]?.listedTotal).toBe(42)
    vault.close()
  })
})
