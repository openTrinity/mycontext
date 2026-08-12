/**
 * `MultiMediaService` —— 头像**按渠道路由**。
 *
 * ## ★★ 为什么这个文件必须存在（这条路原来完全没有测试）
 *
 * 用户报的"飞书头像咋没获取"的根因是**接线**而不是算法：全应用唯一那个
 * `MediaService` 装配时把 `cli` / `avatars` / `channelId` 三个参数全写死
 * 主渠道，于是飞书的 `createFeishuAvatars` 写好了却零调用点、缓存键也
 * 对不上。两层都是**静默**的 —— 表现是"这个人没设头像"，与真的没设
 * 不可区分。
 *
 * 而这类"中间那根线是裸的"错位，只有断言在**接线本身**上才能锁住：
 * 断言取头像的算法对不对，改错接线时它照样全绿。
 */
import { describe, expect, it } from "vitest"
import { MultiMediaService } from "../../../apps/desktop/src/main/services/multi-media.service.js"

/** 一个只记"被谁调过"的假 media —— 我们要验的是路由，不是取头像。 */
function fakeMedia(tag: string, calls: string[]) {
  return {
    avatarsFromCache: (ids: readonly string[]) => {
      calls.push(`${tag}:cache:${ids.join(",")}`)
      return ids.map((externalId) => ({
        externalId,
        path: `/tmp/${tag}-${externalId}.jpg`,
        missReason: null,
        needsFetch: false,
      }))
    },
    avatar: async (input: { externalId: string }) => {
      calls.push(`${tag}:avatar:${input.externalId}`)
      return { path: `/tmp/${tag}-${input.externalId}.jpg`, reason: null }
    },
    selfAvatar: async () => {
      calls.push(`${tag}:self`)
      return { path: `/tmp/${tag}-self.jpg`, reason: null }
    },
  }
}

function build(calls: string[], sources: readonly string[] = ["feishu"]) {
  return new MultiMediaService(
    // 假替身只实现被路由的那三个方法（`AvatarSurface`），
    // 而构造函数的类型是完整的 `MediaService` —— 断言到 never 而不是
    // 给替身补上几十个用不到的方法。
    fakeMedia("dingtalk", calls) as never,
    "dingtalk",
    () => sources.map((channelId) => ({ channelId, media: fakeMedia(channelId, calls) })),
  )
}

describe("MultiMediaService：头像按渠道路由", () => {
  it("★★ 指定渠道 → 用**那个渠道**的取法，不落到主渠道", async () => {
    /**
     * 反证：把 `pick()` 改成恒返回 `this.primary`，这一条立刻转红。
     * 而那个改动正是修复前的真实状态 —— 飞书的实现零调用点。
     */
    const calls: string[] = []
    const media = build(calls)
    media.avatarsFromCache(["ou_FAKE01"], "feishu")
    await media.avatar({ externalId: "ou_FAKE01" }, "feishu")
    await media.selfAvatar({}, "feishu")
    expect(calls).toEqual(["feishu:cache:ou_FAKE01", "feishu:avatar:ou_FAKE01", "feishu:self"])
    // 一次都不该碰主渠道 —— 碰了就是"用钉钉的取法去取飞书的头像"
    expect(calls.some((c) => c.startsWith("dingtalk:"))).toBe(false)
  })

  it("★ 不传渠道 / 传主渠道 → 主渠道（存量调用点的行为不变）", async () => {
    const calls: string[] = []
    const media = build(calls)
    media.avatarsFromCache(["dFAKE01"])
    media.avatarsFromCache(["dFAKE02"], "dingtalk")
    expect(calls).toEqual(["dingtalk:cache:dFAKE01", "dingtalk:cache:dFAKE02"])
  })

  it("★ 那个渠道还没挂上 → 落回主渠道而**不抛**", () => {
    /**
     * 与 `ChannelRuntimeRegistry.require()` 的"拿不到就抛"**故意不同**：
     * 那条不变式针对写与删（写错库无法挽回）。头像是纯读，失败代价是
     * 显示首字母兜底 —— 为它抛错会让整屏头像在渠道刚挂载的那几百毫秒里
     * 一起变错误态，而那比"某个人的头像没显示"糟得多。
     */
    const calls: string[] = []
    const media = build(calls, []) // 一个非主渠道都没挂
    expect(() => media.avatarsFromCache(["ou_FAKE01"], "feishu")).not.toThrow()
    expect(calls).toEqual(["dingtalk:cache:ou_FAKE01"])
  })

  it("★ 每次调用都重读 sources（非主渠道是登录后才现造的）", () => {
    /**
     * 构造时 sources 为空、之后飞书才挂上 —— 必须能路由到它。
     * 传数组而不是函数的话这一条会红（那正是 `MultiKlServerService`
     * 踩过的坑：注册表在装配阶段构造，那时非主渠道全都还不存在）。
     */
    const calls: string[] = []
    let mounted: string[] = []
    const media = new MultiMediaService(fakeMedia("dingtalk", calls) as never, "dingtalk", () =>
      mounted.map((channelId) => ({ channelId, media: fakeMedia(channelId, calls) })),
    )
    media.avatarsFromCache(["ou_FAKE01"], "feishu") // 还没挂 → 主渠道
    mounted = ["feishu"]
    media.avatarsFromCache(["ou_FAKE02"], "feishu") // 挂上了 → 飞书
    expect(calls).toEqual(["dingtalk:cache:ou_FAKE01", "feishu:cache:ou_FAKE02"])
  })
})

