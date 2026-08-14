/**
 * 联系人头像缓存的读写。
 *
 * ## ★ 「取不到」与「没试过」必须能区分
 *
 * 取一个人的头像要 2-3 次 CLI 调用（实测每次 0.3-0.8s）。而"取不到"里
 * 有两种是**终态**（没共同群 / 他自己没设头像）—— 重试永远同一个答案。
 *
 * 不把终态记下来的话，每次打开消息流都会对那几十个人各重试一遍：
 * 几十次子进程、十几秒、结果不变。所以 `recordMiss` 与"没有行"
 * 是两件不同的事，而 `needsFetch` 就是靠这个区分工作的。
 */
import type { SqliteDatabase } from "../database.js"

/**
 * 取不到头像的原因。**新旧两套值的并集。**
 *
 * ## ★ 为什么这里有八个值而不是四个
 *
 * 新值（`not_*` / `failed`）是渠道无关的契约枚举
 * （`@mycontext/channels` 的 `ChannelAvatarMiss`）；旧值
 * （`no_common_group` 等）是钉钉的词汇，头像能力契约化**之前**写进库的。
 *
 * 这张表是**纯缓存**，所以不为改名写 SQL 迁移（那会动用户数据，
 * 收益只是省几次重试）。代价是读取侧必须认旧值 —— 不认的话
 * `toRow` 会把它们过滤成 `null`（"没失败过"），于是那些**已经确定
 * 取不到**的人会被重新取一遍，正好是这个文件头警告的那件事。
 *
 * 旧行会被自然刷新覆盖成新值，届时可以删掉旧的四个。
 *
 * 分层不能反向依赖（store 不能 import channels），所以这里是一份副本 ——
 * 新值必须与契约那侧逐字一致。
 */
export type AvatarMissReason =
  // 契约值（当前写入的都是这五个）
  | "not_set"
  | "not_reachable"
  | "not_attempted"
  /**
   * 这份渠道客户端没有取头像所需的能力（服务端在权限层拒）。**终态**。
   *
   * ★ 必须与 `failed` 分开：`failed` 在 `RETRIABLE` 里（6 小时后重试），
   * 而这个在当前客户端下重试永远无效 —— 实测钉钉随包客户端整族
   * `contact` 返回 `ENTERPRISE_NOT_AUTHORIZED`。归 `failed` 的后果是
   * 每 6 小时对每个人重试一遍一件永远失败的事，而界面上一个字都没说
   * （用户报的「刷新头像也没用」）。
   *
   * ★ 它仍然**能**被 `force` 绕过（用户换了客户端之后点刷新就该重试）——
   * 那条路整段跳过缓存判定，见 `MediaService.fetchAvatar` 里那段。
   */
  | "not_permitted"
  | "failed"
  // 历史值：头像契约化之前的钉钉词汇，只出现在旧行里
  | "no_common_group"
  | "no_avatar_set"
  | "download_failed"
  | "lookup_skipped"

export interface ContactAvatarRow {
  channelId: string
  externalId: string
  localPath: string | null
  mediaId: string | null
  missReason: AvatarMissReason | null
  attemptedAt: number
}

/**
 * `failed`（旧 `download_failed`）的重试退避。
 *
 * 6 小时：网络类问题通常几分钟就好，但我们没有"网络恢复"的信号，
 * 而每次打开页面都重试一遍失败的那些会很吵。6 小时意味着
 * "今天之内会再试一两次"，够了。
 */
export const AVATAR_RETRY_AFTER_MS = 6 * 60 * 60 * 1000

/**
 * ★ 从 `AvatarMissReason` 派生，不再手写第二份清单。
 *
 * 原来这里是一个字面量 Set，与上面的类型各写一遍 —— 那是**两份可以
 * 分叉的真源**：新增一个原因只改类型不改 Set，读回来就会被静默过滤成
 * `null`（即"没失败过"→ 重试），而类型检查全绿。
 *
 * `satisfies` 让漏掉任何一个成员变成编译错误。
 */
const MISS_REASONS = new Set<string>([
  "not_set",
  "not_reachable",
  "not_attempted",
  "failed",
  "no_common_group",
  "no_avatar_set",
  "download_failed",
  "lookup_skipped",
] satisfies AvatarMissReason[])

/**
 * 可以重试的原因。**判据是"可重试"而不是"终态"。**
 *
 * ## ★ 为什么按这个方向列
 *
 * 反过来（列终态、其余可重试）在新增枚举时会静默出错：一个忘了归类的
 * 新原因会落进"可重试"，于是每 6 小时重试一遍一件永远失败的事。
 * 而按"可重试"列的话，忘了归类的新值会被当成终态 —— 那也是错的，
 * 但它的表现是"这个人的头像没取"，比一个悄悄跑的重试循环容易发现。
 *
 * `not_attempted`（旧 `lookup_skipped`）**必须**在这里：它的语义是
 * "我们压根没查"（缺花名），而缺花名往往是暂时的 ——
 * 会话标题或那个人的消息可能只是还没采到。归成终态的后果是
 * 花名后来有了，头像却永久不再取。
 */
const RETRIABLE: ReadonlySet<string> = new Set<string>([
  "not_attempted",
  "lookup_skipped",
] satisfies AvatarMissReason[])

