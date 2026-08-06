/**
 * 隔离键里的「来源应用」那一段。
 *
 * ## 这一组锁的是一个**实测存在**的身份撞车
 *
 * 同一台机器上装了两个不同来源的渠道 CLI（随包的开源版、用户自备的闭源版），
 * 两者 `auth status` 返回的 `corp_id` 与 `user_id` **完全相同**
 * （逐字段 sha256 比对，13 个字段全等）。于是四元组
 * `(accountId, channelId, corpId, userId)` 把它们判成同一个身份、
 * 共用一个 vault —— 而两者的消息面不同，混进一个库就是把两批语料
 * 蒸进同一份画像，且不可逆。
 *
 * 修法是给 `channelId` 带上来源键。这一组锁三件事：
 * ① 两个来源真的分开（那是这次的修复）；
 * ② **内置那份不带后缀**（存量兼容 —— 破了会让老用户"数据全没了"）；
 * ③ 往返幂等，且 hash 不泄漏本机路径。
 */
import { describe, expect, it } from "vitest"
import {
  BUILTIN_SOURCE_KEY,
  parseScopedChannelId,
  scopedChannelId,
  sourceKeyOf,
} from "@mycontext/channels"

/** 照真实形态造的两个自备路径（值是编的，不是本机真实路径）。 */
const CUSTOM_A = "/opt/vendor-cli/dws-darwin-arm64"
const CUSTOM_B = "/opt/other-vendor/dws"

describe("★★ 内置那份必须不带后缀（存量兼容）", () => {
  /**
   * ★★ 这条是全组最重要的。
   *
   * 已有映射行（以及 `channel_self_identity`、`app_settings` 里记的
   * "上次用哪个身份"）里 `channel_id` 就是裸的 `"dingtalk"`。
   * 给内置也加后缀的话那些行**全部失配** —— 表现是"登录进去数据全没了、
   * 又让我重新授权"，而磁盘上的库其实还在。最难查的那类。
   */
  it("★★ 没设自备路径 → 来源键是 builtin", () => {
    expect(sourceKeyOf(undefined)).toBe(BUILTIN_SOURCE_KEY)
  })

  /** 空串等同于没设 —— UI 上把路径清空走的就是这条。 */
  it("★★ 空串等同于没设", () => {
    expect(sourceKeyOf("")).toBe(BUILTIN_SOURCE_KEY)
  })

  it("★★ 内置的 scopedChannelId 与裸 channelId 逐字相同", () => {
    expect(scopedChannelId("dingtalk", BUILTIN_SOURCE_KEY)).toBe("dingtalk")
    expect(scopedChannelId("dingtalk", sourceKeyOf(undefined))).toBe("dingtalk")
    expect(scopedChannelId("feishu", sourceKeyOf(""))).toBe("feishu")
  })

  /**
   * ★ 存量行（裸 `"dingtalk"`）拆出来必须是内置 —— 否则读回来的身份
   * 与写进去的对不上，`find()` 查不到。
   */
  it("★ 裸 channelId 拆出来是内置", () => {
    expect(parseScopedChannelId("dingtalk")).toEqual({
      channelId: "dingtalk",
      sourceKey: BUILTIN_SOURCE_KEY,
    })
  })
})

describe("★★ 两个来源必须分开（这次的修复）", () => {
  /**
   * ★★ 这条是那个 bug 的直接反面：同样的 corpId/userId，
   * 只因为来源不同就该是两个身份、两个 vault。
   */
  it("★★ 自备路径 → 与内置不同的 channelId", () => {
    const builtin = scopedChannelId("dingtalk", sourceKeyOf(undefined))
    const custom = scopedChannelId("dingtalk", sourceKeyOf(CUSTOM_A))
    expect(custom).not.toBe(builtin)
  })

  it("★★ 两个不同的自备路径互相也不同", () => {
    expect(sourceKeyOf(CUSTOM_A)).not.toBe(sourceKeyOf(CUSTOM_B))
  })

  /** 同一个路径必须稳定 —— 否则每次启动都是一个新身份、每次都建新 vault。 */
  it("★★ 同一路径反复算得到同一个键（稳定）", () => {
    expect(sourceKeyOf(CUSTOM_A)).toBe(sourceKeyOf(CUSTOM_A))
  })
})

describe("★ hash 不能泄漏本机路径", () => {
  /**
   * ★★ 路径里有本机用户名（`/Users/<用户名>/…`），而这个值要进数据库、
   * 进日志、可能进目录名。CLAUDE.md §1.1 明确"本机绝对路径"不许出现 ——
   * 用户名本身就是身份信息。
   */
  it("★★ 结果里不含原路径的任何片段", () => {
    const key = sourceKeyOf("/Users/somebody/tools/dws")
    expect(key).not.toContain("somebody")
    expect(key).not.toContain("Users")
    expect(key).not.toContain("/")
    expect(key).not.toContain("dws")
  })

  /** 形状固定：`src-` + 8 位十六进制。目录名/日志里可读且短。 */
  it("形状是 src- 加 8 位十六进制", () => {
    expect(sourceKeyOf(CUSTOM_A)).toMatch(/^src-[0-9a-f]{8}$/)
  })
})

describe("★ 往返幂等", () => {
  /**
   * ★ 拼进去再拆出来必须原样 —— 中间任一步不幂等的话，
   * 写入用的键与查询用的键会不同，而那表现为"授权成功了但列表里没有"。
   */
  it.each([
    ["dingtalk", BUILTIN_SOURCE_KEY],
    ["dingtalk", "src-3f2a1b8c"],
    ["feishu", "src-00000000"],
  ])("%s / %s 往返一致", (channelId, sourceKey) => {
    const scoped = scopedChannelId(channelId, sourceKey)
    expect(parseScopedChannelId(scoped)).toEqual({ channelId, sourceKey })
  })

  /**
   * ★ 后半段为空（`"dingtalk@"` —— 手改过库、或旧格式）按内置处理。
   *
   * 不这么兜的话会拆出一个空来源键，而空键再拼一次得到 `"dingtalk"`
   * （与输入不同）—— 往返不幂等，于是那一行永远查不到自己。
   */
  it("★ 后半段为空 → 按内置处理（往返仍幂等）", () => {
    const parsed = parseScopedChannelId("dingtalk@")
    expect(parsed).toEqual({ channelId: "dingtalk", sourceKey: BUILTIN_SOURCE_KEY })
    expect(scopedChannelId(parsed.channelId, parsed.sourceKey)).toBe("dingtalk")
  })

  /**
   * ★ 分隔符**不能**是 `:` —— 那是 `--profile <corpId>:<userId>` 的分隔符。
   * 两处同符号会让人把带作用域的值直接当 profile 传下去，而那必然
   * `organization not found`（实测过那个报错）。
   */
  it("★ 分隔符不是 profile 用的冒号", () => {
    const scoped = scopedChannelId("dingtalk", "src-3f2a1b8c")
    expect(scoped).not.toContain(":")
  })
})
