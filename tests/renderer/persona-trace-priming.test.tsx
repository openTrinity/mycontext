/**
 * @vitest-environment jsdom
 *
 * `usePersonaTrace` 挂载时先拉一次 in-flight 快照，再接增量。
 *
 * ## ★★ 这一组防的是用户报的 bug
 *
 * "数字分身里正在起草的消息没持久化下来，下次查看就看不到生成历史了。"
 *
 * `onTrace` 是纯**增量流**。会话切走再回来、或组件重新挂载时，订阅是从零开始的：
 * 那一轮生成中途已经流过的内容不会重播，于是"正在起草"的消息看起来丢了。
 *
 * 修法：挂载时先调 `persona.liveTrace({conversationId})` 把主进程留着的
 * "到目前为止"补齐。这一组断言那一次补齐真的发生，且不会把随后到来的增量盖掉。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, renderHook, waitFor, act } from "@testing-library/react"
import { usePersonaTrace } from "@renderer/lib/queries"
import type { PersonaTraceEvent, PersonaTraceItem } from "@mycontext/ipc-contract"

afterEach(cleanup)

function item(id: string, text: string): PersonaTraceItem {
  return {
    id,
    seq: Number(id.replace(/\D/g, "")) || 0,
    role: "assistant",
    itemType: "message",
    contentJson: JSON.stringify({ text }),
    toolName: null,
    toolStatus: null,
    turnId: "t1",
    createdAt: 1,
  }
}

/**
 * 装 window.mycontext.persona：liveTrace 返回一份 in-flight 快照，
 * onTrace 把监听者存下来，测试用 fire() 模拟主进程后续推送。
 */
function installApi(liveItems: PersonaTraceItem[]): {
  fire: (event: PersonaTraceEvent) => void
  liveCalls: Array<{ conversationId: string }>
} {
  const listeners: Array<(e: PersonaTraceEvent) => void> = []
  const liveCalls: Array<{ conversationId: string }> = []
  ;(globalThis as { window?: unknown }).window ??= {}
  ;(window as unknown as { mycontext: Record<string, unknown> }).mycontext = {
    persona: {
      liveTrace: (input: { conversationId: string }) => {
        liveCalls.push(input)
        return Promise.resolve({ ok: true as const, data: { items: liveItems, done: false } })
      },
      onTrace: (listener: (e: PersonaTraceEvent) => void) => {
        listeners.push(listener)
        return () => {
          const i = listeners.indexOf(listener)
          if (i >= 0) listeners.splice(i, 1)
        }
      },
    },
  }
  return {
    fire: (event) => {
      for (const l of [...listeners]) l(event)
    },
    liveCalls,
  }
}

describe("★★ usePersonaTrace 挂载补齐 in-flight 快照（修起草中途切走就丢）", () => {
  it("★★ 还没有任何增量推送时，先用 liveTrace 快照把'到目前为止'补上", async () => {
    const api = installApi([item("i1", "已经起草了一半")])
    const { result } = renderHook(() => usePersonaTrace("conv-a"))

    // 挂载即拉快照，且带对了会话
    await waitFor(() => expect(api.liveCalls).toEqual([{ conversationId: "conv-a" }]))
    // 快照内容补进来了 —— 而这一刻一次 onTrace 增量都还没来
    await waitFor(() => expect(result.current.items).toHaveLength(1))
    expect(result.current.items[0]?.id).toBe("i1")
  })

  it("★ 已经收到增量后，晚到的快照不能把新内容盖回旧的", async () => {
    // liveTrace 故意慢：先让增量到达，再让快照 resolve
    let resolveLive: ((v: unknown) => void) | null = null
    const listeners: Array<(e: PersonaTraceEvent) => void> = []
    ;(globalThis as { window?: unknown }).window ??= {}
    ;(window as unknown as { mycontext: Record<string, unknown> }).mycontext = {
      persona: {
        liveTrace: () =>
          new Promise((resolve) => {
            resolveLive = resolve
          }),
        onTrace: (listener: (e: PersonaTraceEvent) => void) => {
          listeners.push(listener)
          return () => undefined
        },
      },
    }
    const { result } = renderHook(() => usePersonaTrace("conv-a"))

    // 增量先到（比快照新）
    act(() => {
      for (const l of listeners)
        l({ conversationId: "conv-a", items: [item("i2", "最新的增量")], done: false })
    })
    expect(result.current.items[0]?.id).toBe("i2")

    // 快照姗姗来迟（内容是更旧的）
    await act(async () => {
      resolveLive?.({ ok: true, data: { items: [item("i1", "旧快照")], done: false } })
      await Promise.resolve()
    })

    // ★ 不能被旧快照盖回去
    expect(result.current.items[0]?.id).toBe("i2")
  })

  it("切换会话先清空，再对新会话拉快照", async () => {
    const api = installApi([])
    const { rerender } = renderHook(({ id }) => usePersonaTrace(id), {
      initialProps: { id: "conv-a" },
    })
    await waitFor(() => expect(api.liveCalls).toContainEqual({ conversationId: "conv-a" }))
    rerender({ id: "conv-b" })
    await waitFor(() => expect(api.liveCalls).toContainEqual({ conversationId: "conv-b" }))
  })
})
