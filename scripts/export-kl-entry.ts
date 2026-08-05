/**
 * 从当前 vault 导出 kl-graph 的标准四件套（TS，与应用共享同一份包源码）。
 *
 * 入口壳 `export-kl.mjs` 用 esbuild 打包后运行（与 smoke/replay 同一套做法）。
 *
 * 为什么要一个脚本：导出平时由应用的 `pipelineExport` IPC 触发，
 * 而联调时需要**不起 Electron**就能产出一份 bundle 喂给他们的 ingest。
 */
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { formatDwsLocalTime } from "@mycontext/channels"
import { ExportMaterializer, type ExportResult } from "@mycontext/knowledge-feed"
import { openStore, VAULT_MIGRATIONS } from "@mycontext/store"

export interface ExportKlOptions {
  dbPath?: string | undefined
  exportDir?: string | undefined
}

export interface ExportKlReport extends ExportResult {
  dbPath: string
  exportDir: string
}

function findVault(explicit?: string): { path: string; appDir: string } {
  if (explicit !== undefined && explicit !== "") {
    return { path: explicit, appDir: join(explicit, "..", "..", "..") }
  }
  const appSupport = join(homedir(), "Library", "Application Support")
  let best = -1
  let picked: { path: string; appDir: string } | null = null
  for (const appName of [
    "MyContextDevelop",
    "MyContextDev",
    "MyContext",
    "InklingsDevelop",
    "InklingsDev",
    "Inklings",
  ]) {
    const appDir = join(appSupport, appName)
    const vaultsDir = join(appDir, "vaults")
    if (!existsSync(vaultsDir)) continue
    for (const entry of readdirSync(vaultsDir)) {
      const candidate = join(vaultsDir, entry, "core.sqlite")
      if (!existsSync(candidate)) continue
      try {
        const handle = openStore({ path: candidate, migrations: VAULT_MIGRATIONS })
        const row = handle.db.prepare<[], { c: number }>("SELECT count(*) AS c FROM messages").get()
        handle.close()
        if ((row?.c ?? 0) > best) {
          best = row?.c ?? 0
          picked = { path: candidate, appDir }
        }
      } catch {
        // 老 schema / 打不开 —— 跳过
      }
    }
  }
  if (picked === null) throw new Error("未找到任何 vault。先登录一次应用，或用 --db 指定。")
  return picked
}

export function runExportKl(options: ExportKlOptions): ExportKlReport {
  const vault = findVault(options.dbPath)
  // 默认落点与应用一致（`<appDir>/shared/exports/dws`），
  // 这样脚本导出的与应用导出的是同一份 —— 不会出现"两份不一致的 bundle"。
  const exportDir = options.exportDir ?? join(vault.appDir, "shared", "exports", "dws")
  const handle = openStore({ path: vault.path, migrations: VAULT_MIGRATIONS })
  try {
    const result = new ExportMaterializer({
      db: handle.db,
      clock: { now: () => Date.now() },
      exportDir,
      formatTime: formatDwsLocalTime,
    }).run()
    return { ...result, dbPath: vault.path, exportDir }
  } finally {
    handle.close()
  }
}
