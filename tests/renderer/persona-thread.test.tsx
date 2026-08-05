/**
 * @vitest-environment jsdom
 *
 * 数字人三栏的行为门禁（真渲染，不是源码文本断言）。
 *
 * ## 这里锁住的是四条**曾经缺失或很容易再弄坏**的行为
 *
 * 1. **同一人连发要合并、跨天要断开** —— 首版每条都带头像与名字，
 *    一屏 6 条；而群里连发五条是常态。合并之后一屏 20 条。
 *    跨天必须断开：「昨天 23:58 / 今天 00:01」合成一组在对话意义上是错的。
 * 2. **草稿可编辑，且只在真改过时传 `editedText`** —— `editedText` 早在
 *    schema 与 IPC 入参里，UI 没接（用户只能整条采用或整条丢弃，
 *    而真实使用中绝大多数是"意思对，改两个字"）。恒传的话每条都会被
 *    记成"用户编辑过"，那个字段之后要用来看模型原稿有多可用。
 * 3. **引用可点** —— `citations` 是真 message_id。这是用户判断
 *    "它是不是在瞎编"的唯一手段，而这一页最关键的信任问题就是那个。
 * 4. **原因说人话且分清能不能自己改** —— `grant_missing` 对用户没意义；
 *    更糟的是给它配一个"去改设置"的按钮（用户找不到那个开关，
 *    然后以为是自己的问题）。
 *
 * 用真渲染而不是读源码字符串：这四条都是**运行时行为**。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { I18nextProvider } from "react-i18next"
import { createI18n } from "@mycontext/i18n"
import type {
  PersonaConversationView,
  PersonaDraftView,
  PersonaMessageView,
} from "@mycontext/ipc-contract"
import { MessageThread } from "@renderer/features/persona/message-thread"
import { ReplyDock } from "@renderer/features/persona/reply-dock"
import { ConversationRail } from "@renderer/features/persona/conversation-rail"
import { ChannelBadge } from "@renderer/features/persona/channel-badge"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** jsdom 没有 ResizeObserver，而 Button/Avatar 走 useSquircle 会用它。 */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver

/** jsdom 没有滚动实现；消息定位只需要观察调用参数。 */
HTMLElement.prototype.scrollTo ??= function scrollTo(): void {}

/**
 * ★ 让「滚到了哪条消息」在 jsdom 里变得可观测。
 *
 * ## 为什么需要这么一层
 *
 * 实现刻意**不用** `scrollIntoView`（那个会连祖先一起推，表现是"点看引用
 * 后中间栏与整页先后跳两次"），而是在**中间栏自己的滚动容器**上算出
 * `top` 再 `container.scrollTo({top})`。于是"停在哪条"不再等于
 * "谁被调用了"，而是藏在那个 `top` 数字里。
 *
 * 而 jsdom 没有布局：所有 `getBoundingClientRect()` 全是 0，
 * 于是每条消息算出来的 `top` 都一样 —— 断言"停在 m2 而不是 m1"
 * 就恒真（**把功能删掉也通过**）。
 *
 * 所以给每个 `<li>` 造一份**可区分**的几何：第 i 条的 top = i*100。
 * 这样容器被滚到的 `top` 可以反查回是哪一条，"跳准了没有"才真的被锁住。
 *
 * @returns `calls` 每次滚动的容器/目标偏移/behavior；`rowTop` 反查用
 */
function installRowGeometry(): {
  calls: { top: number; behavior: string }[]
  /** 第 index 条消息（0 起）应当算出的容器 scrollTop */
  expectedTopFor: (index: number) => number
  restore: () => void
} {
  const ROW_HEIGHT = 100
  const VIEWPORT = 400
  /**
   * ★ 让第 0 条也有一个**非零**的期望值。
   *
   * 实现里有 `Math.max(0, top)`，而居中公式在靠前的几条上算出负数 ——
   * 于是 index 0 与 index 1 都被 clamp 成 0，"停在 m2 而不是 m1"
   * 就变成 `0 !== 0` 恒假（**功能删掉也通不过/也测不出**）。
   *
   * 把整个列表往下推半屏（每条的 top 加上 VIEWPORT），让所有候选的
   * 居中目标都落在正数区间，相邻两条的期望值因此真的可区分。
   */
  const ROW_OFFSET = VIEWPORT
  const calls: { top: number; behavior: string }[] = []

  const origRect = Element.prototype.getBoundingClientRect
  const origScrollTo = HTMLElement.prototype.scrollTo
  const origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight")

  Element.prototype.getBoundingClientRect = function patched(this: Element): DOMRect {
    const li = this.closest("li")
    if (li !== null && this === li) {
      const siblings = [...(li.parentElement?.children ?? [])]
      const index = siblings.indexOf(li)
      const top = ROW_OFFSET + index * ROW_HEIGHT
      return { top, height: ROW_HEIGHT, bottom: top + ROW_HEIGHT } as DOMRect
    }
    // 容器：视口从 0 起
    return { top: 0, height: VIEWPORT, bottom: VIEWPORT } as DOMRect
  }
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    value: VIEWPORT,
  })
  HTMLElement.prototype.scrollTo = function patched(
    this: HTMLElement,
    ...args: [ScrollToOptions?] | [number, number]
  ): void {
    const first = args[0]
    if (typeof first === "object" && first !== null) {
      calls.push({ top: first.top ?? 0, behavior: first.behavior ?? "auto" })
    }
  } as typeof HTMLElement.prototype.scrollTo

  return {
    calls,
    // 实现里的公式：scrollTop + targetTop - containerTop - clientHeight/2 + height/2
    expectedTopFor: (index) =>
      Math.max(0, ROW_OFFSET + index * ROW_HEIGHT - VIEWPORT / 2 + ROW_HEIGHT / 2),
    restore: () => {
      Element.prototype.getBoundingClientRect = origRect
      HTMLElement.prototype.scrollTo = origScrollTo
      if (origClientHeight === undefined) {
        delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight
      } else {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", origClientHeight)
      }
    },
  }
}

/**
 * jsdom 也没实现 `<dialog>` 的 `showModal`/`close`（大图弹窗要用）。
 *
 * 补一个最小实现：只维护 `open` 属性 —— 那正是我们要断言的东西
 * （"弹窗在不在 DOM 里且是打开的"）。真正的 top layer / 焦点陷阱
 * 是浏览器行为，不在这一层测。
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

/**
 * ★ 装 `window.mycontext` 的桩。
 *
 * `MessageThread` 现在会取头像（`media.avatars`）与下载媒体。
 * 不装的话它在渲染时就抛 —— 而抛出的表现是"整棵树白屏"，
 * 于是用例会以"正确的结论、错误的理由"失败。
 */
function installMediaApi(): void {
  ;(globalThis as { window?: { mycontext?: unknown } }).window ??= {}
  const existing = (window as unknown as { mycontext?: Record<string, unknown> }).mycontext ?? {}
  ;(window as unknown as { mycontext: Record<string, unknown> }).mycontext = {
    ...existing,
    media: {
      // 头像一律取不到 → 退回首字母色块（这些用例验的不是头像）
      avatars: () => Promise.resolve({ ok: true as const, data: [] }),
      download: () => Promise.resolve({ ok: true as const, data: { ok: true } }),
      /**
       * ★ 自动下载这一屏的媒体。
       *
       * 必须装：`MessageThread` 挂载时就会调它（这一屏有没下的媒体时）。
       * 不装的话 react-query 会把 `undefined is not a function` **吞掉** ——
       * 于是"自动下载压根没跑"在用例里看起来是通过的，
       * 正好是这个函数上面那段注释在警告的事。
       *
       * 默认返回 `downloaded: 0`：这些用例验的不是下载本身，
       * 而非 0 会触发 invalidate → 重查消息 → 又跑一遍。
       */
      downloadForMessages: () =>
        Promise.resolve({
          ok: true as const,
          data: { downloaded: 0, failed: 0, skipped: 0 },
        }),
    },
    /**
     * 草稿卡的署名读四步进度里的 persona 行。
     *
     * 不装的话 `useOnboardingSteps` 会打到 undefined 上 —— 而 react-query
     * 会把那个错误吞掉、署名静默回落到「数字人」。于是"名字没透出来"
     * 这个 bug 在用例里看起来是通过的。
     */
    onboarding: {
      steps: () =>
        Promise.resolve({
          ok: true as const,
          data: [
            {
              step: "persona",
              state: "done",
              payload: { name: "小小周", figureSeed: "小小周|0#0" },
              updatedAt: 0,
            },
          ],
        }),
    },
  }
}

function wrap(node: React.ReactElement) {
  installMediaApi()
  // retry 关掉：失败时立刻暴露，而不是让用例等三次重试
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <I18nextProvider i18n={createI18n("zh")}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </I18nextProvider>,
  )
}

const DAY_ONE = new Date(2026, 5, 3, 10, 0, 0).getTime()
const DAY_TWO = new Date(2026, 5, 4, 0, 1, 0).getTime()

function message(over: Partial<PersonaMessageView> & { id: string }): PersonaMessageView {
  return {
    senderDisplayName: "小李",
    senderExternalId: "DeOTHER",
    contentText: "正文",
    sentAt: DAY_ONE,
    isSelf: false,
    mentionsSelf: false,
    origin: "channel",
    quoted: null,
    media: [],
    // 缺省是"本人自己打的"；要角标的用例显式覆盖它
    agentSend: null,
    ...over,
  }
}

describe("★ 消息流：同一人合并 + 跨天断开", () => {
  it("切换会话后滚到底部，当前会话新增消息时平滑滚底", () => {
    installMediaApi()
    const scrollTo = vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(() => undefined)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(
      <MessageThread
        conversationId="conv-a"
        loading={false}
        messages={[message({ id: "m1", contentText: "第一句" })]}
      />,
      {
        wrapper: ({ children }) => (
          <I18nextProvider i18n={createI18n("zh")}>
            <QueryClientProvider client={client}>{children}</QueryClientProvider>
          </I18nextProvider>
        ),
      },
    )

    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "auto" })

    view.rerender(
      <MessageThread
        conversationId="conv-a"
        loading={false}
        messages={[
          message({ id: "m1", contentText: "第一句" }),
          message({ id: "m2", contentText: "新消息" }),
        ]}
      />,
    )
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "smooth" })

    view.rerender(
      <MessageThread
        conversationId="conv-b"
        loading={false}
        messages={[message({ id: "m3", contentText: "另一个会话的最新消息" })]}
      />,
    )
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "auto" })
  })

  it("查看引用只滚一次；引用高亮期间新消息不会再次拉动视口", () => {
    installMediaApi()
    const scrollTo = vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(() => undefined)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(
      <MessageThread
        conversationId="conv-a"
        loading={false}
        messages={[
          message({ id: "m1", contentText: "被引用" }),
          message({ id: "m2", contentText: "最新消息" }),
        ]}
        highlightIds={["m1"]}
      />,
      {
        wrapper: ({ children }) => (
          <I18nextProvider i18n={createI18n("zh")}>
            <QueryClientProvider client={client}>{children}</QueryClientProvider>
          </I18nextProvider>
        ),
      },
    )

    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "smooth" })

    view.rerender(
      <MessageThread
        conversationId="conv-a"
        loading={false}
        messages={[
          message({ id: "m1", contentText: "被引用" }),
          message({ id: "m2", contentText: "最新消息" }),
          message({ id: "m3", contentText: "刚收到的新消息" }),
        ]}
        highlightIds={["m1"]}
      />,
    )
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })

  it("同一人 5 分钟内连发三条 → 只出现一次发送者名", () => {
    wrap(
      <MessageThread
        loading={false}
        messages={[
          message({ id: "m1", contentText: "第一句", sentAt: DAY_ONE }),
          message({ id: "m2", contentText: "第二句", sentAt: DAY_ONE + 30_000 }),
          message({ id: "m3", contentText: "第三句", sentAt: DAY_ONE + 60_000 }),
        ]}
      />,
    )
    // 三条正文都在（合并不是"丢消息"）
    for (const text of ["第一句", "第二句", "第三句"]) {
      expect(screen.getByText(text)).toBeTruthy()
    }
    // 但发送者名只出现一次 —— 这就是合并
    expect(screen.getAllByText("小李")).toHaveLength(1)
  })

  it("★ 跨天必须断开：23:58 与次日 00:01 是两组", () => {
    wrap(
      <MessageThread
        loading={false}
        messages={[
          message({ id: "m1", contentText: "睡了", sentAt: DAY_TWO - 3 * 60_000 }),
          // 只隔 3 分钟（在合并窗口内），但跨了天
          message({ id: "m2", contentText: "早", sentAt: DAY_TWO }),
        ]}
      />,
    )
    /**
     * 时间上够近，可两条在对话意义上毫无关系 ——
     * 合并了会读成"他连着说了两句"。
     */
    expect(screen.getAllByText("小李")).toHaveLength(2)
  })

  it("不同人连发不合并（各自要有名字）", () => {
    wrap(
      <MessageThread
        loading={false}
        messages={[
          message({ id: "m1", senderDisplayName: "小李", sentAt: DAY_ONE }),
          message({ id: "m2", senderDisplayName: "小王", sentAt: DAY_ONE + 1000 }),
        ]}
      />,
    )
    expect(screen.getByText("小李")).toBeTruthy()
    expect(screen.getByText("小王")).toBeTruthy()
  })

  it("@我 标出来（mention 触发模式下唯一会触发数字人的那些）", () => {
    wrap(<MessageThread loading={false} messages={[message({ id: "m1", mentionsSelf: true })]} />)
    expect(screen.getByText("@我")).toBeTruthy()
  })

  it("空列表给下一步动作，不是一行灰字", () => {
    wrap(<MessageThread loading={false} messages={[]} />)
    // 空状态的两行：现状 + 怎么办
    expect(screen.getByText("这个会话还没有消息")).toBeTruthy()
    expect(screen.getByText("同步之后消息会出现在这里")).toBeTruthy()
  })
})

