/**
 * 媒体下载：把 `media_assets` 里的 mediaId 换成本地文件。
 *
 * ## 为什么是**按需**下载而不是采集时全下
 *
 * 一个活跃群一周几百张图。全下的后果是几百 MB 磁盘 + 几百次子进程，
 * 而其中绝大多数用户永远不会看。所以采集时只记元数据
 * （`media_assets` 早就在这么做），真正下载由**用户点击**触发。
 *
 * ## ★ 一个 join：download-media 要平台 id，而 media 行上只有内部 id
 *
 * `chat message download-media` 需要 `--message-id <openMessageId>` 与
 * `--open-conversation-id <openConversationId>`，而 `media_assets.message_id`
 * 是**我们的**内部 id。所以必须 join 回 `messages.external_id` 与
 * `conversations.external_id` —— 漏了这一步会传一个平台不认识的 id，
 * 而返回的错误是"资源不存在"，看起来像那张图过期了。
 *
 * ## 下载先落临时名再改名
 *
 * 中途失败留下的 0 字节文件会被"已经下过"的判断当成成功 ——
 * 那张图会**永久**显示不出来且不再重试。`rename` 在同目录内是原子的。
 */
import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { basename, extname, join } from "node:path"
import { dialog } from "electron"
import { AppError, type Clock, type Logger } from "@mycontext/kernel"
import type { ChannelAvatarResult, ChannelAvatars, MediaRunner } from "@mycontext/channels"
import {
  ContactAvatarRepository,
  MediaAssetRepository,
  SelfIdentityRepository,
  type MediaAssetRow,
  type SqliteDatabase,
} from "@mycontext/store"

export interface MediaServiceOptions {
  clock: Clock
  logger: Logger
  /** 渠道 CLI。为 null 时下载不可用（未登录 / 无渠道） */
  cli: MediaRunner | null
  /**
   * 渠道的头像能力。为 null 时取头像不可用（未登录 / 该渠道没实现）。
   *
   * 与 `cli` 分开是因为它们是**两种不同的依赖**：媒体下载只需要"能跑命令"
   * （落地路径由我们给），而"怎么才能拿到一个人的头像"是渠道特有的知识
   * （钉钉要经共同群绕三条命令）。改动前这里只有 `cli`，于是本文件
   * 直接 import 了钉钉的 `fetchAvatar` —— 那份知识就漏到了宿主层。
   */
  avatars: ChannelAvatars | null
  channelId: string
}

/**
 * 落地目录 —— **在 attach 时给，不在构造时给**。
 *
 * ## ★★ 为什么必须跟着 vault 走
 *
 * 这三个目录里装的是**聊天内容**：消息里的图片、同事的头像、用户上传的形象。
 * 原来它们是 `<userData>/{media,avatars,uploads}`（应用级），也就是
 * 两个身份的图片混在一个目录里 —— 而 vault 分库的全部意义就是
 * "打开的是哪个文件，能看到的就只有那些数据"。
 *
 * 而且必须在 **attach** 时给：构造时锁死的话，切身份后新下载的图片
 * 仍然落在上一个身份的目录里，且那个错误是静默的（图能显示、库里有行，
 * 只是文件躺在别人的目录下，删那个 vault 时不会被带走）。
 */
export interface MediaDirs {
  /** 消息里的图片/文件 */
  media: string
  /** 联系人头像 */
  avatar: string
  /** 用户上传的图片（数字人形象 / 自己的头像） */
  upload: string
}

/** 一次批量下载最多几个。用户点一张图时通常只要一张，批量是给"预热"用的。 */
const MAX_BATCH = 8

/** 支持内联预览的 MIME 前缀。其余只给"打开文件"。 */
const PREVIEWABLE = ["image/"]

export interface MediaDownloadResult {
  ok: boolean
  path?: string
  /** 失败原因（给 UI 显示，不是给机器判定） */
  detail?: string
}

