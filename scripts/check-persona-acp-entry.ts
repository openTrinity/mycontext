/**
 * 数字分身的**生产路径**端到端：真 ACP + 真 forge 画像 + 真判定闸 + 真 kl。
 *
 * ## 与 `check-persona-entry.ts` 的分工
 *
 * 那个跑的是 **LlmClient 直连**（`runtime: {} as never`，注释写着"不碰它"），
 * 于是它验不到这次修的两件事 —— 两件都只在 ACP 那条路上：
 *
 * 1. `PersonaAcp.settleStream`：响应回来后还要等流稳定（半截 JSON 的根因）；
 * 2. `AGENTS.md` 里 `tools: "agent"` 那段措辞（谎报能力的根因）。
 *
 * 所以这里显式给足 `runtime` / `processes` / `klRoot`，让 `PersonaService`
 * 真的构造出 `PersonaAcp` 并走 ACP。
 *
 * ## ★ 只读：跑在 vault 的**副本**上
 *
 * 调用方传进来的 dbPath 必须是副本 —— 这个脚本会写 `dh_agent_runs` /
 * `dh_drafts` / `dh_conversation_configs`。在真 vault 上跑会污染用户的草稿箱。
 *
 * ## 判据是**草稿正文**，不是"没报错"
 *
 * 这条链路最可能的失效是"成功返回但内容不对"（本项目反复出现的那一类）：
 * · 说"不知道"而语料里有 —— 谎报能力那个 bug；
 * · 正文是 `{"reply": …` —— 截断那个 bug。
 * 两者都不报错，所以调用方要看的是 draftText 本身。
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createLogger, systemClock } from "@mycontext/kernel"
import { LlmClient, staticLlmProvider } from "@mycontext/llm"
import { createPersonaInboxHandler } from "@mycontext/persona"
import { ProcessRunner, RuntimeEnv } from "@mycontext/runtime-env"
import {
  ChangelogRepository,
  ConversationRepository,
  PersonaConfigRepository,
  VAULT_MIGRATIONS,
  openStore,
} from "@mycontext/store"
import { PersonaService } from "../apps/desktop/src/main/services/persona.service.js"
import { PersonaGate } from "../apps/desktop/src/main/services/persona-gate.js"

export interface PersonaAcpCheckReport {
  conversation: { id: string; title: string | null }
  /** ACP 到底有没有被启用（false = 这个脚本什么都没验到，必须当失败） */
  acpAvailable: boolean
  /** AGENTS.md 里那段工具声明 —— 用来确认 tools:"agent" 生效了 */
  entryDeclaresKl: boolean
  entryStillLiesAboutTools: boolean
  /** 注入的那条问题 */
  question: string
  /** 落库的草稿（正文 + 原因） */
  drafts: { text: string; notSentReason: string | null }[]
  /**
   * **本次**新产出的那条草稿（按注入消息的 run 关联）。
   *
   * ★ 与 `drafts` 分开是必需的：`drafts` 是最近 3 条，里面会有**修复之前**
   * 落库的坏草稿（库里那两条半截 JSON 就是）。拿它们做断言等于让这个探针
   * 永远红着 —— 而"永远红的门禁"和没有门禁一样，会被人习惯性忽略。
   *
   * null = 这一轮没产出草稿（那本身就是失败）。
   */
  newDraft: { text: string; notSentReason: string | null } | null
  runs: { decision: string; decisionReason: string | null; error: string | null }[]
  /** 走的是哪条路（从日志抓）：acp / llm */
  via: string[]
}

