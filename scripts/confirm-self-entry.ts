/**
 * 解析并确认本人身份，然后回填 `is_self` 与「@我」。
 *
 * ## 为什么需要这个脚本
 *
 * 身份未确认时，**每一条**消息的 `is_self` 都是 null，而蒸馏守卫会以
 * `identity_unconfirmed` 拒掉全部语料 —— 表现是"蒸馏跑完了，一条结论都没有"，
 * 且不报错。实测这个 vault：9768 条消息全部 `is_self = NULL`，
 * `channel_self_identity` 一行都没有。
 *
 * 后端能力（`resolveSelf` / `confirmSelf`）早就完整实现了，缺的只是
 * **有人去调它**。这个脚本走的是与应用完全相同的那两个方法。
 *
 * ## ★ 歧义时不自动挑一个
 *
 * `resolveSelf` 在同名同姓无法唯一确定时抛 `SELF_IDENTITY_AMBIGUOUS`。
 * 这里**照抛**而不是"挑第一个" —— 身份错了之后画像全错且不可逆
 * （污染后的结论会作为下一轮的基线继续放大）。
 */
import { existsSync } from "node:fs"
import { createDingTalkPlugin } from "@mycontext/channels"
import { createLogger, systemClock } from "@mycontext/kernel"
import { ProcessRunner, RuntimeEnv } from "@mycontext/runtime-env"
import { openStore, SelfIdentityRepository, VAULT_MIGRATIONS } from "@mycontext/store"
import { DataPlaneService } from "../apps/desktop/src/main/services/data-plane.service.js"
import { FeedService } from "../apps/desktop/src/main/services/feed.service.js"

export interface ConfirmSelfReport {
  userId: string
  displayNames: string[]
  openIds: { kind: string; value: string }[]
  corpName: string | null
  /** 解析时按 openId 命中的本人消息数（确认前的估计） */
  matchedBefore: number
  /** 回填了多少条 is_self */
  backfilled: number
  /** 回填了多少条「@我」 */
  mentionsBackfilled: number
  /** 回填后库里 is_self=1 / is_self=0 / null 各多少 */
  after: { self: number; other: number; unknown: number }
  elapsedMs: number
}

export async function runConfirmSelf(options: {
  dbPath: string
  binDir: string
  dwsHome: string
  sharedRoot: string
  now: () => number
}): Promise<ConfirmSelfReport> {
  if (!existsSync(options.dbPath)) throw new Error(`vault 不存在：${options.dbPath}`)

  const logger = createLogger("ConfirmSelf", { level: "warn" })
  const runtime = new RuntimeEnv({ binDir: options.binDir, dwsConfigDir: options.dwsHome })
  const processes = new ProcessRunner(logger)
  const plugin = createDingTalkPlugin({ runtime, processes, logger, openExternal: () => undefined })

  const handle = openStore({ path: options.dbPath, migrations: VAULT_MIGRATIONS })

  /**
   * 走真正的 `DataPlaneService`，不是重写一遍逻辑。
   *
   * 重写的话这个脚本"通了"也不代表应用里那条路通 —— 而应用里那条路
   * 才是用户点按钮时跑的东西。
   */
  const feed = new FeedService({
    clock: systemClock,
    logger,
    sharedRoot: options.sharedRoot,
    embedding: () => ({ baseUrl: "", model: "", dim: 2048 }),
    localEmbedding: { model: "", dim: 1024 },
    llm: () => ({ baseUrl: "", model: "" }),
  })
  const dataPlane = new DataPlaneService({
    clock: systemClock,
    logger,
    plugin,
    feed,
    getWindow: () => null,
  })

  const startedAt = options.now()
  try {
    // attach 会顺带起采集与 Feed；这里只需要它把 db 绑上
    await dataPlane.attach(handle.db, options.dbPath)

    const resolved = await dataPlane.resolveSelf()
    const confirmed = dataPlane.confirmSelf()

    const stored = new SelfIdentityRepository(handle.db).get("dingtalk")
    const counts = handle.db
      .prepare<
        [],
        { is_self: number | null; c: number }
      >("SELECT is_self, count(*) AS c FROM messages GROUP BY is_self")
      .all()

    const after = { self: 0, other: 0, unknown: 0 }
    for (const row of counts) {
      if (row.is_self === null) after.unknown = row.c
      else if (row.is_self === 1) after.self = row.c
      else after.other = row.c
    }

    return {
      userId: resolved.userId,
      displayNames: stored?.displayNames ?? resolved.displayNames,
      openIds: resolved.openIds,
      corpName: resolved.corpName,
      matchedBefore: resolved.matchedMessageCount,
      backfilled: confirmed.backfilled,
      mentionsBackfilled: confirmed.mentionsBackfilled,
      after,
      elapsedMs: options.now() - startedAt,
    }
  } finally {
    await dataPlane.detach()
    handle.close()
  }
}
