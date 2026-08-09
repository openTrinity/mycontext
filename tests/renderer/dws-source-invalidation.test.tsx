/**
 * @vitest-environment jsdom
 *
 * 换渠道客户端（自备 dws）之后，界面状态必须跟着变。
 *
 * ## 这一组锁的是「换了客户端，界面要重启才认」
 *
 * 主进程侧本来就做对了（`register.ts` 的 `dwsSourceSave`）：保存后调
 * `dataPlane.clearBlocked()` 解除采集的终态闸，注释里写着理由 ——
 * 换 binary 正是"我在修这个连不上的问题"的信号，而它真的可能修好。
 *
 * 而渲染层只失效了 `dwsSource` + `channels` 两个 key，**漏掉了受影响最大
 * 的那些**：`ingest`（blocked 刚被清）、`selfIdentity`、`adoptableSession`、
 * `status`、`channelIdentities`。
 *
 * 后果是用户报的那件事：换了客户端，界面上「采集未运行 / 身份未确认」
 * 一个都不变，要重启应用才认。
 *
 * ★ 判据是**全失效**而不是"那 5 个 key 也失效"：列举必然再漏，
 * 而换底层影响的面本来就是"几乎所有渠道相关的东西"。对照组是
 * `useSwitchChannelIdentity`（切身份），它用的正是全失效。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { useSaveDwsSource } from "@renderer/lib/queries"

afterEach(cleanup)

function install(save: () => Promise<unknown>): void {
  const api = { dwsSource: { save } } as unknown as Window["mycontext"]
  ;(globalThis as { window?: { mycontext?: unknown } }).window ??= {}
  ;(window as unknown as { mycontext: unknown }).mycontext = api
}

/**
 * 建一个带 spy 的 client。
 *
 * ★ spy 在 `invalidateQueries` 上而不是数各个 query 重取了几次：
 * 后者要先把十几个 query 都挂起来才能观察，而我们要锁的恰恰是
 * "调用方没有列举 key" 这件事本身。
 */
function setup(save: () => Promise<unknown>) {
  install(save)
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const spy = vi.spyOn(client, "invalidateQueries")
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, spy, wrapper }
}

describe("★★ 换自备 dws 后必须全失效", () => {
  /**
   * ★★ 这条是那个 bug 的直接反面。
   *
   * 判据：`invalidateQueries` 被调用，且**不带 queryKey** —— 带 key 就是
   * 列举，而列举必然漏。反证：改回只失效 dwsSource/channels → 红。
   */
  it("★★ 保存成功 → invalidateQueries 不带 key（全失效）", async () => {
    const { spy, wrapper } = setup(() => Promise.resolve({ ok: true, data: {} }))
    const { result } = renderHook(() => useSaveDwsSource(), { wrapper })

    await act(async () => {
      result.current.mutate({ path: "/opt/vendor-cli/dws" })
    })

    await waitFor(() => expect(spy).toHaveBeenCalled())
    // 全失效 = 调用时不传 filters（或传空）
    const args = spy.mock.calls.at(-1)?.[0]
    expect(args === undefined || args.queryKey === undefined).toBe(true)
  })

  /**
   * ★★ **失败路径也要失效** —— 这条锁 `onSettled` 而不是 `onSuccess`。
   *
   * 主进程是先 save 再 `clearBlocked()`，所以即便 save 抛错，状态也可能
   * 已经变了一半。"失败就不刷新"会留下一个比刷新更糟的中间态：
   * 界面显示的是保存前的值，而底层已经换了。
   */
  it("★★ 保存失败 → 仍然失效（onSettled 而非 onSuccess）", async () => {
    const { spy, wrapper } = setup(() => Promise.reject(new Error("boom")))
    const { result } = renderHook(() => useSaveDwsSource(), { wrapper })

    await act(async () => {
      result.current.mutate({ path: "/opt/vendor-cli/dws" })
    })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(spy).toHaveBeenCalled()
  })
})
