/**
 * 判定闸 —— 跑**已发布的 forge 产物**拿「这条能不能自己回」的结论。
 *
 * ## ★ 为什么判定不写在 TypeScript 里
 *
 * 决策层的权威判据是 forge 编译出来的 `references/rules.json`，
 * 而消费它的逻辑（`classify` + `decide_action`）已经在产物自带的
 * `scripts/persona.py` 里。照抄一份到这里是 forge 明确拒绝的形态 ——
 * `compose.render_rules` 的注释原话：「a second source of truth for policy
 * would drift from the first, and **the drift would be invisible**」。
 *
 * 不可见是关键：两份判定不一致的表现不是报错，而是"某一类问题突然开始
 * 自动回了"。所以这里 spawn 产物自己那份，宁可多两个子进程。
 *
 * ## ★ 为什么不能读 `decisions.md` 让模型判
 *
 * 那份是**给人看的表**，带着测出来的百分比。forge 的同一段注释说明了
 * 为什么弱模型读它是危险的：它会看到「other question · 92.2% · answer」
 * 然后得出"我什么都能答"—— **测出来的比率是证据，不是许可**。
 * `rules.json` 就是为此存在的机器可读孪生，而消费它的是这里。
 *
 * ## ★ `null` 表示「判定不可得」，绝不表示「通过」
 *
 * 缺 Python、还没蒸馏过、脚本输出不是 JSON、超时 —— 全都返回 null。
 * 三个调用点必须把 null 当**降级为草稿**处理（fail closed）。
 * 把它当通过会让"没装 Python"这件事变成"自动发送全放行"，
 * 而那个错误在界面上与一切正常完全一样。
 *
 * `persona.py` 自己也是这个口径：`load_rules()` 读不到时返回 `_unavailable`，
 * 而 `decide_action` 见到它就 `downgrade("draft", …)`。
 *
 * ## 只跑三个只读子命令
 *
 * `brief` / `check` / `fresh`。**刻意不跑 `send`** —— 发送必须走
 * `SendGuard` 四层（授权门、contentHash 重读、幂等键、审计表），
 * 而 `persona.py send` 会去调它自己的 dws 客户端，绕过全部四层。
 * vault 源为此声明了 `CAPS.send = false`，这里与它同一个口径。
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { Logger } from "@mycontext/kernel"
import type { ProcessRunner, ResolvedPython } from "@mycontext/runtime-env"

/**
 * forge 发布的 persona 包在 workspace 里的目录名。
 *
 * 与 `PersonaService.installForgeSkills` 拷过去的结构同源：
 * `<cwd>/.opencode/skills/persona-persona/`。对不上时 `available()`
 * 会如实返回 false（而不是让子进程去报一个 Python 的 FileNotFoundError）。
 */
export const PERSONA_SKILL_DIRNAME = "persona-persona"

/**
 * 单次判定的超时。
 *
 * 三个子命令都是「读一个 SQLite + 跑若干正则」，实测量级是百毫秒。
 * 15 秒给的是余量而不是预期耗时 —— 到点算判定不可得（也就是降级），
 * 因为一个卡住的判定进程比一次失败的判定更难查。
 */
const GATE_TIMEOUT_MS = 15_000

/**
 * `brief` 的判定 **与它算出来的理解**。
 *
 * ## ★ 为什么不只取 `verdict`
 *
 * 曾经这里只 `return { verdict, because }`，把 `brief` 另外算好的十几个字段
 * 全丢掉 —— 而那些字段恰恰是"读懂这一轮在说什么"的全部依据。后果实测：
 * 起草提示词退化成「请起草对**最后一条**的回复」，于是
 *
 * · 对方连发三条讲一件事时，只有最后一条进了提示词（`answering` 丢了）；
 * · 这一串在回本人之前哪句话，模型得自己从 30 行流水里猜（`respondingTo` 丢了）；
 * · 本人对**这个人**真实回过什么，完全没给（`precedents` 丢了）。
 *
 * 剩下能进提示词的只有 `style.md` 里的语气参数，产出因此是"语气很像的
 * 条件反射"。实测一个活跃会话连续多轮，草稿全是一两个字的应声词，
 * 而同期 `tool_calls_json` 全为 null —— agent 从没自己去取过这些。
 *
 * 所以判定与理解一起带出来：闸用 `verdict`，起草用其余部分。
 * 两者同源意味着"判定看到的"与"模型看到的"永远是同一批事实。
 */