function draft(over: Partial<PersonaDraftView> = {}): PersonaDraftView {
  return {
    id: "d1",
    conversationId: "conv-a",
    text: "沙箱那边我下午确认一下",
    editedText: null,
    notSentReason: "grant_missing",
    citations: [],
    createdAt: DAY_ONE,
    ...over,
  }
}

describe("★ 草稿可编辑，且只在真改过时传 editedText", () => {
  it("没改过 → 不传 editedText", () => {
    const calls: Parameters<React.ComponentProps<typeof ReplyDock>["onResolve"]>[0][] = []
    wrap(
      <ReplyDock
        drafts={[draft()]}
        busy={false}
        errorText={null}
        generatingIds={[]}
        generatingSince={null}
        onCompose={() => undefined}
        onResolve={(input) => calls.push(input)}
        onShowCitations={() => undefined}
      />,
    )
    fireEvent.click(screen.getByText("发送"))
    expect(calls).toHaveLength(1)
    /**
     * 恒传 `editedText` 的话每条草稿都会被记成"用户编辑过"，
     * 而那个字段之后要用来判断"模型的原稿有多可用"。
     */
    expect(calls[0]).toEqual({ draftId: "d1", action: "send" })
  })

  it("★ 改过 → 传编辑后的正文（首版这条根本接不上）", () => {
    const calls: Parameters<React.ComponentProps<typeof ReplyDock>["onResolve"]>[0][] = []
    wrap(
      <ReplyDock
        drafts={[draft()]}
        busy={false}
        errorText={null}
        generatingIds={[]}
        generatingSince={null}
        onCompose={() => undefined}
        onResolve={(input) => calls.push(input)}
        onShowCitations={() => undefined}
      />,
    )
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "沙箱那边我晚点确认" } })
    // 改过之后按钮文案也要变 —— 否则用户不知道发出去的是哪一版
    fireEvent.click(screen.getByText("发送（用编辑后的）"))
    expect(calls[0]).toEqual({
      draftId: "d1",
      action: "send",
      editedText: "沙箱那边我晚点确认",
    })
  })

  it("正文被清空时发送按钮禁用（空消息发出去毫无意义）", () => {
    wrap(
      <ReplyDock
        drafts={[draft()]}
        busy={false}
        errorText={null}
        generatingIds={[]}
        generatingSince={null}
        onCompose={() => undefined}
        onResolve={() => undefined}
        onShowCitations={() => undefined}
      />,
    )
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } })
    /**
     * 清空算"改过"，所以按钮文案是编辑版的那个 —— 但它必须是禁用的。
     * 只判 `dirty` 不判空的话这里会是一个可点的按钮，
     * 点下去**真的**发出一条空消息（这条路现在是真发了）。
     */
    const send = screen.getByText("发送（用编辑后的）").closest("button")
    expect((send as HTMLButtonElement).disabled).toBe(true)
  })
})

describe("★ 正在处理完成后原地切成新草稿", () => {
  it("快照先结束、草稿列表后刷新时，不消失 tab，也不要求手动切换", async () => {
    installMediaApi()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const i18n = createI18n("zh")
    const props = {
      // 这条只测 tab 状态机，不需要订阅 agent trace。
      conversationId: null,
      busy: false,
      errorText: null,
      generatingSince: DAY_ONE,
      onCompose: () => undefined,
      onResolve: () => undefined,
      onShowCitations: () => undefined,
    }
    const dock = (drafts: readonly PersonaDraftView[], generatingIds: readonly string[]) => (
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={client}>
          <ReplyDock {...props} drafts={drafts} generatingIds={generatingIds} />
        </QueryClientProvider>
      </I18nextProvider>
    )
    const oldDraft = draft({ id: "old", text: "上一轮的草稿" })
    const view = render(dock([oldDraft], ["m1"]))

    fireEvent.click(screen.getByText("正在处理"))

    // 后端先推送 generating 结束；此时草稿 query 还没有返回新数据。
    view.rerender(dock([oldDraft], []))
    expect(screen.getByRole("tab", { name: "正在处理" }).getAttribute("aria-selected")).toBe("true")

    // 草稿随后到达：同一个区域应直接切到新草稿正文。
    view.rerender(
      dock(
        [oldDraft, draft({ id: "fresh", text: "这是刚拟好的回复", createdAt: DAY_ONE + 1 })],
        [],
      ),
    )

    await waitFor(() => {
      expect(screen.queryByRole("tab", { name: "正在处理" })).toBeNull()
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("这是刚拟好的回复")
      expect(screen.getByRole("tab", { name: "草稿 1" }).getAttribute("aria-selected")).toBe("true")
    })
  })

  /**
   * ★★ 看着旧草稿的历史时，新一轮生成完成 → 自动切到新草稿。
   *
   * 这修的是用户报的"正在查看生成的消息历史时，结束后不会自动跳转至草稿"。
   * 原来自动跳转只在 `active.kind === "generating"` 时做；用户若停在具体某条
   * 草稿 tab（看历史），新完成的草稿会被"旧草稿还在列表里"挡住，停着不动，
   * 看起来像没反应。
   */
  it("★★ 停在旧草稿看历史时，新一轮生成完成后自动切到新草稿", async () => {
    installMediaApi()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const i18n = createI18n("zh")
    const props = {
      conversationId: null,
      busy: false,
      errorText: null,
      generatingSince: DAY_ONE,
      onCompose: () => undefined,
      onResolve: () => undefined,
      onShowCitations: () => undefined,
    }
    const dock = (drafts: readonly PersonaDraftView[], generatingIds: readonly string[]) => (
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={client}>
          <ReplyDock {...props} drafts={drafts} generatingIds={generatingIds} />
        </QueryClientProvider>
      </I18nextProvider>
    )
    const oldDraft = draft({ id: "old", text: "上一轮的草稿" })

    // 一进来就停在旧草稿（默认选最新那条）；用户在读它的历史。
    const view = render(dock([oldDraft], []))
    expect(screen.getByRole("tab", { name: "草稿 1" }).getAttribute("aria-selected")).toBe("true")

    // 新一轮生成开始 —— 用户没动，仍停在旧草稿 tab。
    view.rerender(dock([oldDraft], ["m2"]))

    // 生成完成、新草稿到达。
    view.rerender(
      dock(
        [oldDraft, draft({ id: "fresh", text: "刚生成好的新回复", createdAt: DAY_ONE + 1 })],
        [],
      ),
    )

    // ★ 必须自动切到新草稿（它排最前 = 草稿 1），而不是停在旧草稿。
    await waitFor(() => {
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("刚生成好的新回复")
      expect(screen.getByRole("tab", { name: "草稿 1" }).getAttribute("aria-selected")).toBe("true")
    })
  })
})

describe("★ 引用可点：判断「是不是在瞎编」的唯一手段", () => {
  it("把真的 message_id 交出去", () => {
    const shown: string[][] = []
    wrap(
      <ReplyDock
        drafts={[draft({ citations: ["msg-7", "msg-9"] })]}
        busy={false}
        errorText={null}
        generatingIds={[]}
        generatingSince={null}
        onCompose={() => undefined}
        onResolve={() => undefined}
        onShowCitations={(ids) => shown.push([...ids])}
      />,
    )
    fireEvent.click(screen.getByText("看引用 2"))
    // 不是文本匹配猜的，是真 id —— 所以定位是可靠的
    expect(shown).toEqual([["msg-7", "msg-9"]])
  })

  it("没有引用时不显示这个按钮（点了没反应比没有更糟）", () => {
    wrap(
      <ReplyDock
        drafts={[draft({ citations: [] })]}
        busy={false}
        errorText={null}
        generatingIds={[]}
        generatingSince={null}
        onCompose={() => undefined}
        onResolve={() => undefined}
        onShowCitations={() => undefined}
      />,
    )
    expect(screen.queryByText(/看引用/)).toBeNull()
  })

  it("★ 只有被引用的那条拿到高亮底色（引用定位真的生效）", () => {
    wrap(
      <MessageThread
        loading={false}
        messages={[
          message({ id: "m1", contentText: "甲" }),
          message({ id: "m2", contentText: "乙" }),
        ]}
        highlightIds={["m2"]}
      />,
    )
    // 用底色 class 判断哪条被高亮 —— 那是这个功能的可见结果
    const highlighted = document.querySelectorAll("[class*='status-fill-warning-container']")
    expect(highlighted).toHaveLength(1)
    expect(highlighted[0]?.textContent).toContain("乙")
  })
})

describe("★ 原因说人话，且分清能不能自己改", () => {
  /**
   * ★ 这一条从「标成功能还没做 + 不给动作」翻过来了，理由记在这里。
   *
   * 授权入口已经做好（设置页「申请授权」→ `requestGrant`），所以正确的
   * 信息是"你点一下就能解决"。继续说"功能还没做"的代价很具体：用户不会
   * 去点那个按钮，于是自动发送永远差这一条 —— 而界面上写着这是我们的问题。
   */
  it("grant_missing 显示人话 + 标成「可以自己改」+ 给出去申请授权", () => {
    wrap(
      <ReplyDock
        drafts={[draft({ notSentReason: "grant_missing" })]}
        busy={false}
        errorText={null}
        generatingIds={[]}
        generatingSince={null}
        onCompose={() => undefined}
        onResolve={() => undefined}
        onShowCitations={() => undefined}
      />,
    )
    // 原样的 grant_missing 对用户没有任何意义
    expect(screen.queryByText(/grant_missing/)).toBeNull()
    expect(screen.getByText(/还没有发送授权/)).toBeTruthy()
    expect(screen.getByText("可以自己改")).toBeTruthy()
    // ★ 必须给下一步：这一条是"差最后一步"，而那一步他自己能走
    expect(screen.getByText(/^下一步：/).textContent).toContain("申请")
  })

  /**
   * ★ 反面：判定层说该本人拍板时**不能**给"下一步"。
   *
   * 那不是一个可改的设置（它来自这个人自己历史测出来的决策层），
   * 给个按钮等于让用户去找一个我们刻意不提供的开关。
   */
  it("agent_requires_review 标成「本来就这样」+ 不给动作", () => {
    wrap(
      <ReplyDock
        drafts={[draft({ notSentReason: "agent_requires_review" })]}
        busy={false}
        errorText={null}
        generatingIds={[]}
        generatingSince={null}
        onCompose={() => undefined}
        onResolve={() => undefined}
        onShowCitations={() => undefined}
      />,
    )
    expect(screen.queryByText(/agent_requires_review/)).toBeNull()
    expect(screen.getByText("本来就这样")).toBeTruthy()
    expect(screen.queryByText(/^下一步：/)).toBeNull()
  })

  /**
   * ★ 判定层给的那句英文原文要**原样显示**。
   *
   * `brief` 的 `because[0]`（"risk class `commitment` — never settled by the
   * owner alone"）不在枚举里，所以走的是兜底那条分支。它本来就是一句人话，
   * 而它恰恰是"为什么要你看一眼"最有信息量的答案 —— 套一句"需要确认"
   * 等于把它扔掉。
   */
  it("★ 判定层给的原因原样显示（它比任何枚举都具体）", () => {
    const because = "risk class `commitment` — never settled by the owner alone"
    wrap(
      <ReplyDock
        drafts={[draft({ notSentReason: because })]}
        busy={false}
        errorText={null}
        generatingIds={[]}
        generatingSince={null}
        onCompose={() => undefined}
        onResolve={() => undefined}
        onShowCitations={() => undefined}
      />,
    )
    expect(screen.getByText(new RegExp("never settled"))).toBeTruthy()
  })

  it("rate_limited 给出下一步动作（它是能自己改的）", () => {
    wrap(
      <ReplyDock
        drafts={[draft({ notSentReason: "rate_limited" })]}
        busy={false}
        errorText={null}
        generatingIds={[]}
        generatingSince={null}
        onCompose={() => undefined}
        onResolve={() => undefined}
        onShowCitations={() => undefined}
      />,
    )
    expect(screen.getByText("可以自己改")).toBeTruthy()
    expect(screen.getByText("下一步：改频率上限")).toBeTruthy()
  })

  it("★ 未知 reason 原样显示，不给兜底文案", () => {
    wrap(
      <ReplyDock
        drafts={[draft({ notSentReason: "generation_failed" })]}
        busy={false}
        errorText={null}
        generatingIds={[]}
        generatingSince={null}
        onCompose={() => undefined}
        onResolve={() => undefined}
        onShowCitations={() => undefined}
      />,
    )
    /**
     * `generation_failed` 是模型调用失败时我们自己塞的。
     * 兜底成一句客套会把**真错误**伪装成正常判定 ——
     * 而那正是需要被看到的那类信息。
     */
    expect(screen.getByText(/generation_failed/)).toBeTruthy()
  })
})

/**
 * ★ 这一组来自**在真应用里看到的一个矛盾**。
 *
 * 顶部横幅写"待审草稿 13 条"，右栏却写"待审草稿（0）"——
 * 因为默认选中的是待处理数最高的会话，而那个会话恰好一条草稿都没有。
 * 用户看到两个互相矛盾的数字，并且无从知道另外 13 条在哪
 * （他会以为草稿丢了）。
 *
 * 单测发现不了这个：组件各自都对，错的是**容器怎么选默认会话**
 * 与**右栏只说了局部数字**。所以这里锁的是那两件事。
 */