export class MediaService {
  private db: SqliteDatabase | null = null
  /** 当前 vault 的落地目录。未 attach（未登录）时为 null。 */
  private dirs: MediaDirs | null = null

  constructor(private readonly options: MediaServiceOptions) {}

  attach(db: SqliteDatabase, dirs: MediaDirs): void {
    this.db = db
    this.dirs = dirs
  }

  detach(): void {
    this.db = null
    this.dirs = null
  }

  /**
   * 取当前 vault 的落地目录。
   *
   * ★ 未 attach 时**抛错而不是退回一个应用级目录**：那种兜底会让
   * "忘了 attach" 表现成"图片落在了公共目录"—— 一次静默的跨身份写入。
   * 而抛错会在第一次调用时就暴露接线漏了。
   */
  private requireDirs(): MediaDirs {
    const dirs = this.dirs
    if (dirs === null) throw new AppError("DB_UNAVAILABLE", "尚未登录，媒体目录未就绪")
    return dirs
  }

  /**
   * 下载一个媒体资源。
   *
   * 已经下过就直接返回路径（幂等）—— UI 可以无脑调它。
   */
  async download(mediaId: string): Promise<MediaDownloadResult> {
    const db = this.requireDb()
    const cli = this.options.cli
    if (cli === null) return { ok: false, detail: "渠道未就绪（未登录？）" }

    const media = new MediaAssetRepository(db)
    const row = db
      .prepare<
        [string],
        {
          id: string
          message_id: string
          resource_id: string
          resource_kind: string
          path: string | null
          message_external_id: string | null
          conversation_external_id: string | null
        }
      >(
        /**
         * ★ 这个 join 是必需的：download-media 要**平台**的两个 id，
         * 而 media 行上只有我们的内部 message_id。
         */
        `SELECT a.id, a.message_id, a.resource_id, a.resource_kind, a.path,
                m.external_id AS message_external_id,
                c.external_id AS conversation_external_id
           FROM media_assets a
           JOIN messages m ON m.id = a.message_id
           JOIN conversations c ON c.id = m.conversation_id
          WHERE a.id = ?`,
      )
      .get(mediaId)

    if (row === undefined) return { ok: false, detail: "找不到这个媒体记录" }
    // 已经下过（且文件还在）→ 直接用
    if (row.path !== null && existsSync(row.path) && statSync(row.path).size > 0) {
      return { ok: true, path: row.path }
    }
    if (row.message_external_id === null || row.conversation_external_id === null) {
      return { ok: false, detail: "缺少平台 id（消息或会话没有 external_id）" }
    }

    /**
     * `resource_kind` 决定用哪条命令。
     *
     * `mediaId` → `chat message download-media`；`fileId` → `drive download`
     * （后者还没接 —— 明确报出来而不是用错的命令去试）。
     *
     * ★ `url`：值本身就是可直接访问的链接（实测机器人图文卡片把 URL 塞进了
     * `mediaId=` 位置）。拿它当 mediaId 去换下载地址必然 `RESOURCE_NOT_FOUND`，
     * 所以**不调 CLI**。单列一条消息是因为它与 fileId 的性质不同：
     * fileId 是"还没接"（将来会接），url 是"不需要下载"——
     * 混成同一句会让人去实现一个不存在的需求。
     */
    if (row.resource_kind === "url") {
      return {
        ok: false,
        detail: "这是直链资源（URL 被塞进了 mediaId 位置），不经 CLI 下载",
      }
    }
    if (row.resource_kind !== "mediaId") {
      return { ok: false, detail: `暂不支持下载 ${row.resource_kind} 类型（钉盘文件还没接）` }
    }

    const mediaDir = this.requireDirs().media
    mkdirSync(mediaDir, { recursive: true })
    const name = `${createHash("sha256").update(row.resource_id).digest("hex").slice(0, 32)}`
    const target = join(mediaDir, name)
    const temp = `${target}.part`

    try {
      await cli.run([
        "chat",
        "message",
        "download-media",
        "--type",
        "mediaId",
        "--resource-id",
        row.resource_id,
        "--message-id",
        row.message_external_id,
        "--open-conversation-id",
        row.conversation_external_id,
        "--output",
        temp,
      ])
      if (!existsSync(temp) || statSync(temp).size === 0) {
        rmSync(temp, { force: true })
        return { ok: false, detail: "命令成功但文件是空的" }
      }
      renameSync(temp, target)

      const bytes = statSync(target).size
      const content = readFileSync(target)
      media.markDownloaded(row.id, {
        path: target,
        // 内容哈希：只有下载后才算得出，它也是"同一张图被转发多次"的去重键
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes,
        mime: sniffMime(content),
        at: this.options.clock.now(),
      })
      this.options.logger.info("media downloaded", { id: row.id, bytes })
      return { ok: true, path: target }
    } catch (error) {
      rmSync(temp, { force: true })
      const detail = error instanceof Error ? error.message : String(error)
      this.options.logger.warn("media download failed", { id: row.id, detail })
      return { ok: false, detail }
    }
  }

