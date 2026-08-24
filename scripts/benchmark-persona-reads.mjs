#!/usr/bin/env node
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "esbuild"

const root = resolve(import.meta.dirname, "..")
const input = process.env.MYCONTEXT_BENCH_DB?.trim() ?? ""
if (input === "") throw new Error("isolated benchmark database required: set MYCONTEXT_BENCH_DB")
if (!isAbsolute(input)) throw new Error("MYCONTEXT_BENCH_DB must be an absolute path")
const dbPath = realpathSync(input)
const temporaryRoots = [realpathSync(tmpdir()), realpathSync("/tmp")]
const insideTemporaryRoot = temporaryRoots.some((tempRoot) => {
  const pathFromTemp = relative(tempRoot, dbPath)
  return pathFromTemp !== "" && !pathFromTemp.startsWith("..") && !isAbsolute(pathFromTemp)
})
if (!insideTemporaryRoot) {
  throw new Error("benchmark database must be inside the system temporary directory")
}
if (!dirname(dbPath).includes("mycontext")) {
  throw new Error("benchmark database must be inside a mycontext-named temporary directory")
}

const buildDir = mkdtempSync(join(root, "node_modules", ".mycontext-persona-benchmark-"))
const outfile = join(buildDir, "benchmark.cjs")
const alias = Object.fromEntries(
  readdirSync(join(root, "packages")).map((entry) => [
    `@mycontext/${entry}`,
    join(root, "packages", entry, "src/index.ts"),
  ]),
)
try {
  await build({
    entryPoints: [join(root, "scripts/benchmark-persona-reads-entry.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["better-sqlite3", "electron"],
    alias,
    logLevel: "silent",
  })
  const module = await import(pathToFileURL(outfile).href)
  const result = module.benchmarkPersonaReads(dbPath)
  process.stdout.write(`${JSON.stringify(result)}\n`)
} finally {
  rmSync(buildDir, { recursive: true, force: true })
}
