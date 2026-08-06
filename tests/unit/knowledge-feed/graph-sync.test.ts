/**
 * 图谱同步：Outbox → 重新物化四件套。
 *
 * ## 这一层要测的是"什么时候导出"，不是"导出成什么样"
 *
 * 导出格式由 `export-format.test.ts` 覆盖。这里测的是调度语义：
 * 没有新数据不写盘、有新数据才写、失败时不推游标、并发不重叠。
 *
 * 后两条尤其重要：
 * · **失败时推了游标** = 那批数据永远不进图谱，且没有任何东西报错；
 * · **两轮重叠** = 两个全量导出互相覆盖到半截的 `records.jsonl`，
 *   而 loader 读到坏行只会打个 warning 然后跳过（静默少数据）。
 */
import { describe, expect, it } from "vitest"
import { ManualClock } from "@mycontext/kernel"
import { ChangelogRepository, ConsumerCursorRepository } from "@mycontext/store"
import {
  GraphSyncService,
  GRAPH_SYNC_CONSUMER_ID,
  GRAPH_BUILD_CONSUMER_ID,
  type AutoBuildInput,
} from "@mycontext/knowledge-feed"
import { openTestVault, type TestVault } from "../../helpers/vault.js"

const START = 1_785_000_000_000

/** 往 Outbox 写 n 条变更，返回 head。 */
function appendChanges(vault: TestVault, n: number, from = 1): number {
  const changelog = new ChangelogRepository(vault.db)
  changelog.append(
    Array.from({ length: n }, (_, index) => ({
      op: "upsert" as const,
      entityType: "message" as const,
      entityId: `msg-${from + index}`,
      channelId: "dingtalk",
      domain: "chat" as const,
      occurredAt: START + index,
      emittedAt: START + index,
      digest: `d${from + index}`,
    })),
  )
  return changelog.head()
}

function makeSync(
  vault: TestVault,
  overrides: {
    materialize?: () => { totalMessages: number; totalMinutes: number }
    triggerIngest?: () => Promise<boolean | "cancelled">
    /** 攒批判据。不给 = 每轮都触发（老行为，多数用例走这条） */
    autoBuild?: () => Omit<AutoBuildInput, "ackedSeq" | "now">
  } = {},
) {
  const calls = { materialize: 0, ingest: 0 }
  // 先取出局部常量：在闭包里用 `overrides.triggerIngest!()` 会丢掉窄化
  // （TS 认为属性可能在闭包执行时已变），而 `!` 只是压制报错不是修正。
  const trigger = overrides.triggerIngest
  const sync = new GraphSyncService({
    db: vault.db,
    clock: new ManualClock(START),
    materialize:
      overrides.materialize ??
      (() => {
        calls.materialize += 1
        return { totalMessages: 9, totalMinutes: 1 }
      }),
    ...(trigger === undefined
      ? {}
      : {
          triggerIngest: async () => {
            calls.ingest += 1
            return trigger()
          },
        }),
    ...(overrides.autoBuild === undefined ? {} : { autoBuild: overrides.autoBuild }),
  })
  sync.register()
  return { sync, calls }
}

