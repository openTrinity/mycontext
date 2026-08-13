/**
 * @vitest-environment jsdom
 *
 * 引导的**监听范围步骤**（`AttentionStep`）—— 独立一步的判据。
 *
 * ## ★★★ 为什么监听范围是引导里的独立一步
 *
 * 改动前它只在运行状态页能配 → 走完引导的用户 `attention_scope` 是空表
 * → 路由走"名单为空则放行" → 分身对**所有**会话的新消息起草。那不是用户
 * 选的，是缺省值替他选的。
 *
 * 而它与学习范围（`sources` 步）语义相反（只增不减 vs 可随时关掉），
 * 所以**拆成独立一步**（用户原话「在 onboarding 也应该加一个步骤，不和
 * 学习范围放一起」），而不是塞在学习范围那一步的下半块。
 *
 * ## 三条判据，每条对应一个真实的坏形态
 *
 * ① **候选只给已勾进学习范围的会话** —— 否则能配出"监听了但不采集"：
 *    分身收到消息却拿不到上下文（`admit()` 要读历史），于是不回或回得离谱；
 * ② **候选为空时说清怎么办** —— 空列表读起来像"坏了"，而真相是
 *    "回上一步勾几个会话"（一个能立刻执行的动作）；
 * ③ **"一个都不勾"的含义要说出来** —— 它等于"不收窄"（盯全部），
 *    而用户的直觉是"不勾就是不启用"，方向正好相反。
 *
 * ## 为什么单独渲染 `AttentionStep` 而不是整页
 *
 * 与 `onboarding-channel-scope.test.tsx` 同一个理由：整页要装十几个 IPC
 * 通道，自己再拼一份必然漏、且会随别的功能演进反复红。这里的判据只关于
 * 这个组件"收到什么 props 时显示什么"。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { I18nextProvider } from "react-i18next"
import { createI18n } from "@mycontext/i18n"
import type { MyContextApi } from "@mycontext/ipc-contract"
import { AttentionStep } from "../../apps/desktop/src/renderer/features/onboarding/attention-step.js"
import type { SourcesDraft } from "../../apps/desktop/src/renderer/features/onboarding/sources-step.js"

afterEach(cleanup)

/** jsdom 没有 ResizeObserver，而 Button 走 useSquircle 会用它。 */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data })

const CH = "dingtalk"
/** 值全是编的（CLAUDE.md §1.2）。 */
const A = { id: "cidFAKE0001==", title: "沙箱项目群" }
const B = { id: "cidFAKE0002==", title: "周会同步群" }

/**
 * 文案锚点：只锚**换一种说法也得留着**的那几个字。
 *
 * 锚整句的代价见 `onboarding-channel-scope.test.tsx` 的注释：一次文案润色
 * 红一片，而实现一行没动 —— 那种红说的是"句子变了"，而判据本该说
 * "这个状态有没有被表达"。
 */
/** 「回上一步勾选」那句的骨架。★ 用"先选好"而非"上一步"——后者 hint 里也有。 */
const HINT_EMPTY = /先选好学习范围/
/** 「不勾 = 盯全部」那句的骨架 */
const HINT_ALL = /一个都不勾/

function installApi() {
  const api = {
    channels: {
      conversations: () =>
        ok({
          items: [
            {
              externalId: A.id,
              title: A.title,
              kind: "group" as const,
              memberCount: 9,
              lastMessageAt: 1_785_207_229_000,
              channelId: CH,
            },
            {
              externalId: B.id,
              title: B.title,
              kind: "group" as const,
              memberCount: 4,
              lastMessageAt: 1_785_207_229_000,
              channelId: CH,
            },
          ],
          truncated: false,
        }),
    },
  }
  ;(globalThis as { window?: unknown }).window ??= {}
  ;(window as unknown as { mycontext: unknown }).mycontext = api as unknown as MyContextApi
}

function draft(overrides: Partial<SourcesDraft> = {}): SourcesDraft {
  return {
    rangeDays: 90,
    chatKinds: ["direct", "group"],
    conversationIds: [],
    enabledSources: ["chat"],
    attentionConversationIds: [],
    ...overrides,
  }
}

function renderStep(value: SourcesDraft) {
  installApi()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const i18n = createI18n("zh")
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <AttentionStep value={value} onChange={() => undefined} channelFilter={new Set([CH])} />
      </I18nextProvider>
    </QueryClientProvider>,
  )
}

