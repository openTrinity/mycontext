/**
 * 头像获取。**只对人，不对群。**
 *
 * ## 为什么这么绕：钉钉没有开放的用户头像接口
 *
 * 实测（也见随包脚本 `dws_avatar.py` 的 README）：
 * · `contact user get` **不返回**头像字段；
 * · `dws api`（raw OpenAPI，可以直接调 `/topapi/v2/user/get` 拿头像）
 *   需要**自有应用 AppKey/AppSecret**，当前 MCP 默认凭证登录不支持。
 *
 * 唯一可行的路径是「**共同群**的成员详情里有 `avatarMediaId`」：
 *
 * ```
 * contact user search --query <姓名>        → openDingTalkId
 * chat search-common --nicks <花名>          → 共同群的 openConversationId
 * chat group members list-by-ids --id <群> --users <odid>  → avatarMediaId
 * chat message download-media --type mediaId --resource-id <mediaId>
 *   --message-id 0 --open-conversation-id <群> --output <文件>
 * ```
 *
 * `--message-id 0` 是脚本里验过的一个"绕过校验"的取值 —— 头像不属于
 * 任何一条消息，但那个参数是必填的。
 *
 * ## ★ mediaId 不是 URL，所以唯一产物是**本地文件**
 *
 * 直接拼 `https://down.dingtalk.com/media/<id>` 会 404 —— mediaId 必须先经
 * 服务端鉴权换成带签名的临时 URL，而 dws 把"换 URL"与"下载"打包在一个
 * 命令里，中间那个签名 URL **不外露**（`--verbose` 也不打印）且会过期。
 * 因此没有"只拿 URL 不落地"的用法。
 *
 * ## ★ 三种「取不到」是**不同的事**，必须分开报
 *
 * · `no_common_group` —— 与这个人没有共同群。**正常**，退回文字头像；
 * · `no_avatar_set` —— 他自己没设头像（钉钉也显示文字头像）。**正常**；
 * · `download_failed` —— 换 URL 或下载失败。**这个才值得重试**。
 *
 * 合成一个 "失败" 的后果：每次打开页面都会对那些"本来就没有头像"的人
 * 重试一遍，几十个人就是几十次 CLI 调用，而结果永远一样。
 *
 * ★ 但**分错**同样有害：实测 21 个人被报成 `no_common_group`，
 * 而他们其实有 7-9 个共同群、只是没设头像
 * （`members=[{nick:"小马", avatarMediaId:null}]` —— 成员行**在**，
 * 那个字段是 null）。「没有共同群」会让用户以为该去拉个群，
 * 而拉了也没用。判据见 `mediaIdFromGroup` 的三态返回值。
 *
 * ## 群头像取不到
 *
 * `conversation-info` 不返回群头像，也没有"群 avatarMediaId"这种字段。
 * 调用方对群直接用首字母色块兜底（那也是钉钉自己在没设群头像时的做法）。
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import type {
  ChannelAvatarMiss,
  ChannelAvatarRequest,
  ChannelAvatarResult,
  ChannelAvatars,
  MediaRunner,
} from "../../types.js"

/**
 * 取不到头像的原因。
 *
 * `no_common_group` / `no_avatar_set` 是**终态**（重试没有意义），
 * `download_failed` / `lookup_skipped` 可以重试 —— 调用方据此决定要不要再问一次。
 *
 * ## ★ `lookup_skipped`：「我们压根没去找」不能算终态
 *
 * `search-common` 只能按花名搜，所以缺花名时这个函数**一次命令都不调**。
 * 那时的诚实答案是"没查"，而不是"没有共同群" ——
 * 后者是一个**终态**，会让 `needsFetch` 从此不再重试。
 *
 * 而缺花名往往是**暂时**的：会话标题还没采到、或那个人的消息还没落库
 * （左栏的花名来自会话标题，消息流的来自 `sender_display_name`）。
 * 把它记成终态的后果是：花名后来有了，头像却永久不再取。
 */
export type AvatarMissReason =
  | "no_common_group"
  | "no_avatar_set"
  | "download_failed"
  | "lookup_skipped"

export type AvatarResult =
  | { ok: true; path: string; mediaId: string; groupExternalId: string }
  | { ok: false; reason: AvatarMissReason; detail?: string }

