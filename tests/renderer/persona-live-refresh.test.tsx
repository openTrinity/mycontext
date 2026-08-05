/**
 * @vitest-environment jsdom
 *
 * Persona 快照是这一页的实时刷新信号。收到它时，当前会话的消息与处理结果
 * 必须一起刷新；否则用户只能靠切换会话制造一个新 query 才能看到新内容。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { usePersonaActivities, usePersonaMessages, usePersonaSnapshot } from "@renderer/lib/queries"
import type { PersonaSnapshotView } from "@mycontext/ipc-contract"

afterEach(cleanup)

const SNAPSHOT: PersonaSnapshotView = {
  running: true,
  agentAvailable: true,
  degradedReason: null,
  killSwitch: false,
  autoReplyCount: 1,
  pendingInbox: 0,
  pendingDrafts: 0,
  residents: [],
  maxResident: 8,
  /**
   * 正在生成的那几条。空数组 = 没有在生成的会话。
   *
   * 这一行是契约里新加的必填字段（`personaSnapshotSchema.generating`），
   * 而这些用例验的是"推送来的快照能不能刷新界面"，与生成态无关 ——
   * 给一个明确的空数组，而不是让类型检查红着。
   */
  generating: [],
}

describe("数字分身实时刷新", () => {
  it("收到快照后刷新当前会话消息与处理结果", async () => {
    const subscription: { listener: ((snapshot: PersonaSnapshotView) => void) | null } = {
      listener: null,
    }
    let messageCalls = 0
    let activityCalls = 0

    ;(globalThis as { window?: unknown }).window ??= {}
    ;(window as unknown as { mycontext: Record<string, unknown> }).mycontext = {
      persona: {
        snapshot: () => Promise.resolve({ ok: true as const, data: SNAPSHOT }),
        onSnapshot: (next: (snapshot: PersonaSnapshotView) => void) => {
          subscription.listener = next
          return () => {
            subscription.listener = null
          }
        },
        conversations: () => Promise.resolve({ ok: true as const, data: [] }),
        drafts: () => Promise.resolve({ ok: true as const, data: [] }),
        messages: () => {
          messageCalls += 1
          return Promise.resolve({ ok: true as const, data: [] })
        },
        activities: () => {
          activityCalls += 1
          return Promise.resolve({ ok: true as const, data: [] })
        },
      },
    }

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )

    renderHook(
      () => {
        usePersonaSnapshot()
        usePersonaMessages("conv-1")
        usePersonaActivities("conv-1")
      },
      { wrapper },
    )

    await waitFor(() => {
      expect(messageCalls).toBe(1)
      expect(activityCalls).toBe(1)
      expect(subscription.listener).not.toBeNull()
    })

    subscription.listener?.(SNAPSHOT)

    await waitFor(() => {
      expect(messageCalls).toBe(2)
      expect(activityCalls).toBe(2)
    })
  })
})
