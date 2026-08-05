/**
 * 数字人的**真实端到端**：投递 → 调度 → 出草稿（会花钱）。
 *
 * ## 走的是生产路径，不是重写一遍
 *
 * · `PersonaService.attach` → 真的 `PersonaSupervisor`（准入 6 种 drop reason、
 *   LRU、合并窗口）；
 * · `createPersonaInboxHandler` → 真的 Outbox 消费者（租约 / 游标 / 重放）；
 * · `handleBatch` → 真的 LLM 调用 + 真的 `evaluatePolicy` 8 条 + 真的落库。
 *
 * 重写一遍的话这个脚本"通了"也不代表应用里那条路通 —— 而那条路才是
 * 用户点开关时跑的东西。
 *
 * ## 判据是**草稿真的落库了**，不是"没报错"
 *
 * 准入闸命中任何一条都会静默丢弃（那是**正确行为**），
 * 所以"没报错 + 0 条草稿"是这条链路最可能的失败形态 ——
 * 与成功长得一模一样。
 */
import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { LlmClient, staticLlmProvider } from "@mycontext/llm"
import { createLogger, systemClock } from "@mycontext/kernel"
import { createPersonaInboxHandler } from "@mycontext/persona"
import { recallMessages, tokenize } from "@mycontext/retrieval"
import {
  ChangelogRepository,
  ConversationRepository,
  FtsIndexRepository,
  MessageRepository,
  PersonaConfigRepository,
  PersonaRunRepository,
  openStore,
  VAULT_MIGRATIONS,
} from "@mycontext/store"
import type { SqliteDatabase } from "@mycontext/store"
import { PersonaService } from "../apps/desktop/src/main/services/persona.service.js"
import {
  RECALL_TOOL,
  createRecallExecutor,
} from "../apps/desktop/src/main/services/persona-recall-tool.js"

export interface PersonaCheckReport {
  /** 选中的会话 */
  conversation: { id: string; title: string | null; kind: string; messageCount: number }
  /** 处理前后的快照 */
  before: { whitelist: number; pendingInbox: number; pendingDrafts: number }
  /** 消费者投递结果 */
  delivered: { processed: number; skipped: number }
  /** 调度结果 */
  dispatched: number
  skippedBusy: number
  after: { whitelist: number; pendingInbox: number; pendingDrafts: number }
  /** 落库的 run（含决策与原因） */
  runs: {
    decision: string
    decisionReason: string | null
    confidence: number | null
    error: string | null
  }[]
  /** 落库的草稿 */
  drafts: { text: string; notSentReason: string | null; citations: number }[]
  /** workspace 里物化了几个文件（画像有没有真的进去） */
  materializedFiles: number
  /** reply skill 有没有进 workspace（不进的话 agent 看不到它） */
  skillInstalled: boolean
  /**
   * agent 用了几次检索工具、跑了几轮。
   *
   * ★ 必须报出来：检索工具接错了（比如注册了但模型从没被给到、
   * 或者每次都返回空）的表现是"回复变笼统" —— 草稿照样出，
   * 没有任何报错。而 0 次调用与"这次确实不需要检索"长得一模一样，
   * 所以这两个数是唯一能区分它们的信息。
   */
  recall: { calls: number; rounds: number }
  /**
   * 检索工具**能不能被真网关调起来**的探针。
   *
   * ★ 为什么需要它：上面那个 `recall.calls` 常常是 0，而 0 有两个原因 ——
   * 「这轮不需要翻旧消息」（对）与「工具根本没接通」（错），两者
   * 在输出上完全一样。探针问一个**必须翻历史才能答**的问题，
   * 于是 0 就只剩一个解释了。
   *
   * `null` = 没配模型，没做这个探针。
   */
  toolProbe: { called: boolean; hits: number; isolated: boolean } | null
  agentAvailable: boolean
  elapsedMs: number
}

