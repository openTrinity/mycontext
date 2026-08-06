#!/usr/bin/env node
/**
 * 存量迁移：把**应用级**的落点搬进它所属的那个 vault。
 *
 * ## 为什么需要它
 *
 * 隔离维度从「本地账号」改成「渠道身份」之后，五处落点从应用级变成了
 * per-vault。改动前的用户机器上那些数据还躺在老位置，而新代码只往新位置写
 * —— 不搬的话表现是"我的图谱空了"（37 MB 的库还在磁盘上，只是没人读它）。
 *
 * ## 搬什么、不搬什么（判据是"库里有没有存它的绝对路径"）
 *
 * ```
 * 搬：shared/kl          → vaults/<id>/kl          （库内绝对路径实测 0 条）
 * 搬：shared/exports/dws → vaults/<id>/exports/dws （纯派生产物，随时可重生成）
 * 搬：shared/handoff.json→ vaults/<id>/handoff.json（每次 attach 会重写，搬只为不留垃圾）
 * 不搬：media/ avatars/  —— 库里存着**绝对路径**（实测 media_assets.path 22 行、
 *       contact_avatars.local_path 45 行）。搬了那些行就全部失效，而失效的
 *       表现是"图片永久显示不出来"。留在原地继续读，新下载的落进 vault。
 * 不搬：agents/ agent-home/ —— 前者是 agent workspace（每次建会话重铺，
 *       且 `dh_agent_sessions.acp_cwd` 存了绝对路径）；后者是 opencode 的
 *       配置与包缓存（会自己重建）。
 * ```
 *
 * ## ★ 只在**恰好一个** vault 时才搬
 *
 * 应用级的那份数据属于谁？如果机器上有多个 vault，答案不确定 ——
 * 猜错就是把 A 的图谱搬给 B。多个 vault 时**只报告不动手**，让人来定。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/migrate-identity-vaults.mjs --dry-run   # 先看要做什么
 * node scripts/migrate-identity-vaults.mjs             # 真搬
 * ```
 *
 * 幂等：搬过之后再跑什么都不做（目标已存在 / 源已不存在）。
 */
import { existsSync, readdirSync, renameSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const DRY_RUN = process.argv.includes("--dry-run")

/**
 * userData 目录的候选名。
 *
 * ★ `Inklings*` 是改名前的旧名，**必须留着** —— 它们是兼容老装机的真实
 * 路径候选。曾经有人"顺手统一"成 MyContext，结果这类脚本在老机器上
 * 静默什么都找不到（见 CLAUDE.md §2）。
 */
const APP_NAMES = [
  "MyContextDevelop",
  "MyContextDev",
  "MyContext",
  "InklingsDevelop",
  "InklingsDev",
  "Inklings",
]

function findUserData() {
  const appSupport = join(homedir(), "Library", "Application Support")
  const found = []
  for (const name of APP_NAMES) {
    const dir = join(appSupport, name)
    // 判据是 control.sqlite：那才说明这是一个真用过的数据目录
    if (existsSync(join(dir, "control.sqlite"))) found.push(dir)
  }
  return found
}

/** 这个 userData 下的 vault 目录（含 core.sqlite 的才算）。 */
function findVaults(userData) {
  const root = join(userData, "vaults")
  if (!existsSync(root)) return []
  return readdirSync(root)
    .map((entry) => join(root, entry))
    .filter((dir) => existsSync(join(dir, "core.sqlite")))
}

function humanSize(path) {
  try {
    if (!existsSync(path)) return "不存在"
    const st = statSync(path)
    if (st.isDirectory()) {
      let total = 0
      let count = 0
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const child = join(dir, entry.name)
          if (entry.isDirectory()) walk(child)
          else {
            count += 1
            try {
              total += statSync(child).size
            } catch {
              // 文件在遍历途中消失（WAL 等）—— 不影响这个纯展示用的估算
            }
          }
        }
      }
      walk(path)
      return `${(total / 1024 / 1024).toFixed(1)} MB / ${String(count)} 个文件`
    }
    return `${(st.size / 1024).toFixed(1)} KB`
  } catch {
    return "读不出来"
  }
}

