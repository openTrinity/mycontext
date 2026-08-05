/**
 * AgentEvent → ChatItem[] 的归约。
 *
 * 借鉴参考实现的四个设计要点（都是流式渲染的必修课）：
 * · **流式 finalize**：text_delta 追加到当前 assistant item，turn_end 时定稿；
 * · **message / thought 互斥**：thought 是独立 item（默认折叠），
 *   不能追加进正文 —— 否则思考过程会出现在答案里；
 * · **乱序 chunk 重排**：tool_result 可能先于 tool_call 到（网络乱序），
 *   按 callId 关联而不是按到达顺序；
 * · **取消守卫**：turn 被取消后到达的事件一律丢弃。
 *
 * ## ★ replay 抑制窗口（不实现会让 UI 历史翻倍）
 *
 * 实测 opencode 的 `loadSession` 在末尾执行 `replayMessages(events, messages)`,
 * 把该 session 的**全部**历史消息作为 `*_chunk` 通知推给 client；
 * `resumeSession` 不 replay 且只取最近 20 条。
 *
 * 我们的 UI 渲染读的是**我们自己的库**，agent 侧只需要恢复上下文、
 * 不需要把历史吐给我们 —— 吐回来反而要去重。因此：
 * ① 默认走 `resume`；
 * ② 无论 resume 还是 load，调用前后打标记进入**抑制窗口**：
 *    窗口期内到达的事件只用于校对，**不落库**；
 * ③ 第二道防线是与**历史内容 hash** 比对，挡住抑制窗口关闭后才到的尾巴。
 *
 * 验收断言：**重进一个已有 10 条消息的会话后，库里行数仍是 10。**
 *
 * ## ★★ 去重的作用范围是**有界的**（这是修复过一次的地方）
 *
 * 内容 hash 去重曾经是**永久且全局**的：任何两轮内容相同的回复，
 * 第二轮都会被吞掉。实测两轮各自完整回复「收到」→ 第二条被删。
 * 而「收到 / 好的 / 知道了 / 嗯」是中文对话里对**不同问题**的正常重复回复,
 * 它们永久消失，且用户只看到"这次没回我"。
 *
 * 去重要挡的只有 replay，而 replay 只发生在一个明确的时段里。所以现在：
 * · 只与 `primeFromHistory` 灌入的**历史** hash 比对（不与本会话新产生的比）；
 * · 且只在**警戒期**内比对 —— 抑制窗口打开期间，加上窗口关闭后
 *   `replayGraceMs`（默认 5s，覆盖 replay 尾巴的到达抖动）；
 * · 警戒期结束后去重整体关闭，新回复重复多少次都照常落库。
 *
 * ## ★★ 警戒期内**不外泄未定稿的 item**（于是不需要"回滚"）
 *
 * 流式路径下"是否重复"只能在 `turn_end` 定稿时判出来（那时内容才完整）。
 * 上一版的做法是先按 delta 增量渲染/写库、定稿判重后再通过
 * `retracted` 要求调用方回滚 —— 而全仓库**没有任何消费者**实现那个回滚,
 * 于是接线者一漏就会留下孤儿行。
 *
 * 现在改成：警戒期内流式 item **暂不进 `touched`**（调用方看不到、不会写库),
 * 定稿时才决定丢弃还是整条放出。代价是警戒期内首字延迟到定稿 ——
 * 而警戒期正是"这些字大概率是历史回放"的时段，本来就不该急着渲染。
 * 警戒期外一切照旧：逐 delta 立刻进 `touched`，无延迟、无去重。
 */
import { createHash } from "node:crypto"
import type { AgentEvent, ChatItem, ToolStatus, UnifiedContentBlock } from "./chat-item.js"
import { textBlock, toPlainText } from "./chat-item.js"

/**
 * replay 尾巴的宽限期（抑制窗口关闭后仍与历史比对多久）。
 *
 * 5s 的依据：replay 是一批通知，窗口关闭与最后一条通知到达之间只有网络与
 * 事件循环的抖动，秒级足够。取太长的代价是"正常的重复回复被吞"的时间窗变宽，
 * 取太短的代价是 replay 尾巴漏进库 —— 前者用户会当成"没回我"（更糟），
 * 所以宁可偏短。
 */
const DEFAULT_REPLAY_GRACE_MS = 5_000

