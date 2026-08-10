/**
 * 钉钉 Stream 长连接事件消费者（`dws event consume`）。
 *
 * ## 它做什么 / 不做什么
 *
 * 做：起一条 `event consume user_im_message_receive_at` 的长连接，NDJSON 一行
 * 一条事件到 stdout；每条事件**只当叫醒信号**——把 `conversation_id` 交给上层
 * 立刻定向补拉那个会话（见 `IngestService.refreshConversation`）。
 *
 * **不做**：不把事件正文当消息落库。事件的解析路径与 `chat message list-all`
 * 不同源，两个真源必然漂（字段名、@ 解析、引用都不一样）。所以正文永远走
 * 采集那条路，事件只负责「快」。这也意味着：**事件通路挂了不影响完整性**，
 * 只是"新消息要等下一轮轮询"而不是"秒级"。
 *
 * ## ★ 健康判据是「stdout 真收到过至少一条事件」，不是 `[event] ready`
 *
 * 实测（记忆 dws-event-consume-connects-but-delivers-nothing）：这个账号上
 * `event consume` 会打 `[event] ready` + `state=connected`，但
 * `Subscriptions: none`、**4 分钟零投递**。也就是 ready 只说明**本地 bus 起来了**，
 * 不代表云端订阅建成、更不代表事件会到。把 ready 当"接通了"会得到一个
 * "看起来在工作、实际零投递"的通路——与网络安静在外观上完全一样。
 *
 * 所以状态机是 `starting → ready →（收到第一条才）delivering`。停在 ready
 * 超过一段时间，上层在状态页显示"事件通路未投递，正在靠轮询"。
 *
 * ## 退出必须退订
 *
 * `event _bus` 是常驻子进程，`kill -9` 会跳过退订、在**服务端**泄漏订阅
 * （与 kl-server 占端口同一类问题）。所以 `stop()` 先 `close()`（关 stdin →
 * 对端读到 EOF 优雅退出），再跑一次 `event stop --all` 兜底清理服务端订阅。
 */
import type { Clock, Logger } from "@mycontext/kernel"
import type { ProcessRunner, RuntimeEnv } from "@mycontext/runtime-env"
import type { DuplexHandle } from "@mycontext/runtime-env"
import type {
  ChannelEvents,
  ChannelEventSignal,
  ChannelEventStreamHealth,
  ChannelEventStreamState,
  ChannelEventSubscriptionAudit,
} from "../../types.js"
import { assertAllowedCommand } from "./cli.js"

/**
 * 事件通路的健康状态。**必须能区分「起来了」与「真的在投递」**——
 * 这正是 ready 陷阱的落点（见文件头）。渠道无关的别名见 ChannelEventStreamState。
 */
export type EventStreamState = ChannelEventStreamState

/** 一条被规范化的叫醒信号。正文字段刻意不带——事件只用来"叫醒"，不落库。 */
export type DingTalkEventSignal = ChannelEventSignal

export interface DingTalkEventConsumerOptions {
  runtime: RuntimeEnv
  processes: ProcessRunner
  logger: Logger
  clock: Clock
  /** 收到一条（去重后的）事件时回调。上层在这里定向补拉。 */
  onSignal: (signal: DingTalkEventSignal) => void
  /**
   * 退避等待。注入以便测试（默认真 setTimeout）。
   * 与 kl-server 的 `sleep?` 注入同款做法。
   */
  sleep?: (ms: number) => Promise<void>
  /** 退避基数（首次重连等待），默认 1s。 */
  backoffBaseMs?: number
  /** 退避上限，默认 60s。 */
  backoffMaxMs?: number
}

/** 状态页要读的一份健康快照。渠道无关别名见 ChannelEventStreamHealth。 */
export type EventStreamHealth = ChannelEventStreamHealth

