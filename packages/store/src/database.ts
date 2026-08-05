/**
 * 数据库连接与迁移。
 *
 * 设计要点：
 * - WAL：后续需要「我们写 + 其他进程只读」并发，现在就定好
 * - 迁移在单个事务里执行：失败则整体回滚，不留半截 schema
 * - 记录 checksum 并在启动时校验：已应用的迁移被改动会明确报错，
 *   而不是让新旧库悄悄产生结构差异。判据是**剥掉注释后**的 SQL
 *   （见 migration-checksum.ts）—— 改注释两次打挂过开发环境，
 *   而注释不是 schema。
 */
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import Database from "better-sqlite3"
import { AppError, type Logger } from "@mycontext/kernel"
import { rawChecksum, schemaChecksum } from "./migration-checksum.js"
import { MIGRATIONS, type Migration } from "./migrations.js"

export type SqliteDatabase = Database.Database

export interface AppliedMigration {
  version: number
  name: string
  appliedAt: string
}

export interface OpenDatabaseOptions {
  /** 数据库文件路径；":memory:" 用于测试 */
  path: string
  logger?: Logger
  now?: () => Date
  /** 迁移清单。缺省用 control 库的清单，vault 库需显式传 VAULT_MIGRATIONS。 */
  migrations?: readonly Migration[]
}

/**
 * 一条已应用记录与当前代码的关系。
 *
 * `legacy` 与 `mismatch` 的区别是这道校验的**全部意义**所在：
 * 前者已确认只差注释（收敛掉即可），后者是真的 schema drift（必须报错）。
 */
type ChecksumVerdict = "current" | "legacy" | "mismatch"

/**
 * 判定库里记的 checksum 与当前迁移的关系。
 *
 * 三级判据，从便宜到贵：
 *
 * ① `schemaChecksum` —— 新库写入的就是这个值，绝大多数情况在这里返回；
 * ② `rawChecksum`    —— 旧库记的是原文 hash，而原文一字未改（最常见的老库）；
 * ③ `legacyChecksums` —— 原文变过，但变的是注释。**只认显式登记过的值。**
 *
 * ③ 之所以必须是白名单而不是「算不出来就放行」：`rawChecksum` 不可逆，
 * 拿着库里那个值无法反推它当时对应的 schema。没登记 = 无从确认 = 报错。
 */
function verifyChecksum(recorded: string, migration: Migration): ChecksumVerdict {
  if (recorded === schemaChecksum(migration.sql)) return "current"
  if (recorded === rawChecksum(migration.sql)) return "legacy"
  if (migration.legacyChecksums?.includes(recorded) === true) return "legacy"
  return "mismatch"
}

function ensureMigrationTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `)
}

function readApplied(
  db: SqliteDatabase,
): Map<number, { name: string; checksum: string; appliedAt: string }> {
  const rows = db
    .prepare<
      [],
      { version: number; name: string; checksum: string; applied_at: string }
    >("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version")
    .all()
  return new Map(
    rows.map((row) => [
      row.version,
      { name: row.name, checksum: row.checksum, appliedAt: row.applied_at },
    ]),
  )
}

/**
 * 修复 2026-07-31 开发版本短暂写入本地 vault 的迁移编号冲突。
 *
 * 当时 Persona 五个迁移占用了 v11-v15；rebase 到 main 后发现正式 v11
 * 已被 `avatar-miss-reset` 占用，于是 Persona 迁移顺延为 v12-v16。
 *
 * 这里只接受精确形状：库里的 v11-v15 必须逐项等于当前 v12-v16
 * （名称与 SQL checksum 都一致），且尚无 v16。任一项不符都不碰数据，
 * 继续由常规 checksum 校验报错。
 */
function repairLegacyPersonaMigrationNumbers(
  db: SqliteDatabase,
  migrations: readonly Migration[],
  logger?: Logger,
): boolean {
  const currentV11 = migrations.find((migration) => migration.version === 11)
  if (currentV11?.name !== "avatar-miss-reset") return false

  const applied = readApplied(db)
  if (applied.has(16)) return false

  for (let legacyVersion = 11; legacyVersion <= 15; legacyVersion += 1) {
    const legacy = applied.get(legacyVersion)
    const current = migrations.find((migration) => migration.version === legacyVersion + 1)
    if (
      legacy === undefined ||
      current === undefined ||
      legacy.name !== current.name ||
      // 走同一套三级判据：这些库记的是**原文** checksum（它们早于判据变更），
      // 用严格相等会让这条修复路径对所有真实老库都失效 —— 而它存在的理由
      // 恰好就是修那些库。
      verifyChecksum(legacy.checksum, current) === "mismatch"
    ) {
      return false
    }
  }

  db.transaction(() => {
    db.prepare(
      "UPDATE schema_migrations SET version = -version WHERE version BETWEEN 11 AND 15",
    ).run()
    db.prepare(
      "UPDATE schema_migrations SET version = -version + 1 WHERE version BETWEEN -15 AND -11",
    ).run()
  })()
  logger?.warn("legacy persona migration numbers repaired", {
    from: "v11-v15",
    to: "v12-v16",
  })
  return true
}

/**
 * 执行迁移。返回已应用的迁移列表（含本次新增）。
 * 幂等：已应用的迁移会被跳过，重复调用不产生变化。
 */
export function runMigrations(
  db: SqliteDatabase,
  options: { logger?: Logger; now?: () => Date; migrations?: readonly Migration[] } = {},
): AppliedMigration[] {
  const migrations = options.migrations ?? MIGRATIONS
  const now = options.now ?? (() => new Date())
  const logger = options.logger

  ensureMigrationTable(db)
  repairLegacyPersonaMigrationNumbers(db, migrations, logger)
  const applied = readApplied(db)

  // 先校验历史迁移未被篡改，再决定要不要写入。
  const converge: { version: number; name: string; from: string; to: string }[] = []
  for (const migration of migrations) {
    const record = applied.get(migration.version)
    if (record === undefined) continue
    const verdict = verifyChecksum(record.checksum, migration)
    if (verdict === "current") continue
    if (verdict === "legacy") {
      converge.push({
        version: migration.version,
        name: migration.name,
        from: record.checksum,
        to: schemaChecksum(migration.sql),
      })
      continue
    }
    throw new AppError(
      "DB_MIGRATION_FAILED",
      `迁移 ${migration.version}（${migration.name}）的内容与已应用版本不一致：` +
        `已发布的迁移不可修改，请追加新的迁移版本`,
      {
        messageKey: "errors:db.migrationChanged",
        messageParams: { version: migration.version, name: migration.name },
        context: {
          version: migration.version,
          expected: schemaChecksum(migration.sql),
          actual: record.checksum,
        },
      },
    )
  }

  /**
   * 把仅差注释的旧记录收敛到 `schemaChecksum`。
   *
   * ★ 这不是「改库掩盖 drift」—— 能走到这里说明 schema 已被证明相同
   * （`verifyChecksum` 只对显式登记过的旧值返回 legacy）。收敛的目的是
   * 让记录落到当前判据上，否则每次启动都要再查一遍历史变体表；
   * 而真正的 drift 在上面那个 throw 就已经拦住了。
   *
   * 一次事务写完：中途崩溃留下「一半收敛」的库不会有正确性问题
   * （旧值下次仍会被赦免），但没有理由让它发生。
   */
  if (converge.length > 0) {
    const update = db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = ?")
    db.transaction(() => {
      for (const item of converge) update.run(item.to, item.version)
    })()
    logger?.warn("migration checksums converged to schema checksum", {
      // 只记版本与名字：checksum 本身在 context 里没有诊断价值，
      // 而「哪几条被收敛过」是下次排查时真正想知道的。
      migrations: converge.map((item) => `v${item.version} ${item.name}`),
    })
  }

  const pending = migrations.filter((migration) => !applied.has(migration.version))
  if (pending.length === 0) {
    logger?.debug("migrations up to date", { appliedCount: applied.size })
  } else {
    const insert = db.prepare(
      "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    )
    const apply = db.transaction((items: readonly Migration[]) => {
      for (const migration of items) {
        db.exec(migration.sql)
        insert.run(
          migration.version,
          migration.name,
          schemaChecksum(migration.sql),
          now().toISOString(),
        )
      }
    })
    try {
      apply(pending)
    } catch (error) {
      throw new AppError("DB_MIGRATION_FAILED", `数据库迁移失败：${(error as Error).message}`, {
        cause: error,
        messageKey: "errors:db.migrationFailed",
        messageParams: { detail: (error as Error).message },
        context: { pending: pending.map((item) => item.version) },
      })
    }
    logger?.info("migrations applied", { versions: pending.map((item) => item.version) })
  }

  return [...readApplied(db).entries()]
    .map(([version, record]) => ({ version, name: record.name, appliedAt: record.appliedAt }))
    .sort((left, right) => left.version - right.version)
}

export interface StoreHandle {
  db: SqliteDatabase
  appliedMigrations: AppliedMigration[]
  appliedVersion: number
  close(): void
}

export function openStore(options: OpenDatabaseOptions): StoreHandle {
  const { path, logger } = options
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true })
  }

  let db: SqliteDatabase
  try {
    db = new Database(path)
  } catch (error) {
    const detail = (error as Error).message
    /**
     * ABI 不匹配是本地开发最常踩的一类失败：`pnpm test` 会把 better-sqlite3
     * 编译成 Node ABI，之后直接起应用就会 ERR_DLOPEN_FAILED（反之亦然）。
     * 原始报错只说 NODE_MODULE_VERSION 对不上，不告诉你该跑哪个命令，
     * 因此这里补一句可操作的提示。
     */
    const abiMismatch = (error as { code?: string }).code === "ERR_DLOPEN_FAILED"
    throw new AppError(
      "DB_UNAVAILABLE",
      abiMismatch
        ? `无法打开数据库：native 模块 ABI 不匹配。` +
          `跑应用前执行 pnpm native:electron，跑测试前执行 pnpm native:node。原始信息：${detail}`
        : `无法打开数据库：${detail}`,
      {
        cause: error,
        messageKey: "errors:db.unavailable",
        messageParams: { detail },
        context: { path },
      },
    )
  }

  // 内存库不支持 WAL，静默跳过即可。
  if (path !== ":memory:") db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  db.pragma("busy_timeout = 5000")

  const applied = runMigrations(db, {
    ...(logger === undefined ? {} : { logger }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.migrations === undefined ? {} : { migrations: options.migrations }),
  })

  return {
    db,
    appliedMigrations: applied,
    appliedVersion: applied.at(-1)?.version ?? 0,
    close: () => db.close(),
  }
}
