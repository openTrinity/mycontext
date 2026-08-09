/**
 * @vitest-environment jsdom
 *
 * 历史处理结果 → 点一条看那一轮的完整过程（`RunTraceDialog`）。
 *
 * ## 这一组锁的是三种状态必须**长得不一样**
 *
 * ```
 * runId 为 null            → 整行不可点（本来就不是 agent 生成的）
 * 有 runId 但 trace 为空   → 可点，弹窗里说"这一轮没有留下过程"
 * 有 runId 且有 trace      → 可点，弹窗里是完整过程
 * ```
 *
 * 中间那种把它显示成一片空白就等于让「没有」与「没加载出来」不可区分，
 * 而那正是本项目最怕的静默降级。
 *
 * ★★ 它**不该普遍出现**。曾经"实测 6 轮里 4 轮如此"被写进这个文件的注释
 * 并归因为"走了直连降级那条路"—— 那是**误判**：真实原因是 `appendTrace`
 * 的行主键不带 runId，重启后新轮次把旧轮次的痕迹整行改嫁走了（已修）。
 * 再次普遍出现时先查写入侧。
 *
 * ## ★ 还锁一条性能不变式：**没点开时一次库都不查**
 *
 * 历史面板一屏 20 条。各预取一遍 trace + 元信息是 40 次查询，
 * 而其中 19 条用户不会点开。这条断言"未点开 → runTrace/runDetail 调用数为 0"。
 *
 * ## ★★ 以及本次修复的那条：过程**不在列表里就地展开**
 *
 * 就地展开是「没法 scroll、看不全」的成因：这一栏住在一个有高度上限的
 * popover 里，外面还套着 `overflow-hidden` 的布局区，于是几十条 tool_call
 * 挤在几行里读不了。走原生 `<dialog>`（top layer，不受祖先 overflow 影响）
 * 才真的解决。所以有一条断言"点开后内容在 dialog 元素里"。
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

/**
 * jsdom 没实现 `<dialog>` 的 `showModal`/`close`（见 persona-thread 里同款）。
 *
 * ★ 补的是**最小**实现：只切 `open` 属性。真正的 top layer / 焦点陷阱 /
 * inert 背景是浏览器的事，测不到也不该在这里假装测到 ——
 * 这里要的只是"内容挂进了 dialog 元素"。
 */
const dialogProto = globalThis.HTMLDialogElement?.prototype as
  | (HTMLDialogElement & { showModal?: () => void; close?: () => void })
  | undefined
if (dialogProto !== undefined) {
  dialogProto.showModal ??= function showModal(this: HTMLDialogElement): void {
    this.setAttribute("open", "")
  }
  dialogProto.close ??= function close(this: HTMLDialogElement): void {
    this.removeAttribute("open")
  }
}

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

/** 记录两个通道各被调了几次 —— "没点开时不查库"那条靠它。 */
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

/** 那一行的可点入口（整行是一个 button，无障碍名里含正文）。 */
function rowButton(text = "收到，我看一下"): HTMLElement | null {
  return (
    [...document.querySelectorAll("button")].find((node) =>
      (node.textContent ?? "").includes(text),
    ) ?? null
  )
}

describe("★ 入口的有无", () => {
  /**
   * ★ `runId` 为 null → 整行不可点。
   *
   * 那是"用户自己写的"或升级前的旧记录，本来就没有过程可言。
   * 给一个点了只会说"没有过程"的入口，等于让用户白点一次才知道
   * 这里没东西 —— 而那与"有 run 但没留下 trace"是两种不同的事实。
   *
   * ★ 判据是"这一行不是 button"，而不是"文字不在了"：这一条容易被写成
   * 断言正文消失，但正文**必须**还在（不可看过程 ≠ 不显示这条历史）。
   */
  it("★ runId 为 null → 那一行不是可点的 button，但正文仍在", async () => {
    installApi()
    renderFeed([activity({ runId: null })])
    await waitFor(() => expect(screen.getByText("收到，我看一下")).toBeTruthy())
    expect(rowButton()).toBeNull()
  })

  it("有 runId → 整行可点", async () => {
    installApi()
    renderFeed([activity()])
    await waitFor(() => expect(rowButton()).toBeTruthy())
  })
})