export interface ReducerOptions {
  /** 起始序号（从库里已有的最大 seq + 1 开始） */
  startSeq?: number
  /** id 生成器（注入以便测试确定性） */
  newId: (seq: number) => string
  /** 时间（注入 Clock 的 now） */
  now: () => number
  /**
   * 抑制窗口关闭后，继续与历史 hash 比对多久（毫秒）。
   *
   * 见 `DEFAULT_REPLAY_GRACE_MS`。传 0 表示窗口一关就不再去重。
   */
  replayGraceMs?: number
}

export interface ReduceResult {
  /** 本次事件产生或更新的 item（调用方据此增量写库与增量渲染） */
  touched: ChatItem[]
  /**
   * 定稿时被判为重复而**撤下**的 item id。
   *
   * ## 为什么现在通常是空的
   *
   * 警戒期内的流式 item **不进 `touched`**（见文件头注释），
   * 所以"先渲染了再撤下"这条路径已经不存在，调用方**不需要**实现回滚。
   *
   * 保留这个字段是为了可观测性（以及万一将来又引入需要撤销的路径）：
   * 它现在的语义是「这些 id 曾在内部建过但没有外泄过」。
   * **调用方可以安全地忽略它。**
   */
  retracted: string[]
  /** 因抑制窗口或去重被丢弃的事件数（可观测：>0 说明发生了 replay） */
  suppressed: number
}

/**
 * 内容 hash。
 *
 * 分隔符写成 `\u0000` **转义序列**而不是裸 NUL 字节：裸 NUL 会让 git 把整个文件
 * 判定为 binary（`git diff` 只显示 `Bin ... bytes`），代码在评审里完全不可读。
 * 语义上用 NUL 分隔是对的 —— role 与正文之间的边界不能被正文内容伪造。
 */
function hashContent(role: string, blocks: readonly UnifiedContentBlock[]): string {
  return createHash("sha256")
    .update(`${role}\u0000${toPlainText(blocks)}`)
    .digest("hex")
    .slice(0, 32)
}

/**
 * 这段文本是否**只是占位**（点 / 省略号 / 空白）。
 *
 * 用途见 `appendStream`：opencode 在工具调用间隙吐的 `...` 不该建出 message item。
 * 判据刻意收得很窄 —— 只认 ASCII 点、中文省略号 `…`、以及空白。多一个字（哪怕是
 * 标点）就不算占位，因为误伤真实答案的代价（内容凭空消失）远高于漏掉一个占位。
 */
function isPlaceholderText(text: string): boolean {
  return text.length > 0 && /^[.…\s]+$/u.test(text)
}

export class ChatItemReducer {
  private readonly items = new Map<string, ChatItem>()
  /** turnId → 当前正在流式追加的 assistant item id */
  private readonly streamingMessage = new Map<string, string>()
  private readonly streamingThought = new Map<string, string>()
  /** callId → tool_call item id（用于关联乱序到达的 tool_result） */
  private readonly toolCalls = new Map<string, string>()
  /** 已取消的 turn：之后到达的事件一律丢弃 */
  private readonly cancelledTurns = new Set<string>()
  /**
   * 我们自己发起的 turn（`beginTurn` 登记）：其流式 item 豁免警戒期扣留。
   * 见 `beginTurn` 的注释 —— 已发出 prompt 的 turn 不可能是 replay。
   */
  private readonly liveTurns = new Set<string>()
  /**
   * **历史**内容 hash（只由 `primeFromHistory` 灌入）。
   *
   * ★ 刻意**不**把本会话新产生的回复加进来：那会让"两轮都回「收到」"
   * 的第二条被永久吞掉（见文件头）。这个集合的唯一用途是识别 replay，
   * 而 replay 回来的必然是历史里已有的内容。
   */
  private readonly historyHashes = new Set<string>()
  /** 警戒期内已判过重的历史 hash：同一条历史只该被挡一次 */
  private readonly matchedHistoryHashes = new Set<string>()
  /** 内部建过但从未外泄的 item id（可观测；调用方不需要处理） */
  private readonly retractedIds = new Set<string>()
  private replayDepth = 0
  /** 抑制窗口最后一次关闭的时刻；null = 从未关过 */
  private replayEndedAt: number | null = null
  private seq: number
  private suppressedCount = 0

  constructor(private readonly options: ReducerOptions) {
    this.seq = options.startSeq ?? 1
  }