/**
 * 订阅面对账结果（`event list` 目录 + `event status` 实际订阅）。
 *
 * ## ★ 为什么这件事有意义，而"用 event list 兜底消息"没有
 *
 * `dws event list` 实测返回的是**事件目录**（3 个可订阅的 `event_key`：
 * at 无参数 / o2o 要 `user` / group 要 `group`），**不含任何消息** ——
 * 拿它补消息完整性在物理上不成立。
 *
 * 但它能回答另一个真问题：**这个账号的事件覆盖面有多大**。
 * `at` 一个订阅覆盖全部群的「@我」，而 o2o/group 要**逐会话**订阅 ——
 * 也就是"没被订阅的会话只能靠轮询"。把这个差额算出来放到状态页，
 * 用户才知道实时通路覆盖了多少、剩下的靠什么。
 *
 * 不算的话「事件通路健康」会被误读成「所有消息都能秒级到」，
 * 而实际上绝大多数会话根本没有事件覆盖（见 memory 里那条覆盖面结构性不全）。
 */
export type EventSubscriptionAudit = ChannelEventSubscriptionAudit

const DEFAULT_BACKOFF_BASE_MS = 1_000
const DEFAULT_BACKOFF_MAX_MS = 60_000
/**
 * 去重表上限。事件量不大（只有 @我），但长连不重启会一直攒，
 * 所以给一个有界的 FIFO —— 超了就丢最旧的（重投总是发生在临近时间窗内）。
 */
const DEDUP_CAPACITY = 4_096

/**
 * `[event] ready` 的 stderr 标记。**只用来把状态推进到 ready，不作健康证据**
 * （见文件头）。真投递才把状态推到 delivering。
 */
const READY_MARKER = "[event] ready"

/**
 * stderr 里表示「登录态没了」的痕迹 —— 撞到就**停止重连**。
 *
 * ## ★★★ 为什么必须有这个判断（一个刷了 19 次的无限循环）
 *
 * `spawnOnce` 的 `onExit` **不看退出码也不看 stderr**，任何退出一律当"断线"
 * 然后退避重连。而「凭据不存在」是**终态**：重连 19 次与 1 次结果完全一样。
 *
 * 实测日志（钉钉未登录，飞书刚连上）：
 *
 *     warn | process non-zero exit | exitCode 5 | event stop --as user:
 *            no credentials found, run: dws auth login
 *     warn | dingtalk event stream disconnected, backing off {reconnects: 1}
 *     …一路涨到 reconnects: 19，每 60 秒一条，直到应用关掉
 *
 * 代价不止是噪音：这堆重复 warn **把真正的错误埋了** —— 同一份日志里
 * 飞书那一路一条记录都没有，而我第一次读的时候正是被这串刷屏带偏、
 * 漏看了夹在中间的 `dws auth login`。
 *
 * ## 为什么上面那个 `hasPinnedIdentity()` 守卫拦不住
 *
 * 它判的是「有没有**绑身份行**」，而身份行与凭据是两件事：这台机器上
 * `dingtalk@src-…` 那行在（vault 都建了），只是 dws 的 token 没了。
 * 于是守卫放行 → 子进程起来 → 立刻以 no credentials 退出 → 退避重连。
 *
 * ★ 判据放在 stderr 的文本上而不是退出码：实测同一个成因出现过
 * exitCode 5（`no credentials found`）与 2（`"actions": ["dws auth login"]`）
 * 两种，而两者的 stderr 都明确写着要 `auth login`。
 */
const CREDENTIALS_GONE_MARKERS: readonly string[] = [
  "no credentials found",
  "auth login",
  "not_authenticated",
  "not_configured",
]