/**
 * ── 「刷新头像」不许写账号级头像（一次真实的串台）────────────────
 *
 * 用户报："设置里飞书头像，点了刷新头像，再切换到钉钉就变成飞书的新头像了"。
 *
 * 根因是**两个语义不同的动作共用了一条通道**：
 *
 * | 动作                   | 该做什么                                  |
 * |------------------------|-------------------------------------------|
 * | 从已连接的平台获取     | 取渠道头像 **并写账号头像**（用户就是要这个） |
 * | 刷新头像               | 只更新**这个渠道**那张缓存                 |
 *
 * 我让后者也走 `mediaSelfAvatar`，而那条会 `applyChannelProfile({avatarUrl})`
 * 写 `accounts` 表（全应用一份）。于是在飞书点刷新 → 账号头像变成飞书那张 →
 * 切回钉钉时头部回落 `session.avatarUrl` → 显示飞书那张。
 *
 * 这里锁住"刷新走的是纯读那条路"：`avatar()` 而不是 `selfAvatar()`。
 */
describe("刷新头像：只碰渠道缓存，不碰账号", () => {
  it("★★ 刷新走 avatar()（纯读 + 写 contact_avatars），**不是** selfAvatar()", async () => {
    /**
     * 反证：把渲染层的 `useRefreshChannelAvatar` 改回 `useFetchSelfAvatar`，
     * 那条路会调 `selfAvatar()` → 这条断言的 `selfCalls` 变成 1 → 红。
     *
     * ★ 这一层验的是 `MultiMediaService` 的两个方法**互不代理** ——
     * 若哪天有人把 `avatar()` 实现成"内部再调一次 selfAvatar"，
     * 账号头像会重新被写，而串台会悄悄回来。
     */
    const calls: string[] = []
    const media = build(calls)
    await media.avatar({ externalId: "ou_FAKE01", force: true }, "feishu")
    expect(calls).toEqual(["feishu:avatar:ou_FAKE01"])
    // 一次都不该碰 selfAvatar —— 那条会写账号级头像
    expect(calls.filter((c) => c.endsWith(":self"))).toEqual([])
  })

  it("★ selfAvatar 仍然可用（「从已连接的平台获取」要的就是它，含写账号）", async () => {
    // 不能因为修串台就把这条路也堵掉：那个动作的语义**就是**写账号头像
    const calls: string[] = []
    const media = build(calls)
    await media.selfAvatar({ force: true }, "feishu")
    expect(calls).toEqual(["feishu:self"])
  })
})

/**
 * ── ★★★ 锁住**渲染层用了哪个 hook** ────────────────────────────
 *
 * 上面那两条锁的是 `MultiMediaService` 的方法互不代理 —— 但串台的真实
 * 位置**不在**那里，而在"授权卡那颗按钮调了哪个 hook"。我改错的正是那一行，
 * 而 `MultiMediaService` 的行为从头到尾都是对的。
 *
 * 这就是本仓库反复出现的形状：**两头都锁了、中间那根线是裸的**。
 * 所以这里直接对源码断言 —— 判据是"那颗按钮的 onClick 走的是纯读那条路"。
 */
