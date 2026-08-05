#!/usr/bin/env node
/**
 * 无头自检入口。
 *
 * 实际逻辑在 smoke-entry.ts（TS，与应用共享同一份包源码）。
 * Node 不能直接执行 TS，这里用仓库已有的 esbuild 打包到临时文件后运行，
 * 不额外引入 tsx / vite-node 这类运行时依赖。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { build } from "esbuild"

const root = resolve(import.meta.dirname, "..")
// 产物必须落在仓库内：external 的 better-sqlite3 要靠 node_modules 解析，
// 放到系统临时目录会解析失败。
const outDir = mkdtempSync(join(root, "node_modules", ".mycontext-smoke-"))
const outFile = join(outDir, "smoke.mjs")

try {
  await build({
    entryPoints: [join(root, "scripts/smoke-entry.ts")],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // native 模块与工作区包：前者必须外置，后者内联进产物。
    external: ["better-sqlite3"],
    alias: {
      "@mycontext/kernel": join(root, "packages/kernel/src/index.ts"),
      "@mycontext/store": join(root, "packages/store/src/index.ts"),
    },
    logLevel: "silent",
  })

  const { runSmoke } = await import(`file://${outFile}`)
  const result = runSmoke()
  console.log(JSON.stringify(result.report, null, 2))
  console.log("\nSMOKE_OK")
} catch (error) {
  console.error("SMOKE_FAILED:", error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
