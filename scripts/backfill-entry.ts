/**
 * 跑一轮**真实回溯**（会真的调 DWS CLI，消耗接口配额）。
 *
 * 与 `replay-raw-entry.ts` 的分工：
 * · 重放 = 验证"解析器能不能正确处理**已有**数据"，零网络；
 * · 本脚本 = 拿回**还没采到**的历史（水位清零后才有意义）。
 *
 * ## 为什么需要它，而不是直接 `pnpm dev`
 *
 * `pnpm dev` 会起 Electron 窗口、等用户登录、走完整 UI 流程 —— 而回溯是
 * 一个**无头**的、可观察的批处理动作。用脚本跑能：
 * ① 在终端看到每轮的推进（几百次 CLI 调用要跑几分钟，看不到进度会以为卡死）；
 * ② 到达终止条件就退出，不用手动关窗口；
 * ③ 把"回溯完成"变成一个可断言的退出码（CI / 验收都能用）。
 *
 * 走的是与生产**完全相同**的 `IngestScheduler` + `normalize` + `persistBatch`，
 * 所以这不是"另一套采集实现"—— 它只是没有 UI 的那一个。
 */
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createDingTalkPlugin } from "@mycontext/channels"
import { ProcessRunner, RuntimeEnv } from "@mycontext/runtime-env"
import {
  createFtsHandler,
  FTS_CONSUMER_ID,
  normalize,
  OutboxConsumer,
  persistBatch,
  IngestScheduler,
  type PullWindow,
} from "@mycontext/ingest"
import {
  FtsIndexRepository,
  openStore,
  SelfIdentityRepository,
  VAULT_MIGRATIONS,
} from "@mycontext/store"

export interface BackfillOptions {
  dbPath?: string | undefined
  /** 最多跑多少轮。每轮 = 一个时间窗（可能翻多页） */
  maxRounds: number
  /**
   * 单页条数（透传给 CLI 的 `--limit`，也是截断检测的基数）。
   *
   * ★ 与"单轮翻页预算"是**两个**不同的量 —— 我第一版把它们混成一个变量，
   * 于是「50 条一页」同时变成「一轮最多 50 页」。而 7 天真实历史远超 50 页
   * （实测每页满 50 条、连续 8 页 hasMore 仍为 true），于是每轮都在预算耗尽时
   * 停在半路、一个窗都没抽干 → `confirmedEnd` 恒为 null → **水位永不前进**。
   * 实测表现：第 3/4/5 轮各 50 页、新增 0 条、水位仍是 0（活锁）。
   */
  pageSize: number
  /**
   * 单轮翻页预算。
   *
   * 大回溯要允许它足够大，否则永远抽不干第一个窗。
   * 生产侧（ingest.service）用 50 是因为那是**增量**采集的常态窗口；
   * 一次性回溯是不同的工作负载，所以这里单独给。
   */
  maxPagesPerRound: number
  onProgress?: ((line: string) => void) | undefined
  /**
   * 应用目录（内含 `dws/` profile）。不传时先按 dbPath 推，推不出再落回
   * MyContextDevelop 的默认位置 —— 跑在 vault 副本上时这一项是必需的。
   */
  appDir?: string | undefined
}

export interface BackfillReport {
  dbPath: string
  rounds: number
  cliCalls: number
  changed: number
  unchanged: number
  watermarkStart: number
  watermarkEnd: number
  counts: Record<string, number>
  conversationsByType: Record<string, number>
  ftsIndexed: number
  selfConfirmed: boolean
}

