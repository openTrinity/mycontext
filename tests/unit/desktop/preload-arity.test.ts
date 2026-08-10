/**
 * preload 转发层的**参数个数**必须与主进程 handler 对齐。
 *
 * ## ★★ 为什么需要这条门禁（typecheck 天然看不见这一类）
 *
 * preload 里每个方法都是 `(...) => ipcRenderer.invoke(channel, ...)` 这种
 * 一行转发。漏掉一个参数不会有任何编译错误 —— 契约里声明的是
 * `graphBuild(fresh?: boolean, channelId?: string)`，而 TS **允许把少参数的
 * 函数赋给多参数的函数类型**（刻意的规则，不是 bug）。于是
 * `(fresh?: boolean) => invoke(ch, fresh)` 完美满足那个契约，
 * 而第二个参数在运行时永远是 undefined。
 *
 * 实测的后果（本机日志 2026-08-08 09:21/09:24）：`graphBuild` 漏了
 * `channelId`，于是在飞书那栏点一次「建图」，
 * `[Main:KlServer] graph build started` 与
 * `[Main:KlServer:feishu] graph build started` **各来一条** —— 建了两个渠道。
 * 更要紧的是 `fresh=true` 走同一条路：在飞书那栏点「重建」会把主渠道那份图
 * 一起删了重烧（不可逆、几小时、出网烧 LLM）。
 *
 * 而 UI 那一侧看起来完全正确（渲染层确实传了 `{fresh, channelId}`，
 * 主进程 handler 也确实收两个参数）——错的是中间那一层，
 * 且它没有任何编译期或运行期信号。这正是本仓库最贵的那类 bug 的形状。
 *
 * ## 判据
 *
 * 从 `register.ts` 抓每个 handler 的**回调形参个数**（`_event` 之后的），
 * 再从 `preload/index.ts` 抓同一个通道 `invoke()` 的**实参个数**（通道名之后
 * 的），两者必须相等。用源码文本比对而不是真的加载 preload：
 * 那个模块要 `electron` 运行时，在 vitest 里加载不了。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const register = readFileSync(
  join(import.meta.dirname, "../../../apps/desktop/src/main/ipc/register.ts"),
  "utf8",
)
const preload = readFileSync(
  join(import.meta.dirname, "../../../apps/desktop/src/preload/index.ts"),
  "utf8",
)

/** 去掉注释 —— 注释里的示例代码不该参与比对。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

/**
 * 逗号分割，但**忽略括号/方括号/花括号内部**的逗号。
 *
 * 不能直接 `split(",")`：`invoke(ch, input ?? {}, foo(a, b))` 会被切碎，
 * 于是参数个数算多。
 */
function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ""
  for (const ch of text) {
    if (ch === "(" || ch === "[" || ch === "{") depth += 1
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1
    if (ch === "," && depth === 0) {
      parts.push(current)
      current = ""
      continue
    }
    current += ch
  }
  if (current.trim() !== "") parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part !== "")
}

/** 从 `text` 中 `openIndex`（'(' 的位置）开始，找到配对的 ')'。 */
function matchParen(text: string, openIndex: number): number {
  let depth = 0
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1
    else if (text[i] === ")") {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** 主进程：通道名 → handler 回调在 `_event` 之后收几个参数。 */
function handlerArity(): Map<string, number> {
  const source = stripComments(register)
  const out = new Map<string, number>()
  const re = /ipcMain\.handle\(\s*IPC_CHANNELS\.(\w+)\s*,\s*(?:async\s*)?\(/g
  for (const match of source.matchAll(re)) {
    const channel = match[1]
    if (channel === undefined) continue
    // match 末尾那个 '(' 是回调的形参列表开头
    const open = match.index + match[0].length - 1
    const close = matchParen(source, open)
    if (close === -1) continue
    const params = splitTopLevel(source.slice(open + 1, close))
    // 第一个是 event（`_event` / `_` / `event`）—— 不算业务参数
    out.set(channel, Math.max(0, params.length - 1))
  }
  return out
}

/** preload：通道名 → `invoke()` 在通道名之后传了几个实参。 */
function invokeArity(): Map<string, number> {
  const source = stripComments(preload)
  const out = new Map<string, number>()
  const re = /ipcRenderer\.invoke\(\s*IPC_CHANNELS\.(\w+)/g
  for (const match of source.matchAll(re)) {
    const channel = match[1]
    if (channel === undefined) continue
    const open = source.lastIndexOf("(", match.index + "ipcRenderer.invoke".length)
    const close = matchParen(source, open)
    if (close === -1) continue
    const args = splitTopLevel(source.slice(open + 1, close))
    // 第一个是通道名本身
    out.set(channel, Math.max(0, args.length - 1))
  }
  return out
}

describe("★★ preload 转发不许漏参数", () => {
  const handlers = handlerArity()
  const invokes = invokeArity()

  it("抓到了两侧的通道（判据本身要有效，不能空跑成绿）", () => {
    // 反证：如果正则失效，下面那条逐通道断言会因为没有用例而恒绿
    expect(handlers.size).toBeGreaterThan(20)
    expect(invokes.size).toBeGreaterThan(20)
    expect(handlers.has("klGraphBuild")).toBe(true)
    expect(invokes.has("klGraphBuild")).toBe(true)
  })

  /**
   * ★★ 核心不变式。
   *
   * handler 收几个就必须转发几个 —— 少一个就是一个静默失效的参数，
   * 而它在 UI 与主进程两侧看起来都对。
   */
  it("★★ 每个通道：handler 收几个参数，preload 就转发几个", () => {
    const mismatched: string[] = []
    for (const [channel, expected] of handlers) {
      const actual = invokes.get(channel)
      // preload 没有这个通道 = 渲染层用不到它（比如只在主进程内部转发），跳过
      if (actual === undefined) continue
      if (actual !== expected) {
        mismatched.push(
          `${channel}: handler 收 ${String(expected)} 个，preload 转发 ${String(actual)} 个`,
        )
      }
    }
    expect(mismatched).toEqual([])
  })

  /**
   * ★ `klGraphBuild` 单独再钉一次：它是这条门禁的来由，
   * 而它漏的那个参数会导致**不可逆的删图**跑在错误的渠道上。
   */
  it("★★ klGraphBuild 转发 channelId（漏了会在错误的渠道上删图重烧）", () => {
    expect(handlers.get("klGraphBuild")).toBe(2)
    expect(invokes.get("klGraphBuild")).toBe(2)
    expect(stripComments(preload)).toMatch(
      /invoke\(\s*IPC_CHANNELS\.klGraphBuild\s*,\s*fresh\s*\?\?\s*false\s*,\s*channelId\s*\)/,
    )
  })
})