  /**
   * 用库里已有的历史预热去重集合。
   *
   * 这是 replay 抑制真正生效的前提：抑制窗口挡住的是"我们知道要 replay"的时段，
   * 而 hash 比对挡住的是窗口关闭后才到达的**尾巴**。
   *
   * 只灌历史、不灌新内容：见 `historyHashes` 的注释。
   */
  primeFromHistory(history: readonly { role: string; content: UnifiedContentBlock[] }[]): void {
    for (const item of history) {
      this.historyHashes.add(hashContent(item.role, item.content))
    }
  }

  /**
   * 进入 replay 抑制窗口。返回结束函数。
   *
   * 用计数而不是布尔：嵌套调用（resume 失败后立刻 load）不该让内层的
   * `end()` 提前把窗口关掉。
   */
  beginReplaySuppression(): () => void {
    this.replayDepth += 1
    let ended = false
    return () => {
      if (ended) return
      ended = true
      this.replayDepth = Math.max(0, this.replayDepth - 1)
      // 记下关闭时刻：宽限期从这里开始算（见 inReplayGuard）。
      if (this.replayDepth === 0) this.replayEndedAt = this.options.now()
    }
  }

  get inReplayWindow(): boolean {
    return this.replayDepth > 0
  }

  /**
   * 声明「这个 turn 是我们自己刚发起的」——它的输出**豁免警戒期扣留**。
   *
   * ## 为什么需要这个豁免
   *
   * 警戒期（抑制窗口 + 关闭后的宽限期）会把流式 item 扣到定稿才外泄，
   * 依据是"这些字大概率是历史回放"。但每一轮（第 2 轮起）都要先
   * `session/resume`，窗口一关就进 5s 宽限期，而 `session/prompt` 紧接着
   * （几毫秒内）就发出去了 —— 于是**本轮真实答案的前 5 秒被白扣**，
   * 用户发完问题干等十几秒才见第一个动静，主观上就是"卡住/被截断"。
   *
   * 而这段扣留在逻辑上就是错的：一旦我们为某个 turnId 发出了 prompt，
   * 它的输出定义上是新内容，不可能是 replay。所以按 turn 精确豁免，
   * 而不是把宽限期整个关掉 —— 后者会让 resume 的历史尾巴重新落库
   * （那是宽限期存在的唯一理由）。
   */
  beginTurn(turnId: string): void {
    this.liveTurns.add(turnId)
  }

  /**
   * 是否处于**警戒期**：抑制窗口开着，或刚关闭不久（宽限期内）。
   *
   * 只有警戒期内才做历史 hash 比对、才推迟流式 item 的外泄。
   * 期外一切照常 —— 这正是「两轮都回『收到』」不再被吞的原因。
   */
  private get inReplayGuard(): boolean {
    if (this.replayDepth > 0) return true
    if (this.replayEndedAt === null) return false
    const grace = this.options.replayGraceMs ?? DEFAULT_REPLAY_GRACE_MS
    return this.options.now() - this.replayEndedAt < grace
  }

  get suppressed(): number {
    return this.suppressedCount
  }

  /** 标记某轮已取消：之后到达的事件一律丢弃（用户点了停止）。 */
  cancelTurn(turnId: string): void {
    this.cancelledTurns.add(turnId)
    this.streamingMessage.delete(turnId)
    // 取消的 turn 收不到 turn_end，豁免标记要在这里撤（否则永久留存）。
    this.liveTurns.delete(turnId)
    this.streamingThought.delete(turnId)
  }

  snapshot(): ChatItem[] {
    return [...this.items.values()].sort((a, b) => a.seq - b.seq)
  }