describe("图谱同步的触发时机", () => {
  it("没有新变更时不导出（空转不写盘）", async () => {
    const vault = openTestVault()
    try {
      const { sync, calls } = makeSync(vault)
      const result = await sync.runOnce()
      expect(result.exported).toBe(false)
      expect(result.lag).toBe(0)
      expect(calls.materialize).toBe(0)
    } finally {
      vault.close()
    }
  })

  it("有新变更时导出一次，并把游标推到 head", async () => {
    const vault = openTestVault()
    try {
      const head = appendChanges(vault, 5)
      const { sync, calls } = makeSync(vault)

      const result = await sync.runOnce()
      expect(result.exported).toBe(true)
      expect(result.ackedSeq).toBe(head)
      expect(calls.materialize).toBe(1)

      const cursor = new ConsumerCursorRepository(vault.db, new ManualClock(START)).get(
        GRAPH_SYNC_CONSUMER_ID,
      )
      expect(cursor?.ackedSeq).toBe(head)
    } finally {
      vault.close()
    }
  })

  it("★ 追上之后再跑不重复导出（否则每个周期都在白写几 MB）", async () => {
    const vault = openTestVault()
    try {
      appendChanges(vault, 3)
      const { sync, calls } = makeSync(vault)
      await sync.runOnce()
      await sync.runOnce()
      await sync.runOnce()
      expect(calls.materialize).toBe(1)
    } finally {
      vault.close()
    }
  })

  it("又有新变更 → 再导出一次", async () => {
    const vault = openTestVault()
    try {
      appendChanges(vault, 2)
      const { sync, calls } = makeSync(vault)
      await sync.runOnce()
      expect(calls.materialize).toBe(1)

      appendChanges(vault, 2, 3)
      const second = await sync.runOnce()
      expect(second.exported).toBe(true)
      expect(calls.materialize).toBe(2)
    } finally {
      vault.close()
    }
  })

  it("lag() 反映落后条数（状态页显示「图谱落后 N 条」）", async () => {
    const vault = openTestVault()
    try {
      const head = appendChanges(vault, 7)
      const { sync } = makeSync(vault)
      expect(sync.lag()).toBe(head)
      await sync.runOnce()
      expect(sync.lag()).toBe(0)
    } finally {
      vault.close()
    }
  })
})

describe("★ 失败与并发", () => {
  it("★★ 导出失败时**不推游标**（否则那批数据永远不进图谱且无人知道）", async () => {
    const vault = openTestVault()
    try {
      const head = appendChanges(vault, 4)
      const { sync } = makeSync(vault, {
        materialize: () => {
          throw new Error("磁盘满了")
        },
      })

      const result = await sync.runOnce()
      expect(result.exported).toBe(false)
      expect(result.error).toContain("磁盘满了")

      // 游标仍是 0 —— 下一轮会重试这批
      const cursor = new ConsumerCursorRepository(vault.db, new ManualClock(START)).get(
        GRAPH_SYNC_CONSUMER_ID,
      )
      expect(cursor?.ackedSeq).toBe(0)
      expect(sync.lag()).toBe(head)
    } finally {
      vault.close()
    }
  })

  it("失败后下一轮能恢复（不是永久卡住）", async () => {
    const vault = openTestVault()
    try {
      appendChanges(vault, 3)
      let shouldFail = true
      let materialized = 0
      const { sync } = makeSync(vault, {
        materialize: () => {
          if (shouldFail) throw new Error("瞬时失败")
          materialized += 1
          return { totalMessages: 3, totalMinutes: 0 }
        },
      })

      expect((await sync.runOnce()).exported).toBe(false)
      shouldFail = false
      expect((await sync.runOnce()).exported).toBe(true)
      expect(materialized).toBe(1)
    } finally {
      vault.close()
    }
  })

  it("★ 两轮并发时第二轮直接返回（不会写出半截的 records.jsonl）", async () => {
    const vault = openTestVault()
    try {
      appendChanges(vault, 3)
      let materialized = 0
      // 显式标注 resolve 的类型：Promise 执行器里的赋值 TS 推不出来，
      // 会把 `release` 收窄成 never（然后 `release?.()` 报"不可调用"）。
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      // materialize 是同步的，所以用 triggerIngest 把这一轮"卡住"，
      // 模拟导出还没结束时第二轮进来。
      const { sync } = makeSync(vault, {
        materialize: () => {
          materialized += 1
          return { totalMessages: 3, totalMinutes: 0 }
        },
        triggerIngest: async () => {
          await gate
          return true
        },
      })

      const first = sync.runOnce()
      const second = await sync.runOnce() // 第一轮还卡在 gate 上
      expect(second.exported).toBe(false)

      release()
      expect((await first).exported).toBe(true)
      expect(materialized).toBe(1)
    } finally {
      vault.close()
    }
  })
})