  /** 预热：把一批还没下的下下来（供"这个会话的图都加载出来"用）。 */
  async prefetch(limit = MAX_BATCH): Promise<{ done: number; failed: number }> {
    const db = this.requireDb()
    const pending = new MediaAssetRepository(db).listPending(Math.min(limit, MAX_BATCH))
    let done = 0
    let failed = 0
    for (const asset of pending) {
      const result = await this.download(asset.id)
      if (result.ok) done += 1
      else failed += 1
    }
    return { done, failed }
  }

  /**
   * 把指定这些消息上挂的媒体都下下来。
   *
   * ## ★ 与 `prefetch` 的区别：**按消息**而不是按"全库还没下的"
   *
   * `prefetch` 拿的是 `listPending`（全库范围、上限 8），它服务的是
   * "后台顺手预热"。而这个方法服务的是**用户正在看的那一屏** ——
   * 打开会话时把这一屏的图立刻拉下来，让图片"直接就在那"而不是
   * 每张都要点一下。范围必须精确到消息，否则会去下别的会话的图。
   *
   * ## ★ 串行而不是并发
   *
   * 每次下载 spawn 一个子进程（实测 0.3-0.8s）。一屏 20 张并发起来
   * 就是 20 个子进程同时跑 —— 会挤占采集与蒸馏的 CPU，而用户只是
   * 打开了一个会话。串行慢一些，但图是**逐张出现**的（每下完一张
   * 渲染层刷新就能看到），观感上并不比并发差。
   *
   * ## ★ 已经在本地的不重下
   *
   * SQL 里就用 `path IS NULL` 过掉了，所以 `skipped` 是"这一屏挂了多少
   * 资源、其中多少本来就齐了"——调用方靠它区分"本来就全在"
   * 与"刚下了 20 张"：前者不需要触发重新渲染。
   */
  async downloadForMessages(
    messageIds: readonly string[],
  ): Promise<{ downloaded: number; failed: number; skipped: number }> {
    const db = this.requireDb()
    if (messageIds.length === 0) return { downloaded: 0, failed: 0, skipped: 0 }

    const placeholders = messageIds.map(() => "?").join(",")
    /**
     * 一次查出「总共几个」与「还没下的是哪些」。
     *
     * `path IS NULL` 在 SQL 里过滤而不是全取回来再判：一屏 20 条消息
     * 可能挂几十个资源，而第二次打开这个会话时绝大多数已经下过 ——
     * 那时 `pending` 是 0 行，整个方法就是两次查询的开销。
     *
     * ★ 同时排除 `resource_kind = 'url'`（与 `listPending` 同一个理由）：
     * 那类值是被塞进 `mediaId=` 位置的直链，拿它当 mediaId 去换下载地址
     * 必然 `RESOURCE_NOT_FOUND`，而表上没有「永久失败」这一列 ——
     * 不排就会每次打开会话都重下一遍（一个子进程 + 两行 WARN，且不可能成功）。
     * `fileId` **不排**：它在下载器里是 spawn 之前提前返回的，不烧子进程。
     * 详见 `MediaAssetRepository.listPending` 的注释。
     */
    const total = db
      .prepare<
        string[],
        { n: number }
      >(`SELECT COUNT(*) AS n FROM media_assets WHERE message_id IN (${placeholders})`)
      .get(...messageIds)
    const pending = db
      .prepare<string[], { id: string }>(
        `SELECT id FROM media_assets
          WHERE message_id IN (${placeholders})
            AND path IS NULL
            AND resource_kind <> 'url'`,
      )
      .all(...messageIds)

    let downloaded = 0
    let failed = 0
    for (const asset of pending) {
      const result = await this.download(asset.id)
      if (result.ok) downloaded += 1
      else failed += 1
    }
    const skipped = (total?.n ?? 0) - pending.length
    this.options.logger.debug("media downloaded for messages", {
      messages: messageIds.length,
      downloaded,
      failed,
      skipped,
    })
    return { downloaded, failed, skipped }
  }

