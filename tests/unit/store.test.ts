import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import {
  AccountRepository,
  CONTROL_MIGRATIONS,
  openStore,
  runMigrations,
  SettingsRepository,
} from "@mycontext/store"
import type { Migration } from "@mycontext/store"

const tempDirs: string[] = []

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "mycontext-test-"))
  tempDirs.push(dir)
  return join(dir, "mycontext.db")
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe("迁移 runner", () => {
  it("首次打开即应用全部迁移并建好表", () => {
    const store = openStore({ path: tempDbPath() })
    // 断言「已应用的版本集合 == 清单的版本集合」，而不是「等于清单条数」。
    //
    // appliedVersion 的实现是「最后一条已应用迁移的 version」（database.ts），
    // 不是"条数"。这两者只在版本号从 1 开始连续无空洞时偶然相等 ——
    // 任何一次编号调整（分批发布、撤回一个版本）都会让这条断言假红/假绿。
    // 集合比对对乱序与空洞都成立。
    expect(store.appliedMigrations.map((item) => item.version)).toEqual(
      CONTROL_MIGRATIONS.map((item) => item.version),
    )
    expect(store.appliedVersion).toBe(CONTROL_MIGRATIONS.at(-1)?.version ?? 0)
    expect(store.appliedMigrations.map((item) => item.name)).toContain("init")

    const tables = store.db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name)
    expect(tables).toContain("accounts")
    expect(tables).toContain("app_settings")
    expect(tables).toContain("schema_migrations")
    store.close()
  })

  it("重复执行幂等：不重复应用、记录不增加", () => {
    const path = tempDbPath()
    const first = openStore({ path })
    const firstCount = first.appliedMigrations.length
    first.close()

    const second = openStore({ path })
    expect(second.appliedMigrations.length).toBe(firstCount)
    expect(second.appliedVersion).toBe(CONTROL_MIGRATIONS.at(-1)?.version ?? 0)
    second.close()
  })

  it("已应用的迁移被改动时明确报错，而不是静默产生结构差异", () => {
    const path = tempDbPath()
    const original: Migration[] = [{ version: 1, name: "init", sql: "CREATE TABLE a(x);" }]
    const db = new Database(path)
    runMigrations(db, { migrations: original })

    const tampered: Migration[] = [{ version: 1, name: "init", sql: "CREATE TABLE a(x, y);" }]
    expect(() => runMigrations(db, { migrations: tampered })).toThrow(/已发布的迁移不可修改/)
    db.close()
  })

  it("迁移执行失败时整体回滚，不留半截 schema", () => {
    const db = new Database(":memory:")
    const migrations: Migration[] = [
      { version: 1, name: "ok", sql: "CREATE TABLE good(x);" },
      { version: 2, name: "broken", sql: "THIS IS NOT SQL;" },
    ]
    expect(() => runMigrations(db, { migrations })).toThrow(/数据库迁移失败/)

    // 第一个迁移与它的 schema_migrations 记录都应随事务回滚。
    const tables = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name)
    expect(tables).not.toContain("good")
    db.close()
  })

  it("追加新迁移只应用增量部分", () => {
    const db = new Database(":memory:")
    runMigrations(db, { migrations: [{ version: 1, name: "one", sql: "CREATE TABLE t1(x);" }] })
    const applied = runMigrations(db, {
      migrations: [
        { version: 1, name: "one", sql: "CREATE TABLE t1(x);" },
        { version: 2, name: "two", sql: "CREATE TABLE t2(x);" },
      ],
    })
    expect(applied.map((item) => item.version)).toEqual([1, 2])
    db.close()
  })
})

