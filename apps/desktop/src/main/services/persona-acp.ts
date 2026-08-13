/**
 * 数字分身的 opencode 编排 —— **每个 conversation 一个 ACP session**。
 *
 * ## 为什么单独一个文件而不是塞进 persona.service.ts
 *
 * 那个文件已经 2000+ 行，装着管控层接线、判定闸、发送、快照推送。
 * 而这里是一段**可以整块换掉**的东西：opencode 起不来时 PersonaService
 * 退回 `LlmClient` 直连（现在那条路），两者的接口都是"给上下文，出草稿"。
 * 混进去会让"能不能换回去"这件事看不出来。
 *
 * ## ★ 一个进程，多个 session
 *
 * 不是每会话一个 opencode **进程** —— 实测那个二进制 102MB，8 个常驻会话
 * 就是 8 份。ACP 协议本身支持一个进程开多个 session（`session/new` 返回
 * 各自的 id），所以：**进程单例 + 每会话一个 session**。
 *
 * 隔离靠三样，都不是"约定"而是结构：
 * · **cwd** —— 每会话一个 workspace，skill 与 AGENTS.md 铺在里面；
 * · **token scope** —— `kind:"persona"` + `scopeId:conversationId`，
 *   MCP server 在 SQL 的 WHERE 里硬加这个条件（见 mcp/auth.ts 文件头：
 *   群聊里一句 injection 就能查单聊，所以这一层必须是能力而不是参数）；
 * · **工具白名单** —— `TOOL_ALLOWLIST.persona`（有 profile_read，
 *   没有 dws_query）。
 *
 * ## ★ 事件按 acpSessionId 分派
 *
 * `AcpClient.onNotification` 是构造期单回调，而这里同时可能有 8 个 session
 * 在跑。所以维护一张 `acpSessionId → 该会话的收集器` 的表 —— 与
 * SearchService 那边同一个结论（那里刚从单例改过来）。
 *
 * 单例在并发下的失效形态是**串台**：A 会话的回答写进 B 会话，而两边都
 * 没有异常。
 */
import { AppError, type Clock, type Logger } from "@mycontext/kernel"
import {
  AcpClient,
  AcpSupervisor,
  McpAuth,
  buildOpencodeSpawn,
  createReverseHandlers,
  mapSessionUpdate,
  resolveGatewayModelConfig,
  ChatItemReducer,
  type AgentEvent,
  type ChatItem,
} from "@mycontext/agent-runtime"
import type {
  DuplexHandle,
  OpencodeResolution,
  ProcessRunner,
  RuntimeEnv,
} from "@mycontext/runtime-env"
import { createAgentResolver, probeBinaryVersion } from "@mycontext/runtime-env"
import { delimiter, join } from "node:path"
import { agentHomeFor, type AgentDirs } from "./agent-dirs.js"

/**
 * **协议动作**的超时（`initialize` / `session/new` / `session/dispose`）。
 *
 * 这些要么毫秒级返回，要么就是真的坏了（opencode 没起来 / 协议不匹配）。
 * 90s 足够宽松，同时保证一个起不来的子进程不会让调用方永久挂住。
 *
 * ★ `session/prompt` **不**走这个值 —— 见 `ACP_METHOD_TIMEOUTS`。
 */
const PROTOCOL_TIMEOUT_MS = 90_000

/**
 * 按方法覆盖超时。`null` = 不设限。
 *
 * ## ★★ 为什么 agent turn 不能有墙钟超时（真机实测，不是保险起见）
 *
 * 这里曾经是一个全局 `TURN_TIMEOUT_MS = 90_000`，理由写的是"数字分身是
 * 替人回消息，一条回复等两分钟已经失去意义"。那个**目标**是对的，
 * 但用墙钟超时去实现它掐掉的是「慢但有效」，而不是「坏了」：
 *
 * ```
 * 16:07:38  persona agent workspace ready
 * 16:09:09  persona acp turn failed  ACP 请求超时：session/prompt   ← 91s
 * 16:09:09  compose falling back to direct llm  reason: acp_turn_empty
 * 那一轮 latency_ms = 118445：91s 花在能查图谱的 ACP 路上，
 * 超时后降级到**没有工具**的直连又跑 27s，最终回了一句"不知道"。
 * ```
 *
 * 而一次 `kl ask` 实测就要 21–37s（建图抢网关时更久）。也就是说
 * "读上下文 + 调一次图谱 + 组织回答"本来就塞不进 90s —— 这个预算
 * 等于**禁用了 kl skill**：agent 每次刚查到东西就被掐掉。
 *
 * ★ 更糟的是失败形态：超时被 `acp_turn_empty` 吃掉，那一轮的
 * thought / tool_call **不落库**，于是草稿卡上「看生成过程」是空的，
 * 而降级生成的回复与正常回复长得一模一样。用户看到的只是"它说不知道"。
 *
 * 搜索侧早就是不设限的（`search.service.ts` 的 `ACP_METHOD_TIMEOUTS`），
 * 它的注释记着同一次教训：「按一个猜出来的秒数掐它，掐掉的是慢但有效」。
 *
 * ## 那靠什么终止
 *
 * 靠**事实**而不是推测：子进程死了 / 连接断了 → `AcpClient.close()`
 * 拒掉所有在途请求（见那里的注释，那是不设限请求的终止保证）。
 * 也就是判据从"猜它太慢"变成"连接确实没了"。
 *
 * ## ★ "不该等太久"这个目标去哪了
 *
 * 它仍然成立，只是**不该由这一层实现**。数字分身的时效性归调度那一层：
 * 一条消息等太久就出草稿让人来写（那是 `decision` 的事），
 * 而不是掐掉一个正在调工具的 agent 再用无工具的直连去编一个答案 ——
 * 后者产出的是**自信且无依据**的回复，比慢一点糟得多。
 */