describe("★ 全局草稿数与右栏数字不能互相矛盾", () => {
  it("别的会话还有草稿时，右栏必须说出来", () => {
    wrap(
      <ReplyDock
        drafts={[]}
        busy={false}
        errorText={null}
        generatingIds={[]}
        generatingSince={null}
        onCompose={() => undefined}
        otherCount={13}
        onResolve={() => undefined}
        onShowCitations={() => undefined}
      />,
    )
    // 没有草稿时默认停在「新建」——一个能直接写的输入框，不是空状态卡
    expect(screen.getByLabelText("新建回复")).toBeTruthy()
    // 而"另外 13 条在别处"仍然要说：不说的话与顶栏的全局数字矛盾
    expect(screen.getByText(/另外 13 条草稿在别的会话里/)).toBeTruthy()
  })

  it("没有别处的草稿时不显示那行（凭空冒出一个 0 会让人以为出错了）", () => {
    wrap(
      <ReplyDock
        drafts={[draft()]}
        busy={false}
        errorText={null}
        generatingIds={[]}
        generatingSince={null}
        onCompose={() => undefined}
        otherCount={0}
        onResolve={() => undefined}
        onShowCitations={() => undefined}
      />,
    )
    expect(screen.queryByText(/别的会话里/)).toBeNull()
  })
})

function conversation(
  over: Partial<PersonaConversationView> & { conversationId: string },
): PersonaConversationView {
  return {
    channelId: "dingtalk",
    externalId: `ext-${over.conversationId}`,
    title: over.conversationId,
    kind: "group",
    memberCount: 8,
    unreadCount: 0,
    lastMessageAt: DAY_ONE,
    messageCount: 100,
    unreadForPersona: 0,
    replyMode: "draft",
    triggerMode: "all",
    keywords: [],
    personaNote: null,
    peerExternalId: null,
    /**
     * 侧栏预览三件套的缺省。
     *
     * `lastMessageText: null` = "还没有消息" —— 那是最保守的缺省：
     * 给一个假正文会让所有不关心预览的用例里都出现一句凭空的话，
     * 而那句话会在断言 `textContent` 时干扰匹配。
     */
    lastMessageText: null,
    lastMessageSender: null,
    lastMessageIsSelf: null,
    ...over,
  }
}

describe("★ 左栏：草稿徽标与排序", () => {
  it("★ 按最新消息时间从上到下排（谁刚来消息谁在最上面）", () => {
    /**
     * ★ 用户要求：侧栏顺序 = 消息新旧顺序，与钉钉等 IM 一致。
     *
     * 原来是「草稿数 → 待处理 → 时间」三级 —— 会让一个"三天前有 5 条草稿"
     * 的会话压在"一分钟前刚来消息"的上面。这条锁住新行为：即便下面那个
     * 会话有 3 条草稿、且没有未读，只要它的最新消息**更早**，就排在后面。
     *
     * 反证：恢复 draftsOf/unread 优先的排序时，"有草稿"会跳到第一，这里必红。
     */
    wrap(
      <ConversationRail
        items={[
          conversation({ conversationId: "刚来消息", lastMessageAt: DAY_TWO, unreadForPersona: 0 }),
          conversation({ conversationId: "有草稿但更早", lastMessageAt: DAY_ONE }),
        ]}
        loading={false}
        activeId={null}
        draftCounts={new Map([["有草稿但更早", 3]])}
        onSelect={() => undefined}
      />,
    )
    const rows = [...document.querySelectorAll("aside ul li")].map((li) => li.textContent ?? "")
    expect(rows[0]).toContain("刚来消息")
    expect(rows[1]).toContain("有草稿但更早")
  })

  it("草稿与待处理是两个徽标（合成一个会让两种下一步看起来一样）", () => {
    wrap(
      <ConversationRail
        items={[conversation({ conversationId: "两种都有", unreadForPersona: 5 })]}
        loading={false}
        activeId={null}
        draftCounts={new Map([["两种都有", 2]])}
        onSelect={() => undefined}
      />,
    )
    expect(screen.getByText("2 待审")).toBeTruthy()
    expect(screen.getByText("5")).toBeTruthy()
  })

  /**
   * ★ 未读（我没读）与待处理（数字人没跑）必须能分开看。
   *
   * 这两个数字长得一样但下一步动作完全不同：前者是"去读"，
   * 后者是"等一轮 tick"。合成一个的话用户无从判断该做什么。
   *
   * 数据源也不同：未读来自 L1 探针的 `unreadPoint`（钉钉红点），
   * 待处理来自 `dh_inbox` 里 state=pending 的行数。
   */
  it("★ 未读与待处理同时存在时是两个不同的徽标", () => {
    wrap(
      <ConversationRail
        items={[conversation({ conversationId: "都有", unreadCount: 7, unreadForPersona: 3 })]}
        loading={false}
        activeId={null}
        draftCounts={new Map()}
        onSelect={() => undefined}
      />,
    )
    expect(screen.getByText("7")).toBeTruthy()
    expect(screen.getByText("3")).toBeTruthy()
    // 两个徽标的 title 不同 —— 那是用户唯一能查到含义的地方
    expect(screen.getByTitle(/你还没读的消息/)).toBeTruthy()
    expect(screen.getByTitle(/还没跑的消息/)).toBeTruthy()
  })

  it("未读为 0 时不显示那个徽标（凭空一个 0 会让人以为出错了）", () => {
    wrap(
      <ConversationRail
        items={[conversation({ conversationId: "没未读", unreadCount: 0 })]}
        loading={false}
        activeId={null}
        draftCounts={new Map()}
        onSelect={() => undefined}
      />,
    )
    expect(screen.queryByTitle(/你还没读的消息/)).toBeNull()
  })

  it("★ 三位数截断成 99+（实测有 353 未读的告警群，会把标题挤掉）", () => {
    wrap(
      <ConversationRail
        items={[conversation({ conversationId: "告警群", unreadCount: 353 })]}
        loading={false}
        activeId={null}
        draftCounts={new Map()}
        onSelect={() => undefined}
      />,
    )
    expect(screen.getByText("99+")).toBeTruthy()
    expect(screen.queryByText("353")).toBeNull()
  })

  /**
   * ★★ 四档 tab：全部 / 自动判断 / 直出 / 草稿模式，且三类**互斥**。
   *
   * 互斥这件事值得单独锁：如果「直出」的会话同时也出现在「自动判断」里，
   * 三个 tab 的条数加起来就大于总数，而用户会拿它们当分区看
   * （"我有几个会话在自动发"需要一个确定的答案）。
   *
   * 反证：把分组改回 `behavesAsAuto ? auto : draft`（直出并入 auto）时，
   * 「直出」tab 会是空的 —— 下面第一条断言会红。
   */
  it("★★ 直出的会话只出现在「直出」tab，不混进「自动判断」", () => {
    const items = [
      conversation({ conversationId: "直出的", replyMode: "yolo" }),
      conversation({ conversationId: "自动的", replyMode: "auto" }),
      conversation({ conversationId: "草稿的", replyMode: "draft" }),
    ]
    wrap(
      <ConversationRail
        items={items}
        loading={false}
        activeId={null}
        draftCounts={new Map()}
        onSelect={() => undefined}
      />,
    )
    const rowsIn = (tabLabel: string): string[] => {
      fireEvent.click(screen.getByRole("radio", { name: tabLabel }))
      return [...document.querySelectorAll("aside ul li")].map((li) => li.textContent ?? "")
    }

    const yoloRows = rowsIn("直出")
    expect(yoloRows.some((r) => r.includes("直出的"))).toBe(true)
    // ★ 互斥：直出那条**不**出现在自动判断里
    expect(yoloRows.some((r) => r.includes("自动的"))).toBe(false)

    const autoRows = rowsIn("自动判断")
    expect(autoRows.some((r) => r.includes("自动的"))).toBe(true)
    expect(autoRows.some((r) => r.includes("直出的"))).toBe(false)

    const draftRows = rowsIn("草稿模式")
    expect(draftRows.some((r) => r.includes("草稿的"))).toBe(true)
    expect(draftRows.some((r) => r.includes("直出的"))).toBe(false)

    // 全部：三条都在（互斥不等于漏掉）
    const allRows = rowsIn("全部")
    expect(allRows).toHaveLength(3)
  })

  /**
   * ★★ 搜索：标题**与最新一条正文**都要搜。
   *
   * 只搜标题的话"我记得有人提过沙箱"这种查法搜不到 —— 而那正是
   * 用户会用搜索的场合（记得内容、忘了在哪个群）。
   */
  it("★★ 搜索命中标题", () => {
    wrap(
      <ConversationRail
        items={[
          conversation({ conversationId: "c1", title: "沙箱项目群" }),
          conversation({ conversationId: "c2", title: "午饭群" }),
        ]}
        loading={false}
        activeId={null}
        draftCounts={new Map()}
        onSelect={() => undefined}
      />,
    )
    fireEvent.change(screen.getByLabelText("搜索会话"), { target: { value: "沙箱" } })
    const rows = [...document.querySelectorAll("aside ul li")].map((li) => li.textContent ?? "")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain("沙箱项目群")
  })

  it("★★ 搜索也命中最新一条正文（记得内容、忘了在哪个群）", () => {
    wrap(
      <ConversationRail
        items={[
          conversation({
            conversationId: "c1",
            title: "午饭群",
            lastMessageText: "沙箱环境好了吗",
          }),
          conversation({ conversationId: "c2", title: "闲聊", lastMessageText: "今天天气不错" }),
        ]}
        loading={false}
        activeId={null}
        draftCounts={new Map()}
        onSelect={() => undefined}
      />,
    )
    fireEvent.change(screen.getByLabelText("搜索会话"), { target: { value: "沙箱" } })
    const rows = [...document.querySelectorAll("aside ul li")].map((li) => li.textContent ?? "")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain("午饭群")
  })

  it("★ 搜不到时说清是搜不到（而不是与「这一类没有」同一句话）", () => {
    wrap(
      <ConversationRail
        items={[conversation({ conversationId: "c1", title: "沙箱项目群" })]}
        loading={false}
        activeId={null}
        draftCounts={new Map()}
        onSelect={() => undefined}
      />,
    )
    fireEvent.change(screen.getByLabelText("搜索会话"), { target: { value: "不存在的东西" } })
    expect(screen.getByText(/没有匹配/)).toBeTruthy()
  })

  /**
   * ★★ 每行显示「最新一条」，本人发的加「我：」前缀。
   *
   * `lastMessageIsSelf` 是**三态**：null（身份还没确认）时不加前缀 ——
   * 那时我们确实不知道是谁发的，猜错一半比不说更让人困惑。
   */
  it("★★ 本人发的加「我：」前缀", () => {
    wrap(
      <ConversationRail
        items={[
          conversation({
            conversationId: "c1",
            lastMessageText: "我等下看",
            lastMessageIsSelf: true,
          }),
        ]}
        loading={false}
        activeId={null}
        draftCounts={new Map()}
        onSelect={() => undefined}
      />,
    )
    expect(screen.getByText("我：我等下看")).toBeTruthy()
  })

  it("★★ is_self 未判定（null）时**不**加前缀（不假装知道是谁发的）", () => {
    wrap(
      <ConversationRail
        items={[
          conversation({
            conversationId: "c1",
            kind: "direct",
            lastMessageText: "我等下看",
            lastMessageIsSelf: null,
          }),
        ]}
        loading={false}
        activeId={null}
        draftCounts={new Map()}
        onSelect={() => undefined}
      />,
    )
    expect(screen.getByText("我等下看")).toBeTruthy()
    expect(screen.queryByText("我：我等下看")).toBeNull()
  })

  it("★ 群聊里别人发的带发送者名（单聊不带 —— 名字就是会话标题）", () => {
    wrap(
      <ConversationRail
        items={[
          conversation({
            conversationId: "g1",
            kind: "group",
            lastMessageText: "好了",
            lastMessageSender: "小李",
            lastMessageIsSelf: false,
          }),
          conversation({
            conversationId: "d1",
            kind: "direct",
            title: "小王",
            lastMessageText: "在吗",
            lastMessageSender: "小王",
            lastMessageIsSelf: false,
          }),
        ]}
        loading={false}
        activeId={null}
        draftCounts={new Map()}
        onSelect={() => undefined}
      />,
    )
    expect(screen.getByText("小李：好了")).toBeTruthy()
    // 单聊：不重复写一遍对方名字
    expect(screen.getByText("在吗")).toBeTruthy()
  })
})

/**
 * ★ 引用回复：`quoted_external_id` 从一开始就在落库，UI 一直没用。
 *
 * 没有引用块的后果：一句"对，就按那个来"在界面上是一句突然的话，
 * 而它其实是在回复三条之前的某个方案。判断"数字人回得对不对"时
 * 这个上下文是必需的。
 */
