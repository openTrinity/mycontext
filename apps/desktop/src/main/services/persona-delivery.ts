/**
 * ④ delivery —— 真发送。**三个入口，一条路径。**
 *
 * ## 三个入口
 *
 * · guard 判了 `send`（自动发）；
 * · 用户在草稿箱点了发送；
 * · 用户自己在回复框写了一条。
 *
 * 三者都走这里的 `send()`，因为 `SendGuard` 的那几条对"用户自己写的"
 * **同样适用**：
 *
 * · **急停** —— 它的意义是"现在别以我的身份说话"，与这句话是谁写的无关；
 * · **授权** —— 没授权时渠道命令会失败，而在这里先判能给出可执行的原因；
 * · **幂等键** —— 按 draftId 派生。没有 draft 就没有稳定的键，
 *   "点了发送、超时、再点一次"会真的发两条。
 *
 * 频率限制那条**也**照样过：用户自己连点十次与数字人连发十条，
 * 对群里的人来说是同一件事。
 *
 * ## ★ 这一层不判"该不该发"
 *
 * 判断在 guard。这里只判"**发的是不是对的那条**"（重读库比对 contentHash）
 * 与"能不能发出去"（授权、渠道可用）。两件事分开是 `send-guard.ts` 文件头
 * 那条纵深设计的落点 —— yolo 档关掉的是**判断**，不是**正确性**。
 */
import { randomUUID } from "node:crypto"
import type { Clock, Logger } from "@mycontext/kernel"
import {
  ConversationRepository,
  PersonaConfigRepository,
  PersonaRunRepository,
  type SqliteDatabase,
} from "@mycontext/store"
import { GrantManager, SendGuard, SEND_SCOPE, contentHash } from "@mycontext/persona"
import { createSendExecutor, type MediaRunner } from "@mycontext/channels"

/** 一条待发的草稿（权威正文仍会在 SendGuard 里按 id 重读一次）。 */
export interface DeliverableDraft {
  id: string
  conversationId: string
  text: string
  editedText: string | null
}

export interface DeliveryOutcome {
  state: string
  reason?: string
}

export interface DeliveryOptions {
  clock: Clock
  logger: Logger
  /** 渠道 CLI。null = 未登录 / 无渠道 → 授权与真发送都不可用。 */
  cli?: MediaRunner | null
  /**
   * 覆盖 `SendGuard` 的第 ① 层（应用层强制短路）。
   *
   * ★ 只该在**门禁里**传，而且只传 `false`：守卫默认在测试环境短路，
   * 那也意味着"真发那条路"在测试里一次都走不到，于是「没授权时是否真的
   * 不调命令」这类断言变成恒真。门禁显式打开它并用假 CLI 接住调用。
   */
  forceSendShortCircuit?: boolean
  /** 急停状态（总闸，覆盖**所有**发送路径 —— 手动那条不过 policy）。 */
  killSwitchActive: () => boolean
  /** 发成功后让数据面定向补拉这个会话，把刚发的那条秒级拉回来。 */
  onSent?: (conversationExternalId: string) => void
  /** 授权失效时把会话降回只出草稿。 */
  onDowngrade?: (conversationId: string, reason: string) => void
}

export class PersonaDelivery {
  constructor(private readonly options: DeliveryOptions) {}

