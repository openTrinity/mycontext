/**
 * 会话、参与者、本人身份的仓储。
 *
 * 三张表放一起是因为它们在采集链路里总是一起被写（一条消息进来要确保
 * 它的会话与发送者都存在），分开会让调用方持有三个仓储对象却永远同时用。
 */
import { AppError } from "@mycontext/kernel"
import type { SqliteDatabase } from "../database.js"
import type { ActorInput, ConversationInput, ConversationRow, SelfIdentityRecord } from "./types.js"

export type PersonaConversationExclusionReason = "bot_channel" | "self_conversation"

interface ConversationDbRow {
  id: string
  channel_id: string
  external_id: string
  type: "direct" | "group"
  title: string | null
  member_count: number | null
  is_self_involved: number
  is_bot_channel: number
  last_message_at: number | null
  created_at: number
}

function toConversation(row: ConversationDbRow): ConversationRow {
  return {
    id: row.id,
    channelId: row.channel_id,
    externalId: row.external_id,
    type: row.type,
    title: row.title,
    memberCount: row.member_count,
    isSelfInvolved: row.is_self_involved === 1,
    isBotChannel: row.is_bot_channel === 1,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
  }
}

export class ConversationRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * upsert：已存在则只更新会变的字段。
   *
   * 刻意**不覆盖** `is_bot_channel`：那个值可能是用户手动改过的
   * （启发式判断会误判，用户纠正后不该被下一次采集抹掉）。
   * 同理 `created_at` 保留首次见到的时间。
   */
  upsert(input: ConversationInput): void {
    this.db
      .prepare(
        `INSERT INTO conversations
           (id, channel_id, external_id, type, title, member_count,
            is_self_involved, is_bot_channel, last_message_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, external_id) DO UPDATE SET
           type            = excluded.type,
           title           = COALESCE(excluded.title, conversations.title),
           member_count    = COALESCE(excluded.member_count, conversations.member_count),
           last_message_at = MAX(
             COALESCE(excluded.last_message_at, 0),
             COALESCE(conversations.last_message_at, 0)
           )`,
      )
      .run(
        input.id,
        input.channelId,
        input.externalId,
        input.type,
        input.title ?? null,
        input.memberCount ?? null,
        (input.isSelfInvolved ?? true) ? 1 : 0,
        (input.isBotChannel ?? false) ? 1 : 0,
        input.lastMessageAt ?? null,
        input.createdAt,
      )
  }

  findByExternalId(channelId: string, externalId: string): ConversationRow | null {
    const row = this.db
      .prepare<
        [string, string],
        ConversationDbRow
      >("SELECT * FROM conversations WHERE channel_id = ? AND external_id = ?")
      .get(channelId, externalId)
    return row === undefined ? null : toConversation(row)
  }

  findById(id: string): ConversationRow | null {
    const row = this.db
      .prepare<[string], ConversationDbRow>("SELECT * FROM conversations WHERE id = ?")
      .get(id)
    return row === undefined ? null : toConversation(row)
  }

  /**
   * 单聊对端的 `openDingTalkId`。群聊返回 null。
   *
   * ## ★ 为什么单聊不能拿 `conversations.external_id` 当对端身份
   *
   * 我原来在 persona.service.ts 里写过「实测单聊的 external_id 与
   * openDingTalkId 同形」——**那是错的**，而且错得很安静。实测本库 52 个单聊：
   *
   * · `conversations.external_id` = `cid…`，47 字符，是**会话** id；
   * · 对端 openDingTalkId = `messages.sender_external_id` = `D…`，33-34 字符。
   *
   * 把前者传给 `chat message send --open-dingtalk-id` 的表现不是"发错人"
   * （那还好些），而是服务端回
   * 「单聊时 receiverUid 不能为空」—— 也就是它**根本没把 cid 认成一个人**。
   * 于是点「发送」永远失败，而失败原因指向一个我们没传的参数名。
   *
   * ## ★★ 「单聊只有两个人，所以随便取一条对方的消息」——**这个前提不成立**
   *
   * 我原来在这里写过那句话，实测推翻了它。本机 143 个单聊里有 1 个的
   * 「非本人 sender」是**两个**：
   *
   * ```
   * 会话「某某」（用户自己两个身份之间的单聊）
   *   D0AUGT…ay(33)  is_self=1   ← 当前 vault 绑的"我"
   *   D0AUGT…aw(33)  is_self=0   ← 对端，21 条历史消息都是它
   *   DMvqYy…(34)    is_self=0   ← ★ 同一个人的**另一套** openId，只 2 条
   * ```
   *
   * 成因是 openDingTalkId 的定义：它是「**当前用户视角下**的目标用户唯一
   * 标识，不可跨用户共享」。同一个人在不同观察者视角下是不同的 openId，
   * 而一个会话里可能同时躺着**两个视角**采到的消息（换过 CLI／换过身份）。
   *
   * ★ 于是 `LIMIT 1` **无 ORDER BY** 就是一个真 bug：挑哪个由 SQLite 决定。
   * 实测它挑中了只出现 2 条的那个（而不是 21 条的主对端）—— 表现是
   * 「发给 A 的消息进了 B 的对话」，而两个 openId 的显示名相同，
   * 界面上看不出任何异常。
   *
   * ## 判据：取**出现次数最多**的那个，并列时取最近说过话的
   *
   * 主对端一定是消息最多的那个（历史都是跟他聊的）。次数并列时取
   * `MAX(sent_at)` 更大的 —— 那是"现在还在用的那套 openId"。
   * 两级排序让结果**确定**：同一个会话每次问都得到同一个答案，
   * 而"不确定"本身就是上面那个 bug 的成因。
   *
   * 取不到只有一种情况 —— 该单聊里对方从没说过话，那时也确实没有人可发。
   */
  findPeerExternalId(conversationId: string): string | null {
    const row = this.db
      .prepare<[string], { peer: string | null }>(
        `SELECT m.sender_external_id AS peer
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
          WHERE m.conversation_id = ?
            AND c.type = 'direct'
            AND m.is_self = 0
            AND m.sender_external_id IS NOT NULL
          GROUP BY m.sender_external_id
          -- ★ 两级排序让结果**确定**（见方法注释）：主对端是消息最多的那个，
          --   并列时取最近还在说话的那套 openId。无 ORDER BY 的 LIMIT 1
          --   会在"一个会话里有两套视角的 openId"时挑错人。
          ORDER BY COUNT(*) DESC, MAX(m.sent_at) DESC
          LIMIT 1`,
      )
      .get(conversationId)
    return row?.peer ?? null
  }

  /**
   * 把会话标记成**不可读**（服务端拒绝，且不是我们能绕的）。
   *
   * ## ★ 为什么要落库，而不是只在本轮跳过
   *
   * `classifyDwsError` 已经能把保密群那个错误（`server_error_code=1001`）
   * 归成终态 `RESOURCE_FORBIDDEN`，于是**这一次**不会重试。但那不等于
   * 「以后都不再试」—— 采集是每 2 分钟一轮的循环，不落库的话每轮都会
   * 再撞一次同一个必失败的调用。
   *
   * 更要紧的是第二个作用：**把「读不了」与「0 条」区分开**。
   * 实测 `list-all` 会为保密群返回十几条伪消息（`content` 是拒绝提示、
   * 而 `sender`/时间是真值），伪消息在解析层被丢掉之后，这个会话看起来
   * 就是"这段时间没人说话"。CLAUDE.md 第 5 节要求的正是相反：
   * 明确记成「不可读」而不是「0 条」。
   *
   * 幂等：同一个会话反复标记只刷新时间戳。不存在的会话是 no-op
   * （拒绝可能发生在会话还没入库时，那时没什么可标记的）。
   *
   * @param reason 机器可读的原因（`confidential` / `cross_org`）。
   *   分开记是因为处置不同：前者无补救动作，后者授权一次就能读。
   */
  markUnreadable(channelId: string, externalId: string, reason: string, at: number): void {
    this.db
      .prepare(
        `UPDATE conversations
            SET unreadable_reason = ?, unreadable_at = ?
          WHERE channel_id = ? AND external_id = ?`,
      )
      .run(reason, at, channelId, externalId)
  }

  /**
   * 不可读会话的 external_id → 原因。
   *
   * 采集前一次取全（一个很小的 Map —— 实测 123 个群里 1 个），
   * 逐个查会是几十次同步 SQL，而 better-sqlite3 是同步的。
   */
  unreadableByExternalId(channelId: string): Map<string, string> {
    const rows = this.db
      .prepare<[string], { external_id: string; unreadable_reason: string }>(
        `SELECT external_id, unreadable_reason FROM conversations
          WHERE channel_id = ? AND unreadable_reason IS NOT NULL`,
      )
      .all(channelId)
    return new Map(rows.map((row) => [row.external_id, row.unreadable_reason]))
  }

  /**
   * `会话 externalId → 渠道 id` 的全量映射。
   *
   * ## ★ 为什么一次全取而不是逐个查
   *
   * 知识图谱的 ego 图要把几百条 fact 归到 IM 渠道，而 kl 的图库里
   * **没有渠道字段**（它的 `conversation_id` 就是这里的 `external_id`，
   * 实测能对上）。逐个查是几百次同步 SQL —— better-sqlite3 是同步的，
   * 那是几百次主进程阻塞。
   *
   * 实测本库 88 个会话，一次全取是一个很小的 Map。
   */
  channelByExternalId(): Map<string, string> {
    const rows = this.db
      .prepare<
        [],
        { external_id: string; channel_id: string }
      >("SELECT external_id, channel_id FROM conversations")
      .all()
    return new Map(rows.map((row) => [row.external_id, row.channel_id]))
  }

  /** 按最近活跃排序，供侧栏与蒸馏范围选择使用。 */
  listRecent(limit = 100): ConversationRow[] {
    return this.db
      .prepare<
        [number],
        ConversationDbRow
      >("SELECT * FROM conversations ORDER BY last_message_at DESC NULLS LAST LIMIT ?")
      .all(limit)
      .map(toConversation)
  }

  setBotChannel(id: string, isBotChannel: boolean): void {
    this.db
      .prepare("UPDATE conversations SET is_bot_channel = ? WHERE id = ?")
      .run(isBotChannel ? 1 : 0, id)
  }

  /** Persona 不应处理或展示的会话；分类规则由 v12 的数据库视图统一定义。 */
  personaExclusionReason(id: string): PersonaConversationExclusionReason | null {
    const row = this.db
      .prepare<
        [string],
        { reason: PersonaConversationExclusionReason }
      >("SELECT reason FROM persona_conversation_exclusions WHERE conversation_id = ?")
      .get(id)
    return row?.reason ?? null
  }

  /**
   * 清理已进入 Persona 持久化队列、但后来被识别为 bot/自聊的历史项。
   *
   * 分类会随着消息与 actor 补全而变化，所以不能只依赖一次性迁移。
   * attach 前调用可保证 mailbox.restore() 不会把这些消息重新捞回内存。
   */
  cleanupPersonaExclusions(at: number): { inbox: number; drafts: number } {
    const transaction = this.db.transaction(() => {
      const inbox = this.db
        .prepare(
          `UPDATE dh_inbox
              SET state = 'dropped',
                  drop_reason = (
                    SELECT reason
                      FROM persona_conversation_exclusions e
                     WHERE e.conversation_id = dh_inbox.conversation_id
                  ),
                  processed_at = COALESCE(processed_at, ?)
            WHERE state = 'pending'
              AND conversation_id IN (
                SELECT conversation_id FROM persona_conversation_exclusions
              )`,
        )
        .run(at).changes
      const drafts = this.db
        .prepare(
          `UPDATE dh_drafts
              SET state = 'expired', resolved_at = COALESCE(resolved_at, ?)
            WHERE state = 'pending'
              AND conversation_id IN (
                SELECT conversation_id FROM persona_conversation_exclusions
              )`,
        )
        .run(at).changes
      return { inbox, drafts }
    })
    return transaction()
  }

  count(): number {
    return (
      this.db.prepare<[], { c: number }>("SELECT count(*) AS c FROM conversations").get()?.c ?? 0
    )
  }
}