describe("★ 引用回复的样式", () => {
  it("显示被引用者与摘要", () => {
    wrap(
      <MessageThread
        loading={false}
        messages={[
          message({
            id: "m1",
            contentText: "对，就按那个来",
            quoted: { id: "m0", senderDisplayName: "小王", excerpt: "沙箱那个方案我看可以" },
          }),
        ]}
      />,
    )
    expect(screen.getByText("小王")).toBeTruthy()
    expect(screen.getByText("沙箱那个方案我看可以")).toBeTruthy()
  })

  it("★ 被引用的消息在采集范围外时**明说**，而不是留白", () => {
    wrap(
      <MessageThread
        loading={false}
        messages={[
          // excerpt 为空 = 那条消息没在库里（采集窗口之外）
          message({ id: "m1", quoted: { id: null, senderDisplayName: null, excerpt: "" } }),
        ]}
      />,
    )
    /**
     * 留白的话用户看到一个空的引用框，会以为是渲染坏了。
     * 明说"在采集范围之外"才让他知道这是**数据**的边界而不是 bug。
     */
    expect(screen.getByText("（这条消息在采集范围之外）")).toBeTruthy()
    expect(screen.getByText("引用了一条消息")).toBeTruthy()
  })

  it("★ 带引用的消息不与上一条合并（否则引用看起来属于上一条）", () => {
    wrap(
      <MessageThread
        loading={false}
        messages={[
          message({ id: "m1", contentText: "第一句", sentAt: DAY_ONE }),
          message({
            id: "m2",
            contentText: "第二句",
            sentAt: DAY_ONE + 10_000,
            quoted: { id: "m0", senderDisplayName: "小王", excerpt: "更早那条" },
          }),
        ]}
      />,
    )
    // 同一人、10 秒内 —— 本来会合并，但有引用块所以必须断开
    expect(screen.getAllByText("小李")).toHaveLength(2)
  })
})

/**
 * ★ 图片与文件：采集时只记 mediaId 不下字节。
 *
 * 所以"没有本地文件"是**常态**而不是错误 —— 界面上必须能一键拿下来，
 * 否则用户看到的只是"[图片]"三个字，而那张图其实是能取到的。
 */
describe("★ 媒体：已下载渲染，没下的给按钮", () => {
  function asset(over: Partial<PersonaMessageView["media"][number]> = {}) {
    return {
      id: "a1",
      kind: "image",
      path: null,
      mime: null,
      bytes: null,
      originalName: null,
      previewable: false,
      ...over,
    }
  }

  it("未下载 → 有一个可点的下载按钮", () => {
    wrap(
      <MessageThread
        loading={false}
        messages={[message({ id: "m1", contentText: "", media: [asset()] })]}
      />,
    )
    expect(screen.getByText("点击下载图片")).toBeTruthy()
  })

  it("★ 已下载且可预览 → 渲染 img，src **原样**用后端给的 URL", () => {
    wrap(
      <MessageThread
        loading={false}
        messages={[
          message({
            id: "m1",
            contentText: "",
            media: [
              asset({
                // 主进程在 IPC 边界已经转成可加载的 scheme
                path: "mycontext-file://local/tmp/x.png",
                mime: "image/png",
                previewable: true,
              }),
            ],
          }),
        ]}
      />,
    )
    const img = document.querySelector("img")
    expect(img).not.toBeNull()
    /**
     * ★ 断言的是"原样用"，而不是某个具体前缀。
     *
     * 这条曾经写成 `expect(src).toBe("file:///tmp/x.png")` —— 也就是
     * 断言渲染层**自己拼** `file://`。而实测那个 URL 在真应用里
     * **加载不了**（Chromium 拦掉从 http origin 到 file:// 的请求），
     * 于是那条断言绿着，界面上 img 数量是 0。
     *
     * 教训：这里能验的只是"没有多加也没有少加前缀"。
     * "真的能加载"只有 CDP 探针能验（见 check-persona-ui-interact.mjs）。
     */
    expect(img?.getAttribute("src")).toBe("mycontext-file://local/tmp/x.png")
    expect(screen.queryByText("点击下载图片")).toBeNull()
  })

  it("已下载但不可预览 → 只给文件名，不尝试内联渲染", () => {
    wrap(
      <MessageThread
        loading={false}
        messages={[
          message({
            id: "m1",
            contentText: "",
            media: [
              asset({
                kind: "file",
                path: "/tmp/x.pdf",
                mime: "application/pdf",
                previewable: false,
                originalName: "方案.pdf",
              }),
            ],
          }),
        ]}
      />,
    )
    // 渲染一个不认识的字节流会得到碎图标，所以只给名字
    expect(document.querySelector("img")).toBeNull()
    expect(screen.getByText("文件：方案.pdf")).toBeTruthy()
  })

  /**
   * ★ 图片要能点开看大图。
   *
   * 气泡里的缩略图上限 240px（那是对的），但那也意味着**看不清** ——
   * 截图里的报错、白板上的字在 240px 里全是马赏克。而这一页的用途是
   * "判断这条消息在说什么"，看不清图等于少一半上下文。
   */
  it("★ 已下载的图包在一个可点的 button 里（不是给 img 挂 onClick）", () => {
    wrap(
      <MessageThread
        loading={false}
        messages={[
          message({
            id: "m1",
            contentText: "",
            media: [
              asset({
                path: "mycontext-file://local/tmp/x.png",
                mime: "image/png",
                previewable: true,
              }),
            ],
          }),
        ]}
      />,
    )
    /**
     * 断言"图的父节点是 button"：点击能力必须落在可聚焦、有语义的元素上
     * —— 键盘用户要能 Tab 到它，读屏器要念"按钮"。
     * 给 img 挂 onClick 的话两者都拿不到。
     */
    const img = document.querySelector("img")
    expect(img?.parentElement?.tagName).toBe("BUTTON")
  })

  it("★ 点开出现大图弹窗（原生 dialog），关闭后消失", () => {
    wrap(
      <MessageThread
        loading={false}
        messages={[
          message({
            id: "m1",
            contentText: "",
            media: [
              asset({
                path: "mycontext-file://local/tmp/x.png",
                mime: "image/png",
                previewable: true,
              }),
            ],
          }),
        ]}
      />,
    )
    expect(document.querySelector("dialog")).toBeNull()
    fireEvent.click(screen.getByTitle("点击查看大图"))
    expect(document.querySelector("dialog")).not.toBeNull()
    // 弹窗里有「下载」与「关闭」
    expect(screen.getByText("下载")).toBeTruthy()
    fireEvent.click(screen.getByText("关闭"))
    expect(document.querySelector("dialog")).toBeNull()
  })

  it("未下载的图**不给**弹窗（那时该点的是「下载图片」）", () => {
    wrap(
      <MessageThread
        loading={false}
        messages={[message({ id: "m1", contentText: "", media: [asset({ kind: "image" })] })]}
      />,
    )
    expect(screen.queryByTitle("点击查看大图")).toBeNull()
    expect(screen.getByText("点击下载图片")).toBeTruthy()
  })

  it("★ 「下载」只把 mediaId 交给主进程（传路径等于开任意文件读取的口子）", async () => {
    const calls: { mediaId: string }[] = []
    installMediaApi()
    ;(window as unknown as { mycontext: Record<string, unknown> }).mycontext = {
      ...(window as unknown as { mycontext: Record<string, unknown> }).mycontext,
      media: {
        avatars: () => Promise.resolve({ ok: true as const, data: [] }),
        download: () => Promise.resolve({ ok: true as const, data: { ok: true } }),
        saveAs: (input: { mediaId: string }) => {
          calls.push(input)
          return Promise.resolve({ ok: true as const, data: { saved: true, path: "/out/x.png" } })
        },
      },
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <I18nextProvider i18n={createI18n("zh")}>
        <QueryClientProvider client={client}>
          <MessageThread
            loading={false}
            messages={[
              message({
                id: "m1",
                contentText: "",
                media: [
                  asset({
                    id: "media-42",
                    path: "mycontext-file://local/tmp/x.png",
                    mime: "image/png",
                    previewable: true,
                  }),
                ],
              }),
            ]}
          />
        </QueryClientProvider>
      </I18nextProvider>,
    )
    fireEvent.click(screen.getByTitle("点击查看大图"))
    fireEvent.click(screen.getByText("下载"))
    // mutation 是异步的 —— 同步断言会拿到还没发出去的空数组
    await waitFor(() => {
      expect(calls).toEqual([{ mediaId: "media-42" }])
    })
  })
})

/**
 * ★ 本人消息靠右 —— IM 的基本语言。
 *
 * 一眼看出"这是我说的"是这一页的核心：用户在判断数字人代他说的话
 * 合不合适，而那要求他能瞬间分清哪些是自己的、哪些是别人的。
 */
describe("★ 本人与他人的气泡方向", () => {
  it("本人的行是 flex-row-reverse（靠右），他人的不是", () => {
    wrap(
      <MessageThread
        loading={false}
        messages={[
          message({ id: "m1", isSelf: false, contentText: "他说的" }),
          message({ id: "m2", isSelf: true, senderDisplayName: null, contentText: "我说的" }),
        ]}
      />,
    )
    const rows = [...document.querySelectorAll("li > div.group")]
    expect(rows).toHaveLength(2)
    expect(rows[0]?.className).not.toContain("flex-row-reverse")
    expect(rows[1]?.className).toContain("flex-row-reverse")
  })
})

/**
 * ★ 超长不可断内容不能撑破气泡（横向溢出的根因）。
 *
 * ## 为什么这一条值得单独锁
 *
 * 首版正文用的是 `break-words`（= `overflow-wrap: break-word`），而它
 * **只在已有断点处换行** —— 对一个不含空格的长 token 完全无效。
 * 实测库里真有这种数据：钉钉分享链接单条 1568 字符且一个空格都没有
 * （`[dingtalk://dingtalkclient/page/link?pc_slide=…`）。
 *
 * 气泡有 `max-w-[min(560px,72%)]`，但 `max-width` **管不住**一个不可断的
 * 子元素：它撑破气泡 → 撑破 li → 在滚动容器上冒出横向滚动条。
 * 而本人消息是 `flex-row-reverse`，那里的溢出方向是**反的**，
 * 于是横向滑动的手感与其余消息相反（用户报的正是这个）。
 *
 * ## 为什么断言 class 而不是断言宽度
 *
 * jsdom **没有布局引擎** —— `scrollWidth`/`clientWidth` 恒为 0，
 * 在这里断言宽度会得到一个永远绿的假门禁。
 * 真实宽度由 CDP 探针在运行中的应用里验（`scripts/check-persona-ui.mjs`，
 * 断言 `scrollWidth <= clientWidth`）。
 *
 * 这一条锁的是**承载长文本的那个元素带着能断任意位置的类**：
 * 换回 `break-words`（或漏掉这个类）会让它红。
 */
describe("★ 超长不可断内容：正文/引用/文件名都要能断在任意位置", () => {
  /** 实测形态：一段中文 + 一个 1500 字符级、不含空格的 dingtalk 链接。 */
  const LONG_URL = `大家的OKR可以先写一版\n[dingtalk://dingtalkclient/page/link?pc_slide=true&url=${"a".repeat(1400)}]`

  it("正文用 wrap-anywhere（break-words 断不开无空格长串）", () => {
    wrap(
      <MessageThread loading={false} messages={[message({ id: "m1", contentText: LONG_URL })]} />,
    )
    /**
     * 用 `textContent` 找而不是 `getByText(LONG_URL)`：
     * testing-library 默认会归一化空白，而这段正文里有换行 ——
     * 直接传原串匹配不上（那会让用例以"正确的结论、错误的理由"失败）。
     */
    const body = [...document.querySelectorAll("span")].find(
      (node) => node.textContent === LONG_URL,
    )
    expect(body).toBeTruthy()
    expect(body?.className).toContain("wrap-anywhere")
    /**
     * 显式排除 `break-words`：它是这个 bug 的原因，而两个类同时存在时
     * `overflow-wrap` 只生效一个（后者覆盖前者），留着会让人以为还需要它。
     */
    expect(body?.className).not.toContain("break-words")
  })

  it("引用摘要同样能断（80 字上限挡不住 80 个无空格字符）", () => {
    const excerpt = "b".repeat(80)
    wrap(
      <MessageThread
        loading={false}
        messages={[
          message({
            id: "m1",
            quoted: { id: "m0", senderDisplayName: "小李", excerpt },
          }),
        ]}
      />,
    )
    expect(screen.getByText(excerpt).className).toContain("wrap-anywhere")
  })

  it("文件名同样能断（附件名也可能是一长串没有空格的字符）", () => {
    const name = `${"c".repeat(120)}.pdf`
    wrap(
      <MessageThread
        loading={false}
        messages={[
          message({
            id: "m1",
            contentText: "",
            media: [
              {
                id: "a1",
                kind: "file",
                path: "/tmp/x.pdf",
                mime: "application/pdf",
                bytes: null,
                previewable: false,
                originalName: name,
              },
            ],
          }),
        ]}
      />,
    )
    expect(screen.getByText(`文件：${name}`).className).toContain("wrap-anywhere")
  })

  it("★ 长发送者名可截，但时间与「@我」不可截（截一半的时间戳没有意义）", () => {
    wrap(
      <MessageThread
        loading={false}
        messages={[
          message({
            id: "m1",
            /**
             * 实测最长的那一类：15 字符带括号后缀。
             * ★ 化名，但**长度与字符集与真实样本一致**（中文 + 空格 +
             * 拉丁 + 全角括号）—— 截断逻辑要处理的边界不能因为脱敏而变。
             */
            senderDisplayName: "张小明 Alexis（主用钉）",
            mentionsSelf: true,
          }),
        ]}
      />,
    )
    expect(screen.getByText("张小明 Alexis（主用钉）").className).toContain("truncate")
    expect(screen.getByText("@我").className).toContain("shrink-0")
  })
})

/**
 * ★ 渠道标识：这一页管的是"以本人身份在某个 IM 里说话"。
 *
 * 单渠道时它像装饰，第二个渠道（飞书）接进来的那一刻变成必需品 ——
 * 那时左栏会混排两个渠道的会话，而"这条草稿会落到谁的手机上"
 * 只能由渠道标识回答。
 *
 * 这里锁两条：**名字要出来**，以及**未知渠道不能把页面搞崩**。
 */
