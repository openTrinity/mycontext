/**
 * `persona-inbox` 消费者：新消息投给数字人管控层。
 *
 * ## 为什么消费者只**投递**，不处理
 *
 * 与 distill 消费者同一个理由：handler 持着租约，而处理一轮是几秒到几十秒的
 * agent 调用。在这里跑会让租约过期 → 被抢占 → 同一条消息被处理两遍
 * → **可能重复发送**（这是不可逆的社交后果，比重复花钱严重）。
 *
 * 所以这里只做准入判断 + 入队（都是本地、毫秒级）。真正的调度由
 * `PersonaSupervisor.tick()` 由定时器驱动 —— 那里还有合并窗口需要"等一下"。
 *
 * ## ★ `required: false`
 *
 * 与 distill 相反：数字人落后时**允许**裁剪历史。理由是"丢了要不要补" ——
 * 一条三天前没回的消息，现在回也没意义了；而画像的语料丢了是永久损失。
 * 把它设成 true 会让数字人一旦停用就阻塞整个保留策略。
 */
import type { Clock, Logger } from "@mycontext/kernel"
import {
  AttentionRouter,
  ConversationRepository,
  MessageRepository,
  PersonaConfigRepository,
  type ChangelogRow,
  type SqliteDatabase,
} from "@mycontext/store"
import type { PersonaSupervisor } from "./supervisor.js"

export const PERSONA_CONSUMER_ID = "persona-inbox"

export interface PersonaHandlerOptions {
  db: SqliteDatabase
  clock: Clock
  supervisor: PersonaSupervisor
  logger?: Logger
  /** Only these channels may enter Persona. Omit to preserve the legacy all-channel behaviour. */
  channelIds?: readonly string[]
}

/**
 * 两条通路共用的仓储集合。
 *
 * ★ 含 `router` —— 路由必须在**这里**而不是在各自的调用点：见
 * `deliverMessage` 里那段 ★★★。
 */
interface DeliveryRepos {
  messages: MessageRepository
  conversations: ConversationRepository
  configs: PersonaConfigRepository
  router: AttentionRouter
}

/**
 * 造一批共用的仓储实例。
 *
 * ★ 共用而不是每条 new：`prepare` 的语句缓存因此有效。逐条投递时
 * 这不是微优化 —— 回溯 20 万条时每条都重建 statement 是分钟级的差别。
 */
function createRepos(options: PersonaHandlerOptions): DeliveryRepos {
  return {
    messages: new MessageRepository(options.db),
    conversations: new ConversationRepository(options.db),
    configs: new PersonaConfigRepository(options.db),
    router: new AttentionRouter(options.db, options.clock),
  }
}

/**
 * 把**一条**消息投给 supervisor（含**路由** + 准入判断）。返回是否被接纳。
 *
 * ## ★ 为什么单独抽出来
 *
 * 有两条通路会送来消息：
 * · **快通道** —— 入库后的进程内事件（`inbound.message`），毫秒级；
 * · **慢兜底** —— Outbox 消费者扫 changelog（崩溃/漏事件时补上）。
 *
 * 两条路必须走**同一段**判据。各写一遍的话"快通道收了、慢兜底拒了"
 * 这种不一致会极难发现：两边都不报错，只是行为不同。
 *
 * 去重在 `Mailbox.push`（按 message_id），所以两条路重叠是安全的。
 *
 * ## ★★★ 路由在这里，不在调用点
 *
 * 改动前路由只在**快通道的调用点外面**（`ingest.service.ts` 的
 * `inbound.message` 回调里），于是慢兜底整条**绕过监听范围** ——
 * 用户勾的那个范围在那条路上不生效。而慢兜底恰恰是真机上主要生效的那条
 * （快通道要求 `changed.length > 0`，而本机历史早已采完）。
 *
 * 放在这个函数里的判据是：**这是两条路唯一的交汇点**。任何新增的第三条
 * 投递路径也必然要经过它，所以"忘了加路由"在结构上不可能。
 *
 * ## ★★ 路由与 `admit()` 仍然分开（下沉的是"在哪调"，不是"合并成一个"）
 *
 * | 谁 | 问的是 | 变了会怎样 |
 * |---|---|---|
 * | 路由 | 这条消息属于分身的关心范围吗 | 不属于 → 根本不该进管控层 |
 * | admit | 这条消息现在该触发一次回复吗 | 不该 → 进了但被丢弃，有理由可查 |
 *
 * 混成一个 reason 会让"范围外"和"暂时不回"用同一句话表达，而它们一个是
 * 配置问题、一个是时机问题 —— 用户排查时需要的正是这个区别。
 */
