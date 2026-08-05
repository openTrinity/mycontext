/**
 * 运行状态汇总。
 *
 * 这是本阶段验证基建是否正常的窗口：目录、数据库迁移版本、配置来源。
 * 敏感项由 kernel 的 toConfigView 负责脱敏，本服务不接触明文密钥。
 */
import { app } from "electron"
import { toConfigView, type LoadedConfig } from "@mycontext/kernel"
import type { StatusReport } from "@mycontext/ipc-contract"
import type { AccountRepository, AppliedMigration } from "@mycontext/store"
import type { AppPaths } from "../bootstrap/paths.js"

export interface StatusServiceOptions {
  paths: AppPaths
  config: LoadedConfig
  dotenvLoaded: boolean
  dotenvPath: string | undefined
  migrations: AppliedMigration[]
  accounts: AccountRepository
}

export class StatusService {
  constructor(private readonly options: StatusServiceOptions) {}

  report(): StatusReport {
    const { paths, config, migrations, accounts } = this.options
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? "unknown",
      nodeVersion: process.versions.node,
      platform: `${process.platform}-${process.arch}`,
      packaged: app.isPackaged,
      paths: {
        userData: paths.userData,
        database: paths.controlDatabase,
        vaults: paths.vaultsRoot,
        logs: paths.logs,
      },
      database: {
        appliedVersion: migrations.at(-1)?.version ?? 0,
        migrations,
        accountCount: accounts.count(),
      },
      config: toConfigView(config),
      dotenvLoaded: this.options.dotenvLoaded,
      dotenvPath: this.options.dotenvPath ?? null,
    }
  }
}