export interface BriefVerdict {
  /** `reply` 之外的一切都意味着不能自己发 */
  verdict: "reply" | "draft" | "handoff" | "silent"
  /**
   * 命中的每一条规则。
   *
   * ★ 必须带出来：这是"为什么要你看一眼"唯一可信的来源。
   * 只记一个 `agent_requires_review` 的话，用户看到的是一个 code，
   * 而 `because[0]` 是一句人话（"risk class `commitment` — never settled
   * by the owner alone"）。
   */
  because: string[]
  /**
   * 要回的**那个东西**。
   *
   * `text` 是整串（对方连发时是全部，不是最后一条），`messageCount` 是
   * 折了几条。forge 侧的折叠判据是 `rules.json → policy.burst`，
   * 与判定用的是同一个单位 —— 也就是"闸看的"和"要回的"必然一致。
   */
  answering: {
    text: string
    lastText: string
    messageCount: number
    /**
     * 发这一串的人（对方）。
     *
     * ★ 必须从这里取，不能用 `respondingTo.sender`：后者是"这一串在回**谁**的
     * 话"，而那几乎总是本人自己 —— 拿它当对方的名字去做排除，等于把本人排除
     * 了两遍，而对方的名字一次都没排除。实测后果：1:1 里对方往往是本会话
     * 提及数最高的 Person，于是记忆的头号命中就是"对话的这个人是谁"，
     * 白占一个名额。
     */
    sender: string
  } | null
  /** 这一串在回本人之前说的哪句话。短消息离了它几乎没有意义。 */
  respondingTo: { sender: string; text: string } | null
  /**
   * 本人对**这个人**在类似情境下的真实回复。
   *
   * ★ 必须是按人取的：语气不跨收件人迁移，而 forge 侧已经按 `peer_open_id`
   * 限定过。给模型看"他以前这么回过"比给它一堆统计参数有用得多，
   * 也是唯一能让草稿从"套语气"变成"像那个人在回这件事"的输入。
   */
  precedents: Array<{ given: string; theyReplied: string }>
}

/** `check` 的判定：草稿正文本身的机械复核。 */
export interface CheckVerdict {
  verdict: "block" | "warn" | "pass"
  /** 命中的问题（`block` 时用来解释为什么被挡） */
  issues: string[]
}

/**
 * `fresh` 的判定：这一轮还值不值得回。
 *
 * ★ 三条判据（本人已回 / 有更新消息 / 采集滞后超阈值），而我们自己的
 * SQL 只做得到第一条 —— 后两条要读 `sync_cursors.watermark` 并与
 * `policy.freshness.maxLagSeconds` 比，那个阈值在 `rules.json` 里。
 * 各写一遍会让"库落后时照样发"这个失效悄悄回来。
 */
export interface FreshVerdict {
  stale: boolean
  reason: string | null
}

export interface PersonaGateOptions {
  logger: Logger
  processes: ProcessRunner
  /** 解析出的解释器；null = 判定不可得（三个方法一律返回 null） */
  python: ResolvedPython | null
}

/**
 * 判定闸的**形状**（`PersonaService` 依赖这个，不依赖具体类）。
 *
 * ★ 结构化而不是直接用 `PersonaGate`：门禁要能注入一个假判定层去验
 * 「判定不可得时到底发不发」——而那条断言在真实现下永远走不到
 * （测试机上没有已发布的产物）。与 `MediaRunner` 那处同一个理由：
 * 拿到它的人能做的事与我们自己完全一样，不多一条。
 */