const ACP_METHOD_TIMEOUTS = { "session/prompt": null } as const

/**
 * `session/prompt` 响应之后，还要等流"安静"多久才算收完。
 *
 * ## ★ 为什么必须等（真进程实测，不是保险起见）
 *
 * ACP 的响应帧**夹在 `agent_message_chunk` 之间**到达。
 * `scripts/probe-acp-stream.mjs` 的一次 dump（原样）：
 *
 * ```
 * 16 chunk "hold"     17 chunk "For"
 * 18 RESPONSE id=3 {"stopReason":"end_turn","outputTokens":24}   ← 响应在这里
 * 19 chunk "Re"  20 chunk "view"  21 chunk "\":"  22 chunk "false"
 * 23 chunk ",\"review"  24 chunk "R"  25 chunk "eason\":\"\"}"   ← 真正的结尾
 * ```
 *
 * 同一次运行：响应时刻拼到 `{"reply":"卢广仲","holdFor`（23 字符），
 * 1.5 秒后才是完整的 55 字符。库里那条 40 字符的坏草稿
 * （`{"reply": "哈哈好", "holdForReview": false,`）就是在响应那一刻取走的。
 *
 * ## 为什么是"等安静"而不是"等某条结束通知"
 *
 * 没有那条通知：`session-update-mapper.ts` 的文件头写明了
 * 「turn 结束 = `session/prompt` 的响应 resolve，不是某条 update」。
 * 而响应已经证明会早到，所以唯一可依赖的是**可观测事实**：流不再增长。
 * `tests/externals/acp-e2e.test.ts:318` 的 `settleStream` 是同一个结论。
 *
 * ## 600ms 的取值
 *
 * e2e 那边用 1.5s，因为它要容忍**模型思考**时的停顿（还没 end_turn）。
 * 这里已经拿到 `end_turn` 了，只需覆盖"响应与尾部 chunk 之间的传输间隙"——
 * 实测是毫秒级（上面那次 dump 里 7 条 chunk 在几十毫秒内到齐）。
 * 600ms 是两个数量级的余量，同时不给每条回复都加一秒的手感代价。
 */
const STREAM_SETTLE_MS = 600

/** 等流稳定的轮询间隔。与 e2e 的 `settleStream` 同一个口径。 */
const STREAM_POLL_MS = 100

/**
 * 等流稳定的**总**上限。
 *
 * 到点就把已收到的内容返回（并记 warn），**不返回 null** ——
 * 一条已经快拼完的草稿不该因为尾巴慢了就整个丢掉。
 * 它只在对端一直断续吐字时才会命中，那时长度已经足够长了。
 */
const STREAM_SETTLE_CEILING_MS = 10_000

/** 宿主 MCP server 端口。与搜索同一个（同一个进程内的同一个 server）。 */
const HOST_MCP_PORT = 47_999

