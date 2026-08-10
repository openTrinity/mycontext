/**
 * `IngestSnapshot.perChannel[].storage`：存储用量必须**逐渠道**。
 *
 * ## 这一条锁的是一个 300 倍的错数
 *
 * 实测（本机 2026-08-09）：仪表盘/运行状态选着飞书，显示
 * 「库体积 **187.7 MB** · 原生留存 **7,666**」—— 而飞书库真值是
 * **640 KB / 4 条**（那两个数来自主库：192 MB / 7,684）。
 *
 * 成因是 `perChannel` 的字段清单里**没有 storage**，而契约里那段注释写着
 * 「`storage` 是整个 vault 的文件体积，刻意不放」。那句话在"一个 vault
 * 一个库"的时代成立；现在每个非主渠道有自己的 `sources/<id>/core.sqlite`，
 * 而 `collectStorageStats` 拿的正是那个 `IngestService` 自己的 db/dbPath ——
 * 也就是说**真值一直算出来了，只是没往上传**。
 *
 * 渲染层两处都是"逐字段兜底 `row.x ?? raw.x`"（为了防热更错配白屏，那个设计
 * 是对的），于是缺失的字段被静默填成了主渠道的值 —— 比 undefined 更糟：
 * 前者是一个看起来完全正常的错数。
 *
 * ## 判据
 *
 * ① `perChannel` 每一行都带 `storage`（缺一行就会被兜底成别人的数）；
 * ② 两个渠道的 `storage` 互不相同 —— 用**真库**跑，一个塞了数据一个空着。
 *    只断言"字段存在"挡不住"两行都填了主渠道的值"这种形态。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createLogger, systemClock } from "@mycontext/kernel"
import { openStore, VAULT_MIGRATIONS, type StoreHandle } from "@mycontext/store"
import type { ChannelPlugin } from "@mycontext/channels"
import { DataPlaneService } from "@main/services/data-plane.service"
import type { FeedDirs, FeedService } from "@main/services/feed.service"

const logger = createLogger("test-storage-scope", { level: "error" })

let dir: string
let primary: StoreHandle
let source: StoreHandle

/** 只实现 `snapshot()` 这条路上会碰到的东西 —— 采集不真跑（autoStart:false）。 */
function fakePlugin(id: string): ChannelPlugin {
  return {
    meta: { id, name: id, kind: "im" },
    auth: {
      status: () => Promise.resolve({ state: "unauthorized" as const }),
      login: () => Promise.reject(new Error("not used")),
      describeStepKeys: () => [],
    },
    ingest: {
      probe: () => Promise.resolve(null),
      pull: () =>
        Promise.resolve({
          conversations: [],
          messages: [],
          nextCursor: null,
          hasMore: false,
          itemCount: 0,
          rawPayload: "{}",
        }),
    },
  } as unknown as ChannelPlugin
}

function fakeFeed(): FeedService {
  return {
    attach: () => undefined,
    detach: () => undefined,
    export: () => Promise.resolve(null),
    info: () => null,
  } as unknown as FeedService
}

function feedDirs(root: string): FeedDirs {
  return {
    exportRoot: join(root, "exports"),
    klRoot: join(root, "kl"),
    handoffFile: join(root, "handoff.json"),
  } as unknown as FeedDirs
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "storage-scope-"))
  primary = openStore({ path: join(dir, "core.sqlite"), migrations: VAULT_MIGRATIONS })
  source = openStore({ path: join(dir, "feishu.sqlite"), migrations: VAULT_MIGRATIONS })
  /**
   * ★ 让两个库**体积明显不同**：主库塞 300 条 raw_records，渠道库塞 2 条。
   * 「两边都空」的话即使 bug 在也测不出来（0 === 0）。
   */
  const insert = (h: StoreHandle, count: number, prefix: string): void => {
    const stmt = h.db.prepare(
      "INSERT INTO raw_records (id, channel_id, resource, external_id, payload, payload_hash, source, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    for (let i = 0; i < count; i += 1) {
      // 值全是编的（CLAUDE.md §1.2）；payload 撑大一点让体积差出来
      stmt.run(
        `${prefix}-row-${i}`,
        prefix,
        "chat.message",
        `msgFAKE${i}`,
        JSON.stringify({ pad: "x".repeat(512), i }),
        `${prefix}-hash-${i}`,
        "manual",
        i,
      )
    }
  }
  insert(primary, 300, "dingtalk")
  insert(source, 2, "feishu")
})

afterEach(() => {
  primary.close()
  source.close()
  rmSync(dir, { recursive: true, force: true })
})

async function service(): Promise<DataPlaneService> {
  const plane = new DataPlaneService({
    clock: systemClock,
    logger,
    plugin: fakePlugin("dingtalk"),
    feed: fakeFeed(),
    getWindow: () => null,
    autoStart: false,
    sources: () => [{ plugin: fakePlugin("feishu"), feed: fakeFeed() }],
  })
  // ★ attach 是 async —— 不 await 的话 sourceIngest 还没填上就查了快照
  await plane.attach(primary.db, join(dir, "core.sqlite"), feedDirs(dir), [
    {
      channelId: "feishu",
      db: source.db,
      dbPath: join(dir, "feishu.sqlite"),
      feedDirs: feedDirs(join(dir, "feishu")),
    },
  ])
  return plane
}

describe("perChannel 的 storage 是渠道级的", () => {
  it("★★ 每一行都带 storage（缺了会被逐字段兜底填成主渠道的数）", async () => {
    const snap = (await service()).snapshot()
    const rows = snap.perChannel ?? []
    expect(rows.length).toBeGreaterThanOrEqual(2)
    for (const row of rows) {
      expect(row.storage, `${row.channelId} 少了 storage`).toBeDefined()
      expect(typeof row.storage.rawRecords).toBe("number")
      expect(typeof row.storage.mainBytes).toBe("number")
    }
  })

  it("★★ 两个渠道的数不一样（真库：主库 300 条 / 渠道库 2 条）", async () => {
    const rows = (await service()).snapshot().perChannel ?? []
    const ding = rows.find((r) => r.channelId === "dingtalk")
    const feishu = rows.find((r) => r.channelId === "feishu")
    expect(ding).toBeDefined()
    expect(feishu).toBeDefined()

    // ★ 核心判据：各自查自己的库
    expect(ding?.storage.rawRecords).toBe(300)
    expect(feishu?.storage.rawRecords).toBe(2)
    // ★ 反证"两行填了同一个值"这种形态
    expect(feishu?.storage.rawRecords).not.toBe(ding?.storage.rawRecords)
    expect(feishu?.storage.mainBytes).toBeLessThan(ding?.storage.mainBytes ?? 0)
  })
})
