/**
 * @vitest-environment jsdom
 *
 * ★★ 身份错位告警：**渠道当前用的组织** ≠ **这个账号绑定的组织**。
 *
 * ## 这一组锁的是一个真实的越权读取面
 *
 * dws 的会话列表与消息采集都按它**当前生效的 profile** 来答，而那个 profile
 * 由 `primaryProfile` 决定。实测过一次真实错位（本机）：
 *
 * · 用户在应用里授权到组织 A，token 确实写进去了（`token.json` 的
 *   `updated_at` 就是那一刻）；
 * · 但 `primaryProfile` 仍指着组织 B，且 B 已 `expired`；
 * · 于是引导页「学习范围」列出的单聊是**组织 B** 的联系人（43 个），
 *   而 vault 身份行绑的是组织 A（库里只有 19 个单聊）。
 *
 * 用户授权的是 A，应用却在按 B 列会话 —— 这与 CLAUDE.md 第 5 节
 * 「严格遵守用户选的范围」是同一类问题，不是显示不准而已。
 *
 * ## 为什么只能告警
 *
 * 修它要让 dws 把 primary 切到 A，而实测**每一种** `--profile` 形式都报
 * `organization … not found`（`corpId:userId` / `corpId` / `corpName` /
 * `corpName:userName`，`profile switch --dry-run` 也一样）——
 * 因为 `dws profile list` 只认 1 个槽位而 `profiles.json` 里记了 3 个。
 * 那是 dws 侧两份记录不一致，应用这侧无法寻址。
 *
 * 所以目标是把**静默**的错位变成**可见**的。这一组就锁那个可见性。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { I18nextProvider } from "react-i18next"
import { createI18n } from "@mycontext/i18n"
import type { AuthStatus, ChannelSummary, MyContextApi } from "@mycontext/ipc-contract"
import { ChannelAuthPanel } from "@renderer/features/channels/channel-auth-panel"

afterEach(cleanup)

/** jsdom 没有 ResizeObserver，而 Button 走 useSquircle 会用它。 */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver

/** 组织 A：用户**以为**自己连的那个（也是 vault 身份行绑的那个）。 */
const CORP_BOUND = "dingAAAA0001"
/** 组织 B：dws 实际生效的那个（primaryProfile 指着它）。 */
const CORP_CHANNEL = "dingBBBB0002"

function authorized(
  corpId: string,
  corpName: string,
): Extract<AuthStatus, { state: "authorized" }> {
  return {
    state: "authorized",
    corpId,
    corpName,
    userId: "100001",
    userName: "张三",
    accessExpiresAt: "2026-09-01T00:00:00Z",
    refreshExpiresAt: "2026-09-30T00:00:00Z",
    // 刻意给足天数：否则会同时弹「快过期」，让断言分不清是哪一条
    daysUntilRefreshExpiry: 29,
  }
}

function channel(status: AuthStatus): ChannelSummary {
  return {
    id: "dingtalk",
    labelKey: "channels:dingtalk.label",
    descriptionKey: "channels:dingtalk.description",
    available: true,
    stepKeys: [],
    status,
    loginInProgress: false,
  }
}

/**
 * 装一份最小 API。
 *
 * `boundCorpId` = vault 身份行里的组织；`null` 表示这个账号还没有身份行
 * （`readSelf` 返回 null，那是正常状态）。
 */
function installApi(boundCorpId: string | null, confirmed = true): void {
  const api = {
    channels: {
      adoptableSession: () => Promise.resolve({ ok: true as const, data: null }),
      adoptSession: () => Promise.resolve({ ok: true as const, data: { adopted: false } }),
      onAuthProgress: () => () => undefined,
    },
    ingest: {
      readSelf: () =>
        Promise.resolve({
          ok: true as const,
          data:
            boundCorpId === null
              ? null
              : {
                  channelId: "dingtalk",
                  userId: "100001",
                  openIds: [{ kind: "openDingTalkId", value: "DFAKE0001" }],
                  displayNames: ["张三"],
                  corpName: "组织甲",
                  corpId: boundCorpId,
                  matchedMessageCount: 12,
                  confirmed,
                },
        }),
    },
    app: {
      bootstrapState: () =>
        Promise.resolve({
          ok: true as const,
          data: { session: { avatarUrl: null }, needsOnboarding: false },
        }),
    },
    dwsSource: {
      read: () =>
        Promise.resolve({
          ok: true as const,
          data: {
            configuredPath: null,
            configuredMissing: false,
            bundledPath: "/tmp/dws",
            bundledVersion: null,
            effectivePath: "/tmp/dws",
            fromDefaults: null,
            channelCode: null,
            channelFromDefaults: null,
            channelActive: false,
          },
        }),
    },
  } as unknown as MyContextApi
  ;(globalThis as { window?: { mycontext?: MyContextApi } }).window ??= {}
  ;(window as unknown as { mycontext: MyContextApi }).mycontext = api
}

