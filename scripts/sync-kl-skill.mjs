#!/usr/bin/env node
/**
 * 把算法团队的 kl skill 同步到随包分发的资源目录，**并做外发前的净化**。
 *
 * 为什么要"同步"而不是直接引用 `kl-graph/`：
 * skill 要铺进 agent 的 workspace（走 opencode 的 `skills.paths`），
 * 而那个目录是我们自己的资源目录；且这一步还要做脱敏（见下）。
 *
 * 有同步脚本就必须有**漂移门禁**（`check-kl-skill-sync.mjs`）：
 * 「同步过了」与「忘了同步」外观完全相同，与 `check-docs-tracked`
 * 是同一类静默失败。
 *
 * ## ★ 这一步不是纯拷贝 —— 它换掉真名与第三方商标
 *
 * 上游的 SKILL.md 里有真实同事姓名（命令示例）与一处第三方产品商标
 * （`check:trademarks` 禁止全仓库出现，而这个目录正是会外发的那个）。
 * 在他们仓库里两者都没问题；而这份会**打进 .app 发给用户**，
 * 于是同一段文字换了受众。映射与理由见 `lib/kl-skill-sanitize.mjs`。
 *
 * 上游那份**一个字都不改** —— 改了会在 `sync:kl-graph` 合并时变成冲突，
 * 且算法团队看不到。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { findResidual, sanitize } from "./lib/kl-skill-sanitize.mjs"

const root = resolve(import.meta.dirname, "..")
const source = join(root, "kl-graph/.claude/skills/kl")
const target = join(root, "apps/desktop/resources/skills/kl")

if (!existsSync(source)) {
  console.error(
    [
      `未找到 kl skill 源：${source}`,
      "kl-graph/ 是算法团队仓库的历史，需要先导入进来（见 docs/handoff/）。",
    ].join("\n"),
  )
  process.exit(1)
}

/**
 * 只对**文本**做替换，其余按字节拷。
 *
 * 二进制里做字符串替换会破坏文件（且 skill 目录里出现二进制本身就该被看见），
 * 所以扩展名不认识时原样拷 —— 但同时提示一声，因为那意味着净化没覆盖它。
 */
const TEXT_EXT = /\.(md|txt|json|yml|yaml|sh|py|ts|js|mjs)$/i

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })

let textFiles = 0
let binaryFiles = 0
const replaced = new Set()

const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const rel = relative(source, full)
    const dest = join(target, rel)
    if (statSync(full).isDirectory()) {
      mkdirSync(dest, { recursive: true })
      walk(full)
      continue
    }
    mkdirSync(dirname(dest), { recursive: true })
    if (!TEXT_EXT.test(name)) {
      writeFileSync(dest, readFileSync(full))
      binaryFiles += 1
      continue
    }
    const original = readFileSync(full, "utf8")
    for (const { kind } of findResidual(original)) replaced.add(kind)
    writeFileSync(dest, sanitize(original), "utf8")
    textFiles += 1
  }
}
walk(source)

console.log(`已同步 kl skill：${source}\n           → ${target}`)
console.log(`  文本 ${String(textFiles)} 个（已净化）／其他 ${String(binaryFiles)} 个`)
if (replaced.size > 0) {
  // 只报"换掉了哪几类"，不回显真名 —— 那等于在日志里又泄漏一次
  console.log(`  ★ 已替换：${[...replaced].join("、")}（映射见 lib/kl-skill-sanitize.mjs）`)
}
if (binaryFiles > 0) {
  console.log("  ⚠ 有非文本文件未经净化检查 —— 确认它们不含个人数据或商标。")
}