describe("仓储", () => {
  it("账号可写入、按邮箱查回、并记录登录时间", () => {
    const store = openStore({ path: tempDbPath() })
    const accounts = new AccountRepository(store.db)

    expect(accounts.count()).toBe(0)
    accounts.create({
      id: "id-1",
      vaultId: "vault-1",
      emailCanonical: "user@example.com",
      emailDisplay: "User@example.com",
      passwordHash: "hash",
      salt: "salt",
      hashParams: "{}",
      createdAt: "2026-07-28T00:00:00.000Z",
    })

    expect(accounts.count()).toBe(1)
    const found = accounts.findByEmail("user@example.com")
    expect(found?.emailDisplay).toBe("User@example.com")
    expect(found?.lastLoginAt).toBeNull()

    accounts.markLogin("id-1", "2026-07-28T01:00:00.000Z")
    expect(accounts.findByEmail("user@example.com")?.lastLoginAt).toBe("2026-07-28T01:00:00.000Z")
    expect(accounts.findByEmail("missing@example.com")).toBeNull()
    store.close()
  })

  it("邮箱唯一约束阻止重复写入", () => {
    const store = openStore({ path: tempDbPath() })
    const accounts = new AccountRepository(store.db)
    const input = {
      id: "id-1",
      vaultId: "vault-1",
      emailCanonical: "dup@example.com",
      emailDisplay: "dup@example.com",
      passwordHash: "h",
      salt: "s",
      hashParams: "{}",
      createdAt: "2026-07-28T00:00:00.000Z",
    }
    accounts.create(input)
    expect(() => accounts.create({ ...input, id: "id-2", vaultId: "vault-2" })).toThrow()
    store.close()
  })

  it("设置项可写入并覆盖", () => {
    const store = openStore({ path: tempDbPath() })
    const settings = new SettingsRepository(store.db)

    expect(settings.get("theme")).toBeNull()
    settings.set("theme", "dark", "2026-07-28T00:00:00.000Z")
    expect(settings.get("theme")).toBe("dark")
    settings.set("theme", "light", "2026-07-28T01:00:00.000Z")
    expect(settings.get("theme")).toBe("light")
    store.close()
  })

  it("数据在重新打开后仍然存在", () => {
    const path = tempDbPath()
    const first = openStore({ path })
    new SettingsRepository(first.db).set("k", "v", "2026-07-28T00:00:00.000Z")
    first.close()

    const second = openStore({ path })
    expect(new SettingsRepository(second.db).get("k")).toBe("v")
    second.close()
  })
})

/**
 * 升级路径：v1 建的库（没有 vault_id）必须能升到 v2 并被回填。
 *
 * 这条覆盖的是「打包态已有用户数据」的情况——加列本身不难，
 * 难的是忘了回填：vault_id 为空的账号登录后会去开一个名为 "" 的 vault。
 */
describe("control 库 v1 → v2 升级", () => {
  it("已有账号被回填 vault_id，且唯一索引生效", () => {
    const path = tempDbPath()
    const v1 = CONTROL_MIGRATIONS.filter((migration) => migration.version === 1)

    // 先只跑 v1，模拟旧版本装出来的库
    const old = new Database(path)
    runMigrations(old, { migrations: v1 })
    old
      .prepare(
        `INSERT INTO accounts
           (id, email_canonical, email_display, password_hash, salt, hash_params, created_at)
         VALUES ('legacy', 'old@example.com', 'old@example.com', 'h', 's', '{}', '2026-01-01')`,
      )
      .run()
    old.close()

    // 再用完整清单打开，应该自动补上 v2
    const store = openStore({ path })
    expect(store.appliedVersion).toBe(CONTROL_MIGRATIONS.at(-1)?.version ?? 0)

    const account = new AccountRepository(store.db).findById("legacy")
    expect(account).not.toBeNull()
    // 回填用 id 本身：只要非空且稳定即可，不能留空字符串。
    expect(account?.vaultId).toBe("legacy")

    // 唯一索引：两个账号不能共用一个 vault
    expect(() =>
      store.db
        .prepare(
          `INSERT INTO accounts
             (id, vault_id, email_canonical, email_display, password_hash, salt, hash_params, created_at)
           VALUES ('other', 'legacy', 'other@example.com', 'o', 'h', 's', '{}', '2026-01-01')`,
        )
        .run(),
    ).toThrow()
    store.close()
  })
})