export interface AvatarLookupInput {
  /** 目标的 openDingTalkId（消息里的 sender_external_id 就是它） */
  openDingTalkId: string
  /** 姓名或花名：用来搜共同群。没有就只能靠 `groupExternalId` */
  nick?: string | null
  /**
   * 已知的共同群。传了就跳过搜索 —— **快得多也稳得多**。
   *
   * 调用方通常知道这个：我们是从某个会话的消息里看到这个人的，
   * 那个会话如果是群，它本身就是一个共同群。
   */
  groupExternalId?: string | null
  /** 头像落地目录（调用方给，通常是 `<userData>/avatars`） */
  outputDir: string
  signal?: AbortSignal
}

/** 搜共同群时最多翻几页。20/页 × 3 页够覆盖"这个人在我哪个群里"。 */
const MAX_COMMON_GROUP_PAGES = 3

interface MemberPayload {
  avatarMediaId?: unknown
  avatar_media_id?: unknown
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
}

/**
 * 从一个群里取某人的 avatarMediaId。
 *
 * ★ 三种结果必须分开，**不能都返回 null**：
 * · `{ inGroup: true, mediaId: "@lQ…" }`  —— 拿到了；
 * · `{ inGroup: true, mediaId: null }`    —— 他在这个群里，但**没设头像**
 *   （实测形态：`members=[{nick:"小马", avatarMediaId:null}]`，
 *   即成员行**存在**而那个字段是 null）；
 * · `{ inGroup: false }`                  —— 他不在这个群里（`members: []`）。
 *
 * 合成一个 null 的后果见 `findViaCommonGroups`：那会把"没设头像"
 * 误报成"没有共同群"。
 */
interface GroupMemberAvatar {
  inGroup: boolean
  mediaId: string | null
}

async function mediaIdFromGroup(
  cli: Pick<MediaRunner, "json">,
  groupExternalId: string,
  openDingTalkId: string,
  signal?: AbortSignal,
): Promise<GroupMemberAvatar> {
  const payload = await cli.json<unknown>(
    ["chat", "group", "members", "list-by-ids", "--id", groupExternalId, "--users", openDingTalkId],
    signal === undefined ? {} : { signal },
  )
  const record = asRecord(payload)
  // 形状实测是 `{ members: [...] }`；剥信封之后 result 就是这个对象
  const members = record === null ? null : record["members"]
  if (!Array.isArray(members) || members.length === 0) return { inGroup: false, mediaId: null }
  const first = asRecord(members[0]) as MemberPayload | null
  if (first === null) return { inGroup: false, mediaId: null }
  return { inGroup: true, mediaId: str(first.avatarMediaId) ?? str(first.avatar_media_id) }
}

/**
 * 搜共同群，逐个试到拿到 mediaId。
 *
 * ## ★ 返回值要能区分「没有共同群」与「有群但他没设头像」
 *
 * 实测踩到（真实数据，21 个人被记成 `no_common_group`）：
 * 「小马」有 7 个共同群，成员详情里 `members=1` 而
 * `avatarMediaId=null` —— 也就是他**在群里**但**没设头像**。
 * 而首版这个函数对两种情况都返回 null，调用方于是一律报
 * `no_common_group`。
 *
 * 那个错误标签不只是难看，它**指向错误的排查方向**：
 * 用户看到"没有共同群"会去拉群，而真相是对方没设头像 —— 拉了也没用。
 *
 * ## ★ 确认"在群里但没头像"之后**立刻停**
 *
 * 头像是**人身上**的属性，不是"人在这个群里"的属性：同一个人在
 * 7 个群里的 `avatarMediaId` 必然相同（实测小吴在 3 个群里返回同一个
 * mediaId）。所以一旦在任一群里看到他而那个字段是空，
 * 继续翻剩下的群是**白花 6 次子进程调用去得到同一个答案**。
 */
type CommonGroupSearch =
  | { kind: "found"; mediaId: string; groupExternalId: string }
  /** 见到过他（至少一个共同群里有他的成员行），但 avatarMediaId 是空 */
  | { kind: "no_avatar" }
  /** 一个共同群都没搜到，或搜到的群里都没有他 */
  | { kind: "no_group" }
  /** 缺花名 → **没查**（不是"没有群"）。可重试，见 `lookup_skipped` */
  | { kind: "skipped" }

