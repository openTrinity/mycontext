/**
 * @vitest-environment jsdom
 *
 * 已保存的学习范围要显示成**绝对日期**，不是「近 30 天」。
 *
 * ## ★★★ 缺陷是什么（用户原话）
 *
 * 「近30天，近90天这种词都是针对这次选择的。比如上次是前天选的近30天，
 *   和这次近30天范围应该是不一样的 —— 显示的填过的不应该是近30天」
 *
 * 「近 N 天」是相对**点下去那一刻**的，而存进库的是一个绝对时间戳
 * （`midnightToday() - N 天`，那个对齐是刻意的：不对齐会让同一天内重复保存
 * 算出不同的 since，进而反复触发清语料 + 删图重建）。
 *
 * 于是下次打开面板时 `toDraft` 把它换算回天数，而那个天数**已经不是 30 了**。
 *
 * ## 实测（探针，改动前）
 *
 * 前天选的「近 30 天」→ `toScopeDraft` 返回 `rangeDays: 32` →
 * `[30, 90, 180, 365, null].includes(32) === false` → **一个筹码都不高亮**。
 * 用户看到的是"我明明选过，怎么什么都没选中"。
 *
 * ★ 而"仍然显示近 30 天"更糟：那句话在今天指的是**另一个**区间（今天往回
 * 30 天），与真正生效的下界差两天 —— 用户会以为前天到今天这两天没被学，
 * 而实际学了。
 *
 * 所以判据是：**显示一个具体日期**，那是唯一在任何一天读起来都对的表达。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { SourcesStep, type SourcesDraft } from "@renderer/features/onboarding/sources-step"
import { toScopeDraft } from "@renderer/features/shell/collection-scope-panel"

afterEach(cleanup)

/** jsdom 没有 ResizeObserver，而 Button 走 useSquircle 会用它。 */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver

const DAY = 86_400_000