  /**
   * 归约一批事件。
   *
   * ## ★ 警戒期内流式 item 暂不外泄
   *
   * 警戒期（抑制窗口 + 宽限期）内，`message` / `thought` 这类流式 item
   * 只有在 `turn_end` 定稿并通过历史比对之后才进 `touched`。
   * 这样"判为重复"就不需要调用方回滚 —— 那条回滚契约全仓库无人实现，
   * 接线者一漏就会留下孤儿行。
   *
   * 期外（也就是绝大多数时间）流式 item 逐 delta 立刻进 `touched`，
   * 首字延迟不受影响。
   */
  apply(events: readonly AgentEvent[]): ReduceResult {
    const touched = new Map<string, ChatItem>()
    this.retractedIds.clear()

    for (const event of events) {
      // 取消守卫：已取消的 turn 的后续事件全部丢弃。
      if (this.cancelledTurns.has(event.turnId)) {
        this.suppressedCount += 1
        continue
      }
      const item = this.applyOne(event)
      if (item === null) continue
      // 警戒期内的未定稿流式 item 先扣住（定稿时由 finalizeTurn 放出）。
      // ★ 我们自己发起的 turn 豁免：它不可能是 replay，扣住只会白等宽限期
      // （见 `beginTurn`）。
      if (this.inReplayGuard && !this.liveTurns.has(event.turnId) && this.isPendingStream(item)) {
        continue
      }
      touched.set(item.id, item)
    }

    // 已撤下的 item 绝不能出现在 touched 里。
    // 警戒期内它本来就没进过（上面扣住了）；这一步兜的是"宽限期恰好在
    // 一个 turn 的中途结束"这类边界：delta 进了 touched 而定稿判为重复。
    for (const id of this.retractedIds) touched.delete(id)

    // turn 收尾后撤掉豁免标记：turn 已结束，`liveTurns` 再留着只会无界增长。
    // 放在这里（而不是 finalizeTurn 里）是因为定稿判重要用到它。
    for (const event of events) {
      if (event.type === "turn_end") this.liveTurns.delete(event.turnId)
    }

    return {
      touched: [...touched.values()],
      retracted: [...this.retractedIds],
      suppressed: this.suppressedCount,
    }
  }

  /**
   * 这个 item 是否是「还在流式追加、尚未定稿」的。
   *
   * 判据是它仍被某个 turn 的流式指针指着 —— `finalizeTurn` 会先清指针
   * 再返回该 item，所以定稿后的那次返回不会被扣住。
   */
  private isPendingStream(item: ChatItem): boolean {
    if (item.itemType !== "message" && item.itemType !== "thought") return false
    // turnId 是可选的（乱序 tool_result 建的占位项没有）。没有 turnId
    // 就不可能被流式指针指着，也就不是"未定稿的流式 item"。
    const turnId = item.turnId
    if (turnId === undefined) return false
    const registry = item.itemType === "message" ? this.streamingMessage : this.streamingThought
    return registry.get(turnId) === item.id
  }

  private applyOne(event: AgentEvent): ChatItem | null {
    switch (event.type) {
      case "text_delta":
        return this.appendStream(event.turnId, "message", event.text)
      case "thought_delta":
        // thought 与 message 互斥：独立 item，默认折叠。
        // 追加进正文会让思考过程出现在答案里。
        return this.appendStream(event.turnId, "thought", event.text)
      case "tool_call":
        return this.startToolCall(event.turnId, event.callId, event.toolName)
      case "tool_result":
        return this.finishToolCall(event.callId, event.status, event.summary, event.label)
      case "plan":
        return this.emit(event.turnId, "plan", "assistant", [
          textBlock(event.entries.map((e) => `${e.done ? "[x]" : "[ ]"} ${e.text}`).join("\n")),
        ])
      case "citation":
        return this.emit(event.turnId, "message", "assistant", [
          { kind: "citation", ordinal: event.ordinal, label: event.label },
        ])
      case "error":
        return this.emit(event.turnId, "error", "system", [textBlock(event.message)])
      case "turn_end":
        return this.finalizeTurn(event.turnId, event.usage)
    }
  }

  /** 流式追加：同一 turn 的连续 delta 落在同一个 item 上。 */
  private appendStream(
    turnId: string,
    itemType: "message" | "thought",
    text: string,
  ): ChatItem | null {
    const registry = itemType === "message" ? this.streamingMessage : this.streamingThought
    const existingId = registry.get(turnId)

    if (existingId !== undefined) {
      const item = this.items.get(existingId)
      if (item !== undefined) {
        const first = item.content[0]
        if (first !== undefined && first.kind === "text") {
          first.text += text
        } else {
          item.content.push(textBlock(text))
        }
        return item
      }
    }

    /**
     * ★ 正文还没开始时，纯占位的 delta **不建 item**。
     *
     * 实测 opencode 在**每次工具调用前**会吐一个 `...` 的 message chunk。
     * 而 message item 按 turnId 复用（一个 turn 一条），所以第一个 `...` 会把
     * item 建出来、**提前占掉一个 seq** —— 后续所有 tool_call 的 seq 都比它大，
     * 而真答案最后追加进这条早已存在的 item。两个症状由此而来：
     * ① 答案开头挂一串点（点数恒为 3 的倍数；没有工具调用的轮次一个点都没有）；
     * ② 答案看着"跑到工具卡上面"了 —— 其实是被钉在了工具之前的那个 seq。
     *
     * 丢弃之后 message 在真正开始说话时才创建，自然排到工具之后，开头也干净了。
     *
     * 只在 **item 尚未创建** 时判：正文一旦开始，后面的 `……` 是合法内容
     * （"他说……然后就走了"），一律保留。
     * 也只对 message 做：thought 是独立的折叠流，它的省略号是它自己的节奏。
     */
    if (itemType === "message" && isPlaceholderText(text)) return null

    const created = this.emit(turnId, itemType, "assistant", [textBlock(text)])
    if (created !== null) registry.set(turnId, created.id)
    return created
  }

