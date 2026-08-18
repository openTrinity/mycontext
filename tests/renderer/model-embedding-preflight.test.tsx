/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest"
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

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data })

type EmbeddingProbeReason =
  | "embeddingUnavailable"
  | "embeddingUnauthorized"
  | "embeddingBadResponse"
  | "embeddingDimensionMismatch"
type ProbeReason = EmbeddingProbeReason | "unreachable"

function installApi({
  reason = null,
  models = ["chat-only", "text-embedding-v4"],
}: {
  reason?: ProbeReason | null
  models?: string[]
} = {}) {
  const modelsDiscovered = reason !== "unreachable"
  const probe = vi.fn(() =>
    ok({
      ok: reason === null,
      reason,
      provider: modelsDiscovered ? ("openai" as const) : null,
      providers: modelsDiscovered ? ["openai" as const] : [],
      modelProviders: modelsDiscovered
        ? Object.fromEntries(models.map((model) => [model, ["openai" as const]]))
        : {},
      detail: reason === null ? null : "gateway detail",
      models: modelsDiscovered ? models : [],
    }),
  )
  const api = {
    runtimeConfig: {
      read: () =>
        ok({
          llmBaseUrl: { value: "https://gw.example.com/v1", source: "user" as const },
          llmApiKey: { configured: true, tail: "1234", source: "user" as const },
          modelMain: { value: "chat-only", source: "user" as const },
          mainProvider: { value: "openai" as const, source: "user" as const },
          embedModel: { value: "text-embedding-v4", source: "default" as const },
          klLlmBaseUrl: { value: "", source: "default" as const },
          klLlmApiKey: { configured: false, tail: null, source: "default" as const },
          klModelMain: { value: "", source: "default" as const },
          klProvider: { value: "openai" as const, source: "default" as const },
          klEffective: {
            baseUrl: "https://gw.example.com/v1",
            model: "chat-only",
            apiKeyConfigured: true,
            provider: "openai" as const,
          },
        }),
      save: () => ok({ appliedNow: true, needsRestart: [] as ("agent" | "klServer")[] }),
      probe,
      onChanged: () => () => undefined,
    },
  }
  ;(globalThis as { window?: { mycontext?: unknown } }).window ??= {}
  ;(window as unknown as { mycontext: unknown }).mycontext = api as unknown as MyContextApi
  return probe
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

describe("向量模型连接预检", () => {
  it("传入当前向量模型，修改向量模型后探测结果过期", async () => {
    const probe = installApi()
    renderForm()

    fireEvent.click(await screen.findByText("测试连接"))
    await waitFor(() =>
      expect(probe).toHaveBeenCalledWith({
        baseUrl: "https://gw.example.com/v1",
        embedModel: "text-embedding-v4",
      }),
    )
    await screen.findByText(/连接正常/)

    const otherButtons = screen.getAllByRole("button", { name: "其它…" })
    fireEvent.click(otherButtons[1]!)
    fireEvent.change(screen.getByLabelText("向量模型"), {
      target: { value: "custom-embedding" },
    })

    await waitFor(() => expect(screen.queryByText(/连接正常/)).toBeNull())
    expect(screen.queryByText(/来自网关/)).toBeNull()
  })

  it("探测成功但没有向量候选时，不重新展示推荐值并明确进入手填", async () => {
    installApi({ models: ["chat-only"] })
    renderForm()

    fireEvent.click(await screen.findByText("测试连接"))
    await screen.findByText(/连接正常/)

    expect(screen.queryByRole("button", { name: "text-embedding-v4" })).toBeNull()
    expect(screen.getByLabelText("向量模型")).toHaveProperty("value", "text-embedding-v4")
    expect(screen.getByText(/没有向量模型候选/)).toBeTruthy()
    const selectedOther = screen
      .getAllByRole("button", { name: "其它…" })
      .filter((button) => button.getAttribute("aria-pressed") === "true")
    expect(selectedOther).toHaveLength(1)
  })

  it("网关返回空模型列表时，仍按无向量候选处理", async () => {
    installApi({ models: [] })
    renderForm()

    fireEvent.click(await screen.findByText("测试连接"))
    await screen.findByText(/连接正常/)

    expect(screen.queryByRole("button", { name: "text-embedding-v4" })).toBeNull()
    expect(screen.getByLabelText("向量模型")).toHaveProperty("value", "text-embedding-v4")
    expect(screen.getByText(/没有向量模型候选/)).toBeTruthy()
  })

  it("models 阶段失败时保留未探测状态", async () => {
    installApi({ reason: "unreachable", models: [] })
    renderForm()

    fireEvent.click(await screen.findByText("测试连接"))
    await screen.findByText(/连不上这个地址/)

    expect(screen.getByRole("button", { name: "text-embedding-v4" })).toBeTruthy()
    expect(screen.queryByText(/没有向量模型候选/)).toBeNull()
  })

  it("embedding 失败仍保留已发现的主模型列表", async () => {
    installApi({ reason: "embeddingUnavailable", models: ["chat-only", "embed-supported"] })
    renderForm()

    fireEvent.click(await screen.findByText("测试连接"))
    await screen.findByText(/向量接口或模型不可用/)

    expect(screen.getAllByRole("button", { name: "chat-only" }).length).toBeGreaterThan(0)
    expect(screen.getByText(/来自网关/)).toBeTruthy()
  })

  it.each([
    ["embeddingUnauthorized", "向量模型无权限"],
    ["embeddingBadResponse", "向量返回格式不对"],
    ["embeddingDimensionMismatch", "向量维度不是 2048"],
  ] as const)("%s 显示可执行的错误文案", async (reason, copy) => {
    installApi({ reason })
    renderForm()

    fireEvent.click(await screen.findByText("测试连接"))
    await screen.findByText(new RegExp(copy))
  })
})
