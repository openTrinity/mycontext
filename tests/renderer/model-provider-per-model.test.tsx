/**
 * @vitest-environment jsdom
 *
 * 「测试连接」后**按所选模型**决定协议 —— 用户明确要的两件事：
 *
 * ① 协议选择器要能表达"只支持 anthropic / 只支持 openai / 都支持"，而这要**按模型**
 *    看（同一网关里 claude 两者都支持、embedding 只支持 openai），不能拿网关级的
 *    一个值糊所有模型；
 * ② 从列表里选一个模型时，自动把协议切到**该模型**支持的那个（有 anthropic 优先
 *    anthropic），用户仍可手动再切。
 *
 * 判据来自探测返回的 `modelProviders`（每模型的 supported_endpoint_types）。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { I18nextProvider } from "react-i18next"
import { createI18n } from "@mycontext/i18n"
import type { MyContextApi } from "@mycontext/ipc-contract"
import { ModelConfigForm } from "@renderer/features/settings/model-config-form"

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver

afterEach(cleanup)

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data })

/**
 * 装一份 window.mycontext：探测返回两个模型 ——
 * `claude-x` 两协议都支持、`qwen-x` 只支持 openai。
 */
function installApi(): void {
  const api = {
    runtimeConfig: {
      read: () =>
        ok({
          llmBaseUrl: { value: "https://gw.example.com/v1", source: "user" as const },
          llmApiKey: { configured: true, tail: "1234", source: "user" as const },
          modelMain: { value: "claude-x", source: "user" as const },
          mainProvider: { value: "openai" as const, source: "default" as const },
          embedModel: { value: "text-embedding-v4", source: "default" as const },
          klLlmBaseUrl: { value: "", source: "default" as const },
          klLlmApiKey: { configured: false, tail: null, source: "default" as const },
          klModelMain: { value: "", source: "default" as const },
          klProvider: { value: "openai" as const, source: "default" as const },
          klEffective: {
            baseUrl: "",
            model: "claude-x",
            apiKeyConfigured: true,
            provider: "openai" as const,
          },
        }),
      save: () => ok({ appliedNow: true, needsRestart: [] as ("agent" | "klServer")[] }),
      probe: () =>
        ok({
          ok: true,
          reason: null,
          provider: "anthropic" as const,
          providers: ["anthropic" as const, "openai" as const],
          modelProviders: {
            "claude-x": ["anthropic", "openai"],
            "qwen-x": ["openai"],
          } as Record<string, ("openai" | "anthropic")[]>,
          detail: null,
          models: ["claude-x", "qwen-x"],
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

/** 主模型那块协议选择器里，某个协议 chip 是否处于选中态（aria-pressed）。 */
function protocolChipPressed(label: string): boolean {
  const chips = screen.getAllByRole("button", { name: label })
  // 主模型协议在前、kl 的在折叠区（默认收起，不渲染）——取第一个即主模型那个
  return chips[0]?.getAttribute("aria-pressed") === "true"
}

describe("★ 探测后按所选模型决定协议", () => {
  it("★★ 选支持 anthropic 的模型 → 协议自动选 anthropic（用户没手动切时）", async () => {
    installApi()
    renderForm()
    await screen.findByText("测试连接")
    fireEvent.click(screen.getByText("测试连接"))
    await waitFor(() => expect(screen.queryByText(/来自网关/)).not.toBeNull())

    // 当前主模型是 claude-x（两协议都支持）→ 推荐 anthropic 自动选中
    await waitFor(() => expect(protocolChipPressed("Anthropic")).toBe(true))
    expect(protocolChipPressed("OpenAI 兼容")).toBe(false)
  })

  it("★★ 改选只支持 openai 的模型 → 协议自动切成 openai", async () => {
    installApi()
    renderForm()
    await screen.findByText("测试连接")
    fireEvent.click(screen.getByText("测试连接"))
    await waitFor(() => expect(screen.queryByText(/来自网关/)).not.toBeNull())

    // 点 qwen-x（chip 文案就是模型 id）——主模型那块的（取第一个）
    fireEvent.click(screen.getAllByRole("button", { name: "qwen-x" })[0]!)
    await waitFor(() => expect(protocolChipPressed("OpenAI 兼容")).toBe(true))
    expect(protocolChipPressed("Anthropic")).toBe(false)
  })

  it("★ 用户手动切协议后不被模型推荐值覆盖", async () => {
    installApi()
    renderForm()
    await screen.findByText("测试连接")
    fireEvent.click(screen.getByText("测试连接"))
    await waitFor(() => expect(screen.queryByText(/来自网关/)).not.toBeNull())

    // claude-x 默认推荐 anthropic；用户手动点 openai
    await waitFor(() => expect(protocolChipPressed("Anthropic")).toBe(true))
    const openaiChip = screen.getAllByRole("button", { name: "OpenAI 兼容" })[0]!
    fireEvent.click(openaiChip)
    await waitFor(() => expect(protocolChipPressed("OpenAI 兼容")).toBe(true))
    // 手选后仍是 openai（没被 claude-x 的推荐值 anthropic 冲掉）
    expect(protocolChipPressed("Anthropic")).toBe(false)
  })
})
