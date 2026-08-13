/**
 * @vitest-environment jsdom
 *
 * 引导页的行为门禁（真渲染，不是源码文本断言）。
 *
 * ## 这里锁住的是四条**曾经错过或很容易再错**的行为
 *
 * 1. **进度来自库，不是 state** —— 首版用局部 state 记"第几步"，
 *    关掉窗口再开就从头开始。所以断言：库里说前两步 done，
 *    页面就该停在第 3 步，而不是第 1 步。
 * 2. **skipped 与 pending 可区分** —— 用户跳过后重进，那一步要显示"已跳过"。
 *    显示成"待办"会让人以为上次的操作没生效。
 * 3. **可以前后跳** —— 引导不是 wizard。点第 1 步要真能回去
 *    （而且回去之后不该被 refetch 弹走 —— 那是 `jumped` 闩住的那个 bug）。
 * 4. **未接入的资料源要标出来** —— 只有 chat/minutes 真能采。
 *    不标的话用户勾了"邮箱"永远等不到数据且不报错。
 *
 * 用真渲染而不是读源码字符串：这四条都是**运行时行为**，
 * 源码里看不出"进度到了会不会跳"。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { I18nextProvider } from "react-i18next"
import { createI18n } from "@mycontext/i18n"
import type { MyContextApi, OnboardingStepView } from "@mycontext/ipc-contract"
import { OnboardingView } from "../../apps/desktop/src/renderer/features/onboarding/onboarding-view.js"
import {
  SourcesStep,
  type SourcesDraft,
} from "../../apps/desktop/src/renderer/features/onboarding/sources-step.js"

afterEach(cleanup)

/**
 * jsdom 没有 `ResizeObserver`，而 Button 走 `useSquircle` 会用它。
 *
 * 补一个不做事的桩：这里要验的是引导流程的行为，
 * 而 squircle 是纯视觉（圆角形状）—— 它在 jsdom 里本来也测不出什么。
 */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver

/** 一行进度。缺省 pending，用参数覆盖成 done/skipped。 */
function step(
  id: string,
  state: "pending" | "done" | "skipped",
  payload?: unknown,
): OnboardingStepView {
  return { step: id as OnboardingStepView["step"], state, payload, updatedAt: 1 }
}

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data })

interface Recorded {
  stepDone: { step: string; payload?: unknown }[]
  stepSkip: { step: string }[]
  sourceSave: { kind: string; enabled: boolean }[]
  conversationCalls: number
  /** 让用例指定探测结果：null = 成功；否则按这个 reason 失败 */
  probeReason: "unauthorized" | "unreachable" | "badResponse" | "noKey" | null
}

/**
 * 装一个最小的 `window.mycontext`。
 *
 * 只实现引导页会碰的那几个方法，其余留 undefined —— 引导页要是碰了
 * 别的通道，这里会抛而不是静默走别的分支，那正是我们想知道的。
 */
