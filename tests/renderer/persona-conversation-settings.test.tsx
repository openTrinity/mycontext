/**
 * @vitest-environment jsdom
 *
 * 会话设置弹窗的行为门禁。
 *
 * ## 这一屏锁的是四件用户明确要的事
 *
 * 1. **回复方式 / 触发条件 / 白名单进弹窗**（原来钉在中栏顶部占 24% 视口）。
 *    触发条件是**四种**：不触发 / @我时 / 每条消息 / 命中关键词。
 * 2. **群成员**：从发过言的人归并，带筛选，且必须说明是"发过言的"
 *    而不是"全体成员"（钉钉取不到花名册）。
 * 3. **聊天记录 like 搜索**：命中项可点，点了要**精确跳转**到那条
 *    （把 message id 交出去）。
 * 4. **单聊没有成员 tab**（就俩人，列出来是废话）。
 *
 * 用真渲染而不是源码文本：这四条都是运行时行为（点了会怎样）。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { I18nextProvider } from "react-i18next"
import { createI18n } from "@mycontext/i18n"
import type { PersonaConversationView, MyContextApi } from "@mycontext/ipc-contract"
import { ConversationSettingsDialog } from "@renderer/features/persona/conversation-settings-dialog"

afterEach(cleanup)

/** jsdom 缺 ResizeObserver / dialog.showModal —— 补最小实现（见 persona-thread 里同款）。 */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver
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
    lastMessageAt: Date.now(),
    messageCount: 100,
    unreadForPersona: 0,
    replyMode: "draft",
    triggerMode: "mention",
    keywords: [],
    personaNote: null,
    peerExternalId: null,
    lastMessageText: null,
    lastMessageSender: null,
    lastMessageIsSelf: null,
    ...over,
  }
}

function installApi(over: {
  members?: { externalId: string; displayName: string | null; messageCount: number }[]
  hits?: { id: string; contentText: string; senderDisplayName: string | null; sentAt: number }[]
}): void {
  ;(globalThis as { window?: { mycontext?: unknown } }).window ??= {}
  ;(window as unknown as { mycontext: unknown }).mycontext = {
    persona: {
      members: () => Promise.resolve({ ok: true as const, data: over.members ?? [] }),
      searchMessages: () => Promise.resolve({ ok: true as const, data: over.hits ?? [] }),
    },
    // MembersPanel 会 useContactAvatars → media.avatars —— 缺 stub 会抛
    media: { avatars: () => Promise.resolve({ ok: true as const, data: [] }) },
  } as unknown as MyContextApi
}

function wrap(node: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <I18nextProvider i18n={createI18n("zh")}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </I18nextProvider>,
  )
}

describe("★★ 会话设置弹窗：设置 tab（回复方式 / 触发条件 / 白名单）", () => {
  it("★ 触发条件是四种：不触发 / @我时 / 每条消息 / 命中关键词", () => {
    installApi({})
    wrap(
      <ConversationSettingsDialog
        open
        onClose={() => undefined}
        item={conversation({ conversationId: "g1" })}
        busy={false}
        onChange={() => undefined}
        onJumpToMessage={() => undefined}
      />,
    )
    for (const label of ["不触发", "@我时", "每条消息", "命中关键词"]) {
      expect(screen.getByText(label)).toBeTruthy()
    }
  })

  it("★ 改回复方式把 patch 交出去", () => {
    installApi({})
    const patches: unknown[] = []
    wrap(
      <ConversationSettingsDialog
        open
        onClose={() => undefined}
        item={conversation({ conversationId: "g1", replyMode: "draft" })}
        busy={false}
        onChange={(p) => patches.push(p)}
        onJumpToMessage={() => undefined}
      />,
    )
    // 「自动发送」= auto（回复方式的一档）
    fireEvent.click(screen.getByText("自动发送"))
    expect(patches).toContainEqual({ replyMode: "auto" })
  })

  /**
   * ★★ 白名单那道门已删：选了「自动发送」就是授权，不该再要求第二步。
   *
   * 曾经这里有一个"加入白名单"开关，只在 auto 档出现 —— 用户选了自动、
   * 功能却仍然只出草稿，而原因是一条静默降级。现在两个档位下都**不该**
   * 再出现任何"还要再确认一次"的入口。
   *
   * 两个档位都断言，是因为只查 auto 的话"把它挪到 draft 档下"也会通过。
   */
  it("★ 两个档位下都没有「白名单」这类二次确认入口", () => {
    installApi({})
    for (const replyMode of ["draft", "auto"] as const) {
      const { container, unmount } = wrap(
        <ConversationSettingsDialog
          open
          onClose={() => undefined}
          item={conversation({ conversationId: "g1", replyMode })}
          busy={false}
          onChange={() => undefined}
          onJumpToMessage={() => undefined}
        />,
      )
      const text = container.textContent ?? ""
      expect(text, `${replyMode} 档不该出现「白名单」`).not.toContain("白名单")
      // 回复方式本身仍在（否则上面那条会因为"整个面板没渲染"而假绿）
      expect(text).toContain("回复方式")
      unmount()
    }
  })
})

