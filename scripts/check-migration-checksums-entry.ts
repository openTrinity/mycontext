/**
 * 迁移 checksum 的不变式核验（供 `scripts/check-migration-checksums.mjs` 调用）。
 *
 * 拆成 `-entry.ts` 而不是把逻辑写在 `.mjs` 里，是为了 **import 真正发布的
 * `schemaChecksum`**。这一点不是洁癖：写这个门禁的过程中，脚本里那份
 * `schemaChecksum` 的复制品与实现漂移过一次（规范化改了之后复制品没跟上，
 * 于是算出的值全不一样，而门禁照样报绿）。门禁拿副本比对 = 门禁在测副本。
 */
import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  type Migration,
  rawChecksum,
  schemaChecksum,
  stripSqlComments,
  VAULT_MIGRATIONS,
} from "@mycontext/store"

export interface HistoryFinding {
  /** SQL 常量名，如 VAULT_0002_RAW_NORMALIZED */
  constName: string
  /** 该常量在全历史里出现过的原文 checksum → 它对应的语义 checksum */
  variants: { raw: string; schema: string }[]
}

export interface LegacyFinding {
  version: number
  name: string
  legacy: string
  /** 在全历史里找到的、产出这个原文 checksum 的那一版的语义 checksum */
  foundSchema: string | null
  currentSchema: string
}

export interface VaultFinding {
  appDir: string
  vaultId: string
  maxVersion: number | null
  drifts: {
    version: number
    name: string
    /** 库里记的那个值（列名是 `checksum`，这里改名以免与"当前算出的"混淆） */
    recorded: string
    /** current = 已是语义 checksum；legacy = 已登记的旧值；unknown = 无法归因 */
    verdict: "current" | "legacy-raw" | "legacy-registered" | "unknown"
  }[]
  /**
   * 这个库属于**另一套迁移清单**（版本号重叠但迁移名对不上）。
   *
   * 原型期留下的库就是这样：它的 v1-v7 与当前的 v1-v7 毫无关系。
   * 对它逐条比对只会产出无从处置的噪音，所以门禁只报告、不失败。
   */
  foreignManifest: boolean
  /** 打不开时的原因；非 null 表示这个库没被检查 */
  unreadable: string | null
}

export interface CheckReport {
  historyBlobCount: number
  constCount: number
  /** 语义有差异的常量 —— 非空 = 有人真的改过已发布迁移的 schema */
  semanticDrift: HistoryFinding[]
  /** 有多个原文变体但语义一致的常量（正常，仅供打印） */
  commentOnlyDrift: HistoryFinding[]
  /** legacyChecksums 登记项的核对结果 */
  legacy: LegacyFinding[]
  /** 剥注释后变空/不含 SQL 关键字的迁移 —— 说明剥注释写坏了 */
  emptyAfterStrip: number[]
  /** 语义 checksum 撞车的迁移对 —— 说明规范化把不同 SQL 折成了同一个 */
  collisions: { a: number; b: number; checksum: string }[]
  vaults: VaultFinding[]
}

export interface CheckOptions {
  repoRoot: string
  /** vault 路径列表；空数组表示本机没有 vault（那半跳过） */
  vaultPaths: { appDir: string; vaultId: string; path: string }[]
  /** 打开 SQLite 的方式由调用方注入（.mjs 侧 require better-sqlite3） */
  openDatabase: (path: string) => {
    all: (sql: string) => { version: number; name: string; checksum: string }[]
    close: () => void
  }
}

/**
 * 从一个 .ts 源文件里抽出所有 `const NAME = \`...\`` 形式的 SQL 常量。
 *
 * 用文本抽取而不是 import：要处理的是**历史 blob**，它们引用的模块路径
 * 早已不存在（文件拆分过），import 不可能成功。而这里只需要字符串内容。
 */
function extractSqlConstants(source: string): Map<string, string> {
  const out = new Map<string, string>()
  const pattern = /(?:export\s+)?const\s+([A-Z0-9_]+)\s*=\s*`([\s\S]*?)`/g
  let match = pattern.exec(source)
  while (match !== null) {
    const [, name, sql] = match
    if (name !== undefined && sql !== undefined) out.set(name, sql)
    match = pattern.exec(source)
  }
  return out
}

