/**
 * 无头自检的实际逻辑（TS，由 scripts/smoke.mjs 用 esbuild 打包后执行）。
 *
 * 验证「配置装载 + 数据库迁移 + 读写持久化 + 密钥脱敏」这条基建链路，
 * 不启动 Electron、不触碰真实用户数据。界面相关验证靠手动启动应用。
 */
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, parseEnvFile, toConfigView } from "@mycontext/kernel"
import { AccountRepository, openStore, SettingsRepository, VaultStore } from "@mycontext/store"

const SECRET = "sk-smoke-should-not-leak"

export function runSmoke(): { ok: true; report: unknown } {
  const workDir = mkdtempSync(join(tmpdir(), "mycontext-smoke-"))
  try {
    // 1. 配置：默认 < .env < 环境变量
    const envFile = join(workDir, ".env")
    writeFileSync(envFile, `MYCONTEXT_LOG_LEVEL=debug\nMYCONTEXT_LLM_API_KEY=${SECRET}\n`)
    const dotenv = parseEnvFile(readFileSync(envFile, "utf8"))
    const config = loadConfig({ dotenv, env: { MYCONTEXT_MODEL_MAIN: "qwen3.7-max" } })

    if (config.values.logLevel !== "debug") throw new Error("配置：.env 未生效")
    if (config.meta.logLevel.source !== "dotenv") throw new Error("配置：.env 来源标记错误")
    if (config.meta.modelMain.source !== "env") throw new Error("配置：环境变量未取得最高优先级")

    const view = toConfigView(config)
    if (JSON.stringify(view).includes(SECRET)) {
      throw new Error("配置：敏感值未脱敏，出现在配置视图中")
    }

    // 2. 控制库：迁移 → 写入 → 重开后仍在
    const dbPath = join(workDir, "control.sqlite")
    const vaultId = randomUUID()
    const store = openStore({ path: dbPath })
    new AccountRepository(store.db).create({
      id: randomUUID(),
      vaultId,
      emailCanonical: "smoke@example.com",
      emailDisplay: "smoke@example.com",
      passwordHash: "hash",
      salt: "salt",
      hashParams: "{}",
      createdAt: new Date().toISOString(),
    })
    new SettingsRepository(store.db).set("smoke", "ok", new Date().toISOString())
    store.close()

    const reopened = openStore({ path: dbPath })
    const accountCount = new AccountRepository(reopened.db).count()
    const setting = new SettingsRepository(reopened.db).get("smoke")
    const migrations = reopened.appliedMigrations
    reopened.close()

    if (accountCount !== 1) throw new Error("控制库：账号未持久化")
    if (setting !== "ok") throw new Error("控制库：设置未持久化")

    // 3. Vault：账号级数据落在独立文件里，且与控制库互不干扰
    const vaults = new VaultStore({ root: join(workDir, "vaults") })
    const vaultSettings = new SettingsRepository(vaults.handle(vaultId).db, "vault_settings")
    vaultSettings.set("onboarding.skippedAt", new Date().toISOString(), new Date().toISOString())
    const vaultVersion = vaults.handle(vaultId).appliedVersion
    vaults.closeAll()

    const vaultsAgain = new VaultStore({ root: join(workDir, "vaults") })
    const restored = new SettingsRepository(vaultsAgain.handle(vaultId).db, "vault_settings").get(
      "onboarding.skippedAt",
    )
    // 另一个 vault 看不到它——隔离由文件系统保证，不靠查询条件。
    const otherVault = new SettingsRepository(
      vaultsAgain.handle("other-vault").db,
      "vault_settings",
    ).get("onboarding.skippedAt")
    vaultsAgain.closeAll()

    if (restored === null) throw new Error("Vault：账号级设置未持久化")
    if (otherVault !== null) throw new Error("Vault：跨 vault 数据可见，隔离失效")

    return {
      ok: true,
      report: {
        control: {
          appliedVersion: migrations.at(-1)?.version ?? 0,
          migrations: migrations.map((item) => `v${item.version} ${item.name}`),
          accountCount,
        },
        vault: { appliedVersion: vaultVersion, isolated: otherVault === null },
        config: view.map((entry) => ({
          key: entry.key,
          source: entry.source,
          value: entry.sensitive ? (entry.configured ? "[configured]" : "[unset]") : entry.value,
        })),
      },
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}