export class DingTalkEventConsumer implements ChannelEvents {
  private handle: DuplexHandle | null = null
  private state: EventStreamState = "stopped"
  /**
   * 这一轮的退出是不是"凭据没了"。
   *
   * ★ 每次 `spawnOnce` 开头复位：它描述的是**最近那一条连接**为什么退出，
   * 不是历史。不复位的话用户重新授权后第一次断线会被误判成终态。
   */
  private credentialsGone = false
  private lastEventAt: number | null = null
  private delivered = 0
  private reconnects = 0
  /** 主动停止标记：`onExit` 据此区分"我们关的"与"对端崩了要重连"。 */
  private stopping = false
  /** 去重环：Set 保序，超容量丢最旧。 */
  private readonly seen = new Set<string>()
  private loop: Promise<void> | null = null

  constructor(private readonly options: DingTalkEventConsumerOptions) {}

  health(): EventStreamHealth {
    return {
      state: this.state,
      lastEventAt: this.lastEventAt,
      delivered: this.delivered,
      reconnects: this.reconnects,
    }
  }

  /** 起长连接。幂等：已在跑就直接返回。 */
  start(): void {
    if (this.loop !== null) return
    this.stopping = false
    // 重新授权后重新 start()：上一轮的终态判定不能留下来
    this.credentialsGone = false
    this.loop = this.runReconnectLoop()
  }

  /**
   * 停长连接并退订。
   *
   * 顺序要紧：先置 `stopping`（让 onExit 不再触发重连），再 `close()`
   * （关 stdin → 对端优雅退出），最后 `event stop --all` 清服务端订阅。
   */
  async stop(): Promise<void> {
    this.stopping = true
    this.state = "stopped"
    const handle = this.handle
    this.handle = null
    if (handle !== null) {
      await handle.close().catch(() => undefined)
    }
    // 等重连循环收尾（它在 backoff 里 sleep 时也会因为 stopping 立刻退出）。
    const loop = this.loop
    this.loop = null
    if (loop !== null) await loop.catch(() => undefined)
    await this.unsubscribeAll()
  }

  /**
   * 重连循环。断线走**指数退避**，主动停止（`stopping`）时退出。
   *
   * 每一轮起一条长连接，`onExit` 触发时若不是主动停止就等退避再起下一条。
   */
  private async runReconnectLoop(): Promise<void> {
    while (!this.stopping) {
      const exited = this.spawnOnce()
      await exited
      if (this.stopping) break

      /**
       * ★★★ 凭据没了 → **终态，不重连**。
       *
       * 见 `CREDENTIALS_GONE_MARKERS` 上方那段：重连一百次都一样，
       * 而它刷出来的 warn 会把真正的错误埋掉（实测刷到 19 次）。
       *
       * 归 `stopped` 而不是 `failed`：这不是故障，是"还没到能起的时候"
       * —— 与上面「没绑身份」同一个语气。用户重新授权后挂载链路会
       * 重新 `start()`（那时 `credentialsGone` 也跟着复位）。
       */
      if (this.credentialsGone) {
        this.state = "stopped"
        this.options.logger.warn("event stream stopped: credentials gone, reauthorization needed", {
          reconnects: this.reconnects,
        })
        break
      }

      // 断线：进退避。收到过事件的连接归零退避（它是健康的，只是断了）。
      this.reconnects += 1
      this.state = "backoff"
      const wait = Math.min(
        this.options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS,
        (this.options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS) * 2 ** (this.reconnects - 1),
      )
      this.options.logger.warn("dingtalk event stream disconnected, backing off", {
        reconnects: this.reconnects,
        waitMs: wait,
      })
      await this.sleep(wait)
    }
  }

