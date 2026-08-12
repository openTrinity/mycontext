/**
 * 飞书头像获取。**对人（`ofUser`），也对本人** —— 单聊对象、群成员、本人
 * 都走这一个入口，与钉钉的 `avatars` 契约一致。
 *
 * ## 与钉钉的实现差在哪（渠道不同，路径不同）
 *
 * 钉钉没有开放的用户头像接口，只能绕"共同群成员详情里的 avatarMediaId"、
 * 再用一条打包命令换签名 URL 下载（见 `dingtalk/avatar.ts` 文件头）。
 * 飞书**有正经的按 id 取人接口**：`contact +get-user --user-id <open_id>`
 * 直接返回**平铺的一组 HTTPS URL**（`avatar_middle` 等，见 `pickAvatarUrl`
 * 里记的实测形状）。所以飞书这条简单得多：一次命令拿 URL → `fetch` 下载
 * 落地，没有 mediaId、没有绕群。
 *
 * ## ★ 安全边界（CLAUDE.md §5）
 *
 * · 用的是 `contact +get-user`（**按已知 open_id 取**，`Risk: read`），
 *   **不是** `+search-user`（按姓名/关键词反查人）—— 后者是更大的读取面，
 *   刻意不进白名单。我们只对**已经在聊天里见过的人**（open_id 已随消息采到）
 *   取头像，读取面没有扩大。
 * · **scope 不用加**：实测当前已有的 `contact:user.base:readonly` 就能拿到
 *   这四个头像 URL（用本人跑通）。所以**不引入** `basic_profile`——
 *   `parse.ts` 里"刻意只要 base、不要 basic_profile"那条收窄仍然成立。
 *   （首版注释曾写"需要 basic_profile"，那是没实测的推断，已被证伪。）
 *
 * ## ★ 落地文件名用 URL 的 hash，不含姓名
 *
 * 与钉钉同一个理由：姓名是 PII，不该出现在路径里；换了头像 URL 会变 →
 * 新文件，旧的自然失效（不用做缓存失效逻辑）。`cacheKey` 用 URL 本身
 * （宿主据此判断"换头像了要重下"）。
 *
 * ## ★ 三种「取不到」分开报（与契约的 ChannelAvatarMiss 对齐）
 *
 * · 缺 `externalId`（open_id）→ `not_attempted`（**可重试**，id 可能还没采到）；
 * · 命令成功但 `avatar` 为空 → `not_set`（对方没设头像，终态，飞书自己也显示文字头像）；
 * · 命令失败 / 下载失败 → `failed`（**可重试**）。
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ChannelAvatarRequest, ChannelAvatarResult, ChannelAvatars } from "../../types.js"
import type { LarkCli } from "./cli.js"

/**
 * 从 `contact +get-user` 的响应里挑一个可用的头像 URL。
 *
 * ## ★★ 字段形状是**实测**出来的，不是照文档猜的
 *
 * 实测（`contact +get-user --as user --format json`，本人）：信封是
 * `{ok, identity, data}`，人在 **`data.user`**，而头像是**四个平铺字段**
 * （都是 https URL，长度 181-183）：
 *
 * ```
 * data.user.avatar_big / avatar_middle / avatar_thumb / avatar_url
 * ```
 *
 * **没有** `avatar` 这个嵌套对象、**也没有** `avatar_240 / avatar_origin`
 * 这类开放平台文档式的键名。首版按"嵌套 avatar + avatar_240"写，实测下
 * `pickAvatarUrl` 会**恒返回 null** → 每个人都被误判成「没设头像」
 * （`not_set` 是终态、不重试），而命令其实成功了 —— 这正是本仓库最贵的
 * 那类静默降级（CLAUDE.md §4）。所以这里按实测的键名取。
 *
 * 取 `avatar_middle`（中等尺寸，够头像用又不浪费带宽），依次退到
 * `avatar_big` / `avatar_url` / `avatar_thumb`。
 *
 * ★ 同时兼容"已拆过信封"的形状：`LarkCli.json` 若把 `data` 拆掉，
 * 这里从顶层/`user` 也能找到，所以三种层级都试一遍（成本是几次属性读，
 * 换来的是上游改信封时不会静默变成"所有人都没头像"）。
 */