describe("kl ingest 的触发", () => {
  it("默认不触发（导出与「花钱重建图谱」是两个独立决定）", async () => {
    const vault = openTestVault()
    try {
      appendChanges(vault, 2)
      const { sync } = makeSync(vault)
      const result = await sync.runOnce()
      expect(result.exported).toBe(true)
      expect(result.ingestTriggered).toBe(false)
    } finally {
      vault.close()
    }
  })

  it("注入触发器后会调用，且结果透出", async () => {
    const vault = openTestVault()
    try {
      appendChanges(vault, 2)
      const { sync, calls } = makeSync(vault, { triggerIngest: async () => true })
      const result = await sync.runOnce()
      expect(result.ingestTriggered).toBe(true)
      expect(calls.ingest).toBe(1)
    } finally {
      vault.close()
    }
  })

  it("★ 触发失败不回滚导出（数据已在盘上，手动 kl ingest 仍可用）", async () => {
    const vault = openTestVault()
    try {
      const head = appendChanges(vault, 2)
      const { sync } = makeSync(vault, {
        triggerIngest: async () => {
          throw new Error("kl server 没起")
        },
      })

      const result = await sync.runOnce()
      // 导出成功、游标推进 —— 只是 ingest 没触发
      expect(result.exported).toBe(true)
      expect(result.ackedSeq).toBe(head)
      expect(result.ingestTriggered).toBe(false)
      expect(result.error).toBeNull()
    } finally {
      vault.close()
    }
  })
})

describe("消费者注册语义", () => {
  /**
   * ★ `required: false` 是刻意的 —— 与 FTS 不同。
   *
   * 图谱是**外部**消费者：它落后不该阻止我们裁剪 `raw_records`
   * （那会让本地库无限增长）。图谱要历史时重新全量导出即可，
   * 它不依赖 Outbox 的历史保留。
   */
  it("注册成非必需消费者（不阻塞本地保留策略）", async () => {
    const vault = openTestVault()
    try {
      const { sync } = makeSync(vault)
      void sync
      const cursor = new ConsumerCursorRepository(vault.db, new ManualClock(START)).get(
        GRAPH_SYNC_CONSUMER_ID,
      )
      expect(cursor?.required).toBe(false)
    } finally {
      vault.close()
    }
  })

  it("重复注册幂等（挂载/卸载多次不出错）", () => {
    const vault = openTestVault()
    try {
      const { sync } = makeSync(vault)
      sync.register()
      sync.register()
      const cursors = new ConsumerCursorRepository(vault.db, new ManualClock(START))
        .list()
        .filter((c) => c.consumerId === GRAPH_SYNC_CONSUMER_ID)
      expect(cursors).toHaveLength(1)
    } finally {
      vault.close()
    }
  })
})

/**
 * ★★ 攒批自动建图的**接线**（策略本身在 auto-build.test.ts）。
 *
 * 这里验的是三件只有接起来才成立的事：
 *
 * 1. 判据说"不建"时**真的不调** trigger —— 那是省下 2 小时的地方；
 * 2. 判据每轮都**重新取**（图刚被建好 / kl 变成 building 都要立刻生效）；
 * 3. 建图水位与导出水位是**两个**游标 —— 合并会把"数据准备好了"
 *    记成"图已经建好了"，而那是一个静默的谎。
 */