  /**
   * 把一个已下载的媒体「另存为」到用户选的位置。
   *
   * ## ★ 只收 `mediaId`，路径由**我们**查出来
   *
   * 让调用方传源路径等于开一个任意文件读取的口子 —— 渲染层渲染的是
   * 群聊正文（不可信输入），而 `{ path: "~/.ssh/id_rsa" }` 与
   * `{ path: "<media>/x.jpg" }` 在类型上没有区别。
   * 用 mediaId 反查之后，能被导出的集合**结构上**限定在
   * "我们自己下载过的媒体"里。
   *
   * ## 用户取消不是错误
   *
   * `showSaveDialog` 的 `canceled` 是完全正常的路径 —— 返回
   * `{ saved: false }` 而不是抛错。抛错的话渲染层会弹一个"保存失败"，
   * 而用户明明是自己点的取消。
   *
   * ## 没下载过的不能存
   *
   * `path === null` 表示只有元信息、字节还没拉下来。这时候正确的动作是
   * 让用户先点"下载"（UI 上那个按钮），而不是在这里悄悄替他下 ——
   * 下载要调 CLI、可能失败、可能很慢，而他按的是"另存为"。
   */
  async saveAs(mediaId: string): Promise<{ saved: boolean; path: string | null }> {
    const db = this.requireDb()
    const row = new MediaAssetRepository(db).findById(mediaId)
    if (row === null) {
      throw new AppError("IPC_BAD_REQUEST", "媒体不存在", { context: { mediaId } })
    }
    if (row.path === null || !existsSync(row.path)) {
      throw new AppError("IPC_BAD_REQUEST", "这个文件还没下载到本地", { context: { mediaId } })
    }

    /**
     * 默认文件名用平台给的原名，缺失时退回 `<mediaId>.<扩展名>`。
     *
     * ★ `basename` 是必需的：`originalName` 来自渠道（不可信），
     * 一个 `../../../.zshrc` 会让默认路径逃出用户选的目录。
     * 对话框虽然还要用户确认一次，但默认值不该是一个可疑路径。
     */
    const fallback = `${mediaId}${extname(row.path)}`
    const suggested = row.originalName === null ? fallback : basename(row.originalName)

    const result = await dialog.showSaveDialog({
      defaultPath: suggested === "" ? fallback : suggested,
    })
    if (result.canceled || result.filePath === "") return { saved: false, path: null }

    copyFileSync(row.path, result.filePath)
    this.options.logger.info("media saved as", { id: row.id })
    return { saved: true, path: result.filePath }
  }