function installApi(steps: OnboardingStepView[]): Recorded {
  const recorded: Recorded = {
    stepDone: [],
    stepSkip: [],
    sourceSave: [],
    conversationCalls: 0,
    probeReason: null,
  }

  const api = {
    channels: {
      list: () =>
        ok([
          {
            id: "dingtalk",
            labelKey: "channels:dingtalk.label",
            descriptionKey: "channels:dingtalk.description",
            available: true,
            status: { state: "unauthorized" },
          },
          {
            id: "feishu",
            labelKey: "channels:feishu.label",
            descriptionKey: "channels:feishu.description",
            available: true,
            status: { state: "unauthorized" },
          },
        ]),
      /**
       * 授权进度订阅。
       *
       * 必须实现：第 1 步的渠道面板会订阅它，缺了会抛
       * `onAuthProgress is not a function` —— 而那次抛发生在渲染中，
       * 表现是"整页空白但用例说停在第 1 步"（正确结论、错误理由）。
       */
      onAuthProgress: () => () => undefined,
      authStatus: () => ok({ state: "unauthorized" }),
      authStart: () => ok({ state: "unauthorized" }),
      authCancel: () => ok(true),
      conversations: () => {
        recorded.conversationCalls += 1
        return ok({
          items: [
            {
              externalId: "cid-a",
              title: "连接器产研交流群",
              kind: "group" as const,
              memberCount: 16,
              lastMessageAt: 1_785_207_229_000,
            },
            {
              externalId: "cid-b",
              title: "小王",
              kind: "direct" as const,
              memberCount: 2,
              lastMessageAt: null,
            },
          ],
          truncated: true,
        })
      },
    },
    onboarding: {
      steps: () => ok(steps),
      stepDone: (input: { step: string; payload?: unknown }) => {
        recorded.stepDone.push(input)
        return ok(true as const)
      },
      stepSkip: (input: { step: string }) => {
        recorded.stepSkip.push(input)
        return ok(true as const)
      },
      complete: () => ok(true as const),
      skip: () => ok(true as const),
      restart: () => ok(true as const),
    },
    /**
     * 第 4 步会读 `persona.snapshot()`（拿 `agentAvailable` 判断有没有配模型）
     * 与 `distill.progress()`。不实现的话整棵树在渲染时就抛。
     */
    persona: {
      snapshot: () =>
        ok({
          running: false,
          agentAvailable: false,
          killSwitch: false,
          listeningCount: 0,
          pendingInbox: 0,
          pendingDrafts: 0,
          residents: [],
        }),
      onSnapshot: () => () => undefined,
    },
    /**
     * ★ 第 4 步现在有一块知识图谱概览（`GraphSection`）。
     *
     * 不装这两个通道的话它在渲染时就抛 `Cannot read properties of
     * undefined (reading 'serverStatus')` —— 而那次抛发生在 effect 里，
     * 表现是整棵树挂掉，于是**别的**用例报"找不到进入应用"。
     * 那正是这个桩存在的理由：让失败的理由与结论对得上。
     *
     * `serverStatus` 报 stopped + 没在建图，`graphOverview` 报"还没建图"
     * —— 这些用例验的不是图谱，给一个明确的空态就够了。
     */
    /**
     * ★ 第 4 步现在还会读采集快照（`useIngestSnapshot`）——
     * 那是「语料覆盖范围」那一块要的（用户选了 180 天、目前采到多少）。
     *
     * 不装 `onProgress` 的话它在 effect 里抛
     * `Cannot read properties of undefined (reading 'onProgress')` ——
     * 整棵树挂掉，于是**别的**用例报"找不到进入应用"。
     */
    ingest: {
      snapshot: () =>
        ok({
          running: false,
          channelId: "dingtalk",
          messages: 0,
          conversations: 0,
          unjudged: 0,
          outboxHead: 0,
          ftsIndexed: 0,
          ftsLag: 0,
          probeIntervalMs: 0,
          probeThrottled: false,
          lastError: null,
          blockedReason: null,
          failedAttempts: 0,
          selfConfirmed: true,
          mediaAssets: 0,
          minutes: 0,
          storage: { mainBytes: 0, walBytes: 0, rawRecords: 0, rawPruned: 0, vectors: 0 },
          staleConsumers: [],
          // null = 没在回溯（这些用例验的不是覆盖范围）
          backfill: null,
        }),
      onProgress: () => () => undefined,
      /**
       * 身份确认三件套：onboarding 的 channel 步在「已授权但未确认」时会
       * 就地渲染 `SelfIdentityPanel`，它读 `readSelf` 并可调 resolve/confirm。
       * 默认返回一个未确认的解析结果——足够让面板渲染出来（软门用例要断言它在）。
       */
      readSelf: () =>
        ok({
          channelId: "dingtalk",
          userId: "u1",
          openIds: [{ kind: "openDingTalkId", value: "od-1" }],
          displayNames: ["测试用户"],
          corpName: "测试企业",
          matchedMessageCount: 0,
          confirmed: false,
        }),
      resolveSelf: () =>
        ok({
          channelId: "dingtalk",
          userId: "u1",
          openIds: [{ kind: "openDingTalkId", value: "od-1" }],
          displayNames: ["测试用户"],
          corpName: "测试企业",
          matchedMessageCount: 3,
          confirmed: false,
        }),
      confirmSelf: () => ok({ backfilled: 3, mentionsBackfilled: 0 }),
    },
    kl: {
      serverStatus: () =>
        ok({ state: "stopped" as const, reason: null, port: null, building: false }),
      onStatus: () => () => undefined,
      graphOverview: () => ok({ available: false, reason: "还没建过图" }),
    },
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
          running_: false,
        }),
      start: () => ok({}),
      reset: () => ok({}),
      onProgress: () => () => undefined,
      sources: () =>
        ok([
          {
            kind: "chat",
            enabled: true,
            scope: {},
            lastSyncedSeq: 0,
            state: "idle",
            lastError: null,
            status: "ready" as const,
          },
          {
            kind: "minutes",
            enabled: true,
            scope: {},
            lastSyncedSeq: 0,
            state: "idle",
            lastError: null,
            status: "ready" as const,
          },
          {
            kind: "mail",
            enabled: false,
            scope: {},
            lastSyncedSeq: 0,
            state: "idle",
            lastError: null,
            status: "planned" as const,
          },
        ]),
      sourceSave: (input: { kind: string; enabled: boolean }) => {
        recorded.sourceSave.push(input)
        return ok(true as const)
      },
      sourceReset: () => ok(true as const),
    },
    /**
     * 第 2 步（模型）渲染 `ModelConfigForm`，它读 `runtimeConfig.read()`
     * 并订阅 `onChanged`。给一个明确的空态 —— 这些用例验的不是模型配置。
     */
    runtimeConfig: {
      read: () =>
        ok({
          llmBaseUrl: { value: "", source: "default" as const },
          llmApiKey: { configured: false, tail: null, source: "default" as const },
          modelMain: { value: "glm-5.2", source: "default" as const },
          mainProvider: { value: "openai" as const, source: "default" as const },
          embedModel: { value: "text-embedding-v4", source: "default" as const },
          klLlmBaseUrl: { value: "", source: "default" as const },
          klLlmApiKey: { configured: false, tail: null, source: "default" as const },
          klModelMain: { value: "", source: "default" as const },
          klProvider: { value: "openai" as const, source: "default" as const },
          klEffective: {
            baseUrl: "",
            model: "glm-5.2",
            apiKeyConfigured: false,
            provider: "openai" as const,
          },
        }),
      save: () => ok({ appliedNow: true, needsRestart: [] as ("agent" | "klServer")[] }),
      /**
       * 探测网关。默认成功并给一个**只有网关才有**的模型名
       * （`gateway-only-model`）—— 用例据此断言"列表真的来自探测结果"
       * 而不是内置推荐档位。
       */
      probe: () =>
        recorded.probeReason === null
          ? ok({
              ok: true,
              reason: null,
              provider: "openai" as const,
              providers: ["openai" as const],
              modelProviders: {} as Record<string, ("openai" | "anthropic")[]>,
              detail: null,
              models: ["gateway-only-model", "glm-5.2"],
            })
          : ok({
              ok: false,
              reason: recorded.probeReason,
              provider: null,
              providers: [] as ("openai" | "anthropic")[],
              modelProviders: {} as Record<string, ("openai" | "anthropic")[]>,
              detail: "Invalid token (request id: test)",
              models: [] as string[],
            }),
      onChanged: () => () => undefined,
    },
  }

  ;(globalThis as { window?: { mycontext?: unknown } }).window ??= {}
  ;(window as unknown as { mycontext: unknown }).mycontext = api as unknown as MyContextApi
  return recorded
}

function renderView() {
  // retry 关掉：失败时立刻暴露，而不是让用例等三次重试超时
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const i18n = createI18n("zh")
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <OnboardingView />
      </QueryClientProvider>
    </I18nextProvider>,
  )
}

