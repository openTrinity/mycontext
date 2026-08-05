/**
 * @vitest-environment jsdom
 *
 * 配完模型之后，「配了模型没有」这件事必须**立刻**在界面上变。
 *
 * ## ★★ 这一组防的是一个打包态实测到的谎
 *
 * 引导第 2 步「配置模型」已经打勾、主进程日志里
 * ```
 * 11:17:19  llm holder reconfigured {"model": "qwen3.7-plus"}
 * 11:17:19  gateway changed; restarting kl-server
 * 11:17:22  kl-server ready
 * ```
 * 三条都跑完了，而第 5 步仍然显示
 * 「没配模型 —— 抽取型任务会失败。去『设置 → 高级』配 LLM。」
 *
 * 根因：那个横幅的判据是 `personaSnapshot.agentAvailable`
 * （`onboarding-view` 传给 `DistillStep` 的 `modelConfigured`），而
 * `useSaveRuntimeConfig` 的 `onSuccess` 只失效了 `runtimeConfig` /
 * `advancedAi` 两个 key —— 那份快照一直是**启动那一刻**的（`false`）。
 *
 * 连带的谎更具体：同一页那句「配好模型后**下次启动**会自动整理」也来自这份
 * 过期快照，于是用户以为必须重启；而实际上 kl 早已带着新网关跑着，点
 * 「开始学习」就会立刻建图（实测 forge 跑完到 `graph build started` 0 秒）。
 *
 * ## 为什么必须测
 *
 * 这类"漏了一个 invalidate"的 bug **没有任何报错**，而且只在"保存配置"与
 * "读那个快照"是**两个组件**时显形 —— 日常开发在设置页里改配置看不出问题
 * （那一页不读 personaSnapshot）。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { useRuntimeConfigSync, useSaveRuntimeConfig } from "@renderer/lib/queries"

afterEach(cleanup)

/**
 * 装一份最小的 `window.mycontext`。
 *
 * `onChanged` 把监听者存下来，测试用 `fire()` 模拟主进程广播 ——
 * 那正是真实路径（主进程 `runtimeConfig.onChange` 里 `send`）。
 */
function installApi(): { fire: () => void; saved: unknown[] } {
  const listeners: Array<() => void> = []
  const saved: unknown[] = []
  ;(globalThis as { window?: unknown }).window ??= {}
  ;(window as unknown as { mycontext: Record<string, unknown> }).mycontext = {
    runtimeConfig: {
      save: (input: unknown) => {
        saved.push(input)
        return Promise.resolve({ ok: true as const, data: { applied: [], needsRestart: [] } })
      },
      onChanged: (listener: () => void) => {
        listeners.push(listener)
        return () => {
          const i = listeners.indexOf(listener)
          if (i >= 0) listeners.splice(i, 1)
        }
      },
    },
  }
  return {
    fire: () => {
      for (const l of [...listeners]) l()
    },
    saved,
  }
}

/** 记下每个 key 被失效了几次 —— 断言的就是这个。 */
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

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

/** `QUERY_KEYS.personaSnapshot` / `distillProgress` 的字面值（见 queries.ts）。 */
const PERSONA_SNAPSHOT = JSON.stringify(["persona", "snapshot"])
const DISTILL_PROGRESS = JSON.stringify(["distill", "progress"])
const RUNTIME_CONFIG = JSON.stringify(["runtime-config"])

describe("★★ 保存网关后要失效「配了模型没有」的消费方", () => {
  it("★★ personaSnapshot 被失效（漏了它 = 引导页横幅说谎）", async () => {
    const api = installApi()
    const { client, invalidated } = trackingClient()
    const { result } = renderHook(() => useSaveRuntimeConfig(), {
      wrapper: makeWrapper(client),
    })

    result.current.mutate({ llmBaseUrl: "https://gw", llmApiKey: "sk-x" })
    await waitFor(() => {
      expect(api.saved).toHaveLength(1)
    })

    await waitFor(() => {
      // ★★ 这一条就是那个 bug：原来只失效 runtimeConfig / advancedAi
      expect(invalidated).toContain(PERSONA_SNAPSHOT)
    })
  })

  it("★ distillProgress 也要失效（forge.available 随模型配置变）", async () => {
    const api = installApi()
    const { client, invalidated } = trackingClient()
    const { result } = renderHook(() => useSaveRuntimeConfig(), {
      wrapper: makeWrapper(client),
    })

    result.current.mutate({ llmBaseUrl: "https://gw", llmApiKey: "sk-x" })
    await waitFor(() => {
      expect(api.saved).toHaveLength(1)
    })
    await waitFor(() => {
      expect(invalidated).toContain(DISTILL_PROGRESS)
    })
  })

  it("★ 原有的两个 key 不能丢（设置页与高级面板读它）", async () => {
    const api = installApi()
    const { client, invalidated } = trackingClient()
    const { result } = renderHook(() => useSaveRuntimeConfig(), {
      wrapper: makeWrapper(client),
    })

    result.current.mutate({ llmBaseUrl: "https://gw", llmApiKey: "sk-x" })
    await waitFor(() => {
      expect(api.saved).toHaveLength(1)
    })
    await waitFor(() => {
      expect(invalidated).toContain(RUNTIME_CONFIG)
    })
  })
})

/**
 * ★★ 主进程广播 `runtimeConfigChanged` 时也要失效 —— 不只在"本地点了保存"时。
 *
 * `useSaveRuntimeConfig` 的 `onSuccess` 只覆盖"在这个渲染进程里点了保存"，
 * 而主进程在**每次** `runtimeConfig.save()` 之后都广播（startup.ts 的
 * `onChange`）。挂在 App 级订阅一次比让每个消费方各自记得失效可靠。
 */
describe("★★ 订阅主进程广播（useRuntimeConfigSync）", () => {
  it("★★ 收到广播 → 失效 personaSnapshot 与 distillProgress", async () => {
    const api = installApi()
    const { client, invalidated } = trackingClient()
    renderHook(() => useRuntimeConfigSync(), { wrapper: makeWrapper(client) })

    // 订阅装好之前不该有任何失效
    expect(invalidated).toHaveLength(0)

    api.fire() // 模拟主进程 send(runtimeConfigChanged)

    await waitFor(() => {
      expect(invalidated).toContain(PERSONA_SNAPSHOT)
    })
    expect(invalidated).toContain(DISTILL_PROGRESS)
    expect(invalidated).toContain(RUNTIME_CONFIG)
  })

  /**
   * ★ 卸载后要退订 —— 不退的话 App 重挂载（切主题/换语言触发的重渲染链）
   * 会叠加监听者，一次广播失效 N 次。那不会报错，只是白刷网络与库。
   */
  it("★ 卸载后不再响应广播", async () => {
    const api = installApi()
    const { client, invalidated } = trackingClient()
    const { unmount } = renderHook(() => useRuntimeConfigSync(), {
      wrapper: makeWrapper(client),
    })

    api.fire()
    await waitFor(() => {
      expect(invalidated).toContain(PERSONA_SNAPSHOT)
    })
    const countAfterFirst = invalidated.length

    unmount()
    api.fire()

    // 卸载后那一发不该产生任何新的失效
    expect(invalidated).toHaveLength(countAfterFirst)
  })
})
