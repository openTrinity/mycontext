/**
 * @vitest-environment jsdom
 *
 * 会话列表**截断**时不当终态缓存 —— 它要能自己恢复。
 *
 * ## 锁的是哪个 bug
 *
 * `truncated` 是主进程给的"这不是全集"的信号，两个可恢复的成因：
 * 主渠道的库还没挂完（授权刚成功那个窗口），或渠道 CLI 这一次调用失败。
 * 两者都会在几秒内自己好转 —— 而 `staleTime: 5 * 60_000` 会把那一刻的
 * 残缺结果按住 5 分钟，用户看到一个空列表且**不会自己恢复**
 * （主进程没有"挂载完成"事件推给渲染层）。
 *
 * ## ★ 判据用 `truncated` 而不是"items 为空"
 *
 * 真的没有会话（新账号、全是保密群）也是空 —— 那时无限轮询是白跑。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { useChannelConversations } from "@renderer/lib/queries"

afterEach(cleanup)

function setup(responses: { items: unknown[]; truncated: boolean; sources?: unknown[] }[]) {
  let call = 0
  const conversations = vi.fn(() => {
    const body = responses[Math.min(call, responses.length - 1)]
    call += 1
    return Promise.resolve({ ok: true as const, data: body })
  })
  ;(globalThis as { window?: { mycontext?: unknown } }).window ??= {}
  ;(window as unknown as { mycontext: unknown }).mycontext = {
    channels: { conversations },
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, wrapper, conversations }
}

describe("★★ 截断的会话列表要能自己恢复", () => {
  /**
   * ★★★ 截断 → 开轮询（`refetchInterval` 不是 false）。
   * 反证：把 refetchInterval 删掉 → 必红。
   */
  it("★★★ truncated:true → refetchInterval 是个数（会再问）", async () => {
    const { client, wrapper } = setup([{ items: [], truncated: true }])
    const { result } = renderHook(() => useChannelConversations(true), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())

    const query = client.getQueryCache().find({ queryKey: ["channel", "conversations"] })
    const interval = query?.options.refetchInterval
    const resolved = typeof interval === "function" ? interval(query!) : interval
    expect(typeof resolved).toBe("number")
  })

  /**
   * ★★ 完整结果 → **停**轮询。不停的话这个列表会一直跑渠道 CLI
   *（每次都是子进程），那是白烧机器。
   */
  it("★★ truncated:false → refetchInterval 为 false（停）", async () => {
    const { client, wrapper } = setup([{ items: [], truncated: false }])
    const { result } = renderHook(() => useChannelConversations(true), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())

    const query = client.getQueryCache().find({ queryKey: ["channel", "conversations"] })
    const interval = query?.options.refetchInterval
    const resolved = typeof interval === "function" ? interval(query!) : interval
    expect(resolved).toBe(false)
  })

  /**
   * ★★ `staleTime` 也要跟着分档：截断的结果不该被按住 5 分钟。
   */
  it("★★ 截断的 staleTime 远小于完整的", async () => {
    const { client, wrapper } = setup([{ items: [], truncated: true }])
    const { result } = renderHook(() => useChannelConversations(true), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())

    const query = client.getQueryCache().find({ queryKey: ["channel", "conversations"] })
    const stale = query?.options.staleTime
    const resolved = typeof stale === "function" ? stale(query!) : stale
    expect(typeof resolved).toBe("number")
    expect(resolved as number).toBeLessThan(60_000)
  })

  /**
   * ★★★ **登录过期不许重试** —— 这条锁的是一个停不下来的轮询。
   *
   * 原判据是 `truncated === true` → 每 8 秒无限重取，注释里写着
   * "两者都会在几秒内自己好转"。实测不成立：
   *
   *     16:20:54 warn | conversation list: primary db not attached yet
   *     16:21:02 warn | …每 8 秒一条，刷到日志末尾（2 分半没停）
   *
   * 而 `expired` 更糟 —— 那一轮里钉钉每次调用都回 `dws auth login` 提示，
   * 重试 20 次与 1 次结果完全一样，只是把真正的错误刷出了屏幕。
   */
  it("★★★ expired（登录过期）→ 不重试（靠等永远好不了）", async () => {
    const { client, wrapper } = setup([
      {
        items: [],
        truncated: true,
        sources: [{ channelId: "dingtalk", count: 0, state: "expired", reason: "登录已过期" }],
      },
    ])
    const { result } = renderHook(() => useChannelConversations(true), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())

    const query = client.getQueryCache().find({ queryKey: ["channel", "conversations"] })
    const interval = query?.options.refetchInterval
    expect(typeof interval === "function" ? interval(query!) : interval).toBe(false)
  })

  /** ★★ `cannot-enumerate` 是渠道的固有属性，重试无意义。 */
  it("★★ cannot-enumerate → 不重试", async () => {
    const { client, wrapper } = setup([
      {
        items: [],
        truncated: true,
        sources: [{ channelId: "feishu", count: 0, state: "cannot-enumerate", reason: null }],
      },
    ])
    const { result } = renderHook(() => useChannelConversations(true), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())

    const query = client.getQueryCache().find({ queryKey: ["channel", "conversations"] })
    const interval = query?.options.refetchInterval
    expect(typeof interval === "function" ? interval(query!) : interval).toBe(false)
  })

  /** ★★★ `not-ready`（库还在挂）**才**重试 —— 它是唯一会自己好转的。 */
  it("★★★ not-ready → 重试", async () => {
    const { client, wrapper } = setup([
      {
        items: [],
        truncated: true,
        sources: [{ channelId: "dingtalk", count: 0, state: "not-ready", reason: "挂载中" }],
      },
    ])
    const { result } = renderHook(() => useChannelConversations(true), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())

    const query = client.getQueryCache().find({ queryKey: ["channel", "conversations"] })
    const interval = query?.options.refetchInterval
    expect(typeof (typeof interval === "function" ? interval(query!) : interval)).toBe("number")
  })

  /**
   * ★★★ 有**次数上限** —— `not-ready` 理论上会好转，但挂载那一步自己挂掉时
   * （实测发生过）无限轮询会一直转，而它刷出来的 warn 会掩盖真正的错误。
   */
  it("★★★ not-ready 重试到上限后停下", async () => {
    const { client, wrapper } = setup([
      {
        items: [],
        truncated: true,
        sources: [{ channelId: "dingtalk", count: 0, state: "not-ready", reason: "挂载中" }],
      },
    ])
    const { result } = renderHook(() => useChannelConversations(true), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())

    const query = client.getQueryCache().find({ queryKey: ["channel", "conversations"] })!
    const interval = query.options.refetchInterval as (q: typeof query) => number | false
    // 伪造"已经取到过 8 次"→ 必须停
    const exhausted = {
      ...query,
      state: { ...query.state, dataUpdateCount: 8 },
    } as unknown as typeof query
    expect(interval(exhausted)).toBe(false)
  })
})
