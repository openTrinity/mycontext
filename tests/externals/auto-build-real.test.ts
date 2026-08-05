/**
 * 自动建图在**真实 vault** 上的接线。
 *
 * ## 为什么单测不够
 *
 * `auto-build.test.ts` 那 19 条喂的是手造的输入 —— 它们验的是**判断**。
 * `graph-sync.test.ts` 那 5 条用的是临时空库 —— 验的是**接线**。
 * 但两者都没验：真实 vault 上那两个游标真的存在、真的能推、
 * 真的能被判据读到。而这一整块的价值全在"它在我这台机器上真的会建图"。
 *
 * 这一条在**副本**上跑（`/tmp`），因为它要写游标 —— 绝不能碰真库。
 *
 * ## ★ 没有 vault 时跳过而不是失败
 *
 * 与 `ego-graph-real.test.ts` 同一个思路。但 ABI 不匹配要**抛**：
 * 吞掉它会让用例显示为绿色的 skipped（那正是「门禁跳过比门禁失败更糟」）。
 */
import { copyFileSync, existsSync, mkdtempSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"
import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { ManualClock, type Logger } from "@mycontext/kernel"
import { ChangelogRepository, ConsumerCursorRepository } from "@mycontext/store"
import {
  GraphSyncService,
  GRAPH_SYNC_CONSUMER_ID,
  GRAPH_BUILD_CONSUMER_ID,
  AUTO_BUILD_LAG_THRESHOLD,
} from "@mycontext/knowledge-feed"

/**
 * 开发态 vaults 目录，**含改名前的旧名字**。
 *
 * ★★ 全量 rebrand 之后这里只写新名字，本机改名前跑出来的真实 vault
 * （`InklingsDevelop/vaults`）就找不到了 → `ready` false → 整个 describe
 * 被 `skipIf` 跳过，而 skip 的输出是**绿色的**：真数据断言静默消失，
 * 看起来与全部通过一模一样。旧名字必须留着。
 */
const APP_DIRS = ["MyContextDevelop", "InklingsDevelop"]

function resolveVaults(): string {
  const base = join(homedir(), "Library", "Application Support")
  for (const name of APP_DIRS) {
    const dir = join(base, name, "vaults")
    if (existsSync(dir)) return dir
  }
  return join(base, APP_DIRS[0] ?? "MyContextDevelop", "vaults")
}

const VAULTS = resolveVaults()

/**
 * 找一个有 Outbox 数据的 vault，**复制**到 tmp（这个测试要写游标）。
 *
 * ★ 每次调用都复制一份新的，而不是全部用例共享一份。
 *
 * 共享的后果这一轮真实发生过：第一个用例的 `runOnce()` 把
 * `graph-export` 游标推到了 head，于是后面的用例 lag=0 → 不导出 →
 * 全部走 `if (!result.exported) return` 提前返回，**测试全绿但什么都没验**。
 * 反证时抓到的：把"失败时不推水位"改成"总是推"，那一条照样绿。
 */
function copyVault(): string | null {
  if (!existsSync(VAULTS)) return null
  for (const dir of readdirSync(VAULTS)) {
    const src = join(VAULTS, dir, "core.sqlite")
    if (!existsSync(src)) continue
    try {
      const db = new Database(src, { readonly: true })
      const head = db
        .prepare("SELECT COALESCE(MAX(seq),0) AS c FROM knowledge_changelog")
        .get() as { c: number }
      db.close()
      if (head.c === 0) continue
      const tmp = mkdtempSync(join(tmpdir(), "mycontext-autobuild-"))
      const dst = join(tmp, "core.sqlite")
      copyFileSync(src, dst)
      // WAL 里可能有还没 checkpoint 的数据 —— 一起拷，否则 head 会偏小
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(src + suffix)) copyFileSync(src + suffix, dst + suffix)
      }
      return dst
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes("NODE_MODULE_VERSION") || message.includes("ERR_DLOPEN_FAILED")) {
        throw new Error(
          "better-sqlite3 的 ABI 与当前 Node 不匹配 —— 跑测试前执行 `pnpm native:node`。" +
            "（刻意抛出而不是跳过：吞掉它会让用例显示为绿色的 skipped）",
          { cause: error },
        )
      }
      // 这个 vault 缺表 / 没迁移 —— 换下一个
    }
  }
  return null
}

/** 只用来判断"这台机器有没有 vault"（跳过与否）。 */
const ready = copyVault() !== null

const noop: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noop,
}

const NOW = 1_785_000_000_000

/**
 * 在副本上装一个 GraphSyncService，materialize/trigger 都是假的（只记调用）。
 *
 * ★ 直接 `new Database` 而不走 `openStore`：后者会重跑迁移校验，而真库的
 * `init` 迁移 checksum 与当前源码不一致（上游改过一个已发布的迁移）——
 * 那会让这个测试报一个与它要验的东西完全无关的错。
 * 这里只需要一个能读写 `consumer_cursors` 的连接。
 */