describe("★★ 没点开时一次库都不查", () => {
  /**
   * 历史一屏 20 条，各预取 trace + 元信息是 40 次查询，而 19 条不会被点开。
   * 这条锁 `RunTraceDialog` 的 `open` → enabled 门控。
   */
  it("★★ 未点开 → runTrace 与 runDetail 都没被调用", async () => {
    const calls: Calls = { trace: 0, detail: 0 }
    installApi({ calls })
    renderFeed([
      activity({ id: "a1", text: "第一条" }),
      activity({ id: "a2", text: "第二条" }),
      activity({ id: "a3", text: "第三条" }),
    ])
    await waitFor(() => expect(rowButton("第一条")).toBeTruthy())
    // 给查询一点时间真的发出去（如果它会发的话）
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls.trace).toBe(0)
    expect(calls.detail).toBe(0)
  })

  it("点开之后才查（两个通道各一次）", async () => {
    const calls: Calls = { trace: 0, detail: 0 }
    installApi({ calls })
    renderFeed([activity()])
    await waitFor(() => expect(rowButton()).toBeTruthy())
    rowButton()?.click()
    await waitFor(() => expect(calls.trace).toBe(1))
    await waitFor(() => expect(calls.detail).toBe(1))
  })

  /**
   * ★ 关掉之后**不再**保持查询挂载。
   *
   * `Dialog` 的 children 只在 open 时挂载，而这里连组件本身都卸载 ——
   * 一屏 20 条各留一个挂着的 trace 查询就是原来那个性能问题的另一种形态。
   */
  it("★ 关掉弹窗 → 内容卸载（不是只是隐藏）", async () => {
    installApi({ trace: [], detail: null })
    renderFeed([activity()])
    await waitFor(() => expect(rowButton()).toBeTruthy())
    rowButton()?.click()
    await waitFor(() => expect(document.querySelector("dialog")).toBeTruthy())

    const close = [...document.querySelectorAll("button")].find(
      (node) => node.getAttribute("aria-label") === "关闭",
    )
    expect(close).toBeTruthy()
    close?.click()
    await waitFor(() => expect(document.querySelector("dialog")).toBeNull())
  })
})

describe("★★ 过程在一个独立弹窗里，不是列表内就地展开", () => {
  /**
   * ★★ 这条锁本次修复。
   *
   * 就地展开时那段过程被夹在 popover 的高度上限与祖先的 `overflow-hidden`
   * 之间，用户报的是「没法 scroll、看不全」。原生 `<dialog>` 在 top layer，
   * 不受祖先 overflow/z-index/transform 影响 —— 这是解决那个问题的手段本身，
   * 所以断言"内容真的在 dialog 里"。
   */
  it("★★ 点开后过程渲染在 <dialog> 元素内部", async () => {
    installApi({
      trace: [
        {
          id: "t1",
          seq: 1,
          role: "assistant",
          itemType: "message",
          contentJson: JSON.stringify([{ kind: "text", text: "我先查一下这个人最近说了什么" }]),
          toolName: null,
          toolStatus: null,
          turnId: null,
          createdAt: Date.parse("2026-08-06T11:59:00Z"),
        },
      ],
      detail: null,
    })
    renderFeed([activity()])
    await waitFor(() => expect(rowButton()).toBeTruthy())
    rowButton()?.click()

    await waitFor(() => {
      const dialog = document.querySelector("dialog")
      expect(dialog).toBeTruthy()
      expect(dialog?.textContent ?? "").toContain("我先查一下这个人最近说了什么")
    })
  })

  /**
   * ★★ 弹窗里**只有一个**滚动容器。
   *
   * 嵌套滚动容器正是原来"滚的是外层列表、过程只露三四行"的成因 ——
   * 在弹窗里重新引入一个（比如给触发消息或工具输出各加一个 max-h）
   * 就等于把 bug 搬了个家。
   *
   * 判据用 className 而不是 computed style：jsdom 没有布局引擎，
   * `scrollHeight`/`clientHeight` 恒为 0，量不到真实溢出。
   * 真浏览器里的那一半由 `check:persona-ui` 覆盖。
   */
  it("★★ 弹窗里只有一个 overflow-y-auto（不嵌套滚动容器）", async () => {
    installApi({ trace: [], detail: null })
    renderFeed([activity()])
    await waitFor(() => expect(rowButton()).toBeTruthy())
    rowButton()?.click()

    await waitFor(() => expect(document.querySelector("dialog")).toBeTruthy())
    const dialog = document.querySelector("dialog")
    const scrollers = [...(dialog?.querySelectorAll("*") ?? [])].filter((node) =>
      /overflow-y-auto|overflow-auto|overflow-y-scroll/.test(node.className.toString()),
    )
    expect(scrollers).toHaveLength(1)
  })
})

