/**
 * 按渠道路由的媒体/头像聚合器。
 *
 * ## ★★ 为什么需要它（用户报的"飞书头像没获取"的真根因）
 *
 * `MediaService` 原来全应用**只有一个**，装配时三个参数全写死主渠道：
 *
 * ```ts
 * cli: dingtalk.mediaRunner ?? null,
 * avatars: dingtalk.avatars ?? null,   // ← 飞书的实现从没被接进来
 * channelId: dingtalk.meta.id,        // ← 于是永远按钉钉查/写
 * ```
 *
 * 两层静默后果：
 * ① 飞书的 `createFeishuAvatars` 写好了却零调用点 → 永远退化成首字母兜底，
 *    看起来像"这个人没设头像"；
 * ② `avatarsFromCache`/`selfAvatar` 都按 `options.channelId` 过滤，
 *    即使有飞书头像也因为键对不上而查不到。
 *
 * 头像的**取法**本来就按渠道不同（钉钉走共同群搜索、飞书走
 * `contact +get-user` 的直链字段），这正是插件能力契约存在的理由。
 *
 * ## ★ 与 `MultiGraphQueryService` / `MultiKlServerService` 同一个形状
 *
 * 那两个已经是对的范式（主渠道 + `getSources()` 函数 + 按 id 路由），
 * 这里照抄，不发明第二套。**函数而非数组**：非主渠道的实例由
 * `ChannelPipelineManager` 在登录后才现造，传数组会永远拿到空的。
 *
 * ## ★ 找不到那个渠道时落回主渠道，而不是抛
 *
 * 这与 `ChannelRuntimeRegistry.require()` 的"拿不到就抛"**故意不同**：
 * 那条不变式针对的是**写**与**删**（写错库、删错渠道的图无法挽回）。
 * 而头像是纯读、且失败的代价是"显示首字母兜底" —— 为它抛一个错会让
 * 整屏头像在渠道刚挂载的那几百毫秒里一起变成错误态。
 * 落回主渠道最坏是"某个人的头像没显示"，而那与缓存未命中不可区分，
 * 本来就是这个功能的正常状态之一。
 */
import type { MediaService } from "./media.service.js"

/** 只取我们真正按渠道路由的那几个方法 —— 不是整个 MediaService 的镜像。 */
type AvatarSurface = Pick<MediaService, "avatarsFromCache" | "avatar" | "selfAvatar">

export class MultiMediaService {
  constructor(
    private readonly primary: MediaService,
    private readonly primaryChannelId: string,
    private readonly getSources: () => readonly { channelId: string; media: AvatarSurface }[],
  ) {}

  /**
   * 解析出该用哪个渠道的 media。
   *
   * `channelId` 不给 / 就是主渠道 / 没挂上 → 主渠道（存量行为）。
   */
  private pick(channelId?: string): AvatarSurface {
    if (channelId === undefined || channelId === this.primaryChannelId) return this.primary
    return this.getSources().find((item) => item.channelId === channelId)?.media ?? this.primary
  }

  avatarsFromCache(
    externalIds: readonly string[],
    channelId?: string,
  ): ReturnType<MediaService["avatarsFromCache"]> {
    return this.pick(channelId).avatarsFromCache(externalIds)
  }

  /** 取一个人的头像（真去调渠道 CLI）。名字就叫 `avatar` —— 与被代理的方法同名。 */
  avatar(
    input: Parameters<MediaService["avatar"]>[0],
    channelId?: string,
  ): ReturnType<MediaService["avatar"]> {
    return this.pick(channelId).avatar(input)
  }

  /** 取**本人**头像。`selfAvatar` 内部按 channelId 读身份行，所以必须路由对。 */
  selfAvatar(
    options: Parameters<MediaService["selfAvatar"]>[0] = {},
    channelId?: string,
  ): ReturnType<MediaService["selfAvatar"]> {
    return this.pick(channelId).selfAvatar(options)
  }
}
