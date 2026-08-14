/**
 * @vitest-environment jsdom
 *
 * 三个域的覆盖面**各自一份缓存**（`domain` 必须进 queryKey）。
 *
 * ## ★★★ 锁的是哪个 bug
 *
 * `useChatCoverage` 现在服务三个域（消息 / 听记 / 文档）。它们共用一个
 * IPC 通道与一个 hook，只差一个 `domain` 参数 —— 而 react-query 是按
 * **queryKey** 认身份的。
 *
 * `domain` 不进 key 的后果：设置页把三行并排渲染时，第二、三行会**直接命中
 * 第一行的缓存**（react-query 认为是同一个 query，连请求都不发）。
 * 于是文档那栏显示的是**消息的条数**。
 *
 * 而这个 bug 的形状正是本仓库最贵的那一类：三个数字都"看起来对"
 * （都是合理的正整数），没有任何东西会报错，只是其中两个属于别人。
 *
 * ## 断言的是**发出去的请求**，不是渲染结果
 *
 * 判据必须是"每个域各发了一次、且带对了 domain"。断言渲染结果的话，
 * 三个域返回同一个数字时这条用例照样绿 —— 而那恰好是 bug 的表现。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { useChatCoverage } from "@renderer/lib/queries"

afterEach(cleanup)

const FROM = "2026-08-11"
const TO = "2026-08-12"

function setup() {
  /** 每个域回一个**不同**的条数 —— 串台时才看得出来。 */
  const byDomain: Record<string, number> = { chat: 111, minutes: 22, doc: 3 }
  const calls: string[] = []
  const chatCoverage = vi.fn((input: { domain?: string }) => {
    const domain = input.domain ?? "chat"
    calls.push(domain)
    return Promise.resolve({
      ok: true as const,
      data: {
        days: [],
        localCount: byDomain[domain] ?? 0,
        dayCount: 1,
        drainedDays: 0,
        pendingConversations: 0,
      },
    })
  })
  ;(globalThis as { window?: { mycontext?: unknown } }).window ??= {}
  ;(window as unknown as { mycontext: unknown }).mycontext = {
    distill: { chatCoverage },
  }
  /**
   * ★ 一个**共享**的 QueryClient —— 缓存串台只在共享缓存下才会发生。
   * 每个 hook 各造一个 client 的话这条用例永远绿（那就白测了）。
   */
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { wrapper, calls, chatCoverage }
}

describe("★★★ 覆盖面的三个域不共用缓存", () => {
  it("★★★ 三个域各发一次请求，且各自拿到自己的数字", async () => {
    const { wrapper, calls } = setup()

    const chat = renderHook(() => useChatCoverage("dingtalk", FROM, TO, true, "chat"), { wrapper })
    const minutes = renderHook(() => useChatCoverage("dingtalk", FROM, TO, true, "minutes"), {
      wrapper,
    })
    const doc = renderHook(() => useChatCoverage("dingtalk", FROM, TO, true, "doc"), { wrapper })

    await waitFor(() => {
      expect(chat.result.current.data).toBeDefined()
      expect(minutes.result.current.data).toBeDefined()
      expect(doc.result.current.data).toBeDefined()
    })

    /**
     * ★ 三次请求、三个域各一次。
     *
     * 反证：把 `domain` 从 queryKey 里去掉 ⇒ `calls` 只有一项（`chat`），
     * 而另两个 hook 直接命中缓存 —— 于是下面三条数字断言里有两条也跟着红。
     */
    expect([...calls].sort()).toEqual(["chat", "doc", "minutes"])
    expect(chat.result.current.data?.localCount).toBe(111)
    expect(minutes.result.current.data?.localCount).toBe(22)
    expect(doc.result.current.data?.localCount).toBe(3)
  })

  it("★★ 不传 domain 时与显式传 chat **共用**同一份缓存（缺省要一致）", async () => {
    const { wrapper, calls } = setup()

    const implicit = renderHook(() => useChatCoverage("dingtalk", FROM, TO), { wrapper })
    const explicit = renderHook(() => useChatCoverage("dingtalk", FROM, TO, true, "chat"), {
      wrapper,
    })

    await waitFor(() => {
      expect(implicit.result.current.data).toBeDefined()
      expect(explicit.result.current.data).toBeDefined()
    })

    /**
     * ★ 这一条是上一条的**配对**：`domain` 进 key 之后，最容易写错的是
     * 让缺省值在两处不同（hook 签名给 `"chat"`、queryKey 里写 `domain ?? ""`）
     * —— 那会让"不传"与"传 chat"变成两个 query，同一个数字请求两遍。
     *
     * 只发一次 ⇒ 两者是同一份缓存 ⇒ 缺省值只有一处定义。
     */
    expect(calls).toEqual(["chat"])
    expect(implicit.result.current.data?.localCount).toBe(111)
  })
})