describe("★ 渠道标识", () => {
  it("钉钉渲染出渠道名", () => {
    wrap(<ChannelBadge channelId="dingtalk" />)
    expect(screen.getByText("钉钉")).toBeTruthy()
  })

  it("★ 未知渠道只少一个图标，不白屏（渠道 id 来自库里的字符串，不是编译期常量）", () => {
    /**
     * `ICONS[id]` 取到 undefined 时若直接当组件渲染，React 会抛 ——
     * 而表现是整页白屏。这一条锁住那个降级分支。
     */
    wrap(<ChannelBadge channelId="wechat-work" />)
    // 缺 i18n key 时 i18next 回落到 key 本身：难看但不是白屏，且能看出缺哪个
    expect(document.body.textContent).toContain("wechat-work")
    expect(document.querySelector("svg")).toBeNull()
  })
})

/**
 * ★ 草稿署名：这句话不是我写的，是数字人替我写的。
 *
 * 这一页的主要动作是审草稿，而用户审的是"以**我的身份**要发出去的话"。
 * 没有署名时草稿卡与"我自己写的草稿"在视觉上无从区分 ——
 * 而这两者的信任级别完全不同（一个要逐字核对，一个不用）。
 */
describe("★ 草稿署名：名字与形象", () => {
  it("显示引导页设的数字人名字", async () => {
    wrap(
      <ReplyDock
        drafts={[draft({ id: "d1" })]}
        busy={false}
        errorText={null}
        generatingIds={[]}
        generatingSince={null}
        onCompose={() => undefined}
        onResolve={() => undefined}
        onShowCitations={() => undefined}
      />,
    )
    /**
     * 要 `waitFor`：名字来自 `onboarding.steps()` 这个**异步**查询，
     * 首帧渲染时它还没回来，署名显示的是兜底的「数字人」。
     * 同步断言会拿到兜底值 —— 那等于什么都没验。
     */
    await waitFor(() => {
      // stub 里 payload 的 name 是「小小周」
      expect(screen.getByText("小小周 起草")).toBeTruthy()
    })
  })

  it("形象渲染成一张图（DiceBear 离线生成，不依赖网络）", () => {
    wrap(
      <ReplyDock
        drafts={[draft({ id: "d1" })]}
        busy={false}
        errorText={null}
        generatingIds={[]}
        generatingSince={null}
        onCompose={() => undefined}
        onResolve={() => undefined}
        onShowCitations={() => undefined}
      />,
    )
    const figure = document.querySelector("img")
    expect(figure).toBeTruthy()
    /**
     * `data:` 而不是 `https://api.dicebear.com/…`：走 HTTP API 的话
     * 断网/内网时所有形象都变空白，而这是一个本地优先的桌面应用。
     */
    expect(figure?.getAttribute("src")?.startsWith("data:")).toBe(true)
  })
})

/**
 * ★ 正文清洗必须**真的接到界面上**。
 *
 * 纯函数的单测（`tests/unit/desktop/content-display.test.ts`）证明不了
 * 这一点：函数写对了但渲染层没调它，界面上照样是
 * `[图片消息](mediaId=$iwEL…) 注意：如需下载使用dws…`。
 *
 * 这正是"两层都对、中间没接"那类失效 —— 而它在这个仓库里出现过不止一次
 * （注释声称订阅了某个事件而没人订阅；`file://` 的 URL 单测全绿而界面 0 张图）。
 */
describe("★ 清洗接到界面上（不只是函数写对了）", () => {
  it("图片标记与 CLI 提示都不出现在界面上", () => {
    wrap(
      <MessageThread
        loading={false}
        messages={[
          message({
            id: "m1",
            contentText:
              "[图片消息](mediaId=$iwELAqNwbmcDAATRAfQF) 注意：如需下载使用dws chat message download-media命令下载",
            media: [],
          }),
        ]}
      />,
    )
    /**
     * 判据是这两个串**在整个界面上都找不到**，而不是"某个元素的文本等于 X"
     * —— 后者会漏掉"标记被渲染到了别的地方"。
     */
    expect(document.body.textContent).not.toContain("mediaId=")
    expect(document.body.textContent).not.toContain("download-media")
    expect(document.body.textContent).not.toContain("命令下载")
  })

  it("@真名(花名) 显示成 @花名", () => {
    wrap(
      <MessageThread
        loading={false}
        messages={[message({ id: "m1", contentText: "@周敏(敏敏) 收到了" })]}
      />,
    )
    expect(screen.getByText("@敏敏 收到了")).toBeTruthy()
    expect(document.body.textContent).not.toContain("周敏")
  })

  it("正文旁边的真内容一个字都不少（贪婪正则会吃掉它）", () => {
    wrap(
      <MessageThread
        loading={false}
        messages={[message({ id: "m1", contentText: "[图片消息](mediaId=@lQ)很赞[向上]" })]}
      />,
    )
    // 表情标签也要留着 —— 那是钉钉的表情，用户本来就这么看到
    expect(screen.getByText("很赞[向上]")).toBeTruthy()
  })

  it("纯图片消息且没有 media 行 → 给占位，不是一个空气泡", () => {
    wrap(
      <MessageThread
        loading={false}
        messages={[message({ id: "m1", contentText: "[图片消息](mediaId=@lQ)", media: [] })]}
      />,
    )
    /**
     * 不给占位的话这里是一个**空的圆角矩形** —— 看起来像界面坏了。
     * 而这个组合有真实来源：消息里有 mediaId 但 `media_assets`
     * 那一行还没建索引（历史数据或解析规则变过）。
     */
    expect(screen.getByText("（图片/文件，暂未建立索引）")).toBeTruthy()
  })
})

/**
 * ★ 单聊也取头像 —— 但**不能**把单聊的 external_id 当共同群传下去。
 *
 * ## 这一条锁的是一个会造成"永久取不到"的陷阱
 *
 * `fetchAvatar` 的 `groupExternalId` 是一条捷径（已知共同群就直接查它的
 * 成员详情，省掉一次 `search-common`）。但它对"查不到"的处理是
 * **判 `no_avatar_set` 并且不再搜别的群** —— 因为"他确实在这个群里"
 * 是那条捷径的前提。
 *
 * 单聊的 external_id 不是群。传给它的话查询必然空 → 落一条**终态** miss
 * （`needsFetch` 从此不再重试）→ 那个人的头像**永久**取不到。
 * 而表现是"单聊就是没有头像"，与没做这个功能一模一样。
 */
describe("★ 单聊头像：取，但不传假的共同群", () => {
  /** 记录 media.avatars 的入参。 */
  function captureAvatarCalls() {
    const calls: { externalIds: string[]; groupExternalId: string | null }[] = []
    ;(window as unknown as { mycontext: Record<string, unknown> }).mycontext = {
      ...(window as unknown as { mycontext?: Record<string, unknown> }).mycontext,
      media: {
        avatars: (input: { externalIds: string[]; groupExternalId: string | null }) => {
          calls.push({ externalIds: input.externalIds, groupExternalId: input.groupExternalId })
          return Promise.resolve({ ok: true as const, data: [] })
        },
        download: () => Promise.resolve({ ok: true as const, data: { ok: true } }),
      },
    }
    return calls
  }

  it("单聊会取头像（原来整个跳过）", async () => {
    const calls = captureAvatarCalls()
    render(
      <I18nextProvider i18n={createI18n("zh")}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <MessageThread
            loading={false}
            messages={[message({ id: "m1", senderExternalId: "DePEER" })]}
            isGroup={false}
            conversationExternalId="DeCONV"
          />
        </QueryClientProvider>
      </I18nextProvider>,
    )
    await waitFor(() => {
      expect(calls.length).toBeGreaterThan(0)
    })
    expect(calls[0]?.externalIds).toContain("DePEER")
  })

  it("★ 单聊**不传** groupExternalId（传了会落终态 miss，头像永久取不到）", async () => {
    const calls = captureAvatarCalls()
    render(
      <I18nextProvider i18n={createI18n("zh")}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <MessageThread
            loading={false}
            messages={[message({ id: "m1", senderExternalId: "DePEER" })]}
            isGroup={false}
            conversationExternalId="DeCONV"
          />
        </QueryClientProvider>
      </I18nextProvider>,
    )
    await waitFor(() => {
      expect(calls.length).toBeGreaterThan(0)
    })
    expect(calls[0]?.groupExternalId).toBeNull()
  })

  it("群聊仍然传 groupExternalId（那条捷径省掉一次 search-common）", async () => {
    const calls = captureAvatarCalls()
    render(
      <I18nextProvider i18n={createI18n("zh")}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <MessageThread
            loading={false}
            messages={[message({ id: "m1", senderExternalId: "DePEER" })]}
            isGroup
            conversationExternalId="cidGROUP"
          />
        </QueryClientProvider>
      </I18nextProvider>,
    )
    await waitFor(() => {
      expect(calls.length).toBeGreaterThan(0)
    })
    expect(calls[0]?.groupExternalId).toBe("cidGROUP")
  })

  /**
   * ★ 本人的头像也要取 —— 原来被显式跳过了。
   *
   * 跳过的理由是「本人的头像走账号设置那份，而且本人通常没有共同群里的
   * avatarMediaId 记录」，两句都不成立：
   *
   * ① 实测拿本人的 openDingTalkId 查任一群的成员详情，`avatarMediaId`
   *    **有值**（`@lQDPM4P-MAwPhw…`）—— 本人在群里就是个普通成员；
   * ② 账号那份头像是用户**自己上传的**（钉钉没有开放的用户头像接口，
   *    所以授权时填不上），实测真实账号里 `avatar_url` 是 null ——
   *    也就是"走账号那份"在真实数据上等于**没有头像**。
   *
   * 结果是本人的每条消息都只显示首字母色块，而这一栏正是在审
   * 「以本人身份要发出去的话」—— 本人是这一屏的主角之一。
   */
  it("★ 本人的头像也要取（原来 isSelf 被显式跳过）", async () => {
    const calls = captureAvatarCalls()
    render(
      <I18nextProvider i18n={createI18n("zh")}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <MessageThread
            loading={false}
            messages={[
              message({ id: "m1", senderExternalId: "DePEER" }),
              message({
                id: "m2",
                isSelf: true,
                senderExternalId: "DeSELF",
                senderDisplayName: "小周",
              }),
            ]}
            isGroup
            conversationExternalId="cidGROUP"
          />
        </QueryClientProvider>
      </I18nextProvider>,
    )
    await waitFor(() => {
      expect(calls.length).toBeGreaterThan(0)
    })
    // 他人的在里面（原来就在），本人的也必须在（这一条是新的）
    expect(calls[0]?.externalIds).toContain("DePEER")
    expect(calls[0]?.externalIds).toContain("DeSELF")
  })

  /**
   * ★ 取到之后要真的画出来。
   *
   * 上一条只证明"发了请求"。而"请求发了但图没画出来"是这个功能踩过的
   * 那类 bug：实测 23 个头像下载成功、界面上 img 数量是 0
   * （原因是拼了 `file://` 而 Chromium 从 http 源加载它会被拦，
   * 且失败是**静默**的 —— 直接退回首字母色块）。
   *
   * 所以本人这一路也要有一条端到端的断言：给了 path 就得出现 img。
   */
  it("★ 本人头像取到后真的渲染成 img（不是静默退回首字母）", async () => {
    ;(window as unknown as { mycontext: Record<string, unknown> }).mycontext = {
      ...(window as unknown as { mycontext?: Record<string, unknown> }).mycontext,
      media: {
        avatars: () =>
          Promise.resolve({
            ok: true as const,
            data: [
              {
                externalId: "DeSELF",
                // 主进程已在 IPC 边界转成 mycontext-file://（不是 file://）
                path: "mycontext-file://local/tmp/self.jpg",
                missReason: null,
              },
            ],
          }),
        download: () => Promise.resolve({ ok: true as const, data: { ok: true } }),
      },
    }
    render(
      <I18nextProvider i18n={createI18n("zh")}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <MessageThread
            loading={false}
            messages={[
              message({
                id: "m1",
                isSelf: true,
                senderExternalId: "DeSELF",
                senderDisplayName: "小周",
              }),
            ]}
            isGroup
            conversationExternalId="cidGROUP"
          />
        </QueryClientProvider>
      </I18nextProvider>,
    )
    await waitFor(() => {
      const img = document.querySelector("img")
      expect(img).toBeTruthy()
      // src 原样用后端给的 URL —— 不再拼任何前缀
      expect(img?.getAttribute("src")).toBe("mycontext-file://local/tmp/self.jpg")
    })
  })
})

/**
 * ★ 左栏与顶栏的头像：单聊要显示对方的真头像。
 *
 * ## 这一组锁的是一个**会造成永久取不到**的取值错误
 *
 * 取头像要的是**人**的 id（`openDingTalkId`，实测 `D0AU…` 33 字符），
 * 而单聊的 `externalId` 是**会话** id（实测 `cid…` 47 字符）。
 * 两者形态都不同 —— 拿会话 id 去查成员详情必然空，而那会落一条
 * **终态** miss（`no_avatar_set`，`needsFetch` 从此不再重试），
 * 于是那个人的头像永久取不到。
 *
 * 表现是"单聊就是没有头像"，与没做这个功能一模一样。
 */