export interface PersonaGateLike {
  brief(
    skillDir: string,
    target: GateTarget & { messageId: string | null },
  ): Promise<BriefVerdict | null>
  check(skillDir: string, text: string): Promise<CheckVerdict | null>
  fresh(
    skillDir: string,
    target: GateTarget & { lastSeenId: string | null },
  ): Promise<FreshVerdict | null>
}

export interface GateTarget {
  /**
   * 会话的**本地** id（`conversations.id`）。
   *
   * ★ 不是 `external_id`：判定层读的是我们自己的 `core.sqlite`（vault 源），
   * 而 `recent_messages()` 的 where 是 `m.conversation_id = ?` —— 那一列
   * 存本地主键。传 external_id 的话它一条消息都查不到，于是 `brief` 退回
   * corpus 并标 degraded、`fresh` 判 stale：**自动发送静默全失效**。
   */
  conversationExternalId: string
  /** 单聊 */
  single: boolean
  /**
   * 对端的 openDingTalkId。
   *
   * ★ 单聊**必须**给：`persona.py` 的 `_tail_with_lag` 在
   * `single && !peer_open_id` 时直接返回空消息集，于是 `brief` 拿不到
   * 上下文、`fresh` 判 stale —— 也就是所有单聊永远降级。
   * 而单聊恰恰是最该自动回的那一类。
   *
   * 不能拿 `conversations.external_id` 顶替：它在单聊里是**会话**标识，
   * 当成对端身份用是猜（`requestGrant` 的注释里记着同一个区别）。
   * 取不到时传空串，判定会如实降级。
   */
  peerOpenId: string
}

export class PersonaGate implements PersonaGateLike {
  constructor(private readonly options: PersonaGateOptions) {}

  /**
   * 这个会话的 workspace 里有没有可用的判定层。
   *
   * 判据是**脚本与规则文件都在**，而不是"目录在"：`installForgeSkills`
   * 在还没蒸馏过时装 0 个包，那时目录存在但里面什么都没有。
   */
  available(skillDir: string): boolean {
    if (this.options.python === null) return false
    return (
      existsSync(join(skillDir, "scripts", "persona.py")) &&
      existsSync(join(skillDir, "references", "rules.json"))
    )
  }

  /**
   * 判定：这一批该不该回、能不能自己回。
   *
   * `messageId` 是被回的那条（这一批最后一条）。不给时 `brief` 自己找
   * "最新的非本人消息"—— 但显式给更准：合批之后最后一条才是触发点。
   */
  async brief(
    skillDir: string,
    target: GateTarget & { messageId: string | null },
  ): Promise<BriefVerdict | null> {
    const payload = await this.run(skillDir, [
      "brief",
      ...this.targetArgs(target),
      ...(target.messageId === null ? [] : ["--message-id", target.messageId]),
    ])
    if (payload === null) return null
    const verdict = payload["verdict"]
    /**
     * 认不出的 verdict 当判定不可得，而不是当 draft。
     *
     * 两者对自动发送的效果一样（都降级），但记的原因不同：
     * 上游改了取值时我们要看到"判定层对不上"，而不是以为这条恰好该人工。
     */
    if (
      verdict !== "reply" &&
      verdict !== "draft" &&
      verdict !== "handoff" &&
      verdict !== "silent"
    ) {
      this.options.logger.warn("persona brief returned an unknown verdict", {
        verdict: typeof verdict === "string" ? verdict : typeof verdict,
      })
      return null
    }
    return {
      verdict,
      because: stringList(payload["because"]),
      answering: answeringOf(payload["answering"]),
      respondingTo: respondingToOf(payload["respondingTo"]),
      precedents: precedentsOf(payload["precedents"]),
    }
  }

