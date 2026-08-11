/**
 * @vitest-environment jsdom
 *
 * 仪表盘顶部那一行问候（头像 + 「下午好，X」）。
 *
 * ## 这一组锁的是"问候语跟着当前渠道走"这件事
 *
 * 需求（用户明确）：问候语显示**当前渠道绑定的已授权账号名**，
 * 当前渠道**未授权**就显示「渠道未授权」，渠道列表还没读到就整行不出现。
 *
 * 名字由调用方（`dashboard-module` 从 `scope.channels[].status.userName` 取）
 * 算好传进来，`GreetingRow` 只负责渲染这三态 —— 所以这里断言的是三态渲染，
 * 而不再是"花名 vs 实名"那套（那套随身份逻辑搬到了 scope 层）。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"
import { I18nextProvider } from "react-i18next"
import { createI18n } from "@mycontext/i18n"
import { GreetingRow } from "@renderer/features/dashboard/greeting-row"

afterEach(cleanup)

const wrap = (node: React.ReactElement) =>
  render(<I18nextProvider i18n={createI18n("zh")}>{node}</I18nextProvider>)

describe("★ 问候行渲染三态", () => {
  it("已授权 → 「问候语，账号名」，名字恰好出现一次", () => {
    const { container } = wrap(<GreetingRow accountName="小王" />)
    const text = container.textContent ?? ""
    expect(text).toContain("小王")
    // 问候语按小时分段，四个取值之一都算对（不锁死具体哪一个）
    expect(text).toMatch(/早上好|下午好|晚上好|夜深了/)
    /**
     * ★ 名字**恰好出现一次**（不是「下午好，小王小王」）。
     * ParticleText 会把真文字放进 sr-only 供读屏，`textContent` 里因此
     * 只应有一份 —— 若粒子层也把文本塞进 DOM 就会数出两份。
     */
    const hits = text.match(/小王/g) ?? []
    expect(hits).toHaveLength(1)
  })

  it("★★ 当前渠道未授权（null）→ 显示「渠道未授权」，不问候", () => {
    /**
     * 反证：若这里回落成账号名或空串，就回到了"下午好，"后面接不上名字
     * 的假问候。必须明确说"未授权"。
     */
    const { container } = wrap(<GreetingRow accountName={null} />)
    const text = container.textContent ?? ""
    expect(text).toContain("渠道未授权")
    expect(text).not.toMatch(/早上好|下午好|晚上好|夜深了/)
  })

  it("★ 渠道列表还没读到（undefined）→ 整行不渲染", () => {
    /**
     * 一个"？头像 + 你好，—"比空着更像坏了，而它只闪一瞬。
     */
    const { container } = wrap(<GreetingRow accountName={undefined} />)
    expect(container.textContent ?? "").toBe("")
  })

  it("不带身份状态（那是被删掉的身份条的活）", () => {
    const { container } = wrap(<GreetingRow accountName="小王" />)
    const text = container.textContent ?? ""
    expect(text).not.toContain("本人身份已确认")
    expect(text).not.toContain("待确认")
  })
})