export class ActorRepository {
  constructor(private readonly db: SqliteDatabase) {}

  upsert(input: ActorInput): void {
    this.db
      .prepare(
        `INSERT INTO actors
           (id, channel_id, external_id, kind, display_name, staff_id,
            is_self, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, external_id) DO UPDATE SET
           -- display_name 用最新的（花名会改），但不允许被 null 抹掉
           display_name = COALESCE(excluded.display_name, actors.display_name),
           staff_id     = COALESCE(excluded.staff_id, actors.staff_id),
           -- is_self 只能从 0 变 1（身份确认后回填），不能被后续采集降回 0
           is_self      = MAX(actors.is_self, excluded.is_self),
           last_seen_at = MAX(COALESCE(excluded.last_seen_at, 0),
                              COALESCE(actors.last_seen_at, 0))`,
      )
      .run(
        input.id,
        input.channelId,
        input.externalId,
        input.kind,
        input.displayName ?? null,
        input.staffId ?? null,
        (input.isSelf ?? false) ? 1 : 0,
        input.seenAt,
        input.seenAt,
      )
  }

  findIdByExternalId(channelId: string, externalId: string): string | null {
    const row = this.db
      .prepare<
        [string, string],
        { id: string }
      >("SELECT id FROM actors WHERE channel_id = ? AND external_id = ?")
      .get(channelId, externalId)
    return row?.id ?? null
  }