describe("引导步骤：分身监听范围（AttentionStep）", () => {
  it("★★★ 候选**只有已勾进学习范围**的会话（否则能配出「监听了但不采集」）", async () => {
    /**
     * 上一步（学习范围）只勾了 A。这一步的候选里只该有 A —— 勾一个没在采的
     * 群会得到"分身盯着一个没有历史上下文的会话"，它收到消息却答不好，
     * 而用户看不出成因（他明明勾了监听）。
     *
     * ★ 这一步**不含**学习范围列表（那在 SourcesStep），所以判据直接是
     * "A 出现、B 不出现"，不需要像上一版那样数出现次数。
     */
    renderStep(draft({ conversationIds: [A.id] }))
    await waitFor(() => expect(screen.getByText(A.title)).toBeTruthy())
    expect(screen.queryByText(B.title)).toBeNull()
  })

  it("★★★ 上一步没勾任何会话时，指回上一步（不是给一个空列表）", async () => {
    /**
     * 空列表读起来像"没有可选的东西"（坏了）。而真相是"回上一步勾几个"
     * —— 那是一个用户能立刻执行的动作。
     */
    renderStep(draft({ conversationIds: [] }))
    // 候选为空时不查询会话标题，等文案出现即可
    await waitFor(() => expect(screen.getByText(HINT_EMPTY)).toBeTruthy())
    // ★ 那时不该显示"不勾 = 盯全部"（还没有候选，那句话没有对象）
    expect(screen.queryByText(HINT_ALL)).toBeNull()
  })

  it("★★★ 有候选时，把「一个都不勾 = 盯全部」说出来", async () => {
    /**
     * 存量行为是"名单为空 → 全部放行"（`AttentionRouter.route()` 里那条
     * 迁移期判据：空表判成"什么都不关心"会让分身整个静默）。
     *
     * 所以在引导里不勾 **不等于** 关掉分身，而恰恰是"不收窄"。
     * 用户的直觉与此相反 —— 不说这句话，他会以为自己已经把分身关了。
     */
    renderStep(draft({ conversationIds: [A.id, B.id] }))
    await waitFor(() => expect(screen.getByText(HINT_ALL)).toBeTruthy())
    expect(screen.queryByText(HINT_EMPTY)).toBeNull()
  })
})

describe("★★★ 接线：监听范围步骤排在学习范围**之后**保存", () => {
  it("★★★ `attention` 步骤在 STEP_ORDER 里排在 `sources` 之后", async () => {
    /**
     * ## 为什么顺序重要
     *
     * `attentionScopeSave` 会把勾中的会话并入学习范围白名单（消灭"监听了
     * 但不采集"）。若 attention 排在 sources 之前，那次并入写进
     * `distill_sources` 的 id 会被 sources 步的 `saveSource` **整份覆盖** ——
     * 两次写都成功、日志里一个错都没有，只是并入静默失效。
     *
     * 拆成两步之后，顺序由 `STEP_ORDER` 保证（sources 先、attention 后），
     * 而不再靠"同一个 advance 分支里两行的先后"。所以这里锚 `STEP_ORDER`。
     */
    const { readFileSync } = await import("node:fs")
    const src = readFileSync(
      "apps/desktop/src/renderer/features/onboarding/onboarding-view.tsx",
      "utf8",
    )
    /**
     * ★ 从 `= [`（数组开括号）起切，而不是从 `STEP_ORDER` 那个词起 ——
     * 后者后面第一个 `]` 是类型标注 `OnboardingStepId[]` 的那个，
     * slice 会停在数组体之前，`indexOf('"attention"')` 拿到 -1。
     */
    const declStart = src.indexOf("STEP_ORDER: readonly OnboardingStepId[] = [")
    const bodyStart = src.indexOf("= [", declStart) + 3
    const order = src.slice(bodyStart, src.indexOf("]", bodyStart))
    const sourcesAt = order.indexOf('"sources"')
    const attentionAt = order.indexOf('"attention"')
    expect(sourcesAt).toBeGreaterThan(0)
    expect(attentionAt).toBeGreaterThan(0)
    expect(sourcesAt).toBeLessThan(attentionAt)
  })

  it("★★ `attention` 分支里空数组时**不调**保存（契约要求至少一个）", async () => {
    /**
     * 契约里 `conversationExternalIds` 是 `.min(1)`，调空的会报错。
     * 语义上空 = "不收窄"，而库里那张表本就是空的 —— "存空名单"与
     * "没存过"行为相同但含义不同，不该去调。
     */
    const { readFileSync } = await import("node:fs")
    const src = readFileSync(
      "apps/desktop/src/renderer/features/onboarding/onboarding-view.tsx",
      "utf8",
    )
    const at = src.indexOf("saveAttention.mutate(")
    expect(at).toBeGreaterThan(0)
    const guard = src.lastIndexOf("attentionConversationIds.length > 0", at)
    expect(guard).toBeGreaterThan(0)
    expect(guard).toBeLessThan(at)
  })
})