describe("接线：授权卡的「刷新头像」不许走写账号那条", () => {
  it("★★ channel-auth-panel 用 useRefreshChannelAvatar，不用 useFetchSelfAvatar", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync(
      "apps/desktop/src/renderer/features/channels/channel-auth-panel.tsx",
      "utf8",
    )
    /**
     * 反证：把那一行换回 `useFetchSelfAvatar()` → 这条转红。
     * 而红之前的状态正是用户报的串台（飞书点刷新，钉钉变飞书头像）。
     */
    expect(src).toContain("useRefreshChannelAvatar()")
    /**
     * ★ 判据是**调用与 import**，不是"文件里提不提这个名字"。
     *
     * 我第一版写成 `!src.includes("useFetchSelfAvatar")` —— 红了，
     * 而红的原因是**注释里解释了为什么不用它**（那些注释恰恰是有价值的）。
     * 断言必须只管真正会执行的东西：`useFetchSelfAvatar(` 的调用，
     * 以及 import 清单里有没有它。
     */
    expect(src.includes("useFetchSelfAvatar(")).toBe(false)
    const importBlock = src.slice(0, src.indexOf('} from "../../lib/queries.js"'))
    expect(importBlock.includes("useFetchSelfAvatar")).toBe(false)
  })

  it("★ 而设置页的「从已连接的平台获取」**仍然**用 useFetchSelfAvatar（它就该写账号）", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync(
      "apps/desktop/src/renderer/features/settings/identity-panel.tsx",
      "utf8",
    )
    // 不能因为修串台就把这条也换掉：那个动作的语义就是"设成我的账号头像"
    expect(src).toContain("useFetchSelfAvatar")
  })
})

/**
 * ── ★★ 「刷新头像」必须带**花名** ──────────────────────────────
 *
 * 钉钉没有开放的按 id 取头像接口，只能绕"共同群成员详情里的 avatarMediaId"，
 * 而找共同群靠 `chat search-common --nicks <花名>`。缺花名时渠道层
 * **一次命令都不发**就返回 `not_attempted`。
 *
 * 实测（真应用 CDP）：不传 nick 时钉钉 `failed:1` 且缓存落回
 * `not_attempted`，而飞书同一次 `fetched:1`（它按 open_id 直取、不需要花名）。
 * 表现是"点了刷新毫无变化"—— 而那条 `avatar lookup` 日志是 debug 级，
 * 在 info 的运行环境里看不见。
 *
 * 判据落在**渲染层有没有把 nick 传下去**，因为那才是我漏掉的地方。
 */
describe("接线：刷新头像必须带花名（否则钉钉一次命令都不发）", () => {
  it("★★ hook 把 nick 映射成 nickByExternalId 传给 avatarsFetch", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/renderer/lib/queries.ts", "utf8")
    const start = src.indexOf("export function useRefreshChannelAvatar")
    expect(start).toBeGreaterThan(0)
    const body = src.slice(start, start + 2000)
    /**
     * 反证：把那段 `nickByExternalId` 展开删掉 → 红。
     * 而红之前的状态正是钉钉点刷新没反应。
     */
    expect(body).toContain("nickByExternalId")
    expect(body).toContain("force: true")
  })

  it("★★ 按钮传的是**原始**花名，不是展示用的 channelNick", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync(
      "apps/desktop/src/renderer/features/channels/channel-auth-panel.tsx",
      "utf8",
    )
    const idx = src.indexOf("refreshAvatar.mutate(")
    expect(idx).toBeGreaterThan(0)
    const call = src.slice(idx, idx + 900)
    /**
     * `channelNick` 在"花名与实名相同"时返回 `null`（展示用的过滤）——
     * 拿它当 nick 就等于没传。所以这里断言用的是身份行里的原始值。
     *
     * 反证：把 `nick:` 那行改成 `nick: channelNick` → 红。
     */
    expect(call).toContain("displayNames[0]")
    expect(call.includes("nick: channelNick")).toBe(false)
  })
})