  count(): number {
    return this.db.prepare<[], { c: number }>("SELECT count(*) AS c FROM actors").get()?.c ?? 0
  }
}

/** 单聊交集推断的结果。`null` 分支各自带原因，便于日志里区分"为什么没推出来"。 */
export type SelfExternalIdInference =
  | { ok: true; externalId: string; directChats: number }
  /** 双方都发过言的单聊不足 2 个 —— 交集必然含对方，分不出谁是我。 */
  | { ok: false; reason: "not_enough_direct_chats"; directChats: number }
  /** 交集为空或多于一个 —— 数据异常（多半是 type 判错把群当成了单聊）。 */
  | { ok: false; reason: "not_unique"; candidates: number; directChats: number }

/**
 * 从**单聊**里反推本人在消息中使用的标识（钉钉的 `openDingTalkId`）。
 *
 * ## ★★ 为什么需要它：授权给的编号和消息里的编号不是一套
 *
 * 授权成功只给 `corpId + userId`（工号，实测输出见 `parseAuthStatus`），
 * 而消息的发送者字段是 `senderOpenDingTalkId` —— 两个**互不相通**的标识符
 * 空间，且渠道没有开放「工号 → 聊天标识」的接口（`get-self` 实测不给后者）。
 *
 * 于是 `resolveSelf` 只能绕道：拿姓名去 `contact user search` 搜一批人，
 * 再用工号从里面精确挑出本人。判定是准的（最终判据是工号），但**这条路
 * 失败率高**：搜不到、花名与实名不一致搜不着、字段缺失都会让它抛
 * `SELF_IDENTITY_AMBIGUOUS`，而那时用户只能看着一条红字手动处理 ——
 * 未确认期间蒸馏会拒掉**全部**语料（`assertDistillable` 第一条守卫）。
 *
 * ## ★★ 判据：在多个单聊里都出现的那个人，只能是我
 *
 * 单聊定义上只有两人。所以：
 *
 * ```
 * 单聊①（和 A）：出现过 D-aaa、D-me
 * 单聊②（和 B）：出现过 D-bbb、D-me
 * 单聊③（和 C）：出现过 D-ccc、D-me
 * ```
 *
 * A/B/C 是三个不同的人，各自只出现在自己那个单聊里；而**跨全部单聊的交集
 * 只可能是我自己** —— 不存在第三个人同时在我的多个单聊里（否则它就不是单聊）。
 *
 * ★ 这条路**完全不碰姓名**。姓名匹配是灾难性的（实测同名同姓搜出 6 个不同
 * `openDingTalkId`，见 self-identity.ts 文件头「为什么姓名绝对不参与判定」），
 * 而这里是纯结构推断：不查通讯录、不多跑一次子进程、一条 SQL。
 *
 * ## ★ 两道自检，宁可返回 null 也不给可能错的答案
 *
 * 1. **至少 2 个"双方都发过言"的单聊。** 只有 1 个时交集是 `{我, 对方}`
 *    两个元素，无从分辨 —— 这时必须放弃，不能挑一个。
 * 2. **交集必须唯一。** 不唯一说明数据不符合假设（最可能是 `type` 判错，
 *    把群当成了单聊 —— 那个判据实测踩过坑，见 `classifyConversation`），
 *    这时同样放弃。
 *
 * ★ `HAVING count(...) = <单聊总数>` 里的分母只算**双方都发过言**的单聊：
 * 若把"我只收没发"的单聊也算进分母，我自己就达不到那个计数而被排除掉 ——
 * 那会让这条路在"有几个只收不发的单聊"时静默失效。
 *
 * ## 局限（调用方必须知道）
 *
 * **首次授权那一刻用不了** —— 库里还没有消息。所以它是 `search` 路径的
 * **兜底与交叉校验**，不是替代品。好在采集不依赖身份（照常跑），
 * 所以等用户看到那条红字时，库里通常已经有消息了。
 */