  /**
   * 一批人的头像 —— **只读缓存，绝不起子进程**。
   *
   * ## ★ 为什么读与取必须是两个方法
   *
   * 合成一个的后果实测过：`media/avatars` 那个 IPC 把 60 个人放在同一个
   * `attempt()` 里串行跑，而其中任何一个抛错（CLI exit≠0 / 30s 超时）
   * 都会让整个 IPC 返回 failure → 渲染层 `data` 变 `undefined` →
   * **这一屏所有头像一起退回首字母**，包括那些只需要读一行 SQL 就能
   * 返回的人。实测库里 154 个人已缓存，却因为第三个人的一次超时全屏兜底。
   *
   * 拆开之后这个方法的失败面只有 SQLite 本身：没有子进程、没有网络、
   * 没有 30s 超时。「以前取到过的头像」于是变成**必然显示**的。
   *
   * `listByExternalIds` 一次查完（那个方法本来就在仓储里，之前没人调用 ——
   * IPC 逐个 `avatar()` 等于 60 次 prepare/step 同步阻塞主进程）。
   *
   * ★ 顺带返回 `needsFetch`：调用方据此知道「还有谁值得去取」，
   * 而这个判断需要 miss 原因与退避窗口（终态不该重试）——
   * 那是仓储的知识，不该让渲染层复制一份。
   */
  avatarsFromCache(externalIds: readonly string[]): {
    externalId: string
    path: string | null
    missReason: string | null
    needsFetch: boolean
  }[] {
    const db = this.requireDb()
    const avatars = new ContactAvatarRepository(db)
    const now = this.options.clock.now()
    const rows = avatars.listByExternalIds(this.options.channelId, externalIds)
    const byId = new Map(rows.map((row) => [row.externalId, row]))

    return externalIds.map((externalId) => {
      const row = byId.get(externalId)
      /**
       * 文件被手删（或换了机器同步了库没同步文件）→ 当成没取过。
       *
       * 不判这个的话会返回一个指向不存在文件的 URL，而 `<img>` 的失败是
       * 静默的（回退首字母），于是那个人永久没有头像且**不会重试** ——
       * 缓存行还在，`needsFetch` 看到 `localPath !== null` 就说不用取。
       */
      const hasFile = row?.localPath !== null && row?.localPath !== undefined
      const fileOk = hasFile && existsSync(row.localPath as string)
      if (fileOk) {
        return {
          externalId,
          path: row?.localPath ?? null,
          missReason: null,
          needsFetch: false,
        }
      }
      return {
        externalId,
        path: null,
        missReason: row?.missReason ?? null,
        // 文件没了 → 无论缓存怎么说都该重取
        needsFetch: hasFile ? true : avatars.needsFetch(this.options.channelId, externalId, now),
      }
    })
  }

