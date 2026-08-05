/**
 * LLM 客户端 + map 阶段的**真实调用**核验（会真的花钱，不进门禁）。
 *
 * 为什么必须有这一条：单测用注入的假 fetch，证明的是"我们按自己以为的
 * 形状处理响应"。而这个网关的实测行为与 OpenAI 文档**不一致**：
 * · 开了 `response_format: json_object` 仍可能返回 ```json 围栏包裹的内容；
 * · 响应里多一个 `reasoning_content`（思考过程，不是答案）。
 * 这两条只有真调才知道。接口一变，这里第一时间红。
 *
 * 语料用真实 vault 里的消息（上一轮回溯落库的 9541 条里取一小批）：
 * "抽取质量"这件事在造的语料上看不出任何东西。
 */
import { existsSync } from "node:fs"
import { LlmClient } from "@mycontext/llm"
import { createLogger } from "@mycontext/kernel"
import {
  ConversationRepository,
  MessageRepository,
  openStore,
  VAULT_MIGRATIONS,
  type ConversationRow,
} from "@mycontext/store"
import {
  assertHasEvidence,
  filterDistillable,
  mapFacetWithLlm,
  routineCandidates,
} from "@mycontext/distill"

export interface MapCheckReport {
  /** 语料规模 */
  windowMessages: number
  accepted: number
  rejected: Record<string, number>
  selfMessageCount: number
  conversationCount: number
  /** 统计侧（不调模型） */
  statCandidates: number
  statKeys: string[]
  /** LLM 侧 */
  llmCalls: number
  llmCandidates: number
  droppedNoEvidence: number
  droppedBadShape: number
  /** 每条结论的证据条数（全部 > 0 才算通过守卫） */
  minEvidence: number
  /** 抽出来的结论（人看一眼就知道质量） */
  sample: { key: string; value: string; confidence: number; evidence: number }[]
  tokens: { prompt: number; completion: number; total: number }
  elapsedMs: number
}

export async function runMapCheck(options: {
  dbPath: string
  baseUrl: string
  apiKey: string
  model: string
  /** 取多少条消息（默认 80 —— 够抽出东西，又不至于烧太多） */
  limit?: number
  /** 往前多少天 */
  days?: number
  now: () => number
}): Promise<MapCheckReport> {
  if (!existsSync(options.dbPath)) throw new Error(`vault 不存在：${options.dbPath}`)

  const handle = openStore({ path: options.dbPath, migrations: VAULT_MIGRATIONS })
  const logger = createLogger("MapCheck", { level: "warn" })

  try {
    const limit = options.limit ?? 80
    const end = options.now()
    const start = end - (options.days ?? 30) * 86_400_000

    const messageRepo = new MessageRepository(handle.db)
    const windowMessages = messageRepo.distillableInWindow({ start, end, limit })

    // 会话表：守卫要读 is_bot_channel，装配 prompt 要读 title
    const conversationRepo = new ConversationRepository(handle.db)
    const conversationById = new Map<string, ConversationRow>()
    for (const message of windowMessages) {
      if (conversationById.has(message.conversationId)) continue
      const row = conversationRepo.findById(message.conversationId)
      if (row !== null) conversationById.set(message.conversationId, row)
    }

    // ★ 走真正的守卫，不是自己写一遍过滤 —— 那样测的就不是生产路径了
    const { accepted, rejected } = filterDistillable(windowMessages, conversationById)

    const selfNames = handle.db
      .prepare<[], { display_names_json: string }>(
        "SELECT display_names_json FROM channel_self_identity LIMIT 1",
      )
      .all()
      .flatMap((raw) => JSON.parse(raw.display_names_json) as string[])

    const startedAt = options.now()

    // ── 统计侧：不调模型 ────────────────────────────────────────────
    const stats = routineCandidates(accepted, { offsetMinutes: 8 * 60 })
    for (const candidate of stats) assertHasEvidence(candidate)

    // ── LLM 侧：真调 ────────────────────────────────────────────────
    const client = new LlmClient({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model,
      logger,
      concurrency: 2,
    })

    const result = await mapFacetWithLlm(
      "tone",
      accepted,
      conversationById,
      { scope: "global", scopeRef: "" },
      { client, selfNames, batchSize: limit },
    )
    // 守卫也要真跑：它是"无证据不入库"的落点
    for (const candidate of result.candidates) assertHasEvidence(candidate)

    const usage = client.usage()
    return {
      windowMessages: windowMessages.length,
      accepted: accepted.length,
      rejected,
      selfMessageCount: accepted.filter((message) => message.isSelf === true).length,
      conversationCount: conversationById.size,
      statCandidates: stats.length,
      statKeys: stats.map((candidate) => candidate.key),
      llmCalls: result.calls,
      llmCandidates: result.candidates.length,
      droppedNoEvidence: result.droppedNoEvidence,
      droppedBadShape: result.droppedBadShape,
      minEvidence:
        result.candidates.length === 0
          ? 0
          : Math.min(...result.candidates.map((candidate) => candidate.evidence.length)),
      sample: result.candidates.slice(0, 8).map((candidate) => ({
        key: candidate.key,
        value: String(
          typeof candidate.value === "string" ? candidate.value : JSON.stringify(candidate.value),
        ).slice(0, 140),
        confidence: candidate.confidence,
        evidence: candidate.evidence.length,
      })),
      tokens: {
        prompt: usage.promptTokens,
        completion: usage.completionTokens,
        total: usage.totalTokens,
      },
      elapsedMs: options.now() - startedAt,
    }
  } finally {
    handle.close()
  }
}
