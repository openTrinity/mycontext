/**
 * 「哪个 dws 二进制」这个隔离维度的**唯一接线**。
 *
 * ## ★★★ 这一组存在的理由：反证时它是裸的
 *
 * 隔离键的第一段是来源应用（`source-key.ts`：实测两个来源的 CLI 返回
 * **逐字段相同**的 corpId/userId，不带来源会被判成同一个身份、共用一个 vault）。
 *
 * 判据那侧锁得很细（`active-identity.test.ts` 里那 5 条）。但把
 * `startup.ts` 里传这个值的那一行删掉之后，全仓 **3826 条测试一条都不红** ——
 * 也就是"调用方到底传没传"没有任何人验证。
 *
 * 而那条线断掉的后果就是这次的事故（本机日志 2026-08-09）：
 *
 * ```
 * 23:23:28  active identity restored {channelId: "dingtalk"}   ← 内置那份的身份
 * 23:23:28  vault opened {vaultId: "vaultFAKE-B…"}                ← 内置那份的库
 * 23:25:02+ process {"executable": "…/dws-darwin-arm64"}       ← 跑的却是自制客户端
 * ```
 *
 * 自制客户端采的数据写进内置客户端的 vault，实测 8898 条消息，
 * 而**没有任何报错** —— 两个库都"有数据"，只是数据属于另一个来源。
 * 与「两头都锁了、中间那根线是裸的」同一个形状。
 */
import { describe, expect, it } from "vitest"
import { scopedChannelIdFor } from "@main/bootstrap/post-auth-identity.js"

describe("★★★ 来源作用域：内置不加后缀、自备按路径分流", () => {
  /**
   * ★★ 内置那份**不加后缀**。
   *
   * 这是存量兼容的关键：库里已有的行是 `channel_id = "dingtalk"`，
   * 加了后缀就等于所有老用户的身份一夜之间找不到 → 数据看起来全没了。
   */
  it("★★ 没设自备路径 → 裸 channelId（存量行照旧命中）", () => {
    expect(scopedChannelIdFor("dingtalk", null)).toBe("dingtalk")
    expect(scopedChannelIdFor("dingtalk", undefined)).toBe("dingtalk")
    // 空串也算没设 —— UI 上清空输入框就是这个值
    expect(scopedChannelIdFor("dingtalk", "")).toBe("dingtalk")
  })

  /** ★★ 设了自备路径 → 带后缀，且与内置**不同**。 */
  it("★★ 设了自备路径 → 带 @src- 后缀且与内置不同", () => {
    const custom = scopedChannelIdFor("dingtalk", "/opt/vendor-cli/dws")
    expect(custom).toMatch(/^dingtalk@src-[0-9a-f]{8}$/)
    expect(custom).not.toBe(scopedChannelIdFor("dingtalk", null))
  })

  /**
   * ★★★ **两个不同的自备路径必须分开。**
   *
   * 这条是隔离本身：同一台机器上装两份不同来源的 CLI 时，
   * 它们的 corpId/userId 相同，唯一的区别就是这个值。
   */
  it("★★★ 两个不同路径 → 两个不同的作用域", () => {
    const a = scopedChannelIdFor("dingtalk", "/opt/vendor-a/dws")
    const b = scopedChannelIdFor("dingtalk", "/opt/vendor-b/dws")
    expect(a).not.toBe(b)
  })

  /** ★ 同一个路径**稳定** —— 不稳定的话每次启动都换一个 vault。 */
  it("★ 同一路径两次调用给同一个值", () => {
    const p = "/opt/vendor-cli/dws"
    expect(scopedChannelIdFor("dingtalk", p)).toBe(scopedChannelIdFor("dingtalk", p))
  })

  /**
   * ★★ 不泄漏路径本身。
   *
   * 这个值要进数据库、进日志、进 vault 目录名，而自备路径里通常有本机
   * 用户名（`/Users/<用户名>/…`）—— 那是身份信息（CLAUDE.md §1.1）。
   */
  it("★★ 结果里不含路径片段（hash 而不是原值）", () => {
    const out = scopedChannelIdFor("dingtalk", "/Users/somebody/tools/dws-darwin-arm64")
    expect(out).not.toContain("somebody")
    expect(out).not.toContain("/")
    expect(out).not.toContain("dws")
  })

  /** ★ 渠道 id 本身要保留（将来多渠道时不能串）。 */
  it("★ 换渠道 → 前缀跟着换", () => {
    expect(scopedChannelIdFor("feishu", "/opt/x/dws")).toMatch(/^feishu@src-/)
  })
})
