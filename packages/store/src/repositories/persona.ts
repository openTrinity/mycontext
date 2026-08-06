/**
 * 数字人的表（`dh_*`）读写。
 *
 * ## ★ 默认值是**安全侧**的，且由数据库保证
 *
 * `reply_mode = 'draft'`：数字人以本人身份发消息，误发的社交成本不可逆
 * （对方已经看到了，撤回也留痕）。所以"开始自动回复"必须是用户
 * **显式**打开的动作 —— 而不是"装好就开始替你说话"。
 *
 * 这个默认写在建表 DDL 里而不是代码里：代码里的默认值会在某次重构中
 * 被"顺手"改成别的，而 DDL 的改动必须走迁移（会被审阅到）。
 *
 * ## ★ `listening` 列已废弃
 *
 * 它曾是准入闸的第二条（默认 0 → 新会话一律被丢）。实测后果：投递 200 条
 * 消息、拒 184 条，绝大多数就是这一条 —— 也就是**默认什么都不做**，
 * 而用户要逐个会话去开（这个账号 86 个会话）。
 *
 * 现在管控层收所有消息，发不发由「回复模式 + 白名单」决定。
 * 列**保留不删**（删列要重建表，且已有数据没有价值可救），但
 * **任何代码都不再读它** —— 下一次迁移可以顺手清掉。
 *
 * ## 为什么 config 缺行也要能读
 *
 * 绝大多数会话用户从没配过 —— 那时 `list()` 要返回缺省值而不是空。
 * 返回空会让 UI 只显示配过的那几个会话，用户找不到想调的那个群。
 */
import type { SqliteDatabase } from "../database.js"

/**
 * 回复模式。
 *
 * ★ 只保留两档：`draft`（出草稿等审）与 `auto`（准入闸过就以本人身份发）。
 *
 * 首版有过 `smart`（按需自动）与 `silent`（不出也不发）。`smart` 与 `auto`
 * 的差别对用户不成立（无非是"没通过时降级成什么"，那是内部实现细节）；
 * `silent` 表达的是"这个会话根本不该处理" —— 现在由 `triggerMode: "none"`
 * 更直接地表达（"不触发"就是"根本不进 agent"）。
 *
 * 库里可能还有历史的 `smart` / `silent` 行 —— 读回时被下面的 `REPLY_MODES`
 * 白名单拦住并退回缺省 `draft`，写入时新代码只会写这三个值，所以老行会随
 * 下次保存自然消失。不做数据迁移（多一份可能出错的路径）。
 *
 * ★ `yolo` 是"不过判定闸直接发"那一档（见 `@mycontext/persona` 的 policy）。
 * 它必须在下面的 runtime 白名单里 —— 漏了的表现是"用户选了 yolo、存进去了，
 * 但读回变成 draft"，而那是静默的：界面显示 draft，用户以为没保存成功。
 */
export type ReplyMode = "auto" | "draft" | "yolo"
/**
 * 触发条件。四种，与界面上那四个选项一一对应。
 *
 * ★ `none`（不触发）是后加的。库里的列是 TEXT 且没有 CHECK 约束，
 * 所以不需要迁移 —— 但**读**的时候要能容忍任何值：见 `toConfig` 里
 * 那个白名单（一个手改过的库、或者降级回旧版写下的值，
 * 不该让整个会话列表打不开）。
 */
export type TriggerMode = "none" | "all" | "mention" | "keyword"

export interface DhConversationConfigRow {
  conversationId: string
  replyMode: ReplyMode
  triggerMode: TriggerMode
  keywords: string[]
  distillEnabled: boolean
  personaNote: string | null
  updatedAt: number
}

export interface DhDraftRow {
  id: string
  runId: string | null
  conversationId: string
  replyToExternalId: string | null
  text: string
  editedText: string | null
  state: "pending" | "sent" | "discarded" | "expired"
  citations: string[]
  notSentReason: string | null
  /**
   * 过期原因（`over_draft_cap` / `superseded_by_newer_message` / …）。
   * 与 `notSentReason`（"当时为什么没自动发"）分开：这一列答的是
   * "后来为什么消失了"。写了从来没人读会让"草稿怎么没了"无从回答。
   */
  expiredReason: string | null
  createdAt: number
  resolvedAt: number | null
}

/**
 * 一条 agent 过程痕迹（= 一个 `ChatItem` 的落库形态）。
 *
 * 字段与 `search_chat_messages` 同构（见 v19 迁移文件头）：**落库形态与
 * 渲染形态相同**，所以"回看历史"与"实时流式"由同一份数据驱动。
 * `contentJson` 是 `UnifiedContentBlock[]` 的 JSON —— 存储层不解析它。
 */
export interface PersonaTraceInput {
  id: string
  seq: number
  role: string
  itemType: string
  contentJson: string
  toolName?: string | null
  toolStatus?: string | null
  turnId?: string | null
  createdAt: number
}

/** 读出来的那一行。与 `PersonaTraceInput` 的差别只在可选字段已归一为 null。 */
export interface PersonaTraceRow {
  id: string
  seq: number
  role: string
  itemType: string
  contentJson: string
  toolName: string | null
  toolStatus: string | null
  turnId: string | null
  createdAt: number
}

export interface DhRunRow {
  id: string
  conversationId: string
  triggerMessageId: string | null
  draftText: string | null
  confidence: number | null
  decision: string
  decisionReason: string | null
  /**
   * **全部**未通过的条件，不只是第一个。
   *
   * `evaluatePolicy` 返回 `reason`（第一个命中的）与 `failedConditions`
   * （全部）。只存前者的话用户看到"不在工作时间"就以为改个时间就能发，
   * 而实际上还差授权、还超了频率 —— 他会改一次、失败、再改一次。
   * 一次看到全部才能让他判断"这功能现在到底能不能用"。
   */
  failedConditions: string[]
  latencyMs: number | null
  costTokens: number | null
  error: string | null
  createdAt: number
}

