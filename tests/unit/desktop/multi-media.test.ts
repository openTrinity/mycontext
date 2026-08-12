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
    const media = new MultiMediaService(
      fakeMedia("dingtalk", calls) as never,
      "dingtalk",
      () => mounted.map((channelId) => ({ channelId, media: fakeMedia(channelId, calls) })),
    )
    media.avatarsFromCache(["ou_FAKE01"], "feishu") // 还没挂 → 主渠道
    mounted = ["feishu"]
    media.avatarsFromCache(["ou_FAKE02"], "feishu") // 挂上了 → 飞书
    expect(calls).toEqual(["dingtalk:cache:ou_FAKE01", "feishu:cache:ou_FAKE02"])
  })
})