export async function runPersonaCheck(options: {
  dbPath: string
  workspaceRoot: string
  /** 随包分发的 skill 目录（reply skill 从这里复制进 workspace） */
  skillsDir: string
  baseUrl: string
  apiKey: string
  model: string
  /** 指定会话；不传则挑消息最多的那个群 */
  conversationId?: string
  now: () => number
}): Promise<PersonaCheckReport> {
  if (!existsSync(options.dbPath)) throw new Error(`vault 不存在：${options.dbPath}`)

  const handle = openStore({ path: options.dbPath, migrations: VAULT_MIGRATIONS })
  const baseLogger = createLogger("PersonaCheck", { level: "warn" })

  /**
   * 拦一条日志来读检索次数。
   *
   * 为什么不给 `PersonaService` 加一个"上次检索了几次"的字段：那会为了
   * 这个脚本在生产类型上开一个洞（而且是可变状态）。日志那行本来就有
   * `calls` 与 `rounds`，从这里读是**零侵入**的 —— 且如果哪天那行日志
   * 被删了，这个数会变成 0，脚本会报"检索一次都没发生"，
   * 也就是说这个耦合是**会被发现**的，不是静默的。
   */
  const recall = { calls: 0, rounds: 0 }
  const logger: typeof baseLogger = {
    ...baseLogger,
    info: (message, fields) => {
      if (message === "persona recalled history" && fields !== undefined) {
        recall.calls += typeof fields["calls"] === "number" ? fields["calls"] : 0
        recall.rounds = typeof fields["rounds"] === "number" ? fields["rounds"] : recall.rounds
      }
      baseLogger.info(message, fields)
    },
  }

  const llm =
    options.baseUrl === "" || options.apiKey === ""
      ? null
      : new LlmClient({
          baseUrl: options.baseUrl,
          apiKey: options.apiKey,
          model: options.model,
          logger,
          concurrency: 1,
        })

  const persona = new PersonaService({
    clock: systemClock,
    logger,
    // runtime 只在起 ACP session 时用到，当前实现走 LLM 直出，不碰它
    runtime: {} as never,
    workspaceRoot: options.workspaceRoot,
    // 与生产同一个 skill 目录：不传的话回复会退回内置指引（更平庸）
    skillsDir: options.skillsDir,
    llmProvider: staticLlmProvider(llm),
    getWindow: () => null,
  })

  const startedAt = options.now()
  try {
    persona.attach(handle.db)
    const supervisor = persona.inboundSupervisor
    if (supervisor === null) throw new Error("supervisor 未就绪（attach 失败）")

    /**
     * 挑一个**有他人消息**的会话。
     *
     * 准入闸会拒掉 `is_self = 1` 的消息（本人发的不需要数字人回），
     * 所以全是自己说话的会话跑不出任何东西 —— 那会让这个脚本
     * "成功地什么都没验"。
     */
    const picked =
      options.conversationId ??
      handle.db
        .prepare<[], { id: string }>(
          `SELECT c.id FROM conversations c
             JOIN messages m ON m.conversation_id = c.id
            WHERE c.is_bot_channel = 0 AND m.is_self = 0
                  AND m.content_text IS NOT NULL AND trim(m.content_text) <> ''
            GROUP BY c.id
            ORDER BY count(*) DESC
            LIMIT 1`,
        )
        .get()?.id
    if (picked === undefined)
      throw new Error("没有可用会话（需要至少一个含他人消息的非机器人会话）")

    const conversation = new ConversationRepository(handle.db).findById(picked)
    if (conversation === null) throw new Error(`会话不存在：${picked}`)
    const messageCount =
      handle.db
        .prepare<
          [string],
          { c: number }
        >("SELECT count(*) AS c FROM messages WHERE conversation_id = ?")
        .get(picked)?.c ?? 0

    const before = snapshotCounts(persona)

    /**
     * 触发条件设为 `all`。
     *
     * ★ 这里**不再**"开监听"（那个概念已删 —— 管控层收所有消息）。
     * 仍要显式设 `all`：这个账号的历史消息里「@我」只有 54 条，
     * 挑中的会话大概率一条都没有 —— 缺省的 `mention` 会让准入闸全拒
     * （`trigger_not_matched`），而那是**正确行为**，只是没验到后面的链路。
     */
    new PersonaConfigRepository(handle.db).upsert(
      picked,
      { replyMode: "draft", triggerMode: "all" },
      options.now(),
    )

    /**
     * 走真正的 Outbox 消费者投递。
     *
     * 从 changelog 里取该会话最近的变更 —— 那正是生产路径的输入
     * （`IngestService` 的 tick 里调的是同一个 handler）。
     */
    const handler = createPersonaInboxHandler({
      db: handle.db,
      clock: systemClock,
      supervisor,
      logger,
    })
    const changelog = new ChangelogRepository(handle.db)
    // 取最近 200 条变更，够覆盖一个活跃会话的近期消息
    const head = changelog.head()
    const batch = changelog.changesSince(Math.max(0, head - 200), 200)
    const delivered = handler(batch)

    /**
     * ★ 等过合并窗口再 tick。
     *
     * `Mailbox.takeBatch` 有 3 秒的合并窗口 —— 那是**刻意的**：群里
     * 连着来五条消息时该合成一轮回复，而不是回五次。
     * 投完立刻 tick 会拿到空批次（`dispatched: 0`），
     * 看起来像"调度没跑起来"，实际是没等够。
     *
     * 生产路径上不需要等（定时器 8 秒一轮，天然过了窗口），
     * 只有这个脚本因为"投完马上就要看结果"才需要显式睡一下。
     */
    await new Promise((resolve) => setTimeout(resolve, 3500))
    const scheduled = await persona.tick()

    const runs = new PersonaRunRepository(handle.db)
    const after = snapshotCounts(persona)

    // 物化的文件数：画像有没有真的进 workspace
    const materialized = handle.db
      .prepare<
        [string],
        { acp_cwd: string }
      >("SELECT acp_cwd FROM dh_agent_sessions WHERE conversation_id = ?")
      .get(picked)
    const materializedFiles = materialized === undefined ? 0 : countFiles(materialized.acp_cwd)
    /**
     * ★ 单独查 forge 的产物在不在。
     *
     * 只数总文件数的话，产物没复制进去也照样"有几个文件"（AGENTS.md）
     * —— 而缺产物的表现是"回复不像本人"，没有任何报错。
     *
     * 路径必须是 `.opencode/skills`（harness 按 cwd 发现，真进程实测锁定）。
     * 这里曾经查的是 `.claude/skills/reply/SKILL.md` —— 两处都错：那个
     * 目录名从来没被写过，而 `reply` skill 已经删掉了（唯一入口是
     * forge 的 `persona-persona`）。于是这个探针恒报 false，
     * 也就是它想防的那件事一次都没被它发现。
     */
    const skillInstalled =
      materialized !== undefined &&
      existsSync(join(materialized.acp_cwd, ".opencode", "skills", "persona-persona", "SKILL.md"))

    const toolProbe = llm === null ? null : await probeRecallTool(llm, handle.db, picked)

    return {
      conversation: {
        id: conversation.id,
        title: conversation.title,
        kind: conversation.type,
        messageCount,
      },
      before,
      delivered,
      dispatched: scheduled.dispatched,
      skippedBusy: scheduled.skippedBusy,
      after,
      runs: runs.recentRuns(picked, 10).map((run) => ({
        decision: run.decision,
        decisionReason: run.decisionReason,
        confidence: run.confidence,
        error: run.error,
      })),
      drafts: runs.pendingDrafts(10).map((draft) => ({
        text: draft.text.slice(0, 200),
        notSentReason: draft.notSentReason,
        citations: draft.citations.length,
      })),
      materializedFiles,
      skillInstalled,
      recall: { ...recall },
      toolProbe,
      agentAvailable: persona.agentAvailable(),
      elapsedMs: options.now() - startedAt,
    }
  } finally {
    await persona.detach()
    handle.close()
  }
}