function pickAvatarUrl(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null
  const root = payload as Record<string, unknown>
  const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null

  // 实测层级是 data.user；另外两种是"信封已被拆掉"的可能形状。
  const candidates = [
    asRecord(asRecord(root["data"])?.["user"]),
    asRecord(root["user"]),
    root,
  ].filter((c): c is Record<string, unknown> => c !== null)

  for (const user of candidates) {
    /**
     * ★★★ **两种形状都要认** —— 取本人与按 id 取别人的响应不一样。
     *
     * ## 实测（同一台机、同一个 CLI 版本，2026-08）
     *
     * | 调用                                  | 身份 | avatar 形状                       |
     * |---------------------------------------|------|-----------------------------------|
     * | `+get-user`（省略 --user-id，取本人） | user | **平铺** `avatar_middle/big/…`    |
     * | `+get-user --user-id <open_id>`       | bot  | **嵌套** `avatar.avatar_240/640/…`|
     *
     * 而按 id + **user** 身份（这个文件原来的写法）只返回三个字段
     * （`name` / `i18n_name` / `user_id`）—— **一个 avatar 都没有**。
     *
     * ## 这个坑我踩了两次，方向相反
     *
     * · 首版按嵌套 `avatar.avatar_240` 写（照开放平台文档），被"实测本人"
     *   证伪，于是改成只认平铺；
     * · 而线上跑的是**按 id 取**那条路，于是 `pickAvatarUrl` 恒返回 null →
     *   每个人都落 `not_set`（**终态、不重试**）→ 头像永远是首字母兜底，
     *   `contact_avatars` 表里全是 miss。用户报的"头像还是没显示"就是它。
     *
     * 教训：**"实测过"要看实测的是不是线上真正走的那条调用**。
     * 我两次实测都是真的，但都只覆盖了一半的调用形态。
     * 所以这里不再二选一，两种形状按优先级依次试。
     */
    // ① 平铺（本人那条路）：middle 够用、big 更清晰、url/thumb 兜底
    for (const key of ["avatar_middle", "avatar_big", "avatar_url", "avatar_thumb"]) {
      const url = user[key]
      if (typeof url === "string" && url.startsWith("https://")) return url
    }
    // ② 嵌套（按 id + bot 那条路）：240 够头像用，依次退到更大/原图/小图
    const avatar = asRecord(user["avatar"])
    if (avatar !== null) {
      for (const key of ["avatar_240", "avatar_640", "avatar_origin", "avatar_72"]) {
        const url = avatar[key]
        if (typeof url === "string" && url.startsWith("https://")) return url
      }
    }
  }
  return null
}

export function createFeishuAvatars(cli: Pick<LarkCli, "json">): ChannelAvatars {
  return {
    async ofUser(request: ChannelAvatarRequest): Promise<ChannelAvatarResult> {
      const openId = request.externalId
      // open_id 还没采到 → 一次命令都不发，记可重试（id 后来会有）
      if (openId === "") return { ok: false, reason: "not_attempted" }

      let url: string | null
      try {
        const payload = await cli.json<unknown>(
          [
            "contact",
            "+get-user",
            "--user-id",
            openId,
            "--user-id-type",
            "open_id",
            /**
             * ★★ 按 id 取**必须用 bot 身份**。
             *
             * CLI 自己的 help 原文："Self lookup (omit --user-id) needs user
             * identity; **a bot must pass --user-id**" —— 两条路各自的身份要求
             * 是对偶的。实测：按 id + user 身份只返回
             * `name`/`i18n_name`/`user_id` 三个字段（**零 avatar**），
             * 而 bot 身份返回 22 个字段含嵌套 `avatar` 对象。
             *
             * ★ 这**不是**扩大读取面：仍然是"按已经在聊天里见过的 open_id
             * 取一个人"，没有反查、没有枚举。换的只是这条命令要求的凭据类型
             * （应用凭据 vs 用户凭据）。
             */
            "--as",
            "bot",
            "--format",
            "json",
          ],
          request.signal === undefined ? {} : { signal: request.signal },
        )
        url = pickAvatarUrl(payload)
      } catch (error) {
        return {
          ok: false,
          reason: "failed",
          detail: error instanceof Error ? error.message : String(error),
        }
      }

      // 命令成功但没有头像 URL → 对方没设头像（终态，飞书自己也显示文字头像）
      if (url === null) return { ok: false, reason: "not_set" }

      // URL 的 hash 做文件名（不含姓名；换头像 URL 变 → 新文件）
      mkdirSync(request.outputDir, { recursive: true })
      const name = `${createHash("sha256").update(url).digest("hex").slice(0, 32)}.jpg`
      const target = join(request.outputDir, name)
      // 已经下过就直接用：URL 变了文件名也会变，所以命中即有效
      if (existsSync(target) && statSync(target).size > 0) {
        return { ok: true, path: target, cacheKey: url }
      }

      // 先下到临时名再原子改名 —— 中途失败不会留下 0 字节文件被当成"已下过"
      const temp = `${target}.part`
      try {
        const res = await fetch(url, request.signal === undefined ? {} : { signal: request.signal })
        if (!res.ok) {
          return { ok: false, reason: "failed", detail: `HTTP ${String(res.status)}` }
        }
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.byteLength === 0) {
          return { ok: false, reason: "failed", detail: "空响应体" }
        }
        writeFileSync(temp, buf)
        renameSync(temp, target)
        return { ok: true, path: target, cacheKey: url }
      } catch (error) {
        rmSync(temp, { force: true })
        return {
          ok: false,
          reason: "failed",
          detail: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }
}