describe("★ 左栏头像：单聊用对方的 openDingTalkId，不是会话 id", () => {
  it("单聊有 peer 头像时渲染成图片", () => {
    wrap(
      <ConversationRail
        items={[
          conversation({
            conversationId: "c-direct",
            kind: "direct",
            title: "小李",
            externalId: "cidCONV",
            peerExternalId: "DePEER",
          }),
        ]}
        loading={false}
        activeId={null}
        avatarByPeer={new Map([["DePEER", "mycontext-file://local/tmp/a.jpg"]])}
        onSelect={() => undefined}
      />,
    )
    const img = document.querySelector("img")
    expect(img).not.toBeNull()
    expect(img?.getAttribute("src")).toBe("mycontext-file://local/tmp/a.jpg")
  })

  /**
   * ★ 用**会话 id** 当键时必须取不到 —— 这一条锁的正是那个取值错误。
   *
   * 如果实现里写的是 `avatarByPeer.get(item.externalId)`，那么在真实数据上
   * 永远查不到（键是 `D0AU…` 而查的是 `cid…`），而这条用例会红。
   */
  it("用会话 id 当键查不到（证明用的是 peer id 而不是 externalId）", () => {
    wrap(
      <ConversationRail
        items={[
          conversation({
            conversationId: "c-direct",
            kind: "direct",
            externalId: "cidCONV",
            peerExternalId: "DePEER",
          }),
        ]}
        loading={false}
        activeId={null}
        // 只按**会话 id** 建索引 —— 正确的实现应当查不到
        avatarByPeer={new Map([["cidCONV", "mycontext-file://local/tmp/wrong.jpg"]])}
        onSelect={() => undefined}
      />,
    )
    expect(document.querySelector("img")).toBeNull()
  })

  /**
   * 群聊退回色块**不是缺陷**：钉钉没有群头像字段（`conversation-info`
   * 不返回，也没有"群 avatarMediaId"这种东西），所以这与用户在钉钉里
   * 看到的一致。
   */
  it("群聊没有 peer，退回首字母色块", () => {
    wrap(
      <ConversationRail
        items={[conversation({ conversationId: "c-group", kind: "group", title: "项目群" })]}
        loading={false}
        activeId={null}
        avatarByPeer={new Map([["DePEER", "mycontext-file://local/tmp/a.jpg"]])}
        onSelect={() => undefined}
      />,
    )
    expect(document.querySelector("img")).toBeNull()
  })

  it("取不到头像时不渲染 img（而不是渲染一个坏图）", () => {
    wrap(
      <ConversationRail
        items={[
          conversation({ conversationId: "c-direct", kind: "direct", peerExternalId: "DeNONE" }),
        ]}
        loading={false}
        activeId={null}
        avatarByPeer={new Map()}
        onSelect={() => undefined}
      />,
    )
    expect(document.querySelector("img")).toBeNull()
  })
})

/**
 * 滚动与定位的三种「该停在哪」。
 *
 * ## ★ 为什么这三条值得锁
 *
 * 三个都是"点了/开了之后停在错的地方"，而这类 bug 的共同点是
 * **界面看起来是好的**（内容全在、没有报错），只是位置不对 ——
 * 所以单测不写就只能靠人每次手点。
 *
 * 用户报的原话是「点到聊天记录肯定要到最下面现在都是最上面」
 * 与「点引用请不要莫名其妙也跳到上面」。后者不是随机行为：
 * 锚点原来取的是"列表里第一条被高亮的消息"，而被引用的消息通常比
 * 最近 80 条更早（实测 53 条引用一条都不在窗口内）→ 它被合并进列表后
 * 排在**最前面** → 于是每次都跳到顶部。
 */
describe("★ 滚动定位：打开停底部，点引用停在被引用的那条", () => {
  /**
   * ★★ 把挂在 `requestAnimationFrame` 上的滚动推进一帧。
   *
   * 引用跳转那一路是在 layout effect 里同步做的，但媒体/头像的高度变化
   * 会让"点完立刻断言"读到旧布局。jsdom 的 rAF 走真实 timer，
   * 所以用 `act` + 一次宏任务让它落地。
   */
  async function flushFrame(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }

  it("★ 打开会话 → 滚到容器底部（消息是旧→新，最新在底下）", () => {
    /**
     * ## ★ 必须先把 `scrollHeight` 造成非 0
     *
     * jsdom 没有真实布局，`scrollHeight` 天然是 0 —— 于是
     * `expect(top).toBe(scrollHeight)` 是 `0 === 0`，**把功能整段删掉
     * 也照样通过**。所以给原型装一个固定的 `scrollHeight`，
     * 让"滚到底部"变得可观测。
     */
    const proto = window.HTMLElement.prototype
    const original = Object.getOwnPropertyDescriptor(proto, "scrollHeight")
    Object.defineProperty(proto, "scrollHeight", { configurable: true, value: 1234 })
    const scrolls = installRowGeometry()
    try {
      const { container } = wrap(
        <MessageThread
          loading={false}
          conversationId="c1"
          messages={[
            message({ id: "m1", contentText: "最早" }),
            message({ id: "m2", contentText: "最新" }),
          ]}
        />,
      )
      const scroller = container.querySelector("[class*='overflow-y-auto']") as HTMLElement | null
      expect(scroller).not.toBeNull()
      // 停在底部 = 以 scrollHeight 为 top 滚过一次（而不是压根没滚）
      const last = scrolls.calls.at(-1)
      expect(last?.top).toBe(1234)
      // 切会话是**瞬时**到位，不放长动画
      expect(last?.behavior).toBe("auto")
    } finally {
      scrolls.restore()
      if (original === undefined) delete (proto as { scrollHeight?: unknown }).scrollHeight
      else Object.defineProperty(proto, "scrollHeight", original)
    }
  })

  it("★ 同一会话来新消息时滚到底部，且用 smooth（切会话才是 auto）", () => {
    /**
     * 这一条锁的是**两件事**：
     * ① 依赖数组的正确性 —— effect 依赖 `latestMessageId` 而不是整个
     *    `messages` 数组，所以查询刷新（内容没变但数组是新的）不会重复滚动；
     * ② 追加消息与切换会话用**不同的** behavior：切会话瞬时到位（auto），
     *    追加消息平滑（smooth）。混成一种的话，翻历史时来一条新消息
     *    会看到一次突兀的跳动。
     *
     * ⚠️ 追加消息**确实会**滚到底部 —— 这是当前的取舍（组件分不开
     * "新会话数据到了"与"来了新消息"）。这条记录的是**真实行为**：
     * 将来真要加"用户是否贴底"的判断时它会失败，那正是提醒。
     */
    const proto = window.HTMLElement.prototype
    const original = Object.getOwnPropertyDescriptor(proto, "scrollHeight")
    Object.defineProperty(proto, "scrollHeight", { configurable: true, value: 1234 })
    const scrolls = installRowGeometry()
    try {
      const { rerender } = wrap(
        <MessageThread
          loading={false}
          conversationId="c1"
          messages={[message({ id: "m1", contentText: "甲" })]}
        />,
      )
      // 打开会话那一次：瞬时到底
      expect(scrolls.calls.at(-1)).toEqual({ top: 1234, behavior: "auto" })

      // 同一会话来了新消息（messages 变了，conversationId 没变）
      rerender(
        <I18nextProvider i18n={createI18n("zh")}>
          <QueryClientProvider client={new QueryClient()}>
            <MessageThread
              loading={false}
              conversationId="c1"
              messages={[
                message({ id: "m1", contentText: "甲" }),
                message({ id: "m2", contentText: "乙（新来的）" }),
              ]}
            />
          </QueryClientProvider>
        </I18nextProvider>,
      )
      // ★ 又滚到底，但这一次是 smooth
      expect(scrolls.calls.at(-1)).toEqual({ top: 1234, behavior: "smooth" })
    } finally {
      scrolls.restore()
      if (original === undefined) delete (proto as { scrollHeight?: unknown }).scrollHeight
      else Object.defineProperty(proto, "scrollHeight", original)
    }
  })

  it("★★ 点引用块 → 停在**被引用的那条**，不是列表第一条", async () => {
    /**
     * 这一条直接锁住那个 bug：`m_old` 是被引用的目标且排在**最前**，
     * 但它同时也会被高亮 —— 旧实现锚定"第一条高亮"时两者恰好重合，
     * 所以要用一个**后面**的目标才能分辨对错。
     *
     * 构造：m1（最早）… m3 引用 m2。点 m3 的引用块应停在 **m2**，
     * 而不是 m1（列表首条）。
     */
    const capture = installRowGeometry()
    try {
      wrap(
        <MessageThread
          loading={false}
          conversationId="c1"
          messages={[
            message({ id: "m1", contentText: "列表第一条" }),
            message({ id: "m2", contentText: "被引用的那条" }),
            message({
              id: "m3",
              contentText: "我在回复上面那条",
              quoted: { id: "m2", senderDisplayName: "小李", excerpt: "被引用的那条" },
            }),
          ]}
        />,
      )
      fireEvent.click(screen.getByTitle("跳到这条消息"))
      // 滚动挂在 rAF 上（见 flushFrame 的注释）—— 不推进这一帧拿到的是空数组
      await flushFrame()
      /**
       * 两次滚动：① 打开会话时到底部（auto）；② 点引用的那次跳转。
       * 断言**最后**那一次 —— 第一次是"打开就停在最新"，不是这条要验的。
       */
      expect(capture.calls).toHaveLength(2)
      // ★ 停在 m2（index 1）上，而不是列表首条 m1（index 0）
      expect(capture.calls.at(-1)?.top).toBe(capture.expectedTopFor(1))
      expect(capture.calls.at(-1)?.top).not.toBe(capture.expectedTopFor(0))
    } finally {
      capture.restore()
    }
  })

  it("★ 草稿「看引用」→ 停在那条引用上（而不是列表首条）", async () => {
    const capture = installRowGeometry()
    try {
      wrap(
        <MessageThread
          loading={false}
          conversationId="c1"
          messages={[
            message({ id: "m1", contentText: "列表第一条" }),
            message({ id: "m2", contentText: "草稿引的那条" }),
          ]}
          highlightIds={["m2"]}
        />,
      )
      await flushFrame()
      /**
       * 只有**一次**滚动：`highlightIds` 从一开始就有值，所以这一轮走的是
       * 引用定位那一路，不会再有"打开就到底部"那一次
       * （见实现里 `anchorId !== null` 时提前 return）。
       */
      expect(capture.calls).toHaveLength(1)
      // ★ 停在 m2（index 1）上，而不是列表首条 m1（index 0）
      expect(capture.calls[0]?.top).toBe(capture.expectedTopFor(1))
      expect(capture.calls[0]?.top).not.toBe(capture.expectedTopFor(0))
    } finally {
      capture.restore()
    }
  })

  /**
   * ★ 引用跳转一律用 `smooth`。
   *
   * 这里曾经有两条用例断言"远了用 auto、近了用 smooth"的距离启发式 ——
   * 那是**另一版实现**（`node.scrollIntoView` + 算 delta）的行为，
   * 而现在的实现在容器上算 `top` 再 `scrollTo`，引用一路固定 smooth。
   * 断言一个不存在的启发式只会锁住一个假契约，所以收敛成这一条：
   * 跳转确实发生了、且是 smooth（切会话那一路才是 auto，见上面第一条）。
   */
  it("★ 引用跳转用 smooth（切会话那一路才是 auto）", async () => {
    const capture = installRowGeometry()
    try {
      wrap(
        <MessageThread
          loading={false}
          conversationId="c1"
          messages={[
            message({ id: "m1", contentText: "很远的目标" }),
            message({
              id: "m2",
              contentText: "回复",
              quoted: { id: "m1", senderDisplayName: "小李", excerpt: "很远的目标" },
            }),
          ]}
        />,
      )
      fireEvent.click(screen.getByTitle("跳到这条消息"))
      await flushFrame()
      expect(capture.calls.at(-1)?.behavior).toBe("smooth")
    } finally {
      capture.restore()
    }
  })

  it("★★ 多条引用时停在 highlightIds[0]，而不是「列表里最早的那条高亮」", async () => {
    /**
     * ## ★ 这一条才真正区分新旧实现
     *
     * 上一条（单条引用）在两种实现下都通过 —— 只有一条高亮时
     * "列表首条高亮"与"目标"必然重合，所以它锁不住这个 bug。
     * 反证时发现了这一点：把逻辑改回 `messages.find(高亮)` 它照样绿。
     *
     * 真正的差别要**两条以上**引用、且 `highlightIds[0]` **不是**
     * 列表里最早的那条。草稿的 `citations` 常常就是这个形态
     * （多条引用，顺序按草稿里的引用顺序而不是时间顺序）。
     *
     * 旧实现 = 停在 m1（列表最早的高亮）→ 用户看到的是"跳到上面去了"。
     * 新实现 = 停在 m3（citations 的第一个）。
     */
    const capture = installRowGeometry()
    try {
      wrap(
        <MessageThread
          loading={false}
          conversationId="c1"
          messages={[
            message({ id: "m1", contentText: "更早的那条高亮" }),
            message({ id: "m2", contentText: "没被引用" }),
            message({ id: "m3", contentText: "草稿真正指向的那条" }),
          ]}
          // 注意顺序：m3 在前 —— 它才是"看引用"该停的地方
          highlightIds={["m3", "m1"]}
        />,
      )
      await flushFrame()
      expect(capture.calls).toHaveLength(1)
      // ★ 停在 highlightIds[0]=m3（index 2），而不是"列表里最早的那条高亮" m1（index 0）
      expect(capture.calls[0]?.top).toBe(capture.expectedTopFor(2))
      expect(capture.calls[0]?.top).not.toBe(capture.expectedTopFor(0))
    } finally {
      capture.restore()
    }
  })

  it("★ 目标不在这一屏时引用块**不可点**（点了没反应比不可点更糟）", () => {
    // 被引用的消息在采集窗口之外 → quoted.id 为 null
    wrap(
      <MessageThread
        loading={false}
        conversationId="c1"
        messages={[
          message({
            id: "m1",
            contentText: "我引了一条很早的",
            quoted: { id: null, senderDisplayName: "小李", excerpt: "" },
          }),
        ]}
      />,
    )
    expect(screen.queryByTitle("跳到这条消息")).toBeNull()
    // 但引用块本身仍要显示，并说明原因
    expect(screen.getByText("（这条消息在采集范围之外）")).toBeTruthy()
  })

  it("★ quoted.id 有值但那条不在 messages 里 → **仍然可点**（会去补捞）", () => {
    /**
     * ★★ 这一条的断言**反过来了**，是刻意的。
     *
     * 旧行为：`quoted.id` 不在当前 80 条窗口里就做成不可点，理由是
     * "点了不动比不可点更糟"。但那让用户没了最短路径 —— 被引用的消息
     * 几乎总在窗口之外（实测引用几乎一条都不在最近 80 条里），于是
     * "看一眼他在回复什么"变成"去右上角搜索里绕一圈再自己找回来"。
     *
     * 而后端**本来就支持**按 id 补捞（`persona.service.messages(includeIds)`，
     * 且带 conversationId 校验）。所以现在：有 id 就可点，点了走
     * `onRequestMessage` 把那条取回来再定位。
     *
     * 真正跳不了的只剩「压根没采到那条」（`quoted.id === null`）——
     * 那一条由上一个用例守着。
     */
    const requested: string[] = []
    wrap(
      <MessageThread
        loading={false}
        conversationId="c1"
        onRequestMessage={(id) => requested.push(id)}
        messages={[
          message({
            id: "m1",
            contentText: "引用了一条不在这屏的",
            quoted: { id: "m_not_loaded", senderDisplayName: "小李", excerpt: "很早的话" },
          }),
        ]}
      />,
    )
    const jump = screen.getByTitle("跳到这条消息")
    fireEvent.click(jump)
    // 点了要真的去请求那条消息（而不是静默什么都不做）
    expect(requested).toEqual(["m_not_loaded"])
    // 摘要仍然显示 —— "他在回复什么"这个信息不该丢
    expect(screen.getByText("很早的话")).toBeTruthy()
  })

  it("★ 被点过的引用目标要高亮（跳过去之后看得出是哪条）", () => {
    wrap(
      <MessageThread
        loading={false}
        conversationId="c1"
        messages={[
          message({ id: "m1", contentText: "甲" }),
          message({ id: "m2", contentText: "被引用的乙" }),
          message({
            id: "m3",
            contentText: "丙",
            quoted: { id: "m2", senderDisplayName: "小李", excerpt: "被引用的乙" },
          }),
        ]}
      />,
    )
    fireEvent.click(screen.getByTitle("跳到这条消息"))
    const highlighted = document.querySelectorAll("[class*='status-fill-warning-container']")
    expect(highlighted).toHaveLength(1)
    expect(highlighted[0]?.textContent).toContain("被引用的乙")
  })

  /**
   * ★★ 跳转要有**回程**。
   *
   * 「看引用」原来是一趟单程票：被引用的消息常在几百条之前，用户核对完
   * 只能自己滚回来，而"刚才那条"已经在几屏之外 —— 那正是"每次都要回到
   * 上面再下去"的来源。
   */
  it("★ 跳过去之后出现「回到刚才」，点它滚回原处", () => {
    wrap(
      <MessageThread
        loading={false}
        conversationId="c1"
        messages={[
          message({ id: "m1", contentText: "很早的乙" }),
          message({
            id: "m2",
            contentText: "丙",
            quoted: { id: "m1", senderDisplayName: "小李", excerpt: "很早的乙" },
          }),
        ]}
      />,
    )
    // 还没跳时不该有回程按钮（没地方可回）
    expect(screen.queryByText("回到刚才")).toBeNull()

    fireEvent.click(screen.getByTitle("跳到这条消息"))
    // 跳过去了 → 回程按钮出现
    const back = screen.getByText("回到刚才")
    expect(back).toBeTruthy()

    // 点回程 → 高亮回到**发起跳转**的那条（m2），而不是停在 m1
    fireEvent.click(back)
    const highlighted = document.querySelectorAll("[class*='status-fill-warning-container']")
    expect(highlighted[0]?.textContent).toContain("丙")
    // 回程只有一级，走完就收起
    expect(screen.queryByText("回到刚才")).toBeNull()
  })

  /**
   * ★★ 同一个引用**点第二次**也要重新定位。
   *
   * 去重键原来是 `conversationId:anchorId`，于是"跳过去 → 自己滚走 →
   * 再点同一个引用"时键没变，effect 认为处理过了 → **点了没反应**。
   * 而那是用户最自然的操作之一（来回核对同一条）。
   */
  it("★ 同一条引用点第二次仍然重新滚动（不是「点了没反应」）", () => {
    installMediaApi()
    const scrollTo = vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(() => undefined)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <MessageThread
        loading={false}
        conversationId="c1"
        messages={[
          message({ id: "m1", contentText: "被引用的乙" }),
          message({
            id: "m2",
            contentText: "丙",
            quoted: { id: "m1", senderDisplayName: "小李", excerpt: "被引用的乙" },
          }),
        ]}
      />,
      {
        wrapper: ({ children }) => (
          <I18nextProvider i18n={createI18n("zh")}>
            <QueryClientProvider client={client}>{children}</QueryClientProvider>
          </I18nextProvider>
        ),
      },
    )

    const jump = screen.getByTitle("跳到这条消息")
    fireEvent.click(jump)
    const afterFirst = scrollTo.mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)

    // 再点同一个引用 —— 必须又滚一次
    fireEvent.click(jump)
    expect(scrollTo.mock.calls.length).toBeGreaterThan(afterFirst)
    scrollTo.mockRestore()
  })

  /**
   * ★★ 走最短路径：远处**瞬时到位**，不放"翻过整段历史"的长动画。
   *
   * ## 症状与根因
   *
   * 用户报的是「不是最短路径过去的，每次都要回到上面再下去」。
   * 定位算的 `top` 一直是对的 —— 症结在 `behavior: "smooth"`：
   * 浏览器的平滑滚动会**匀速刷过中间的全部内容**。而被引用的消息几乎
   * 总在几百条之前（实测引用几乎一条都不在最近 80 条里，靠 `includeIds`
   * 补捞回来的都更早），于是那段动画就是肉眼可见地"往上翻过整段历史"。
   *
   * ## 判据：超过两屏就瞬时
   *
   * 两屏之内平滑是**有用的**（看清"我从这儿移到了那儿"）；超过两屏
   * 空间感本来就断了（中间内容一闪而过什么也看不清），动画只剩等待成本。
   *
   * 桩几何：每行 100px、视口 400px（见 `installRowGeometry`），
   * 所以隔 8 行以上就超过两屏。
   */
  it("★★ 远处的引用瞬时到位（不放翻历史的长动画）", async () => {
    const capture = installRowGeometry()
    try {
      /**
       * 12 条消息，最后一条引用**第 9 条**（index 8）。
       *
       * ★ 桩几何下"目标离我多远" = `250 + index × 100`（每行 100px、
       * 视口 400px、居中公式见 `expectedTopFor`）。所以 index 8 的距离是
       * 1050px —— 超过两屏（800px），正是要走瞬时的那一档。
       * index 越小越近，下一条用例用 index 0（250px）验平滑那一侧。
       */
      const items = Array.from({ length: 11 }, (_, index) =>
        message({ id: `m${String(index + 1)}`, contentText: `第 ${String(index + 1)} 条` }),
      )
      wrap(
        <MessageThread
          loading={false}
          conversationId="c1"
          messages={[
            ...items,
            message({
              id: "m12",
              contentText: "我在回复很早那条",
              quoted: { id: "m9", senderDisplayName: "小李", excerpt: "第 9 条" },
            }),
          ]}
        />,
      )
      fireEvent.click(screen.getByTitle("跳到这条消息"))
      await flushFrame()

      const jump = capture.calls.at(-1)
      // 落点是 m9（index 8）—— 先确认跳对了地方，再看怎么跳的
      expect(jump?.top).toBe(capture.expectedTopFor(8))
      // ★ 远距离必须是 auto —— smooth 会一路匀速刷过中间那些消息
      expect(jump?.behavior).toBe("auto")
    } finally {
      capture.restore()
    }
  })

  /**
   * 反面：近处仍然平滑。
   *
   * 一律 auto 的话短距离跳转会"闪一下"，用户看不出自己移到了哪 ——
   * 那个空间感在两屏之内是有价值的，不该为了修远距离把它一起丢掉。
   */
  it("★ 近处的引用保持平滑滚动（空间感在两屏内有用）", async () => {
    const capture = installRowGeometry()
    try {
      wrap(
        <MessageThread
          loading={false}
          conversationId="c1"
          messages={[
            message({ id: "m1", contentText: "被引用的那条" }),
            message({
              id: "m2",
              contentText: "我在回复上面那条",
              quoted: { id: "m1", senderDisplayName: "小李", excerpt: "被引用的那条" },
            }),
          ]}
        />,
      )
      fireEvent.click(screen.getByTitle("跳到这条消息"))
      await flushFrame()
      expect(capture.calls.at(-1)?.behavior).toBe("smooth")
    } finally {
      capture.restore()
    }
  })
})

