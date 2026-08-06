/**
 * @vitest-environment jsdom
 *
 * 身份切换器。
 *
 * ## 这一组锁的是三件"不做就会让人以为数据丢了"的事
 *
 * ① **少于两个身份时整块不渲染**。一个身份时"切换"没有意义，
 *    零个时用户该看到的是授权入口 —— 摆一个空/单项列表只会让人
 *    以为漏了什么。
 * ② **当前那个不给按钮**（而不是给一个禁用的）：禁用按钮读起来像
 *    "这个操作暂时不可用"，而事实是"你已经在这儿了"。
 * ③ ★★ **切换中必须明示图谱要重新准备**。切一次要停采集、卸 agent、
 *    停图谱服务，而图谱 warmup 实测冷启约 90s。不明示的话用户会在那
 *    一两分钟里看到一个空图谱面板 —— 而"图谱空了"与"图谱正在准备"
 *    在界面上长得一样，那正是本项目最怕的静默降级。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { I18nextProvider } from "react-i18next"
import { createI18n } from "@mycontext/i18n"
import type { ChannelIdentity, MyContextApi } from "@mycontext/ipc-contract"
import { IdentitySwitcher } from "@renderer/features/channels/identity-switcher"

afterEach(cleanup)

/** jsdom 没有 ResizeObserver，而 Button 走 useSquircle 会用它。 */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver

/** ★ 值全是编的（CLAUDE.md §1.2）。 */
const CORP_A = "dingFAKECORP0001"
const CORP_B = "dingFAKECORP0002"

function identity(overrides: Partial<ChannelIdentity> = {}): ChannelIdentity {
  return {
    channelId: "dingtalk",
    corpId: CORP_A,
    userId: "100001",
    corpName: "组织甲",
    userName: "张三",
    active: true,
    lastUsedAt: "2026-08-06T10:00:00.000Z",
    ...overrides,
  }
}

function installApi(
  rows: ChannelIdentity[],
  options: { onSwitch?: () => Promise<unknown> } = {},
): void {
  const api = {
    channels: {
      identityList: () => Promise.resolve({ ok: true as const, data: rows }),
      identitySwitch:
        options.onSwitch ??
        (() => Promise.resolve({ ok: true as const, data: { switched: true } })),
    },
  } as unknown as MyContextApi
  ;(globalThis as { window?: { mycontext?: MyContextApi } }).window ??= {}
  ;(window as unknown as { mycontext: MyContextApi }).mycontext = api
}

function renderSwitcher() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <I18nextProvider i18n={createI18n("zh")}>
      <QueryClientProvider client={client}>
        <IdentitySwitcher />
      </QueryClientProvider>
    </I18nextProvider>,
  )
}

describe("★ 少于两个身份时整块不渲染", () => {
  it("零个身份（还没授权过）→ 什么都不画", async () => {
    installApi([])
    const { container } = renderSwitcher()
    // 等查询 settle，确认不是"还在 loading 所以是空的"
    await waitFor(() => expect(container.textContent).not.toContain("你的身份"))
    expect(container.textContent).not.toContain("切换")
  })

  it("只有一个身份 → 也不画（那时「切换」这个概念不存在）", async () => {
    installApi([identity()])
    const { container } = renderSwitcher()
    await waitFor(() => expect(container.textContent).not.toContain("你的身份"))
  })
})