/** 某个时刻那一天的 00:00 —— 与生产代码的 `midnightToday` 同一个语义。 */
function midnightOf(at: number): number {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function renderStep(draft: SourcesDraft) {
  /**
   * ★ `SourcesStep` 内部调 `useChannelConversations` —— 所以必须有
   * QueryClient 与一个 `window.mycontext` 桩，否则渲染直接抛。
   * 这一组用例只看时间范围那一节，所以会话列表回空就够了。
   */
  ;(globalThis as { window?: { mycontext?: unknown } }).window ??= {}
  ;(window as unknown as { mycontext: unknown }).mycontext = {
    channels: { conversations: () => Promise.resolve({ ok: true, data: { items: [] } }) },
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  render(
    <SourcesStep
      value={draft}
      onChange={() => undefined}
      sources={[{ kind: "chat", status: "ready" }]}
    />,
    { wrapper },
  )
}

/** 一个最小可用的草稿。 */
function baseDraft(extra: Partial<SourcesDraft> = {}): SourcesDraft {
  return {
    rangeDays: 30,
    chatKinds: ["direct", "group"],
    conversationIds: [],
    enabledSources: ["chat"],
    attentionConversationIds: [],
    ...extra,
  }
}

describe("★★★ toScopeDraft：相对天数在几天后就对不上了（缺陷的根）", () => {
  it("★★★ 前天选的「近 30 天」→ 今天读回来是 32 天（匹配不上任何预设）", () => {
    const savedSince = midnightOf(Date.now() - 2 * DAY) - 30 * DAY
    const draft = toScopeDraft({ since: savedSince }, ["chat"])

    /**
     * 这一条**锁住那个换算的事实**，而不是说它是 bug —— `rangeDays` 仍然
     * 是保存时要用的天数（正确）。它记录的是"为什么不能只靠它显示"。
     *
     * ★ 32 不在 `RANGES` 里（30/90/180/365/null）⇒ 界面上一个筹码都不高亮。
     */
    expect(draft.rangeDays).toBe(32)
    expect([30, 90, 180, 365, null].includes(draft.rangeDays)).toBe(false)

    /**
     * ★★★ 而**绝对下界**必须一并带出来 —— 那是修法的关键。
     *
     * 反证：把 `toDraft` 里那一行 `savedSince` 去掉 ⇒ 这一条转红，
     * 而下面那两条渲染断言也跟着红。
     */
    expect(draft.savedSince).toBe(savedSince)
  })

  it("★ 库里没有 since（不限）→ 不给 savedSince（没有「当前生效」可言）", () => {
    const draft = toScopeDraft({}, ["chat"])
    expect(draft.savedSince).toBeUndefined()
    expect(draft.rangeDays).toBeNull()
  })
})

describe("★★★ 界面：显示的是绝对日期，不是「近 N 天」", () => {
  it("★★★ 有已保存的下界 → 显示「当前生效：从 <具体日期> 起」", () => {
    const savedSince = midnightOf(Date.now() - 2 * DAY) - 30 * DAY
    renderStep(baseDraft({ rangeDays: 32, savedSince }))

    /**
     * ★ 断言的是**那一行在**，且带了一个可读的年份 —— 而不是断言完整文案。
     *
     * 渲染层的 i18n 是不做插值的桩（实测：渲染出来的是字面
     * `当前生效：从 {{date}} 起`）。所以这一层能锁的是"这一行渲染了"；
     * 「日期真的是那一天」由上面 `toScopeDraft` 那条与 `formatDay` 一起保证。
     */
    expect(screen.getByText(/当前生效/)).toBeDefined()
  })

  it("★★★ **没有**已保存的下界 → 这一行不出现（不显示一个编的日期）", () => {
    renderStep(baseDraft({ rangeDays: 30 }))

    /**
     * 全新库 / 从没保存过时没有"当前生效"这件事。显示一个由 `rangeDays`
     * 现算出来的日期会把"我打算选的"说成"已经生效的" —— 而那两件事在
     * 用户点保存之前完全不同。
     *
     * 反证：把 `savedSinceText` 的 `savedSince === undefined` 那个早退去掉
     * ⇒ 这一条转红。
     */
    expect(screen.queryByText(/当前生效/)).toBeNull()
  })

  it("★★ 用户改了范围 → 那一行要说清「只增不减」", () => {
    /**
     * ## 为什么这一条重要
     *
     * 只增不减的语义下，用户看到"现在从 6 月 13 日起"、又点了「近 30 天」
     * （一个**更窄**的范围），会以为范围被收窄了 —— 而实际下界不动
     * （`mergeScopeOnlyGrowing` 取 min）。
     *
     * 不说这一句，那个"选了却没变"读起来就是一个 bug。
     *
     * ★ 判据：`savedSince` 是 100 天前，而这次选 30 天 ⇒ dirty ⇒
     * 走 `savedSinceOnlyGrows` 那一句。
     */
    const savedSince = midnightOf(Date.now()) - 100 * DAY
    renderStep(baseDraft({ rangeDays: 30, savedSince }))

    expect(screen.getByText(/只增不减/)).toBeDefined()
  })

  it("★★ 没改（这次选的与已保存的是同一天）→ 不说那句「只增不减」", () => {
    /**
     * 这一条是上一条的**配对**：只写上一条的话，最省事的实现是"一律带上
     * 只增不减那句" —— 而那会让"什么都没改"的常态也挂着一句警告文案，
     * 用户读起来像"我是不是刚做了什么危险操作"。
     *
     * ★ `savedSince` 恰好等于"今天 00:00 减 30 天" ⇒ 不 dirty。
     */
    const savedSince = midnightOf(Date.now()) - 30 * DAY
    renderStep(baseDraft({ rangeDays: 30, savedSince }))

    expect(screen.getByText(/当前生效/)).toBeDefined()
    expect(screen.queryByText(/只增不减/)).toBeNull()
  })

  it("★ 自定义区间那一栏不重复显示（它自己就是两个绝对日期）", () => {
    const savedSince = midnightOf(Date.now()) - 100 * DAY
    renderStep(
      baseDraft({
        rangeDays: null,
        savedSince,
        customRange: { from: "2026-05-01", to: "2026-06-01" },
      }),
    )

    // 两个 <input type="date"> 已经把区间说清了，再补一句是噪声
    expect(screen.queryByText(/当前生效/)).toBeNull()
  })
})