/** 全历史里所有版本的迁移源文件 blob。 */
function historyBlobs(repoRoot: string): string[] {
  const listed = execFileSync(
    "git",
    [
      "rev-list",
      "--objects",
      "--all",
      "--",
      "packages/store/src/migrations",
      "packages/store/src/migrations.ts",
    ],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  )
  const blobs = new Set<string>()
  for (const line of listed.trim().split("\n")) {
    const [oid, path] = line.split(" ")
    if (oid !== undefined && path?.endsWith(".ts") === true) blobs.add(oid)
  }
  return [...blobs]
}

/**
 * 批量读 blob 内容。
 *
 * `git cat-file --batch` 一次读完而不是逐个 `git show`：39 个 blob 时后者要
 * fork 39 次进程，在 CI 上是几秒级的差别，而且以后 blob 只会更多。
 */
function readBlobs(repoRoot: string, blobs: string[]): string[] {
  if (blobs.length === 0) return []
  const raw = execFileSync("git", ["cat-file", "--batch"], {
    cwd: repoRoot,
    input: `${blobs.join("\n")}\n`,
    maxBuffer: 512 * 1024 * 1024,
  })
  const out: string[] = []
  let offset = 0
  while (offset < raw.length) {
    const newline = raw.indexOf(0x0a, offset)
    if (newline < 0) break
    const header = raw.toString("utf8", offset, newline).split(" ")
    const size = Number(header[2])
    if (!Number.isFinite(size)) break
    const start = newline + 1
    out.push(raw.toString("utf8", start, start + size))
    // 每条内容后面跟一个换行
    offset = start + size + 1
  }
  return out
}

/** 当前工作树里的 SQL 常量（含未跟踪的新迁移文件）。 */
function worktreeConstants(repoRoot: string): Map<string, string> {
  const out = new Map<string, string>()
  const migrationsFile = join(repoRoot, "packages/store/src/migrations.ts")
  for (const [name, sql] of extractSqlConstants(readFileSync(migrationsFile, "utf8"))) {
    out.set(name, sql)
  }
  const vaultDir = join(repoRoot, "packages/store/src/migrations/vault")
  for (const entry of readdirSync(vaultDir)) {
    if (!entry.endsWith(".ts")) continue
    for (const [name, sql] of extractSqlConstants(readFileSync(join(vaultDir, entry), "utf8"))) {
      out.set(name, sql)
    }
  }
  return out
}