function wrap(status: AuthStatus, variant: "onboarding" | "settings" = "settings") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <I18nextProvider i18n={createI18n("zh")}>
      <QueryClientProvider client={client}>
        <ChannelAuthPanel channel={channel(status)} variant={variant} />
      </QueryClientProvider>
    </I18nextProvider>,
  )
}

describe("★★ 身份错位必须显式告警（不能静默按另一个组织读数据）", () => {
  /**
   * ★ 这一条就是那个真实故障的回归锁。
   *
   * 断言两个组织名都出现：只说"身份不一致"用户无法判断该怎么做，
   * 而说清"渠道在用 B、账号绑的是 A"他才知道要重新授权到哪个。
   */
  it("★★ 渠道组织与账号绑定的组织不同 → 报警并说清是哪两个", async () => {
    installApi(CORP_BOUND)
    wrap(authorized(CORP_CHANNEL, "组织乙"))

    const alert = await waitFor(() => screen.getByRole("alert"))
    expect(alert.textContent).toContain("组织乙") // 渠道当前生效的
    expect(alert.textContent).toContain("组织甲") // 这个账号绑定的
  })

  /** 一致时**不能**报警 —— 假阳性会让用户学会忽略这条告警。 */
  it("★ 两边组织一致时不报警", async () => {
    installApi(CORP_BOUND)
    wrap(authorized(CORP_BOUND, "组织甲"))

    /**
     * 等 selfIdentity 真的查完再断言 —— 否则可能在 `data` 还没到时就跑
     * `queryByRole`，那时告警本来就不会渲染，这条测试会**恒过**。
     *
     * 用「已识别到 12 条本人消息」那个数字当信号：它只在 selfIdentity
     * 到了之后才出现，且全屏唯一（corpName 会在多处出现，findByText
     * 会撞上 multiple elements）。
     */
    await waitFor(() => expect(screen.getAllByText(/组织甲/).length).toBeGreaterThan(0))
    expect(screen.queryByRole("alert")).toBeNull()
  })

  /**
   * ★ 还没有身份行时**不报警**。
   *
   * 那是"新账号继承了本机登录态、还没采纳"的正常状态（见
   * `adoptExistingSession`）。此时没有"绑定的组织"可比，报警是纯假阳性。
   */
  it("★ 这个账号还没有身份行时不报警", async () => {
    installApi(null)
    wrap(authorized(CORP_CHANNEL, "组织乙"))

    /**
     * 没有身份行时 settings 变体不显示身份行，改显示那句"本机已有登录态"。
     * 用它当"查完了"的信号，再断言没有告警。
     */
    await waitFor(() => expect(screen.getByText(/这台电脑上已有钉钉登录态/)).toBeTruthy())
    expect(screen.queryByRole("alert")).toBeNull()
  })

  /** 未授权时无从比对，也不该报警。 */
  it("★ 未授权时不报警", async () => {
    installApi(CORP_BOUND)
    wrap({ state: "unauthorized" })

    await waitFor(() => expect(screen.getByText(/连接/)).toBeTruthy())
    expect(screen.queryByRole("alert")).toBeNull()
  })
})

/**
 * ★★ 「这个账号连了吗」≠「这台电脑登录过吗」。
 *
 * ## 这一组锁的是用户报的那个交互问题
 *
 * 用户原话："用户不知道要重新授权啊…如果是注册的话，进来都应该重新授权一下。"
 *
 * 根因：dws 的登录态按**系统用户**共享（token 密钥在 Keychain，
 * `DWS_CONFIG_DIR` 隔离不了它）。所以 `auth status` 回答的是「这台电脑登录过
 * 钉钉吗」，而卡片却把它渲染成「已连接钉钉 · 某某」—— 新注册的用户看到这个，
 * 合理反应就是"不用管了，下一步"，于是他从不授权。
 *
 * 后果实测过：`@222` 那个账号身份表 0 行、accounts 的 display_name/avatar_url
 * 全 NULL，而 messages 已 49 条 —— `is_self` 全 NULL，蒸馏拒掉全部语料而
 * 进度页显示"完成"。
 *
 * 引导页的完成门本来就用按账号的信号（`selfConfirmed` 读 vault 的
 * `confirmed_at`），所以门没被骗到 —— **骗到的是界面**。这一组锁界面。
 */