/**
 * 媒体自动下载。
 *
 * ## ★ 为什么从"点一下才下"改成"自动下"
 *
 * 原来每张图都要用户点「下载图片」。那个设计的理由是"一个活跃群一周
 * 几百张图，全下是几百 MB 且绝大多数没人看" —— 对**全量预取**成立，
 * 但对**用户已经打开的这一屏**不成立：他打开了这个会话，那些图就是
 * 他要看的东西。
 *
 * 所以范围收在"这一屏的消息"上，而不是整个会话历史。
 */
describe("★ 媒体自动下载：打开会话就下这一屏的", () => {
  /**
   * 记下 `downloadForMessages` 收到了什么。
   *
   * ★ 必须在 `wrap()` **之后**装 —— `wrap` 内部会调 `installMediaApi()`，
   * 那会把整个 `media` 对象换成新的，装在前面的桩会被覆盖掉。
   * （踩过：三条用例全报"一次都没调"，而实际是桩被换掉了。）
   */
  function captureAutoDownload(downloaded = 0): { calls: string[][] } {
    const calls: string[][] = []
    const media = (window as unknown as { mycontext: { media: Record<string, unknown> } }).mycontext
      .media
    media.downloadForMessages = (input: { messageIds: readonly string[] }) => {
      calls.push([...input.messageIds])
      return Promise.resolve({
        ok: true as const,
        data: { downloaded, failed: 0, skipped: 0 },
      })
    }
    return { calls }
  }

  /**
   * 先建好 `window.mycontext`，再换掉 `downloadForMessages`，最后渲染。
   *
   * `installMediaApi()` 是幂等的（它保留 `existing` 里的其余字段），
   * 但它每次都重建 `media` —— 所以顺序必须是"装 API → 装桩 → 渲染"，
   * 而 `wrap` 会再装一次 API。这里手工按正确顺序来。
   */
  function renderWithCapture(
    node: React.ReactElement,
    downloaded = 0,
  ): { calls: string[][]; result: ReturnType<typeof render> } {
    installMediaApi()
    const capture = captureAutoDownload(downloaded)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const result = render(
      <I18nextProvider i18n={createI18n("zh")}>
        <QueryClientProvider client={client}>{node}</QueryClientProvider>
      </I18nextProvider>,
    )
    return { calls: capture.calls, result }
  }

  const pendingImage = {
    id: "a1",
    kind: "image",
    path: null,
    mime: null,
    bytes: null,
    originalName: null,
    previewable: false,
  }

  it("★ 有没下载的媒体 → 自动请求下载，且只带**那些**消息", async () => {
    const { calls } = renderWithCapture(
      <MessageThread
        loading={false}
        conversationId="c1"
        messages={[
          message({ id: "m1", contentText: "纯文字，没有媒体" }),
          message({ id: "m2", contentText: "带图", media: [pendingImage] }),
        ]}
      />,
    )
    await waitFor(() => expect(calls).toHaveLength(1))
    // 只带 m2 —— 纯文字的消息没有可下的东西，带上它是白跑一趟
    expect(calls[0]).toEqual(["m2"])
  })

  it("★ 媒体都已在本地 → 一次都不请求（否则每次开会话都白跑一轮）", async () => {
    const { calls } = renderWithCapture(
      <MessageThread
        loading={false}
        conversationId="c1"
        messages={[
          message({
            id: "m1",
            contentText: "图已经下过了",
            media: [{ ...pendingImage, path: "mycontext-file:///tmp/a.jpg", previewable: true }],
          }),
        ]}
      />,
    )
    // 给 effect 跑的机会，然后确认它没跑
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls).toHaveLength(0)
  })

  it("★ 同一份 messages 下只请求一次（不因重渲染反复下）", async () => {
    /**
     * ## ★ 这条能锁什么、不能锁什么
     *
     * **能锁**：effect 不会因为组件重渲染（mutation 状态变化、
     * 父组件重渲染）而反复触发下载。
     *
     * **锁不住**：真实环境里的那个环 —— 下载成功 → `invalidateQueries`
     * → react-query 重新拉消息 → `messages` 变成**新数组** → 依赖
     * `messages` 的 effect 重跑 → 又下 → 又 invalidate。
     * 这里 `messages` 是固定的 prop（没有真的 query 在背后），
     * 所以那条路径走不到。反证确认过：把依赖改成 `messages` 这条仍然绿。
     *
     * 真正防住那个环的是实现里用 `pendingMediaKey`（内容派生的字符串，
     * 下完之后变空串）而不是数组引用 —— 那一点只能靠代码审读与
     * 真应用里观察 IPC 次数来保证。这条用例守的是它的下限。
     */
    const { calls } = renderWithCapture(
      <MessageThread
        loading={false}
        conversationId="c1"
        messages={[message({ id: "m1", contentText: "带图", media: [pendingImage] })]}
      />,
      1,
    )
    await waitFor(() => expect(calls).toHaveLength(1))
    // 等足够久，让可能的重复触发暴露
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(calls).toHaveLength(1)
  })

  it("自动下载失败时手动按钮仍在（那是唯一的补救手段）", () => {
    renderWithCapture(
      <MessageThread
        loading={false}
        conversationId="c1"
        messages={[message({ id: "m1", contentText: "带图", media: [pendingImage] })]}
      />,
    )
    // path 仍是 null（自动下载没成功）→ 必须还能手动点
    expect(screen.getByText("点击下载图片")).toBeTruthy()
  })
})