async function findViaCommonGroups(
  cli: Pick<MediaRunner, "json">,
  input: AvatarLookupInput,
): Promise<CommonGroupSearch> {
  const nick = input.nick
  if (nick === null || nick === undefined || nick === "") return { kind: "skipped" }

  let cursor = "0"
  for (let page = 0; page < MAX_COMMON_GROUP_PAGES; page += 1) {
    const payload = await cli.json<unknown>(
      [
        "chat",
        "search-common",
        "--nicks",
        nick,
        // OR：任一匹配即可。AND 在只有一个 nick 时等价，但语义上 OR 更对
        "--match-mode",
        "OR",
        "--limit",
        "20",
        "--cursor",
        cursor,
      ],
      input.signal === undefined ? {} : { signal: input.signal },
    )
    const record = asRecord(payload)
    const groups = record === null ? null : record["groups"]
    if (!Array.isArray(groups)) return { kind: "no_group" }

    for (const item of groups) {
      const group = asRecord(item)
      const groupId = group === null ? null : str(group["openConversationId"])
      if (groupId === null) continue
      const found = await mediaIdFromGroup(cli, groupId, input.openDingTalkId, input.signal)
      if (found.mediaId !== null) {
        return { kind: "found", mediaId: found.mediaId, groupExternalId: groupId }
      }
      // 在这个群里但没头像 → 别的群也一样（头像是人的属性），立刻停
      if (found.inGroup) return { kind: "no_avatar" }
    }

    const next = record === null ? null : str(record["nextCursor"])
    const hasMore = record !== null && record["hasMore"] === true
    if (!hasMore || next === null) break
    cursor = next
  }
  return { kind: "no_group" }
}

/**
 * 取一个人的头像，落到 `outputDir/<sha256(mediaId)>.jpg`。
 *
 * 用 mediaId 的 hash 做文件名而不是姓名：
 * · 同名同姓的人不会互相覆盖（实测同名有 6 个 openDingTalkId）；
 * · 换了头像 mediaId 会变 → 新文件，旧的自然失效（不用做缓存失效逻辑）；
 * · 文件名里**不含**姓名 —— 那是 PII，不该出现在路径里。
 */