export function deliverMessage(
  options: PersonaHandlerOptions,
  repos: DeliveryRepos,
  messageId: string,
): boolean {
  const message = repos.messages.findById(messageId)
  if (message === null) return false
  const conversation = repos.conversations.findById(message.conversationId)
  if (conversation === null) return false
  if (options.channelIds !== undefined && !options.channelIds.includes(conversation.channelId)) {
    return false
  }

  /**
   * ★★★ 路由闸：先判「这个会话我管不管」，再判「现在该不该回」。
   *
   * 顺序有理由：路由是**配置**问题（一次 `count(*)` + 一次主键查询，便宜），
   * 而下面那三条准入前置要 3 次带子查询的 SQL。范围外的消息在这里就该走，
   * 没有理由为它去查 `message_mentions` 与"对方后来有没有又说话"。
   */
  const route = repos.router.route({
    channelId: conversation.channelId,
    conversationExternalId: conversation.externalId,
    sentAt: message.sentAt,
  })
  if (!route.routed) {
    options.logger?.debug("persona route skipped", { reason: route.reason })
    return false
  }

  /**
   * 「@我」从 message_mentions 读，而不是重新解析正文。
   *
   * 解析在 channels 层做过一次（含花名匹配与全角括号那些边界），
   * 这里再解析一遍就有两处定义，早晚不一致。
   */
  const mentioned =
    options.db
      .prepare<
        [string],
        { c: number }
      >("SELECT count(*) AS c FROM message_mentions WHERE message_id = ? AND is_self = 1")
      .get(message.id)?.c ?? 0
  const readSnapshot = options.db
    .prepare<[string, string], { unread_count: number | null; observed_at: number }>(
      `SELECT unread_count, observed_at
         FROM probe_snapshots
        WHERE channel_id = ? AND conversation_external_id = ?`,
    )
    .get(conversation.channelId, conversation.externalId)
  const turnAnswered =
    options.db
      .prepare<[string, number], { answered: number }>(
        `SELECT EXISTS (
           SELECT 1
             FROM messages reply
            WHERE reply.conversation_id = ?
              AND reply.is_self = 1
              AND reply.sent_at > ?
         ) AS answered`,
      )
      .get(message.conversationId, message.sentAt)?.answered === 1

  return options.supervisor.onInbound({
    message,
    conversation,
    config: repos.configs.get(message.conversationId),
    mentionsSelf: mentioned > 0,
    conversationExclusion: repos.conversations.personaExclusionReason(conversation.id),
    conversationRead:
      readSnapshot?.unread_count === 0 && readSnapshot.observed_at >= message.sentAt,
    turnAnswered,
  })
}

/**
 * 把一批变更投给 supervisor。
 *
 * ## ★★★ 这是**唯一**的投递入口（v4 §4）
 *
 * 改动前还有一条"快通道"（`createPersonaFastPath`，挂在 `IngestService`
 * 的 `inbound.message` 事件上）。它已删 —— 理由：
 *
 * · 消费者循环就在 `runPull` / `refreshConversation` 的**末尾同栈**，
 *   所以快通道领先的只是几十毫秒；
 * · 而两条路的代价是一个**永久的**维护负担（判据会不会分叉）——
 *   那不是假想：v2 修过一次真事故，路由原来只挂快通道，
 *   慢兜底整条绕过监听范围。
 *
 * ★ 现在 `deliverMessage` 只有这一个调用者，"忘了加某道闸"
 * 在结构上不可能。
 *
 * ## 返回值的语义
 *
 * `processed` 是**接纳数**而不是"看过的条数"：被路由或准入闸挡掉的
 * 算 skipped。这样状态页上的"处理了 N 条"就是"真的进队列的 N 条"，
 * 而不是一个虚高的数字。
 */
export function createPersonaInboxHandler(options: PersonaHandlerOptions) {
  const repos = createRepos(options)

  return (batch: readonly ChangelogRow[]): { processed: number; skipped: number } => {
    let processed = 0
    let skipped = 0

    for (const entry of batch) {
      if (entry.entityType !== "message" || entry.op === "delete") {
        skipped += 1
        continue
      }
      if (deliverMessage(options, repos, entry.entityId)) processed += 1
      else skipped += 1
    }

    if (processed > 0) {
      options.logger?.info("persona inbox enqueued", { processed, skipped })
    }
    return { processed, skipped }
  }
}
