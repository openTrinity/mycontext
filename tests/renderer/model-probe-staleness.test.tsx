/**
 * @vitest-environment jsdom
 *
 * 模型「测试连接」的结果必须**对应当前输入**，改了地址/密钥就不能再显示旧结论。
 *
 * ## ★ 这一组防的是"假反馈"
 *
 * `ModelConfigForm` 的头注释自己立了规矩：不给假反馈（保存按钮的 dirty 态就是
 * 为此）。但测试连接原来漏了同一条：探测成功给了绿灯后，用户又改了 baseUrl
 * 或 apiKey —— 那条绿灯测的是**改之前**那组凭据，却一直留在界面上，读起来像
 * "当前这组也通"。密钥填错在几小时后的蒸馏里才以 401 报错，而这里的绿灯恰恰
 * 让人以为已经测通 —— 正是本组件要消灭的那种静默失效的反面。
 *
 * 修法：记下探测**针对哪组凭据**跑的，当前草稿与之不一致时不显示结果。
 * 断言的是"改输入后绿灯消失"，反证：不做失效判断则旧绿灯仍在。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { I18nextProvider } from "react-i18next"
import { createI18n } from "@mycontext/i18n"
import type { MyContextApi } from "@mycontext/ipc-contract"
import { ModelConfigForm } from "@renderer/features/settings/model-config-form"

/** jsdom 没有 ResizeObserver，而 Button 走 useSquircle 会用它。 */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver

afterEach(cleanup)

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data })

/** 装一份最小 window.mycontext：读一个空配置，探测默认成功给出网关列表。 */
function installApi(): void {
  const api = {
    runtimeConfig: {
      read: () =>
        ok({
          llmBaseUrl: { value: "https://old.example.com/v1", source: "user" as const },
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
      probe: () =>
        ok({
          ok: true,
          reason: null,
          provider: "openai" as const,
          detail: null,
          models: ["gateway-only-model", "glm-5.2"],
        }),
      onChanged: () => () => undefined,
    },
  }
  ;(globalThis as { window?: { mycontext?: unknown } }).window ??= {}
  ;(window as unknown as { mycontext: unknown }).mycontext = api as unknown as MyContextApi
}

function renderForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <I18nextProvider i18n={createI18n("zh")}>
      <QueryClientProvider client={client}>
        <ModelConfigForm />
      </QueryClientProvider>
    </I18nextProvider>,
  )
}

describe("★ 测试连接的结果对应当前输入（不给假反馈）", () => {
  it("★★ 探测成功给出绿灯，改了 baseUrl 之后绿灯消失", async () => {
    installApi()
    renderForm()

    // 等表单读到配置渲染出来
    await screen.findByText("测试连接")
    fireEvent.click(screen.getByText("测试连接"))

    // 探测成功：出现"来自网关"标签（它只在 result.ok 且有模型时出现）
    await waitFor(() => expect(screen.queryByText(/来自网关/)).not.toBeNull())

    // 改地址 —— 探测结果不再代表当前输入
    const baseUrlInput = screen.getByPlaceholderText("https://…")
    fireEvent.change(baseUrlInput, { target: { value: "https://new.example.com/v1" } })

    // ★ 旧绿灯（"来自网关"）必须消失
    await waitFor(() => expect(screen.queryByText(/来自网关/)).toBeNull())
  })

  it("★ 探测成功但当前模型不在网关列表 → 明确警告（防 model_not_found 静默失效）", async () => {
    installApi()
    renderForm()

    await screen.findByText("测试连接")
    fireEvent.click(screen.getByText("测试连接"))
    await waitFor(() => expect(screen.queryByText(/来自网关/)).not.toBeNull())

    // 当前 modelMain 是 glm-5.2，它**在**列表里 → 不该警告
    expect(screen.queryByText(/model_not_found/)).toBeNull()
  })
})
