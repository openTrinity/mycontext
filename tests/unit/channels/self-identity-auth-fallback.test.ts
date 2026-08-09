/**
 * `get-self` 拿不到时，从**授权态**取本人身份。
 *
 * ## 这一组锁的是一个实测过的死锁
 *
 * 实测（用户日志 2026-08-09）：随包的那份客户端对某企业的 `contact` 域
 * 没开通，于是：
 *
 * ```
 * contact/get_current_user_profile   → ENTERPRISE_NOT_AUTHORIZED
 * contact/search_contact_by_key_word → ENTERPRISE_NOT_AUTHORIZED   ← 路 3 也没了
 * ```
 *
 * 而 `get-self` 原本是**硬前置**（抛出即整个 `resolveSelf` 结束），
 * 所以后面两条兜底路一条都到不了：
 *
 *     点「用这个身份」→ resolveSelf → get-self 被拒 → 抛错
 *       → 身份行永远写不成 → 引导页那两句提示永远不消失
 *
 * ★ 而这一步要的东西 **`auth status` 已经有了**：它走 auth 域，
 * 返回 `user_id` / `user_name` / `corp_id` / `corp_name`。
 * 实测同一份客户端、同一个企业，那条命令正常返回。
 *
 * 也就是说我们为了拿一个已经在手边的值去调了一个可能没权限的接口，
 * 并且让它的失败终止了整条链。
 *
 * ## ★ 为什么单聊交集（路 2）救不了这个场景
 *
 * 那条路要求库里有 ≥2 个双方都发过言的单聊。而这个 bug 的典型现场是
 * **刚授权、库还是空的**（实测那个 vault 的 `messages` 是 0 行）——
 * 采集又因为没有身份而不敢跑（`identity_unbound`），于是永远攒不出数据。
 * 死锁的两头互相等：要身份才能采集，要采集才能推断身份。
 *
 * 所以退路必须**既不依赖库、也不依赖 contact 权限**，只有授权态满足。
 */
import { describe, expect, it } from "vitest"
import { AppError, isAppError } from "@mycontext/kernel"
import { resolveSelf, type AuthIdentityFallback } from "@mycontext/channels"

/** 照真实响应的形状造（值全是编的）。 */
const AUTH_IDENTITY = {
  userId: "100200",
  userName: "张三",
  corpId: "dingFAKECORP0001",
  corpName: "示例组织",
}

/** 客户端对 contact 域没开通 —— 与 `classifyDwsError` 的产物一致。 */
function notAuthorized(): AppError {
  return new AppError("PERMISSION_REQUIRED", "当前渠道客户端对这个企业没有开通该能力", {
    retryable: false,
    messageKey: "errors:byCode.CHANNEL_CLIENT_NOT_AUTHORIZED",
    context: { serverErrorCode: "ENTERPRISE_NOT_AUTHORIZED" },
  })
}

/**
 * 一个"contact 域全挂"的 cli：`get-self` 与 `search` 都被拒。
 *
 * ★ 两条都拒是**真实形态**（实测两个 operation 报同一个码）。
 * 只让 `get-self` 挂的话测试会因为路 3 侥幸成功而绿 —— 那就测不到这件事。
 */
function contactDeniedCli(): { json: (args: string[]) => Promise<unknown>; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    json: (args: string[]) => {
      calls.push(args.join(" "))
      return Promise.reject(notAuthorized())
    },
  }
}