export interface PersonaActivityRow {
  id: string
  conversationId: string
  kind: "auto_sent" | "user_accepted" | "user_edited"
  text: string
  occurredAt: number
  /**
   * 产生这条回复的那一轮 agent run。**用来回看"这句话是怎么想出来的"**。
   *
   * ★ 可空，而两种空的含义不同（界面要分开处置）：
   * · 用户自己写的那条（`composeSend`）—— 本来就没有 run，没有过程可言；
   * · 升级前的旧记录 —— 那时还不记 run_id。
   * 两者都不该显示"看处理过程"入口（点了没反应比不显示更糟）。
   *
   * ★ 与「有 run 但没 trace」是**第三种**状态：那时入口要在，
   * 展开后明说"这一轮没有留下过程"。让「没有」与「没加载出来」可区分。
   *
   * ★★ 这个第三态曾**普遍**出现，而当时的归因（"走了直连降级那条路"）
   * 是错的：真实原因是 `appendTrace` 的行主键不带 runId，重启后
   * 新轮次把旧轮次的痕迹整行改嫁走了（见那个方法的注释）。
   * 也就是说界面说的"没有留下过程"在很多情况下并不诚实 —— 留过，被删了。
   * 修掉之后它应当退回真正的少数情况（opencode 缺失时的直连路）。
   * 若再次**普遍**出现，先怀疑写入侧又丢了痕迹，不要再照抄"直连降级"这个解释。
   */
  runId: string | null
}

/**
 * 一轮 agent run 的元信息 —— 回答「为什么会跑、判成了什么、贵不贵」。
 *
 * ## ★ 为什么与 trace 分成两个查询
 *
 * trace 是那一轮的**过程**（thinking / 正文 / tool），这个是**结论与代价**。
 * 两者都只在用户**展开某一条**时才需要，所以都不该塞进
 * `recentActivities`（一次 20 条，其中 19 条不会被展开 —— 那是 19 次白做的 join）。
 */
export interface PersonaRunDetailRow {
  runId: string
  decision: string
  /** 未自动发送时的原因（机器码，界面用 `explainDecisionReason` 翻译） */
  decisionReason: string | null
  latencyMs: number | null
  costTokens: number | null
  error: string | null
  /** 触发这一轮的那条消息 —— 回答「为什么这轮会跑」 */
  trigger: { senderDisplayName: string | null; contentText: string | null } | null
}

const REPLY_MODES: ReadonlySet<string> = new Set(["auto", "draft", "yolo"])
/**
 * 读回时的白名单。库里的列是 TEXT 无约束，所以一个手改过的库
 * （或降级回旧版写下的值）不该让整个会话列表打不开 —— 认不出就退回缺省。
 *
 * ★ `none` 必须在这里。漏掉它的后果是**静默的**：用户选了「不触发」，
 * 落库成功，而读回时因为不在白名单被换成缺省的 `mention` ——
 * 表现是"这个会话我明明设了不触发，它还是在回"，且界面上显示的是 @我时。
 */
const TRIGGER_MODES: ReadonlySet<string> = new Set(["none", "all", "mention", "keyword"])

function parseKeywords(raw: string | null): string[] {
  if (raw === null || raw === "") return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : []
  } catch {
    // 坏 JSON 按空处理：一条坏配置不该让整个会话列表打不开
    return []
  }
}

