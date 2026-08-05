/**
 * 测试用的临时 vault 库。
 *
 * 用临时**文件**而不是 `:memory:`：WAL、外键、FTS 虚拟表的行为在内存库上
 * 与真实部署有差异（尤其 WAL 相关的体积统计），而我们有测试在断言这些。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach } from "vitest"
import { openStore, VAULT_MIGRATIONS, type SqliteDatabase } from "@mycontext/store"

export interface TestVault {
  db: SqliteDatabase
  path: string
  close: () => void
}

const openVaults: TestVault[] = []
const tempDirs: string[] = []

export function openTestVault(): TestVault {
  const dir = mkdtempSync(join(tmpdir(), "mycontext-vault-"))
  tempDirs.push(dir)
  const path = join(dir, "core.sqlite")
  const store = openStore({ path, migrations: VAULT_MIGRATIONS })
  const vault: TestVault = {
    db: store.db,
    path,
    close: () => {
      try {
        store.close()
      } catch {
        // 已关闭
      }
    },
  }
  openVaults.push(vault)
  return vault
}

// 兜底清理：测试里忘了 close 也不会泄漏临时目录（也不会让下一个测试拿到脏库）。
afterEach(() => {
  while (openVaults.length > 0) openVaults.pop()?.close()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})