  /** 复核草稿正文本身。`block` = 必须人工看（多半是命中了受限风险类或超长）。 */
  async check(skillDir: string, text: string): Promise<CheckVerdict | null> {
    const payload = await this.run(skillDir, ["check", "--text", text])
    if (payload === null) return null
    /**
     * ★ 产物 `check` 的字段是 `result` / `problems`，**不是** `verdict` / `issues`。
     *
     * 实测真机跑 `python3 scripts/persona.py check --text "不知道"` 的输出：
     *
     * ```json
     * { "result": "pass", "codepoints": 3, "problems": [], "guidance": "..." }
     * ```
     *
     * 而这里原来只读 `payload["verdict"]` —— 恒 undefined → 落到"未知 verdict"
     * 分支 → 返回 null → 调用方把 holdForReview 强置 true 并记
     * `review_gate_unavailable`。表现是**每一条草稿都进待审**，UI 上写着
     * 一个看起来像"环境没装好"的原因，而实际上 gate 跑得好好的、还判了 pass。
     *
     * 两个名字都收：`result` 是当前产物（`persona.py:328`），`verdict` 留给
     * 将来可能的改名。哪个都读不到才算判定不可得。
     */
    const verdict = payload["result"] ?? payload["verdict"]
    if (verdict !== "block" && verdict !== "warn" && verdict !== "pass") {
      this.options.logger.warn("persona check returned an unknown verdict", {
        verdict: typeof verdict === "string" ? verdict : typeof verdict,
      })
      return null
    }
    /**
     * `problems` 是对象数组（`{severity,kind,detail}`），不是字符串数组 ——
     * 取 `detail` 那一段给用户看。`issues` 同上：留给将来的改名。
     */
    const problems = payload["problems"]
    const issues = Array.isArray(problems)
      ? problems
          .map((item) =>
            typeof item === "object" &&
            item !== null &&
            typeof (item as { detail?: unknown }).detail === "string"
              ? (item as { detail: string }).detail
              : typeof item === "string"
                ? item
                : "",
          )
          .filter((detail) => detail !== "")
      : stringList(payload["issues"])
    return { verdict, issues }
  }

  /**
   * 发送前的新鲜度判定。
   *
   * ★ 缺 `lastSeen` 时仍然跑：`fresh` 那时判的是"本人是不是最后说话的人"
   * 与滞后，两条都仍然有意义。
   */
  async fresh(
    skillDir: string,
    target: GateTarget & { lastSeenId: string | null },
  ): Promise<FreshVerdict | null> {
    const payload = await this.run(skillDir, [
      "fresh",
      ...this.targetArgs(target),
      ...(target.lastSeenId === null ? [] : ["--last-seen", target.lastSeenId]),
    ])
    if (payload === null) return null
    /**
     * `stale` 缺失或不是布尔 → 判定不可得。
     *
     * 不默认成 false：那会把"读不懂输出"变成"可以发"，
     * 而这是三个方法里唯一直接挡在真发送前面的那个。
     */
    const stale = payload["stale"]
    if (typeof stale !== "boolean") {
      this.options.logger.warn("persona fresh returned no stale flag", {})
      return null
    }
    const reason = payload["reason"] ?? payload["lagReason"] ?? payload["verdict"]
    return { stale, reason: typeof reason === "string" && reason !== "" ? reason : null }
  }

  /** 三个子命令共用的目标参数。单聊与群聊的差别只在这里。 */
  private targetArgs(target: GateTarget): string[] {
    return [
      "--conversation-id",
      target.conversationExternalId,
      "--single",
      target.single ? "true" : "false",
      "--peer-open-id",
      target.peerOpenId,
    ]
  }