describe("★★ 成员 tab", () => {
  it("★★ 单聊没有成员 tab（就俩人，列出来是废话）", () => {
    installApi({ members: [] })
    wrap(
      <ConversationSettingsDialog
        open
        onClose={() => undefined}
        item={conversation({ conversationId: "d1", kind: "direct" })}
        busy={false}
        onChange={() => undefined}
        onJumpToMessage={() => undefined}
      />,
    )
    expect(screen.queryByText("成员")).toBeNull()
  })

  it("★★ 群聊：成员从发过言的人来（有头像 + 名字，不再摆发言次数）", async () => {
    installApi({
      members: [
        { externalId: "u1", displayName: "小李", messageCount: 42 },
        { externalId: "u2", displayName: "小王", messageCount: 7 },
      ],
    })
    wrap(
      <ConversationSettingsDialog
        open
        onClose={() => undefined}
        item={conversation({ conversationId: "g1", kind: "group" })}
        busy={false}
        onChange={() => undefined}
        onJumpToMessage={() => undefined}
      />,
    )
    fireEvent.click(screen.getByText("成员"))
    expect(await screen.findByText("小李")).toBeTruthy()
    expect(screen.getByText("小王")).toBeTruthy()
    // ★ 不显示发言次数（"统计数量不必"）
    expect(screen.queryByText(/42 条/)).toBeNull()
    expect(screen.queryByText(/发过言的 2 人/)).toBeNull()
  })

  it("★ 成员可筛选", async () => {
    installApi({
      members: [
        { externalId: "u1", displayName: "小李", messageCount: 42 },
        { externalId: "u2", displayName: "老王", messageCount: 7 },
      ],
    })
    wrap(
      <ConversationSettingsDialog
        open
        onClose={() => undefined}
        item={conversation({ conversationId: "g1", kind: "group" })}
        busy={false}
        onChange={() => undefined}
        onJumpToMessage={() => undefined}
      />,
    )
    fireEvent.click(screen.getByText("成员"))
    await screen.findByText("小李")
    fireEvent.change(screen.getByPlaceholderText("筛选成员"), { target: { value: "老王" } })
    expect(screen.getByText("老王")).toBeTruthy()
    expect(screen.queryByText("小李")).toBeNull()
  })
})

describe("★★ 记录搜索 tab：命中可点、点了精确跳转", () => {
  it("★★ 点搜索结果 → 把那条的 id 交出去（精确跳转）", async () => {
    installApi({
      hits: [
        {
          id: "m_target",
          contentText: "沙箱环境好了吗",
          senderDisplayName: "小李",
          sentAt: Date.now(),
        },
      ],
    })
    const jumped: string[] = []
    wrap(
      <ConversationSettingsDialog
        open
        onClose={() => undefined}
        item={conversation({ conversationId: "g1" })}
        busy={false}
        initialTab="search"
        onChange={() => undefined}
        onJumpToMessage={(id) => jumped.push(id)}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText("在这个会话里搜…"), {
      target: { value: "沙箱" },
    })
    // 命中词被 splitHighlight 拆成 <mark>+片段，所以匹配高亮出来的那段
    const mark = await screen.findByText("沙箱")
    fireEvent.click(mark)
    // ★ 交出去的是那条命中消息的 id —— 消息流据此精确定位
    expect(jumped).toEqual(["m_target"])
  })

  it("★ 点结果同时关弹窗（跳过去要能看见消息流）", async () => {
    installApi({
      hits: [{ id: "m1", contentText: "命中的话", senderDisplayName: "小李", sentAt: Date.now() }],
    })
    const closes = vi.fn()
    wrap(
      <ConversationSettingsDialog
        open
        onClose={closes}
        item={conversation({ conversationId: "g1" })}
        busy={false}
        initialTab="search"
        onChange={() => undefined}
        onJumpToMessage={() => undefined}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText("在这个会话里搜…"), { target: { value: "命中" } })
    fireEvent.click(await screen.findByText("命中"))
    await waitFor(() => expect(closes).toHaveBeenCalled())
  })

  it("★ 搜不到时说清是搜不到（不是与「还没输入」同一句）", async () => {
    installApi({ hits: [] })
    wrap(
      <ConversationSettingsDialog
        open
        onClose={() => undefined}
        item={conversation({ conversationId: "g1" })}
        busy={false}
        initialTab="search"
        onChange={() => undefined}
        onJumpToMessage={() => undefined}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText("在这个会话里搜…"), {
      target: { value: "不存在的东西" },
    })
    expect(await screen.findByText(/没有包含.*不存在的东西/)).toBeTruthy()
  })
})