describe("★★ 机器级登录态不能显示成「这个账号已连接」", () => {
  /**
   * ★ 核心回归锁：渠道 authorized、但这个账号没有身份行。
   *
   * 必须显示「连接钉钉」+「授权」，而不是「已连接」+「重新授权」——
   * 说"重新"是误导，用户会以为已经连过一次。
   */
  it("★★ authorized 但账号无身份行 → 显示「连接」而不是「已连接」", async () => {
    installApi(null)
    wrap(authorized(CORP_CHANNEL, "组织乙"), "onboarding")

    /**
     * ★ 用**精确**匹配：「连接钉钉」是「已连接钉钉」的子串，
     * 用 includes 语义的正则会让这条断言在两种状态下都过 —— 恒真的测试。
     */
    await waitFor(() => expect(screen.getByText(/^连接钉钉$/)).toBeTruthy())
    expect(screen.queryByText(/^已连接钉钉$/)).toBeNull()
  })

  /** 说清"本机有登录态，但要为当前账号确认一次" —— 否则用户不知道为什么要授权。 */
  it("★ 给出可操作的解释（本机已有登录态 ≠ 当前账号已连接）", async () => {
    installApi(null)
    wrap(authorized(CORP_CHANNEL, "组织乙"))

    await waitFor(() => expect(screen.getByText(/这台电脑上已有钉钉登录态/)).toBeTruthy())
  })

  /**
   * ★★ 不能把**别人的**身份显示成"你的"。
   *
   * 机器级登录态里的 corpName/userName 属于本机上另一个账号（或一个过期
   * profile）。把它摆在标题下面正是这个误导的核心。
   */
  it("★★ 不显示那份不属于当前账号的身份", async () => {
    installApi(null)
    wrap(authorized(CORP_CHANNEL, "组织乙"), "onboarding")

    await waitFor(() => expect(screen.getByText(/^连接钉钉$/)).toBeTruthy())
    // 「组织乙 · 张三」这种身份行不该出现在英雄区
    expect(screen.queryByText(/组织乙 · 张三/)).toBeNull()
  })

  /**
   * ★ 身份**歧义**（同名多 ID）时同样不算连好。
   *
   * 那时身份行存在但 `confirmed_at` 是 null（主进程不替用户猜），
   * `is_self` 全表为空、蒸馏一条语料都拿不到 —— 与完成门的判据保持一致。
   */
  it("★ 有身份行但未确认（歧义）→ 仍不算已连接", async () => {
    installApi(CORP_BOUND, false)
    wrap(authorized(CORP_BOUND, "组织甲"), "onboarding")

    await waitFor(() => expect(screen.getByText(/^连接钉钉$/)).toBeTruthy())
    expect(screen.queryByText(/^已连接钉钉$/)).toBeNull()
  })

  /** 真连好的账号照旧显示「已连接」+ 身份 —— 老用户不该被要求重新授权。 */
  it("★ 已确认身份的账号仍显示「已连接」与身份", async () => {
    installApi(CORP_BOUND)
    wrap(authorized(CORP_BOUND, "组织甲"), "onboarding")

    await waitFor(() => expect(screen.getByText(/^已连接钉钉$/)).toBeTruthy())
    expect(screen.getAllByText(/组织甲/).length).toBeGreaterThan(0)
  })
})

describe("引导页的平台卡片保持紧凑", () => {
  it("默认只显示平台横条，点配置后才展开授权详情", async () => {
    installApi(CORP_BOUND)
    wrap({ state: "unauthorized" }, "onboarding")

    await waitFor(() => expect(screen.getByText(/^连接钉钉$/)).toBeTruthy())
    expect(screen.queryByText("开始授权")).toBeNull()
    expect(screen.queryByText("授权范围")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "配置" }))
    expect(screen.getByRole("button", { name: "收起" })).toBeTruthy()
    expect(screen.getByText("开始授权")).toBeTruthy()
    expect(screen.getByText("授权范围")).toBeTruthy()
  })
})