describe("★★ 「没有过程」与「没加载出来」必须可区分", () => {
  /**
   * ★★ 有 runId 但 trace 为空：显示一片空白的话，用户无从判断
   * 是"这轮没记"还是"读失败了"。
   */
  it("★★ trace 为空 → 明说「这一轮没有留下过程」，不是空白", async () => {
    installApi({ trace: [] })
    renderFeed([activity()])
    await waitFor(() => expect(rowButton()).toBeTruthy())
    rowButton()?.click()

    await waitFor(() => {
      expect(document.querySelector("dialog")?.textContent ?? "").toContain("没有留下过程")
    })
  })
})

describe("元信息：为什么会跑、判成了什么", () => {
  /**
   * ★ 触发消息回答"为什么这轮会跑" —— 而那是历史面板原来完全缺失的信息。
   */
  it("★ 点开后显示触发消息、判定与耗时", async () => {
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
    await waitFor(() => expect(rowButton()).toBeTruthy())
    rowButton()?.click()

    await waitFor(() => {
      const text = document.querySelector("dialog")?.textContent ?? ""
      expect(text).toContain("小李")
      expect(text).toContain("这个能帮忙看下吗")
      // 判定译名（不是裸的 drafted）
      expect(text).toContain("出草稿")
      // 耗时与 token（4615ms → 4.6s）
      expect(text).toContain("4.6")
      expect(text).toContain("15629")
    })
  })

  /**
   * ★ 未登记的 decision **原样显示机器码**，不套兜底词。
   * 兜底会把一个我们还没处理的新状态伪装成已知态（`run-log` 同口径）。
   */
  it("★ 未登记的 decision 原样显示，不套兜底文案", async () => {
    installApi({
      trace: [],
      detail: {
        runId: "run-1",
        decision: "some_new_decision",
        decisionReason: null,
        latencyMs: null,
        costTokens: null,
        error: null,
        trigger: null,
      },
    })
    renderFeed([activity()])
    await waitFor(() => expect(rowButton()).toBeTruthy())
    rowButton()?.click()

    await waitFor(() => {
      const text = document.querySelector("dialog")?.textContent ?? ""
      expect(text).toContain("some_new_decision")
      // 不该出现 i18n 的裸 key（那是"翻不到就显示 key"的形态）
      expect(text).not.toContain("decisions.")
    })
  })

  /**
   * ★ 查不到那一轮（老库 / 已被清理）→ **明说**，而不是不显示。
   * 不显示会让人以为"这条就是没有元信息"，而事实是"记录没了"。
   */
  it("★ runDetail 返回 null → 明说查不到", async () => {
    installApi({ trace: [], detail: null })
    renderFeed([activity()])
    await waitFor(() => expect(rowButton()).toBeTruthy())
    rowButton()?.click()

    await waitFor(() =>
      expect(document.querySelector("dialog")?.textContent ?? "").toContain("查不到"),
    )
  })
})
