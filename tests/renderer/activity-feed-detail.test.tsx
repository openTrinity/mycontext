/**
 * @vitest-environment jsdom
 *
 * 历史处理结果的「看处理过程」详情。
 *
 * ## 这一组锁的是三种状态必须**长得不一样**
 *
 * ```
 * runId 为 null            → 不给入口（本来就不是 agent 生成的）
 * 有 runId 但 trace 为空   → 给入口，展开说"这一轮没有留下过程"
 * 有 runId 且有 trace      → 给入口，展开是完整过程
 * ```
 *
 * 中间那种是**常态**（实测本机 6 轮里 4 轮如此 —— 走了直连降级那条路）。
 * 把它显示成一片空白就等于让「没有」与「没加载出来」不可区分，
 * 而那正是本项目最怕的静默降级。
 *
 * ## ★ 还锁一条性能不变式：**收起时一次库都不查**
 *
 * 历史面板一屏 20 条。各预取一遍 trace + 元信息是 40 次查询，
 * 而其中 19 条用户不会展开。这条断言"未展开 → runTrace/runDetail 调用数为 0"。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { I18nextProvider } from "react-i18next"
import { createI18n } from "@mycontext/i18n"
import type { MyContextApi, PersonaActivityView } from "@mycontext/ipc-contract"
import { ActivityFeed } from "@renderer/features/persona/activity-feed"

afterEach(cleanup)

/** jsdom 没有 ResizeObserver，而某些组件走 useSquircle 会用它。 */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver

function activity(overrides: Partial<PersonaActivityView> = {}): PersonaActivityView {
  return {
    id: "act-1",
    conversationId: "conv-1",
    kind: "auto_sent",
    text: "收到，我看一下",
    occurredAt: Date.parse("2026-08-06T12:00:00Z"),
    runId: "run-1",
    ...overrides,
  }
}

/** 记录两个通道各被调了几次 —— "收起时不查库"那条靠它。 */
interface Calls {
  trace: number
  detail: number
}

function installApi(options: { trace?: unknown[]; detail?: unknown; calls?: Calls } = {}): void {
  const calls = options.calls ?? { trace: 0, detail: 0 }
  const api = {
    persona: {
      runTrace: () => {
        calls.trace += 1
        return Promise.resolve({ ok: true as const, data: options.trace ?? [] })
      },
      runDetail: () => {
        calls.detail += 1
        return Promise.resolve({ ok: true as const, data: options.detail ?? null })
      },
    },
  } as unknown as MyContextApi
  ;(globalThis as { window?: { mycontext?: MyContextApi } }).window ??= {}
  ;(window as unknown as { mycontext: MyContextApi }).mycontext = api
}

function renderFeed(activities: readonly PersonaActivityView[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <I18nextProvider i18n={createI18n("zh")}>
      <QueryClientProvider client={client}>
        <ActivityFeed activities={activities} />
      </QueryClientProvider>
    </I18nextProvider>,
  )
}

describe("★ 入口的有无", () => {
  /**
   * ★ `runId` 为 null → 不给入口。
   *
   * 那是"用户自己写的"或升级前的旧记录，本来就没有过程可言。
   * 给一个点了只会说"没有过程"的按钮，等于让用户白点一次才知道
   * 这里没东西 —— 而那与"有 run 但没留下 trace"是两种不同的事实。
   */
  it("★ runId 为 null → 不渲染「看处理过程」", async () => {
    installApi()
    renderFeed([activity({ runId: null })])
    await waitFor(() => expect(screen.getByText("收到，我看一下")).toBeTruthy())
    expect(screen.queryByRole("button", { name: "看生成过程" })).toBeNull()
  })

  it("有 runId → 渲染入口", async () => {
    installApi()
    renderFeed([activity()])
    await waitFor(() => expect(screen.getByRole("button", { name: "看生成过程" })).toBeTruthy())
  })
})

describe("★★ 收起时一次库都不查", () => {
  /**
   * 历史一屏 20 条，各预取 trace + 元信息是 40 次查询，而 19 条不会被展开。
   * 这条锁 `enabled` 门控（`RunTraceDisclosure` 与 `usePersonaRunDetail`）。
   */
  it("★★ 未展开 → runTrace 与 runDetail 都没被调用", async () => {
    const calls: Calls = { trace: 0, detail: 0 }
    installApi({ calls })
    renderFeed([activity({ id: "a1" }), activity({ id: "a2" }), activity({ id: "a3" })])
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "看生成过程" })).toHaveLength(3),
    )
    // 给查询一点时间真的发出去（如果它会发的话）
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls.trace).toBe(0)
    expect(calls.detail).toBe(0)
  })

  it("展开之后才查（两个通道各一次）", async () => {
    const calls: Calls = { trace: 0, detail: 0 }
    installApi({ calls })
    renderFeed([activity()])
    await waitFor(() => expect(screen.getByRole("button", { name: "看生成过程" })).toBeTruthy())
    screen.getByRole("button", { name: "看生成过程" }).click()
    await waitFor(() => expect(calls.trace).toBe(1))
    await waitFor(() => expect(calls.detail).toBe(1))
  })
})

describe("★★ 「没有过程」与「没加载出来」必须可区分", () => {
  /**
   * ★★ 这条是本组最重要的。
   *
   * 有 runId 但 trace 为空是**常态**（走了直连降级那条路、或升级前生成）。
   * 显示一片空白的话，用户无从判断是"这轮没记"还是"读失败了"。
   */
  it("★★ trace 为空 → 明说「这一轮没有留下过程」，不是空白", async () => {
    installApi({ trace: [] })
    renderFeed([activity()])
    await waitFor(() => expect(screen.getByRole("button", { name: "看生成过程" })).toBeTruthy())
    screen.getByRole("button", { name: "看生成过程" }).click()

    await waitFor(() => {
      const text = document.body.textContent ?? ""
      expect(text).toContain("没有留下过程")
    })
  })
})

describe("元信息：为什么会跑、判成了什么", () => {
  /**
   * ★ 触发消息回答"为什么这轮会跑" —— 而那是历史面板原来完全缺失的信息。
   */
  it("★ 展开后显示触发消息与判定", async () => {
    installApi({
      trace: [],
      detail: {
        runId: "run-1",
        decision: "drafted",
        decisionReason: null,
        latencyMs: 4615,
        costTokens: 15_629,
        error: null,
        trigger: { senderDisplayName: "小李", contentText: "这个能帮忙看下吗" },
      },
    })
    renderFeed([activity()])
    await waitFor(() => expect(screen.getByRole("button", { name: "看生成过程" })).toBeTruthy())
    screen.getByRole("button", { name: "看生成过程" }).click()

    await waitFor(() => {
      const text = document.body.textContent ?? ""
      expect(text).toContain("小李")
      expect(text).toContain("这个能帮忙看下吗")
      // 耗时与 token（4615ms → 4.6s）
      expect(text).toContain("4.6")
      expect(text).toContain("15629")
    })
  })

  /**
   * ★ 查不到那一轮（老库 / 已被清理）→ **明说**，而不是不显示。
   * 不显示会让人以为"这条就是没有元信息"，而事实是"记录没了"。
   */
  it("★ runDetail 返回 null → 明说查不到", async () => {
    installApi({ trace: [], detail: null })
    renderFeed([activity()])
    await waitFor(() => expect(screen.getByRole("button", { name: "看生成过程" })).toBeTruthy())
    screen.getByRole("button", { name: "看生成过程" }).click()

    await waitFor(() => expect(document.body.textContent ?? "").toContain("查不到"))
  })
})