describe("两个以上身份", () => {
  it("列出全部身份，各自显示组织与真名", async () => {
    installApi([
      identity({ corpName: "组织甲", userName: "张三", active: true }),
      identity({
        corpId: CORP_B,
        userId: "200002",
        corpName: "组织乙",
        userName: "李四",
        active: false,
      }),
    ])
    renderSwitcher()
    await waitFor(() => expect(screen.getByText("组织甲")).toBeTruthy())
    expect(screen.getByText("组织乙")).toBeTruthy()
    expect(screen.getByText("张三")).toBeTruthy()
    expect(screen.getByText("李四")).toBeTruthy()
  })

  /**
   * ★ 当前那个标「当前」且**没有**按钮；只有别的身份才有「切换」。
   * 给当前那个一个禁用按钮会读成"暂时不可用"，而事实是"你已经在这儿了"。
   */
  it("★ 当前身份标「当前」且不给切换按钮", async () => {
    installApi([
      identity({ active: true }),
      identity({ corpId: CORP_B, userId: "200002", corpName: "组织乙", active: false }),
    ])
    renderSwitcher()
    await waitFor(() => expect(screen.getByText("当前")).toBeTruthy())
    // 两个身份，但只有一个「切换」按钮（当前那个没有）
    expect(screen.getAllByRole("button", { name: "切换" })).toHaveLength(1)
  })

  /**
   * ★ 显示名缺失时退到 ID 前几位，而不是留空行。
   * 绑定时渠道可能没给名字（`corpName`/`userName` 都可空）。
   */
  it("组织名/真名缺失 → 退到 ID 前缀（不留空行）", async () => {
    installApi([
      identity({ corpName: null, userName: null, active: true }),
      identity({ corpId: CORP_B, userId: "200002", corpName: "组织乙", active: false }),
    ])
    const { container } = renderSwitcher()
    await waitFor(() => expect(screen.getByText("组织乙")).toBeTruthy())
    // corpId 前 10 位 + 省略号
    expect(container.textContent).toContain(CORP_A.slice(0, 10))
  })
})

describe("★★ 切换中必须说清图谱要重新准备", () => {
  /**
   * 这条锁的是那个静默降级：切完身份图谱会空一两分钟（warmup 实测冷启
   * 约 90s），而"空了"与"正在准备"在界面上长得一样。
   * 提示必须与用户看到空图谱在同一屏。
   */
  it("★★ 点切换 → 出现「图谱需要重新准备」的说明", async () => {
    // 永不 resolve：把界面钉在 pending 态上，正是要断言的那一刻
    installApi(
      [
        identity({ active: true }),
        identity({ corpId: CORP_B, userId: "200002", corpName: "组织乙", active: false }),
      ],
      { onSwitch: () => new Promise(() => undefined) },
    )
    renderSwitcher()
    await waitFor(() => expect(screen.getByRole("button", { name: "切换" })).toBeTruthy())
    screen.getByRole("button", { name: "切换" }).click()

    await waitFor(() => {
      const text = document.body.textContent ?? ""
      expect(text).toContain("正在切换身份")
      // ★ 必须提到图谱与"不是数据丢了"
      expect(text).toContain("图谱")
      expect(text).toContain("不是数据丢了")
    })
  })

  it("切换中其它身份的按钮被禁用（避免连点切两次）", async () => {
    installApi(
      [
        identity({ active: true }),
        identity({ corpId: CORP_B, userId: "200002", corpName: "组织乙", active: false }),
      ],
      { onSwitch: () => new Promise(() => undefined) },
    )
    renderSwitcher()
    await waitFor(() => expect(screen.getByRole("button", { name: "切换" })).toBeTruthy())
    screen.getByRole("button", { name: "切换" }).click()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "切换" }).hasAttribute("disabled")).toBe(true),
    )
  })

  it("切换失败 → 报出来（role=alert），不静默吞掉", async () => {
    installApi(
      [
        identity({ active: true }),
        identity({ corpId: CORP_B, userId: "200002", corpName: "组织乙", active: false }),
      ],
      {
        onSwitch: () =>
          Promise.resolve({
            ok: false as const,
            error: { code: "CHANNEL_IDENTITY_UNAVAILABLE", message: "这个身份在本机没有登录态" },
          }),
      },
    )
    renderSwitcher()
    await waitFor(() => expect(screen.getByRole("button", { name: "切换" })).toBeTruthy())
    screen.getByRole("button", { name: "切换" }).click()
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy())
  })
})