  private startToolCall(turnId: string, callId: string, toolName: string): ChatItem | null {
    const existingId = this.toolCalls.get(callId)
    if (existingId !== undefined) {
      // tool_result 先到过（乱序）：补上工具名，保留已有状态。
      const item = this.items.get(existingId)
      if (item !== undefined) {
        item.toolName = toolName
        return item
      }
    }
    const created = this.emit(turnId, "tool_call", "assistant", [])
    if (created === null) return null
    created.toolName = toolName
    created.toolStatus = "running"
    this.toolCalls.set(callId, created.id)
    return created
  }

  /**
   * 工具跑完（或失败）：落终态、追加摘要，并用 `label` 把通道名换成动作描述。
   *
   * ★ `label` 只在**非空且与现名不同**时覆盖：mapper 的兜底会把终态 `title`
   * 也当 label 传下来，而那一版常常仍是 `bash`（跟原名一样）——
   * 无条件覆盖等于每次都写一遍相同的值，白改一次对象还让"名字变过"这件事
   * 不可追溯。同名即 no-op 更诚实。
   */
  private finishToolCall(
    callId: string,
    status: Exclude<ToolStatus, "pending">,
    summary?: string,
    label?: string,
  ): ChatItem | null {
    const existingId = this.toolCalls.get(callId)
    if (existingId === undefined) {
      // 乱序：result 先于 call 到达。先建一个占位 item，等 call 到了补工具名。
      // 丢弃它是错的 —— 那会让"工具跑过了"这件事永久不可见。
      const created = this.emit("unknown", "tool_call", "assistant", [])
      if (created === null) return null
      created.toolStatus = status
      if (label !== undefined && label !== "") created.toolName = label
      if (summary !== undefined) created.content.push(textBlock(summary))
      this.toolCalls.set(callId, created.id)
      return created
    }
    const item = this.items.get(existingId)
    if (item === undefined) return null
    item.toolStatus = status
    if (label !== undefined && label !== "" && label !== item.toolName) item.toolName = label
    if (summary !== undefined && summary !== "") item.content.push(textBlock(summary))
    return item
  }

  /**
   * turn 结束：清掉流式指针（后续 delta 会开新 item）并记账用量。
   *
   * ## ★ 内容比对在这里做，不在 emit 里做
   *
   * 流式路径下 `emit` 拿到的只是**第一个 delta**（比如「好的」），
   * 拿它做内容 hash 比对会吃掉正常回复的开头：
   * 实测 t1="好的"+"，已处理"、t2="好的"+"，明天发布" → 第二轮输出「，明天发布」，
   * 「好的」被判成重复丢掉。而「好的 / 嗯 / 是的」是中文极高频开头，稳定复现。
   *
   * 反向也一样：`primeFromHistory` 存的是**整句** hash，而 replay 是逐 delta 回来的，
   * 首个 delta 的 hash 与整句 hash 对不上 → 实测 replay 一条历史消息照样落库。
   *
   * 所以定稿（turn_end）才是唯一能拿到完整内容、也是唯一该做判定的时刻。
   *
   * ## ★★ 只在警戒期内、且只与**历史** hash 比对
   *
   * 上一版是「与所有见过的内容比、且永久有效」，于是两轮各自完整回复「收到」
   * 时第二条被删（实测）。而「收到 / 好的 / 知道了」是对**不同问题**的
   * 正常重复回复 —— 永久吞掉它们比偶尔多一条 replay 尾巴严重得多。
   *
   * 现在的判据是「警戒期内 + 内容与某条历史相同 + 那条历史还没被匹配过」。
   * 三个条件缺一不可：
   * · 不限警戒期 → 正常重复回复被吞（上一版的 bug）；
   * · 与新内容比 → 同上；
   * · 不记"已匹配过" → 历史里有两条相同内容时只能挡住一条，
   *   那反而是对的（库里本来就有两条）。
   */
  private finalizeTurn(
    turnId: string,
    usage?: { inputTokens?: number; outputTokens?: number },
  ): ChatItem | null {
    const messageId = this.streamingMessage.get(turnId)
    const thoughtId = this.streamingThought.get(turnId)
    this.streamingMessage.delete(turnId)
    this.streamingThought.delete(turnId)

    // thought 不参与内容比对：它不是"消息"，重复的思考没有展示后果，
    // 而按 hash 判重反而会吃掉两轮里恰好相同的思考片段。
    void thoughtId

    if (messageId === undefined) return null
    const item = this.items.get(messageId)
    if (item === undefined) return null

    // ★ 定稿判重：现在 content 是完整的，hash 才有意义。
    if (item.content.length > 0 && this.isReplayOfHistory(item, turnId)) {
      // replay → 丢弃这一条。警戒期内它从未进过 `touched`
      // （见 apply 的 isPendingStream），所以调用方不需要回滚。
      this.items.delete(item.id)
      this.suppressedCount += 1
      this.retractedIds.add(item.id)
      return null
    }

    if (usage !== undefined) item.usage = usage
    return item
  }

