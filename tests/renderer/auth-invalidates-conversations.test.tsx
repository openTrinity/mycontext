/**
 * @vitest-environment jsdom
 *
 * 授权成功之后，**要问渠道的查询必须重取** —— 尤其是会话列表。
 *
 * ## 锁的是哪个 bug（引导第 4 步会话列表恒空）
 *
 * 授权前 `DistillSourceService.conversations()` 会被明确拒绝：身份没绑时
 * 不许跑渠道命令（否则会跟着 CLI 的全局身份读到别人的数据 —— 那是安全
 * 边界，拒绝本身是对的）。于是列表降级成"只有本地已采的部分"，
 * 而新装的机器上本地是空的 → 0 项。
 *
 * 那份空结果带着 `staleTime: 5 * 60_000` 进了缓存，**而 `useChannelMutation`
 * 只失效 `channels` / `bootstrap` / `selfIdentity` 三个 key**，
 * `channelConversations` 不在其中。实测日志（新环境首次授权）：
 *
 *     warn | channel conversation list failed | 还没绑定渠道身份…   ×3
 *     info | channel login start
 *     info | channel identity bound
 *
 * 三次失败全在授权之前，之后一次都没再拉过 —— 用户看到一个永远空的会话
 * 列表，而采集其实在正常跑。不报错，只是答错。
 *
 * ## ★ 判据是**全失效**而不是"再加一个 key"
 *
 * 列举必然再漏：上一次补的是 `selfIdentity`，这次是 `channelConversations`。
 * 授权改的不是几个字段，而是「能不能跑渠道命令」这道闸 —— 也就是所有要问
 * 渠道的查询。对照组是 `useSwitchChannelIdentity`（切身份），用的正是全失效。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { useAdoptSession, useStartChannelAuth } from "@renderer/lib/queries"

afterEach(cleanup)

function setup(impl: () => Promise<unknown>) {
  const api = {
    channels: { authStart: impl, adoptSession: impl },
  } as unknown as Window["mycontext"]
  ;(globalThis as { window?: { mycontext?: unknown } }).window ??= {}
  ;(window as unknown as { mycontext: unknown }).mycontext = api

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const spy = vi.spyOn(client, "invalidateQueries")
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { spy, wrapper }
}

/** 全失效 = 调用时不带 queryKey（带了就是列举，而列举必然漏）。 */
function assertFullInvalidation(spy: ReturnType<typeof vi.spyOn>): void {
  expect(spy).toHaveBeenCalled()
  const everyCallIsFull = spy.mock.calls.every(
    (call) => call[0] === undefined || (call[0] as { queryKey?: unknown }).queryKey === undefined,
  )
  expect(everyCallIsFull).toBe(true)
}

describe("★★ 授权后必须全失效（否则会话列表停在授权前那份空结果）", () => {
  /**
   * ★★★ 这条是那个 bug 的直接反面。
   * 反证：改回逐个列举那三个 key → 必红。
   */
  it("★★★ 授权成功 → invalidateQueries 不带 key（全失效）", async () => {
    const { spy, wrapper } = setup(() => Promise.resolve({ ok: true, data: {} }))
    const { result } = renderHook(() => useStartChannelAuth(), { wrapper })

    await act(async () => {
      result.current.mutate({ channelId: "dingtalk", mode: "loopback" })
    })

    await waitFor(() => expect(spy).toHaveBeenCalled())
    assertFullInvalidation(spy)
  })

  /**
   * ★★ 采纳本机登录态走同一条路 —— 它做的正是**落身份行**这一步，
   * 也就是解开 `identity_unbound` 那道闸。原来这里列了四个 key，
   * 同样漏掉会话列表。
   */
  it("★★ 采纳本机登录态 → 同样全失效", async () => {
    const { spy, wrapper } = setup(() => Promise.resolve({ ok: true, data: {} }))
    const { result } = renderHook(() => useAdoptSession(), { wrapper })

    await act(async () => {
      result.current.mutate()
    })

    await waitFor(() => expect(spy).toHaveBeenCalled())
    assertFullInvalidation(spy)
  })

  /**
   * ★★ **失败路径也要失效**（`onSettled` 而非 `onSuccess`）。
   *
   * 授权是分阶段的：`startLogin` 里 `onAuthorized` 抛错时，身份可能已经绑上
   * 而后续某一步失败。"失败就不刷新"会留下一个比刷新更糟的中间态 ——
   * 界面说未授权，而底层已经能跑渠道命令了。
   */
  it("★★ 授权失败 → 仍然失效", async () => {
    const { spy, wrapper } = setup(() => Promise.reject(new Error("boom")))
    const { result } = renderHook(() => useStartChannelAuth(), { wrapper })

    await act(async () => {
      result.current.mutate({ channelId: "dingtalk", mode: "loopback" })
    })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(spy).toHaveBeenCalled()
  })
})
