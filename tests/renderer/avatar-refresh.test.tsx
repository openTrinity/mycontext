/**
 * @vitest-environment jsdom
 *
 * 头像的**刷新时机**。
 *
 * ## ★ 这里锁的是「列表一变，已经取到的头像不能闪没」
 *
 * `useContactAvatars` 的 `queryKey` 里含 id 列表（必须含 —— 这个 hook 有
 * 两个调用方：左栏的单聊对端与消息流的发送者，两批 id 完全不同，
 * 不含的话它们会互相覆盖对方的结果）。
 *
 * 代价是：**列表一变就是另一个 query**。而这一页的会话列表由快照推送驱动
 * （`usePersonaSnapshot` 每收到一次推送就 invalidate 会话列表，推送节流
 * 250ms），列表里又带着 `lastMessageAt` / `unreadForPersona` 这种随消息变的
 * 字段 —— 活跃时段几秒就变一次。
 *
 * 没有 `placeholderData` 时那一帧的 `data` 是 `undefined`：界面上**所有**
 * 头像同时消失、退回首字母色块，然后重取整批。这就是"会话列表里的头像
 * 刷新时机有问题"的形态。
 *
 * `staleTime` 挡不住这个 —— 它只在**同一个 key** 内生效。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { useContactAvatars } from "@renderer/lib/queries"

afterEach(cleanup)

interface AvatarRow {
  externalId: string
  path: string | null
  missReason: string | null
}

/** 装一个会记调用次数的 `media.avatars`，每个 id 都返回一张图。 */
function installAvatarApi(): { calls: string[][] } {
  const calls: string[][] = []
  ;(globalThis as { window?: unknown }).window ??= {}
  ;(window as unknown as { mycontext: Record<string, unknown> }).mycontext = {
    media: {
      avatars: (input: { externalIds: string[] }) => {
        calls.push([...input.externalIds])
        const data: AvatarRow[] = input.externalIds.map((id) => ({
          externalId: id,
          path: `mycontext-file://local/tmp/${id}.jpg`,
          missReason: null,
        }))
        return Promise.resolve({ ok: true as const, data })
      },
    },
  }
  return { calls }
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const NICKS = { DeA: "小李", DeB: "小王", DeC: "小张" }

describe("★ 会话列表变化时头像不能闪没", () => {
  it("新会话进来（ids 多一个）→ 已取到的头像仍在，不退回首字母", async () => {
    installAvatarApi()
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useContactAvatars(ids, null, NICKS),
      { wrapper, initialProps: { ids: ["DeA", "DeB"] } },
    )
    await waitFor(() => {
      expect(result.current.data?.length).toBe(2)
    })

    // 快照推送 → 会话列表 invalidate → 多了一个单聊对端
    rerender({ ids: ["DeA", "DeB", "DeC"] })

    /**
     * ★ 关键断言：**这一帧**就要有数据。
     *
     * 没有 `placeholderData: keepPreviousData` 时这里是 `undefined`
     * （实测过），于是界面上三个头像一起变成首字母色块。
     */
    expect(result.current.data).toBeDefined()
    expect(result.current.data?.length).toBe(2)

    // 新的那个取到之后一起出现
    await waitFor(() => {
      expect(result.current.data?.length).toBe(3)
    })
  })

  it("会话消失（ids 少一个）→ 剩下的头像也不闪", async () => {
    installAvatarApi()
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useContactAvatars(ids, null, NICKS),
      { wrapper, initialProps: { ids: ["DeA", "DeB", "DeC"] } },
    )
    await waitFor(() => {
      expect(result.current.data?.length).toBe(3)
    })
    rerender({ ids: ["DeA", "DeB"] })
    expect(result.current.data).toBeDefined()
  })

  it("★ ids 顺序变了不算变（排序后进 key，否则会重取整批）", async () => {
    const { calls } = installAvatarApi()
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useContactAvatars(ids, null, NICKS),
      { wrapper, initialProps: { ids: ["DeA", "DeB"] } },
    )
    await waitFor(() => {
      expect(result.current.data?.length).toBe(2)
    })
    /**
     * 会话列表按 `last_message_at` 排序 —— 来一条新消息顺序就变。
     * 不排序进 key 的话每次重排都是一个新 query，
     * 于是整批头像重取（每个 2-3 次子进程调用）。
     */
    rerender({ ids: ["DeB", "DeA"] })
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1)
    })
  })
})