export interface PersonaAcpOptions {
  clock: Clock
  logger: Logger
  runtime: RuntimeEnv
  processes: ProcessRunner
  /**
   * 当前 vault 的 agent 目录（workspace 根 + 隔离 HOME + npm 缓存）。
   *
   * ## ★ 为什么是**回调**而不是值
   *
   * 与下面 `skillPaths` 完全同一个理由：这些路径按 vault 分，而 vault 是
   * **跟着登录/切身份挂载**的 —— 本类在 `PersonaService` 构造时就 new 出来，
   * 那一刻还不知道会挂哪个身份。取值的话切身份后 transcript 片段仍写进
   * 上一个身份的目录，而那个错误是静默的（agent 照常跑、草稿照常出）。
   *
   * 返回 null = 还没挂载（未登录）→ 起 agent 这条路直接降级，
   * 由调用方落回 LlmClient 直连。
   */
  dirs: () => AgentDirs | null
  /**
   * kl-graph 代码根：追加进 PATH，让 skill 里的裸 `kl` 能被找到。
   *
   * ★★ **排在 venv/bin 之后**，不是最前 —— 见 `pythonEnv()` 上方那段。
   * 顺序放反会让裸 `kl` 命中上游那个坏掉的包装脚本，而失败被记成 success。
   */
  klRoot: string
  /** kl-server 端口（注入 env，kl CLI 据此连服务） */
  klPort: number
  /**
   * 取激活后的 Python 环境（`VIRTUAL_ENV` + `PATH` 前插 venv/bin）。
   *
   * ## ★★ 不给它 = agent **用不了 kl skill**（实测，且失败是静默的）
   *
   * 与 `SearchService.getPythonEnv` 同一个旋钮、同一个理由。这里曾经没有
   * 它，PATH 只是 `${klRoot}:${process.env.PATH}` —— 而那导致裸 `kl`
   * 命中的是仓库里那个包装脚本，它第 5 行无条件 exec
   * `${SCRIPT_DIR}/.venv/bin/python`，那个目录在我们的部署里**不存在**
   * （解释器在 `vendor/python/<platform>/venv`，不在 kl-graph 里）。
   *
   * 系统里有**两个** `kl`，谁在 PATH 前面决定成败：
   *
   * ```
   * <venv>/bin/kl        ← 我们生成的入口，能跑（实测 kl status 正常）
   * <klRoot>/kl          ← 上游包装脚本，exec 一个不存在的 .venv → 失败
   * ```
   *
   * ★ 而这个失败**记成 `tool_status: success`**：包装脚本 exec 不到解释器
   * 时"执行命令"这个动作本身没报错，于是 agent 看到命令跑完了、输出是一行
   * `No such file or directory`，然后按 skill 里「检索不到时不要编」的指示
   * 正常地回一句敷衍的话。库里那唯一一次 kl 调用就是这个形态
   * （tool_call 记 success，内容是两行 exec 报错）。日志里零 error ——
   * 又一例 CLAUDE.md §4 说的静默降级。
   *
   * 不给 / 返回 null → 退回 `process.env`，agent 查不了图谱但仍能回消息
   * （明确的能力降级，不阻止建会话）。
   */
  getPythonEnv?: () => Promise<{ python: string; env: NodeJS.ProcessEnv } | null>
  /**
   * skill 目录列表 —— 透传给 opencode 的 `skills.paths`（**指目录**，不再拷进 cwd）。
   *
   * ★ 为什么是回调而不是数组：`forgeSkillRoot` 在 `attach()` 时才定，而
   * opencode 进程是首次 `turn()` 才起（懒启动）。要让"启动时读到最新路径"
   * 语义稳定，必须每次 startAgent 现调；数组会锁死在构造那一刻。
   *
   * 未提供 / 返回空数组时，opencode 走它自己的默认（`<cwd>/.opencode/skills`），
   * 那时 agent 什么外部 skill 都读不到 —— 是明确的能力降级。
   */
  getSkillPaths?: () => readonly string[]
  /**
   * 这一轮用哪个模型（`runtimeConfig.resolved().modelMain`）。
   *
   * ★ 回调而不是值，与 `getSkillPaths` 同一个理由：opencode 是懒启动的，
   * 传值会锁死在构造那一刻，而设置页改完模型后应当"下次起 agent 就生效"。
   *
   * 为什么不直接读 env：`save()` 会 re-seed `process.env`，所以 env 那条路
   * 也是新的 —— 但 `resolved()` 才是三层解析（存的 > `.env` > 内置）的唯一
   * 真源。读它就不必依赖"seed 过了"这个前提；而那个前提一旦被破坏，
   * 表现是静默用错模型（不报错、只是回复风格变了）。
   *
   * 不给 = 退回 env（`MYCONTEXT_MODEL_MAIN`）再退回内置默认。单测走这条。
   */
  getModel?: () => string
  /**
   * 这一轮用哪个协议（`runtimeConfig.resolved().mainProvider`）。
   *
   * ★ 与 `getModel` 同一个理由由装配层显式给：`seedProcessEnv` 只在装配那一刻
   * 跑一次，用户之后在设置里切了协议、子进程是**之后**才 spawn 的，只靠 env
   * 会读到旧快照。不给 = 退回 env（`MYCONTEXT_MODEL_PROVIDER`）再退回 openai。
   */
  getProvider?: () => string
  /**
   * agent 的**过程**有更新时回调（thinking / 正文 / tool 调用组）。
   *
   * ★ 注入回调而不是给 `PersonaAcp` 塞 db + window：这个类的职责是"跑一轮
   * ACP"，让它知道怎么落库、怎么推 IPC 会把两件事绑死（照 `getSkillPaths`
   * 那种做法）。上层（`PersonaService`）接到之后既落 `dh_run_trace`
   * 也推 `personaTrace` 事件。
   *
   * `done` 为 true 表示这一轮结束（UI 据此收起"正在处理"的动效）。
   * 不给这个回调 = 不产出过程（老行为），一切照旧。
   */
  onTrace?: (input: { conversationId: string; items: readonly ChatItem[]; done: boolean }) => void
}

/** 一个 opencode 进程 + 它的 ACP client。 */
interface AgentHandle {
  transport: DuplexHandle
  client: AcpClient
  supervisor: AcpSupervisor
}

/**
 * 一轮 turn 的收集器：把流式事件攒成文本 **+ 用了哪些工具** + 可渲染的过程项。
 *
 * ## ★ 为什么工具名必须收集
 *
 * `dh_agent_runs.tool_calls_json` 长期是 `null`，于是"agent 到底调了什么"
 * 完全不可观测。实测代价：ACP 那条路上 `session/new` 连续失败时，我从
 * "零工具调用"推断成"agent 拿到 skill 却不听话"，而真相是 **session 一次都
 * 没建起来**。一个只能靠推断回答的问题，推断错了没有任何东西会红。
 *
 * 只收**工具名**，不收参数与返回值：参数里会有会话内容（`kl ask "<原话>"`），
 * 而这张表是给用户看"它做了什么"的，不该变成第二份聊天记录。
 *
 * ## `toolNames` 与 `items` 的分工
 *
 * 前者是**摘要**（进 `dh_agent_runs.tool_calls_json`，回答"它调了什么"）；
 * 后者是**过程**（进 `dh_run_trace`，回答"它是怎么想的"，含 thinking 与
 * 工具的标题/状态）。两者粒度与去处都不同，所以各存一份而不是从
 * `items` 里现算 —— 现算会让摘要依赖过程那条路是否接上。
 */
interface TurnCollector {
  conversationId: string
  turnId: string
  /**
   * **只装 `text_delta`** —— 也就是"要发出去的那段话"。
   *
   * ★ 这一点不能变：`settleStream` 靠 `chunks.join("")` 判"流稳了没有"，
   * 而那正是"半截 JSON 进草稿"那个 bug 的防线。把 thought / tool 文本混进来
   * 会改变那个判据的含义（thinking 还在吐字时它会以为回复还没写完），
   * 而且更糟的是**模型的内心独白会被拼进草稿正文**。
   *
   * 过程内容一律走 `reducer`，与这里物理隔开。
   */
  chunks: string[]
  /** 本轮调用过的工具名，按首次出现排序、去重 */
  toolNames: string[]
  /**
   * 过程项（thinking / 正文 / tool 调用组）。
   *
   * 复用搜索模块那套 `ChatItemReducer`：它已经把 ACP 的事件流折叠成
   * 「一行 = 一个可渲染项」，且落库形态与渲染形态相同（见它的文件头）。
   */
  reducer: ChatItemReducer
  /** reducer 产出的全部 item（按 seq 有序），轮末交给 onTrace。 */
  items: Map<string, ChatItem>
}