export function inferSelfExternalIdFromDirectChats(
  db: SqliteDatabase,
  channelId: string,
): SelfExternalIdInference {
  /**
   * 只认「双方都发过言」的单聊（`distinct sender >= 2`）。
   *
   * 单方独白的单聊对交集毫无贡献却会抬高分母：如果那条独白是对方发的，
   * 我不在里面 → 我达不到分母 → 交集为空；如果是我发的，它不影响正确性
   * 但也不提供任何区分力。两种情况下排除掉都更稳。
   */
  const usable = db
    .prepare<[string], { id: string }>(
      `SELECT c.id AS id
         FROM conversations c
        WHERE c.channel_id = ? AND c.type = 'direct'
          AND (SELECT count(DISTINCT m.sender_external_id)
                 FROM messages m
                WHERE m.conversation_id = c.id
                  AND m.sender_external_id IS NOT NULL) >= 2`,
    )
    .all(channelId)

  // 自检 1：少于 2 个可用单聊 → 交集必然含对方，放弃。
  if (usable.length < 2) {
    return { ok: false, reason: "not_enough_direct_chats", directChats: usable.length }
  }

  const placeholders = usable.map(() => "?").join(",")
  /**
   * ★ 分母直接内插成字面量而不是绑定参数：它是 `usable.length`（本函数自己算的
   * 整数，不经任何外部输入），而混着绑 id 字符串与一个数字会让参数元组的类型
   * 退化成 `unknown[]` —— 那正好盖住"绑错顺序"这类真错误。
   */
  const candidates = db
    .prepare<string[], { sender_external_id: string }>(
      `SELECT m.sender_external_id AS sender_external_id
         FROM messages m
        WHERE m.conversation_id IN (${placeholders})
          AND m.sender_external_id IS NOT NULL
        GROUP BY m.sender_external_id
       HAVING count(DISTINCT m.conversation_id) = ${String(usable.length)}`,
    )
    .all(...usable.map((row) => row.id))

  // 自检 2：交集必须唯一。不唯一多半是 type 判错（群被当成单聊）。
  const only = candidates.length === 1 ? candidates[0] : undefined
  if (only === undefined) {
    return {
      ok: false,
      reason: "not_unique",
      candidates: candidates.length,
      directChats: usable.length,
    }
  }

  return {
    ok: true,
    externalId: only.sender_external_id,
    directChats: usable.length,
  }
}

