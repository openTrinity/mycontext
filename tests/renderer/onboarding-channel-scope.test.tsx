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

/**
 * 文案锚点：只锚**稳定的核心词**，不锚整句。
 *
 * ## ★ 为什么单独提出来
 *
 * 第一版这些判据锚的是完整句子（"才生效"/"需要先连上"/"不会用来替你回复"）。
 * 用户一次文案润色（口语腔改成产品化表述）就红了 4 条 —— 而实现一行没动。
 * 那种红是噪音：它说的是"句子变了"，而判据本该说"这个状态有没有被表达"。
 *
 * 核心词的判据是：**换一种说法也得留着的那几个字**。
 * 「暂不支持」「数字分身」是这一批文案的语义骨架，润色不会把它们改掉；
 * 而「才生效」「做不了」是语气，随时会变。
 */
const HINT_READ_ONLY = /不参与数字分身/
const HINT_PERSONA_UNSUPPORTED = /暂不支持数字分身/
const HINT_STEP_UNSUPPORTED = /暂不支持/

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
  /** 监听范围（v29 这一轮新加）。这一组用例不验它 → 空数组。 */
  attentionConversationIds: [],
}

describe("★★★ 第 4 步列的是「已连渠道」的会话", () => {
  /**
   * ★★★ 只连飞书 → 列表里是**飞书**的会话，钉钉的不出现。
   *
   * ## 这一条与上一版恰好相反，值得记下来
   *
   * 上一版我传的是写死的主渠道 id，理由是"这一步喂给蒸馏、而蒸馏只读主库"。
   * 那个前提是错的：`conversationIds` 是**采集白名单**（决定采哪些会话），
   * 而采集按渠道各自跑 —— 每个渠道的 `IngestService` 读自己库里的白名单。
   *
   * 真机表现（用户报的）：只连了飞书时，列表里是**已退登渠道**的 55 个
   * 历史会话，而真正连着的飞书 4 个反倒看不见。
   */
  it("★★★ 只连飞书 → 有飞书的、没有钉钉的", async () => {
    wrap(
      <SourcesStep
        value={SOURCES_DRAFT}
        onChange={() => undefined}
        sources={[]}
        channelFilter={new Set([SOURCE_CHANNEL_ID])}
      />,
    )
    await waitFor(() => {
      expect(screen.getByText(SOURCE_TITLE)).toBeTruthy()
    })
    expect(screen.queryByText(PRIMARY_TITLE)).toBeNull()
  })

  it("★★ 两个都连 → 两边的会话都在", async () => {
    wrap(
      <SourcesStep
        value={SOURCES_DRAFT}
        onChange={() => undefined}
        sources={[]}
        channelFilter={new Set([PRIMARY_CHANNEL_ID, SOURCE_CHANNEL_ID])}
      />,
    )
    await waitFor(() => {
      expect(screen.getByText(PRIMARY_TITLE)).toBeTruthy()
    })
    expect(screen.getByText(SOURCE_TITLE)).toBeTruthy()
  })

  /**
   * ★★ 一个渠道都没连 → 列表空。
   *
   * 空集**不是**"不过滤"（那是 `undefined`）—— 它是一个有意义的真实状态。
   * 判成不过滤会让退登之后仍列出全部历史会话。
   */
  it("★★ 空集 = 一个都没连 → 两边都不出现", async () => {
    wrap(
      <SourcesStep
        value={SOURCES_DRAFT}
        onChange={() => undefined}
        sources={[]}
        channelFilter={new Set()}
      />,
    )
    // 等组件把列表渲染完（会话区的标题一定在）
    await waitFor(() => {
      expect(screen.getAllByText(/会话|单聊|群聊/).length).toBeGreaterThan(0)
    })
    expect(screen.queryByText(PRIMARY_TITLE)).toBeNull()
    expect(screen.queryByText(SOURCE_TITLE)).toBeNull()
  })

  /**
   * ★ 反证 fixture 真的含两个渠道 —— 不然上面那些"没出现"可能永真。
   */
  it("★ 不过滤（undefined）时两条都在", async () => {
    wrap(<SourcesStep value={SOURCES_DRAFT} onChange={() => undefined} sources={[]} />)
    await waitFor(() => {
      expect(screen.getByText(PRIMARY_TITLE)).toBeTruthy()
    })
    expect(screen.getByText(SOURCE_TITLE)).toBeTruthy()
  })

  /**
   * ★★★ 顶部计数只算**可见的**，而「清空」**只清可见的**。
   *
   * ## 这一条锁的是一次真实的数据丢失路径
   *
   * `conversationIds` 是**跨渠道**的一份（保存时才按渠道分桶），所以按渠道
   * 过滤之后它里面有一批看不见的 id。实测（真机截图）：只连飞书时顶部写着
   * 「已选 13 个」而列表里是 4/4 —— 那 9 个是钉钉的旧勾选。
   *
   * 计数错只是误导；**「清空」清掉整个数组才是数据丢失** —— 用户在飞书这一屏
   * 点清空，钉钉的白名单跟着没了，而屏幕上没有任何痕迹。那与这一轮修过的
   * 「保存飞书范围清空了钉钉白名单」是同一形状。
   */
  it("★★★ 顶部计数只算可见的（跨渠道的旧勾选不该算进来）", async () => {
    wrap(
      <SourcesStep
        value={{ ...SOURCES_DRAFT, conversationIds: ["ocFAKE0001", "cidFAKE0001==", "cid-旧的"] }}
        onChange={() => undefined}
        sources={[]}
        channelFilter={new Set([SOURCE_CHANNEL_ID])}
      />,
    )
    /**
     * ★ 用 `getAllByText` 等列表加载。
     *
     * 一个被勾选的会话现在会出现**两次**：学习范围列表一次、
     * 「分身监听范围」的候选一次（候选就是已勾选的那些，见
     * `attentionCandidates`）。`getByText` 在多命中时抛错 ——
     * 而那与"列表没加载出来"是两种完全不同的失败。
     */
    await waitFor(() => {
      expect(screen.getAllByText(SOURCE_TITLE).length).toBeGreaterThan(0)
    })
    // 三个勾选里只有 ocFAKE0001 属于飞书 → 顶部应当是 1，不是 3
    expect(screen.getByText(/已选\s*1\s*个/)).toBeTruthy()
  })

  it("★★★ 「清空」只清可见的 —— 别渠道的勾选必须留着", async () => {
    let next: { conversationIds: string[] } | null = null
    wrap(
      <SourcesStep
        value={{ ...SOURCES_DRAFT, conversationIds: ["ocFAKE0001", "cidFAKE0001=="] }}
        onChange={(v) => {
          next = v
        }}
        sources={[]}
        channelFilter={new Set([SOURCE_CHANNEL_ID])}
      />,
    )
    // ★ 同上：被勾选的会话在监听候选里也会出现一次
    await waitFor(() => {
      expect(screen.getAllByText(SOURCE_TITLE).length).toBeGreaterThan(0)
    })
    const clear = screen.getAllByRole("button").find((b) => /清空/.test(b.textContent ?? ""))
    expect(clear, "找不到清空按钮").toBeDefined()
    clear?.click()

    await waitFor(() => {
      expect(next).not.toBeNull()
    })
    // ★ 核心：飞书那个被清掉，钉钉那个**还在**
    expect(next?.conversationIds).toEqual(["cidFAKE0001=="])
  })

  /**
   * ★★ 只读渠道的会话选了不会进自动回复 —— 那句话必须在。
   *
   * 这一步叫「学习范围」，而"学习"在用户心里等于"分身会学会这些话怎么说"。
   * 只读渠道上那件事不会发生（数据只进图谱与搜索）—— 不说清的话用户以为
   * 自己在给分身喂料，而分身永远用不到它。
   */
  it("★★ 只读渠道的会话在列表里 → 显示「不参与数字分身」", async () => {
    wrap(
      <SourcesStep
        value={SOURCES_DRAFT}
        onChange={() => undefined}
        sources={[]}
        channelFilter={new Set([SOURCE_CHANNEL_ID])}
        readOnlyChannelIds={new Set([SOURCE_CHANNEL_ID])}
      />,
    )
    await waitFor(() => {
      expect(screen.getByText(SOURCE_TITLE)).toBeTruthy()
    })
    expect(screen.getByText(HINT_READ_ONLY)).toBeTruthy()
  })

  /**
   * ★★ 列表里**没有**只读渠道的会话时不显示那句。
   *
   * 判据是"列出来的东西里有"，不是"集合非空" —— 只连了只读渠道但它一条
   * 会话都没采到时，那句说明是多余的（空列表旁边写着"选中的会话只用于…"）。
   */
  it("★★ 只列主渠道时不显示那句（判据是列表内容，不是集合非空）", async () => {
    wrap(
      <SourcesStep
        value={SOURCES_DRAFT}
        onChange={() => undefined}
        sources={[]}
        channelFilter={new Set([PRIMARY_CHANNEL_ID])}
        readOnlyChannelIds={new Set([SOURCE_CHANNEL_ID])}
      />,
    )
    await waitFor(() => {
      expect(screen.getByText(PRIMARY_TITLE)).toBeTruthy()
    })
    expect(screen.queryByText(HINT_READ_ONLY)).toBeNull()
  })

  /**
   * ★★★ 引导页传的是**已授权渠道集合**，不是写死的单个 id。
   *
   * 上面那些直接渲染组件、自己传 filter —— 验不到"调用方传了什么"。
   * 而这次的 bug 恰恰在调用方（我写死了主渠道）。所以这条读源码。
   */
  it("★★★ onboarding-view 传的是 authorizedChannelIds，不是写死的 id", async () => {
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const source = readFileSync(
      join(process.cwd(), "apps/desktop/src/renderer/features/onboarding/onboarding-view.tsx"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    const start = source.indexOf("<SourcesStep")
    expect(start, "找不到 SourcesStep 的调用").toBeGreaterThan(-1)
    const call = source.slice(start, source.indexOf("/>", start))
    expect(call, "第 4 步必须按渠道过滤").toContain("channelFilter")
    expect(call, "不许写死主渠道 —— 只连飞书时会列出已退登渠道的历史会话").not.toContain(
      "PRIMARY_CHANNEL_ID",
    )
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

  it("★★ 显示「当前渠道暂不支持数字分身」", async () => {
    wrap(
      <PersonaStep
        value={draft}
        onChange={() => undefined}
        showNameError={false}
        personaHostConnected={false}
      />,
    )
    await waitFor(() => {
      expect(screen.getByText(HINT_PERSONA_UNSUPPORTED)).toBeTruthy()
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
    expect(screen.queryByText(HINT_PERSONA_UNSUPPORTED)).toBeNull()
  })
})

describe("★★★ 第 5 步：主渠道没连时整块换成说明", () => {
  /**
   * ## 为什么是「整块换掉」而不是加一条横幅
   *
   * 整条蒸馏链只认主渠道，不是漏了个参数：`distill.attach(handle.db, …)` 传
   * 主库、`forge.run({ db: handle.db })` 同样，而 `forge.service.ts:249` 更直接
   * —— `SelfIdentityRepository(input.db).get("dingtalk")`，**渠道 id 写死**。
   *
   * 所以主渠道没连时这一步**不适用**。我上一版加的是一条横幅，真机截图里
   * 同屏三句话互相打架：横幅说做不了、下面说"已入库 1,724 条"、按钮还能点。
   *
   * ★ 不自动 skip：那会写库（替用户做决定），而这是唯一产出画像的一步。
   * 底部的「跳过这步」在 `onboarding-view` 的 footer 里，不受这个 early-return
   * 影响 —— 软门保住了。
   */
  it("★★★ 没连 → 显示说明，且**不渲染**进度与开始按钮", async () => {
    wrap(<DistillStep rangeDays={30} modelConfigured corpusChannelConnected={false} />)
    await waitFor(() => {
      expect(screen.getByText(HINT_STEP_UNSUPPORTED)).toBeTruthy()
    })
    // ★ 核心：那套会误导人的东西一个都不在
    expect(
      screen.queryByRole("button", { name: /开始学习/ }),
      "还渲染着开始按钮 —— 点了会跑一个只认主渠道的流程",
    ).toBeNull()
    expect(screen.queryByText(/学习进度/)).toBeNull()
    expect(screen.queryByText(/已扫描选定的/)).toBeNull()
  })

  it("★★ 连上了 → 正常渲染（别修成「永远不可用」）", async () => {
    wrap(<DistillStep rangeDays={30} modelConfigured corpusChannelConnected />)
    await waitFor(() => {
      expect(screen.getAllByRole("button").length).toBeGreaterThan(0)
    })
    expect(screen.queryByText(HINT_STEP_UNSUPPORTED)).toBeNull()
    const start = screen.getAllByRole("button").find((b) => /开始|学习/.test(b.textContent ?? ""))
    expect(start, "连上了却没有开始按钮").toBeDefined()
    expect(start?.hasAttribute("disabled")).toBe(false)
  })

  /**
   * ★★ 说明里要给**下一步动作**，不能只说"不可用"。
   *
   * 判据是"提到第 1 步或钉钉" —— 用户要知道去哪做什么。
   * 只说"这一步需要先连上"而不说去哪连，等于把人留在原地。
   */
  it("★★ 说明里给了可照做的下一步", async () => {
    wrap(<DistillStep rangeDays={30} modelConfigured corpusChannelConnected={false} />)
    await waitFor(() => {
      expect(screen.getByText(HINT_STEP_UNSUPPORTED)).toBeTruthy()
    })
    /**
     * ★ `getAllByText` 而不是 `getByText`：标题与正文里**都**提到了
     * （标题「需要先连上钉钉」+ 正文「回第 1 步连上钉钉」），
     * 而 `getByText` 遇到多个匹配会抛。这里要的判据是"至少说了一处"。
     */
    expect(screen.getAllByText(/第 1 步|钉钉/).length).toBeGreaterThan(0)
  })
})