export class PersonaAcp {
  private agent: AgentHandle | null = null
  private starting: Promise<AgentHandle | null> | null = null
  private readonly mcpAuth: McpAuth
  /** 按 acpSessionId 索引的在途 turn（并发下防串台，见文件头）。 */
  private readonly turns = new Map<string, TurnCollector>()
  /** conversationId → acpSessionId。resume 用（跨轮复用同一个 session）。 */
  private readonly sessionIds = new Map<string, string>()
  private turnSeq = 0

  constructor(private readonly options: PersonaAcpOptions) {
    this.mcpAuth = new McpAuth({ clock: options.clock })
  }

  /**
   * opencode 的解析 + 版本闸结果，**成功后**缓存。
   *
   * 每次 turn / `available()` 都 `--version` spawn 一次是每轮多 ~270ms，
   * 而成功的结果在进程生命周期内不会变（bundled 那份不会中途换）。
   *
   * ★ 失败**不缓存** —— 冷启动那次探测可能因为签名校验超时而假失败，
   * 缓存住就要重启应用才能恢复。理由与实测数字见 `createAgentResolver`。
   *
   * 惰性建而不是写成字段初始值：`target: ES2022` 下字段初始值在**构造函数体
   * 之前**求值，而 `options` 是参数属性（在体内才赋值）—— 那时 `this.options`
   * 还是 undefined。
   */
  private resolver: (() => OpencodeResolution) | null = null

  private resolveOnce(): OpencodeResolution {
    this.resolver ??= createAgentResolver(this.options.runtime, probeBinaryVersion)
    return this.resolver()
  }

  /** opencode 可用（找得到 **且** 版本达标）→ 走 ACP，否则降级到 LlmClient 直连。 */
  available(): boolean {
    return this.resolveOnce().ok
  }

  /**
   * 为什么不可用 —— 给 UI 一句**可操作**的话。`null` = 可用（无需降级说明）。
   *
   * ★ 区分"没装"与"太老"：前者引导去装，后者引导去升级 —— 两种下一步不同。
   * 太老那句带上实测到的版本号与门槛，因为它正是同事那个 `-32603` 的根因，
   * 说清"你这份 1.2.15 的 ACP 不带鉴权头，与本应用的安全加固不兼容"。
   */
  degradedReason(): string | null {
    const r = this.resolveOnce()
    if (r.ok) return null
    if (r.reason === "missing") return "opencode_missing"
    if (r.reason === "unreadable_version") return "opencode_version_unreadable"
    return `opencode_too_old:${r.found}<${r.required}`
  }

