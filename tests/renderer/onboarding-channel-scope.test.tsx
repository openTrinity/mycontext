/**
 * @vitest-environment jsdom
 *
 * 引导流程按渠道分清：第 4 步不列非主渠道的会话；只连只读渠道时第 3/5 步说清用不了。
 *
 * ## 实测的坏形态（用户截图 2026-08-10）
 *
 * 第 4 步「学习范围」的会话列表**把两个渠道的会话混在一起**（其中一项带飞书
 * 图标、其余带钉钉图标）。而这一步喂给的是第 5 步「开始学习」（蒸馏），
 * 而 `DistillService` 只有一个 `this.db`（主库）、**没有渠道概念** ——
 * 非主渠道的语料在 `sources/<channelId>/core.sqlite` 里，蒸馏压根不读。
 *
 * 所以勾上非主渠道的会话是一个**不会兑现的动作**：界面上有勾、学习时不算、
 * 而且不报错。
 *
 * 同一批问题的另一半 —— 只连了只读渠道（飞书 `sendAs: []`）时：
 * · 第 3 步填完名字与形象 → 分身一直不说话，而用户找不到原因；
 * · 第 5 步点开始 → 跑完什么都没学到，也不报错。
 *
 * ## 为什么单独渲染这三个组件，而不是整页 `OnboardingView`
 *
 * 整页要装十几个 IPC 通道（`onboarding-flow.test.tsx` 里那份 fixture 200 行
 * 且还在长）—— 自己再拼一份必然漏，而且会随别的功能演进反复红。
 * 这里要验的判据只关于**这三个组件收到什么 props 时显示什么**，
 * 与整页装配无关。整页那条路已经由 `onboarding-flow.test.tsx` 盖住。
 *
 * 与 `distill-result.test.tsx` 同一个范式（它也是单独渲染 `DistillStep`）。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { I18nextProvider } from "react-i18next"
import { createI18n } from "@mycontext/i18n"
import type { MyContextApi } from "@mycontext/ipc-contract"
import { SourcesStep } from "../../apps/desktop/src/renderer/features/onboarding/sources-step.js"
import { PersonaStep } from "../../apps/desktop/src/renderer/features/onboarding/persona-step.js"
import { DistillStep } from "../../apps/desktop/src/renderer/features/onboarding/distill-step.js"

afterEach(cleanup)

/** jsdom 没有 ResizeObserver，而 Button 走 useSquircle 会用它。 */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data })

/** 主渠道的会话（应当出现）。值全是编的（CLAUDE.md §1.2）。 */
const PRIMARY_TITLE = "主渠道的群"
/** 非主渠道的会话（**不应**出现在引导第 4 步）。 */
const SOURCE_TITLE = "只读渠道的群"

const PRIMARY_CHANNEL_ID = "dingtalk"
const SOURCE_CHANNEL_ID = "feishu"

/**
 * 装最小 api —— 只给这三个组件真正会碰的通道。
 *
 * ★ 会话列表是**混渠道**的：主进程本来就这么给（每项带 `channelId`，
 * 见 `DistillSourceService.conversations()` 的注释「只用于分组显示与回存分流」）。
 */
function installApi() {
  const api = {
    channels: {
      conversations: () =>
        ok({
          items: [
            {
              externalId: "cidFAKE0001==",
              title: PRIMARY_TITLE,
              kind: "group" as const,
              memberCount: 9,
              lastMessageAt: 1_785_207_229_000,
              channelId: PRIMARY_CHANNEL_ID,
            },
            {
              externalId: "ocFAKE0001",
              title: SOURCE_TITLE,
              kind: "group" as const,
              memberCount: 4,
              lastMessageAt: 1_785_207_229_000,
              channelId: SOURCE_CHANNEL_ID,
            },
          ],
          truncated: false,
        }),
    },
    /**
     * ★ 形状照 `distill-result.test.tsx`（那份是跟着真实契约长的）。
     * 少一个键的表现是渲染中抛，而用例会报一个"正确结论、错误理由"的失败。
     */
    distill: {
      progress: () =>
        ok({
          total: 0,
          pending: 0,
          running: 0,
          done: 0,
          failed: 0,
          skipped: 0,
          costTokens: 0,
          lastError: null,
          facetCount: 0,
          forge: { available: true, step: null },
        }),
      start: () => ok({}),
      reset: () => ok({}),
      onProgress: () => () => undefined,
    },
    ingest: {
      snapshot: () => ok({ backfill: null }),
      onProgress: () => () => undefined,
    },
    /** 第 5 步也显示图谱那条链路 —— 不装会在渲染中抛。给一份"已就绪"。 */
    kl: {
      serverStatus: () =>
        ok({
          state: "ready" as const,
          reason: null,
          port: 8200,
          building: false,
          networkEgress: true,
          buildProgress: null,
        }),
      graphOverview: () =>
        ok({
          available: true,
          reason: null,
          entities: 0,
          facts: 0,
          edges: 0,
          chunks: 0,
          messages: 0,
          entityTypes: [],
          factTypes: [],
          hubs: [],
        }),
      onStatus: () => () => undefined,
    },
    forge: { status: () => ok({ available: true, step: null }) },
  } as unknown as MyContextApi
  ;(globalThis as { window?: { mycontext?: MyContextApi } }).window ??= {}
  ;(window as unknown as { mycontext: MyContextApi }).mycontext = api
}