function makeSync(options: { graphExists: boolean; lastBuiltSeq?: number; ok?: boolean }) {
  // ★ 每个用例一份**新**副本（见 copyVault 的注释）
  const fresh = copyVault()
  if (fresh === null) throw new Error("没有可用的 vault 副本")
  const store = { db: new Database(fresh), close: () => store.db.close() }
  const clock = new ManualClock(NOW)
  const calls = { materialize: 0, trigger: 0 }
  const sync = new GraphSyncService({
    db: store.db,
    clock,
    logger: noop,
    materialize: () => {
      calls.materialize += 1
      return { totalMessages: 0, totalMinutes: 0 }
    },
    /**
     * ★ 水位从**游标表**读，不从 `sync.buildWatermark()`。
     *
     * 后者会让 `autoBuild` 的返回类型自引用（`sync` 还在初始化中），
     * TS 报 TS7023/TS7022。而这里要的就是"库里那两个值"——
     * 直接读表更贴近真实语义，也避开了那个循环。
     */
    autoBuild: () => {
      const row = new ConsumerCursorRepository(store.db, clock).get(GRAPH_BUILD_CONSUMER_ID)
      return {
        lastBuiltSeq: options.lastBuiltSeq ?? row?.ackedSeq ?? 0,
        lastBuiltAt: row?.lastSuccessAt ?? null,
        graphExists: options.graphExists,
        enabled: true,
        ready: true,
      }
    },
    triggerIngest: async () => {
      calls.trigger += 1
      return options.ok ?? true
    },
  })
  sync.register()
  return { sync, store, calls, clock }
}

describe.skipIf(!ready)("★ 自动建图在真实 vault 副本上", () => {
  it("★ 两个游标都注册进了真库（没有它们，判据永远读到 0）", () => {
    const { sync, store } = makeSync({ graphExists: true })
    try {
      const cursors = new ConsumerCursorRepository(store.db, new ManualClock(NOW))
      expect(cursors.get(GRAPH_SYNC_CONSUMER_ID)).not.toBeNull()
      expect(cursors.get(GRAPH_BUILD_CONSUMER_ID)).not.toBeNull()
      // 建图水位是新加的 → 在既有 vault 上必然从 0 起（不能借用导出的）
      expect(sync.buildWatermark().seq).toBe(0)
    } finally {
      store.close()
    }
  })

  it("★ 图不存在 → 真的会触发建图（引导跑完要能用，这是那条需求的落点）", async () => {
    const { sync, store, calls } = makeSync({ graphExists: false })
    try {
      // 本机 vault 已经有上万条 Outbox 记录，且 graph-export 游标是既有的 ——
      // 只要还有 lag 就会导出并进入建图判断
      const result = await sync.runOnce()
      /**
       * ★ 必须真的导出了 —— 否则这一条什么都没验。
       *
       * 断言而不是提前 return：本机 vault 一直有 lag（实测 36 与 12），
       * 而"没有 lag"要么是环境变了要么是副本共享了，两种都该让门禁红。
       */
      expect(result.exported).toBe(true)
      expect(calls.trigger).toBe(1)
      expect(result.ingestTriggered).toBe(true)
      expect(result.ingestReason).toBe("first-build")
    } finally {
      store.close()
    }
  })

  it("★ 建成之后水位推到那一轮的 seq，并记下时刻（攒批判据要读它们）", async () => {
    const { sync, store } = makeSync({ graphExists: false })
    try {
      const result = await sync.runOnce()
      expect(result.exported).toBe(true)
      sync.markBuilt(result.ackedSeq)
      const mark = sync.buildWatermark()
      expect(mark.seq).toBe(result.ackedSeq)
      expect(mark.at).toBe(NOW)
    } finally {
      store.close()
    }
  })

  it("★ 图已在 + 刚建完 → 不再触发（这才是省下那两小时的地方）", async () => {
    const { store, calls, sync } = makeSync({ graphExists: true })
    try {
      // 先把建图水位推到当前 head，模拟"刚建完"
      const head = new ChangelogRepository(store.db).head()
      sync.markBuilt(head)
      const result = await sync.runOnce()
      expect(result.exported).toBe(true)
      // 建图一定不该发生
      expect(calls.trigger).toBe(0)
      expect(result.ingestReason).toBe("no-new-data")
    } finally {
      store.close()
    }
  })

  it("★ 攒够阈值才建：差一条不建、到了就建（用真 head 算）", async () => {
    const a = makeSync({ graphExists: true })
    try {
      const head = new ChangelogRepository(a.store.db).head()
      // 差一条
      a.sync.markBuilt(head - AUTO_BUILD_LAG_THRESHOLD + 1)
      const r1 = await a.sync.runOnce()
      expect(r1.exported).toBe(true)
      expect(r1.ingestReason).toBe("below-threshold")
      expect(a.calls.trigger).toBe(0)
    } finally {
      a.store.close()
    }

    const b = makeSync({ graphExists: true })
    try {
      const head = new ChangelogRepository(b.store.db).head()
      b.sync.markBuilt(head - AUTO_BUILD_LAG_THRESHOLD)
      const r2 = await b.sync.runOnce()
      expect(r2.exported).toBe(true)
      expect(r2.ingestReason).toBe("lag-threshold")
      expect(b.calls.trigger).toBe(1)
    } finally {
      b.store.close()
    }
  })

  it("★ 建图失败 → 水位**不**推进（否则那批数据永远进不了图）", async () => {
    const { sync, store, calls } = makeSync({ graphExists: false, ok: false })
    try {
      const result = await sync.runOnce()
      expect(result.exported).toBe(true)
      expect(calls.trigger).toBe(1)
      expect(result.ingestTriggered).toBe(false)
      // ★ 关键：失败之后水位仍是 0
      expect(sync.buildWatermark().seq).toBe(0)
    } finally {
      store.close()
    }
  })
})
