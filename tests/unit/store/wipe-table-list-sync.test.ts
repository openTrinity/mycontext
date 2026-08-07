/**
 * 清库的**表清单**只有一份 —— 这是一道防漂移门禁。
 *
 * ## 为什么需要它
 *
 * 「清空 vault」现在有两个入口：
 * · 设置页那颗按钮 → `ChannelDataWipeService` → `wipeVaultData`（store 层）；
 * · `scripts/reset-vault.mjs`（开发/排障用的命令行）。
 *
 * 两者本该清同一批表。但脚本是 `.mjs` 且用 `createRequire` 直接拿
 * better-sqlite3（不走 esbuild 打包），**没法 import TS 里那份常量** ——
 * 于是它只能自己维护一份 `DATA_TABLES`。
 *
 * 两份清单漂移的后果是静默的：新增一张数据表时只在一处登记，另一个入口
 * 就会把它**漏清**。而"清空之后还剩一批旧数据"不会报错，只会让下一轮
 * 采集/建图基于半旧半新的库工作。
 *
 * 所以用一个测试把两边钉在一起：改了任一处而没同步另一处 → 这里红。
 * 它不是"测代码逻辑"，而是**替代那个做不到的 import**。
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { VAULT_DATA_TABLES, VAULT_SEARCH_TABLES } from "@mycontext/store"

const SCRIPT = join(import.meta.dirname, "../../../scripts/reset-vault.mjs")

/**
 * 从脚本源码里抠出一个数组字面量里的表名。
 *
 * 用正则读源码而不是 import：见文件头（那个 import 做不到）。
 * 抠不出来（0 个）会让下面的断言失败，而不是静默通过一个空集合 ——
 * 后者会让这道门禁在脚本结构变了之后**假绿**。
 */
function tableNamesIn(source: string, constName: string): string[] {
  const start = source.indexOf(`const ${constName} = [`)
  if (start === -1) return []
  const end = source.indexOf("\n]", start)
  if (end === -1) return []
  const body = source.slice(start, end)
  return [...body.matchAll(/^\s*"([a-z_]+)",?\s*$/gm)].map((match) => match[1] as string)
}

describe("★ 清库表清单：脚本与 store 层必须一致（防静默漏清）", () => {
  const source = readFileSync(SCRIPT, "utf8")

  it("数据表清单逐项相同（含顺序 —— FTS 虚表必须最先）", () => {
    const fromScript = tableNamesIn(source, "DATA_TABLES")

    // 抠不出来就是这道门禁失效了，必须失败而不是跳过
    expect(fromScript.length).toBeGreaterThan(10)
    /**
     * ★ 比**顺序**也相同，不只是集合相同：`messages_fts` 必须排在
     * `messages` 之前（contentless 虚表的 rowid 映射会被 cascade 带走，
     * 见 wipe-vault.ts 文件头 ①）。顺序错了会留下永远删不掉的可检索正文。
     */
    expect(fromScript).toEqual([...VAULT_DATA_TABLES])
  })

  it("搜索表清单逐项相同", () => {
    const fromScript = tableNamesIn(source, "SEARCH_TABLES")

    expect(fromScript.length).toBeGreaterThan(3)
    expect(fromScript).toEqual([...VAULT_SEARCH_TABLES])
  })

  it("★ `messages_fts` 在 `messages` 之前（两边都要）", () => {
    for (const list of [[...VAULT_DATA_TABLES], tableNamesIn(source, "DATA_TABLES")]) {
      const fts = list.indexOf("messages_fts")
      const messages = list.indexOf("messages")
      expect(fts).toBeGreaterThanOrEqual(0)
      expect(messages).toBeGreaterThan(fts)
    }
  })
})