  /**
   * 这一条定稿内容是否是历史的 replay。
   *
   * 只在警戒期内成立（期外一律返回 false —— 那时的重复是正常的重复回复）。
   * 命中后把该历史 hash 记进 `matchedHistoryHashes`：库里若真有两条相同内容，
   * 第二次 replay 应当被放行（否则我们比库里少一条）。
   *
   * ★ 我们自己发起的 turn（`beginTurn`）一律不判重：它的内容已经逐 delta 外泄
   * 出去了，这时再判成 replay 撤掉就会留下孤儿行 —— 而且它定义上不是 replay。
   * 「本轮答案与历史某条恰好同文」（比如两轮都回「收到」）也正该留下。
   */
  private isReplayOfHistory(item: ChatItem, turnId: string): boolean {
    if (this.liveTurns.has(turnId)) return false
    if (!this.inReplayGuard) return false
    const hash = hashContent(item.role, item.content)
    if (!this.historyHashes.has(hash)) return false
    if (this.matchedHistoryHashes.has(hash)) return false
    this.matchedHistoryHashes.add(hash)
    return true
  }

  /**
   * 新建一个 item。
   *
   * 抑制窗口内**只校对不落库**：返回 null 让调用方跳过写库。
   *
   * ★ 这里**不做**流式内容的判重：流式路径下这里拿到的只是第一个 delta，
   * 用它做比对会吃掉「好的 / 嗯 / 是的」这类高频开头。
   * 判定统一放到 `finalizeTurn`（定稿时内容才完整），见那里的注释。
   */
  private emit(
    turnId: string,
    itemType: ChatItem["itemType"],
    role: ChatItem["role"],
    content: UnifiedContentBlock[],
  ): ChatItem | null {
    if (this.inReplayWindow) {
      this.suppressedCount += 1
      return null
    }

    // 非流式 item（plan / citation / error）在这里就已经是完整内容，
    // 没有 turn_end 定稿这一步，所以它们的判重必须在这里做。
    // 流式的 message / thought **不在这里判**（内容还只是第一个 delta），
    // 由 finalizeTurn 定稿时判定。
    //
    // 同样只在警戒期内、只与历史比对：期外两个相同的 error（比如同一个
    // 模型不可用错误重复出现）都该显示出来，吞掉第二个会让人以为它自愈了。
    // ★ 我们自己发起的 turn 同样豁免（见 `beginTurn`）。
    const streaming = itemType === "message" || itemType === "thought"
    if (!streaming && content.length > 0 && this.inReplayGuard && !this.liveTurns.has(turnId)) {
      const hash = hashContent(role, content)
      if (this.historyHashes.has(hash) && !this.matchedHistoryHashes.has(hash)) {
        this.matchedHistoryHashes.add(hash)
        this.suppressedCount += 1
        return null
      }
    }

    const seq = this.seq
    this.seq += 1
    const item: ChatItem = {
      id: this.options.newId(seq),
      seq,
      role,
      itemType,
      content,
      turnId,
      createdAt: this.options.now(),
    }
    this.items.set(item.id, item)
    return item
  }
}