  /**
   * 取一个人的头像（有缓存就用缓存）。
   *
   * ★ 三种"取不到"分开记（见 `contact-avatars.ts`）：前两种是终态，
   * 不记的话每次打开页面都会对那几十个"本来就没头像"的人各重试一遍。
   *
   * ## ★ 渠道抛错在**这一层**收敛成 `failed`，不往外抛
   *
   * `ofUser()` 会抛（`DwsCli.run` 在 exit≠0 时抛 `PROCESS_FAILED`，
   * 30s 超时也抛）。让它穿透出去的后果见 `avatarsFromCache` 的注释：
   * 一个人的抖动带走整批。而这里 catch 之后记一条 `failed`
   * （**可重试**、带 6 小时退避），语义是准确的 —— 命令确实失败了，
   * 而且确实值得过一会儿再试。
   */
  async avatar(input: {
    externalId: string
    nick?: string | null
    groupExternalId?: string | null
    /**
     * 跳过缓存，强制重取。
     *
     * ## ★ 只给「用户显式点了刷新」用，批量循环绝不传
     *
     * 缓存命中的判据是"有 local_path 且文件在"，而那张图**永不过期**
     * （`needsFetch` 对已取到的行直接返回 false）。于是用户在钉钉换了头像后，
     * 应用里那张旧图会一直显示下去，点多少次「从渠道获取」都不变 ——
     * 因为那个按钮走的也是这条缓存命中的路。
     *
     * 不改成"缓存带 TTL"：那会让批量取头像（几十人，每人 2-3 次子进程调用）
     * 周期性地全量重跑一遍，代价与收益完全不成比例。而"我换了头像想看到"
     * 是个**用户知道自己在做什么**的时刻，让他显式触发最省。
     */
    force?: boolean | undefined
  }): Promise<{ path: string | null; reason: string | null }> {
    const db = this.requireDb()
    const channelAvatars = this.options.avatars
    const avatars = new ContactAvatarRepository(db)
    const now = this.options.clock.now()

    /**
     * ★ 记在**所有提前返回之前**。
     *
     * 取头像有四种"什么都没做"的出口（缓存命中 / 终态 miss / 没有渠道能力 /
     * 缺花名），而它们的返回值互相之间、以及与"真的没设头像"**都长得一样**。
     * 日志放在最前面才能区分"走到哪一步停了"。
     *
     * 这一条是排查时补的：当时 `no_common_group` 与手动跑通的结果矛盾，
     * 而放在取头像调用之前的日志一次都没打出来 —— 那本身就是线索
     * （说明停在更早的地方）。
     */
    this.options.logger.debug("avatar lookup", {
      externalId: input.externalId.slice(0, 8),
      channelId: this.options.channelId,
      hasNick: input.nick !== undefined && input.nick !== null && input.nick !== "",
      hasGroup: input.groupExternalId !== undefined && input.groupExternalId !== null,
      hasAvatars: channelAvatars !== null,
      force: input.force === true,
    })

    // ★ force 时整段缓存判定跳过 —— 包括"终态 miss"那一支：用户以前没设头像、
    //   现在设了，正是他会来点这个按钮的场景，而 not_set 本来是永不重试的。
    if (input.force !== true) {
      const cached = avatars.get(this.options.channelId, input.externalId)
      if (cached?.localPath !== null && cached?.localPath !== undefined) {
        if (existsSync(cached.localPath)) return { path: cached.localPath, reason: null }
        // 文件被手删了 → 当成没取过，下面重新取
      } else if (!avatars.needsFetch(this.options.channelId, input.externalId, now)) {
        return { path: null, reason: cached?.missReason ?? null }
      }
    }
    if (channelAvatars === null) return { path: null, reason: null }

    /**
     * 可选字段 null 与 undefined 同等对待（都折成"不传"）。
     *
     * 调用方显式传 null 的语义是"这不是群聊，没有已知共同群"，
     * 与"没传"是同一件事。两个可选参数用同一套判据，
     * 读的人才不用逐个确认 —— 契约那侧也是这么判的。
     */
    const request = {
      externalId: input.externalId,
      ...(input.nick === undefined || input.nick === null ? {} : { displayName: input.nick }),
      ...(input.groupExternalId === undefined || input.groupExternalId === null
        ? {}
        : { viaConversationExternalId: input.groupExternalId }),
      outputDir: this.requireDirs().avatar,
    }

    /**
     * ★ 抛错在这里收敛，不往上传播。
     *
     * `ofUser()` 内部每人要 2-3 次子进程调用，任何一次 exit≠0 或超时
     * 都会抛。而这个方法的调用方是一个**批量循环**，异常穿透等于
     * 「第三个人超时 → 前两个和后面五十七个一起消失」。
     *
     * 记成 `failed` 而不是终态：命令失败是**暂时**的（DWS 限流、
     * 网络抖动），6 小时后自然重试（`AVATAR_RETRY_AFTER_MS`）。
     * 记成终态会让一次抖动永久钉死一个人的头像。
     */
    let result: ChannelAvatarResult
    try {
      result = await channelAvatars.ofUser(request)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.options.logger.warn("avatar fetch threw", {
        externalId: input.externalId.slice(0, 8),
        detail,
      })
      avatars.recordMiss({
        channelId: this.options.channelId,
        externalId: input.externalId,
        reason: "failed",
        at: now,
      })
      return { path: null, reason: "failed" }
    }
    this.options.logger.debug("avatar fetched", {
      externalId: input.externalId.slice(0, 8),
      ok: result.ok,
      reason: result.ok ? null : result.reason,
    })

    if (result.ok) {
      avatars.recordHit({
        channelId: this.options.channelId,
        externalId: input.externalId,
        localPath: result.path,
        /**
         * 契约叫 `cacheKey`，仓储这一列叫 `media_id` —— 存的是同一个东西
         * （渠道侧的内容标识，钉钉给的是 avatarMediaId）。
         *
         * 不把列改名是因为那要一次迁移，而收益只是个名字；
         * 而契约不叫 `mediaId` 是因为"mediaId"是钉钉的词，
         * 别的渠道可能给的是 URL 或 etag。翻译就发生在这一行。
         */
        mediaId: result.cacheKey,
        at: now,
      })
      return { path: result.path, reason: null }
    }
    avatars.recordMiss({
      channelId: this.options.channelId,
      externalId: input.externalId,
      reason: result.reason,
      at: now,
    })
    return { path: null, reason: result.reason }
  }

