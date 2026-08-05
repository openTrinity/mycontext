/**
 * @vitest-environment jsdom
 *
 * 事实面板与 ego 图的**联动**：图上点一个人，下面这一栏要跟过去。
 *
 * ## ★ 锁的是「父级改实体时必须回第一页」
 *
 * `entityFocus` 是**受控**的（状态在仪表盘 —— 图与事实面板的共同父级，
 * 因为图上点一个名字要能筛下面这一栏）。而这带来一个只在受控路径上
 * 出现的漏洞：父级改这个值时**不经过面板里的任何 setter**，
 * 所以"改过滤条件就回第一页"如果写在 setter 里就漏了。
 *
 * 漏掉的表现不是崩，是：停在第 4 页看一个只有 12 条的结果集 ——
 * 列表是空的，而"共 12 条"就写在上面。用户看到的是"查询坏了"。
 *
 * 反证方式：把 `useEffect(() => setPage(0), [entityName])` 删掉，
 * 这个测试必须变红（已验证）。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { FactsExplorer } from "@renderer/features/graph/facts-explorer"

/**
 * jsdom 没有 `ResizeObserver`，而这一栏的分页按钮是 `Button`
 * （走 `useSquircle` → `new ResizeObserver`）。
 *
 * 缺它的表现不是"测试报缺 ResizeObserver"，而是整棵树抛在
 * `<ForwardRef(Button2)>` 里、渲染出一个空 `<div />` —— 于是
 * 断言失败信息是"找不到那个按钮"，指向一个完全无关的方向。
 */
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver

afterEach(cleanup)

interface Captured {
  entityName: string | null
  offset: number
}

/**
 * 装一个记下每次入参的 `kl.graphFacts`。
 *
 * ★ 两个不同的结果集大小，而那是这个测试成立的**前提**：
 * · 不筛实体 → 100 条（5 页，所以「下一页」真的存在）；
 * · 筛「小吴」→ 12 条（不到一页，第 2 页开始必然是空的）。
 *
 * 两边一样大的话这个测试是**空的**：翻不到第 2 页，也就证不出
 * "换实体时回没回第一页"。第一版就是这样 —— 删掉被测的 effect
 * 它照样绿。
 */
function installFactsApi(): { calls: Captured[] } {
  const calls: Captured[] = []
  ;(globalThis as { window?: unknown }).window ??= {}
  ;(window as unknown as { mycontext: Record<string, unknown> }).mycontext = {
    kl: {
      graphFacts: (input: { entityName: string | null; offset: number }) => {
        calls.push({ entityName: input.entityName, offset: input.offset })
        const total = input.entityName === null ? 100 : 12
        const remaining = Math.max(0, Math.min(20, total - input.offset))
        const facts = Array.from({ length: remaining }, (_, i) => ({
          id: `f${String(input.offset + i)}`,
          text: `事实 ${String(input.offset + i)}`,
          type: "DECISION",
          confidence: 0.9,
          at: 1_753_900_000_000,
          entities: ["小吴"],
        }))
        return Promise.resolve({
          ok: true as const,
          data: { available: true, reason: null, total, facts },
        })
      },
    },
  }
  return { calls }
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const TYPES = [
  { type: "DECISION", count: 663 },
  { type: "STATUS", count: 3177 },
]

describe("★ 受控的实体聚焦", () => {
  it("先翻到第 2 页，父级换实体 → offset 回到 0", async () => {
    const { calls } = installFactsApi()
    const { rerender } = render(
      <FactsExplorer typeCounts={TYPES} entityFocus={null} onEntityFocusChange={() => {}} />,
      { wrapper },
    )
    await waitFor(() => {
      expect(calls.length).toBeGreaterThan(0)
    })
    expect(calls[0]?.entityName).toBe(null)
    expect(calls[0]?.offset).toBe(0)

    /**
     * ★ 必须真的翻页 —— 这一步是这个测试的全部力量所在。
     *
     * 停在第 1 页时 `setPage(0)` 是空操作，于是删掉被测的 effect
     * 测试照样绿（第一版就是这个毛病）。100 条 / 每页 20 = 5 页，
     * 所以「下一页」按钮真的在。
     */
    const next = await screen.findByRole("button", { name: "next" })
    next.click()
    await waitFor(() => {
      expect(calls.some((c) => c.offset === 20)).toBe(true)
    })

    // 图上点了「小吴」→ 父级把 entityFocus 改成他
    rerender(<FactsExplorer typeCounts={TYPES} entityFocus="小吴" onEntityFocusChange={() => {}} />)
    await waitFor(() => {
      expect(calls.some((c) => c.entityName === "小吴")).toBe(true)
    })
    /**
     * ★ 所有带这个实体的查询都必须 offset=0。
     *
     * 断言"每一次"而不是"最后一次"：漏掉重置时第一次请求会带着
     * offset=20 打出去，而那一次返回的是空列表 —— 那正是用户看到的
     * 那个 bug。只看最后一次会被后续的正常请求盖掉。
     */
    const focused = calls.filter((c) => c.entityName === "小吴")
    expect(focused.length).toBeGreaterThan(0)
    for (const call of focused) {
      expect(call.offset).toBe(0)
    }
  })

  it("非受控时（没有 onEntityFocusChange）事实卡上的名字仍能筛", async () => {
    /**
     * 这一条锁的是"点了没反应"。
     *
     * 受控化很容易顺手把内部 state 删掉 —— 那时不传回调的调用方
     * （或者忘了接回调的父级）会得到一个点了毫无变化的按钮。
     */
    const { calls } = installFactsApi()
    render(<FactsExplorer typeCounts={TYPES} />, { wrapper })
    await waitFor(() => {
      expect(screen.getAllByText("小吴").length).toBeGreaterThan(0)
    })
    const before = calls.length
    screen.getAllByText("小吴")[0]?.click()
    await waitFor(() => {
      expect(calls.length).toBeGreaterThan(before)
      expect(calls.at(-1)?.entityName).toBe("小吴")
    })
  })
})