function wrap(node: React.ReactElement) {
  installApi()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <I18nextProvider i18n={createI18n("zh")}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </I18nextProvider>,
  )
}

const SOURCES_DRAFT = {
  rangeDays: 30,
  customRange: null,
  chatKinds: ["direct", "group"] as ("direct" | "group")[],
  conversationIds: [],
  enabledSources: [],
}

describe("★★★ 第 4 步只列主渠道的会话", () => {
  it("主渠道的会话出现", async () => {
    wrap(
      <SourcesStep
        value={SOURCES_DRAFT}
        onChange={() => undefined}
        sources={[]}
        channelFilter={PRIMARY_CHANNEL_ID}
      />,
    )
    await waitFor(() => {
      expect(screen.getByText(PRIMARY_TITLE)).toBeTruthy()
    })
  })

  /**
   * ★★★ 核心判据，**否定式**：非主渠道的会话不许出现。
   *
   * 先等主渠道那条渲染出来 —— 否则"找不到"可能只是列表还没加载完，
   * 那种绿是假的（判据永真）。
   */
  it("★★★ 非主渠道的会话不出现（勾了也不会被学习）", async () => {
    wrap(
      <SourcesStep
        value={SOURCES_DRAFT}
        onChange={() => undefined}
        sources={[]}
        channelFilter={PRIMARY_CHANNEL_ID}
      />,
    )
    await waitFor(() => {
      expect(screen.getByText(PRIMARY_TITLE)).toBeTruthy()
    })
    expect(screen.queryByText(SOURCE_TITLE)).toBeNull()
  })

  /**
   * ★★★ 引导页**真的传了** `channelFilter`。
   *
   * ## 为什么必须有这一条
   *
   * 上面那两条直接渲染 `SourcesStep` 并自己传 filter —— 它们验的是"组件收到
   * filter 时会过滤"，**验不到"引导页有没有传"**。实测过：把
   * `onboarding-view.tsx` 里那一行删掉，上面 9 条全绿，而 bug 完整复现。
   *
   * 而整页渲染那条路要装十几个 IPC 通道（见文件头），代价远高于收益。
   * 所以这里直接读源码判那一行 —— 判据很窄：**那次调用带没带 channelFilter**。
   *
   * ★ 先剥注释：注释里写了不等于代码里做了（这个仓库最贵的 bug 就是那种）。
   */
  it("★★★ onboarding-view 给 SourcesStep 传了 channelFilter", async () => {
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const source = readFileSync(
      join(process.cwd(), "apps/desktop/src/renderer/features/onboarding/onboarding-view.tsx"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    const start = source.indexOf("<SourcesStep")
    expect(start, "找不到 SourcesStep 的调用 —— 结构变了就把这条判据跟着改").toBeGreaterThan(-1)
    const call = source.slice(start, source.indexOf("/>", start))
    expect(call, "引导第 4 步必须传 channelFilter，否则会列出别的渠道的会话").toContain(
      "channelFilter",
    )
  })

  /**
   * ★ 反证这个 fixture 真的**含**两个渠道 —— 不然上面那条可能只是
   * "fixture 里压根没有飞书那条"，判据永真。
   */
  it("★ 不过滤时两条都在（证明 fixture 确实混渠道）", async () => {
    wrap(<SourcesStep value={SOURCES_DRAFT} onChange={() => undefined} sources={[]} />)
    await waitFor(() => {
      expect(screen.getByText(PRIMARY_TITLE)).toBeTruthy()
    })
    expect(screen.getByText(SOURCE_TITLE)).toBeTruthy()
  })
})

describe("★★ 第 3 步：没有能跑分身的渠道时说清楚", () => {
  /**
   * ★ 用 `undefined` 而不是 `null` 表示"没挑过形象"。
   *
   * `PersonaDraft.figureStyle` 是**可选**字段（`figureStyle?: FigureStyle`），
   * 组件里走 `value.figureStyle ?? FIGURE_STYLES[0]` —— 而 `??` 对 null 也
   * 生效，所以 null 本该也行。第一版给 null 时报
   * `Cannot read properties of null (reading 'toString')`，说明**别的**字段
   * （seed）才是那个 null 敏感点：`resolvePersonaFigureSeed` 之后有人调
   * `.toString()`。这里按契约的可选语义给 undefined，与真实回填一致
   * （`readPersonaIdentity` 不会产出 null）。
   */
  const draft = { name: "小助手" }

  it("★★ 显示「等你连上…才生效」", async () => {
    wrap(
      <PersonaStep
        value={draft}
        onChange={() => undefined}
        showNameError={false}
        personaHostConnected={false}
      />,
    )
    await waitFor(() => {
      expect(screen.getByText(/才生效/)).toBeTruthy()
    })
  })

  it("★ 连上了就**不显示**（别修成「永远不可用」）", async () => {
    wrap(
      <PersonaStep
        value={draft}
        onChange={() => undefined}
        showNameError={false}
        personaHostConnected
      />,
    )
    // 等这一步真的渲染出来（名字输入框是它的标志）
    await waitFor(() => {
      expect(screen.getAllByRole("textbox").length).toBeGreaterThan(0)
    })
    expect(screen.queryByText(/才生效/)).toBeNull()
  })
})

describe("★★ 第 5 步：语料渠道没连时说清楚 + 主按钮灰", () => {
  it("★★ 显示「什么都学不到」", async () => {
    wrap(<DistillStep rangeDays={30} modelConfigured corpusChannelConnected={false} />)
    await waitFor(() => {
      expect(screen.getByText(/什么都学不到/)).toBeTruthy()
    })
  })

  it("★ 连上了就不显示", async () => {
    wrap(<DistillStep rangeDays={30} modelConfigured corpusChannelConnected />)
    await waitFor(() => {
      expect(screen.getAllByRole("button").length).toBeGreaterThan(0)
    })
    expect(screen.queryByText(/什么都学不到/)).toBeNull()
  })

  /**
   * ★★★ 主按钮 disabled —— 否则点了会跑完并什么都学不到（静默）。
   *
   * ★ 判据落在**那个按钮**上而不是"页面上有 disabled 的按钮"：
   * 这一步还有别的按钮（重来），而它的禁用条件不同。
   */
  it("★★★ 语料渠道没连 → 开始学习的按钮是灰的", async () => {
    wrap(<DistillStep rangeDays={30} modelConfigured corpusChannelConnected={false} />)
    await waitFor(() => {
      expect(screen.getByText(/什么都学不到/)).toBeTruthy()
    })
    const buttons = screen.getAllByRole("button")
    /**
     * 找"开始学习"那个：它是这一页唯一会去调 `distill.start` 的按钮。
     * 用文案定位而不是下标 —— 下标会随布局调整而错位。
     */
    const start = buttons.find((b) => /开始|学习/.test(b.textContent ?? ""))
    expect(start, "找不到开始学习按钮 —— 文案变了？").toBeDefined()
    expect(start?.hasAttribute("disabled")).toBe(true)
  })

  it("★ 连上了那个按钮就是可点的（反证上面那条不是永真）", async () => {
    wrap(<DistillStep rangeDays={30} modelConfigured corpusChannelConnected />)
    await waitFor(() => {
      expect(screen.getAllByRole("button").length).toBeGreaterThan(0)
    })
    const start = screen
      .getAllByRole("button")
      .find((b) => /开始|学习/.test(b.textContent ?? ""))
    expect(start?.hasAttribute("disabled")).toBe(false)
  })
})