/**
 * 一次搬迁。
 *
 * ★ 用 `renameSync` 而不是拷贝+删：同一个卷内它是原子的，而拷贝到一半
 * 断电会留下一份半个库 —— 那比没搬糟得多（下次跑会以为"目标已存在"）。
 *
 * ★ 目标已存在时**不覆盖**：那说明新代码已经在新位置写过了，
 * 覆盖等于用旧数据把新数据擦掉。
 */
function move(from, to, label) {
  if (!existsSync(from)) {
    console.log(`  · ${label}：源不存在，跳过`)
    return "skip"
  }
  if (existsSync(to)) {
    console.log(`  · ${label}：目标已存在（新代码已写过），跳过 —— 旧那份留在 ${from}`)
    return "skip"
  }
  console.log(`  ${DRY_RUN ? "→ 将搬" : "✓ 已搬"} ${label}（${humanSize(from)}）`)
  console.log(`      ${from}`)
  console.log(`   →  ${to}`)
  if (!DRY_RUN) renameSync(from, to)
  return "moved"
}

const userDatas = findUserData()
if (userDatas.length === 0) {
  console.log("没找到任何 userData 目录（这台机器还没跑过应用）—— 什么都不用做。")
  process.exit(0)
}

console.log(DRY_RUN ? "== 预演（不写盘）==\n" : "== 开始迁移 ==\n")

let moved = 0
let blocked = 0

for (const userData of userDatas) {
  console.log(`userData: ${userData}`)
  const vaults = findVaults(userData)
  const shared = join(userData, "shared")

  /**
   * 没有 shared/ 或它是空的 → 什么都不用做。
   *
   * ★ 判"空"而不只是"存在"：应用启动时会无条件 `mkdirSync(sharedRoot)`，
   * 所以一个**只启动过、没建过图**的 userData 下也会有个空 shared/。
   * 只判存在的话它会连同"多 vault 无法判定"那条警告一起报出来 ——
   * 而那是个纯假警报（里面本来就没东西可搬），会让人以为有数据没搬成。
   */
  const sharedEntries = existsSync(shared) ? readdirSync(shared) : []
  if (sharedEntries.length === 0) {
    console.log("  · shared/ 不存在或为空（新装机或已迁移过）\n")
    continue
  }

  /**
   * ★★ 多个 vault → 只报告，不动手。
   *
   * 应用级那份数据属于哪个身份？多个 vault 时答案不确定，而猜错就是
   * 把 A 的图谱搬给 B —— 那是不可逆的跨身份污染。
   */
  if (vaults.length !== 1) {
    console.log(
      `  ⚠ 有 ${String(vaults.length)} 个 vault —— 无法判定 shared/ 属于哪个身份，**不动**。`,
    )
    console.log("    请人工决定后手动 mv，或先只保留一个 vault 再跑本脚本。")
    for (const vault of vaults) console.log(`      vault: ${vault}`)
    console.log(`      shared: ${shared}（${humanSize(shared)}）\n`)
    blocked += 1
    continue
  }

  const vault = vaults[0]
  console.log(`  vault: ${vault}`)
  const results = [
    move(join(shared, "kl"), join(vault, "kl"), "图谱数据"),
    move(join(shared, "exports", "dws"), join(vault, "exports", "dws"), "四件套导出"),
    move(join(shared, "handoff.json"), join(vault, "handoff.json"), "handoff.json"),
    move(
      join(userData, "channels", "dingtalk", "dws-home"),
      join(vault, "channels", "dingtalk", "dws-home"),
      "渠道 CLI 配置目录（profiles/日志）",
    ),
  ]
  moved += results.filter((r) => r === "moved").length

  console.log("\n  ★ 刻意**不搬**的（库里存着绝对路径，搬了那些行会全部失效）：")
  for (const name of ["media", "avatars", "uploads", "agents", "agent-home"]) {
    const dir = join(userData, name)
    if (existsSync(dir)) console.log(`      ${name}/（${humanSize(dir)}）—— 留在原地继续读`)
  }
  console.log()
}

console.log(
  DRY_RUN ? `\n预演完成：会搬 ${String(moved)} 项。` : `\n迁移完成：搬了 ${String(moved)} 项。`,
)
if (blocked > 0) {
  console.log(`⚠ ${String(blocked)} 个 userData 因多 vault 被跳过 —— 见上面的说明。`)
}
if (!DRY_RUN && moved > 0) {
  console.log("\n下一步：起应用，确认图谱面板的实体/事实数与迁移前一致。")
}