describe("★★ 攒批自动建图的接线", () => {
  it("判据说不建 → 一次都不调 trigger（但导出照常）", async () => {
    const vault = openTestVault()
    try {
      appendChanges(vault, 5)
      const { sync, calls } = makeSync(vault, {
        triggerIngest: async () => true,
        // 图已在、刚建完、只有 5 条新数据 → below-threshold
        autoBuild: () => ({
          lastBuiltSeq: 0,
          lastBuiltAt: START,
          graphExists: true,
          enabled: true,
          ready: true,
        }),
      })
      const result = await sync.runOnce()
      // 导出必须照常发生 —— 不建图不等于不准备数据
      expect(result.exported).toBe(true)
      expect(calls.materialize).toBe(1)
      // 而建图一次都不该调
      expect(calls.ingest).toBe(0)
      expect(result.ingestTriggered).toBe(false)
      expect(result.ingestReason).toBe("below-threshold")
    } finally {
      vault.close()
    }
  })

  it("★ 图还没建过 → 哪怕只有 5 条也建（引导跑完要能用）", async () => {
    const vault = openTestVault()
    try {
      appendChanges(vault, 5)
      const { sync, calls } = makeSync(vault, {
        triggerIngest: async () => true,
        autoBuild: () => ({
          lastBuiltSeq: 0,
          lastBuiltAt: null,
          graphExists: false,
          enabled: true,
          ready: true,
        }),
      })
      const result = await sync.runOnce()
      expect(calls.ingest).toBe(1)
      expect(result.ingestTriggered).toBe(true)
      expect(result.ingestReason).toBe("first-build")
    } finally {
      vault.close()
    }
  })

  it("★ 判据每轮重新取（第一轮建完，第二轮就该被挡住）", async () => {
    const vault = openTestVault()
    try {
      appendChanges(vault, 5)
      /**
       * 这一条锁的是 `autoBuild` 必须是**函数**而不是值。
       *
       * 传值的话第二轮用的还是第一轮的快照（那时图还不存在）——
       * 于是每来几条新消息就重建一次全图，而那是 50 分钟的向量化。
       */
      let built = false
      const { sync, calls } = makeSync(vault, {
        triggerIngest: async () => {
          built = true
          return true
        },
        autoBuild: () => ({
          lastBuiltSeq: 0,
          lastBuiltAt: START,
          graphExists: built,
          enabled: true,
          ready: true,
        }),
      })
      const first = await sync.runOnce()
      expect(first.ingestTriggered).toBe(true)
      expect(first.ingestReason).toBe("first-build")

      // 再来 5 条 → 图已经在了、离上次不到 24h、远不够 500 条 → 不建
      appendChanges(vault, 5, 6)
      const second = await sync.runOnce()
      expect(second.exported).toBe(true)
      expect(second.ingestReason).toBe("below-threshold")
      expect(calls.ingest).toBe(1)
    } finally {
      vault.close()
    }
  })

  it("★ 建图水位与导出水位是两个游标，且建图那个默认为 0", async () => {
    const vault = openTestVault()
    try {
      const head = appendChanges(vault, 7)
      const { sync } = makeSync(vault)
      await sync.runOnce()
      const cursors = new ConsumerCursorRepository(vault.db, new ManualClock(START))
      // 导出推到了 head
      expect(cursors.get(GRAPH_SYNC_CONSUMER_ID)?.ackedSeq).toBe(head)
      /**
       * ★ 而建图水位仍是 0 —— 导出成功**不等于**图建好了。
       *
       * 合并成一个游标的话这里会是 head，于是下一轮判断"没有新数据"，
       * 图永远不会被建，而所有数字看起来都对。
       */
      expect(cursors.get(GRAPH_BUILD_CONSUMER_ID)?.ackedSeq).toBe(0)
      expect(sync.buildWatermark()).toEqual({ seq: 0, at: null })
    } finally {
      vault.close()
    }
  })

  it("★ markBuilt 之后水位与时刻都记上了（攒批判据要读它们）", async () => {
    const vault = openTestVault()
    try {
      const head = appendChanges(vault, 7)
      const { sync } = makeSync(vault)
      await sync.runOnce()
      sync.markBuilt(head)
      const mark = sync.buildWatermark()
      expect(mark.seq).toBe(head)
      // 时刻必须有 —— max-age 那条判据完全依赖它
      expect(mark.at).toBe(START)
    } finally {
      vault.close()
    }
  })
})