  /**
   * 取**本人**的头像。
   *
   * ## ★ 为什么本人的头像也要走"共同群"这条路
   *
   * `contact user get-self` 与 `contact user search` 的 Returns 里
   * **都没有头像字段**（逐条查过 `contact.md`）。也就是说没有"查我自己的
   * 头像"这个接口 —— 唯一的路径仍然是「群成员详情里的 avatarMediaId」。
   *
   * 好在本人**必然在自己所在的每个群里**，所以 `search-common` 一定找得到
   * 共同群（这一点比同事的情况更稳：同事可能与你没有共同群）。
   *
   * ## 与用户手动设的头像的关系
   *
   * 这个方法只负责**取到并缓存**，不负责决定"显示哪个"。
   * 优先级由调用方按 `avatarSource` 判（`manual` 优先）——
   * 用户显式上传过的图不该被渠道回填覆盖。
   */
  async selfAvatar(
    options: { force?: boolean | undefined } = {},
  ): Promise<{ path: string | null; reason: string | null }> {
    const db = this.requireDb()
    const identity = new SelfIdentityRepository(db).get(this.options.channelId)
    if (identity === null) return { path: null, reason: "identity_unresolved" }

    /**
     * 取 `openDingTalkId` 那一个 —— `avatarMediaId` 是按它查的。
     * `userId` 查不到头像（那是另一套标识体系）。
     */
    const openId = identity.openIds.find((entry) => entry.kind === "openDingTalkId")?.value
    if (openId === undefined || openId === "") return { path: null, reason: "no_open_id" }

    return this.avatar({
      externalId: openId,
      // 花名用于 search-common 找共同群
      nick: identity.displayNames[0] ?? null,
      ...(options.force === undefined ? {} : { force: options.force }),
    })
  }