function snapshotCounts(persona: PersonaService) {
  const snapshot = persona.snapshot()
  return {
    whitelist: snapshot.whitelistCount,
    pendingInbox: snapshot.pendingInbox,
    pendingDrafts: snapshot.pendingDrafts,
  }
}

/**
 * 探针：**真网关**能不能把检索工具调起来，且执行器真的能捞到东西。
 *
 * ## 为什么这个探针必须存在
 *
 * 主流程里 `recall.calls` 常常是 0，而 0 有两种解释：
 * 「这轮不需要翻旧消息」（正常）与「工具压根没接通」（坏了）。
 * 两者的输出**完全一样** —— 草稿照出、日志无异常。
 *
 * ## ★ 三个信号是**独立**的，缺一不可
 *
 * · `called` —— 真网关把工具调起来了（协议层通）。用的是**产品那一份**
 *   `RECALL_TOOL` 与 `createRecallExecutor`：抄一份的话产品里的声明
 *   改坏了探针照样绿。
 * · `hits` —— 执行器真的从库里捞到了消息。这一项**不依赖模型选什么词**：
 *   模型问完之后，我们拿一个从这个会话的真实消息里取出来的词
 *   再跑一次执行器。模型恰好问了个冷门词导致 0 命中，与
 *   "召回链路坏了"导致 0 命中，本来是分不开的 —— 这样就分开了。
 * · `isolated` —— 同一个词限定到**别的**会话时捞不到本会话的消息。
 *   纯本地断言，不花模型的钱。
 *
 * 只读：不写库、不出草稿。
 */