/**
 * 隔一段时间可以再试一次的原因（网络类失败）。
 *
 * 与 `RETRIABLE` 分开：那个是"立刻可以再试"，这个要等
 * `AVATAR_RETRY_AFTER_MS`。
 */
const RETRIABLE_AFTER_BACKOFF: ReadonlySet<string> = new Set<string>([
  "failed",
  "download_failed",
] satisfies AvatarMissReason[])

interface AvatarDbRow {
  channel_id: string
  external_id: string
  local_path: string | null
  media_id: string | null
  miss_reason: string | null
  attempted_at: number
}

function toRow(raw: AvatarDbRow): ContactAvatarRow {
  return {
    channelId: raw.channel_id,
    externalId: raw.external_id,
    localPath: raw.local_path,
    mediaId: raw.media_id,
    missReason:
      raw.miss_reason !== null && MISS_REASONS.has(raw.miss_reason)
        ? (raw.miss_reason as AvatarMissReason)
        : null,
    attemptedAt: raw.attempted_at,
  }
}

export class ContactAvatarRepository {
  constructor(private readonly db: SqliteDatabase) {}

  get(channelId: string, externalId: string): ContactAvatarRow | null {
    const raw = this.db
      .prepare<
        [string, string],
        AvatarDbRow
      >("SELECT * FROM contact_avatars WHERE channel_id = ? AND external_id = ?")
      .get(channelId, externalId)
    return raw === undefined ? null : toRow(raw)
  }

  /**
   * 批量取（消息流一次要几十个）。
   *
   * 逐个 `get` 也能用，但一屏 20 条消息 = 20 次 prepare/step；
   * 这里一次查完，调用方用 Map 索引。
   */
  listByExternalIds(channelId: string, externalIds: readonly string[]): ContactAvatarRow[] {
    if (externalIds.length === 0) return []
    const placeholders = externalIds.map(() => "?").join(",")
    return this.db
      .prepare<string[], AvatarDbRow>(
        `SELECT * FROM contact_avatars WHERE channel_id = ? AND external_id IN (${placeholders})`,
      )
      .all(channelId, ...externalIds)
      .map(toRow)
  }

  recordHit(input: {
    channelId: string
    externalId: string
    localPath: string
    mediaId: string
    at: number
  }): void {
    this.db
      .prepare(
        `INSERT INTO contact_avatars
           (channel_id, external_id, local_path, media_id, miss_reason, attempted_at)
         VALUES (?, ?, ?, ?, NULL, ?)
         ON CONFLICT(channel_id, external_id) DO UPDATE SET
           local_path = excluded.local_path,
           media_id = excluded.media_id,
           -- 取到了就清掉之前的失败原因（否则 needsFetch 会以为还在失败）
           miss_reason = NULL,
           attempted_at = excluded.attempted_at`,
      )
      .run(input.channelId, input.externalId, input.localPath, input.mediaId, input.at)
  }

  recordMiss(input: {
    channelId: string
    externalId: string
    reason: AvatarMissReason
    at: number
  }): void {
    this.db
      .prepare(
        `INSERT INTO contact_avatars
           (channel_id, external_id, local_path, media_id, miss_reason, attempted_at)
         VALUES (?, ?, NULL, NULL, ?, ?)
         ON CONFLICT(channel_id, external_id) DO UPDATE SET
           -- 之前取到过、现在取不到（换了头像正在传？）→ 保留旧文件，
           -- 那比突然变成文字头像好（用户会以为出错了）
           miss_reason = excluded.miss_reason,
           attempted_at = excluded.attempted_at`,
      )
      .run(input.channelId, input.externalId, input.reason, input.at)
  }

  /**
   * 该不该去取。
   *
   * · 没有行 → 该取（从没试过）；
   * · 取到过 → 不取（cacheKey 变了会是新文件名，所以不用失效）；
   * · `not_attempted` → 立刻可取（见下）；
   * · `failed` → 过了退避窗口才取；
   * · `not_set` / `not_reachable` → **不取**（终态，重试无意义）。
   *
   * 判据用集合（`RETRIABLE` / `RETRIABLE_AFTER_BACKOFF`）而不是逐个
   * 列举终态值 —— 理由见那两个常量的注释：新增枚举时不会静默落进错的分支。
   */
  needsFetch(channelId: string, externalId: string, now: number): boolean {
    const row = this.get(channelId, externalId)
    if (row === null) return true
    if (row.localPath !== null) return false
    if (row.missReason === null) return true
    /**
     * ★ `not_attempted`（旧 `lookup_skipped`）**立刻**可重试，不带退避。
     *
     * 它的含义是"缺花名，我们一次命令都没调" —— 什么都没失败，
     * 所以没有需要退避的东西。而缺花名往往是暂时的（会话标题还没采到、
     * 那个人的消息还没落库），下一次界面来问时花名可能就有了。
     *
     * 给它退避的话会白等 6 小时；而记成终态（首版的行为）更糟 ——
     * 花名后来有了，头像却永久不再取。
     */
    if (RETRIABLE.has(row.missReason)) return true
    if (RETRIABLE_AFTER_BACKOFF.has(row.missReason)) {
      return now - row.attemptedAt >= AVATAR_RETRY_AFTER_MS
    }
    // not_set / not_reachable（及其旧名）：终态
    return false
  }
}
