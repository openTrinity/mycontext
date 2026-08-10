/**
 * @vitest-environment jsdom
 *
 * 渠道号输入框必须在**新装的机器上**就能填。
 *
 * ## 锁的是哪个 bug
 *
 * 这一块原来的渲染条件是 `configured !== null`（`configured` = `configuredPath`
 * = "用户在这个输入框里成功存过路径"）。理由写的是"渠道号是自有 dws 的附属项，
 * 没设路径时连入口都不给"。
 *
 * 那条推理有个顺序错误：**新装的包里 `configuredPath` 恒为 null** ——
 * 于是渠道号框压根不渲染，用户没有任何地方能填它。实测（打包态的
 * `app_settings` 里 `dws_source_path` / `dws_channel_code` 两条都不存在）：
 * 这一块完全不出现，而填渠道号本来就是装完包要做的第一件事。
 *
 * 它还让 `channelInactive` 那句文案恒不可达：能看到框时路径已经存过且
 * spawn 验证过，`channelActive` 基本恒 true。也就是说"填了但不生效"这个
 * 真实状态唯一的出口被那个条件挡住了。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import type { DwsSourceView } from "@mycontext/ipc-contract"
import { DwsSourceDisclosure } from "@renderer/features/channels/dws-source-disclosure"

afterEach(cleanup)

/** 一台没配过任何东西的机器：两项都空。 */
const FRESH: DwsSourceView = {
  configuredPath: null,
  pathFromDefaults: null,
  configuredMissing: false,
  effectiveSource: "bundled",
  effectiveVersion: "dws version 0.0.0-fake",
  channelCode: null,
  channelFromDefaults: null,
  channelActive: false,
}

function renderPanel(view: DwsSourceView) {
  const api = {
    dwsSource: { read: () => Promise.resolve({ ok: true, data: view }), save: vi.fn() },
  } as unknown as Window["mycontext"]
  ;(window as unknown as { mycontext: unknown }).mycontext = api

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return render(<DwsSourceDisclosure />, { wrapper })
}

describe("★★ 渠道号输入框", () => {
  /**
   * ★★★ 这条是那个 bug 的直接反面。
   * 反证：把条件改回 `configured !== null ? … : null` → 必红。
   */
  it("★★★ 一台什么都没配的机器上：展开后渠道号框仍然在", async () => {
    renderPanel(FRESH)
    // 折叠态（没设过路径 → 默认折叠），先点开
    screen.getByTestId("dws-source-toggle").click()
    await waitFor(() => {
      expect(screen.getByTestId("dws-channel-input")).toBeTruthy()
      expect(screen.getByTestId("dws-channel-save")).toBeTruthy()
    })
  })

  /**
   * ★★ 填了但不生效要说出来 —— 这句文案原来恒不可达（见文件头）。
   *
   * ★ 断言用 **i18n key** 而不是中文原文：测试环境没装语言包，`t()` 回落成
   * key 本身。盯原文会让"改一个字"也变红，而这条要锁的是"这句话出不出现"。
   */
  it("★★ 填了渠道号但没用自有 dws → 显示「暂不生效」", async () => {
    renderPanel({ ...FRESH, channelCode: "CHFAKE0001", channelActive: false })
    screen.getByTestId("dws-source-toggle").click()
    await waitFor(() => {
      expect(screen.getByText("dwsSource.channelInactive")).toBeTruthy()
    })
  })

  /**
   * ★ 生效时不该再挂那句警示 —— 否则它变成常驻噪音。
   */
  it("★ 自有 dws 生效时不显示「暂不生效」", async () => {
    renderPanel({
      ...FRESH,
      configuredPath: "/opt/vendor-cli/dws",
      channelCode: "CHFAKE0001",
      channelActive: true,
      effectiveSource: "custom",
    })
    await waitFor(() => expect(screen.getByTestId("dws-channel-input")).toBeTruthy())
    expect(screen.queryByText("dwsSource.channelInactive")).toBeNull()
  })
})
