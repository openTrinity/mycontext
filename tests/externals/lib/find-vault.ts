/**
 * 在本机找一个**真跑过蒸馏**的 dev vault —— 给 `tests/externals/` 共用。
 *
 * ## ★★ 为什么必须运行时发现，不能把 vault id 写进文件
 *
 * vault id 是 `openDingTalkId` 派生出来的**真实标识**，属于 CLAUDE.md §1.1
 * 一个字符都不许进仓库的那一类（git 历史、fork、镜像、CI 日志都会留存）。
 * 而 externals 这批用例天生要碰本机真实数据，最容易在这一点上失手 ——
 * 事实上第一版三个 playbook 用例就把 id 硬编码进了常量。
 *
 * 运行时发现同时解决第二个问题：**同事与 CI 上没有本机 vault**。
 * 返回 null 让调用方 `it.skipIf` 跳过，而不是拿一个写死的路径去失败 ——
 * 后者的报错会指向「路径不存在」，读起来像环境坏了，而事实是「这台机器
 * 本来就没有这份数据」。
 *
 * ★ 判据是「`profile_facets` 里 LLM 结论最多的那个」而不是「第一个」：
 * 一台机器上可能有多个身份的 vault（切过账号），其中只有一个真跑过蒸馏。
 * 取第一个会随机命中一个空库，然后用例报出「0 条结论」——那是个假结论。
 *
 * ★ 单个库读失败**跳过它**而不是让整个用例失败：老 schema 或半写坏的库
 * 不该阻止在别的 vault 上验证。
 */
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"

/** dev 版 userData 目录名。发布版是 `MyContext`，这批用例只跑 dev。 */
const DEV_APP_DIR = "MyContextDevelop"

/**
 * 返回结论最多的那个 vault 的**目录**路径（不是 core.sqlite）。
 * 没有可用 vault 时返回 null —— 调用方应当 `it.skipIf(...)`。
 */
export function findRichestVaultDir(): string | null {
  const root = join(homedir(), "Library/Application Support", DEV_APP_DIR, "vaults")
  if (!existsSync(root)) return null
  let best: { dir: string; facets: number } | null = null
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry)
    const dbPath = join(dir, "core.sqlite")
    if (!existsSync(dbPath)) continue
    try {
      const db = new Database(dbPath, { readonly: true })
      const row = db
        .prepare("SELECT count(*) AS c FROM profile_facets WHERE source = 'llm'")
        .get() as { c: number } | undefined
      db.close()
      const facets = row?.c ?? 0
      if (facets > 0 && (best === null || facets > best.facets)) best = { dir, facets }
    } catch {
      // 库坏了 / schema 太老：跳过它，别让整个用例失败
    }
  }
  return best?.dir ?? null
}
