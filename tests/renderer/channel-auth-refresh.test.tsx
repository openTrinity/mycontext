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
 * ## 为什么测的是"那三份缓存有没有真的被作废"
 *
 * 失效动作没有可见的返回值，坏掉时界面只是"没更新"。
 *
 * ## ★★ 判据不是「逐个点名」，而是「实际被作废」
 *
 * 这一组原来拦 `invalidateQueries` 并只统计**带 queryKey** 的调用，断言
 * 那三个 key 各被点名一次。而后来 `useChannelMutation` 改成了**全失效**
 * （`invalidateQueries()` 不带 key）—— 那比逐个点名**更强**（全清必然覆盖
 * 这三份），这条却因为"没数到三次带 key 的调用"而变红。
 *
 * 也就是说旧判据把手段当成了目的：它锁的应该是"重新授权后这三份缓存不会
 * 继续用旧值"，而不是"用哪种写法去失效"。所以现在改成先把三个 query 挂上
 * 真实数据，再看授权之后它们是否都进了 stale —— 列举与全清都能过，
 * 而"漏掉某一份"仍然必红。
 *
 * 反证跑过：把 `useChannelMutation` 改回只失效 channels + bootstrap
 * （即那个真实 bug 的形态）→ self-identity 那条断言红。
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

/** 授权前后都不该继续用旧值的那三份缓存。 */
const WATCHED = [["channels"], ["bootstrap"], ["self-identity"]] as const

/**
 * 给那三个 key 各塞一份"已经取到、还很新"的数据。
 *
 * ★ 必须真的 `setQueryData` 而不是只声明 key：`invalidateQueries` 只把
 * **已存在**的 query 标 stale，没有缓存条目时它什么也不做，
 * 而那样这一组就永远绿（测了个空）。
 */
function seed(client: QueryClient): void {
  for (const key of WATCHED) client.setQueryData(key, { seeded: true })
}

/** 这三份是否都已被作废（stale）—— 列举失效与全失效都会造成这个结果。 */
function allStale(client: QueryClient): boolean {
  return WATCHED.every((key) => {
    const state = client.getQueryState(key)
    return state !== undefined && state.isInvalidated
  })
}

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

describe("★★ 授权成功后失效的缓存（修重授权身份只刷一半）", () => {
  it("★★ useStartChannelAuth 成功后 channels / bootstrap / self-identity 三份全部作废", async () => {
    installApi()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    seed(client)
    const { result } = renderHook(() => useStartChannelAuth(), { wrapper: wrapper(client) })

    await act(async () => {
      await result.current.mutateAsync({ channelId: "dingtalk", mode: "loopback" })
    })

    // 三份都要作废——尤其 self-identity，那是当初修的那个洞
    await waitFor(() => expect(allStale(client)).toBe(true))
    for (const key of WATCHED) {
      expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true)
    }
  })

  it("★ 取消授权也走同一套失效（取消可能回滚了半途写入的身份）", async () => {
    installApi()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    seed(client)
    const { result } = renderHook(() => useCancelChannelAuth(), { wrapper: wrapper(client) })

    await act(async () => {
      await result.current.mutateAsync({ channelId: "dingtalk" })
    })

    await waitFor(() => expect(allStale(client)).toBe(true))
    expect(client.getQueryState(["self-identity"])?.isInvalidated).toBe(true)
  })
})
