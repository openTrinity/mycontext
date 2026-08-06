/**
 * @vitest-environment jsdom
 *
 * 重新授权后，「身份信息」必须**整份**刷新，而不是只刷一半。
 *
 * ## ★★ 这一组防的是一个真实 bug
 *
 * 有两份"身份"分别缓存：
 * · bootstrap 里的**账号** session（displayName / avatarUrl，侧栏头像读它）；
 * · selfIdentity 这份**渠道**身份（钉钉花名 / openId 列表，身份面板与仪表盘读它）。
 *
 * 渠道授权的 mutation（`useStartChannelAuth`）原来只失效了 channels + bootstrap，
 * **漏了 selfIdentity**。表现是：重新授权后侧栏头像变了，而身份面板里的渠道
 * 花名还是旧的 —— 刷了一半。这与 `runtime-config-sync` 记的"漏一个 invalidate"
 * 是同一类静默失败：没有任何报错，且只在"改的组件"与"读的组件"不同一处时显形。
 *
 * ## 为什么测的是"失效了哪些 key"
 *
 * 失效动作没有可见的返回值，坏掉时界面只是"没更新"。所以直接拦
 * `queryClient.invalidateQueries`，断言三份缓存都被点名失效。
 * 反证：去掉 queries.ts 里那行 selfIdentity 失效，这条立刻红。
 */
import { afterEach, describe, expect, it } from "vitest"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { useStartChannelAuth, useCancelChannelAuth } from "@renderer/lib/queries"

afterEach(cleanup)

/** 最小 window.mycontext：授权/取消都直接成功（本组测的是成功后的失效，不是授权本身）。 */
function installApi(): void {
  ;(globalThis as { window?: unknown }).window ??= {}
  ;(window as unknown as { mycontext: Record<string, unknown> }).mycontext = {
    channels: {
      authStart: () => Promise.resolve({ ok: true as const, data: { state: "authorized" } }),
      authCancel: () => Promise.resolve({ ok: true as const, data: { state: "idle" } }),
    },
  }
}

/** 记下每个被失效的 queryKey。 */
function trackingClient(): { client: QueryClient; invalidated: string[] } {
  const invalidated: string[] = []
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const original = client.invalidateQueries.bind(client)
  client.invalidateQueries = ((filters?: { queryKey?: readonly unknown[] }) => {
    if (filters?.queryKey !== undefined) invalidated.push(JSON.stringify(filters.queryKey))
    return original(filters as Parameters<typeof original>[0])
  }) as typeof client.invalidateQueries
  return { client, invalidated }
}

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

describe("★★ 授权成功后失效的缓存（修重授权身份只刷一半）", () => {
  it("★★ useStartChannelAuth 成功后同时失效 channels / bootstrap / self-identity", async () => {
    installApi()
    const { client, invalidated } = trackingClient()
    const { result } = renderHook(() => useStartChannelAuth(), { wrapper: wrapper(client) })

    await act(async () => {
      await result.current.mutateAsync({ channelId: "dingtalk", mode: "loopback" })
    })

    await waitFor(() => expect(invalidated.length).toBeGreaterThanOrEqual(3))
    // 三份都要在——尤其 self-identity，那是这次修的洞
    expect(invalidated).toContain(JSON.stringify(["channels"]))
    expect(invalidated).toContain(JSON.stringify(["bootstrap"]))
    expect(invalidated).toContain(JSON.stringify(["self-identity"]))
  })

  it("★ 取消授权也走同一套失效（取消可能回滚了半途写入的身份）", async () => {
    installApi()
    const { client, invalidated } = trackingClient()
    const { result } = renderHook(() => useCancelChannelAuth(), { wrapper: wrapper(client) })

    await act(async () => {
      await result.current.mutateAsync({ channelId: "dingtalk" })
    })

    await waitFor(() => expect(invalidated.length).toBeGreaterThanOrEqual(3))
    expect(invalidated).toContain(JSON.stringify(["self-identity"]))
  })
})