/**
 * ★★ 「被我们自己打断」不算失败。
 *
 * 实测的坏形态（每次退出应用都撞一次）：
 * ```
 * shutdown step started {"step":"klServer"}   ← 我们杀 kl
 * graph build failed {"reason":"建图中断：kl-server 进程已退出"}
 * graph auto build failed {"consecutiveFailures":1,"retryAfterMs":1800000}
 * ```
 * 于是**下次启动后半小时不自动建图**，而这一轮根本没失败。
 *
 * ## 为什么必须测「下一轮的行为」而不只是日志
 *
 * 这条断了**不会报错**，只会让退避静默生效 —— 用户看到的是
 * "图就是不更新"，而日志里那条 warn 长得跟真失败一模一样。
 * 所以断言落在 `ingestReason`：`"backoff"` = 退避生效了，
 * 不是 `"backoff"` = 这一轮没被算成失败。
 */
describe("★★ 建图被主动打断（退出应用 / 停服务）不进退避", () => {
  /** 图已存在 + 攒够阈值 → 每一轮判据都说该建，于是能干净地看出退避有没有生效。 */
  const alwaysBuild = () => ({
    lastBuiltSeq: 0,
    lastBuiltAt: START,
    graphExists: true,
    enabled: true,
    ready: true,
  })

  it('★ 返回 "cancelled" → 不算失败，下一轮照常建', async () => {
    const vault = openTestVault()
    try {
      appendChanges(vault, 600) // 够 500 条阈值 → lag-threshold
      let round = 0
      const { sync, calls } = makeSync(vault, {
        triggerIngest: async () => {
          round += 1
          // 第一轮被打断（模拟退出应用时杀了 kl），第二轮正常建成
          return round === 1 ? "cancelled" : true
        },
        autoBuild: alwaysBuild,
      })

      const first = await sync.runOnce()
      // 被打断 → 没建成（不能宣称建好了）
      expect(first.ingestTriggered).toBe(false)
      expect(first.ingestReason).toBe("lag-threshold")

      // 再来新数据触发下一轮
      appendChanges(vault, 600, 601)
      const second = await sync.runOnce()
      /**
       * ★ 关键断言：第二轮**真的建了**。
       *
       * 如果 `"cancelled"` 被算成失败，这里会是 `"backoff"`（30 分钟内不重试），
       * 而 `calls.ingest` 会停在 1。
       */
      expect(second.ingestReason).toBe("lag-threshold")
      expect(second.ingestTriggered).toBe(true)
      expect(calls.ingest).toBe(2)
    } finally {
      vault.close()
    }
  })

  it("对照：返回 false（真失败）→ 下一轮进退避", async () => {
    const vault = openTestVault()
    try {
      appendChanges(vault, 600)
      const { sync, calls } = makeSync(vault, {
        triggerIngest: async () => false,
        autoBuild: alwaysBuild,
      })

      const first = await sync.runOnce()
      expect(first.ingestTriggered).toBe(false)
      expect(first.ingestReason).toBe("lag-threshold")

      appendChanges(vault, 600, 601)
      const second = await sync.runOnce()
      // 这一条锁住"退避仍然有效" —— 修复不能顺手把真失败的退避也废掉
      expect(second.ingestReason).toBe("backoff")
      expect(calls.ingest).toBe(1)
    } finally {
      vault.close()
    }
  })

  it("★ 打断不清零已有的失败计数（那一轮什么都没验证）", async () => {
    const vault = openTestVault()
    try {
      appendChanges(vault, 600)
      let round = 0
      const { sync } = makeSync(vault, {
        triggerIngest: async () => {
          round += 1
          // 第一轮真失败（比如网关坏了），第二轮被我们打断
          return round === 1 ? false : "cancelled"
        },
        /**
         * 时钟不前进（ManualClock 固定在 START），所以第一轮的失败
         * 会让后面每一轮都落在退避窗口内 —— 除非计数被清零。
         */
        autoBuild: alwaysBuild,
      })

      await sync.runOnce()
      appendChanges(vault, 600, 601)
      // 第二轮已经在退避里，trigger 根本不会被调 —— 这本身就是失败计数还在的证据
      const second = await sync.runOnce()
      expect(second.ingestReason).toBe("backoff")
    } finally {
      vault.close()
    }
  })
})