  /**
   * 跑一轮：给上下文，出文本。
   *
   * **不抛**能力性错误（起不来 / 超时）—— 那些返回 null 让调用方降级。
   * 只有"我们自己"的逻辑错误才该冒泡。
   */
  async turn(input: {
    conversationId: string
    /** 已渲染好的 prompt（画像来自 workspace 里的 skill，这里只给对话与指令） */
    prompt: string
    /**
     * 随 prompt 一起送的图片，顺序与 prompt 里的 `[图片 N]` 对应。
     *
     * ## ★ 为什么图必须走这里，而不是"给路径让 agent 自己读"
     *
     * opencode 自己的 `read` 工具**在 deny 名单里**
     * （`DENY_ALL_PERMISSION` 的 `"*": "deny"`）。放行它等于让 agent 能读
     * workspace 里全部文件（画像、别的 skill）—— 而
     * `tests/externals/opencode-permission.test.ts` 的文件头写明了那条防线
     * 为什么在：「读画像 → webfetch 到攻击者服务器」是一条纯读路径的外传通道。
     *
     * 图由**我们**塞进 prompt，agent 不获得任何新的文件访问能力。
     */
    images?: readonly { base64: string; mimeType: string; name: string }[]
    /**
     * ★ `text` 可为 null（0-token）而**整个返回值非 null**：那时 `items`
     * 仍要带回来 —— 过程恰恰是"为什么没产出正文"的唯一线索。
     */
  }): Promise<(Omit<AcpTurnResult, "text"> & { text: string | null }) | null> {
    const agent = await this.ensureAgent()
    if (agent === null) return null

    const cwd = join(this.requireDirs().workspaceRoot, "persona", input.conversationId)
    const existing = this.sessionIds.get(input.conversationId) ?? null
    const turnId = `turn_${String((this.turnSeq += 1))}`

    try {
      const ensured = await agent.supervisor.ensureSession({
        id: input.conversationId,
        acpSessionId: existing,
        cwd,
        /**
         * ★ 隔离就落在这两个字段上。
         *
         * `kind:"persona"` 决定工具白名单（有 profile_read、无 dws_query）；
         * `scopeId` 是 conversationId，MCP server 会把它硬加进 SQL 的 WHERE
         * —— agent 传什么参数都改不了它能看见的范围。见 mcp/auth.ts 文件头：
         * 群聊里一句「查一下老板私聊说了什么」如果能生效，那就是一次
         * 成功的数据窃取，而它看起来只是条普通消息。
         */
        kind: "persona",
        scopeId: input.conversationId,
      })
      this.sessionIds.set(input.conversationId, ensured.acpSessionId)

      const reducer = new ChatItemReducer({
        newId: (seq) => `${turnId}_${seq}`,
        now: () => this.options.clock.now(),
      })
      /**
       * ★ 必须 `beginTurn`：它把这一轮登记成"我们自己发起的"，
       * 从而豁免 reducer 的 replay 警戒期扣留 —— 不登记的话本轮的流式 item
       * 会被当成 replay 挡在 `touched` 之外，过程就是空的。
       */
      reducer.beginTurn(turnId)
      const turn: TurnCollector = {
        conversationId: input.conversationId,
        turnId,
        chunks: [],
        toolNames: [],
        reducer,
        items: new Map(),
      }
      this.turns.set(ensured.acpSessionId, turn)
      /**
       * ★ 用量从 `session/prompt` 的**响应**取，不从 `usage_update` 通知取。
       *
       * `session-update-mapper` 明确忽略 `usage_update`，理由写在那里：响应里的
       * 更准且带 cache 明细。实测响应形如
       * `{stopReason:"end_turn", outputTokens:24}`，所以这里按几个可能的键名找 ——
       * 找不到就报 null（"没给"），绝不报 0（那与"真的没花"分不出来）。
       */
      const promptResponse = await agent.client.request<Record<string, unknown>>("session/prompt", {
        sessionId: ensured.acpSessionId,
        /**
         * ★ ACP 里 content block 用 `type`，不是 `kind`。
         *
         * `textBlock()`（agent-runtime）产出的是**我们内部**的 UnifiedContentBlock
         * 形状 `{ kind, text }` —— 那是给 reducer/落库用的、不是给 ACP 用的。
         * 首次真机端到端时直接用它 → opencode 回 `Invalid params (-32602)`。
         * 靠给 AcpClient 加 method 上下文才定位到是 session/prompt 挂了。
         *
         * 见 acp-e2e：那里所有 prompt 都写着 `{ type: "text", text: ... }`。
         *
         * ## ★ 图片块的形状（从 opencode 二进制里挖出来的，不是猜的）
         *
         * 它的 ACP prompt 分派代码：
         * ```js
         * case"image": if(n.data) return [{type:"file",
         *   url:`data:${n.mimeType};base64,${n.data}`, filename:…, mime:n.mimeType}]
         * ```
         * 也就是 `{ type:"image", data:<base64>, mimeType }` 会被转成模型的
         * file part。字段名是 `data`（不是 `base64`）、`mimeType`（不是 `mime`）
         * —— 这一层的字段名踩过一次（`{kind}` vs `{type}`，见上），所以照抄对端。
         *
         * ★ **文本块必须在第一个**：prompt 里的 `[图片 1]` 要先建立
         * "接下来这几张分别是谁发的"这个映射，模型才知道图属于谁。
         * 反过来它先看到一堆无标注的图。
         */
        prompt: [
          { type: "text", text: input.prompt },
          ...(input.images ?? []).map((image) => ({
            type: "image",
            data: image.base64,
            mimeType: image.mimeType,
          })),
        ],
      })
      /**
       * ★ 响应回来了**不等于**文本收完 —— 再等流稳定。见 `STREAM_SETTLE_MS`。
       *
       * 把这一步省掉的代价不是"偶尔少几个字"，而是一条**半截 JSON**
       * 进草稿箱（库里那条 40 字符的 `…"holdForReview": false,` 就是）。
       */
      const collected = await this.settleStream(ensured.acpSessionId, input.conversationId)
      const toolNames = this.turns.get(ensured.acpSessionId)?.toolNames ?? []
      /**
       * ★ 补一条 `turn_end` 再收摊。
       *
       * `mapSessionUpdate` **永不产** `turn_end`（见它的文件头：ACP 的
       * 响应帧夹在流中间，对端不会明确说"这一轮完了"）—— 它由调用方合成，
       * 搜索模块也是这么做的。不补的话流式的 message / thought **永不 finalize**，
       * 过程里那条正文会一直停在"正在写"的状态。
       */
      this.emitTrace(turn, [{ type: "turn_end", turnId }], true)
      const items = [...turn.items.values()].sort((left, right) => left.seq - right.seq)
      this.turns.delete(ensured.acpSessionId)
      /**
       * 空文本当失败。
       *
       * ★ 0-token 静默返回是这条链路最典型的失效（模型没配对、配额耗尽、
       * 权限拒了工具而模型放弃）—— 返回空串会让调用方把它当成一条
       * "内容为空的草稿"落库，而那在界面上看起来像模型认为无需回复。
       *
       * ★ 失败时也**带上 items**：过程恰恰是"为什么没产出正文"的唯一线索
       * （工具被拒？检索空？），把它一起丢掉等于把排查入口关掉。
       */
      const totalTokens = tokensOf(promptResponse)
      return collected.trim() === ""
        ? { text: null, toolNames, totalTokens, items }
        : { text: collected, toolNames, totalTokens, items }
    } catch (error) {
      this.options.logger.warn("persona acp turn failed", {
        conversationId: input.conversationId,
        detail: error instanceof Error ? error.message : String(error),
        /**
         * ★ 带上完整错误上下文。
         *
         * "ACP 错误：Invalid params" 只告诉我们对端拒绝，没说是哪个 method 的
         * 哪个字段。真机端到端首次跑挂时，正是靠这一段才能定位到具体请求 ——
         * 而 `AppError.context` 在 client 那侧填了 code / 我们在哪里加 method。
         */
        errorContext:
          error && typeof error === "object" && "context" in error
            ? (error as { context?: unknown }).context
            : undefined,
      })
      for (const [key, turn] of this.turns) {
        // 只清自己那条 —— clear() 会抹掉别的会话正在跑的 turn
        if (turn.conversationId === input.conversationId) this.turns.delete(key)
      }
      return null
    }
  }

