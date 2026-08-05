#!/usr/bin/env node
/**
 * 工具链校验：Node 主版本与本仓库要求一致，避免 native 模块（better-sqlite3）
 * 因 ABI 不匹配在运行期才炸。
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dirname, "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const required = pkg.engines.node
const expectedMajor = 22

const [major, minor] = process.versions.node.split(".").map(Number)
const problems = []

if (major !== expectedMajor) {
  problems.push(`Node 主版本应为 ${expectedMajor}（要求 ${required}），当前 ${process.version}`)
} else if (minor < 17) {
  problems.push(`Node 应 >= 22.17.0（要求 ${required}），当前 ${process.version}`)
}

if (problems.length > 0) {
  console.error("工具链校验未通过：")
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error("\n建议：nvm use（仓库根目录已有 .nvmrc）")
  process.exit(1)
}

console.log(`工具链校验通过：Node ${process.version}`)