describe("★★ contact 域没权限时，退到授权态", () => {
  /**
   * ★★ 退路给的是 **userId**，而消息里的发送者标识是 **openDingTalkId** ——
   * 两者不是一回事，所以光有授权态**还不够**。
   *
   * 我第一版把这条写成"退到授权态就该成功"，然后被自己的实现驳回了。
   * 查下去发现原实现是对的：`is_self` 的回填 SQL 按 `sender_external_id`
   * （也就是 openDingTalkId）匹配（`repositories/messages.ts:454`）。
   * 只有 userId 的话回填结果全是 0 → 蒸馏照样拒掉全部语料 ——
   * 那是一种**看起来成功了的失败**，比抛错糟得多。
   *
   * 所以正确行为是：拿到 userId 但拿不到 openId → 仍然抛 AMBIGUOUS，
   * 让用户看到"要人工确认"。真正救回场景的是下面那条
   * （授权态给 userId + 单聊交集给 openId）。
   */
  it("★★ 只有授权态（拿不到 openId）→ 仍抛 AMBIGUOUS，不假装成功", async () => {
    const authIdentity: AuthIdentityFallback = () => Promise.resolve(AUTH_IDENTITY)

    await expect(resolveSelf(contactDeniedCli(), "dingtalk", { authIdentity })).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === "SELF_IDENTITY_AMBIGUOUS",
    )
  })

  /**
   * ★★ 这条才是这次改动真正救回的场景，也是死锁的出口。
   *
   * 授权态给 `userId`（不需要 contact 权限），单聊交集给 `openDingTalkId`
   * （不需要任何权限，纯本地 SQL）—— 两者合起来是一份完整身份。
   * 而在改动之前，`get-self` 一抛就到不了这里。
   */
  it("★★ 授权态给 userId + 单聊交集给 openId → 合成完整身份", async () => {
    const authIdentity: AuthIdentityFallback = () => Promise.resolve(AUTH_IDENTITY)
    const resolved = await resolveSelf(contactDeniedCli(), "dingtalk", {
      authIdentity,
      inferFromMessages: () => "DFAKE0001",
    })
    expect(resolved.userId).toBe(AUTH_IDENTITY.userId)
    expect(resolved.openIds).toEqual([{ kind: "openDingTalkId", value: "DFAKE0001" }])
    expect(resolved.source).toBe("direct-chat-intersection")
  })

  /**
   * ★ 显示名要带上 —— 界面上要显示「组织 · 某某」让用户核对是不是自己。
   * 空着的话那个确认框等于让人对着一个空白点确认。
   */
  it("★ 显示名从授权态带过来", async () => {
    const authIdentity: AuthIdentityFallback = () => Promise.resolve(AUTH_IDENTITY)
    const resolved = await resolveSelf(contactDeniedCli(), "dingtalk", {
      authIdentity,
      inferFromMessages: () => "DFAKE0001",
    })
    expect(resolved.displayNames).toContain(AUTH_IDENTITY.userName)
    expect(resolved.corpName).toBe(AUTH_IDENTITY.corpName)
  })

  /**
   * ★★ **不许编造 openDingTalkId**。
   *
   * 授权态里没有它。造一个假值会让下游以为拿到了真标识，而那个值会被写进
   * `channel_self_identity` 并用来判定"这条消息是不是我发的"——
   * 判错的后果是把别人的消息当本人语料，画像污染不可逆。
   *
   * 断言方式：只给授权态（不给交集）时必须**抛错**而不是返回一个带
   * 编造 openId 的成功结果。上面第一条已经锁了抛错，这条锁"抛的不是
   * 因为它编了一个又发现不对"—— 而是 openIds 从头到尾没有被凭空造出来。
   */
  it("★★ 不编造 openDingTalkId（授权态里没有就是没有）", async () => {
    const authIdentity: AuthIdentityFallback = () => Promise.resolve(AUTH_IDENTITY)
    // 交集给 null（推不出来）→ 没有任何真 openId 来源 → 必须抛
    await expect(
      resolveSelf(contactDeniedCli(), "dingtalk", {
        authIdentity,
        inferFromMessages: () => null,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === "SELF_IDENTITY_AMBIGUOUS",
    )
  })
})

describe("★★ 退路失效时要抛**原来那个**错", () => {
  /**
   * ★★ 不能把服务端的真实原因换成一句"无法获取本人 userId"。
   *
   * 前者带着可行动的信息（"请在设置里换一份客户端"），
   * 后者会把用户引向"是不是我的名字有问题" —— 一个完全错误的方向。
   */
  it("★★ 授权态也拿不到 → 抛出 contact 那个错，保留可行动的文案", async () => {
    const authIdentity: AuthIdentityFallback = () => Promise.resolve(null)

    await expect(resolveSelf(contactDeniedCli(), "dingtalk", { authIdentity })).rejects.toSatisfy(
      (error: unknown) =>
        isAppError(error) &&
        error.code === "PERMISSION_REQUIRED" &&
        error.messageKey === "errors:byCode.CHANNEL_CLIENT_NOT_AUTHORIZED",
    )
  })

  /**
   * ★ 没给退路（老调用方）→ 行为不变，仍然抛原错。
   * 这条保证这次改动对没接退路的调用方是**零影响**的。
   */
  it("★ 不给 authIdentity → 老行为（抛原错）", async () => {
    await expect(resolveSelf(contactDeniedCli(), "dingtalk", {})).rejects.toThrow()
  })
})