async function probeRecallTool(
  llm: LlmClient,
  db: SqliteDatabase,
  conversationId: string,
): Promise<{ called: boolean; hits: number; isolated: boolean }> {
  const repos = { fts: new FtsIndexRepository(db), messages: new MessageRepository(db) }
  const queries: string[] = []
  const execute = createRecallExecutor({
    repos,
    conversationId,
    onCall: (event) => {
      queries.push(event.query)
    },
  })

  await llm.completeWithTools({
    messages: [
      {
        role: "system",
        content: [
          "你在协助排查一个检索工具是否接通。",
          `必须先调用 ${RECALL_TOOL.name} 检索，再回答。`,
          "不要凭印象作答。",
        ].join(""),
      },
      {
        role: "user",
        // 这个问题不翻历史答不出来 —— 所以 0 次调用就是"工具没接通"
        content: "这个会话里最近讨论过什么？先检索一次再用一句话概括。",
      },
    ],
    // ★ 产品那一份声明，不是抄的
    tools: [RECALL_TOOL],
    execute,
    temperature: 0,
    maxTokens: 200,
    maxRounds: 3,
  })

  /**
   * ★ 命中数用**我们自己挑的词**，不用模型挑的那个。
   *
   * 模型可能问一个语料里没有的词（"最近讨论过什么"→ 它可能查"进展"），
   * 那样 0 命中是**正常**的 —— 与"召回链路坏了"的 0 命中无法区分。
   * 这里从这个会话的真实消息里取一个词去查：
   * 那个词一定在 FTS 索引里，所以 0 命中只剩"链路坏了"一个解释。
   *
   * ## ★ 为什么用 `tokenize` 挑而不是 `slice(0, 4)`
   *
   * 首版取正文前 4 个字符，于是真实语料里踩到这一条：
   *
   * ```
   * 正文  "求一个claude code 200刀代充的渠道（给自己用）"
   * 探针词 "求一个c"   → 命中 0
   * ```
   *
   * 原因在分词器：ASCII 词是**整词**入索引的（`claude`），不做 bigram
   * （见 `bigram.ts`：切碎会让 `deploy` 匹配上 `epl` 这种噪音）。
   * 而 `slice(4)` 从 `claude` 中间切了一刀，留下一个孤零零的 `c` ——
   * 那个 token 在索引里**不存在**，AND 组合查询于是必然 0 命中。
   *
   * 也就是说这个门禁曾经会对**完好的召回链路**报"链路坏了"：
   * 一个假红。它只在正文恰好是「中文 + 英文单词」且英文正好落在
   * 第 4 个字符上时才出现 —— 而中英混排在这个语料里是常态。
   *
   * 改法：让分词器自己挑。`tokenize` 是**写入与查询共用**的那一个函数，
   * 所以它吐出来的 token 一定是索引里的 key，不可能切在词中间。
   * 取最长的那个（bigram 优于单字：单字召回偏多，锁不住什么）。
   */
  const sample = db
    .prepare<[string], { content_text: string }>(
      `SELECT content_text FROM messages
        WHERE conversation_id = ? AND content_text IS NOT NULL AND length(content_text) >= 6
        ORDER BY sent_at DESC LIMIT 1`,
    )
    .get(conversationId)?.content_text
  const probeWord =
    sample === undefined
      ? ""
      : (tokenize(sample).sort((left, right) => right.length - left.length)[0] ?? "")
  const hits =
    probeWord === ""
      ? 0
      : recallMessages(repos, probeWord, { conversationIds: [conversationId] }).hits.length

  /**
   * 隔离断言（纯本地）：同一个词限定在**别的**会话时捞不到本会话的消息。
   *
   * 没有别的会话可比时算通过 —— 那时这条断言无从证伪，
   * 报 true 是诚实的（而不是报 false 让人以为隔离坏了）。
   */
  const other = db
    .prepare<
      [string],
      { id: string }
    >("SELECT id FROM conversations WHERE id <> ? ORDER BY id LIMIT 1")
    .get(conversationId)?.id
  let isolated = true
  if (other !== undefined) {
    for (const query of [...queries, probeWord]) {
      if (query.trim() === "") continue
      const leaked = recallMessages(repos, query, { conversationIds: [other] }).hits.filter(
        (hit) => hit.message.conversationId === conversationId,
      )
      if (leaked.length > 0) isolated = false
    }
  }

  return { called: queries.length > 0, hits, isolated }
}

/** 递归数 workspace 里的文件（只为验证"画像真的物化进去了"）。 */
function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0
  let count = 0
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) count += countFiles(full)
    else count += 1
  }
  return count
}
