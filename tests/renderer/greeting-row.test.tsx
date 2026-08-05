/**
 * @vitest-environment jsdom
 *
 * 仪表盘顶部那一行问候（头像 + 「下午好，小王」）。
 *
 * ## 这一组锁的是三件"写错了却静默"的事
 *
 * 1. **花名与实名相同时不许重复** —— 否则得到「高鹏（高鹏）」。
 *    这个判断在 `pickChannelNick` 一处，引导第一步用的是同一个函数；
 * 2. **拿不到花名要退回实名**，而不是显示空、"未知"或 email 前缀。
 *    这个仓库有过同型的 bug：侧栏写「高鹏」而搜索首屏写「gaopeng」——
 *    同一屏两个我；
 * 3. **头像的兜底首字母与旁边的文字必须同名**（都走 `resolveGreetingName`）。
 *    两处各算一遍的话会出现"头像上是沈、旁边写着小王"。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"
import { I18nextProvider } from "react-i18next"
import { createI18n } from "@mycontext/i18n"
import type { AuthSession } from "@mycontext/ipc-contract"
import {
  GreetingRow,
  pickChannelNick,
  resolveGreetingName,
} from "@renderer/features/dashboard/greeting-row"

afterEach(cleanup)

function session(over: Partial<AuthSession> = {}): AuthSession {
  return {
    email: "gaopeng@example.com",
    displayName: "沈某",
    avatarUrl: null,
    avatarSource: null,
    ...over,
  } as AuthSession
}

const wrap = (node: React.ReactElement) =>
  render(<I18nextProvider i18n={createI18n("zh")}>{node}</I18nextProvider>)

describe("★★ pickChannelNick：花名与实名相同时不显示", () => {
  /**
   * 这一条是这个函数存在的**全部**理由。
   * 不判的话问候语会是「下午好，沈某」而头像旁边还有一个「沈某」——
   * 或者更糟，在引导第一步里显示「沈某（沈某）」。
   */
  it("与实名相同 → null（不重复）", () => {
    expect(pickChannelNick(["沈某"], "沈某")).toBeNull()
  })

  it("与实名不同 → 用花名", () => {
    expect(pickChannelNick(["小王"], "沈某")).toBe("小王")
  })

  /** 身份还没解析过时 `displayNames` 整个是 undefined —— 那是正常状态 */
  it("undefined → null（还没解析出身份，不是错误）", () => {
    expect(pickChannelNick(undefined, "沈某")).toBeNull()
  })

  /** 渠道返回空串时不能把空串当花名（那会显示「下午好，」） */
  it("空串 → null", () => {
    expect(pickChannelNick([""], "沈某")).toBeNull()
  })

  /** 一人可能多个名字，取渠道给的主显示名（第一个） */
  it("多个名字取第一个（渠道给的主显示名）", () => {
    expect(pickChannelNick(["小王", "J.Shen"], "沈某")).toBe("小王")
  })
})

describe("★★ resolveGreetingName：头像与文字同一个名字", () => {
  it("有花名 → 用花名", () => {
    expect(resolveGreetingName(session(), "小王")).toBe("小王")
  })

  it("没花名 → 退回账号显示名", () => {
    expect(resolveGreetingName(session(), null)).toBe("沈某")
  })

  /**
   * ★ `displayName` 为空时退到 email 前缀 —— 这一层**不自己实现**，
   * 靠 `resolveDisplayName`。这条用例锁的是"确实委托给了它"，
   * 而不是这里又写了一份切 email 的逻辑。
   */
  it("连账号显示名都没有 → 退到 email 前缀（走 resolveDisplayName）", () => {
    expect(resolveGreetingName(session({ displayName: null }), null)).toBe("gaopeng")
  })
})

describe("★ 问候行渲染", () => {
  it("显示「问候语，名字」，用花名", () => {
    const { container } = wrap(<GreetingRow session={session()} channelNick="小王" />)
    const text = container.textContent ?? ""
    expect(text).toContain("小王")
    // 问候语按小时分段，四个取值之一都算对（不锁死具体哪一个）
    expect(text).toMatch(/早上好|下午好|晚上好|夜深了/)
  })

  /**
   * ★ 名字**恰好出现一次**。
   *
   * 用数个数而不是 `getByText` —— 后者在有两个时抛 "found multiple"，
   * 那也算红，但报错说的是"选择器不够精确"，指向错误的方向
   * （其实是名字重复）。
   */
  it("名字恰好出现一次（不是「下午好，沈某沈某」）", () => {
    const { container } = wrap(<GreetingRow session={session()} channelNick={null} />)
    const hits = (container.textContent ?? "").match(/沈某/g) ?? []
    expect(hits).toHaveLength(1)
  })

  /**
   * ★ session 还没到时整行不出现，而不是画一个占位骨架。
   *
   * 一个"？头像 + 你好，—"比空着更像坏了，而它只闪一瞬。
   */
  it("session=null → 整行不渲染", () => {
    const { container } = wrap(<GreetingRow session={null} channelNick={null} />)
    expect(container.textContent ?? "").toBe("")
  })

  /**
   * ★ 这一行**不是**被删掉的那条身份条 —— 它不带身份状态。
   *
   * 未确认那条警示走 `ProblemLine`（`dashboard-module.tsx`），
   * 而"已确认"平时永远亮着，是噪音，不该回来。
   */
  it("不带身份状态（那是被删掉的身份条的活）", () => {
    const { container } = wrap(<GreetingRow session={session()} channelNick="小王" />)
    const text = container.textContent ?? ""
    expect(text).not.toContain("本人身份已确认")
    expect(text).not.toContain("待确认")
  })
})