export function runMigrationChecksumCheck(options: CheckOptions): CheckReport {
  const { repoRoot } = options
  const blobs = historyBlobs(repoRoot)
  const sources = readBlobs(repoRoot, blobs)

  const current = worktreeConstants(repoRoot)

  /**
   * 每个常量在全历史里出现过的所有原文变体。
   *
   * ★ 只统计**当前仍存在**的常量：历史上被删掉的常量（原型期的
   * `VAULT_0001_BASELINE` 之类）与当前清单无关，把它们算进来只会得到
   * 一堆无从判定的噪音，而门禁一噪就会被忽略。
   */
  const variants = new Map<string, Map<string, string>>()
  for (const source of sources) {
    for (const [name, sql] of extractSqlConstants(source)) {
      if (!current.has(name)) continue
      let byRaw = variants.get(name)
      if (byRaw === undefined) {
        byRaw = new Map()
        variants.set(name, byRaw)
      }
      byRaw.set(rawChecksum(sql), sql)
    }
  }
  // 工作树当前的那一版也算一个变体（还没提交时它只存在于磁盘上）
  for (const [name, sql] of current) {
    let byRaw = variants.get(name)
    if (byRaw === undefined) {
      byRaw = new Map()
      variants.set(name, byRaw)
    }
    byRaw.set(rawChecksum(sql), sql)
  }

  const semanticDrift: HistoryFinding[] = []
  const commentOnlyDrift: HistoryFinding[] = []
  for (const [constName, byRaw] of [...variants].sort(([a], [b]) => a.localeCompare(b))) {
    if (byRaw.size <= 1) continue
    const rows = [...byRaw].map(([raw, sql]) => ({ raw, schema: schemaChecksum(sql) }))
    const distinct = new Set(rows.map((row) => row.schema))
    if (distinct.size > 1) semanticDrift.push({ constName, variants: rows })
    else commentOnlyDrift.push({ constName, variants: rows })
  }

  // legacyChecksums 逐条核对：必须能在历史里找到产出它的那一版，且语义一致
  const legacy: LegacyFinding[] = []
  for (const migration of VAULT_MIGRATIONS) {
    if (migration.legacyChecksums === undefined) continue
    const currentSchema = schemaChecksum(migration.sql)
    for (const value of migration.legacyChecksums) {
      let foundSchema: string | null = null
      for (const byRaw of variants.values()) {
        const sql = byRaw.get(value)
        if (sql !== undefined) {
          foundSchema = schemaChecksum(sql)
          break
        }
      }
      legacy.push({
        version: migration.version,
        name: migration.name,
        legacy: value,
        foundSchema,
        currentSchema,
      })
    }
  }

  /**
   * 剥注释写坏的两个形态，都**不报错**、只是让校验失效，所以要显式查：
   * · 剥空了（把 SQL 当注释吃掉）；
   * · 不同迁移撞出同一个语义 checksum。
   */
  const emptyAfterStrip: number[] = []
  for (const migration of VAULT_MIGRATIONS) {
    if (!/CREATE|ALTER|UPDATE|INSERT|DELETE/.test(stripSqlComments(migration.sql))) {
      emptyAfterStrip.push(migration.version)
    }
  }
  const collisions: { a: number; b: number; checksum: string }[] = []
  const seen = new Map<string, Migration>()
  for (const migration of VAULT_MIGRATIONS) {
    const value = schemaChecksum(migration.sql)
    const previous = seen.get(value)
    if (previous !== undefined) {
      collisions.push({ a: previous.version, b: migration.version, checksum: value })
    } else {
      seen.set(value, migration)
    }
  }

  // 本机 vault 对账
  const vaults: VaultFinding[] = []
  for (const target of options.vaultPaths) {
    let handle
    try {
      handle = options.openDatabase(target.path)
    } catch (error) {
      vaults.push({
        appDir: target.appDir,
        vaultId: target.vaultId,
        maxVersion: null,
        drifts: [],
        unreadable: error instanceof Error ? error.message.slice(0, 120) : "unknown",
      })
      continue
    }
    let rows: { version: number; name: string; checksum: string }[]
    try {
      rows = handle.all("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
    } catch (error) {
      handle.close()
      vaults.push({
        appDir: target.appDir,
        vaultId: target.vaultId,
        maxVersion: null,
        drifts: [],
        unreadable: error instanceof Error ? error.message.slice(0, 120) : "unknown",
      })
      continue
    }
    handle.close()

    const drifts: VaultFinding["drifts"] = []
    /**
     * ★ 先判断这个库是不是**另一套清单**的产物，再逐条比对。
     *
     * 原型期的库（v1-v7、64 位 checksum、版本名完全不同）在版本号上与当前清单
     * 重叠，逐条比对会得到 7 条「无法归因」—— 而它们指向的不是任何要修的东西：
     * 那个库属于另一套 schema，正确处置是删掉重建，不是往登记表里加东西。
     *
     * 判据用**名字**而不是 checksum 长度：名字对不上说明这根本不是同一条迁移，
     * 而长度只是那批库碰巧的实现细节（它当时没做 slice）。
     */
    const nameMismatch = rows.filter((row) => {
      const migration = VAULT_MIGRATIONS.find((item) => item.version === row.version)
      return migration !== undefined && migration.name !== row.name
    })
    const foreignManifest = nameMismatch.length > 0

    for (const row of rows) {
      const migration = VAULT_MIGRATIONS.find((item) => item.version === row.version)
      // 代码里已经没有这个版本 —— 不是 drift，只是这个库比清单旧/新。
      if (migration === undefined) continue
      if (row.checksum === schemaChecksum(migration.sql)) continue
      const drift = { version: row.version, name: row.name, recorded: row.checksum }
      if (row.checksum === rawChecksum(migration.sql)) {
        drifts.push({ ...drift, verdict: "legacy-raw" })
        continue
      }
      if (migration.legacyChecksums?.includes(row.checksum) === true) {
        drifts.push({ ...drift, verdict: "legacy-registered" })
        continue
      }
      drifts.push({ ...drift, verdict: "unknown" })
    }
    vaults.push({
      appDir: target.appDir,
      vaultId: target.vaultId,
      maxVersion: rows.at(-1)?.version ?? null,
      drifts,
      foreignManifest,
      unreadable: null,
    })
  }

  return {
    historyBlobCount: blobs.length,
    constCount: variants.size,
    semanticDrift,
    commentOnlyDrift,
    legacy,
    emptyAfterStrip,
    collisions,
    vaults,
  }
}
