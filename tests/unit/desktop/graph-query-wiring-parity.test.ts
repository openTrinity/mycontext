/**
 * `GraphQueryService` 的两处装配必须给**同一套** option。
 *
 * ## 这一组锁的是本仓库最常复现的那个形状
 *
 * 主渠道与非主渠道走两套代码路径：主渠道的 `graphQuery` 是应用级单例，
 * 非主渠道的 `channelGraph` 由 `ChannelPipelineManager` 每次现造。
 * 于是**加一个能力要在两处各写一遍，漏一处就是一次静默错位**。
 *
 * 已经发生过的（每一次都是"不报错、只是答错/答空"）：
 *
 * · `getSelfNames` 在非主渠道那套是 `() => []` → ego 图恒返回"不知道你在
 *   这里叫什么"，界面显示成「关系图只在钉钉上可用」——一个假结论；
 * · `factsOfEntity` 只接在主渠道那套 → 非主渠道的关系图**恒空**，
 *   而图其实建好了（实测飞书 `entities=11 facts=13 edges=120`，
 *   界面上一个点都没有）。SQLite 的 `edges` 表在默认后端下按设计恒空，
 *   所以关系必须问 kl 的 HTTP —— 漏接就等于没有关系数据。
 *
 * ## 判据：option 键集**相等**，而不是"都包含某几个"
 *
 * 后者挡不住"下次又加一个新 option 只写了一处"——而那正是这个形状的
 * 复现方式。相等意味着任何一侧多/少一个键都会红，那时该做的是把它补到
 * 另一侧（或者把两处的装配提成共用函数，那才是真正的修法）。
 *
 * ## 为什么是源码断言
 *
 * 两处装配都在 `bootstrapApp()` 的闭包里（一处还在 `mountVault` 的回调里），
 * 要跑它得起真 Electron + 真 vault + 迁移 + python env。而判据本身很窄：
 * **两个对象字面量的键名集合**。所以这里直接解析源码 —— 把装配提成共用
 * 函数时这条会红，那时把它改成"只有一处装配"的断言即可。
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const source = readFileSync(
  join(process.cwd(), "apps/desktop/src/main/bootstrap/startup.ts"),
  "utf8",
)

/**
 * 取 `new GraphQueryService({...})` 里那层对象的**顶层**键名。
 *
 * ★ 只要顶层：值里面还有嵌套对象与箭头函数体（里面出现 `xxx:` 的地方多得是），
 * 按括号深度计数才不会把它们算进来。
 */
function optionKeysAt(start: number): string[] {
  const open = source.indexOf("{", start)
  expect(open, "没找到 option 对象的左花括号").toBeGreaterThan(-1)
  const keys: string[] = []
  let depth = 0
  let i = open
  // 逐字符扫，遇到深度 1 上的 `标识符:` 就记一个键
  for (; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === "{" || ch === "(" || ch === "[") depth += 1
    else if (ch === "}" || ch === ")" || ch === "]") {
      depth -= 1
      if (depth === 0) break
    } else if (depth === 1 && /[A-Za-z_]/.test(ch ?? "")) {
      // 只在深度 1（option 对象自己那一层）认键
      const rest = source.slice(i)
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(rest)
      if (m !== null) {
        const before = source.slice(Math.max(0, i - 60), i)
        // 排除注释里的 `xxx:`（`*` 开头的行、或 `//` 之后）
        const line = before.slice(before.lastIndexOf("\n") + 1)
        if (!line.trimStart().startsWith("*") && !line.includes("//")) {
          keys.push(m[1] as string)
        }
        i += m[1]!.length
      }
    }
  }
  return [...new Set(keys)]
}

describe("GraphQueryService 的两处装配给同一套 option", () => {
  it("★★★ 键集相等（漏一个就是一次静默错位）", () => {
    const positions: number[] = []
    let at = source.indexOf("new GraphQueryService(")
    while (at !== -1) {
      positions.push(at)
      at = source.indexOf("new GraphQueryService(", at + 1)
    }
    expect(
      positions.length,
      "startup.ts 里 GraphQueryService 的装配处数变了 —— 若已提成共用函数，把这条改成断言「只有一处」",
    ).toBe(2)

    const [a, b] = positions.map((p) => optionKeysAt(p).sort())
    expect(a).toEqual(b)
  })

  /**
   * ★★ `factsOfEntity` 必须在**两处**都出现，且各自用自己渠道的 kl。
   *
   * 上面那条键集相等已经能挡住"只写一处"，但挡不住"两处都写了、却都指向
   * 主渠道那个 kl"—— 那会让飞书的关系图显示**钉钉的**关系边。
   * 不报错，只是答错，而答的是"这个人和谁有往来"。
   */
  it("★★ factsOfEntity 各问自己渠道的 kl（问错会答成另一个渠道的关系）", () => {
    const calls = [...source.matchAll(/factsOfEntity:\s*\(entityId\)\s*=>\s*(\w+)\.factsOfEntity/g)]
    expect(calls.length, "两处装配都要接 factsOfEntity").toBe(2)
    const receivers = calls.map((m) => m[1])
    // ★ 两处不能指向同一个 kl 实例
    expect(new Set(receivers).size, `两处都指向了 ${receivers[0]} —— 会答成另一个渠道的关系`).toBe(
      2,
    )
  })
})
