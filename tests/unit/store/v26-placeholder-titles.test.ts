/**
 * VAULT v26 的门禁：**占位会话名被清成 NULL，真名一个都不许动**。
 *
 * ## 为什么这条迁移需要门禁
 *
 * 它是一条 `UPDATE ... SET title = NULL`，也就是一条**会丢信息**的语句。
 * 判据写宽一格（比如"含『会话』二字就清"）就会误清真实群名，而那不可逆：
 * 能不能把名字拿回来，取决于那个会话这段时间里有没有对端发言。
 *
 * 另一半是它**必须真的生效**：占位留在库里的话，新的解析逻辑（推不出名字时
 * 给 NULL）救不回存量行 —— `COALESCE(excluded.title, conversations.title)`
 * 会保留旧值，而旧值正是占位。于是那些会话永远显示占位。
 *
 * 两个方向都锁：清该清的、留该留的。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { openStore, VAULT_MIGRATIONS, type StoreHandle } from "@mycontext/store"

let dir: string
let store: StoreHandle

/** 那个确切的占位串 —— 迁移只认它。 */
const PLACEHOLDER = "飞书会话"

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mycontext-v25-"))
  store = openStore({ path: join(dir, "vault.sqlite"), migrations: VAULT_MIGRATIONS })
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

/** 直接插一行会话（绕过 repository —— 这里测的是迁移，不是写入口）。 */
function insert(externalId: string, title: string | null): void {
  store.db
    .prepare(
      `INSERT INTO conversations
         (id, channel_id, external_id, type, title, member_count,
          is_self_involved, is_bot_channel, last_message_at, created_at)
       VALUES (?, 'feishu', ?, 'direct', ?, NULL, 1, 0, NULL, 0)`,
    )
    .run(`conv-${externalId}`, externalId, title)
}

function titleOf(externalId: string): string | null {
  return (
    store.db
      .prepare<[string], { title: string | null }>(
        "SELECT title FROM conversations WHERE external_id = ?",
      )
      .get(externalId)?.title ?? null
  )
}

describe("★★ VAULT v25：清占位会话名", () => {
  /**
   * ★ 迁移是在**建库时**跑的，所以这里要手动再执行一次它的语句 ——
   * 上面 `beforeEach` 建库时表还是空的。
   *
   * 拿迁移清单里那条**真实的 SQL**跑（而不是在测试里另写一遍）：
   * 抄一遍的话两边会慢慢分叉，而分叉的那一头就是没被测到的判据。
   */
  function runV25(): void {
    const migration = VAULT_MIGRATIONS.find((item) => item.version === 26)
    expect(migration, "v25 迁移不在清单里").toBeDefined()
    store.db.exec(migration?.sql ?? "")
  }

  it("★★ 占位被清成 NULL（否则新解析逻辑救不回存量行）", () => {
    insert("oc_placeholder", PLACEHOLDER)
    runV25()
    expect(titleOf("oc_placeholder")).toBeNull()
  })

  /**
   * ★★★ 真名一个都不许动 —— 包括**含「会话」二字**的真名。
   *
   * 这条是判据宽窄的分界线：模糊匹配（`LIKE '%会话%'`）会把它误清，
   * 而那是不可逆的信息丢失。
   */
  it("★★★ 含「会话」二字的真实群名不许被清", () => {
    insert("oc_real_1", "项目会话组")
    insert("oc_real_2", "会话")
    insert("oc_real_3", "飞书会话组")
    runV25()
    expect(titleOf("oc_real_1")).toBe("项目会话组")
    expect(titleOf("oc_real_2")).toBe("会话")
    // ★ 前缀恰好是占位串，但它是个不同的名字 —— 全等判据才不会误伤
    expect(titleOf("oc_real_3")).toBe("飞书会话组")
  })

  it("已经是 NULL 的行不受影响（幂等）", () => {
    insert("oc_null", null)
    runV25()
    runV25()
    expect(titleOf("oc_null")).toBeNull()
  })

  it("跑两遍结果一样（迁移要幂等 —— 修复重跑时不能出第二种结果）", () => {
    insert("oc_a", PLACEHOLDER)
    insert("oc_b", "真名")
    runV25()
    runV25()
    expect(titleOf("oc_a")).toBeNull()
    expect(titleOf("oc_b")).toBe("真名")
  })
})