export async function runPersonaAcpCheck(options: {
  /** vault **副本**的路径 */
  dbPath: string
  workspaceRoot: string
  skillsDir: string
  forgeSkillRoot: string
  klRoot: string
  klPort: number
  agentHome: string
  baseUrl: string
  apiKey: string
  model: string
  conversationId: string
  /** 注入的问题（模拟对方发来的那条消息） */
  question: string
  env: Record<string, string>
}): Promise<PersonaAcpCheckReport> {
  if (!existsSync(options.dbPath)) throw new Error(`vault 副本不存在：${options.dbPath}`)

  const handle = openStore({ path: options.dbPath, migrations: VAULT_MIGRATIONS })
  const baseLogger = createLogger("PersonaAcpCheck", { level: "warn" })

  /**
   * 从日志里抓"走了哪条路"。
   *
   * ★ 这是这个脚本能不能**信**的关键：ACP 起不来时 `generateDraft` 会静默
   * 落回直连并照样出草稿 —— 那时草稿可能是对的，但我们验的东西一个都没验到。
   * 抓 `via` 让"其实没走 ACP"变成一个可见的失败，而不是一次假绿。
   */
  const via: string[] = []
  const logger: typeof baseLogger = {
    ...baseLogger,
    info: (message, fields) => {
      if (message === "persona draft generated" && fields !== undefined) {
        const value = fields["via"]
        if (typeof value === "string") via.push(value)
      }
      baseLogger.info(message, fields)
    },
  }

  const runtime = new RuntimeEnv({ binDir: options.workspaceRoot, env: options.env })
  const processes = new ProcessRunner(logger.child("Proc"))
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
    // ★ 与生产同一套：给足这些才会真的构造 PersonaAcp
    runtime,
    processes,
    workspaceRoot: options.workspaceRoot,
    skillsDir: options.skillsDir,
    agentHome: options.agentHome,
    klRoot: options.klRoot,
    klPort: options.klPort,
    llmProvider: staticLlmProvider(llm),
    getWindow: () => null,
    gate: new PersonaGate({
      logger: logger.child("Gate"),
      processes,
      python: runtime.tryResolvePython(),
    }),
  })

  try {
    // ★ 带 forgeSkillRoot：那是"有没有测量画像"与判定闸的来源
    persona.attach(handle.db, options.forgeSkillRoot)
    const supervisor = persona.inboundSupervisor
    if (supervisor === null) throw new Error("supervisor 未就绪")

    const conversation = new ConversationRepository(handle.db).findById(options.conversationId)
    if (conversation === null) throw new Error(`会话不存在：${options.conversationId}`)

    const acpAvailable = personaAcpAvailable(persona)

    // 触发条件放开到 all（这个会话历史里未必有 @我），保持 draft 模式
    new PersonaConfigRepository(handle.db).upsert(
      options.conversationId,
      { replyMode: "draft", triggerMode: "all" },
      systemClock.now(),
    )

    /**
     * 注入一条**对方发来的**消息（`isSelf: false`）。
     *
     * 直接写 messages + changelog，与采集侧同一个落点 —— 这样后面走的
     * 就是真的 Outbox 消费者 → 准入闸 → 调度 → generateDraft。
     */
    const now = systemClock.now()
    const messageId = `probe-${String(now)}`
    /**
     * `channel_id` / `direction` 是 NOT NULL —— 从该会话已有消息里借一份，
     * 而不是硬编码 'dingtalk' / 'inbound'：那样在别的渠道上会插出一条
     * 与会话不同源的消息，而这个脚本的整个价值就是"与生产同一条路"。
     */
    const sample = handle.db
      .prepare<
        [string],
        { channel_id: string }
      >("SELECT channel_id FROM messages WHERE conversation_id = ? LIMIT 1")
      .get(options.conversationId)
    if (sample === undefined) throw new Error("该会话一条消息都没有，无法借 channel_id")
    handle.db
      .prepare(
        `INSERT INTO messages (id, channel_id, conversation_id, external_id,
           sender_display_name, content_text, sent_at, direction, is_self, origin, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'inbound', 0, 'human', ?)`,
      )
      .run(
        messageId,
        sample.channel_id,
        options.conversationId,
        `probe-ext-${String(now)}`,
        "探针",
        options.question,
        now,
        now,
      )
    const changelog = new ChangelogRepository(handle.db)
    // 用真的 append —— 手写 INSERT 会漏掉 digest/domain 这些消费者要读的字段
    changelog.append([
      {
        op: "upsert",
        entityType: "message",
        entityId: messageId,
        channelId: sample.channel_id,
        domain: "chat",
        occurredAt: now,
        emittedAt: now,
        digest: `probe-${String(now)}`,
      },
    ])

    const handler = createPersonaInboxHandler({
      db: handle.db,
      clock: systemClock,
      supervisor,
      logger,
    })
    const head = changelog.head()
    handler(changelog.changesSince(Math.max(0, head - 20), 20))

    // 过合并窗口（3s）再 tick —— 与 check-persona 同一个理由
    await new Promise((resolve) => setTimeout(resolve, 3500))
    await persona.tick()

    const entry = readEntry(handle.db, options.conversationId)

    const drafts = handle.db
      .prepare<[string], { text: string; not_sent_reason: string | null }>(
        `SELECT text, not_sent_reason FROM dh_drafts WHERE conversation_id = ?
            ORDER BY created_at DESC LIMIT 3`,
      )
      .all(options.conversationId)
      .map((row) => ({ text: row.text, notSentReason: row.not_sent_reason }))

    /**
     * ★ 精确取**本次**那条：按 `trigger_message_id = 我们刚插的那条消息` 关联。
     *
     * 不用"最新一条"：并发/时钟相同时它可能取错，而这个探针的整个价值
     * 就在于那一条正文对不对。按 trigger 关联是结构性的 —— 取不到就是
     * 真的没产出（而不是"取到了别人的"）。
     */
    const newDraftRow = handle.db
      .prepare<[string], { text: string; not_sent_reason: string | null }>(
        `SELECT d.text, d.not_sent_reason FROM dh_drafts d
           JOIN dh_agent_runs r ON r.id = d.run_id
          WHERE r.trigger_message_id = ?`,
      )
      .get(messageId)
    const newDraft =
      newDraftRow === undefined
        ? null
        : { text: newDraftRow.text, notSentReason: newDraftRow.not_sent_reason }

    const runs = handle.db
      .prepare<
        [string],
        { decision: string; decision_reason: string | null; error: string | null }
      >(
        `SELECT decision, decision_reason, error FROM dh_agent_runs WHERE conversation_id = ?
            ORDER BY created_at DESC LIMIT 3`,
      )
      .all(options.conversationId)
      .map((row) => ({
        decision: row.decision,
        decisionReason: row.decision_reason,
        error: row.error,
      }))

    return {
      conversation: { id: conversation.id, title: conversation.title },
      acpAvailable,
      entryDeclaresKl: entry.includes("kl ask"),
      entryStillLiesAboutTools: entry.includes("唯一可用的工具"),
      question: options.question,
      drafts,
      newDraft,
      runs,
      via,
    }
  } finally {
    /**
     * `detach` 而不是 `stop`：stop 只停定时器（同步），而我们还要
     * 等在途那一轮跑完再关连接 —— 不等的话它会写到已关闭的 db 上。
     */
    await persona.detach().catch(() => undefined)
    handle.close()
  }
}

/** ACP 有没有真被启用。用 available() —— 与 createAgent 的判据同源。 */
function personaAcpAvailable(persona: PersonaService): boolean {
  const acp = (persona as unknown as { acp: { available: () => boolean } | null }).acp
  return acp !== null && acp.available()
}

/** 读该会话 workspace 里的 AGENTS.md（判定 tools 措辞用）。 */
function readEntry(
  db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } },
  conversationId: string,
): string {
  const row = db
    .prepare("SELECT acp_cwd FROM dh_agent_sessions WHERE conversation_id = ?")
    .get(conversationId) as { acp_cwd?: string } | undefined
  if (row?.acp_cwd === undefined) return ""
  const path = join(row.acp_cwd, "AGENTS.md")
  return existsSync(path) ? readFileSync(path, "utf8") : ""
}
