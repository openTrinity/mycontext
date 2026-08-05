/**
 * 入库：规范表与 Outbox 在**同一个事务**里写。
 *
 * 这是整条增量链路的核心不变式：「数据可见 ⇔ 变更可见」。
 * 破了它之后消费者会读到 seq 却查不到实体（先写 Outbox 后崩溃），
 * 或永久漏掉变更（先写规范表后崩溃）—— 两者都表现为
 * 「数据看起来采到了，实际缺一段」，而且没有任何东西会报错。
 *
 * 所以这一层只暴露**一个组合函数**，不暴露"只写消息"或"只写 Outbox"的入口。
 */
import type { Clock, Logger } from "@mycontext/kernel"
import {
  ActorRepository,
  ChangelogRepository,
  ConversationRepository,
  MessageRepository,
  MinutesRepository,
  DocumentRepository,
  RawRecordRepository,
  withTransaction,
  type MessageRow,
  type MinutesInput,
  type DocumentInput,
  type DocumentRow,
  type MinutesRow,
  type RawRecordInput,
  type SqliteDatabase,
} from "@mycontext/store"
import {
  newId,
  toChangelogEntry,
  toMinutesChangelogEntry,
  toDocumentChangelogEntry,
  type NormalizedBatch,
} from "./normalizer.js"

export interface PersistResult {
  /** 真正变化的消息（快通道要投给数字人的就是这些） */
  changed: MessageRow[]
  /** 因内容一致被跳过的条数（重叠窗口下这个数会很大，这是正常的） */
  unchanged: number
  /** 新增的原生记录条数 */
  rawInserted: number
  /** 写入的 Outbox seq 列表 */
  seqs: number[]
}

export interface PersistDeps {
  db: SqliteDatabase
  clock: Clock
  logger?: Logger
}

/**
 * 落库一个批次。
 *
 * 步骤顺序有讲究：
 * ① raw：先落原生，让后续所有行都能引用它（解析 bug 时可重放）；
 * ② conversations / actors：消息的外键前置；
 * ③ messages：拿回"真正变了哪些"；
 * ④ changelog：**只为变化的消息**发变更 —— 重叠窗口不该产生无意义的 seq，
 *    否则下游（建索引/蒸馏/图谱）会每轮照单全收地重算。
 */
export function persistBatch(deps: PersistDeps, batch: NormalizedBatch): PersistResult {
  const { db, clock } = deps

  return withTransaction(db, () => {
    const raws = new RawRecordRepository(db)
    const conversations = new ConversationRepository(db)
    const actors = new ActorRepository(db)
    const messages = new MessageRepository(db)
    const changelog = new ChangelogRepository(db)
    const now = clock.now()

    const rawResult = raws.insertMany(batch.raw)
    // 重复内容时取已有行的 id：消息仍应指向那条原生记录。
    const rawRecordId =
      rawResult.inserted[0] ??
      (batch.raw[0] === undefined
        ? null
        : raws.findId(
            batch.raw[0].channelId,
            batch.raw[0].resource,
            batch.raw[0].externalId,
            batch.raw[0].payloadHash,
          ))

    for (const conversation of batch.conversations) {
      conversations.upsert(conversation)
    }

    // 会话的真实内部 id：可能是刚插的，也可能是库里早就有的那行。
    const resolvedConversationIds = new Map<string, string>()
    for (const conversation of batch.conversations) {
      const stored = conversations.findByExternalId(conversation.channelId, conversation.externalId)
      if (stored !== null) resolvedConversationIds.set(conversation.externalId, stored.id)
    }

    const messageInputs = []
    for (const message of batch.messages) {
      // batch 里存的是外部 id（规范化是纯函数，查不了库）
      const conversationId = resolvedConversationIds.get(message.conversationId)
      if (conversationId === undefined) {
        // 会话解析不出来的消息只能丢：没有外键就无法安全入库。
        // 记日志而不是静默跳过 —— 这种情况说明解析层漏了什么。
        deps.logger?.warn("message dropped: conversation not resolved", {
          externalId: message.externalId,
          conversationExternalId: message.conversationId,
        })
        continue
      }

      // 发送者进 actors（消息可能先到、通讯录后拉，所以这里只建最小行）
      if (message.senderExternalId !== null && message.senderExternalId !== undefined) {
        actors.upsert({
          id: newId(now),
          channelId: message.channelId,
          externalId: message.senderExternalId,
          kind: "user",
          displayName: message.senderDisplayName ?? null,
          isSelf: message.isSelf === true,
          seenAt: message.sentAt,
        })
      }

      messageInputs.push({
        ...message,
        conversationId,
        rawRecordId,
      })
    }

    const upserted = messages.upsertMany(messageInputs)

    // ★ 同事务：只为真正变化的消息发变更条目。
    const seqs = changelog.append(
      upserted.changed.map((row) => toChangelogEntry(row, now, rawRecordId ?? undefined)),
    )

    return {
      changed: upserted.changed,
      unchanged: upserted.unchanged,
      rawInserted: rawResult.inserted.length,
      seqs,
    }
  })
}