  /**
   * 发一条草稿，并把结果记进 `dh_send_attempts`。
   *
   * ## ★ 幂等键按 draftId + contentHash 派生，不是随机的
   *
   * `--uuid` 是服务端幂等键（24h 内同值不重复投递）。用随机值的话
   * "点了发送、超时、再点一次"就会真的发两条。按 draftId 派生之后重试
   * 天然复用同一个键。
   *
   * 加上 contentHash：用户改了正文再发是**另一条消息**，该给新键 ——
   * 否则服务端会把它当重复投递吞掉，而用户以为改后的发出去了。
   */
  async send(
    db: SqliteDatabase,
    draft: DeliverableDraft,
    source: "agent_auto" | "user_approved",
  ): Promise<DeliveryOutcome> {
    const cli = this.options.cli
    if (cli === null || cli === undefined) {
      return { state: "failed", reason: "channel_unavailable" }
    }
    const conversations = new ConversationRepository(db)
    const conversation = conversations.findById(draft.conversationId)
    if (conversation === null) return { state: "failed", reason: "conversation_not_found" }

    const runs = new PersonaRunRepository(db)
    const grants = this.grantManager(db)
    const text = draft.editedText ?? draft.text
    const hash = contentHash(text)
    const idempotencyKey = `${draft.id}-${hash.slice(0, 16)}`

    const target = this.resolveTarget(conversations, draft.conversationId, conversation.type)
    if (target === null) {
      this.options.logger.warn("send target unresolved", {
        conversationId: draft.conversationId,
        type: conversation.type,
      })
      return { state: "failed", reason: "peer_not_resolved" }
    }

    const guard = new SendGuard({
      drafts: {
        get: (draftId) => {
          const row = runs.findDraft(draftId)
          return row === null ? null : { text: row.text, editedText: row.editedText }
        },
      },
      grants,
      executor: createSendExecutor(cli),
      clock: this.options.clock,
      logger: this.options.logger.child("Send"),
      killSwitchActive: () => this.options.killSwitchActive(),
      ...(this.options.forceSendShortCircuit === undefined
        ? {}
        : { forceShortCircuit: this.options.forceSendShortCircuit }),
      downgradeToDraft: (conversationId, reason) => {
        new PersonaConfigRepository(db).upsert(
          conversationId,
          { replyMode: "draft" },
          this.options.clock.now(),
        )
        this.options.logger.warn("conversation downgraded to draft", { conversationId, reason })
        this.options.onDowngrade?.(conversationId, reason)
      },
    })

    const attemptedAt = this.options.clock.now()
    /**
     * ★ 在 `guard.send` **之前**读授权 id：守卫在授权被撤销时会 `markRevoked`，
     * 之后再读就是 null 了 —— 而那一行审计恰恰最需要说清"当时用的是哪个授权"。
     */
    const grantAtAttempt = grants.requireValid(draft.conversationId, SEND_SCOPE)
    const outcome = await guard.send({
      draftId: draft.id,
      conversationId: draft.conversationId,
      target,
      // @人 一期不带：正文里的占位符要与 mentions 严格对应，而草稿是模型
      // 写的自由文本 —— 拼错的表现是"发出去但没 @ 到人"
      mentions: [],
      idempotencyKey,
      dryRun: false,
    })

    /**
     * ★ 每次都写这张表 —— 成功与失败都写。
     *
     * 漏了它的后果不是"少一张审计表"，而是 policy 的频率限制**永远不触发**
     * （它读 `state = 'sent'` 的行）。而那是唯一防连发的一条。
     */
    runs.recordSendAttempt({
      idempotencyKey,
      draftId: draft.id,
      conversationId: draft.conversationId,
      targetKind: target.kind,
      /**
       * ★★ 记**真正发出去的那个**目标，不是会话 id。
       *
       * 曾经这里写 `conversation.externalId` —— 于是单聊的审计行记的是
       * `cid…`（会话 id），而实际传给 CLI 的是对端的 `openDingTalkId`。
       * 两个值不同，而这张表的**唯一用途**就是事后追"这条发给了谁"。
       * 实测踩到过一行自相矛盾的审计：`target_kind=open_id` 而
       * `target_external_id=cid…` —— 声称"按人发"却记了个会话 id。
       *
       * 会话 id 并没有丢：它就在同一行的 `conversation_id` 列里。
       */
      targetExternalId: target.externalId,
      atExternalIds: [],
      contentHash: hash,
      grantId: grantAtAttempt?.id ?? null,
      state:
        outcome.state === "sent"
          ? "sent"
          : outcome.state === "blocked_no_grant"
            ? "blocked_no_grant"
            : "failed",
      sentMessageExternalId: outcome.sentExternalId ?? null,
      /**
       * ★ taskId 也落库 —— 换消息 id 那一跳失败时它是唯一的线索。
       * `send` 只返回 `openTaskId`，消息 id 要再走 `query-send-status`。
       */
      sendTaskId: outcome.sentTaskId ?? null,
      usedDryRun: outcome.state === "short_circuited",
      error: outcome.reason ?? null,
      attemptedAt,
      // 只有真发成功才填 —— 频率判定读的正是这一列
      sentAt: outcome.state === "sent" ? this.options.clock.now() : null,
      source,
    })

    /**
     * ★ 真发成功 → 让数据面定向补拉这个会话。
     *
     * 用 `conversation.externalId`（数据面按它找会话）。只在 `sent` 时触发：
     * 失败/短路时没有新消息要拉。**同步 fire-and-forget** —— 补拉的成败
     * 不该阻塞或影响发送结果的返回。
     */
    if (outcome.state === "sent") {
      this.options.onSent?.(conversation.externalId)
    }

    return outcome.reason === undefined
      ? { state: outcome.state }
      : { state: outcome.state, reason: outcome.reason }
  }