  /**
   * 起一条长连接，返回一个在进程退出时 resolve 的 Promise。
   *
   * `user_im_message_receive_at`：@我的消息，**一个订阅覆盖全部群**
   * （不需要逐会话订阅——见 M3 文档 1.1）。
   */
  private spawnOnce(): Promise<void> {
    const args = ["event", "consume", "user_im_message_receive_at"]
    // ★ 门禁：spawnDuplex 绕过 DwsCli.run 的白名单闸，这里必须显式补上。
    assertAllowedCommand(args)
    const binary = this.options.runtime.resolve("dws")
    /**
     * ★ 钉住身份（第三条绕过 DwsCli 的路径）。
     *
     * 与门禁那条注释同一个结构：这个文件自己 spawn，所以 `DwsCli` 里加的东西
     * 一样都到不了这里。不钉的后果是长连接订阅的是**另一个身份**的消息 ——
     * 于是数字人被别的组织的 @我 唤醒，而库里那个会话根本不存在
     * （定向补拉会一路失败，而失败看起来像网络问题）。
     */
    const finalArgs = [...args, ...this.options.runtime.dwsProfileArgs()]
    /**
     * ★★ 没绑身份 → **不起长连接**（而不是"用 CLI 现成的登录态起一条"）。
     *
     * `dwsProfileArgs()` 在没绑身份时返回空数组，拼进 args 里毫无痕迹 ——
     * 命令照样跑，只是跟着渠道 CLI 的**全局 currentProfile** 走。
     * 对长连接来说后果比一次性命令更重：它在**服务端建立了一个订阅**，
     * 推来的是那个身份收到的「@我」消息。也就是说我们会订阅一个
     * 用户从未在这个应用里授权过的人的消息流。
     *
     * 而这是本应用里最不该发生的一类事：数字人被那些消息唤醒、
     * 定向补拉去捞库里根本不存在的会话，全程静默（失败看起来像网络问题）。
     *
     * 归位到 `stopped` 而不是 `backoff`：这不是故障、也不该被重试推着走，
     * 是"还没到能起的时候"。授权完成后挂载链路会重新起数据流（`start()`）。
     */
    if (!this.options.runtime.hasPinnedIdentity()) {
      this.options.logger.info("event stream not started: no bound identity", {})
      this.state = "stopped"
      /**
       * ★★★ 也是终态 —— 不置这个标记的话重连循环会**永远转**。
       *
       * 上一版只把 `credentialsGone` 挂在 stderr 的 `no credentials found`
       * 之类痕迹上，而那要求子进程**真的起来过**。这条 return 在 spawn
       * 之前，于是标记永远为假 → 循环照转。实测（打包态，钉钉未登录）：
       *
       *     18:42:54  event stream not started: no bound identity
       *     18:42:54  dingtalk event stream disconnected {reconnects: 1}
       *     …每 60 秒一条，涨到 9 还在继续
       *
       * 没绑身份是**用户动作才能改变**的状态（去授权），重连一百次与一次
       * 结果完全一样；而这串 warn 的真实代价是把别的错误埋掉 —— 上一轮
       * 我就是被它带偏、漏看了夹在中间的 `auth login`。
       *
       * 复位点与凭据那条同一处（`start()` 与 `spawnOnce()` 开头），
       * 所以授权完成后挂载链路重新 `start()` 就会重新尝试。
       */
      this.credentialsGone = true
      return Promise.resolve()
    }
    this.state = "starting"
    this.credentialsGone = false

    return new Promise<void>((resolve) => {
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      try {
        this.handle = this.options.processes.spawnDuplex({
          executable: binary.path,
          args: finalArgs,
          env: this.options.runtime.buildEnv(),
          onLine: (line) => this.onStdoutLine(line),
          onStderr: (line) => {
            // ready 只推进到 ready，**不**作健康证据（见文件头）。
            if (line.includes(READY_MARKER) && this.state === "starting") {
              this.state = "ready"
            }
            /**
             * ★ 「凭据没了」是终态 —— 记下来，让重连循环退出。
             * 判据与 why 见 `CREDENTIALS_GONE_MARKERS`。
             */
            const lower = line.toLowerCase()
            if (CREDENTIALS_GONE_MARKERS.some((marker) => lower.includes(marker))) {
              this.credentialsGone = true
            }
          },
          onExit: () => settle(),
        })
      } catch (error) {
        // 起不来（二进制缺失等）：当作一次断线，交给退避重连。
        this.options.logger.warn("dingtalk event consume failed to spawn", {
          detail: error instanceof Error ? error.message : String(error),
        })
        settle()
      }
    })
  }