export async function fetchAvatar(
  cli: MediaRunner,
  input: AvatarLookupInput,
): Promise<AvatarResult> {
  let found: [string, string] | null = null

  // 已知共同群优先：省掉一次搜索，也避免"搜不到但其实在某个群里"
  const known = input.groupExternalId
  if (known !== null && known !== undefined && known !== "") {
    const direct = await mediaIdFromGroup(cli, known, input.openDingTalkId, input.signal)
    if (direct.mediaId !== null) found = [direct.mediaId, known]
    else if (direct.inGroup) {
      /**
       * ★ 他在这个群里但成员详情里没有 `avatarMediaId` → 判 `no_avatar_set`，
       * **不再去搜别的群**。
       *
       * 头像是**人身上**的属性，不是"人在这个群里"的属性 ——
       * 实测同一个人在 3 个群里返回的 mediaId 完全相同。
       * 所以这里已经是确定的答案，继续搜是白花几十次 CLI 调用。
       */
      return { ok: false, reason: "no_avatar_set" }
    }
    /**
     * ★ `inGroup === false` 时**要继续搜**，不能判终态。
     *
     * 调用方给的"已知共同群"可能已经不含他了（退群 / 换群），
     * 而那不代表他没头像 —— 落终态会让这个人的头像永久取不到。
     */
  }

  if (found === null) {
    const search = await findViaCommonGroups(cli, input)
    if (search.kind === "no_avatar") return { ok: false, reason: "no_avatar_set" }
    // 缺花名 = 没查过，**不是**终态（花名可能只是还没采到）
    if (search.kind === "skipped") return { ok: false, reason: "lookup_skipped" }
    if (search.kind === "no_group") return { ok: false, reason: "no_common_group" }
    found = [search.mediaId, search.groupExternalId]
  }

  const [mediaId, groupId] = found
  mkdirSync(input.outputDir, { recursive: true })
  const name = `${createHash("sha256").update(mediaId).digest("hex").slice(0, 32)}.jpg`
  const target = join(input.outputDir, name)
  // 已经下过就直接用：mediaId 变了文件名也会变，所以命中即有效
  if (existsSync(target) && statSync(target).size > 0) {
    return { ok: true, path: target, mediaId, groupExternalId: groupId }
  }

  /**
   * 先下到临时名再改名。
   *
   * 不这么做的话：下载中途失败会留下一个 0 字节的文件，而上面那个
   * `existsSync` 会把它当成"已经下过" —— 于是那个人的头像**永久**是空的，
   * 且不会重试。`rename` 在同一目录内是原子的。
   */
  const temp = `${target}.part`
  try {
    await cli.run(
      [
        "chat",
        "message",
        "download-media",
        "--type",
        "mediaId",
        "--resource-id",
        mediaId,
        // ★ 头像不属于任何消息，但这个参数必填 —— 0 是脚本里验过的绕过值
        "--message-id",
        "0",
        "--open-conversation-id",
        groupId,
        "--output",
        temp,
      ],
      input.signal === undefined ? {} : { signal: input.signal },
    )
    if (!existsSync(temp) || statSync(temp).size === 0) {
      rmSync(temp, { force: true })
      return { ok: false, reason: "download_failed", detail: "命令成功但文件是空的" }
    }
    renameSync(temp, target)
    return { ok: true, path: target, mediaId, groupExternalId: groupId }
  } catch (error) {
    rmSync(temp, { force: true })
    return {
      ok: false,
      reason: "download_failed",
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 钉钉的 miss 原因 → 渠道无关的 miss 原因。
 *
 * ## ★ 写成穷尽的 `Record` 而不是 `switch` 带 default
 *
 * `Record<AvatarMissReason, …>` 让**新增一个钉钉原因而忘了映射**变成
 * 编译错误。带 `default` 的 switch 会把漏掉的那个悄悄归到兜底分支，
 * 而兜底值必然是猜的 —— 猜成终态会让那些人的头像永久不再取，
 * 猜成可重试会让它每 6 小时重试一次永远失败的事。
 *
 * 映射本身要保住「终态 vs 可重试」这条线（见 `ChannelAvatarMiss`）：
 * · `no_avatar_set`   → `not_set`        （终态 → 终态）
 * · `no_common_group` → `not_reachable`  （终态 → 终态）
 * · `lookup_skipped`  → `not_attempted`  （可重试 → 可重试）
 * · `download_failed` → `failed`         （可重试 → 可重试）
 */
const MISS_MAP: Record<AvatarMissReason, ChannelAvatarMiss> = {
  no_avatar_set: "not_set",
  no_common_group: "not_reachable",
  lookup_skipped: "not_attempted",
  download_failed: "failed",
}

/**
 * 把 `fetchAvatar` 包成渠道契约的形态。
 *
 * ## 为什么是薄适配器而不是把 `fetchAvatar` 直接改成契约签名
 *
 * `fetchAvatar` 的入参名（`openDingTalkId`、`nick`、`groupExternalId`）
 * 与它的返回值（`mediaId`）**就该**是钉钉的词汇 —— 那个函数的整份文件头
 * 记录的是钉钉侧的实测结论（哪条命令返回什么、`--message-id 0` 那个绕过值、
 * 21 个人被误报成 `no_common_group` 那次）。把它改成中性名字会让那些
 * 注释与代码对不上。
 *
 * 所以翻译发生在**边界上**：契约的词进来，钉钉的词出去，反之亦然。
 *
 * `ofConversation` **不实现** —— 钉钉拿不到群头像（`conversation-info`
 * 不返回，也没有"群 avatarMediaId"字段，见文件头）。
 * 留空比实现一个恒定失败的方法好：调用方判 `undefined` 就知道
 * "这个渠道没这能力"，而一个总是返回 `not_reachable` 的方法
 * 会让它以为"这次没拿到，下次也许行"。
 */
export function createDingTalkAvatars(cli: MediaRunner): ChannelAvatars {
  return {
    async ofUser(request: ChannelAvatarRequest): Promise<ChannelAvatarResult> {
      /**
       * 可选字段用 spread 而不是传 `undefined`：`AvatarLookupInput` 的两个
       * 可选参数在 `exactOptionalPropertyTypes` 下不接受显式 undefined。
       * null 也一并折掉 —— 那边判的是 `null | undefined | ""` 三者，
       * 这里先归一成"不传"，让两侧的判据只有一处。
       */
      const nick = request.displayName
      const group = request.viaConversationExternalId
      const result = await fetchAvatar(cli, {
        openDingTalkId: request.externalId,
        ...(nick === null || nick === undefined || nick === "" ? {} : { nick }),
        ...(group === null || group === undefined || group === ""
          ? {}
          : { groupExternalId: group }),
        outputDir: request.outputDir,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })

      if (result.ok) {
        // mediaId 就是缓存键：换了头像它会变 → 宿主据此知道要重新下
        return { ok: true, path: result.path, cacheKey: result.mediaId }
      }
      return {
        ok: false,
        reason: MISS_MAP[result.reason],
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      }
    },
  }
}