export interface PersistMinutesResult {
  changed: MinutesRow[]
  unchanged: number
  rawInserted: number
  seqs: number[]
}

/**
 * 落库一批听记 —— 原生记录、规范表、Outbox 在**同一个事务**里。
 *
 * 与 `persistBatch` 同一个不变式（「数据可见 ⇔ 变更可见」），
 * 所以同样只暴露组合函数，不暴露"只写 minutes"的入口。
 *
 * 与消息不同的一点：听记**没有会话外键**，所以不需要那套两步解析
 * （先 upsert 会话拿内部 id 再替换）。这让这个函数比 persistBatch 短得多。
 */
export function persistMinutes(
  deps: PersistDeps,
  batch: {
    raw: RawRecordInput[]
    minutes: MinutesInput[]
  },
): PersistMinutesResult {
  const { db, clock } = deps

  return withTransaction(db, () => {
    const raws = new RawRecordRepository(db)
    const minutes = new MinutesRepository(db)
    const changelog = new ChangelogRepository(db)
    const now = clock.now()

    const rawResult = raws.insertMany(batch.raw)
    const rawRecordId =
      rawResult.inserted[0] ??
      (batch.raw[0] === undefined
        ? null
        : raws.findId(
            batch.raw[0].channelId,
            batch.raw[0].resource,
            batch.raw[0].externalId,
            batch.raw[0].payloadHash,
          ))

    const upserted = minutes.upsertMany(
      batch.minutes.map((item) => ({ ...item, rawRecordId: rawRecordId ?? null })),
    )

    // 同事务：只为真正变化的听记发变更条目。
    const seqs = changelog.append(
      upserted.changed.map((row) => toMinutesChangelogEntry(row, now, rawRecordId ?? undefined)),
    )

    return {
      changed: upserted.changed,
      unchanged: upserted.unchanged,
      rawInserted: rawResult.inserted.length,
      seqs,
    }
  })
}

export interface PersistDocumentsResult {
  changed: DocumentRow[]
  unchanged: number
  rawInserted: number
  seqs: number[]
}

/**
 * 落库一批文档 —— 原生记录、规范表、Outbox 在**同一个事务**里。
 *
 * 与 `persistBatch` / `persistMinutes` 同一个不变式（「数据可见 ⇔ 变更可见」），
 * 所以同样只暴露组合函数，不暴露"只写 documents"的入口。
 *
 * 与听记一样**没有会话外键**，所以不需要那套两步解析（先 upsert 会话拿
 * 内部 id 再替换）—— 这让这个函数比 `persistBatch` 短得多。
 *
 * ★ 用同一个函数处理「列元信息」与「补正文」两步：两者的差别只是
 * `contentText` 有没有值，而 upsert 的 COALESCE 已经保证了
 * 「列举轮次不会抹掉已取到的正文」（见 `DocumentRepository` 注释）。
 * 各写一个函数的话，那条 COALESCE 语义会有两处可以漂。
 */
export function persistDocuments(
  deps: PersistDeps,
  batch: {
    raw: RawRecordInput[]
    documents: DocumentInput[]
  },
): PersistDocumentsResult {
  const { db, clock } = deps

  return withTransaction(db, () => {
    const raws = new RawRecordRepository(db)
    const documents = new DocumentRepository(db)
    const changelog = new ChangelogRepository(db)
    const now = clock.now()

    const rawResult = raws.insertMany(batch.raw)
    const rawRecordId =
      rawResult.inserted[0] ??
      (batch.raw[0] === undefined
        ? null
        : raws.findId(
            batch.raw[0].channelId,
            batch.raw[0].resource,
            batch.raw[0].externalId,
            batch.raw[0].payloadHash,
          ))

    const upserted = documents.upsertMany(
      batch.documents.map((item) => ({ ...item, rawRecordId: rawRecordId ?? null })),
    )

    // 同事务：只为真正变化的文档发变更条目。
    const seqs = changelog.append(
      upserted.changed.map((row) => toDocumentChangelogEntry(row, now, rawRecordId ?? undefined)),
    )

    return {
      changed: upserted.changed,
      unchanged: upserted.unchanged,
      rawInserted: rawResult.inserted.length,
      seqs,
    }
  })
}
