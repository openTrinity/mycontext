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
}

/**
 * 把**一条**消息投给 supervisor（含准入判断）。返回是否被接纳。
 *
 * ## ★ 为什么单独抽出来
 *
 * 有两条通路会送来消息：
 * · **快通道** —— 入库后的进程内事件（`inbound.message`），毫秒级；
 * · **慢兜底** —— Outbox 消费者扫 changelog（崩溃/漏事件时补上）。
 *
 * 两条路必须走**同一段**准入逻辑。各写一遍的话"快通道收了、慢兜底拒了"
 * 这种不一致会极难发现：两边都不报错，只是行为不同。
 *
 * 去重在 `Mailbox.push`（按 message_id），所以两条路重叠是安全的。
 */
export function deliverMessage(
  options: PersonaHandlerOptions,
  repos: {
    messages: MessageRepository
    conversations: ConversationRepository
    configs: PersonaConfigRepository
  },
  messageId: string,
): boolean {
  const message = repos.messages.findById(messageId)
  if (message === null) return false
  const conversation = repos.conversations.findById(message.conversationId)
  if (conversation === null) return false

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
 * 快通道投递器：给 `IngestService` 的 `inbound.message` 事件用。
 *
 * 与消费者共用 `deliverMessage`，也共用同一批仓储实例（`prepare` 的
 * 语句缓存因此有效 —— 逐条投递时这一点不是微优化：回溯 20 万条时
 * 每条都重建 statement 会是分钟级的差别）。
 */
export function createPersonaFastPath(
  options: PersonaHandlerOptions,
): (messageId: string) => boolean {
  const repos = {
    messages: new MessageRepository(options.db),
    conversations: new ConversationRepository(options.db),
    configs: new PersonaConfigRepository(options.db),
  }
  return (messageId) => deliverMessage(options, repos, messageId)
}

/**
 * 把一批变更投给 supervisor。
 *
 * 返回的 `processed` 是**接纳数**而不是"看过的条数"：被准入闸挡掉的
 * 算 skipped。这样状态页上的"处理了 N 条"就是"真的进队列的 N 条"，
 * 而不是一个虚高的数字。
 *
 * ★ 与快通道共用 `deliverMessage` —— 两条路的准入逻辑只有一份。
 */
export function createPersonaInboxHandler(options: PersonaHandlerOptions) {
  const repos = {
    messages: new MessageRepository(options.db),
    conversations: new ConversationRepository(options.db),
    configs: new PersonaConfigRepository(options.db),
  }

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