/**
 * 是否同一个身份。判据是 `(corpId, userId)` —— 「哪个组织的哪个工号」。
 *
 * ★ 不比 openId：那是渠道专有形态（钉钉一个、飞书三套），放进渠道无关的
 * 这一层会让接下一个渠道时必须改这里。而 `corpId + userId` 是所有 IM
 * 都有的概念（组织 + 组织内成员编号），语义稳定。
 *
 * ★ 也不比 displayNames：花名会改，改个花名不该被判成"换了个人"。
 */
function isSameIdentity(
  stored: SelfIdentityRecord,
  incoming: Omit<SelfIdentityRecord, "confirmedAt">,
): boolean {
  return stored.corpId === incoming.corpId && stored.userId === incoming.userId
}

export class SelfIdentityRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * 写入本人身份。
   *
   * `confirmedAt` 单独一个方法推进：解析出来（可能有歧义）与用户确认
   * 是两个不同的事实，混成一个字段会让「系统猜的」与「人确认的」不可区分，
   * 而蒸馏的准入条件恰恰是后者。
   *
   * ## ★★ 换了身份就抛错，**不静默覆盖**
   *
   * 隔离维度是 `channel + corpId + userId`：先按渠道分（每个渠道一行），
   * 渠道内再由「组织 + 工号」确定是哪一个身份。
   *
   * 首版是无条件 `ON CONFLICT(channel_id) DO UPDATE` —— 重新授权到另一个
   * 组织/另一个人时**直接覆盖**，而库里已经躺着上一个身份采的会话与消息。
   * 后果不是报错而是**判错**：`is_self` 拿新身份的 openId 去判旧身份的消息，
   * 于是「哪些是本人说的」整批错位，而那正是蒸馏语料的唯一来源。
   *
   * 实测踩到过：一个库里 39 个会话有 28 个属于组织 A，而身份行被覆盖成组织 B
   * 之后 749 条消息被标成 `is_self=1` —— 全是错的。
   *
   * 所以这里 fail-closed：身份不一致时抛 `SELF_IDENTITY_CONFLICT`，
   * 由上层引导用户「换回原身份，或新建一个账号（各自独立 vault）」。
   * 宁可挡住一次授权，也不能让两个人的语料混进同一份画像 —— 后者不可逆。
   *
   * 允许的更新：同一个 `(corpId, userId)` 下刷新 openIds / displayNames
   * （改花名、补上第二个 openId 都是正常的）。
   */
  upsert(record: Omit<SelfIdentityRecord, "confirmedAt">): void {
    const existing = this.get(record.channelId)
    if (existing !== null && !isSameIdentity(existing, record)) {
      throw new AppError("SELF_IDENTITY_CONFLICT", "这个账号已绑定另一个身份，换身份请新建账号", {
        retryable: false,
        messageKey: "errors:byCode.SELF_IDENTITY_CONFLICT",
        // 只记组织名与工号：openId 是标识符，不进日志
        context: {
          channelId: record.channelId,
          storedCorp: existing.corpName,
          storedUserId: existing.userId,
          incomingCorp: record.corpName,
          incomingUserId: record.userId,
        },
      })
    }

    this.db
      .prepare(
        `INSERT INTO channel_self_identity
           (channel_id, user_id, open_ids_json, display_names_json, corp_id, corp_name)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           user_id            = excluded.user_id,
           open_ids_json      = excluded.open_ids_json,
           display_names_json = excluded.display_names_json,
           corp_id            = excluded.corp_id,
           corp_name          = excluded.corp_name`,
      )
      .run(
        record.channelId,
        record.userId,
        JSON.stringify(record.openIds),
        JSON.stringify(record.displayNames),
        record.corpId,
        record.corpName,
      )
  }

  confirm(channelId: string, at: number): void {
    this.db
      .prepare("UPDATE channel_self_identity SET confirmed_at = ? WHERE channel_id = ?")
      .run(at, channelId)
  }

  get(channelId: string): SelfIdentityRecord | null {
    const row = this.db
      .prepare<
        [string],
        {
          channel_id: string
          user_id: string
          open_ids_json: string
          display_names_json: string
          corp_id: string | null
          corp_name: string | null
          confirmed_at: number | null
        }
      >("SELECT * FROM channel_self_identity WHERE channel_id = ?")
      .get(channelId)
    if (row === undefined) return null
    return {
      channelId: row.channel_id,
      userId: row.user_id,
      openIds: JSON.parse(row.open_ids_json) as { kind: string; value: string }[],
      displayNames: JSON.parse(row.display_names_json) as string[],
      corpId: row.corp_id,
      corpName: row.corp_name,
      confirmedAt: row.confirmed_at,
    }
  }
}
