/**
 * 事务助手。
 *
 * 存在的唯一理由：让「规范表与 Outbox 同事务写入」这条不变式有个明确的落点，
 * 而不是散在各调用点靠自觉。破了它的后果是消费者读到 seq 却查不到实体
 * （先写 Outbox 后崩溃），或永久漏掉变更（先写规范表后崩溃）——
 * 两者都表现为"数据看起来采到了，实际缺一段"，而且没有任何东西会报错。
 */
import Database from "better-sqlite3"
import { AppError } from "@mycontext/kernel"
import type { SqliteDatabase } from "./database.js"

/**
 * 在一个事务里执行 fn；抛错则整体回滚。
 *
 * better-sqlite3 的 `db.transaction()` 已经做了这件事，包一层是为了：
 * ① 统一把非 AppError 收敛成 AppError（否则上层拿到 SqliteError 要各自判断）；
 * ② 有个可搜索的名字 —— `grep withTransaction` 就能列出所有需要原子性的写入点。
 *
 * 嵌套调用是安全的：better-sqlite3 对嵌套事务用 SAVEPOINT。
 */
export function withTransaction<T>(db: SqliteDatabase, fn: () => T): T {
  const run = db.transaction(fn)
  try {
    return run()
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError("DB_UNAVAILABLE", `事务执行失败：${(error as Error).message}`, {
      cause: error,
      messageKey: "errors:db.unavailable",
      messageParams: { detail: (error as Error).message },
    })
  }
}

/**
 * 打开 vault 库的连接（供 ingest 等非 Electron 侧使用）。
 *
 * 与 `openStore` 的区别：这里**不跑迁移**，假定库已由主进程打开过。
 * 用于 worker / 测试里需要第二个只读或写连接的场景。
 */
export function openConnection(path: string, options: { readonly?: boolean } = {}): SqliteDatabase {
  const db = new Database(path, options.readonly === true ? { readonly: true } : {})
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  return db
}