  /**
   * 跑一个子命令并解析 JSON。任何异常都返回 null（判定不可得）。
   *
   * `-B`：不写 `__pycache__`。产物目录在 userData 下，往里写字节码不致命，
   * 但它会让"产物目录里有什么"变得不可预测（而 `installForgeSkills`
   * 每次建 agent 都整包覆盖拷一遍）。与 `ForgeService` 同一个理由与写法。
   */
  private async run(skillDir: string, args: string[]): Promise<Record<string, unknown> | null> {
    const python = this.options.python
    if (python === null) return null
    if (!this.available(skillDir)) return null

    try {
      const result = await this.options.processes.exec({
        executable: python.path,
        args: ["-B", join("scripts", "persona.py"), ...args],
        env: {},
        /**
         * cwd 是 skill 目录本身。
         *
         * `persona.py` 用 `Path(__file__).parent.parent` 定位
         * `references/`，所以 cwd 其实不影响它找文件 —— 但传绝对路径的
         * 脚本名会让日志里那行命令长得没法读。这里传 skill 目录 + 相对
         * 脚本名，两者一致。
         */
        cwd: skillDir,
        timeoutMs: GATE_TIMEOUT_MS,
      })

      if (result.exitCode !== 0) {
        /**
         * 非 0 退出是**预期路径之一**：`load_config()` 在这台机器没有语料
         * 时会退出 1 并输出一个 `{"degraded": "markdown-only"}`。
         * 所以记 info 而不是 warn —— 那不是故障，是"还没蒸馏过"。
         */
        this.options.logger.info("persona gate command declined", {
          command: args[0],
          exitCode: result.exitCode,
          detail: (result.stderr.trim() || result.stdout.trim()).slice(0, 200),
        })
        return null
      }
      const parsed = JSON.parse(result.stdout) as unknown
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
      return parsed as Record<string, unknown>
    } catch (error) {
      /**
       * 超时、解析失败、进程起不来 —— 一律判定不可得。
       *
       * 记 warn（与上面的 info 分开）：这几种是真的异常，
       * 而"还没蒸馏过"不是。混在一档会让真问题被日常噪音淹掉。
       */
      this.options.logger.warn("persona gate command failed", {
        command: args[0],
        detail: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }
}

/** JSON 里的字符串数组。非数组/混了别的类型时只留字符串（不抛）。 */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item !== "")
}

/** 一个字段读成字符串；不是字符串就当空 —— 起草侧一律按"没有"处理。 */
function str(source: unknown, key: string): string {
  if (source === null || typeof source !== "object") return ""
  const value = (source as Record<string, unknown>)[key]
  return typeof value === "string" ? value : ""
}

/**
 * `answering`：要回的那个东西。
 *
 * `text` 空就返回 null —— 那时 `brief` 没定位到任何消息（窗口里没有对方的
 * 消息、或 live 读失败），而起草侧必须能区分"整串是空的"与"没折叠"。
 * 把空串当成一条消息会让提示词出现一个空的引用块。
 *
 * ## ★ 要到的是**另一条**消息时也返回 null
 *
 * 产物在"给了 `--message-id` 但窗口里没有"时会带上
 * `requestedMessageFound: false` —— 它仍然回退到"最新那条对方消息"并给出一个
 * 形状完整、`verdict` 正常的 brief，也就是**一份关于另一条消息的判定**。
 *
 * 实测踩过：会话 id 传了平台的 external id，而 forge 的语料按宿主内部 id 存，
 * 于是整个窗口是空的、`messageCount: 0`，`verdict` 照样是 `draft`，没有任何
 * 报错。这里当成"没有理解"处理，于是起草退回「回最后一条」而不是照着一条
 * 错的消息去写 —— 判定层的 `verdict` 仍然生效（它只会更保守）。
 */
function answeringOf(value: unknown): BriefVerdict["answering"] {
  const text = str(value, "text")
  if (text.trim() === "") return null
  if ((value as Record<string, unknown> | null)?.["requestedMessageFound"] === false) {
    return null
  }
  const count = (value as Record<string, unknown> | null)?.["messageCount"]
  return {
    text,
    sender: str(value, "sender"),
    lastText: str(value, "lastText"),
    messageCount: typeof count === "number" && Number.isFinite(count) ? count : 1,
  }
}

function respondingToOf(value: unknown): BriefVerdict["respondingTo"] {
  const text = str(value, "text")
  if (text.trim() === "") return null
  return { sender: str(value, "sender"), text }
}

/** 先例。两个字段都得有内容才算一条 —— 只有其中一半的先例教不了任何东西。 */
function precedentsOf(value: unknown): BriefVerdict["precedents"] {
  if (!Array.isArray(value)) return []
  const out: BriefVerdict["precedents"] = []
  for (const item of value) {
    const replied = str(item, "theyReplied")
    if (replied.trim() === "") continue
    out.push({ given: str(item, "given"), theyReplied: replied })
  }
  return out
}