  /** 会话被 LRU/空闲回收：撤它的 token，并忘掉 session id。 */
  release(conversationId: string): void {
    this.mcpAuth.revoke({ kind: "persona", scopeId: conversationId })
    const acpSessionId = this.sessionIds.get(conversationId)
    if (acpSessionId !== undefined) this.turns.delete(acpSessionId)
    this.sessionIds.delete(conversationId)
  }

  /** 收进程与全部 token。登出/退出时调。 */
  async dispose(): Promise<void> {
    for (const conversationId of [...this.sessionIds.keys()]) this.release(conversationId)
    const agent = this.agent
    this.agent = null
    if (agent !== null) await agent.transport.close().catch(() => undefined)
  }

  /**
   * 等这一轮的流不再增长，返回拼好的全文。
   *
   * ## 判据是「流停了」这个可观测事实
   *
   * 不依赖任何"结束通知"—— 那种通知不存在（见 `STREAM_SETTLE_MS` 与
   * `session-update-mapper.ts` 的文件头），而 `session/prompt` 的响应
   * 已经证明会在流中间到达。`tests/externals/acp-e2e.test.ts:318` 的
   * `settleStream` 是同一个结论、同一套轮询。
   *
   * ## 为什么这里不 import 那个测试里的函数
   *
   * 那是测试代码，生产不该依赖它的生命周期（它会为了测别的东西改参数）。
   * 两处各一份的代价在这里是可接受的：这段逻辑没有分支，且两侧的判据
   * （轮询 + 稳定窗口 + 总上限）在注释里互相指着。
   *
   * ## 超时返回**已收到的**，不返回 null
   *
   * 到 `STREAM_SETTLE_CEILING_MS` 还在断续吐字时，已经攒到的那段通常
   * 已经是完整回复了；丢掉它换一个 null 会让调用方去走"生成失败"分支，
   * 那是一次凭空的降级。记 warn 让它可查。
   */
  private async settleStream(acpSessionId: string, conversationId: string): Promise<string> {
    const read = (): string => this.turns.get(acpSessionId)?.chunks.join("") ?? ""
    const startedAt = Date.now()
    let last = read()
    let lastChangedAt = Date.now()

    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, STREAM_POLL_MS))
      const current = read()
      if (current !== last) {
        last = current
        lastChangedAt = Date.now()
      } else if (Date.now() - lastChangedAt >= STREAM_SETTLE_MS) {
        /**
         * ★ 空文本也在这里返回，**不**等满上限。
         *
         * 0-token 是常见的失效（见 `turn()` 里那段注释），让它多等 10 秒
         * 只是把一次已经确定的失败拖慢 —— 而调用方那侧还有人在等草稿。
         */
        return current
      }
      if (Date.now() - startedAt > STREAM_SETTLE_CEILING_MS) {
        this.options.logger.warn("persona acp stream did not settle; using partial text", {
          conversationId,
          length: current.length,
          waitedMs: Date.now() - startedAt,
        })
        return current
      }
    }
  }

  /** 收到一条 ACP 通知：按 sessionId 找到对的 turn，攒文本、工具名与过程。 */
  private onNotification(method: string, params: unknown): void {
    if (method !== "session/update") return
    const acpSessionId = (params as { sessionId?: unknown } | null)?.sessionId
    // 取不到 id 就丢弃 —— 投给"唯一那个 turn"在并发下就是串台
    if (typeof acpSessionId !== "string") return
    const turn = this.turns.get(acpSessionId)
    if (turn === undefined) return
    const events = mapSessionUpdate(params, turn.turnId)
    for (const event of events) {
      // ★ chunks 只收 text_delta（见 TurnCollector.chunks 的注释）。
      turn.chunks.push(textOf(event))
      // 去重：`tool_call` 与后续的 `tool_call_update` 是同一次调用的两个阶段
      if (event.type === "tool_call" && !turn.toolNames.includes(event.toolName)) {
        turn.toolNames.push(event.toolName)
      }
    }
    /**
     * 同一批事件**再**喂给 reducer 拿可渲染的过程项。
     *
     * 两条路径分开而不是共用一个字符串：一个是"要发出去的话"，
     * 一个是"它是怎么想出来的"。混在一起就是上面那个 bug。
     */
    this.emitTrace(turn, events, false)
  }

  /**
   * 把事件喂给 reducer 并把增量交给上层。
   *
   * `done` 为 true 时表示这一轮结束（`turn()` 在 settle 之后补一条
   * `turn_end` 再调一次）。失败只记日志：过程可见是**附加**能力，
   * 它出错不该让这一轮回复失败。
   */
  private emitTrace(turn: TurnCollector, events: readonly AgentEvent[], done: boolean): void {
    if (this.options.onTrace === undefined) return
    try {
      const { touched } = turn.reducer.apply(events)
      for (const item of touched) turn.items.set(item.id, item)
      if (touched.length === 0 && !done) return
      this.options.onTrace({
        conversationId: turn.conversationId,
        // 按 seq 有序：渲染顺序的唯一依据（见 ChatItem 的注释）。
        items: [...turn.items.values()].sort((left, right) => left.seq - right.seq),
        done,
      })
    } catch (error) {
      this.options.logger.warn("persona acp trace failed", {
        conversationId: turn.conversationId,
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async ensureAgent(): Promise<AgentHandle | null> {
    if (this.agent !== null) return this.agent
    if (this.starting !== null) return this.starting
    this.starting = this.startAgent().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  /**
   * 当前 vault 的 agent 目录。未挂载时抛错 —— 调用点（startAgent / cwd）
   * 都在 try 里，会被当成"agent 起不来"而降级到 LlmClient 直连。
   * 退回一个应用级目录才是危险的：那是一次静默的跨身份写入。
   */
  private requireDirs(): AgentDirs {
    const dirs = this.options.dirs()
    if (dirs === null) throw new AppError("DB_UNAVAILABLE", "尚未登录，agent 目录未就绪")
    return dirs
  }

  /**
   * 激活后的 Python 环境，缓存一次。
   *
   * 缓存的理由与搜索侧一致：`getPythonEnv` 可能要装依赖（一次性的事），
   * 而 `startAgent` 每次 agent 重起都会调到。**null 也缓存** —— 避免反复
   * 重试一个注定失败的准备过程，那会让每次 turn 都白卡几秒。
   */
  private pythonEnvCache: { value: { python: string; env: NodeJS.ProcessEnv } | null } | null = null

  private async pythonEnv(): Promise<{ python: string; env: NodeJS.ProcessEnv } | null> {
    if (this.pythonEnvCache !== null) return this.pythonEnvCache.value
    const get = this.options.getPythonEnv
    const value = get === undefined ? null : await get().catch(() => null)
    this.pythonEnvCache = { value }
    return value
  }

  private async startAgent(): Promise<AgentHandle | null> {
    const usable = this.resolveOnce()
    // 版本闸没过就降级 —— 用一份太老的 opencode 起 ACP 会一路 -32603（见 binaries.ts）。
    if (!usable.ok) return null
    const resolved = usable.binary
    try {
      const modelConfig = resolveGatewayModelConfig(
        process.env,
        this.options.getModel?.(),
        this.options.getProvider?.(),
      )
      /**
       * ★★ 基底是**激活后的 Python 环境**，`klRoot` 追加在 venv/bin **之后**。
       *
       * 顺序是这一段的全部要点，见 `getPythonEnv` 选项上方那段：两个同名的
       * `kl` 里只有 venv 那个能跑，而上游包装脚本失败时会被记成 success。
       * 这里曾经是 `PATH: ${klRoot}:${process.env.PATH}`（klRoot 在最前、
       * 且完全不激活 venv），于是数字分身这一路**从来没成功调起过 kl** ——
       * 而同期搜索 tab 是好的，因为它一直是这么拼的（`search.service.ts`）。
       *
       * ★ 曾经这行的注释写着「与搜索同一个口径」。那句话是错的，
       * 而正是它让这个差异一直没被看见 —— 注释里的"实测结论"有保质期
       * （CLAUDE.md §4），与当前行为冲突时要重新实测，不要照抄。
       */
      const activated = await this.pythonEnv()
      const basePath = activated?.env["PATH"] ?? process.env["PATH"] ?? ""
      const baseEnv: NodeJS.ProcessEnv = {
        ...(activated?.env ?? process.env),
        PATH: `${basePath}${delimiter}${this.options.klRoot}`,
        KL_SERVER_PORT: String(this.options.klPort),
      }
      /**
       * ★ 拿不到 venv 时说出来 —— 那意味着 agent 这一轮查不了图谱。
       * 静默退回 `process.env` 的表现是"它就是没查"，与"它查了但没结果"
       * 在界面上一模一样。
       */
      if (activated === null) {
        this.options.logger.warn("python env unavailable; persona cannot query the graph", {
          klRoot: this.options.klRoot,
        })
      }
      /**
       * ★ agentHome 按 vault 走；npm 缓存留在应用级一份（见 AgentDirs）。
       * 两个旋钮必须**一起**给：只给前者的话缓存跟着隔离 HOME 走，
       * 每个身份各攒一份 325 MB。
       */
      const dirs = this.requireDirs()
      /**
       * ★★ 数字分身用**自己的** HOME，与搜索不共用。
       *
       * 改动前两者共用 `agentHome`，而 opencode 的 session 存储在
       * `$XDG_DATA_HOME/opencode/opencode.db` —— 实测两个 opencode 共用
       * 同一个数据目录时，后起的那个撞在 `CREATE TABLE workspace` 上
       * **直接起不来**。现在没炸只是因为两条路径都是懒启动、时序上还没撞上；
       * 搜索加了档位之后一定会撞（三个档位 + 数字人 = 四个进程可能同时活着）。
       *
       * ★ 代价为零：`sessionIds` 是内存 Map（见文件头），重启后本来就不
       * resume —— 换数据目录不损失任何东西。
       */
      const homeOption = {
        agentHome: agentHomeFor(dirs.home, "persona"),
        npmCache: dirs.npmCache,
        isolateData: true,
      }
      /**
       * ★ skillPaths 每次 startAgent 现调 —— 不是构造时锁死一次。
       * `forgeSkillRoot` 在 attach 时才有值，蒸馏后新出的画像下次起 agent 就生效。
       */
      const paths = (this.options.getSkillPaths?.() ?? []).filter((p) => p !== "")
      const skillOption = paths.length > 0 ? { skillPaths: paths } : {}
      const hardened = buildOpencodeSpawn(
        modelConfig !== null
          ? { baseEnv, modelConfig, allowKlCommand: true, ...homeOption, ...skillOption }
          : { baseEnv, allowKlCommand: true, ...homeOption, ...skillOption },
      )
      // ★ persona 白名单：有 profile_read，没有 dws_query（见 TOOL_ALLOWLIST）
      const handlers = createReverseHandlers({
        kind: "persona",
        onToolAudit: (entry) =>
          this.options.logger.debug("persona tool audit", {
            toolName: entry.toolName,
            allowed: entry.allowed,
          }),
      })

      const transport = this.options.processes.spawnDuplex({
        executable: resolved.path,
        args: hardened.args,
        env: hardened.env,
        cwd: dirs.workspaceRoot,
        onLine: (line: string) => client.handleLine(line),
        onStderr: (line: string) => this.options.logger.debug("opencode stderr", { line }),
        onExit: (info) => {
          this.options.logger.warn("persona opencode exited", {
            code: info.code,
            signal: info.signal,
            /** 有在途请求时说出来 —— 那意味着这一轮是被进程死亡打断的 */
            pending: client.pendingCount,
          })
          if (this.agent?.transport === transport) this.agent = null
          /**
           * ★★ 必须拒掉在途请求 —— 这是 `session/prompt` **不设限**之后的
           * 终止保证（见 `ACP_METHOD_TIMEOUTS`）。
           *
           * 没有墙钟定时器的请求不会自己放弃：子进程死了而没人 `close()`，
           * 那个 promise 就**永久挂住**，`handleBatch` 一直 await，
           * 这个会话的草稿再也不出，而日志里只有一行 exited。
           * 那是把"超时失败"换成了"静默卡死" —— 更难查。
           *
           * `close()` 幂等（内部先置 `closed`），所以与 `dispose()` 那条路
           * 重复调没有副作用。
           */
          client.close()
        },
      })

      const client = new AcpClient({
        transport,
        logger: this.options.logger.child("Acp"),
        onNotification: (method, params) => this.onNotification(method, params),
        reverseHandlers: {
          "session/request_permission": (params) =>
            handlers.requestPermission(params as { toolName: string }),
          "fs/read_text_file": (params) =>
            handlers.readTextFile({
              path: (params as { path?: string }).path ?? "",
              workspaceRoot: dirs.workspaceRoot,
            }),
          "fs/write_text_file": () => handlers.writeTextFile(),
        },
        requestTimeoutMs: PROTOCOL_TIMEOUT_MS,
        // ★ `session/prompt` 不设限 —— 见 `ACP_METHOD_TIMEOUTS` 上方那段实测
        methodTimeouts: ACP_METHOD_TIMEOUTS,
      })

      await client.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      })

      const supervisor = new AcpSupervisor({
        client,
        mcpAuth: this.mcpAuth,
        mcpPort: HOST_MCP_PORT,
        logger: this.options.logger.child("AcpSup"),
        // kl 走 skill（`kl` CLI），不注入宿主 MCP 工具 —— 与搜索同一期口径
        hostToolsEnabled: false,
        onSessionIdChanged: (recordId, acpSessionId) => {
          this.sessionIds.set(recordId, acpSessionId)
        },
        // 数字分身不回放历史（每轮 prompt 自带上下文），所以抑制窗口是空操作
        beginReplaySuppression: () => () => {},
      })

      const handle: AgentHandle = { transport, client, supervisor }
      this.agent = handle
      this.options.logger.info("persona opencode started", { path: resolved.path })
      return handle
    } catch (error) {
      /**
       * 起不来是**降级**不是错误：退回 LlmClient 直连。
       * 但要记 warn —— 静默降级是这个项目里反复出现的那类失效。
       */
      this.options.logger.warn("persona opencode failed to start", {
        detail: error instanceof Error ? error.message : String(error),
      })
      if (error instanceof AppError) throw error
      return null
    }
  }
}

/**
 * 从一个 AgentEvent 里取正文。
 *
 * ★ 只收 `text_delta`。刻意**不收** `thought_delta` —— 那是思考过程
 * （网关那侧对应 `reasoning_content`，见 llm/client.ts 记的那三个坑）。
 * 把它拼进草稿的话，用户会看到模型的内心独白被当成要发出去的话。
 *
 * 工具调用/结果/plan/citation 也不进草稿：那些是过程，不是回复。
 */
function textOf(event: AgentEvent): string {
  return event.type === "text_delta" ? event.text : ""
}

/**
 * 一轮 ACP turn 的产物。
 *
 * ★ 从"返回一个字符串"改成结构体：文本之外还要带出**用了哪些工具**与**用量**，
 * 而那两样原来在这一层被丢掉，于是 `dh_agent_runs` 里恒为 null（见 TurnCollector）。
 */
/**
 * 从 `session/prompt` 的响应里找用量。
 *
 * 键名按实测与 ACP 惯例依次尝试；一个都没有就返回 null。**不兜 0** ——
 * "对端没报用量"与"这一轮真的没花 token"是两件事，而后者几乎不可能发生，
 * 把前者记成 0 会让成本统计静默偏低。
 */
function tokensOf(response: Record<string, unknown> | null | undefined): number | null {
  if (response === null || response === undefined) return null
  const usage = response["usage"]
  const nested =
    usage !== null && typeof usage === "object" ? (usage as Record<string, unknown>) : {}
  for (const value of [
    response["totalTokens"],
    response["outputTokens"],
    nested["totalTokens"],
    nested["total_tokens"],
    nested["outputTokens"],
  ]) {
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return null
}

export interface AcpTurnResult {
  text: string
  /** 本轮调用过的工具名（去重）。空数组 = 确实一次都没调，而不是"没记录" */
  toolNames: readonly string[]
  /** 本轮用量；opencode 没给就是 null（区分"没给"与"是 0"） */
  totalTokens: number | null
  /**
   * agent 的**过程**（thinking / 正文 / tool 调用组）。
   *
   * 与 `toolNames` 的分工见 `TurnCollector` 的注释：那个是摘要（"调了什么"），
   * 这个是过程（"怎么想的"，含 thinking 正文与工具状态）。空数组 = 没接
   * `onTrace` 或这一轮确实没有事件。
   */
  items: readonly ChatItem[]
}
