#!/usr/bin/env node
/**
 * 商标扫描：本仓库不得出现第三方产品商标字样。
 *
 * 参考仓库（架构与工程做法）可以在方案文档里以「参考来源」被提及，
 * 因此 docs/plan 与 docs/design 下的 Markdown 允许命中，其余一律失败。
 */
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"

const root = join(import.meta.dirname, "..")
// 模式按片段拼装：否则本文件自身会命中自己的规则。
const FORBIDDEN = new RegExp(["q" + "oder", "q" + "wenwork", "q" + "wen-work"].join("|"), "i")
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "release",
  "coverage",
  ".tsbuild",
  // 本机 agent 工具与会话附件：已 gitignore、不入库，且 `.claude/skills/find-skills`
  // 是指向仓库外的软链，statSync 跟进去会 ENOENT 崩掉整个门禁。
  ".claude",
  ".agents",
  ".hitg_attachments",
])
/**
 * 预置的第三方可执行文件与他人仓库副本。
 *
 * 其内部字符串不受我们控制（改不了），扫描只会产生噪音。
 * 按相对路径而不是目录名跳过——将来若有 packages/*\/bin/cli.mjs 这类
 * 我们自己写的脚本，仍然要被扫到。
 */
const SKIP_PATHS = [
  join("apps", "desktop", "resources", "bin"),
  join("vendor", "dws"),
  join("kl-graph"),
]
// 方案/设计文档可以引用参考仓库名；对接文档几乎必然提到第三方产品名。
const ALLOWED_PREFIXES = [join("docs", "plan"), join("docs", "design"), join("docs", "handoff")]
/**
 * 可扫描的文本扩展名。
 *
 * 含 py/toml/cfg/in：算法团队的仓库是 Python 项目，
 * 不加这几个等于给算法团队的代码开了白名单（虽然 kl-graph/ 已在 SKIP_PATHS，
 * 但我们自己写的 adapter 与脚本也可能是 .py）。
 */
const TEXT_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|css|html|md|yml|yaml|sql|sh|txt|example|nvmrc|npmrc|py|toml|cfg|in)$/i
/** 无扩展名文件的二进制探测长度：足以覆盖各种可执行文件头。 */
const SNIFF_BYTES = 512

const hits = []

/**
 * 无扩展名文件是否是二进制。
 *
 * 原来的判据是 `entry.includes(".")`——无扩展名就当文本读。
 * 而预置的 dws 可执行文件恰恰无扩展名且有几十 MB：它会被整份读进内存
 * 再逐行跑正则，`pnpm verify` 显著变慢。
 * 改为读前 512 字节探 NUL 字节（文本文件里不会有）。
 */
function looksBinary(path) {
  let fd
  try {
    fd = openSync(path, "r")
    const buffer = Buffer.alloc(SNIFF_BYTES)
    const read = readSync(fd, buffer, 0, SNIFF_BYTES, 0)
    return buffer.subarray(0, read).includes(0)
  } catch {
    // 读不出来就当二进制跳过：扫不到总比崩掉好。
    return true
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) {
      if (SKIP_PATHS.includes(relative(root, full))) continue
      walk(full)
      continue
    }
    const rel = relative(root, full)
    if (ALLOWED_PREFIXES.some((prefix) => rel.startsWith(prefix + sep))) continue
    // 文件名本身也不允许带商标。
    if (FORBIDDEN.test(entry)) hits.push(`${rel}（文件名）`)
    if (TEXT_EXT.test(entry)) {
      // 已知文本扩展名，直接读。
    } else if (entry.includes(".")) {
      // 未知扩展名（图片、字体等）：跳过。
      continue
    } else if (looksBinary(full)) {
      continue
    }
    let content
    try {
      content = readFileSync(full, "utf8")
    } catch {
      continue
    }
    content.split("\n").forEach((line, index) => {
      if (FORBIDDEN.test(line)) hits.push(`${rel}:${index + 1}: ${line.trim().slice(0, 120)}`)
    })
  }
}

walk(root)

if (hits.length > 0) {
  console.error(`商标扫描未通过，命中 ${hits.length} 处：`)
  for (const hit of hits) console.error(`  - ${hit}`)
  process.exit(1)
}

console.log("商标扫描通过：未发现第三方商标字样")