function findVault(explicit?: string): string {
  if (explicit !== undefined && explicit !== "") return explicit
  const appSupport = join(homedir(), "Library", "Application Support")
  let best = -1
  let picked: string | null = null
  for (const appName of [
    "MyContextDevelop",
    "MyContextDev",
    "MyContext",
    "InklingsDevelop",
    "InklingsDev",
    "Inklings",
  ]) {
    const vaultsDir = join(appSupport, appName, "vaults")
    if (!existsSync(vaultsDir)) continue
    for (const entry of readdirSync(vaultsDir)) {
      const candidate = join(vaultsDir, entry, "core.sqlite")
      if (!existsSync(candidate)) continue
      try {
        const handle = openStore({ path: candidate, migrations: VAULT_MIGRATIONS })
        const row = handle.db
          .prepare<[], { c: number }>("SELECT count(*) AS c FROM raw_records")
          .get()
        handle.close()
        if ((row?.c ?? 0) > best) {
          best = row?.c ?? 0
          picked = candidate
        }
      } catch {
        // 打不开 / 老 schema —— 跳过
      }
    }
  }
  if (picked === null) throw new Error("未找到任何 vault。先登录一次应用，或用 --db 指定。")
  return picked
}

export async function runBackfill(options: BackfillOptions): Promise<BackfillReport> {
  const dbPath = findVault(options.dbPath)
  const handle = openStore({ path: dbPath, migrations: VAULT_MIGRATIONS })
  const db = handle.db
  const log = options.onProgress ?? (() => undefined)

  /**
   * 与生产同一套 runtime：binDir / dwsConfigDir 都指向应用的真实目录，
   * 否则会另起一个 DWS profile（等于未登录）。
   *
   * ## ★ 不能只从 dbPath 推
   *
   * 推导只在"库还在应用目录里"时成立。而排查时**经常跑在 vault 副本上**
   * （拷到 /tmp，避免对着每天在用的库写）—— 那时推出来的 dwsConfigDir
   * 指向 /tmp/dws，是一个全新的未登录 profile，报 `exit 2` /
   * `not_authenticated`，而那个错误看起来像"渠道命令坏了"。
   *
   * 所以允许显式传（`--app-dir`），并在推导失败时落回应用的真实目录。
   */
  const derived = join(dbPath, "..", "..", "..")
  const appDir =
    options.appDir !== undefined && options.appDir !== ""
      ? options.appDir
      : existsSync(join(derived, "dws"))
        ? derived
        : join(homedir(), "Library", "Application Support", "MyContextDevelop")
  const runtime = new RuntimeEnv({
    binDir: join(process.cwd(), "apps/desktop/resources/bin"),
    dwsChannel: process.env["MYCONTEXT_DWS_CHANNEL"] ?? "",
    dwsConfigDir: join(appDir, "dws"),
  })
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string) => log(`  ⚠ ${message}`),
    error: (message: string) => log(`  ✗ ${message}`),
    child: () => logger,
  }
  const processes = new ProcessRunner(logger as never)
  const plugin = createDingTalkPlugin({
    runtime,
    processes,
    logger: logger as never,
    openExternal: () => Promise.resolve(),
  })
  const ingest = plugin.ingest
  if (ingest === undefined) throw new Error("钉钉插件没有 ingest 能力")

  const clock = { now: () => Date.now() }
  const scheduler = new IngestScheduler({
    db,
    clock,
    channelId: "dingtalk",
    pageLimit: options.pageSize,
  })

  const identity = new SelfIdentityRepository(db).get("dingtalk")
  const selfConfirmed = identity?.confirmedAt !== null && identity?.confirmedAt !== undefined
  const selfIds = new Set((identity?.openIds ?? []).map((entry) => entry.value))
  const selfNames = new Set(selfConfirmed ? (identity?.displayNames ?? []) : [])

  const watermarkStart = scheduler.watermark
  const report: BackfillReport = {
    dbPath,
    rounds: 0,
    cliCalls: 0,
    changed: 0,
    unchanged: 0,
    watermarkStart,
    watermarkEnd: watermarkStart,
    counts: {},
    conversationsByType: {},
    ftsIndexed: 0,
    selfConfirmed,
  }

  try {
    for (let round = 0; round < options.maxRounds; round += 1) {
      const rootWindow: PullWindow = scheduler.nextWindow()
      scheduler.beginWindow(rootWindow)
      report.rounds += 1

      const queue: PullWindow[] = [rootWindow]
      let confirmedEnd: number | null = null
      let maxSentAt: number | null = null
      let pages = 0
      let roundChanged = 0

      while (queue.length > 0 && pages < options.maxPagesPerRound) {
        const window = queue.shift() as PullWindow
        let cursor: string | null = null
        let drained = false

        while (pages < options.maxPagesPerRound) {
          const page = await ingest.pull({
            start: window.start,
            end: window.end,
            cursor,
            limit: options.pageSize,
          })
          pages += 1
          report.cliCalls += 1

          const result = persistBatch(
            { db, clock },
            normalize({
              channelId: "dingtalk",
              conversations: page.conversations,
              messages: page.messages,
              rawPayload: page.rawPayload,
              rawResource: "chat.message",
              selfExternalIds: selfIds,
              selfDisplayNames: selfNames,
              selfConfirmed,
              fetchedAt: clock.now(),
            }),
          )
          report.changed += result.changed.length
          report.unchanged += result.unchanged
          roundChanged += result.changed.length
          for (const message of result.changed) {
            if (maxSentAt === null || message.sentAt > maxSentAt) maxSentAt = message.sentAt
          }

          // 与生产同一判据：hasMore 而不是 cursor（见 ingest.service 的注释）
          const split = scheduler.splitIfTruncated(window, {
            itemCount: page.itemCount,
            nextCursor: page.hasMore ? "more" : null,
          })
          if (split !== null) {
            queue.unshift(split[0], split[1])
            break
          }
          if (!page.hasMore) {
            drained = true
            scheduler.advancePage(null)
            break
          }
          cursor = page.nextCursor
          scheduler.advancePage(cursor)
          if (cursor === null) {
            drained = true
            break
          }
        }

        if (drained) confirmedEnd = window.end
        else if (pages >= options.maxPagesPerRound) {
          queue.unshift(window)
          break
        }
      }

      if (queue.length > 0) {
        if (confirmedEnd !== null) {
          scheduler.commitProgress(
            maxSentAt !== null && maxSentAt < confirmedEnd ? maxSentAt : confirmedEnd,
          )
        }
      } else {
        scheduler.commitProgress(maxSentAt ?? rootWindow.end)
      }

      const watermark = scheduler.watermark
      report.watermarkEnd = watermark
      const when = new Date(watermark).toISOString().replace("T", " ").slice(0, 19)
      log(
        `  第 ${report.rounds} 轮：${pages} 页 / 新增 ${roundChanged} 条 → 水位 ${when}` +
          (queue.length > 0 ? `（还有 ${queue.length} 个窗未抽干）` : "（整轮抽干）"),
      )

      // 整轮抽干且水位已追到"现在"附近 → 回溯完成。
      if (queue.length === 0 && watermark >= clock.now() - 60_000) break
    }

    // 建索引：与重放同理，不建的话"数据在库里但搜不到"。
    const consumer = new OutboxConsumer({
      db,
      clock,
      consumerId: FTS_CONSUMER_ID,
      owner: `backfill-${process.pid}`,
      handler: createFtsHandler(db, clock),
      batchSize: 2000,
    })
    for (let round = 0; round < 200; round += 1) {
      const consumed = await consumer.runOnce()
      if (consumed.processed === 0 && consumed.skipped === 0) break
    }
    report.ftsIndexed = new FtsIndexRepository(db).count()

    for (const table of [
      "raw_records",
      "messages",
      "conversations",
      "actors",
      "message_mentions",
      "media_assets",
      "minutes",
      "knowledge_changelog",
    ]) {
      const row = db.prepare<[], { c: number }>(`SELECT count(*) AS c FROM ${table}`).get()
      report.counts[table] = row?.c ?? 0
    }
    for (const row of db
      .prepare<
        [],
        { type: string; c: number }
      >("SELECT type, count(*) AS c FROM conversations GROUP BY type")
      .all()) {
      report.conversationsByType[row.type] = row.c
    }

    return report
  } finally {
    handle.close()
  }
}
