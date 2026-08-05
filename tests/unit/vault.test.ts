/**
 * Vault 隔离测试。
 *
 * 核心断言只有一条：**不同 vault 的数据互相看不见**。
 * 这是分库取代「给每张表挂 accountId」的全部理由——后者靠每个查询都记得带条件，
 * 漏一处就是跨账号泄漏，而单账号开发环境永远测不出来。
 */
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { SettingsRepository, VaultStore } from "@mycontext/store"

let root: string
let vaults: VaultStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mycontext-vaults-"))
  vaults = new VaultStore({ root })
})

afterEach(() => {
  vaults.closeAll()
  rmSync(root, { recursive: true, force: true })
})

const settingsOf = (vaultId: string) =>
  new SettingsRepository(vaults.handle(vaultId).db, "vault_settings")

describe("按 vault 隔离", () => {
  it("不同 vault 的设置互不可见", () => {
    settingsOf("vault-a").set("onboarding.skippedAt", "2026-07-29T00:00:00Z", "now")

    expect(settingsOf("vault-a").get("onboarding.skippedAt")).toBe("2026-07-29T00:00:00Z")
    // 换一个账号 → 引导状态是空的，因此会重新走引导。这正是期望行为。
    expect(settingsOf("vault-b").get("onboarding.skippedAt")).toBeNull()
  })

  it("每个 vault 是独立文件", () => {
    vaults.handle("vault-a")
    vaults.handle("vault-b")
    expect(existsSync(join(root, "vault-a", "core.sqlite"))).toBe(true)
    expect(existsSync(join(root, "vault-b", "core.sqlite"))).toBe(true)
  })

  it("同一 vaultId 复用同一个句柄（重复打开会各持一份 WAL 状态）", () => {
    expect(vaults.handle("vault-a")).toBe(vaults.handle("vault-a"))
  })
})

describe("迁移", () => {
  it("vault 库只应用 vault 迁移：没有 accounts 表", () => {
    const handle = vaults.handle("vault-a")
    const tables = handle.db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name)

    expect(tables).toContain("vault_settings")
    // accounts / app_settings 属于控制库。出现在这里意味着两套清单串了。
    expect(tables).not.toContain("accounts")
    expect(tables).not.toContain("app_settings")
  })

  it("重新打开已存在的 vault 不重复应用迁移，数据仍在", () => {
    settingsOf("vault-a").set("k", "v", "now")
    const firstVersion = vaults.handle("vault-a").appliedVersion
    vaults.close("vault-a")

    const reopened = vaults.handle("vault-a")
    expect(reopened.appliedVersion).toBe(firstVersion)
    expect(settingsOf("vault-a").get("k")).toBe("v")
  })
})

describe("生命周期", () => {
  it("close 后可以重新打开", () => {
    vaults.handle("vault-a")
    expect(vaults.isOpen("vault-a")).toBe(true)
    vaults.close("vault-a")
    expect(vaults.isOpen("vault-a")).toBe(false)
    expect(() => vaults.handle("vault-a")).not.toThrow()
  })

  it("closeAll 关掉全部（登出时账号级数据不该仍可读）", () => {
    vaults.handle("vault-a")
    vaults.handle("vault-b")
    vaults.closeAll()
    expect(vaults.isOpen("vault-a")).toBe(false)
    expect(vaults.isOpen("vault-b")).toBe(false)
  })

  it("close 一个没打开过的 vault 不报错（登出路径会无条件调用）", () => {
    expect(() => vaults.close("never-opened")).not.toThrow()
  })

  it("destroy 删掉整个目录，含 WAL 残留", () => {
    settingsOf("vault-a").set("k", "v", "now")
    vaults.destroy("vault-a")
    // 目录整体消失：删账号不需要逐表清理，也不会漏下 -wal / -shm。
    expect(existsSync(join(root, "vault-a"))).toBe(false)
  })

  it("destroy 后重建是干净的（不会读到旧数据）", () => {
    settingsOf("vault-a").set("k", "old", "now")
    vaults.destroy("vault-a")
    expect(settingsOf("vault-a").get("k")).toBeNull()
  })
})

describe("蒸馏产物的落点", () => {
  /**
   * ★ 这几条断言防的是一个**已经存在于上游默认值里**的行为：
   * forge 的 `init` 默认把 skill 装进 `~/.claude/skills` 与 `~/.codex/skills`。
   *
   * 对「自己给自己炼画像」那是对的；对本应用是三重错误 ——
   * 那是运行这台机器的人的 agent 配置（应用无权写）、多账号会打在同一路径上
   * 互相覆盖、卸载应用也带不走。所以路径必须由这里给出，而不是让 forge 用默认值。
   */
  it("forge 的工作目录在 vault 目录内", () => {
    // 在**内**而不是并列：删 vault 就该把派生物一起删掉，
    // 「删账号 = 删一个目录」是分库隔离的核心收益。
    expect(vaults.forgeRoot("vault-a").startsWith(vaults.directory("vault-a"))).toBe(true)
  })

  it("skill 包在 userData 里，且不碰任何 agent 配置目录", () => {
    const skillRoot = vaults.skillRoot("vault-a")
    expect(skillRoot.startsWith(root)).toBe(true)
    for (const reserved of [".claude", ".codex", ".cursor"]) {
      expect(skillRoot.includes(reserved), `不得落在 ${reserved} 下`).toBe(false)
    }
  })

  it("不同 vault 的 skill 包互不覆盖", () => {
    // 上游默认值只有一份 `~/.claude/skills/<slug>-persona`，
    // 两个账号会把画像打在同一路径上 —— 而画像错人是不可逆的。
    expect(vaults.skillRoot("vault-a")).not.toBe(vaults.skillRoot("vault-b"))
  })

  it("destroy 会连 forge 的派生物一起删掉", () => {
    // 光断言路径前缀不够：真正要成立的是「删了就没了」。
    const marker = join(vaults.forgeRoot("vault-a"), "database", "persona.db")
    settingsOf("vault-a").set("k", "v", "now") // 建出 vault 目录
    mkdirSync(join(marker, ".."), { recursive: true })
    writeFileSync(marker, "")
    expect(existsSync(marker)).toBe(true)
    vaults.destroy("vault-a")
    expect(existsSync(marker)).toBe(false)
  })
})
