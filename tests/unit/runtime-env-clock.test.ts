/**
 * Clock 注入的正例，以及「裸 Date.now() 被 eslint 拦住」的负例。
 *
 * 负例为什么必须测：eslint 规则的 selector 写错（比如把 `callee.object.name`
 * 写成 `callee.name`）与规则生效**外观完全相同** —— lint 一样是绿的。
 * 这属于典型的静默失效：我们以为有防线，其实没有。
 */
import { describe, expect, it } from "vitest"
import { ESLint } from "eslint"
import type { Linter } from "eslint"
import { resolve } from "node:path"
import { ManualClock, MS_PER_DAY, MS_PER_HOUR, systemClock } from "@mycontext/kernel"

const root = resolve(import.meta.dirname, "../..")

describe("ManualClock", () => {
  it("时间只在被明确推进时前进", () => {
    const clock = new ManualClock(1_000)
    expect(clock.now()).toBe(1_000)
    expect(clock.now()).toBe(1_000) // 两次读取之间不会自己流逝
    clock.advance(500)
    expect(clock.now()).toBe(1_500)
  })

  it("支持直接跳到某个时刻（构造「已过期」场景）", () => {
    const clock = new ManualClock(0)
    const grantedAt = 1_700_000_000_000
    clock.set(grantedAt)
    // 7 天 TTL 的授权，跳到第 8 天
    clock.advance(8 * MS_PER_DAY)
    expect(clock.now() - grantedAt).toBeGreaterThan(7 * MS_PER_DAY)
  })

  it("拒绝负数推进：时间不会倒流", () => {
    expect(() => new ManualClock(0).advance(-1)).toThrow(/倒流/)
  })

  it("systemClock 返回接近当前时间的值", () => {
    const before = Date.now()
    const now = systemClock.now()
    expect(now).toBeGreaterThanOrEqual(before)
    expect(now - before).toBeLessThan(MS_PER_HOUR)
  })
})

/**
 * eslint 规则的负例。
 *
 * 用 programmatic API 对**构造出来的**违规代码跑 lint，而不是依赖仓库里
 * 恰好存在一处违规 —— 后者会在有人把那处修掉时静默失去覆盖。
 */
describe("时间敏感包禁用裸 Date.now()", () => {
  async function lint(filePath: string, code: string): Promise<Linter.LintMessage[]> {
    const eslint = new ESLint({ cwd: root })
    const [result] = await eslint.lintText(code, { filePath, warnIgnored: false })
    return result?.messages ?? []
  }

  it("packages/persona 里的裸 Date.now() 报错", async () => {
    const messages = await lint(
      resolve(root, "packages/persona/src/__lint_probe__.ts"),
      "export const stamp = (): number => Date.now()\n",
    )
    const restricted = messages.filter((m) => m.ruleId === "no-restricted-syntax")
    expect(restricted.length, JSON.stringify(messages)).toBeGreaterThan(0)
    expect(restricted[0]?.message).toContain("Clock")
  })

  it("packages/ingest 里的无参 new Date() 报错", async () => {
    const messages = await lint(
      resolve(root, "packages/ingest/src/__lint_probe__.ts"),
      "export const at = (): Date => new Date()\n",
    )
    expect(messages.some((m) => m.ruleId === "no-restricted-syntax")).toBe(true)
  })

  it("注入 Clock 的写法不报错（正例，确认规则不是一刀切）", async () => {
    const messages = await lint(
      resolve(root, "packages/persona/src/__lint_probe__.ts"),
      [
        'import type { Clock } from "@mycontext/kernel"',
        "export const stamp = (clock: Clock): number => clock.now()",
        "",
      ].join("\n"),
    )
    expect(messages.filter((m) => m.ruleId === "no-restricted-syntax")).toEqual([])
  })

  it("不在名单里的包（kernel）允许用 Date.now()", async () => {
    // Clock 的默认实现自己必须能读系统时钟，否则这个抽象无处落地。
    const messages = await lint(
      resolve(root, "packages/kernel/src/__lint_probe__.ts"),
      "export const stamp = (): number => Date.now()\n",
    )
    expect(messages.filter((m) => m.ruleId === "no-restricted-syntax")).toEqual([])
  })
})