  /**
   * 存一张用户上传的图片。
   *
   * ## ★ 三件必须做的校验
   *
   * 1. **按魔术字节判类型**，不信调用方说的 —— 渲染层可能被注入，
   *    而一个伪装成图片的可执行文件落进 userData 是个真问题；
   * 2. **落在固定目录下的固定命名**（内容 sha256 + 扩展名）——
   *    不接受调用方给的文件名，那是路径穿越的入口（`../../`）；
   * 3. 内容哈希做名字 = **天然去重**：同一张图上传两次只有一个文件。
   *
   * 不删旧文件：一张头像可能还被别处引用（比如历史草稿里的形象快照）。
   * 孤儿文件由后续的清理任务处理 —— 而"清理"要有人显式设计，
   * 顺手删掉是丢数据的常见来源。
   *
   * ## ★ 那个"后续的清理任务"**还不存在**（这行注释曾经在撒谎）
   *
   * 本文件里没有任何 `unlink` / `readdir`，别处也没有清理器 ——
   * grep 确认过。所以每换一张图就永久留下一个文件，上限是
   * 单张 4MB（`base64` 那个 schema 的上限）×换图次数。
   *
   * 内容哈希做名字让**重复上传同一张**不占额外空间（那是真的去重），
   * 但换 N 张不同的图就是 N 个文件。
   *
   * 这件事被设置页的形象块**实质放大了**：改动前换形象只能重走引导
   * （一次性动作），现在它是一个"今天想换个发型"就会用的常驻入口。
   * 泄漏速率因此从"每个用户一两次"变成"想换就换"。
   *
   * 不在这次改动里做回收，理由是它需要**引用计数**才安全：
   * `figureImagePath` 存在 `onboarding_progress.payload` 的 JSON 里，
   * 而将来的草稿快照/导出也可能引用同一个路径 —— 按"当前 payload 里
   * 没提到就删"会删掉仍被引用的文件，而那是不可逆的。
   * 一个正确的清理器要先有"谁引用了它"的清单，那是独立的一件事。
   */
  saveUploadedImage(input: { base64: string; purpose: "figure" | "avatar" }): {
    path: string
    bytes: number
    mime: string
  } {
    let bytes: Buffer
    try {
      bytes = Buffer.from(input.base64, "base64")
    } catch {
      throw new AppError("IPC_BAD_REQUEST", "图片数据不是合法的 base64")
    }
    if (bytes.length === 0) throw new AppError("IPC_BAD_REQUEST", "图片是空的")

    /**
     * ★ 按魔术字节判类型。
     *
     * 不信扩展名也不信调用方传的 mime：那两个都是**声明**而不是事实。
     * 认不出来就拒 —— 宁可不支持一种冷门格式，也不把一个未知字节流
     * 当图片存进 userData。
     */
    const mime = sniffMime(bytes)
    if (mime === null || !mime.startsWith("image/")) {
      throw new AppError("IPC_BAD_REQUEST", "只支持 PNG / JPEG / GIF / WEBP 图片")
    }

    const dir = join(this.requireDirs().upload, input.purpose)
    mkdirSync(dir, { recursive: true })
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32)
    const target = join(dir, `${hash}.${extensionFor(mime)}`)
    // 已经有同样内容的文件 → 直接复用（内容哈希做名字的好处）
    if (!existsSync(target)) writeFileSync(target, bytes)
    this.options.logger.info("image uploaded", {
      purpose: input.purpose,
      bytes: bytes.length,
      mime,
    })
    return { path: target, bytes: bytes.length, mime }
  }

  private requireDb(): SqliteDatabase {
    if (this.db === null) throw new AppError("DB_UNAVAILABLE", "尚未登录")
    return this.db
  }
}

/** MIME → 扩展名。只覆盖 `sniffMime` 认得的那几种。 */
function extensionFor(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png"
    case "image/jpeg":
      return "jpg"
    case "image/gif":
      return "gif"
    case "image/webp":
      return "webp"
    default:
      return "bin"
  }
}

/** 这个 MIME 能不能内联预览。 */
export function isPreviewable(mime: string | null): boolean {
  if (mime === null) return false
  return PREVIEWABLE.some((prefix) => mime.startsWith(prefix))
}

/**
 * 按魔术字节猜 MIME。
 *
 * ★ 为什么不信扩展名：`download-media` 的 `--output` 是**我们**给的名字
 * （sha256，没有扩展名），而命令本身不告诉我们类型。魔术字节是
 * 这里唯一可靠的信息源。
 *
 * 只认三种图片格式 + PDF —— 其余返回 null，UI 就只给"打开文件"
 * 而不尝试内联渲染（渲染一个不认识的字节流会得到一个碎图标）。
 */
export function sniffMime(bytes: Buffer): string | null {
  if (bytes.length < 12) return null
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png"
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  // GIF: "GIF8"
  if (bytes.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif"
  // WEBP: "RIFF" + "WEBP" at offset 8
  if (
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp"
  }
  // PDF: "%PDF"
  if (bytes.subarray(0, 4).toString("latin1") === "%PDF") return "application/pdf"
  return null
}

export type { MediaAssetRow }