export class PersonaConfigRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /** 读一个会话的配置；没配过返回 null（调用方按"未监听"处理）。 */
  get(conversationId: string): DhConversationConfigRow | null {
    const raw = this.db
      .prepare<
        [string],
        {
          conversation_id: string
          reply_mode: string
          trigger_mode: string
          keywords_json: string | null
          distill_enabled: number
          persona_note: string | null
          updated_at: number
        }
      >("SELECT * FROM dh_conversation_configs WHERE conversation_id = ?")
      .get(conversationId)
    if (raw === undefined) return null
    return {
      conversationId: raw.conversation_id,
      replyMode: REPLY_MODES.has(raw.reply_mode) ? (raw.reply_mode as ReplyMode) : "draft",
      triggerMode: TRIGGER_MODES.has(raw.trigger_mode)
        ? (raw.trigger_mode as TriggerMode)
        : "mention",
      keywords: parseKeywords(raw.keywords_json),
      distillEnabled: raw.distill_enabled === 1,
      personaNote: raw.persona_note,
      updatedAt: raw.updated_at,
    }
  }

  /**
   * 全部**已采过消息**的会话 + 它们的配置（缺的补成未监听）。
   *
   * 从 conversations 左连而不是从 configs 查：后者只有配过的那几行，
   * 而 UI 要展示"我可以给哪些会话开监听"。
   */
  listWithConversations(): {
    conversationId: string
    /**
     * 该会话所属渠道（`'dingtalk'` | `'feishu'` …）。
     *
     * ★ 取的是**会话行上**的 channel_id，不是"应用支持哪些渠道"：
     * 多渠道之后左栏会混排两个渠道的会话，"这一条来自哪"只能由会话自己回答。
     */
    channelId: string
    externalId: string
    title: string | null
    kind: "direct" | "group"
    memberCount: number | null
    lastMessageAt: number | null
    messageCount: number
    unreadForPersona: number
    /**
     * **人**的未读数（钉钉的红点）。
     *
     * ★ 与 `unreadForPersona` 是两件不同的事，两个都要有：
     * · 这个 —— **我**还没读（来自 L1 探针的 `unreadPoint`）；
     * · `unreadForPersona` —— **数字人**还没处理（`dh_inbox` pending）。
     *
     * 混成一个数字的话用户无从知道"这条等我看"还是"等它跑"。
     * 没有探针记录时为 0（探针只返回未读的会话，没记录就是没未读）。
     */
    unreadCount: number
    /**
     * 单聊对方的 openDingTalkId（群聊为 null）。
     *
     * ★ 取头像要的是**人**的 id，而 `external_id` 在单聊里是**会话** id
     * （实测 `cid…` 47 字符 vs `D0AU…` 33 字符，形态都不同）。
     * 拿会话 id 去查成员详情必然空，而那会落一条终态 miss，
     * 于是那个人的头像永久取不到。
     */
    peerExternalId: string | null
    /**
     * 最新一条消息的正文（已截断到 80 字）、发送者名、是否本人发的。
     *
     * 侧栏每一行要显示"显示名 + 最新一条 + 时间" —— 前两个来自这里，
     * 时间用 `lastMessageAt`（同一条记录，见 SQL 里的注释）。
     *
     * `null` = 这个会话还没有消息（新建的群、或采集范围外）。
     */
    lastMessageText: string | null
    lastMessageSender: string | null
    lastMessageIsSelf: boolean | null
    config: DhConversationConfigRow | null
  }[] {
    return this.db
      .prepare<
        [],
        {
          id: string
          channel_id: string
          external_id: string
          title: string | null
          type: string
          member_count: number | null
          last_message_at: number | null
          message_count: number
          unread_for_persona: number
          unread_count: number | null
          peer_external_id: string | null
          last_message_text: string | null
          last_message_sender: string | null
          last_message_is_self: number | null
          reply_mode: string | null
          trigger_mode: string | null
          keywords_json: string | null
          distill_enabled: number | null
          persona_note: string | null
          updated_at: number | null
        }
      >(
        `SELECT c.id, c.channel_id, c.external_id, c.title, c.type, c.member_count, c.last_message_at,
                (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
                (SELECT count(*) FROM dh_inbox i
                  WHERE i.conversation_id = c.id AND i.state = 'pending') AS unread_for_persona,
                -- 单聊对方的 openDingTalkId。只对 direct 取：群聊里"任一个
                -- 对方"没有意义（有很多人），而钉钉也没有群头像字段。
                -- is_self = 0 而不是 <> 1：is_self 可能是 NULL（身份还没确认），
                -- 而 NULL 的那些不能当成"对方"。
                CASE WHEN c.type = 'direct' THEN (
                  SELECT m2.sender_external_id FROM messages m2
                   WHERE m2.conversation_id = c.id AND m2.is_self = 0
                         AND m2.sender_external_id IS NOT NULL
                   LIMIT 1
                ) END AS peer_external_id,
                -- 人的未读数（钉钉红点）。探针只记未读的会话，
                -- 没有那一行就是没未读 → COALESCE 成 0。
                p.unread_count AS unread_count,
                /*
                  ★ 最新一条消息的摘要与发送者 —— 侧栏每一行要显示它。

                  ## 为什么是**一个 JOIN** 而不是三个子查询

                  首版写成三个并列子查询（正文 / 发送者 / is_self 各一个）。
                  它们各自 ORDER BY sent_at DESC LIMIT 1，也就是**各自**
                  决定"最新那条是谁" —— 同一毫秒有两条消息时（群里连发、
                  或补采一次性入库）三者可能落在**不同的行**上，
                  于是侧栏显示"张三：（李四那句话）"。那种错不报错、
                  概率低、且只在真实数据上出现，正是最难查的一类。

                  改成按 id 关联一次：三个字段必然同源。
                  LIMIT 1 仍在子查询里，但它只决定**一个** id。

                  ## 为什么在 SQL 里取而不是渲染层再查

                  侧栏有 92 行。每行自己查一次是 92 次 IPC + 92 次 SQL，
                  而这里是一次 JOIN（实测 89 个会话 12ms —— idx_msg_conv_time
                  就是 (conversation_id, sent_at DESC)，正好覆盖）。

                  ★ 截断放在 SQL 里（substr 80 字）：一条几千字的消息
                  整条传到渲染层再截，等于每次刷列表都搬一遍无用的字节。
                */
                substr(last_msg.content_text, 1, 80) AS last_message_text,
                last_msg.sender_display_name AS last_message_sender,
                last_msg.is_self AS last_message_is_self,
                g.reply_mode, g.trigger_mode, g.keywords_json,
                g.distill_enabled, g.persona_note, g.updated_at
           FROM conversations c
           LEFT JOIN dh_conversation_configs g ON g.conversation_id = c.id
           -- 最新那条消息。按 id 关联（不是三个子查询各自取），见上面的注释
           LEFT JOIN messages last_msg ON last_msg.id = (
             SELECT m3.id FROM messages m3
              WHERE m3.conversation_id = c.id
              ORDER BY m3.sent_at DESC LIMIT 1
           )
           LEFT JOIN probe_snapshots p
                  ON p.channel_id = c.channel_id
                 AND p.conversation_external_id = c.external_id
          WHERE NOT EXISTS (
            SELECT 1
              FROM persona_conversation_exclusions e
             WHERE e.conversation_id = c.id
          )
          ORDER BY c.last_message_at DESC NULLS LAST`,
      )
      .all()
      .map((raw) => ({
        conversationId: raw.id,
        channelId: raw.channel_id,
        externalId: raw.external_id,
        title: raw.title,
        kind: raw.type === "direct" ? ("direct" as const) : ("group" as const),
        memberCount: raw.member_count,
        lastMessageAt: raw.last_message_at,
        messageCount: raw.message_count,
        unreadForPersona: raw.unread_for_persona,
        // 没有探针记录 = 没未读（探针只返回未读的会话）
        unreadCount: raw.unread_count ?? 0,
        peerExternalId: raw.peer_external_id,
        lastMessageText: raw.last_message_text,
        lastMessageSender: raw.last_message_sender,
        /**
         * 最新那条是不是本人发的。
         *
         * `is_self` 可能是 NULL（身份还没确认）—— 那时**不能**当成"不是本人"：
         * 侧栏据此决定要不要加「我：」前缀，而在未确认的库上给所有消息
         * 都不加前缀，比都加或都不加更接近实情（我们确实不知道）。
         * 所以保留三态，由渲染层决定怎么表达"不知道"。
         */
        lastMessageIsSelf:
          raw.last_message_is_self === null ? null : raw.last_message_is_self === 1,
        config:
          raw.updated_at === null
            ? null
            : {
                conversationId: raw.id,
                replyMode:
                  raw.reply_mode !== null && REPLY_MODES.has(raw.reply_mode)
                    ? (raw.reply_mode as ReplyMode)
                    : "draft",
                triggerMode:
                  raw.trigger_mode !== null && TRIGGER_MODES.has(raw.trigger_mode)
                    ? (raw.trigger_mode as TriggerMode)
                    : "mention",
                keywords: parseKeywords(raw.keywords_json),
                distillEnabled: raw.distill_enabled === 1,
                personaNote: raw.persona_note,
                updatedAt: raw.updated_at,
              },
      }))
  }

  /**
   * 保存配置。只传的字段会被改，其余保留（COALESCE）。
   *
   * 可选字段都显式带 `| undefined`：仓库开了 `exactOptionalPropertyTypes`，
   * 而这些值来自 zod 推导的类型（`.optional()` 推出 `k?: T | undefined`）。
   */
  upsert(
    conversationId: string,
    input: {
      replyMode?: ReplyMode | undefined
      triggerMode?: TriggerMode | undefined
      keywords?: readonly string[] | undefined
      distillEnabled?: boolean | undefined
      personaNote?: string | null | undefined
    },
    at: number,
  ): void {
    /**
     * ★ UPDATE 分支一律用**独立的绑定参数**，绝不用 `excluded.*`。
     *
     * 曾经在 `listening` 上写的是
     * `listening = COALESCE(excluded.listening, 表.listening)`。
     * 但 `excluded.listening` 来自 `VALUES` 里的 `COALESCE(?, 0)` ——
     * 它**永远不是 NULL**，于是"没传 listening"会被当成"传了 0"：
     * 用户只改了回复方式，监听就被**静默关掉**了。
     *
     * 那个字段现在废弃了，但这条规则对下面每一个字段仍然成立：
     * `excluded` 拿到的是插入分支加工过的值，不是调用方的原始意图 ——
     * 想表达"没传"就必须用一个没被 COALESCE 处理过的参数。
     */
    const replyMode = input.replyMode ?? null
    const triggerMode = input.triggerMode ?? null
    const keywords = input.keywords === undefined ? null : JSON.stringify([...input.keywords])
    const distillEnabled = input.distillEnabled === undefined ? null : input.distillEnabled ? 1 : 0
    const personaNote = input.personaNote ?? null

    this.db
      .prepare(
        // listening 列仍在（DDL 里 NOT NULL DEFAULT 0），插入时给 0 让它满足约束；
        // 之后任何读路径都不看它 —— 见文件头「已废弃」那一段。
        `INSERT INTO dh_conversation_configs
           (conversation_id, listening, reply_mode, trigger_mode, keywords_json,
            distill_enabled, persona_note, updated_at)
         VALUES (?, 0, COALESCE(?, 'draft'), COALESCE(?, 'mention'), ?,
                 COALESCE(?, 1), ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           reply_mode      = COALESCE(?, dh_conversation_configs.reply_mode),
           trigger_mode    = COALESCE(?, dh_conversation_configs.trigger_mode),
           keywords_json   = COALESCE(?, dh_conversation_configs.keywords_json),
           distill_enabled = COALESCE(?, dh_conversation_configs.distill_enabled),
           persona_note    = COALESCE(?, dh_conversation_configs.persona_note),
           updated_at      = excluded.updated_at`,
      )
      .run(
        conversationId,
        replyMode,
        triggerMode,
        keywords,
        distillEnabled,
        personaNote,
        at,
        // UPDATE 分支：与上面 SET 里的 ? 一一对应，且都是**原始意图**
        replyMode,
        triggerMode,
        keywords,
        distillEnabled,
        personaNote,
      )
  }

  /** 全局设置（kill switch、工作时间等）。 */
  getSetting<T>(key: string, fallback: T): T {
    const raw = this.db
      .prepare<[string], { value_json: string }>("SELECT value_json FROM dh_settings WHERE key = ?")
      .get(key)
    if (raw === undefined) return fallback
    try {
      return JSON.parse(raw.value_json) as T
    } catch {
      return fallback
    }
  }

  setSetting(key: string, value: unknown, at: number): void {
    this.db
      .prepare(
        `INSERT INTO dh_settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                        updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), at)
  }
}

/** 运行记录与草稿。 */
export class PersonaRunRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * 记一条 run。
   *
   * ★ `decisionReason` 在未自动发送时**必填**（由调用方保证）：
   * 用户开了 auto 却总在出草稿，不告诉他命中了哪条
   * （不在工作时间？置信度不够？命中禁止词？授权过期？）
   * 他唯一能做的就是放弃这个功能。
   */
  /**
   * 回填一轮的最终决策。
   *
   * ## ★ 为什么需要"事后改"这一步
   *
   * 自动发送那条路的顺序被外键锁死了：`dh_drafts.run_id` 引用
   * `dh_agent_runs(id)`，所以 **run 必须先落**，才能落草稿，才能发
   * （守卫第 ② 层要按 draftId 重读库比对 contentHash）。
   *
   * 于是 run 落库时还不知道发送结果。而 `decision` 必须是**实际发生的事**：
   * 记了 `auto_sent` 而消息没发出去，是比不发更坏的状态 —— 事后没有任何
   * 东西能纠正它，而 policy 的频率限制还会把它当成一次真发送。
   *
   * 所以发送收尾之后回来改一次。`decision` 与 `decision_reason` 一起改：
   * 只改前者会留下一个"drafted 但原因写着通过了"的自相矛盾的行。
   */
  finalizeRunDecision(id: string, decision: string, reason: string | null): void {
    this.db
      .prepare(`UPDATE dh_agent_runs SET decision = ?, decision_reason = ? WHERE id = ?`)
      .run(decision, reason, id)
  }

  insertRun(
    input: {
      id: string
      conversationId: string
      triggerMessageId: string | null
      draftText: string | null
      confidence: number | null
      decision: string
      decisionReason: string | null
      /** 全部未通过的条件（存进 `risks_json`，供 UI 一次展示全部） */
      failedConditions?: readonly string[]
      /**
       * 这一轮 agent 调过的工具名（存进 `tool_calls_json`）。
       *
       * ★ 这一列长期恒为 `null` —— 因为**从来没有人往里写**。后果不是少个数字：
       * "agent 到底调了什么"变成只能靠推断，而推断会错（实测把"ACP session 一次
       * 都没建起来"误判成"agent 拿到 skill 却不听话"）。
       *
       * 语义上要能区分三态，所以是 `undefined` / `[]` / 非空：
       * · `undefined` → 这条路不报告工具（比如直连路的形状不同）→ 存 null；
       * · `[]` → **确实一次没调**（这是个结论，不是缺数据）→ 存 `[]`；
       * · 非空 → 调了这些。
       */
      toolNames?: readonly string[]
      latencyMs: number | null
      costTokens: number | null
      error: string | null
      isDryRun?: boolean
    },
    at: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO dh_agent_runs
           (id, conversation_id, trigger_message_id, draft_text, confidence,
            decision, decision_reason, risks_json, tool_calls_json, latency_ms,
            cost_tokens, error, is_dry_run, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.conversationId,
        input.triggerMessageId,
        input.draftText,
        input.confidence,
        input.decision,
        input.decisionReason,
        input.failedConditions === undefined ? null : JSON.stringify([...input.failedConditions]),
        input.toolNames === undefined ? null : JSON.stringify([...input.toolNames]),
        input.latencyMs,
        input.costTokens,
        input.error,
        input.isDryRun === true ? 1 : 0,
        at,
      )
  }

  insertDraft(
    input: {
      id: string
      runId: string | null
      conversationId: string
      replyToExternalId: string | null
      text: string
      citations: readonly string[]
      notSentReason: string | null
    },
    at: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO dh_drafts
           (id, run_id, conversation_id, reply_to_external_id, text,
            state, citations_json, not_sent_reason, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        input.id,
        input.runId,
        input.conversationId,
        input.replyToExternalId,
        input.text,
        JSON.stringify([...input.citations]),
        input.notSentReason,
        at,
      )
  }

  /** 待审阅的草稿。UI 的草稿箱读它。 */
  pendingDrafts(limit = 50): DhDraftRow[] {
    return this.db
      .prepare<
        [number],
        {
          id: string
          run_id: string | null
          conversation_id: string
          reply_to_external_id: string | null
          text: string
          edited_text: string | null
          state: string
          citations_json: string | null
          not_sent_reason: string | null
          expired_reason: string | null
          created_at: number
          resolved_at: number | null
        }
      >(
        `SELECT * FROM dh_drafts
          WHERE state = 'pending'
            AND NOT EXISTS (
              SELECT 1
                FROM persona_conversation_exclusions e
               WHERE e.conversation_id = dh_drafts.conversation_id
            )
          ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit)
      .map((raw) => ({
        id: raw.id,
        runId: raw.run_id,
        conversationId: raw.conversation_id,
        replyToExternalId: raw.reply_to_external_id,
        text: raw.text,
        editedText: raw.edited_text,
        state: raw.state as DhDraftRow["state"],
        citations: parseKeywords(raw.citations_json),
        notSentReason: raw.not_sent_reason,
        expiredReason: raw.expired_reason,
        createdAt: raw.created_at,
        resolvedAt: raw.resolved_at,
      }))
  }

  /**
   * 每会话最多保留 `cap` 条 pending 草稿，其余按 `created_at` 从旧到新裁掉
   * （标 `expired` + `expired_reason='over_draft_cap'`）。取代按时效的自动过期。
   *
   * ## `keepIds`：不裁「正在处理的那条」
   *
   * 生成中那几轮本轮新插的草稿、以及正在自动发送中的那条，都不能被这里裁掉
   * —— 否则会出现"发出去了却被标 expired"的竞态（实测报过）。调用方把这些
   * id 传进来，SQL 用 `NOT IN` 排除。给空数组时行为等同于纯按 cap 裁。
   *
   * ## 为什么按会话分区
   *
   * cap 是**每会话**的（一个活跃群刷 20 条草稿不该把别的会话挤空）。用
   * `ROW_NUMBER() OVER (PARTITION BY conversation_id ...)` 给每会话独立编号。
   *
   * @returns 被裁掉的草稿条数
   */
  trimDraftsBeyondCap(
    cap: number,
    at: number,
    options: { keepIds?: readonly string[] } = {},
  ): number {
    const keepIds = options.keepIds ?? []
    // NOT IN () 是语法错误；空集时用一个不可能命中的占位。
    const placeholders = keepIds.length > 0 ? keepIds.map(() => "?").join(",") : "''"
    const result = this.db
      .prepare(
        `UPDATE dh_drafts
            SET state = 'expired',
                expired_reason = COALESCE(expired_reason, 'over_draft_cap'),
                resolved_at = COALESCE(resolved_at, ?)
          WHERE id IN (
            SELECT id FROM (
              SELECT id,
                     ROW_NUMBER() OVER (
                       PARTITION BY conversation_id
                       ORDER BY created_at DESC, id DESC
                     ) AS rn
                FROM dh_drafts
               WHERE state = 'pending'
                 AND id NOT IN (${placeholders})
            )
             WHERE rn > ?
          )`,
      )
      .run(at, ...keepIds, cap)
    return result.changes
  }

  /**
   * 落一轮 agent 的过程痕迹（thinking / 正文 / tool 调用）。
   *
   * ## `INSERT OR REPLACE` 而不是 `OR IGNORE`
   *
   * 搜索那侧是**流式增量**写（一个 item 会从 pending 变 success，所以有
   * 单独的 `updateMessage`）。这里是**轮末一次性**写完整快照，同一个
   * `(run_id, seq)` 重写就该覆盖 —— 用 `OR IGNORE` 的话重试那次会静默丢掉
   * 更完整的版本（tool 状态停在 pending）。
   *
   * 一次事务：半截痕迹比没有痕迹更难读（看起来像 agent 中途死了）。
   *
   * ## ★★ 行主键**必须**带 runId —— 不带就是跨轮互相覆盖
   *
   * 这修的是「历史处理结果点开几乎全说『没有留下过程』」的真正根因。
   *
   * `item.id` 由 reducer 用 `newId: (seq) => `${turnId}_${seq}`` 生成，而
   * `turnId` 来自 `PersonaAcp.turnSeq` —— 一个**进程内**自增计数器
   * （`persona-acp.ts:225` 的 `private turnSeq = 0`）。也就是每次应用重启，
   * 第一轮的 item id 又是 `turn_1_1`。而 `dh_run_trace.id` 是 PRIMARY KEY，
   * 于是 `INSERT OR REPLACE` 把**上一次装机那一轮的痕迹整行改嫁**给新的 run：
   * 那一行的 `run_id` 被改写成新 runId，旧 run 就此一行不剩。
   *
   * 实测两个本机 vault 里的指纹都对得上（`ORDER BY created_at`）：
   * ```
   * 21 轮 run / 只有 13 轮剩下痕迹；且尾部 3 行的 id 是 turn_1_1 / turn_2_1 /
   * turn_3_1 —— 时间戳却是最新的 3 轮（那次重启后 turnSeq 从 0 重新开始）。
   * 另一个 vault：566 轮 run / 只剩 38 轮有痕迹，且最早那一轮的 seq 是
   * 2,3,4 —— seq=1 那行被后来的 turn_1_1 抢走了（现属另一个 run）。
   * ```
   * 也就是它不只是"没写进来"，而是**已经写进来的被后面的轮次删掉**，
   * 而且是最看不出来的那种：库里没有报错，草稿与发送一切正常。
   *
   * ★ 反证跑过：把主键改回 `item.id`，`run-trace-collision.test.ts` 里
   * 那条多 item 的断言立刻红成 `[2,3]` —— 与上面真实库里的指纹一模一样。
   *
   * 所以主键在这里就地命名空间化（`<runId>:<itemId>`）——
   * 而不是去要求调用方保证 turnId 全局唯一：那种要求靠人记，
   * 而漏掉的表现就是本次这个（静默、跨版本、只在重启后出现）。
   * 读回来的 `id` 只被渲染层当 React key 用（`toChatItems` → `EventStream`），
   * 没有任何地方解析它的格式。
   *
   * 存量的旧行**没有迁移**：它们的内容已经被覆盖掉了，改主键也换不回来。
   * 新写入不再命中 `turn_N_M` 那些旧主键，所以旧行从此不会再被误删。
   */
  appendTrace(runId: string, items: readonly PersonaTraceInput[]): number {
    if (items.length === 0) return 0
    const statement = this.db.prepare(
      `INSERT OR REPLACE INTO dh_run_trace
         (id, run_id, seq, role, item_type, content_json, tool_name, tool_status,
          turn_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    let written = 0
    this.db.transaction(() => {
      for (const item of items) {
        written += statement.run(
          `${runId}:${item.id}`,
          runId,
          item.seq,
          item.role,
          item.itemType,
          item.contentJson,
          item.toolName ?? null,
          item.toolStatus ?? null,
          item.turnId ?? null,
          item.createdAt,
        ).changes
      }
    })()
    return written
  }

  /** 读一轮的过程痕迹（按 seq —— 渲染顺序的唯一依据）。 */
  traceForRun(runId: string): PersonaTraceRow[] {
    return this.db
      .prepare<
        [string],
        {
          id: string
          seq: number
          role: string
          item_type: string
          content_json: string
          tool_name: string | null
          tool_status: string | null
          turn_id: string | null
          created_at: number
        }
      >(
        `SELECT id, seq, role, item_type, content_json, tool_name, tool_status,
                turn_id, created_at
           FROM dh_run_trace WHERE run_id = ? ORDER BY seq`,
      )
      .all(runId)
      .map((raw) => ({
        id: raw.id,
        seq: raw.seq,
        role: raw.role,
        itemType: raw.item_type,
        contentJson: raw.content_json,
        toolName: raw.tool_name,
        toolStatus: raw.tool_status,
        turnId: raw.turn_id,
        createdAt: raw.created_at,
      }))
  }

  /** 生成完成后、落草稿/自动发送前检查该轮是否仍未被本人回复。 */
  isReplyTurnOpen(
    conversationId: string,
    replyToExternalId: string | null,
    cutoff?: number,
  ): boolean {
    if (replyToExternalId === null) return true
    const row = this.db
      .prepare<[string, string, number | null, number | null], { closed: number }>(
        `SELECT EXISTS (
           SELECT 1
             FROM messages trigger_message
            WHERE trigger_message.conversation_id = ?
              AND trigger_message.external_id = ?
              AND (
                (
                  ? IS NOT NULL
                  AND trigger_message.sent_at < ?
                  AND EXISTS (
                    SELECT 1
                      FROM conversations c
                      JOIN probe_snapshots p
                        ON p.channel_id = c.channel_id
                       AND p.conversation_external_id = c.external_id
                     WHERE c.id = trigger_message.conversation_id
                       AND p.unread_count = 0
                       AND p.observed_at >= trigger_message.sent_at
                  )
                )
                OR EXISTS (
                  SELECT 1
                    FROM messages reply
                   WHERE reply.conversation_id = trigger_message.conversation_id
                     AND reply.is_self = 1
                     AND reply.sent_at > trigger_message.sent_at
                )
              )
        ) AS closed`,
      )
      .get(conversationId, replyToExternalId, cutoff ?? null, cutoff ?? null)
    return row?.closed !== 1
  }

  /**
   * 按 id 取一条草稿（**不限 state**）。
   *
   * ★ `SendGuard` 的第 ② 层用它重读库并比对 contentHash ——
   * 那一层的全部意义是"发的必须是被批准的那条"，所以它不能信内存里的
   * 对象，必须回库拿一次。
   */
  findDraft(
    id: string,
  ): { id: string; conversationId: string; text: string; editedText: string | null } | null {
    const row = this.db
      .prepare<
        [string],
        { id: string; conversation_id: string; text: string; edited_text: string | null }
      >(`SELECT id, conversation_id, text, edited_text FROM dh_drafts WHERE id = ?`)
      .get(id)
    return row === undefined
      ? null
      : {
          id: row.id,
          conversationId: row.conversation_id,
          text: row.text,
          editedText: row.edited_text,
        }
  }

  /**
   * 只存编辑后的正文，**不**改 state。
   *
   * ★ 为什么要与 `resolveDraft` 分开：真发送的顺序必须是
   * 「先落库编辑 → 再发」。守卫第 ② 层重读库时读到的必须是用户实际
   * 批准的那份（编辑后的），否则发出去的是编辑前的正文 ——
   * 而用户以为自己改过了。
   *
   * 用 `resolveDraft` 顺手存的话就做不到：它会同时把 state 改成 sent，
   * 而那时还没发。
   */
  saveDraftEdit(id: string, editedText: string): boolean {
    /**
     * ★ 只写 `edited_text` —— `dh_drafts` **没有** `updated_at` 列
     * （DDL 里只有 `created_at` 与 `resolved_at`，核对过）。
     * 第一版顺手写了 `updated_at = ?`，那会在运行时抛
     * `no such column` —— 而它只在用户真的编辑草稿再发时才走到，
     * 也就是最不希望出错的那条路上。
     */
    const result = this.db
      .prepare(`UPDATE dh_drafts SET edited_text = ? WHERE id = ? AND state = 'pending'`)
      .run(editedText, id)
    return result.changes > 0
  }

  /**
   * 回填「为什么没发出去」，**不**改 state。
   *
   * ★ 给自动发送那条路用：判定说能发，于是先落草稿再真发；发失败时
   * 草稿必须**留在 pending**（用户还能改一改再试），但箱子里那条得说清
   * 原因。不回填的话它长得和"还没轮到发"一模一样，而两者的处置完全不同。
   *
   * 与 `resolveDraft` 分开的理由同 `saveDraftEdit`：那个会把 state 一起
   * 改掉，而这里恰恰要保住 pending。
   */
  saveDraftNotSentReason(id: string, reason: string): boolean {
    const result = this.db
      .prepare(`UPDATE dh_drafts SET not_sent_reason = ? WHERE id = ? AND state = 'pending'`)
      .run(reason, id)
    return result.changes > 0
  }

  resolveDraft(
    id: string,
    state: "sent" | "discarded" | "expired",
    at: number,
    editedText?: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE dh_drafts SET state = ?, edited_text = COALESCE(?, edited_text), resolved_at = ?
          WHERE id = ? AND state = 'pending'`,
      )
      .run(state, editedText ?? null, at, id)
    // 只改 pending：重复点"发送"不该把已发的又标一次（那会掩盖重复发送）
    return result.changes > 0
  }

  /** 某会话最近的 run（运行日志视图）。 */
  recentRuns(conversationId: string, limit = 20): DhRunRow[] {
    return this.db
      .prepare<
        [string, number],
        {
          id: string
          conversation_id: string
          trigger_message_id: string | null
          draft_text: string | null
          confidence: number | null
          decision: string
          decision_reason: string | null
          risks_json: string | null
          latency_ms: number | null
          cost_tokens: number | null
          error: string | null
          created_at: number
        }
      >(
        `SELECT id, conversation_id, trigger_message_id, draft_text, confidence,
                decision, decision_reason, risks_json, latency_ms, cost_tokens,
                error, created_at
           FROM dh_agent_runs WHERE conversation_id = ?
          ORDER BY created_at DESC LIMIT ?`,
      )
      .all(conversationId, limit)
      .map((raw) => ({
        id: raw.id,
        conversationId: raw.conversation_id,
        triggerMessageId: raw.trigger_message_id,
        draftText: raw.draft_text,
        confidence: raw.confidence,
        decision: raw.decision,
        decisionReason: raw.decision_reason,
        failedConditions: parseKeywords(raw.risks_json),
        latencyMs: raw.latency_ms,
        costTokens: raw.cost_tokens,
        error: raw.error,
        createdAt: raw.created_at,
      }))
  }

  /**
   * 当前会话里用户真正关心的结果。
   *
   * 运行耗时、token 和内部拒因属于诊断信息，不适合作为数字分身页的主信息。
   * 这里仅返回已经成功发生的动作：自动发送、用户原样采纳、用户编辑后发送。
   */
  recentActivities(conversationId: string, limit = 20): PersonaActivityRow[] {
    return this.db
      .prepare<
        [string, number],
        {
          id: string
          conversation_id: string
          source: string
          text: string
          edited_text: string | null
          occurred_at: number
          run_id: string | null
        }
      >(
        `SELECT a.idempotency_key AS id,
                a.conversation_id,
                a.source,
                d.text,
                d.edited_text,
                COALESCE(a.sent_at, a.attempted_at) AS occurred_at,
                -- ★ run_id 白拿：这个 JOIN 本来就在（为了取正文），
                --   多带一列就让界面能回看那一轮的过程。见 PersonaActivityRow.runId
                d.run_id
           FROM dh_send_attempts a
           JOIN dh_drafts d ON d.id = a.draft_id
          WHERE a.conversation_id = ?
            AND a.state = 'sent'
            AND a.source IN ('agent_auto', 'user_approved')
          ORDER BY occurred_at DESC
          LIMIT ?`,
      )
      .all(conversationId, limit)
      .map((raw) => ({
        id: raw.id,
        conversationId: raw.conversation_id,
        kind:
          raw.source === "agent_auto"
            ? ("auto_sent" as const)
            : raw.edited_text !== null && raw.edited_text.trim() !== raw.text.trim()
              ? ("user_edited" as const)
              : ("user_accepted" as const),
        text: raw.edited_text ?? raw.text,
        occurredAt: raw.occurred_at,
        runId: raw.run_id,
      }))
  }

  /**
   * 一轮 run 的元信息（含触发消息）。找不到返回 null。
   *
   * ★ `LEFT JOIN messages`：`trigger_message_id` 可能指向一条已被保留策略
   * 清掉的消息 —— 那时元信息的其余部分（判定、耗时）仍然有价值，
   * 不该因为触发消息没了就整个查不到。
   */
  runDetail(runId: string): PersonaRunDetailRow | null {
    const row = this.db
      .prepare<
        [string],
        {
          id: string
          decision: string
          decision_reason: string | null
          latency_ms: number | null
          cost_tokens: number | null
          error: string | null
          sender_display_name: string | null
          content_text: string | null
        }
      >(
        `SELECT r.id, r.decision, r.decision_reason, r.latency_ms, r.cost_tokens, r.error,
                m.sender_display_name, m.content_text
           FROM dh_agent_runs r
           LEFT JOIN messages m ON m.id = r.trigger_message_id
          WHERE r.id = ?`,
      )
      .get(runId)
    if (row === undefined) return null
    return {
      runId: row.id,
      decision: row.decision,
      decisionReason: row.decision_reason,
      latencyMs: row.latency_ms,
      costTokens: row.cost_tokens,
      error: row.error,
      // 两个字段都空 = 触发消息查不到（已被清理），那时给 null 而不是一个空对象
      trigger:
        row.sender_display_name === null && row.content_text === null
          ? null
          : { senderDisplayName: row.sender_display_name, contentText: row.content_text },
    }
  }

  /**
   * 最近的发送时间戳（policy 的频率判定读它）。
   *
   * ## ★ 为什么必须从 `dh_send_attempts` 读，而不是传空数组
   *
   * `evaluatePolicy` 的 8 条里，`rate_limited` 是**唯一**防"数字人在群里
   * 连发"的那一条。而它的输入是 `recentSendsInConversation` /
   * `recentSendsGlobal` —— 传空数组时那条判定恒通过，
   * 也就是**限流完全没生效**，而外观与"限流工作正常"一模一样
   * （在没触发上限的时候两者行为相同）。
   *
   * 只算 `state = 'sent'`：`reserved`（占位未发）与 `blocked_no_grant`
   * 都没有真的发出去，算进来会让限流比实际更严
   * —— 那会让用户看到"明明没发几条却被限流"。
   *
   * ## ★ 给未来接 SendGuard 的人：这张表现在**没有写入方**
   *
   * 一期自动发送恒被 `grant_missing` 拦住，所以 `dh_send_attempts`
   * 在真实 vault 里是空的（核对过），限流因此**从不触发** ——
   * 这与"限流生效但没触上限"看起来完全一样。
   *
   * 接上 SendGuard 时**必须**在真发成功后写一行 `state = 'sent'`。
   * 漏了这一步的表现是：数字人在群里连发，而日志与界面上
   * 都显示一切正常 —— 而这是 policy 8 条里唯一防那件事的。
   *
   * 手动「标记已发」**刻意不**写这张表：那是用户自己复制过去发的，
   * 不是数字人的发送频率。
   *
   * @param conversationId 传了就只算该会话；不传算全局
   */
  recentSendTimestamps(options: { conversationId?: string; sinceMs: number }): number[] {
    const conversationId = options.conversationId
    if (conversationId === undefined) {
      return this.db
        .prepare<[number], { sent_at: number }>(
          `SELECT sent_at FROM dh_send_attempts
            WHERE state = 'sent' AND sent_at IS NOT NULL AND sent_at >= ?
            ORDER BY sent_at DESC`,
        )
        .all(options.sinceMs)
        .map((row) => row.sent_at)
    }
    return this.db
      .prepare<[string, number], { sent_at: number }>(
        `SELECT sent_at FROM dh_send_attempts
          WHERE conversation_id = ? AND state = 'sent'
                AND sent_at IS NOT NULL AND sent_at >= ?
          ORDER BY sent_at DESC`,
      )
      .all(conversationId, options.sinceMs)
      .map((row) => row.sent_at)
  }

  /**
   * 记一次发送尝试。**每次都写，成功与失败都写。**
   *
   * ## ★ 这个方法就是上面那段警告说的"写入方"
   *
   * 漏了它的后果不是"少一张审计表"，而是 **policy 的频率限制永远不触发**
   * —— 而那是 9 条里唯一防"数字人在群里连发"的一条。表现是数字人连发，
   * 而日志与界面都显示一切正常。
   *
   * ## 为什么失败也写
   *
   * 失败的尝试同样占用了一次对外调用，而且"连续失败很多次"本身是一个
   * 要能看见的信号（授权被撤销、网关限流）。只写成功的话
   * `dh_send_attempts` 会变成一张"看起来一切顺利"的表。
   *
   * 频率判定只算 `state = 'sent'`（见 `recentSendTimestamps`）——
   * 也就是"写下来"与"计入限流"是两件事，这里负责前者。
   *
   * ## 幂等键是主键
   *
   * 用 `INSERT OR REPLACE`：重试复用同一个 `idempotencyKey`（那是
   * 服务端幂等的要求），于是同一次逻辑发送在这张表里只有一行 ——
   * 最后一次的结果。用 `INSERT` 会在重试时抛主键冲突，
   * 而那时我们正在处理一个已经失败的发送，再抛一个错只会掩盖原因。
   */
  recordSendAttempt(input: {
    idempotencyKey: string
    draftId: string | null
    conversationId: string
    targetKind: "group" | "user" | "open_id"
    targetExternalId: string
    atExternalIds: readonly string[]
    contentHash: string
    grantId: string | null
    state: "reserved" | "sent" | "failed" | "blocked_no_grant"
    sentMessageExternalId: string | null
    /**
     * 平台返回的**任务** id（钉钉 `openTaskId`）。
     *
     * ★ 与消息 id 分开留：`send` 只返回它，消息 id 要再走一跳
     * `query-send-status`。那一跳失败时它是**唯一**的线索
     * （能事后补查，也能回答"为什么这条没标上分身发送"）。
     */
    sendTaskId?: string | null
    usedDryRun: boolean
    error: string | null
    attemptedAt: number
    /** 只有真发成功才有值 —— 频率判定读的正是这一列 */
    sentAt: number | null
    /** 自动发送会被隔离；用户审核后发送保留为本人语料。 */
    source: "agent_auto" | "user_approved"
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO dh_send_attempts
           (idempotency_key, draft_id, conversation_id, target_kind, target_external_id,
            at_external_ids, content_hash, grant_id, state, sent_message_external_id,
            send_task_id, used_dry_run, error, attempted_at, sent_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.idempotencyKey,
        input.draftId,
        input.conversationId,
        input.targetKind,
        input.targetExternalId,
        input.atExternalIds.length === 0 ? null : input.atExternalIds.join(","),
        input.contentHash,
        input.grantId,
        input.state,
        input.sentMessageExternalId,
        input.sendTaskId ?? null,
        input.usedDryRun ? 1 : 0,
        input.error,
        input.attemptedAt,
        input.sentAt,
        input.source,
      )
  }

  /**
   * agent **自主**发出去过的那些平台消息 id。
   *
   * 供采集侧对账用：这些消息会被采集回来，而它们**不是本人写的** ——
   * 不标出来就会被当成真实语料再蒸一遍，于是数字人开始模仿自己
   * （见 `MessageRepository.claimAgentOrigin` 的注释）。
   *
   * 用户在待审页明确采用的 `user_approved` 不在这里返回。那次点击本身
   * 就是用户选择，应保留为本人语料进入下一轮增量蒸馏。
   *
   * 只取 `state = 'sent'` 且有平台 id 的：`reserved` / `failed` /
   * `blocked_no_grant` 都没有真的发出去，把它们算进来会误标**别人**的消息
   * （那一列是 null，而 `IN (null)` 虽然匹配不到，但语义上是错的）。
   *
   * 带时间窗是因为这张表会一直长，而对账只需要覆盖"最近采集回来的那些"。
   */
  agentSentExternalIds(sinceMs: number): string[] {
    return this.db
      .prepare<[number], { external_id: string }>(
        `SELECT sent_message_external_id AS external_id
           FROM dh_send_attempts
          WHERE state = 'sent' AND source = 'agent_auto'
            AND sent_message_external_id IS NOT NULL
            AND attempted_at >= ?`,
      )
      .all(sinceMs)
      .map((row) => row.external_id)
  }
}