describe("★ 模型那一步：用交互承载信息，不是堆 tips", () => {
  /**
   * ★★ 为什么这一组值得存在
   *
   * 用户的原话是「onboarding 页面能不能别这么多提示，都用高级交互代替」。
   * 首版那一步有**四层文字说同一件事**：页标题「配置模型」+ 页说明 +
   * 表单分区标题「模型服务」+ 分区说明「OpenAI 兼容的接口地址与密钥。」
   *
   * 而这类回归极其容易再犯 —— 下次给表单加个字段时，顺手补一句
   * `description` 是最自然的动作。所以断言的是**结构性质**
   *（"分区标题不出现"、"状态是标签不是句子"），而不是某句具体文案。
   */
  it("引导里不重复表单的分区标题（bare 模式）", async () => {
    installApi([
      step("channel", "done"),
      step("model", "pending"),
      step("persona", "pending"),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()

    // 停在模型步：接口地址那个输入框在
    await waitFor(() => {
      expect(screen.getAllByLabelText("接口地址").length).toBeGreaterThan(0)
    })
    // 页标题在（外层那一层说明保留）。步骤条上也有同名一项，所以按 heading 取
    expect(screen.getByRole("heading", { name: "配置模型" })).toBeTruthy()
    // ★ 但表单自己的分区标题**不该**再出现一次
    expect(screen.queryByText("模型服务")).toBeNull()
  })

  it("key 的配置状态是一个标签，不是一行说明句", async () => {
    installApi([
      step("channel", "done"),
      step("model", "pending"),
      step("persona", "pending"),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()

    await waitFor(() => {
      expect(screen.getAllByLabelText("接口地址").length).toBeGreaterThan(0)
    })
    // 桩里 configured:false → 显示「未配置」这个短标签
    expect(screen.getByText("未配置")).toBeTruthy()
    // 首版那句整行描述不该还在
    expect(screen.queryByText(/尚未配置/)).toBeNull()
  })

  it("KL 单独配置默认折叠，且收起时也能看到实际生效的模型", async () => {
    installApi([
      step("channel", "done"),
      step("model", "pending"),
      step("persona", "pending"),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()

    await waitFor(() => {
      expect(screen.getAllByLabelText("接口地址").length).toBeGreaterThan(0)
    })
    // 折叠标题在（Disclosure 的 title）
    expect(screen.getByText("知识库单独用别的模型")).toBeTruthy()
    /**
     * ★ 收起时也要能看到当前实际生效的模型（Disclosure 的 summary）——
     * 看一个值不该先展开一块区域。桩里 klEffective.model = glm-5.2。
     *
     * 用 getAllBy：`glm-5.2` 现在**本该**出现多次（选中的模型 chip +
     * 这个 summary）—— 那是两处不同的信息，不是重复渲染。
     */
    expect(screen.getAllByText("glm-5.2").length).toBeGreaterThan(1)
  })

  /**
   * ★★ 保存按钮的 dirty 态。
   *
   * 首版无论改没改都能点，点完还显示「已保存」—— 那是**假反馈**：
   * 让用户以为某个改动生效了，而其实什么都没提交。
   */
  it("没有改动时保存按钮是禁用的（不给假反馈）", async () => {
    installApi([
      step("channel", "done"),
      step("model", "pending"),
      step("persona", "pending"),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()

    await waitFor(() => {
      expect(screen.getAllByLabelText("接口地址").length).toBeGreaterThan(0)
    })
    expect(screen.getByText("保存并继续").closest("button")?.disabled).toBe(true)
  })

  it("改了东西之后才能保存 → 记 stepDone(model) 并前进到数字分身", async () => {
    const recorded = installApi([
      step("channel", "done"),
      step("model", "pending"),
      step("persona", "pending"),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()

    await waitFor(() => {
      expect(screen.getAllByLabelText("接口地址").length).toBeGreaterThan(0)
    })
    // 先改一处（否则按钮是禁用的 —— 见上一条）
    const baseInputs = screen.getAllByLabelText("接口地址")
    fireEvent.change(baseInputs[0]!, { target: { value: "https://gw.example" } })

    // onboarding 里按钮文案走 settings 命名空间 —— 这一条同时锁住
    // 「i18n 没串命名空间」（串了会渲染出原始 key `model.saveAndNext`）
    fireEvent.click(screen.getByText("保存并继续"))

    await waitFor(() => {
      expect(recorded.stepDone.some((item) => item.step === "model")).toBe(true)
    })
    // 前进到下一步（数字分身的名字输入框）
    await waitFor(() => {
      expect(screen.getByPlaceholderText("例如：小墨")).toBeTruthy()
    })
  })

  /**
   * ★★ 「测试连接」是这次改版的核心 —— 它把「几小时后静默失败」
   * 变成「现在当场知道」。同一次请求顺带把模型名从"猜着填的输入框"
   * 变成"从网关探到的列表里挑"。
   */
  it("测试连接成功 → 用探到的模型列表替换推荐档位", async () => {
    installApi([
      step("channel", "done"),
      step("model", "pending"),
      step("persona", "pending"),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()

    await waitFor(() => {
      expect(screen.getAllByLabelText("接口地址").length).toBeGreaterThan(0)
    })
    // 探测前：网关独有的那个模型不在（显示的是内置推荐档位）
    expect(screen.queryByText("gateway-only-model")).toBeNull()

    fireEvent.click(screen.getByText("测试连接"))

    // 探测后：绿灯 + 网关真实列表里的模型出现在 chips 里
    // （主模型与 KL 模型两处 chips 都会用探到的列表，所以是 getAll）
    await waitFor(() => {
      expect(screen.getAllByText("gateway-only-model").length).toBeGreaterThan(0)
    })
    // 「连接正常 · N 个模型可用」那个绿灯
    expect(screen.getByText(/连接正常/)).toBeTruthy()
  })

  it("测试连接失败 → 给可照做的下一步，不是英文报文", async () => {
    const recorded = installApi([
      step("channel", "done"),
      step("model", "pending"),
      step("persona", "pending"),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    recorded.probeReason = "unauthorized"
    renderView()

    await waitFor(() => {
      expect(screen.getAllByLabelText("接口地址").length).toBeGreaterThan(0)
    })
    fireEvent.click(screen.getByText("测试连接"))

    await waitFor(() => {
      expect(screen.getByText("密钥不对，换一把再试")).toBeTruthy()
    })
    // 网关原文不该怼到界面上（它在 title 里给会看的人）
    expect(screen.queryByText(/Invalid token/)).toBeNull()
  })
})

describe("★ 进度来自数据库，不是组件 state", () => {
  it("库里前两步 done → 停在第 3 步（资料源），而不是第 1 步", async () => {
    installApi([
      step("channel", "done"),
      step("model", "done"),
      step("persona", "done", { name: "小墨", figureSeed: "x#1" }),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()

    // 资料源那步特有的控件：时间范围
    await waitFor(() => {
      expect(screen.getByText("时间范围")).toBeTruthy()
    })
  })

  it("四步都 pending → 停在第 1 步（渠道授权）", async () => {
    installApi([
      step("channel", "pending"),
      step("model", "pending"),
      step("persona", "pending"),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()

    /**
     * 第 1 步从渠道注册表动态渲染，不硬编码某一个渠道。
     *
     * ★ 断言从"两张卡同时在"改成"选中那张在 + 另一个渠道可切"：
     * 这一步现在**一次只配一个渠道**（picker 选，见 onboarding-view 里那段
     * 注释）。原来平铺全部渠道 + 完成判据写死主渠道，导致只连飞书的用户
     * 第 1 步永远不会自动完成、只能「跳过」。
     * 意图不变（不硬编码渠道），变的是表达。
     */
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "连接钉钉" })).toBeTruthy()
    })
    // 另一个渠道通过 picker 可达（而不是同屏平铺两张授权卡）
    expect(screen.getByRole("button", { name: /选择要配置的渠道|渠道/ })).toBeTruthy()
    /**
     * ★ 原来这里断言 `img[alt=""]` 的 src 是 `channel-source-logo.png`。
     *
     * 那张图是**飞书专属**的品牌 logo（`FEISHU_BRAND_LOGO_URL`），它当时能
     * 被选到，只是因为第 1 步把**所有**渠道的授权卡平铺渲染。现在这一步
     * 一次只配一个渠道（默认第一个 = 钉钉），飞书的 logo 自然不在 DOM 里
     * —— 那是预期行为，不是回归。
     *
     * 所以这条断言改成：这一屏**不该**出现另一个渠道的品牌资源
     * （反过来锁住"没有把两个渠道混在一屏"这件事，正是这次改动的目的）。
     */
    expect(document.querySelector('img[src*="channel-source-logo.png"]')).toBeNull()
    expect(screen.queryByText("时间范围")).toBeNull()
  })

  it("★ 表单从库里的 payload 回填（不是每次重新填）", async () => {
    installApi([
      step("channel", "done"),
      step("model", "done"),
      step("persona", "pending", { name: "小墨", figureSeed: "seed#3" }),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()

    await waitFor(() => {
      const input = screen.getByPlaceholderText("例如：小墨") as HTMLInputElement
      expect(input.value).toBe("小墨")
    })
  })

  it("★ 带 figureCustom 的 payload 能回填（选中态从库里来）", async () => {
    /**
     * 逐槽位定制是后加的字段。回填不做对的表现很隐蔽：形象仍然显示
     * （seed 还在），只是用户上次挑的头发**没有被选中** ——
     * 于是他会以为"我上次的修改没保存"。
     */
    installApi([
      step("channel", "done"),
      step("model", "done"),
      step("persona", "pending", {
        name: "小墨",
        figureSeed: "seed#3",
        figureStyle: "notionists",
        figureCustom: { slots: { hair: "variant07" } },
      }),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "头发" })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole("tab", { name: "头发" }))
    /**
     * `variant07` 在 notionists.hair 的**倒序**表里是第 57 个
     * （variant63 排第 1）。断言的是 `aria-pressed` ——
     * 那个属性只有在"库里的值真的被读进选中态"时才为 true。
     */
    const pressed = screen
      .getAllByLabelText(/^头发 \d+$/)
      .filter((element) => element.getAttribute("aria-pressed") === "true")
    expect(pressed).toHaveLength(1)
    expect(pressed[0]?.getAttribute("aria-label")).toBe("头发 57")
  })

  it("★ 旧 payload（没有 figureCustom）不炸，且形象仍然渲染", async () => {
    /**
     * 库里现在真的是这个形状（`{"name":"小小周","figureSeed":"小小周|0#0"}`）。
     * 这是唯一能证明"没弄坏老用户"的断言。
     */
    installApi([
      step("channel", "done"),
      step("model", "done"),
      step("persona", "pending", { name: "小小周", figureSeed: "小小周|0#0" }),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()

    await waitFor(() => {
      const input = screen.getByPlaceholderText("例如：小墨") as HTMLInputElement
      expect(input.value).toBe("小小周")
    })
    // 一个槽位都不该是选中态 —— 全部由 seed 决定
    fireEvent.click(screen.getByRole("tab", { name: "头发" }))
    const pressed = screen
      .getAllByLabelText(/^头发 \d+$/)
      .filter((element) => element.getAttribute("aria-pressed") === "true")
    expect(pressed).toHaveLength(0)
  })

  it("★ 脏 figureCustom 不让引导页打不开", async () => {
    // 手改过的 payload / 降级过的版本都可能给出这种形状
    installApi([
      step("channel", "done"),
      step("model", "done"),
      step("persona", "pending", {
        name: "小墨",
        figureSeed: "seed#3",
        figureCustom: "not an object",
      }),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()

    await waitFor(() => {
      expect(screen.getByPlaceholderText("例如：小墨")).toBeTruthy()
    })
  })
})

describe("★★ 新用户的形象必须跟着名字变（不是所有人同一张脸）", () => {
  /**
   * ## 这一组锁的是一次**功能回退**
   *
   * 旧界面的候选 seed 由 `personaFigureSeeds(\`${name}|${round}\`)` 派生
   * —— 改名字就换一批脸，那是有意的设计。改成 `FigureStudio` 之后
   * 名字不再进 seed，而新用户的 `DEFAULT_PERSONA_IDENTITY.figureSeed`
   * 是**常量** `"|0#0"`：实测空名字 / "小小周" / "另一个名字" 三者的
   * 预览**逐字节相同** —— 即每个新用户看到的都是同一张默认脸。
   *
   * 判据是**预览的 `src` 变了**（会随缺陷变化的量），不是"输入框有值"
   * —— 后者在形象完全不跟名字走时也成立。
   */
  const previewSrc = (): string => {
    /**
     * 大预览是这一屏里尺寸最大的那张（128px）。按尺寸挑而不是按顺序：
     * 抽屉里有几十张缩略图，靠"第一个 img"会挑到不确定的那一张。
     */
    const images = [...document.querySelectorAll("img")]
    const big = images.find((image) => {
      const width = (image.parentElement as HTMLElement | null)?.style.width
      return width === "128px"
    })
    return big?.getAttribute("src") ?? ""
  }

  const typeName = (name: string) => {
    fireEvent.change(screen.getByPlaceholderText("例如：小墨"), { target: { value: name } })
  }

  it("新用户改名字 → 预览真的换一张脸", async () => {
    installApi([
      step("channel", "done"),
      step("model", "done"),
      step("persona", "pending"),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()
    await waitFor(() => {
      expect(screen.getByPlaceholderText("例如：小墨")).toBeTruthy()
    })

    const empty = previewSrc()
    expect(empty.length).toBeGreaterThan(100)

    typeName("小小周")
    const first = previewSrc()
    typeName("另一个名字")
    const second = previewSrc()

    // ★ 这三条就是那次回退的直接判据 —— 修复前三者逐字节相同
    expect(first).not.toBe(empty)
    expect(second).not.toBe(empty)
    expect(second).not.toBe(first)
  })

  it("★ 派生的 seed 也要**存进 payload**（否则草稿署名是另一张脸）", async () => {
    /**
     * 只在渲染时算 seed 而不写回草稿的话，界面上是新脸、存进库的却是
     * `"|0#0"` —— 于是草稿署名与设置页会显示**另一张脸**。
     * `persona-identity.ts` 的文件头记录的正是这个形态的教训，
     * 而它比不派生更糟：不派生只是大家都一样，这个是两处不一致。
     */
    const recorded = installApi([
      step("channel", "done"),
      step("model", "done"),
      step("persona", "pending"),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()
    await waitFor(() => {
      expect(screen.getByPlaceholderText("例如：小墨")).toBeTruthy()
    })

    typeName("小小周")
    fireEvent.click(screen.getByText("下一步"))

    await waitFor(() => {
      expect(recorded.stepDone.length).toBeGreaterThan(0)
    })
    const payload = recorded.stepDone.find((call) => call.step === "persona")?.payload as {
      name: string
      figureSeed: string
    }
    expect(payload.name).toBe("小小周")
    // 名字必须真的在 seed 里 —— 常量 "|0#0" 会让这条红
    expect(payload.figureSeed).toContain("小小周")
  })

  it("老用户（seed 里已带自己的名字）的形象逐字节不变", async () => {
    /**
     * ★ 这条是上面那条的**反面**，必须同时存在。
     *
     * 只有上面那条时，"每次渲染都按当前名字重算 seed"这种实现也会通过
     * —— 而那会把老用户挑过的脸换掉（他们的 seed 形如 `小小周|0#0`，
     * 也就是同一个形态）。判据取"重新派生得到同一个串"：
     * 老用户的 seed 里带的就是他自己的名字，所以两者必然相等。
     */
    const recorded = installApi([
      step("channel", "done"),
      step("model", "done"),
      step("persona", "pending", { name: "小小周", figureSeed: "小小周|0#0" }),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()
    await waitFor(() => {
      const input = screen.getByPlaceholderText("例如：小墨") as HTMLInputElement
      expect(input.value).toBe("小小周")
    })

    fireEvent.click(screen.getByText("下一步"))
    await waitFor(() => {
      expect(recorded.stepDone.length).toBeGreaterThan(0)
    })
    const payload = recorded.stepDone.find((call) => call.step === "persona")?.payload as {
      figureSeed: string
    }
    expect(payload.figureSeed).toBe("小小周|0#0")
  })

  it("点过「随机」之后改名字**不再**换脸（挑过的东西不该被覆盖）", async () => {
    installApi([
      step("channel", "done"),
      step("model", "done"),
      // `|rN#0` 是「随机」产出的形态 —— 表示用户自己挑过
      step("persona", "pending", { name: "小小周", figureSeed: "小小周|0#0|r3#0" }),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()
    await waitFor(() => {
      expect(screen.getByPlaceholderText("例如：小墨")).toBeTruthy()
    })

    const before = previewSrc()
    typeName("改了个名字")
    expect(previewSrc()).toBe(before)
  })
})

describe("★ skipped 与 pending 在步骤条上可区分", () => {
  it("跳过过的那一步显示「已跳过」而不是「待办」", async () => {
    installApi([
      step("channel", "done"),
      step("model", "done"),
      step("persona", "skipped"),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()

    await waitFor(() => {
      expect(screen.getByText("已跳过")).toBeTruthy()
    })
    // done 也要显示（两种"走过"要都看得见）—— channel 与 model 都 done，故用 All
    expect(screen.getAllByText("已完成").length).toBeGreaterThan(0)
  })
})

describe("★ 可以前后跳，且不会被 refetch 弹走", () => {
  it("点步骤条上的第 2 步就切到第 2 步", async () => {
    installApi([
      step("channel", "done"),
      step("model", "done"),
      step("persona", "pending"),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()

    await waitFor(() => {
      expect(screen.getByPlaceholderText("例如：小墨")).toBeTruthy()
    })

    // 跳到第 3 步再跳回来 —— 双向都要能走
    fireEvent.click(screen.getByText("学习范围"))
    await waitFor(() => {
      expect(screen.getByText("时间范围")).toBeTruthy()
    })
    fireEvent.click(screen.getByText("数字分身"))
    await waitFor(() => {
      expect(screen.getByPlaceholderText("例如：小墨")).toBeTruthy()
    })
  })
})

describe("★ 名字必填：空名字不许前进", () => {
  it("名字为空点「下一步」→ 不写库、不前进、给出提示", async () => {
    const recorded = installApi([
      step("channel", "done"),
      step("model", "done"),
      step("persona", "pending"),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()

    await waitFor(() => {
      expect(screen.getByPlaceholderText("例如：小墨")).toBeTruthy()
    })
    fireEvent.click(screen.getByText("下一步"))

    await waitFor(() => {
      expect(screen.getByText("先给它起个名字")).toBeTruthy()
    })
    // 关键：**没有**把一个空名字写进库
    expect(recorded.stepDone.filter((item) => item.step === "persona")).toHaveLength(0)
    // 也没有前进
    expect(screen.queryByText("时间范围")).toBeNull()
  })

  it("填了名字就能前进，且 payload 带着名字一起落库", async () => {
    const recorded = installApi([
      step("channel", "done"),
      step("model", "done"),
      step("persona", "pending"),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()

    await waitFor(() => {
      expect(screen.getByPlaceholderText("例如：小墨")).toBeTruthy()
    })
    fireEvent.change(screen.getByPlaceholderText("例如：小墨"), { target: { value: "小墨" } })
    fireEvent.click(screen.getByText("下一步"))

    await waitFor(() => {
      expect(recorded.stepDone.some((item) => item.step === "persona")).toBe(true)
    })
    const written = recorded.stepDone.find((item) => item.step === "persona")
    expect((written?.payload as { name?: string } | undefined)?.name).toBe("小墨")
  })
})

describe("★ 资料源：未接入的要标出来，会话列表要惰性加载", () => {
  beforeEach(() => {
    installApi([
      step("channel", "done"),
      step("model", "done"),
      step("persona", "done"),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
  })

  it("★ 排期中的源单独分组，不与能用的混排", async () => {
    renderView()
    await waitFor(() => {
      expect(screen.getByText("邮箱")).toBeTruthy()
    })
    /**
     * ★ 文案从「未接入」改成「排期中」是有意的。
     *
     * 逐个查过 DWS 的 reference：文档 / 邮箱 / 日历 / 待办 / 考勤 /
     * DING / 钉盘的只读命令**都存在** —— 缺的是我们的采集器。
     * 「未接入」读起来像"这个渠道做不到"，那时用户只能放弃；
     * 「排期中」让他知道那是排期问题，而且勾上的选择会被记住。
     */
    expect(screen.queryByText("未接入")).toBeNull()

    /**
     * ★★ 分组是**必要的**，不只是好看。
     *
     * 9 个源里只有 2 个真能采（chat / minutes）。它们原来平铺在一个两列
     * 网格里，只靠一个浅色后缀区分 —— 用户很自然地全勾上，然后第 4 步
     * 显示"已启用 9 个资料源"而实际工作的只有 2 个。那个数字会误导人。
     *
     * 现在是两个分组标题，勾之前就知道自己在勾什么。
     */
    expect(screen.getByText("现在可用")).toBeTruthy()
    expect(screen.getByText("排期中")).toBeTruthy()
  })

  it("★ 一进这一步就拉会话列表（不再「点开才拉」）", async () => {
    const recorded = installApi([
      step("channel", "done"),
      step("model", "done"),
      step("persona", "done"),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()
    /**
     * 首版是惰性的（那是一次约 4.8s 的三路子进程调用）。但指定会话是
     * 这一步的**主要动作** —— 让用户先点一下再等 5 秒，等于把一次等待
     * 拆成两次注意力切换。
     */
    await waitFor(() => {
      expect(recorded.conversationCalls).toBe(1)
    })
    await waitFor(() => {
      expect(screen.getByText(/列表可能不完整/)).toBeTruthy()
    })
    // 会话本身也要出现
    expect(screen.getByText("连接器产研交流群")).toBeTruthy()
  })

  /**
   * ★ 单聊与群聊分两组，各有全选。
   *
   * 两类的选择逻辑不同：单聊通常全选（一对一的真实对话，语料质量最高），
   * 群聊要挑（大群里大半是与本人无关的噪声）。
   */
  it("★ 单聊与群聊分组，各自有全选按钮", async () => {
    installApi([
      step("channel", "done"),
      step("model", "done"),
      step("persona", "done"),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()
    await waitFor(() => {
      expect(screen.getByText("连接器产研交流群")).toBeTruthy()
    })
    // 两组各一个全选按钮
    expect(screen.getAllByRole("button", { name: "全选" })).toHaveLength(2)
  })

  it("★ 单聊不显示「2 人」（那是一句废话）", async () => {
    installApi([
      step("channel", "done"),
      step("model", "done"),
      step("persona", "done"),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()
    await waitFor(() => {
      // 桩里的单聊「小王」memberCount 是 2
      expect(screen.getByText("小王")).toBeTruthy()
    })
    /**
     * 单聊必然是两个人，所以「2 人」不携带信息，而它占的位置本该给
     * 更有用的东西。群聊的人数有意义（12 人群与 500 人群的语料密度不同），
     * 所以那一组仍然显示。
     */
    expect(screen.queryByText("2 人")).toBeNull()
    expect(screen.getByText("16 人")).toBeTruthy()
  })

  it("★ 有「最近一年」这一档（半年到不限之间原本是空的）", async () => {
    installApi([
      step("channel", "done"),
      step("model", "done"),
      step("persona", "done"),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()
    await waitFor(() => {
      expect(screen.getByText("时间范围")).toBeTruthy()
    })
    expect(screen.getByText("最近一年")).toBeTruthy()
  })

  it("★ 可以切成自定义日期区间（两个 date 输入）", async () => {
    installApi([
      step("channel", "done"),
      step("model", "done"),
      step("persona", "done"),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()
    await waitFor(() => {
      expect(screen.getByText("时间范围")).toBeTruthy()
    })
    fireEvent.click(screen.getByRole("button", { name: "指定日期区间" }))
    // 原生 date 输入（不引日期库 —— 它自带本地化与系统日历面板）
    expect(document.querySelectorAll('input[type="date"]')).toHaveLength(2)
  })

  it("勾选写进 distill_sources：未勾的源要显式写 enabled:false", async () => {
    const recorded = installApi([
      step("channel", "done"),
      step("model", "done"),
      step("persona", "done"),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()
    await waitFor(() => {
      expect(screen.getByText("时间范围")).toBeTruthy()
    })
    fireEvent.click(screen.getByText("下一步"))

    await waitFor(() => {
      expect(recorded.sourceSave.length).toBeGreaterThan(0)
    })
    /**
     * 三个源都要写到。
     *
     * 只写勾上的那些是个很自然的写法，但那样"取消勾选"就永远不生效
     * —— 库里那一行还是 enabled:1，采集照跑。这条断言就是拦这个。
     */
    expect(recorded.sourceSave.map((item) => item.kind).sort()).toEqual(["chat", "mail", "minutes"])
    expect(recorded.sourceSave.find((item) => item.kind === "mail")?.enabled).toBe(false)
    expect(recorded.sourceSave.find((item) => item.kind === "chat")?.enabled).toBe(true)
  })
})

describe("跳过这步：写库并前进", () => {
  it("点「跳过这步」→ 记 skipped 并到下一步", async () => {
    const recorded = installApi([
      step("channel", "done"),
      step("model", "done"),
      step("persona", "pending"),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    renderView()
    await waitFor(() => {
      expect(screen.getByPlaceholderText("例如：小墨")).toBeTruthy()
    })
    fireEvent.click(screen.getByText("跳过这步"))

    await waitFor(() => {
      expect(recorded.stepSkip).toEqual([{ step: "persona" }])
    })
    await waitFor(() => {
      expect(screen.getByText("时间范围")).toBeTruthy()
    })
  })
})

describe("最后一步的主按钮是「进入应用」而不是「下一步」", () => {
  it("停在第 4 步时显示进入应用", async () => {
    installApi([
      step("channel", "done"),
      step("model", "done"),
      step("persona", "done"),
      step("sources", "done"),
      step("distill", "pending"),
    ])
    renderView()
    await waitFor(() => {
      expect(screen.getByText("进入应用")).toBeTruthy()
    })
    expect(screen.queryByText("下一步")).toBeNull()
  })
})

/**
 * ★★ 身份未确认时的**软门**：channel 步不自动打勾，但绝不阻塞。
 *
 * ## 这里锁的是一个曾经的静默坑
 *
 * 授权成功但身份**歧义**（同名多 ID）时，`is_self` 全表保持 null，
 * 蒸馏守卫会拒掉**全部**语料且不报错。而首版的完成门只看 `authorized`：
 * 授权一成功就把 channel 步记 done → 用户看到"引导完成、蒸馏 0 结论"而
 * 无从知道原因。
 *
 * 软门的三条不变式，缺一条都退回静默或变成硬阻塞：
 * 1. 授权但未确认 → channel 步**不**自动记 done（否则回到静默）；
 * 2. 同时**就地**渲染确认入口（否则用户不知道要做什么）；
 * 3. 「跳过这步」仍然可用（否则变成硬门，把没网/暂不想确认的人卡死）。
 *
 * 判据是**行为**（stepDone 有没有被调、面板在不在、跳过走不走得通），
 * 不是文案 —— 与本文件其余用例同一风格。
 */
function authorizedChannel(selfConfirmed: boolean): Recorded {
  const recorded = installApi([
    step("channel", "pending"),
    step("model", "pending"),
    step("persona", "pending"),
    step("sources", "pending"),
    step("distill", "pending"),
  ])
  const api = (window as unknown as { mycontext: Record<string, unknown> }).mycontext
  // 渠道置为已授权（默认桩是 unauthorized）
  ;(api as { channels: Record<string, unknown> }).channels = {
    ...(api as { channels: Record<string, unknown> }).channels,
    list: () =>
      ok([
        {
          id: "dingtalk",
          labelKey: "channels:dingtalk.label",
          descriptionKey: "channels:dingtalk.description",
          available: true,
          status: {
            state: "authorized",
            corpId: "c1",
            corpName: "测试企业",
            userId: "u1",
            userName: "测试用户",
            accessExpiresAt: "2026-09-01T00:00:00Z",
            refreshExpiresAt: "2026-09-27T00:00:00Z",
            daysUntilRefreshExpiry: 29,
          },
        },
      ]),
    authStatus: () => ok({ state: "authorized" }),
  }
  // 快照的 selfConfirmed 由入参控制（unjudged 给个非零，让面板走「有未判定」分支）
  const ingest = (api as { ingest: Record<string, unknown> }).ingest
  const baseSnapshot = {
    running: true,
    channelId: "dingtalk",
    messages: 100,
    conversations: 3,
    unjudged: selfConfirmed ? 0 : 100,
    outboxHead: 0,
    ftsIndexed: 0,
    ftsLag: 0,
    probeIntervalMs: 0,
    probeThrottled: false,
    lastError: null,
    blockedReason: null,
    failedAttempts: 0,
    selfConfirmed,
    /**
     * ★ 原因也要给：界面按它分叉（见 `readIdentityProblem`）。
     * 不给（undefined）会被当成"快照还没回来"而整块不渲染 ——
     * 那正是这一层要区分的：加载态不该显示告警。
     *
     * 这一组测的是"未确认时给不给入口"，所以给 `unresolved`
     * （最常见的那一档：自动识别没成功，点一下重试）。
     */
    selfIdentityState: selfConfirmed ? null : ("unresolved" as const),
    mediaAssets: 0,
    minutes: 0,
    storage: { mainBytes: 0, walBytes: 0, rawRecords: 0, rawPruned: 0, vectors: 0 },
    staleConsumers: [],
    backfill: null,
  }
  ;(ingest as { snapshot: unknown }).snapshot = () => ok(baseSnapshot)
  return recorded
}

describe("★★ 身份未确认：软门（不自动完成，但不阻塞）", () => {
  it("已授权但未确认 → channel 步不自动记 done", async () => {
    const recorded = authorizedChannel(false)
    renderView()

    // 渠道面板渲染出来（说明确实停在第 1 步且已授权）
    await waitFor(() => {
      expect(screen.getByText("测试企业")).toBeTruthy()
    })
    // 给 effect 充分的机会去（错误地）打勾——它不该打
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(recorded.stepDone.filter((item) => item.step === "channel")).toHaveLength(0)
  })

  it("已授权但未确认 → 就地显示身份确认入口", async () => {
    authorizedChannel(false)
    renderView()

    // SelfIdentityPanel 的确认按钮「解析身份」出现（它来自 settings 命名空间，
    // 渲染出中文说明它既挂上了、命名空间也没串）
    await waitFor(() => {
      expect(screen.getByText("解析身份")).toBeTruthy()
    })
  })

  it("已授权且已确认 → channel 步自动记 done（正常人零多余点击）", async () => {
    const recorded = authorizedChannel(true)
    renderView()

    await waitFor(() => {
      expect(recorded.stepDone.some((item) => item.step === "channel")).toBe(true)
    })
    // 已确认时不该再显示确认入口
    expect(screen.queryByText("解析身份")).toBeNull()
  })

  it("★ 未确认也**不阻塞**：跳过这步仍然可用并记 skipped", async () => {
    const recorded = authorizedChannel(false)
    renderView()

    await waitFor(() => {
      expect(screen.getByText("测试企业")).toBeTruthy()
    })
    // 软门的关键：这一步没自动完成，但用户随时能跳过
    fireEvent.click(screen.getByText("跳过这步"))
    await waitFor(() => {
      expect(recorded.stepSkip).toEqual([{ step: "channel" }])
    })
  })
})

/**
 * 会话选择：全选按钮的**标签与行为必须同源**，且列表不嵌套滚动。
 *
 * ## ★★ 这里锁的是一个真 bug
 *
 * 改动前 `allSelected` 算的是 `items`（全量），而 `onToggleAll` 收的是
 * `visible`（搜索过滤后）。于是有搜索词时两者矛盾：
 *
 * · 69/69 全选中 + 搜一个关键词 → 标签显示「全不选」（全量都选中了），
 *   点下去只取消匹配的那几个，而标签**仍然**显示「全不选」；
 * · 5/69 选中、关键词正好匹配那 5 个 → 标签显示「全选」，点下去却是取消。
 *
 * 这类 bug 单测不写就只能靠人恰好在搜索状态下点一次全选才会发现。
 *
 * ## 另一条：不再有内层滚动区
 *
 * 原来列表是 `max-h-[320px] overflow-y-auto`，嵌在页面滚动区里 ——
 * 两层都能滚，而且把「资料源」那一整段挤出了视口。
 * 现在是"默认 8 条 + 展开其余"，只有页面这一层滚动。
 */
describe("★★ 会话全选：标签与行为同源；列表不嵌套滚动", () => {
  /** 造 n 个单聊，标题形如 `同事01`；其中带 `目标` 的用来测搜索。 */
  function manyConversations(n: number) {
    const items = Array.from({ length: n }, (_, i) => ({
      externalId: `cid-${String(i)}`,
      title: `同事${String(i).padStart(2, "0")}`,
      kind: "direct" as const,
      memberCount: 2,
      lastMessageAt: null,
    }))
    // 两个可搜到的目标，用一个不会与 `同事NN` 混淆的词
    items[3] = { ...items[3]!, title: "目标甲" }
    items[7] = { ...items[7]!, title: "目标乙" }
    return items
  }

  function renderSources(options: {
    items: ReturnType<typeof manyConversations>
    selectedIds?: readonly string[]
  }) {
    const changes: SourcesDraft[] = []
    installApi([
      step("channel", "done"),
      step("model", "done"),
      step("persona", "done"),
      step("sources", "pending"),
      step("distill", "pending"),
    ])
    const api = (window as unknown as { mycontext: Record<string, unknown> }).mycontext
    ;(api as { channels: Record<string, unknown> }).channels = {
      ...(api as { channels: Record<string, unknown> }).channels,
      conversations: () => ok({ items: options.items, truncated: false }),
    }
    const draft: SourcesDraft = {
      rangeDays: 180,
      customRange: null,
      chatKinds: ["direct", "group"],
      conversationIds: [...(options.selectedIds ?? [])],
      enabledSources: ["chat"],
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <I18nextProvider i18n={createI18n("zh")}>
        <QueryClientProvider client={client}>
          <SourcesStep
            value={draft}
            onChange={(next) => changes.push(next)}
            sources={[
              { kind: "chat", status: "ready" },
              { kind: "mail", status: "planned" },
            ]}
          />
        </QueryClientProvider>
      </I18nextProvider>,
    )
    return { changes }
  }

  it("★ 收起态只显示 8 条，其余靠「展开」——**没有**内层滚动条", async () => {
    renderSources({ items: manyConversations(20) })
    await waitFor(() => {
      expect(screen.getByText("同事00")).toBeTruthy()
    })
    // 第 9 条（下标 8）不该在 DOM 里 —— 那正是"折叠"而不是"滚动"
    expect(screen.queryByText("同事08")).toBeNull()
    // 折叠掉的数量要说出来：3 个与 61 个是两种决定
    expect(screen.getByRole("button", { name: "展开其余 12 个" })).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "展开其余 12 个" }))
    expect(screen.getByText("同事08")).toBeTruthy()
    expect(screen.getByText("同事19")).toBeTruthy()
  })

  it("★★ 有搜索词时：全选按钮的标签跟着**可见集合**变，不是全量", async () => {
    // 20 个里已选中 2 个（下标 3 与 7，正是那两个「目标」）
    renderSources({ items: manyConversations(20), selectedIds: ["cid-3", "cid-7"] })
    await waitFor(() => {
      expect(screen.getByText("目标甲")).toBeTruthy()
    })
    /**
     * 未搜索时：20 个里选了 2 个 → 可见集合没全选 → 标签是「全选」。
     */
    expect(screen.getByRole("button", { name: "全选" })).toBeTruthy()

    // 搜「目标」→ 可见的两个**都已选中** → 标签必须翻成「全不选」
    fireEvent.change(screen.getByPlaceholderText("搜索会话名…"), { target: { value: "目标" } })
    expect(screen.getByRole("button", { name: "全不选" })).toBeTruthy()
    /**
     * ★ 这就是那个 bug 的核心：旧实现在这里显示「全选」（因为全量 2/20
     * 没选满），而点下去的行为是**取消**那两个 —— 标签与行为相反。
     */
  })

  it("★ 搜索状态下点全不选 → 只动可见的那些（不清掉别的）", async () => {
    const { changes } = renderSources({
      items: manyConversations(20),
      selectedIds: ["cid-1", "cid-3", "cid-7"],
    })
    await waitFor(() => {
      expect(screen.getByText("目标甲")).toBeTruthy()
    })
    fireEvent.change(screen.getByPlaceholderText("搜索会话名…"), { target: { value: "目标" } })
    fireEvent.click(screen.getByRole("button", { name: "全不选" }))

    const last = changes.at(-1)
    expect(last).toBeDefined()
    if (last === undefined) return
    // cid-3 / cid-7 被取消，而**没被搜到**的 cid-1 要留着
    expect(last.conversationIds).toEqual(["cid-1"])
  })
})