  /**
   * 发送目标：群聊用 `--group <openConversationId>`，单聊用对端的 openDingTalkId。
   *
   * ## ★ 单聊**不能**用 `conversations.external_id`
   *
   * 实测本库 52 个单聊：`external_id` 是 `cid…`（47 字符，**会话** id），
   * 而对端 openDingTalkId 是 `D…`（33-34 字符）。传错的表现不是发错人，
   * 而是服务端回「单聊时 receiverUid 不能为空」：它没把 cid 认成一个人，
   * 于是点「发送」100% 失败，且错误信息指向一个我们压根没传的参数名。
   *
   * 查不到 → 返回 null 直接失败，**不退回用 cid 猜**：那只会把一个明确的
   * "找不到对端"变回刚才那个含义不明的服务端报错。
   */
  private resolveTarget(
    conversations: ConversationRepository,
    conversationId: string,
    conversationType: string,
  ): { kind: "group" | "open_id"; externalId: string } | null {
    if (conversationType === "group") {
      const row = conversations.findById(conversationId)
      const externalId = row?.externalId ?? ""
      return externalId === "" ? null : { kind: "group", externalId }
    }
    const peer = conversations.findPeerExternalId(conversationId)
    return peer === null || peer === "" ? null : { kind: "open_id", externalId: peer }
  }

  /**
   * 造一个 GrantManager。
   *
   * `downgradeToDraft` 是必填回调：授权失效时**立刻**把该会话降回只出草稿。
   * 不接的话授权过期后那个会话会一直尝试自动发、一直失败 —— 而用户看到的
   * 是"数字人不回了"，看不出是授权问题。
   */
  private grantManager(db: SqliteDatabase): GrantManager {
    return new GrantManager({
      db,
      clock: this.options.clock,
      logger: this.options.logger.child("Grant"),
      downgradeToDraft: (conversationId, reason) => {
        new PersonaConfigRepository(db).upsert(
          conversationId,
          { replyMode: "draft" },
          this.options.clock.now(),
        )
        this.options.logger.warn("conversation downgraded to draft", { conversationId, reason })
        this.options.onDowngrade?.(conversationId, reason)
      },
    })
  }

  /**
   * 授权记录的读口 —— **唯一一处** `GrantManager` 装配。
   *
   * ## ★ 为什么由 delivery 提供，而不是接线层再造一个
   *
   * guard 判 policy 时要读授权（`grant_missing` / `grant_expired` 是两条不同的
   * reason），而真发时 `SendGuard` 也要读。两处曾各造一个 `GrantManager`，
   * 装配代码逐字重复 —— 包括那个**必填**的 `downgradeToDraft` 回调。
   *
   * 重复的代价不是多几行：漏配那个回调的表现是**授权过期后该会话一直尝试
   * 自动发、一直失败**，而用户看到的是"数字人不回了"，看不出是授权问题。
   * 一处装配就不可能漏。
   *
   * 返回整个 manager 而不只是 `get()`：policy 要的是**整行**
   * （`requireValid()` 把"过期"与"从未授权"都压成 null，而那两者对用户的
   * 意义不同 —— 前者是「去续一下」，后者是「还没授过」）。
   */
  grants(db: SqliteDatabase): GrantManager {
    return this.grantManager(db)
  }

  /** 新草稿 id。抽出来只是为了让调用点不各 import 一次 crypto。 */
  newDraftId(): string {
    return randomUUID()
  }
}
