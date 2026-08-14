/**
 * @vitest-environment jsdom
 *
 * 覆盖面那三行在**picker 没选过**时也要渲染（CDP 探针抓到的 bug）。
 *
 * ## ★★★ 缺陷是什么
 *
 * `ScopeCoverage` 对 `channelId === null` 直接 `return null`。而
 * `CollectionScopePanel` 原来把**原始的** `channelId` 传给它 ——
 * 而 picker 没选过时那个 prop **就是 null**（那是常态：刚打开状态页、
 * 或者只有一个渠道时都不会去点 picker）。
 *
 * 后果：整块覆盖面**一个字都不渲染** —— 连"正在统计…"与"还没有记账数据"
 * 都没有。实测（CDP，真应用）：三个源都开着、三个域的 IPC 全通，
 * 而界面上那三行完全不存在。
 *
 * ## ★★ 这个文件自己的注释警告过这件事
 *
 * `activeChannel = channelId ?? PRIMARY_CHANNEL_ID` 被提出来的理由是
 * 「读库/存库/草稿归属/会话过滤/已保存提示**五处**都要用它，
 * 任意两处不一致就是一次跨渠道错位」。覆盖面是**第六处**，而它漏了。
 *
 * ## ★ 为什么既有的渲染层测试抓不到
 *
 * 它们都**显式传了**一个 channelId —— 而"没选过 picker"这个真实的默认
 * 状态没人造。所以这条用例的关键是 `channelId={null}`。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { ScopeCoverage } from "@renderer/features/shell/scope-coverage"

afterEach(cleanup)

function setup(channelId: string | null) {
  const calls: { channelId: string; domain?: string }[] = []
  const chatCoverage = vi.fn((input: { channelId: string; domain?: string }) => {
    calls.push(input)
    return Promise.resolve({
      ok: true as const,
      data: { days: [], localCount: 12, dayCount: 3, drainedDays: 1, pendingConversations: 0 },
    })
  })
  ;(globalThis as { window?: { mycontext?: unknown } }).window ??= {}
  ;(window as unknown as { mycontext: unknown }).mycontext = { distill: { chatCoverage } }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  render(<ScopeCoverage channelId={channelId} rangeDays={30} customRange={null} domain="doc" />, {
    wrapper,
  })
  return { calls }
}

describe("★★★ 覆盖面：channelId 为 null 时的行为", () => {
  it("★★★ 传 null → 什么都不渲染（这正是那个 bug 的形状）", async () => {
    /**
     * 这一条**锁住组件的既有契约**：它对 null 返回 null。
     *
     * ★ 不改这个契约是刻意的：`ScopeCoverage` 不该替调用方决定"null 是
     * 哪个渠道" —— 主渠道 id 是 `CollectionScopePanel` 的知识
     * （它有 `PRIMARY_CHANNEL_ID`）。让组件自己 `?? "dingtalk"` 会把
     * 一个渠道 id 写死进一个通用组件里。
     *
     * 所以修法在**调用方**（传 `activeChannel`），而这一条说明为什么
     * 那个修法是必要的：组件这一侧确实会什么都不画。
     */
    const { calls } = setup(null)
    expect(calls).toHaveLength(0)
    expect(document.body.textContent ?? "").toBe("")
  })

  it("★★ 传具体渠道 → 渲染出带**域名**的那一行", async () => {
    const { calls } = setup("dingtalk")

    await waitFor(() => {
      expect(calls.length).toBeGreaterThan(0)
    })
    expect(calls[0]?.domain).toBe("doc")
    /**
     * ★★ 这里**只能**断言"那一行渲染了 + 域名进了插值参数"。
     *
     * 渲染层测试里的 i18n 是一个不做插值的桩（实测：渲染出来的是字面的
     * `{{label}}：{{from}} 起已有 {{count}} {{unit}}…`）。所以"三行文案
     * 各不相同"这件事在这一层**测不到** —— 那个判据由 CDP 探针
     * （`scripts/probe-data-plane-v2.mjs` 的 `domainRows`）在真应用里锁住，
     * 而它正是那次误报的来源：三行曾经完全一样。
     *
     * 两层各锁一半，且都写清了自己锁的是哪一半 —— 比在这里写一条
     * 恒绿的断言好。
     */
    await waitFor(() => {
      expect(document.body.textContent ?? "").toContain("{{label}}")
    })
  })
})