  /** stdout 一行一条 NDJSON 事件。解析失败只记日志（不让一条坏行杀掉长连）。 */
  private onStdoutLine(line: string): void {
    const signal = parseEventLine(line)
    if (signal === null) return
    if (this.seen.has(signal.eventId)) return
    this.remember(signal.eventId)

    // ★ 真投递：这才是"事件通路在工作"的证据。
    this.state = "delivering"
    this.lastEventAt = this.options.clock.now()
    this.delivered += 1
    this.reconnects = 0
    try {
      this.options.onSignal(signal)
    } catch (error) {
      this.options.logger.warn("dingtalk event onSignal threw", {
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private remember(eventId: string): void {
    this.seen.add(eventId)
    if (this.seen.size > DEDUP_CAPACITY) {
      // Set 保插入序：删第一个就是删最旧的。
      const oldest = this.seen.values().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }
  }

  /**
   * 订阅面对账：读事件目录（`event list`）+ 当前订阅（`event status`）。
   *
   * 用途见 `EventSubscriptionAudit` 的注释：算出"实时通路覆盖了多少"，
   * 让状态页能说清剩下的靠轮询。**不抛异常** —— 这是可观测性，
   * 读不到就报 `error` 并给零覆盖，不能让它挡住采集或退出。
   */
  async audit(): Promise<EventSubscriptionAudit> {
    const empty: EventSubscriptionAudit = {
      catalog: [],
      globalKeys: [],
      perConversationKeys: [],
      activeSubscriptions: 0,
      error: null,
    }
    /**
     * ★ 没绑身份 → 直接给空，不去问 CLI。
     *
     * 不钉 profile 时问到的是**别人**订了什么，而这份审计的用途是
     * "我们这个身份的实时通路覆盖了多少"。拿别人的数字填进来会让状态页
     * 显示一个看起来正常、实际与我们无关的覆盖率。
     *
     * `error` 留 null：这不是读取失败，是"还没有身份可问"——
     * 报成 error 会让状态页显示一个不存在的故障。
     */
    if (!this.options.runtime.hasPinnedIdentity()) return empty
    try {
      const binary = this.options.runtime.resolve("dws")
      const run = async (args: readonly string[]): Promise<unknown> => {
        assertAllowedCommand(args)
        const result = await this.options.processes.exec({
          executable: binary.path,
          // ★ 钉住身份：订阅审计要看的是**这个身份**订了什么，
          // 而不是 CLI 全局 profile 那个人订了什么（见 spawnOnce 的注释）。
          args: [...args, "-f", "json", ...this.options.runtime.dwsProfileArgs()],
          env: this.options.runtime.buildEnv(),
          timeoutMs: 20_000,
        })
        return JSON.parse(result.stdout) as unknown
      }

      const catalogRaw = await run(["event", "list"])
      const entries = Array.isArray(catalogRaw) ? catalogRaw : []
      const catalog: string[] = []
      const globalKeys: string[] = []
      const perConversationKeys: string[] = []
      for (const entry of entries) {
        if (typeof entry !== "object" || entry === null) continue
        const record = entry as Record<string, unknown>
        const key = str(record["event_key"]) ?? str(record["eventKey"])
        if (key === null) continue
        catalog.push(key)
        /**
         * `required_params` 决定它是"一个订阅覆盖全部"还是"要逐会话订阅"：
         * `at` 是 null（无参数）→ 全局；o2o 要 `user`、group 要 `group` → 逐会话。
         * 实测字段是 `required_params`（snake_case），camelCase 一并认。
         */
        const params = record["required_params"] ?? record["requiredParams"]
        const needsParams = Array.isArray(params) && params.length > 0
        ;(needsParams ? perConversationKeys : globalKeys).push(key)
      }

      const statusRaw = await run(["event", "status"])
      let activeSubscriptions = 0
      if (typeof statusRaw === "object" && statusRaw !== null) {
        const subs = (statusRaw as Record<string, unknown>)["subscriptions"]
        if (Array.isArray(subs)) activeSubscriptions = subs.length
      }

      return { catalog, globalKeys, perConversationKeys, activeSubscriptions, error: null }
    } catch (error) {
      return {
        ...empty,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * 退订服务端订阅。`event stop --all` 是**一次性**命令，走 processes.exec
   * （不是长连），失败只记日志——退出路径不该因为清理失败而抛。
   */
  private async unsubscribeAll(): Promise<void> {
    const args = ["event", "stop", "--all"]
    /**
     * ★★★ 没绑身份 → **什么都不停**。这里漏了比别处更糟。
     *
     * `--all` 的语义是"停这个身份的全部订阅"。不钉 profile 时它按 CLI 的
     * 全局 currentProfile 走 —— 于是我们会去停**另一个身份**的订阅，
     * 而那个身份可能正是用户自己终端里在用的。也就是说一次
     * "我们这边的清理"会把用户在别处的订阅打掉。
     *
     * 而没绑身份时本来就没有我们建立的订阅可停（`spawnOnce` 那道闸拦住了），
     * 所以直接返回既安全又正确 —— 不是"跳过清理"，是"没有东西要清"。
     */
    if (!this.options.runtime.hasPinnedIdentity()) return
    try {
      assertAllowedCommand(args)
      const binary = this.options.runtime.resolve("dws")
      await this.options.processes.exec({
        executable: binary.path,
        /**
         * ★★ 钉住身份 —— 这里**尤其**不能漏。
         *
         * `--all` 停的是"这个身份的全部订阅"。不钉的话它按 CLI 全局 profile 走，
         * 于是切换身份时可能停掉**另一个身份**的订阅（那个身份甚至可能是用户
         * 自己终端里正在用的）。而这个方法整段吞异常（退出路径不该抛），
         * 所以停错了人不会有任何痕迹。
         */
        args: [...args, ...this.options.runtime.dwsProfileArgs()],
        env: this.options.runtime.buildEnv(),
        timeoutMs: 10_000,
      })
    } catch (error) {
      this.options.logger.debug("dingtalk event stop --all failed (ignored)", {
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.options.sleep !== undefined) return this.options.sleep(ms)
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

/**
 * 解析一行事件 NDJSON → 叫醒信号。**只取去重键与会话 id**，正文一概不取
 * （见文件头：事件不落库）。拿不到这两个的行返回 null（含 stderr 混进来的
 * 人类可读行、心跳行）。
 *
 * 字段名两种写法都收：payload 文档写的是 snake_case（`event_id` /
 * `conversation_id`），但历史上 DWS 有的命令返回 camelCase。
 */
export function parseEventLine(line: string): DingTalkEventSignal | null {
  const trimmed = line.trim()
  if (trimmed === "" || !trimmed.startsWith("{")) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const record = parsed as Record<string, unknown>
  // 有的实现把业务字段裹在 `data` / `payload` 里；两层都找。
  const inner =
    typeof record["data"] === "object" && record["data"] !== null
      ? (record["data"] as Record<string, unknown>)
      : typeof record["payload"] === "object" && record["payload"] !== null
        ? (record["payload"] as Record<string, unknown>)
        : record

  const eventId = str(record["event_id"]) ?? str(record["eventId"]) ?? str(inner["event_id"])
  const conversationExternalId =
    str(inner["conversation_id"]) ??
    str(inner["conversationId"]) ??
    str(inner["open_conversation_id"]) ??
    str(inner["openConversationId"])
  if (eventId === null || conversationExternalId === null) return null
  return { eventId, conversationExternalId }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}
