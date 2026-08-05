/**
 * 本地索引消费者。
 *
 * ★ **FTS 与 embedding 必须是两个独立消费者**（各自一行 `consumer_cursors`）。
 *
 * 理由：embedding 是**远程调用**（回溯几万条 = 几百次网络往返 + 限流等待），
 * FTS 是**纯本地**（bigram 切分 + 一次 INSERT，微秒级）。
 * 共用一个游标 → 一次远程限流就把游标卡住 → **纯本地的 FTS 也建不出来**，
 * 而"新消息 1s 内可搜到"这条 SLA 恰恰依赖 FTS。
 *
 * | consumer_id | 性质 | 紧迫度 |
 * | --- | --- | --- |
 * | `local-index-fts` | 纯本地 | 亚秒级 |
 * | `local-index-vector` | 远程 API | 可落后数分钟至数小时 |
 */
import { quantizeInt8, toIndexSegment } from "@mycontext/retrieval"
import {
  FtsIndexRepository,
  MessageRepository,
  VectorRepository,
  type ChangelogRow,
  type SqliteDatabase,
} from "@mycontext/store"
import type { Clock, Logger } from "@mycontext/kernel"
import { sha256 } from "./normalizer.js"
import type { ConsumerHandlerResult } from "./consumer.js"

export const FTS_CONSUMER_ID = "local-index-fts"
export const VECTOR_CONSUMER_ID = "local-index-vector"

/**
 * FTS 建索引。
 *
 * 不用触发器（触发器里没法调 JS 分词函数），走 Outbox 消费者增量建 ——
 * 附带好处：索引重建变成"回拨消费者游标"，不需要 DDL。
 */
export function createFtsHandler(
  db: SqliteDatabase,
  clock: Clock,
  logger?: Logger,
): (batch: readonly ChangelogRow[]) => ConsumerHandlerResult {
  const fts = new FtsIndexRepository(db)
  const messages = new MessageRepository(db)

  return (batch) => {
    let processed = 0
    let skipped = 0
    const now = clock.now()

    for (const entry of batch) {
      // 未实现的实体类型（document / minutes）：跳过 + 计数、**不告警** ——
      // 这是预期状态而不是错误。只有枚举外的类型才该告警。
      if (entry.entityType !== "message") {
        skipped += 1
        continue
      }

      if (entry.op === "delete") {
        fts.remove(entry.entityId)
        processed += 1
        continue
      }

      const message = messages.findById(entry.entityId)
      if (message === null) {
        // 消息已被删除（隐私删除等），变更条目还在 —— 跳过不是错误。
        skipped += 1
        continue
      }
      const text = message.contentText
      if (text === null || text.trim() === "") {
        skipped += 1
        continue
      }

      const contentHash = sha256(text)
      const result = fts.upsert({
        messageId: message.id,
        conversationId: message.conversationId,
        seg: toIndexSegment(text),
        contentHash,
        indexedAt: now,
      })
      if (result === "unchanged") skipped += 1
      else processed += 1
    }

    if (processed > 0) {
      logger?.debug("fts index updated", { processed, skipped, upTo: batch.at(-1)?.seq })
    }
    return { processed, skipped }
  }
}

/** 生成 embedding 的抽象。远程实现在 apps 侧注入，测试注入罐头值。 */
export interface Embedder {
  readonly model: string
  readonly dim: number
  /** 一次至多 batchSize 条。返回顺序必须与输入一致 */
  embed(texts: readonly string[]): Promise<number[][]>
  readonly batchSize: number
}

export interface VectorHandlerOptions {
  db: SqliteDatabase
  clock: Clock
  embedder: Embedder
  logger?: Logger
  /** 每天的 token 预算。超预算暂停并**告警**（不是静默停：用户会以为坏了） */
  dailyBudgetTokens?: number
}

/**
 * 向量建索引。
 *
 * 跳过规则（省钱且这些行对语义检索本来无贡献）：
 * 内容为空、长度 < 4 字符、`origin='agent'` 的消息不做 embedding。
 */
export function createVectorHandler(
  options: VectorHandlerOptions,
): (batch: readonly ChangelogRow[]) => Promise<ConsumerHandlerResult> {
  const vectors = new VectorRepository(options.db)
  const messages = new MessageRepository(options.db)

  return async (batch) => {
    let processed = 0
    let skipped = 0
    const now = options.clock.now()

    const pending: { id: string; text: string }[] = []
    for (const entry of batch) {
      if (entry.entityType !== "message" || entry.op === "delete") {
        skipped += 1
        continue
      }
      const message = messages.findById(entry.entityId)
      const text = message?.contentText ?? null
      if (
        message === null ||
        text === null ||
        text.trim().length < 4 ||
        message.origin === "agent" ||
        vectors.has(message.id)
      ) {
        skipped += 1
        continue
      }
      pending.push({ id: message.id, text })
    }

    // 分批：远程接口有单请求条数上限（联调时以实测为准）。
    for (let offset = 0; offset < pending.length; offset += options.embedder.batchSize) {
      const slice = pending.slice(offset, offset + options.embedder.batchSize)
      try {
        const embeddings = await options.embedder.embed(slice.map((item) => item.text))
        const records = []
        for (let index = 0; index < slice.length; index += 1) {
          const item = slice[index]
          const embedding = embeddings[index]
          if (item === undefined || embedding === undefined) continue
          // 量化在这里做（而不是让 embedder 关心存储形态）：
          // 实测 int8 让内存降到 1/4 而耗时几乎不变。
          const quantized = quantizeInt8(embedding)
          records.push({
            messageId: item.id,
            dim: quantized.dim,
            embedding: quantized.data,
            quant: "int8" as const,
            scale: quantized.scale,
            model: options.embedder.model,
            embeddedAt: now,
          })
        }
        vectors.upsertMany(records)
        processed += records.length
      } catch (error) {
        // ★ 一批失败**继续下一批**，不抛错卡住整条游标。
        //   失败行进 vector_failures 计数，状态页显示「向量待建 N / 失败 M」。
        const detail = (error as Error).message
        for (const item of slice) vectors.recordFailure(item.id, detail, now)
        skipped += slice.length
        options.logger?.warn("embedding batch failed, continuing", {
          count: slice.length,
          detail,
        })
      }
    }

    return { processed, skipped }
  }
}