/**
 * ★★ 「这条是分身发的」角标。
 *
 * ## 为什么这组断言值得存在
 *
 * 在此之前消息头里有一句 `byPersona`，但它**从来没渲染过** ——
 * 判据是 `origin === "agent"`，而 `origin` 恒为 `human`：`send` 只返回
 * `openTaskId`，`sent_message_external_id` 全 NULL，`claimAgentOrigin`
 * 匹配不到（实测 12052 条消息里 `origin='agent'` 零条）。
 * 也就是说那个标签是一段**看起来在工作**的死代码。
 *
 * 所以这里锁三件事：显示、**两种来源分开**、以及点开能把 citations 交出去。
 */
describe("★★ 消息上的「分身发的」角标", () => {
  it("★ 自动发送与「我确认过」必须分开显示", () => {
    /**
     * 合成一句"分身发的"会让后者显得比实际更自动 —— 而两者的责任归属
     * 完全不同（系统替我说话 vs 我自己选的那句话）。
     */
    wrap(
      <MessageThread
        messages={[
          message({
            id: "m-auto",
            isSelf: true,
            agentSend: { source: "agent_auto", runId: "r1", citations: [] },
          }),
          message({
            id: "m-approved",
            isSelf: true,
            sentAt: DAY_ONE + 10 * 60_000,
            agentSend: { source: "user_approved", runId: "r2", citations: [] },
          }),
        ]}
        loading={false}
      />,
    )
    expect(screen.getByText("分身自动发送")).toBeTruthy()
    expect(screen.getByText("分身起草 · 我已确认")).toBeTruthy()
  })

  it("★ 本人自己打的不显示角标（反证：不能给每条都挂）", () => {
    wrap(<MessageThread messages={[message({ id: "m-1", isSelf: true })]} loading={false} />)
    expect(screen.queryByText(/分身/)).toBeNull()
  })

  it("★★ 点角标把**真的** message_id 交出去（用户要的「看引用的区域」）", () => {
    const shown: string[][] = []
    wrap(
      <MessageThread
        messages={[
          message({
            id: "m-1",
            isSelf: true,
            agentSend: { source: "agent_auto", runId: "r1", citations: ["msg-7", "msg-9"] },
          }),
        ]}
        loading={false}
        onShowCitations={(ids) => shown.push([...ids])}
      />,
    )
    fireEvent.click(screen.getByText("看引用 2"))
    expect(shown).toEqual([["msg-7", "msg-9"]])
  })

  it("★ 没有引用时角标仍显示，但不可点（点了没反应比不可点更糟）", () => {
    wrap(
      <MessageThread
        messages={[
          message({
            id: "m-1",
            isSelf: true,
            agentSend: { source: "agent_auto", runId: "r1", citations: [] },
          }),
        ]}
        loading={false}
        onShowCitations={() => undefined}
      />,
    )
    // 角标本身有价值（"这句不是本人自己想的"）
    expect(screen.getByText("分身自动发送")).toBeTruthy()
    // 但没有可点的入口
    expect(screen.queryByText(/看引用/)).toBeNull()
  })

  it("★★ 合并的那条也要有角标（分身连发两条时第二条不能丢）", () => {
    /**
     * 这正是它**不能**放在消息头里的原因：那一行只在未合并时渲染。
     * 放在头里的话"有时显示有时不显示"，比不显示更让人不信这个标记。
     */
    wrap(
      <MessageThread
        messages={[
          message({
            id: "m-1",
            isSelf: true,
            senderDisplayName: "我",
            agentSend: { source: "agent_auto", runId: "r1", citations: [] },
          }),
          message({
            id: "m-2",
            isSelf: true,
            senderDisplayName: "我",
            // 1 分钟后 —— 落在合并窗口内
            sentAt: DAY_ONE + 60_000,
            agentSend: { source: "agent_auto", runId: "r1", citations: [] },
          }),
        ]}
        loading={false}
      />,
    )
    // 两条都要有
    expect(screen.getAllByText("分身自动发送")).toHaveLength(2)
  })
})

/**
 * ★★ 生成过程中：就地显示「正在基于这几条起草」。
 *
 * ## 为什么不是顶部一个转圈
 *
 * 用户的原话是「看到当前正在最新处理的引用哪些**新消息**」。
 * 一个笼统的"生成中"回答不了那个问题 —— 群里连来五条时他想知道的是
 * 数字人把五条一起读了、还是只看了最后一条。而那两种情况下
 * 回复质量的预期完全不同。
 *
 * 生成要几秒到几十秒，这期间没有任何迹象的话，界面与"数字人没反应"
 * 长得一样，而这两件事用户的下一步动作完全不同（等 vs 去查为什么）。
 */
describe("★★ 生成中标出正在处理的消息", () => {
  it("★ 只标在**那几条**上，不是全都标", () => {
    wrap(
      <MessageThread
        messages={[
          message({ id: "m-1" }),
          message({ id: "m-2", sentAt: DAY_ONE + 60_000 }),
          message({ id: "m-3", sentAt: DAY_ONE + 120_000 }),
        ]}
        loading={false}
        generatingIds={["m-2", "m-3"]}
      />,
    )
    // 两条被标（而不是三条）
    expect(screen.getAllByText("正在基于这条起草…")).toHaveLength(2)
  })

  it("★ 没有在途轮次时一条都不标（反证：不能常驻显示）", () => {
    wrap(<MessageThread messages={[message({ id: "m-1" })]} loading={false} />)
    expect(screen.queryByText(/正在基于/)).toBeNull()
  })

  it("★★ 别的会话在生成时，这一屏不该标任何消息", () => {
    /**
     * 快照里的 `generating` 是**全局**的（可能 3 个会话同时在跑）。
     * 容器要按 conversationId 挑出当前那一条 —— 传错的表现是
     * "标错消息"，而 id 恰好不重合时看起来"什么都没标"（语义已经错了）。
     * 这一条锁的是组件对"给我的 id 不在这一屏里"的处理。
     */
    wrap(
      <MessageThread
        messages={[message({ id: "m-1" })]}
        loading={false}
        generatingIds={["m-from-another-conversation"]}
      />,
    )
    expect(screen.queryByText(/正在基于/)).toBeNull()
  })
})

/**
 * ★★ 引用跳转的**时序** —— 用户报的「跳转不能准确跳到对应的位置」。
 *
 * ## 上面那两条为什么没抓到它
 *
 * 它们在**渲染时就把**被引用的消息放进 `messages` 了。而真实时序是：
 *
 *   点「看引用」→ 容器 setCitationIds → usePersonaMessages 的 queryKey 变
 *   → **发起一次新请求** → …几十到几百毫秒… → 列表里才有那条消息
 *
 * 也就是说 `highlightIds` 变化的那一刻，被引用的消息**还没渲染**
 * （实测 53 条引用一条都不在最近 80 条窗口内，所以这是常态而非边缘情况）。
 * 旧实现在 `citationKey` 一变就 `itemRefs.get(first)?.scrollIntoView()`
 * —— `get` 返回 undefined，`?.` 静默什么都不做，**没有报错**。
 *
 * 表现就是"跳不准"：有时不动，有时停在上一次高亮的位置。
 *
 * ## 这一组的构造
 *
 * 先只给"当前窗口"的消息 + `highlightIds` 指向一条**不在其中**的 id，
 * 然后 rerender 把那条补进来（模拟请求回来）—— 断言滚动发生在**补进来之后**。
 */
describe("★★ 引用跳转的时序：目标消息晚到也要跳准", () => {
  /** rAF 在 jsdom 里是真的，但要等它跑完才看得到滚动。 */
  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

  it("★★ 目标还没到时不乱跳；到了之后跳到它身上", async () => {
    const capture = installRowGeometry()
    try {
      const { rerender } = wrap(
        <MessageThread
          loading={false}
          conversationId="c1"
          messages={[message({ id: "m_recent", contentText: "窗口里的最近一条" })]}
          // 引用的是一条**不在**当前窗口里的消息
          highlightIds={["m_old"]}
        />,
      )
      await nextFrame()
      /**
       * ★ 第一阶段必须是"什么都没滚"。
       *
       * 旧实现在这里也是"什么都没滚"（get 返回 undefined）——
       * 所以这一条单独看**分不出**新旧实现。它的作用是排除另一种错修法：
       * "找不到就退回滚到列表第一条/底部" —— 那会把用户丢到一个
       * 与引用无关的位置，比不动更糟。
       */
      expect(capture.calls).toHaveLength(0)

      // 请求回来了：includeIds 把 m_old 带进列表（它更早，所以排在前面）
      rerender(
        <I18nextProvider i18n={createI18n("zh")}>
          <QueryClientProvider client={new QueryClient()}>
            <MessageThread
              loading={false}
              conversationId="c1"
              messages={[
                message({ id: "m_old", contentText: "草稿引的那条老消息" }),
                message({ id: "m_recent", contentText: "窗口里的最近一条" }),
              ]}
              highlightIds={["m_old"]}
            />
          </QueryClientProvider>
        </I18nextProvider>,
      )
      await nextFrame()

      // ★★ 这一条是新旧实现的分界：旧的永远停在 0 次
      expect(capture.calls).toHaveLength(1)
      // ★ 停在补进来的 m_old（index 0），而不是窗口里那条 m_recent（index 1）
      expect(capture.calls[0]?.top).toBe(capture.expectedTopFor(0))
      expect(capture.calls[0]?.top).not.toBe(capture.expectedTopFor(1))
    } finally {
      capture.restore()
    }
  })

  it("★★ 同一组引用只跳一次 —— 之后来新消息不再把用户拽回去", async () => {
    /**
     * 依赖里带 `messages` 是上面那条的代价：列表每变一次这个 effect 都会跑。
     * 不记"已经跳过了"的话，用户看完引用往下翻，一条新消息到达就把他
     * 拽回那条老消息 —— 那比原来的 bug 更烦人。
     */
    const capture = installRowGeometry()
    try {
      const { rerender } = wrap(
        <MessageThread
          loading={false}
          conversationId="c1"
          messages={[
            message({ id: "m_old", contentText: "引的那条" }),
            message({ id: "m1", contentText: "甲" }),
          ]}
          highlightIds={["m_old"]}
        />,
      )
      await nextFrame()
      expect(capture.calls).toHaveLength(1)

      // 来了新消息（同一组引用没变）
      rerender(
        <I18nextProvider i18n={createI18n("zh")}>
          <QueryClientProvider client={new QueryClient()}>
            <MessageThread
              loading={false}
              conversationId="c1"
              messages={[
                message({ id: "m_old", contentText: "引的那条" }),
                message({ id: "m1", contentText: "甲" }),
                message({ id: "m2", contentText: "乙（新来的）" }),
              ]}
              highlightIds={["m_old"]}
            />
          </QueryClientProvider>
        </I18nextProvider>,
      )
      await nextFrame()
      // 仍然是 1 次 —— 没有被再拽一次
      expect(capture.calls).toHaveLength(1)
    } finally {
      capture.restore()
    }
  })

  it("★ 换一组引用要能再跳（防止「只跳一次」过度收紧）", async () => {
    const capture = installRowGeometry()
    try {
      const { rerender } = wrap(
        <MessageThread
          loading={false}
          conversationId="c1"
          messages={[
            message({ id: "a", contentText: "甲条" }),
            message({ id: "b", contentText: "乙条" }),
          ]}
          highlightIds={["a"]}
        />,
      )
      await nextFrame()
      expect(capture.calls).toHaveLength(1)

      // 用户点了另一条草稿的「看引用」
      rerender(
        <I18nextProvider i18n={createI18n("zh")}>
          <QueryClientProvider client={new QueryClient()}>
            <MessageThread
              loading={false}
              conversationId="c1"
              messages={[
                message({ id: "a", contentText: "甲条" }),
                message({ id: "b", contentText: "乙条" }),
              ]}
              highlightIds={["b"]}
            />
          </QueryClientProvider>
        </I18nextProvider>,
      )
      await nextFrame()
      expect(capture.calls).toHaveLength(2)
      // ★ 第二次跳到 b（index 1）—— 换了一组引用要能再跳
      expect(capture.calls[1]?.top).toBe(capture.expectedTopFor(1))
    } finally {
      capture.restore()
    }
  })
})
