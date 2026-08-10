/**
 * 仪表盘的取数与格式化 —— **纯函数**，与 React 无关。
 *
 * ## 为什么把它们拆出来
 *
 * 仪表盘上每个数字都是"从若干个快照里算出来的一句话"。这些算法有真正的
 * 判据（多少算落后？空系统与健康系统怎么区分？），而判据要能被门禁锁住。
 * 混在组件里的话只能靠 CDP 探针去读渲染结果，那种断言又慢又脆。
 */
import type {
  DashboardTrends,
  DistillProgressView,
  FeedInfo,
  IngestSnapshot,
  KlGraphOverview,
  KlServerStatus,
  PersonaSnapshotView,
} from "@mycontext/ipc-contract"
import type { MetricTone } from "./primitives.js"

/**
 * 千分位。
 *
 * 手写而不是 `toLocaleString()`：后者的分隔符跟随系统区域设置，
 * 于是同一个数字在不同机器上长得不一样，截图对不上、门禁也没法断言。
 */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "—"
  const sign = n < 0 ? "-" : ""
  const digits = Math.abs(Math.trunc(n)).toString()
  const parts: string[] = []
  for (let i = digits.length; i > 0; i -= 3) parts.unshift(digits.slice(Math.max(0, i - 3), i))
  return sign + parts.join(",")
}

/**
 * 字节 → 人话。
 *
 * 用 1024 进制并标 KiB/MiB：磁盘占用给用户看的时候，"1.0 MB" 与 "1.0 MiB"
 * 差 5%，而我们这里的数来自 SQLite 的页数 —— 它本来就是 1024 进制的。
 * 标成 MB 等于把一个精确值说成一个近似值。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—"
  if (bytes < 1024) return `${Math.trunc(bytes)} B`
  const units = ["KiB", "MiB", "GiB", "TiB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value).toString()} ${units[unit]}`
}

/** 毫秒 → "15 秒" / "2 分钟"。给探针间隔这种"多久一次"用。 */
export function formatInterval(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—"
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`
  return `${Math.round(ms / 60_000)} 分钟`
}

/**
 * Outbox 落后量的语气。
 *
 * ## ★ 判据（这是这个文件里唯一"有观点"的地方）
 *
 * · 0 → good：追平了；
 * · < 500 → neutral：正常的在途量。一轮采集能进上百条，
 *   落后几十几百只说明消费者还没跑到，不是问题；
 * · < 5000 → warn：某个消费者慢了，但还在追；
 * · 否则 → bad：多半是某个消费者卡住了（lease 没释放 / 反复失败）。
 *
 * 阈值给得宽是刻意的：一个天天亮黄灯的仪表盘等于没有仪表盘 ——
 * 人会学会忽略它，然后真的出问题时也一起忽略了。
 */
export function lagTone(lag: number): MetricTone {
  if (lag <= 0) return "good"
  if (lag < 500) return "neutral"
  if (lag < 5_000) return "warn"
  return "bad"
}

export const LAG_WARN_THRESHOLD = 500
export const LAG_BAD_THRESHOLD = 5_000

/**
 * 采集这一组。
 *
 * `running` 为 false 时**不是**把数字藏起来，而是照常给出并在语气上降级：
 * 用户想知道的是"我有多少数据"，那与"现在有没有在采"是两个问题。
 */
export interface IngestCards {
  messages: string
  conversations: string
  media: string
  minutes: string
  /**
   * 听记覆盖面的一句话。null = 没问题（或还没跑过一轮）。
   *
   * ★ 光有听记条数不够：首版列表只取首页，条数会稳定停在 50，
   * 与"这个账号一共 50 场会"完全同形。这一行是那个静默缺失的出口。
   */
  minutesHint: string | null
  storage: string
  lag: string
  lagTone: MetricTone
  probeHint: string
  /** 采集没在跑 / 被拦住时的一句话。null = 正常。 */
  problem: string | null
  /**
   * 渠道当前**没连上**，所以下面这些数字是**历史数据**。
   *
   * ## ★★ 为什么需要这一条
   *
   * 引导的完成判据是「四步都走过」（`onboarding.isDismissed()`，那是刻意的，
   * 见 onboarding.service.ts 文件头）—— 与「**现在**授权还有效吗」无关。
   * 于是登录态过期之后整个应用照常打开：仪表盘显示 8 万条消息、数字分身
   * 有名字有头像，而设置页同时写着「未连接」。
   *
   * 两个画面互相矛盾，且**没有任何一处**告诉用户这些数字是过去采的、
   * 现在一条新消息都进不来。实测就是这个形态（本机 84,367 条 + 「未连接」）。
   *
   * 这不是"多显示一句提示"的锦上添花：用户据此判断"采集正常"，
   * 于是不会去重新授权，而数据从此停在过去 —— 又一个静默降级
   * （CLAUDE.md §4）。
   */
  staleData: boolean
}

/**
 * @param channelConnected 渠道现在连上了吗。`null` = 还不知道（首帧、正在查）
 *   —— 那时**不下结论**，否则已连接的账号会闪一下"历史数据"。
 * @param channelName 当前渠道的显示名（「飞书」/「钉钉」）。
 *
 *   ## ★★ 为什么必须传进来
 *
 *   下面那三句话原来把渠道名**写死成「钉钉」**。而这一页的每个数字都已经
 *   按页头 picker 选中的渠道取过了 —— 于是选飞书时界面上是：飞书的数字，
 *   加一条「钉钉未连接 —— 以下是历史数据」。用户读到的是另一个渠道的状态，
 *   而没有任何痕迹说这句话讲的不是当前渠道。
 *
 *   缺省给「渠道」这个中性词而不是「钉钉」：拿不到名字时说得笼统，
 *   总比笃定地说错一个渠道名好。
 */
export function readIngest(
  snapshot: IngestSnapshot | null,
  channelConnected: boolean | null = null,
  channelName = "渠道",
): IngestCards | null {
  if (snapshot === null) return null
  const staleData = channelConnected === false
  const problem =
    snapshot.blockedReason === "session_expired"
      ? `${channelName}登录已过期，去设置里重新授权`
      : snapshot.blockedReason === "permission_required"
        ? /**
           * ★★ 这句话**不能**说"去授权" —— 它原来写的是「钉钉侧需要一次授权
           * 确认」，而权限类终态里最常见的那个成因**不是**授权缺失：
           *
           * 实测（一次真实刷屏事故）：`ENTERPRISE_NOT_AUTHORIZED` 表示
           * **当前这份渠道客户端**对这个企业没开通所需能力。用户按提示去
           * 重新扫码，扫完问题一动不动 —— 因为要换的是客户端而不是登录态。
           *
           * ★ `lastError` 优先：`classifyDwsError` 已经按具体错误码给了
           * 精确文案（比如"请到设置里换一份客户端"），比这里的通用兜底
           * 有信息量得多。只有在它缺失时才退回这句。
           *
           * 兜底那句刻意用"需要处理"而不是"需要授权"：权限类终态有多种成因
           * （客户端缺能力、跨组织未确认、PAT 缺 scope），而说错方向比
           * 说得笼统更糟 —— 用户会按错误的指引反复尝试。
           */
          (snapshot.lastError ?? `${channelName}侧的权限不足，采集已暂停 —— 去设置里看详情`)
        : snapshot.lastError !== null
          ? snapshot.lastError
          : /**
             * ★ 「未连接」排在 `!running` **之前**。
             *
             * 两者常常同时成立（没连上自然也不跑），而"渠道未连接"是
             * **原因**，"采集未运行"只是它的表现。先说结果那句会让用户
             * 去查采集器，而要做的事在设置页。
             */
            staleData
            ? `${channelName}未连接 —— 以下是历史数据，现在不会有新消息进来`
            : !snapshot.running
              ? "采集未运行"
              : null
  return {
    messages: formatCount(snapshot.messages),
    conversations: formatCount(snapshot.conversations),
    media: formatCount(snapshot.mediaAssets),
    minutes: formatCount(snapshot.minutes),
    minutesHint: minutesHint(snapshot.minutesCoverage),
    storage: formatBytes(snapshot.storage.mainBytes + snapshot.storage.walBytes),
    lag: formatCount(snapshot.ftsLag),
    lagTone: lagTone(snapshot.ftsLag),
    probeHint: snapshot.probeThrottled
      ? `${formatInterval(snapshot.probeIntervalMs)}（已退避）`
      : formatInterval(snapshot.probeIntervalMs),
    problem,
    staleData,
  }
}

/**
 * 听记覆盖面 → 一句话。`null` = 不显示。
 *
 * ## ★ 两种不完整分开说，因为处置不同
 *
 * · **列表没抽干** —— 会议本身少了（撞了页数预算）。等下一轮或放宽预算；
 * · **转写没抽干** —— 会议都在，但某几场的逐句转写不全。那要用户
 *   显式为那几场补拉，等下一轮没用（撞的是同一个上限）。
 *
 * 合成一句"覆盖不全"会让用户不知道该等还是该动手。
 *
 * `null` / `undefined`（还没跑过一轮，或主进程还是旧版没有这个字段）时
 * **不说话**：那时是"未知"，而编一句"没问题"正是这次要消灭的那类静默。
 *
 * ★ `undefined` 也要判：dev 下渲染层热重载而主进程没重启时，快照里
 * 压根没有这个键 —— 只判 `=== null` 会在 `coverage.drained` 上抛
 * `Cannot read properties of undefined`，而那会让整个面板白屏。
 */
function minutesHint(coverage: IngestSnapshot["minutesCoverage"] | undefined): string | null {
  if (coverage === null || coverage === undefined) return null
  const parts: string[] = []
  if (!coverage.drained) parts.push("会议列表未抽干，可能还有更早的会没采到")
  if (coverage.transcriptTruncated > 0) {
    parts.push(`${String(coverage.transcriptTruncated)} 场会的转写不完整`)
  }
  return parts.length === 0 ? null : parts.join("；")
}

/**
 * 蒸馏这一组。
 *
 * ★ `total === 0` 要与"跑完了 0 条"分开：前者是"还没开始"（应当引导用户去
 * 选范围），后者是"跑了但什么都没产出"（那是真问题，历史上出现过 ——
 * 身份未确认导致 9768 条语料全被守卫拒掉，而进度页显示"完成"）。
 * 两者都显示 0% 的话，那个真问题会被当成"我还没开始"而永远查不出来。
 */
export interface DistillCards {
  facets: string
  done: string
  ratio: number
  failed: string
  tokens: string
  state: "idle" | "running" | "done" | "empty" | "failing"
  stateText: string
}

export function readDistill(progress: DistillProgressView | null): DistillCards | null {
  if (progress === null) return null
  const finished = progress.done + progress.skipped
  const ratio = progress.total === 0 ? 0 : finished / progress.total
  const state: DistillCards["state"] =
    progress.total === 0
      ? "idle"
      : progress.running > 0 || progress.pending > 0
        ? "running"
        : progress.failed > 0 && progress.done === 0
          ? "failing"
          : progress.facetCount === 0
            ? "empty"
            : "done"
  const stateText =
    state === "idle"
      ? "还没选蒸馏范围"
      : state === "running"
        ? `进行中：${progress.done + progress.skipped}/${progress.total}`
        : state === "failing"
          ? `全部失败（${progress.failed} 个任务）`
          : state === "empty"
            ? "任务跑完但没有结论 —— 多半是本人身份未确认"
            : "已完成"
  return {
    facets: formatCount(progress.facetCount),
    done: `${formatCount(finished)} / ${formatCount(progress.total)}`,
    ratio,
    failed: formatCount(progress.failed),
    tokens: formatCount(progress.costTokens),
    state,
    stateText,
  }
}

/** 分身这一组。 */
export interface PersonaCards {
  autoReply: string
  pendingInbox: string
  pendingDrafts: string
  residents: string
  killSwitch: boolean
  /** 有降级时的一句话（没配 LLM / agent 不可用 / 急停开着）。 */
  degraded: string | null
}

export function readPersona(snapshot: PersonaSnapshotView | null): PersonaCards | null {
  if (snapshot === null) return null
  const degraded = snapshot.killSwitch
    ? "急停开着 —— 所有发送都被拦住"
    : !snapshot.agentAvailable
      ? "分身运行时不可用，草稿是占位文本"
      : !snapshot.running
        ? "调度未运行"
        : null
  return {
    autoReply: formatCount(snapshot.autoReplyCount),
    pendingInbox: formatCount(snapshot.pendingInbox),
    pendingDrafts: formatCount(snapshot.pendingDrafts),
    residents: `${snapshot.residents.length} / ${snapshot.maxResident}`,
    killSwitch: snapshot.killSwitch,
    degraded,
  }
}

/**
 * 图谱这一组。
 *
 * kl 的状态是 stopped/starting/ready/failed 四态 + building。
 * 这里把它压成一句人话 —— 用户不需要知道我们的状态机，
 * 只需要知道"能不能用"和"要不要等"。
 */
export function describeKl(status: KlServerStatus | null): {
  text: string
  tone: MetricTone
  progressRatio: number | null
} {
  if (status === null) return { text: "未集成", tone: "muted", progressRatio: null }
  if (status.building) {
    const p = status.buildProgress
    const phase =
      p === null
        ? ""
        : p.phase === "phase_a"
          ? "切块与向量化"
          : p.phase === "phase_b"
            ? "抽取与建图"
            : p.phase === "improve"
              ? "社区与排序"
              : p.phase
    return {
      text: phase === "" ? "建图中" : `建图中 · ${phase}`,
      tone: "neutral",
      progressRatio: p?.percent ?? null,
    }
  }
  if (status.state === "ready") return { text: "就绪", tone: "good", progressRatio: null }
  if (status.state === "starting") return { text: "启动中", tone: "neutral", progressRatio: null }
  if (status.state === "failed")
    return { text: status.reason ?? "启动失败", tone: "bad", progressRatio: null }
  return { text: "未启动", tone: "muted", progressRatio: null }
}

/**
 * 毫秒 → 倒计时文案（"约 3 小时" / "约 25 分钟" / "不到 1 分钟"）。
 *
 * ★ 一律带"约"：这个数是**下界**（触发要等下一轮图谱同步，默认 10 分钟一轮），
 * 所以给一个精确到秒的倒计时是在承诺做不到的事。写"约"之后
 * 「显示 0 分钟但还没开始」就不再是一个 bug 报告。
 */
/**
 * 格式化一个**确定的时长**（配置值），不带"约"。
 *
 * ★ 与 `formatEta` 分开是刻意的：那个格式化的是**估算**（还要等多久），
 * 带"约"是诚实的；而这个格式化的是**用户自己配的那个数**，
 * 说「约 1 小时」会让人以为系统在猜 —— 而它就是 1 小时。
 *
 * 实测撞到过：「最小间隔 约 1 小时，可在设置里改」——「约」与「可在设置里改」
 * 放在一起自相矛盾（可配置的值不该是约数）。
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—"
  if (ms % 3_600_000 === 0) return `${String(ms / 3_600_000)} 小时`
  if (ms % 60_000 === 0) return `${String(ms / 60_000)} 分钟`
  return `${String(Math.round(ms / 60_000))} 分钟`
}

export function formatEta(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 60_000) return "不到 1 分钟"
  if (ms < 3_600_000) return `约 ${String(Math.round(ms / 60_000))} 分钟`
  if (ms < 86_400_000) return `约 ${String(Math.round(ms / 3_600_000))} 小时`
  return `约 ${String(Math.round(ms / 86_400_000))} 天`
}

/**
 * `graph.reason` 那句话**要不要常驻在版面上**。
 *
 * ## ★★ 判据是「用户现在需要做什么吗」，不是「信息重不重要」
 *
 * 那个字段现在有四种来源（`kl-server.service.ts` 的 `graphOverview`）：
 *
 * | 形态 | 例子 | 该常驻吗 |
 * |---|---|---|
 * | 建图中（缺库窗口） | `正在建图 —— 这一轮完成后就会有内容` | ✗ 板块头按钮已经写着「同步中…」 |
 * | 建图中（有库） | `正在建图 —— 数字会随进度增长` | ✗ 同上 |
 * | 还没建过 | `还没建过图（点「重新建图」开始…）` | ✗ 那颗按钮本身就是入口 |
 * | 半成品 / 读失败 | `事实一条都没抽出来 —— Phase B 的 LLM 抽取没成功` | **✓ 要动手**（重试或换网关） |
 *
 * 前三种是**进度或入口的复述** —— 它们与旁边那颗按钮说的是同一件事，
 * 常驻等于把同一句话说两遍，而版面被挤掉一行。第四种才有下一步动作。
 *
 * ## ★★★ 为什么用结构化输入而不是匹配文案
 *
 * 最直接的写法是 `reason.includes("正在建图")`。那会在**改文案的那一天**
 * 静默失效 —— 而失效的表现是"黄条又常驻了"，没有任何报错，
 * 而且没人会想到去改这个判据（本仓库刚因为
 * `formatEta`/`formatDuration` 那类文案耦合栽过）。
 *
 * `building` 与 `available` 是主进程给的**事实**，与措辞无关：
 * · `building` = 我们自己的状态机（`rebuildGraph` 进出时置位）；
 * · `available` = 图里有没有东西（`entities > 0 || facts > 0`）。
 *
 * 「还没建过」那一档的判据是 `available===false && building===false`
 * —— 而"半成品"恰恰是 `available===true`（有实体但 facts=0），
 * 两者因此可分。
 */
export function classifyGraphReason(input: {
  reason: string | null
  /** 我们的建图状态机（`klServerStatus.building`） */
  building: boolean
  /** 图里有没有东西（`graphOverview.available`） */
  available: boolean
}): "none" | "progress" | "actionable" {
  if (input.reason === null || input.reason.trim() === "") return "none"
  // 正在建 → 进度。板块头那颗按钮已经在说这件事。
  if (input.building) return "progress"
  /**
   * 图里空着且没在建 = 「还没建过」。那是**入口**而不是问题 ——
   * 旁边那颗「首次同步」就是下一步，再说一遍没有信息量。
   */
  if (!input.available) return "progress"
  /**
   * 有内容却仍有话说 = 半成品（facts=0 / 读失败）→ 要用户动手。
   * ★ 这一档必须常驻：收起来等于把一个待办藏进 popover。
   */
  return "actionable"
}

/**
 * 最近一轮建图**产出了多少** → 一句人能读的话。`null` = 还没建过 / 没测到。
 *
 * ## ★★ 为什么需要它（绝对值回答不了这个问题）
 *
 * 界面上「实体 618 / 事实 814」说的是"图里有多少"。而用户问的是
 * "刚才那一轮干了什么" —— 增量建图下一轮可能只新增几十个实体，
 * 总数几乎不变，于是**每轮看起来都像没跑**。而那恰恰让人以为增量没生效。
 *
 * ## ★ 三段各自回答一个问题
 *
 * · 新增了什么（实体/事实/关系的**净增**）；
 * · 处理了多少语料（`unitsProcessed` / `chunksCreated`）；
 * · 增量省了多少（`unitsSkipped` —— 那是没白烧的 LLM 抽取，也就是钱与时间）。
 *
 * ★ 净增允许**负数**并原样显示（带符号）：`fresh` 重建先清空、
 * 或上游合并了重复实体都会让某项减少。夹到 0 会把"合并生效了"说成"没变化"。
 */
export function describeBuildVolume(volume: KlGraphOverview["lastBuild"]): string | null {
  if (volume === null) return null
  const { entities, facts, edges, unitsProcessed, unitsSkipped, chunksCreated } = volume

  /**
   * ★ 全 0 时说「没有新增」而不是「+0 实体 +0 事实」——
   * 后者读起来像坏了，而它其实是个正常状态（语料都命中了缓存）。
   */
  const grew = entities !== 0 || facts !== 0 || edges !== 0
  const signed = (n: number): string => (n > 0 ? `+${formatCount(n)}` : formatCount(n))
  const gains = grew
    ? `新增 ${signed(entities)} 实体 · ${signed(facts)} 事实 · ${signed(edges)} 关系`
    : "本轮没有新增实体/事实"

  /** 处理量：`unitsProcessed` 为 0 时整段省掉（那时上游没给或真没处理）。 */
  const work =
    unitsProcessed > 0
      ? ` · 处理 ${formatCount(unitsProcessed)} 条语料（切 ${formatCount(chunksCreated)} 块）`
      : ""

  /**
   * ★ 跳过数只在 > 0 时说，并且说清它**是好事**（省了抽取）——
   * 光报一个"跳过 2,589"会被读成"漏了 2589 条"。
   */
  const saved = unitsSkipped > 0 ? ` · 增量跳过 ${formatCount(unitsSkipped)} 条（已抽过）` : ""

  return `${gains}${work}${saved}`
}

/**
 * 自动建图的调度状态 → 一句人能读的话。
 *
 * ## ★ 每个 reason 都要说不同的话（这是这个函数存在的理由）
 *
 * `AutoBuildSkipReason` 的注释里写过：一个把人引向错误方向的原因码
 * 比没有原因码更糟。`build-in-progress` 曾经叫 `not-ready`，
 * 于是日志里连刷几条看起来像"kl 起不来"（要去查 Python/端口），
 * 而真实情况是它正忙着出结果。这里把那几种情况分开成不同的话。
 *
 * ## 为什么倒计时只在"由时间决定"时才显示
 *
 * `etaMs === null` 表示等下去也不会开始（关掉了 / 正在建 / 没有新数据）。
 * 那时显示倒计时是在骗人 —— 契约里 null 与 0 分开正是为了这件事。
 */
export function describeBuildSchedule(
  schedule: KlGraphOverview["buildSchedule"],
): { text: string; tone: MetricTone } | null {
  if (schedule === null) return null
  const { reason, etaMs, pendingMessages, messagesToThreshold, lagThreshold, minIntervalMs } =
    schedule

  if (!schedule.enabled) {
    /**
     * ★★ 「关闭」不是一个开关，而是**没配 LLM** 的结果 —— 必须说出原因。
     *
     * `autoBuild.enabled` 的判据是 `klBaseUrl` 与 `klApiKey` 都非空
     * （见 startup.ts）。所以这里的"关闭"读起来像"你自己关掉了"，
     * 而实际是"缺配置"—— 两者的下一步完全不同：前者去找开关（找不到），
     * 后者去设置里填模型。
     *
     * 实测撞上：用户看到「知识加工落后 28,819 条」+「自动构建已关闭」，
     * 而这两句合起来完全没有指向"去配模型"。同一份日志里
     * `llm not configured` 早就写着原因，只是没传到界面上。
     */
    return { text: "自动构建已关闭 · 需先配置模型（或手动触发）", tone: "muted" }
  }
  if (reason === "build-in-progress") {
    // ★ 措辞刻意不是"未就绪"：那会把人引去查环境，而实际是上一轮在跑。
    return { text: "上一轮构建仍在进行", tone: "neutral" }
  }
  if (schedule.willBuild) {
    return { text: `已达触发条件 · 下一轮同步开始构建`, tone: "neutral" }
  }
  if (reason === "backoff") {
    return {
      text: `构建失败后退避中 · ${etaMs === null ? "待重试" : `${formatEta(etaMs)}后重试`}`,
      tone: "warn",
    }
  }
  if (reason === "no-new-data") {
    // 没有增量时时间条件也不会触发（max-age 要求同时有新数据）—— 不给倒计时。
    return { text: "无增量数据 · 暂不构建", tone: "muted" }
  }
  /**
   * ★ 首次建图前在等够初始跨度（14 天 / min(14天, 学习范围)）。
   *
   * 这是用户要的那句"小提示"：第一张图要先攒够一段时间跨度再建（否则建出来
   * 又薄又马上过时、还得全量重烧）。措辞要说清"在攒、不是坏了"，并给倒计时。
   * `etaMs === null`（拿不到最早时刻）时不给一个走到 0 也不会建的假倒计时。
   */
  if (reason === "awaiting-initial-window") {
    const wait = etaMs === null ? "" : `约 ${formatEta(etaMs)}后`
    return {
      text: `正在积累前期数据 · ${wait}生成第一张图谱（数据采齐后会提前）`,
      tone: "muted",
    }
  }
  /**
   * ★★★ `min-interval`：**条数早就够了，只是在冷却**。
   *
   * 这一档原来没有，于是它掉进下面那个 `below-threshold` 的分支，
   * 拼出一句自相矛盾的话（实测界面原文）：
   *
   * ```
   * 自动构建 · 增量 25,477 / 500 条（还差 0 条） · 或 约 23 小时后按时间触发
   * ```
   *
   * 「还差 0 条」读起来像卡住了，而「23 小时」是 24h 兜底的倒计时 ——
   * 真正要等的是冷却的剩余（那一刻实测还有约 23 **分钟**，差 60 倍）。
   * 两个数字各自按公式都对，合起来把用户指向两个都错的结论：
   * 「要等一整天」或「条数还没攒够」。
   *
   * ★ 这句话要同时给出三件事：已达标（别再等条数）、还要等多久（冷却剩余）、
   * 那个冷却是可配置的（否则用户以为是写死的）。
   */
  if (reason === "min-interval") {
    const gap = formatDuration(minIntervalMs)
    const wait = etaMs === null ? "" : `，${formatEta(etaMs)}后构建`
    return {
      text: `增量 ${formatCount(pendingMessages)} 条已达标 · 冷却中${wait}（最小间隔 ${gap}，可在设置里改）`,
      tone: "muted",
    }
  }
  // below-threshold：两个条件谁先到都会触发，所以两个都报。
  const byCount = `增量 ${formatCount(pendingMessages)} / ${formatCount(lagThreshold)} 条`
  const byTime = etaMs === null ? "" : ` · 或 ${formatEta(etaMs)}后按时间触发`
  return {
    text: `${byCount}（还差 ${formatCount(messagesToThreshold)} 条）${byTime}`,
    tone: "muted",
  }
}

/**
 * Outbox 消费者里**最落后**的那个。
 *
 * ★ 取最大值而不是平均：平均会把"一个消费者彻底卡死"稀释成一个温和的数字
 * （5 个消费者里 1 个落后 10000、其余 0 → 平均 2000，看起来只是有点忙）。
 * 而卡死的那一个正是我们要看见的。
 */
export function worstConsumer(
  info: FeedInfo | null,
): { consumerId: string; lag: number; needsFullRebuild: boolean } | null {
  if (info === null || info.consumers.length === 0) return null
  let worst = info.consumers[0]
  if (worst === undefined) return null
  for (const c of info.consumers) if (c.lag > worst.lag) worst = c
  return { consumerId: worst.consumerId, lag: worst.lag, needsFullRebuild: worst.needsFullRebuild }
}

/**
 * 「知识加工」的一句话状态。
 *
 * ## ★ 为什么把两个板块压成一行
 *
 * 仪表盘原来有「知识管道」（Outbox 消费者的 acked_seq / lag / 死信）与
 * 「画像蒸馏」（distill_tasks 的 facet × 窗口状态机）两整块。那些数字
 * **要求用户理解我们的架构**才能读懂 —— 而他要的答案只有一个：
 * 「现在能不能用、有没有出事」。
 *
 * 但**不能直接丢掉**：这两块各自承载了一个真实的失效信号
 * （消费者卡死 → 检索结果不是最新的；蒸馏跑完但 0 条结论 → 画像是空的，
 * 而那通常是本人身份没确认）。这两个信号有用，摆出来的方式没用。
 *
 * 所以压成一行：正常时返回 null（不占地方），出事时返回一句**人话**
 * —— 说清后果与下一步，而不是 `acked_seq=10230`。
 *
 * 技术细节仍在「设置 → 状态」页（那里本来就是给排查用的）。
 */
export function readProcessing(input: {
  feed: FeedInfo | null
  distill: DistillProgressView | null
}): { text: string; tone: "warn" | "bad" } | null {
  const worst = worstConsumer(input.feed)
  /**
   * 落后阈值取 500。
   *
   * 依据：一轮采集最多带回几百条消息（实测单窗 2529 条要 51 页），
   * 而消费者是每轮 tick 追的 —— 几十条的落后是**正常的在途量**，
   * 报出来就是狼来了。500 以上才说明追不上。
   */
  if (worst !== null && worst.needsFullRebuild) {
    return { text: `${worst.consumerId} 需要重建索引 —— 搜索结果可能不完整`, tone: "warn" }
  }
  if (worst !== null && worst.lag > 500) {
    return {
      text: `知识加工落后 ${formatCount(worst.lag)} 条 —— 最近的消息可能还搜不到`,
      tone: "warn",
    }
  }

  const dis = readDistill(input.distill)
  /**
   * 蒸馏只报两种：**全失败**与**跑完但没结论**。
   *
   * 「进行中」不报 —— 那是正常工作，而它可能持续几十分钟
   * （一个横幅挂几十分钟会被当成背景，之后真出事时也不会被看见）。
   */
  if (dis !== null && dis.state === "failing") {
    return { text: `画像蒸馏全部失败（${dis.failed} 个任务）—— 去设置里看模型配置`, tone: "bad" }
  }
  if (dis !== null && dis.state === "empty") {
    return { text: "画像蒸馏跑完但没有结论 —— 多半是本人身份未确认", tone: "bad" }
  }
  return null
}

/**
 * 身份条要显示什么 —— 纯判定，与 React 无关。
 *
 * ## ★ 为什么抽出来
 *
 * 这一条上有四个"看起来显然、实际会写错"的判定，而它们都是**静默**的：
 *
 * · 渠道要不要给切换器（给一个只有一项的下拉是假的可配置性）；
 * · 哪些渠道算"已连接"（`expired` 不算 —— 那个状态下采集已经停了，
 *   把它列成可选项等于让用户以为切过去还有数据）；
 * · 分身有没有名字（没名字时草稿署名会回落到兜底文案「数字分身」，
 *   而那个回落在这一页上看不出来）；
 * · 身份判定的三态（未读到 / 已确认 / 待确认）—— 待确认时蒸馏会拒掉
 *   **全部**语料且不报错，所以那一档必须是警告色而不是灰字。
 *
 * 放在组件里只能靠 CDP 探针读渲染结果去验，那种断言又慢又脆。
 */
export interface IdentityBarView {
  /** 已连接（真的授权成功）的渠道 id。顺序即渲染顺序 */
  connectedChannelIds: string[]
  /**
   * 要不要渲染渠道切换器。
   *
   * ★ 判据是**已连接 ≥ 2**，不是"渠道插件 ≥ 2"：飞书的插件在，但
   * `available: false`，给它一个选项点了只能跳设置 —— 而设置里已经有
   * 渠道页，在仪表盘再放一个入口是重复。
   */
  showChannelPicker: boolean
  /** 分身配过名字了吗。false 时右半边给「去起个名字」而不是空字符串 */
  personaNamed: boolean
  /** 身份判定的三态 */
  selfState: "unknown" | "confirmed" | "unconfirmed"
}

export function readIdentityBar(input: {
  channels: readonly { id: string; status: { state: string } }[]
  personaName: string
  selfConfirmed: boolean | null
}): IdentityBarView {
  const connectedChannelIds = input.channels
    .filter((item) => item.status.state === "authorized")
    .map((item) => item.id)
  return {
    connectedChannelIds,
    showChannelPicker: connectedChannelIds.length >= 2,
    personaNamed: input.personaName.trim() !== "",
    selfState:
      input.selfConfirmed === null ? "unknown" : input.selfConfirmed ? "confirmed" : "unconfirmed",
  }
}

/**
 * 身份未确认时，那条红字该把用户指向**哪个**入口。
 *
 * ## ★★ 为什么要分情形（从前一律说"去设置里确认"）
 *
 * 未确认有两个成因，而它们的正确动作在**不同的页面**上：
 *
 * · **继承来的登录态**（最常见）：渠道登录态按系统用户共享，新注册的应用
 *   账号一进来就是"已连接"，于是用户没有理由去点重新授权 → 落身份行的
 *   `onAuthorized` **从不触发**。这时该做的是去**渠道页**点「采纳本机登录态」，
 *   而那个「解析身份」按钮解决不了它（完整机理见主进程
 *   `adoptExistingSession` 的注释）。
 * · **解析失败/歧义**：这时才该去解析并确认。
 *
 * 把两者说成同一句话的后果不是"文案不精确"，而是**把人指向一个按了没用的
 * 按钮** —— 而未确认期间蒸馏拒掉全部语料，用户在错误的地方反复尝试时
 * 画像一直是空的。
 *
 * ★ 抽成纯函数与 `readIdentityBar` 同理：判据要能被单测锁住，
 * 而在组件里只能靠渲染探针去验，那种断言又慢又脆。
 *
 * @param adoptable 本机有一份可采纳的登录态吗（来自 `useAdoptableSession`）。
 *   `undefined` = 还在查 / 没查（那时按"解析失败"处理，那是更保守的指向：
 *   那条路对两种成因都至少是可尝试的）。
 * @param identityState 主进程给的**原因**（`IngestSnapshot.selfIdentityState`）。
 *   有它才能把"真的同名歧义"与"只是还没解析"分开 —— 两者在库里同形
 *   （都没有身份行），而引导相反。不传（旧调用方）时退回原来的两分法。
 */
export function readIdentityProblem(input: {
  selfState: IdentityBarView["selfState"]
  adoptable: { corpName: string; userName: string } | null | undefined
  identityState?: "unbound" | "unresolved" | "ambiguous" | "unconfirmed" | null | undefined
}):
  | { kind: "adopt"; corpName: string; userName: string }
  | { kind: "resolve" }
  | { kind: "ambiguous" }
  | null {
  // 只在真的"读到了、但没确认"时说话。`unknown` 是加载态，报警是狼来了。
  if (input.selfState !== "unconfirmed") return null
  /**
   * ★★ 没绑身份 → **什么都不说**（不是"换一句话说"）。
   *
   * 这一档的正确动作是"去授权"，而那件事**已经有人在说了**，而且说得更好：
   * · 引导页：上方那个授权面板本身就写着「为当前账号授权一次，才能确定
   *   「你」是谁」，还带着「开始授权」按钮；
   * · 仪表盘：`readIngest` 的 `staleData` 那条说「钉钉未连接 —— 以下是
   *   历史数据，现在不会有新消息进来」。
   *
   * 在它们下面再挂一个"还没授权"的框，是同一件事说两遍 —— 而重复的提示
   * 会稀释真正需要注意的那条（同名歧义、解析失败那两档才是这里的职责）。
   *
   * ★ 这不是"少报一个状态"：`unbound` 的可见性由那两处负责，
   * 这里返回 null 只是不重复。删掉它们中任何一个之前，先把这句话搬过去。
   */
  if (input.identityState === "unbound") return null
  /**
   * ★★ 真的同名歧义 —— **只有**主进程说是它才这么讲。
   *
   * 原来界面对所有"未确认"都显示「检测到同名的多个账号」，而那句话
   * 在绝大多数成因下是**假的**（刚清过数据、解析失败、还没授权都会走到
   * 这里）。它会让用户去找一个不存在的重名同事，而真正该做的事不被提及。
   */
  if (input.identityState === "ambiguous") return { kind: "ambiguous" }
  const adoptable = input.adoptable
  if (adoptable === null || adoptable === undefined) return { kind: "resolve" }
  return { kind: "adopt", corpName: adoptable.corpName, userName: adoptable.userName }
}

// ---------------------------------------------------------------
// 时序 + 消化漏斗
// ---------------------------------------------------------------

/**
 * 一个周期的汇总（时序图上方那几个数）。
 *
 * ★ 全部是**这个窗口内**的量，与仪表盘顶部的"总共有多少"是两回事。
 * 混在一起是这一页最容易读错的地方，所以文案上必须带周期
 * （"近 30 天收到 8,142 条"而不是"收到 8,142 条"）。
 */
export interface TrendSummary {
  /** 窗口内收到的消息数 */
  inbound: number
  /** 窗口内发出的消息数 */
  outbound: number
  /** 窗口内进了图谱的块数 */
  chunks: number
  /** 日均（按**有数据的天**算，不是按窗口天数）*/
  perDay: number
  /** 最忙的那天（unix ms + 条数）；null = 窗口内一条都没有 */
  busiest: { at: number; count: number } | null
  /**
   * 窗口内**一条消息都没有**的天数。
   *
   * ★ 单独摊出来：那些天是"采集断了"还是"周末"，用户自己知道 ——
   * 但界面必须先让他看见有几天是空的。曲线上的低谷不带数字，
   * 而"11 天没有数据"是个能立刻判断的事实。
   */
  emptyDays: number
}

export function readTrendSummary(trends: DashboardTrends | null): TrendSummary | null {
  if (trends === null || trends.days.length === 0) return null
  let inbound = 0
  let outbound = 0
  let chunks = 0
  let emptyDays = 0
  let busiest: { at: number; count: number } | null = null
  for (const day of trends.days) {
    inbound += day.inbound
    outbound += day.outbound
    chunks += day.chunks
    const total = day.inbound + day.outbound
    if (total === 0) emptyDays += 1
    if (busiest === null || total > busiest.count) busiest = { at: day.at, count: total }
  }
  /**
   * ★ 日均按**有数据的天**算。
   *
   * 按窗口天数算的话，一个刚采了 3 天的库选「近 90 天」会显示一个
   * 除以 90 的日均 —— 那个数字既不是他的真实节奏，也不说明任何问题。
   * `daysWithData` 为 0 时给 0（而不是 NaN）。
   */
  const denominator = trends.daysWithData > 0 ? trends.daysWithData : 0
  return {
    inbound,
    outbound,
    chunks,
    perDay: denominator === 0 ? 0 : Math.round((inbound + outbound) / denominator),
    // 最忙那天是 0 条时当成"没有"——一个全空的窗口没有"最忙的一天"
    busiest: busiest !== null && busiest.count > 0 ? busiest : null,
    emptyDays,
  }
}

/**
 * 图谱落后的一句话 + 语气。
 *
 * ## ★★ 判据：按**比例**而不是按绝对条数
 *
 * 绝对条数在小库上没有意义（刚装的库落后 500 条是正常的在途量），
 * 而在大库上 500 条又太宽。用"消化了百分之多少"才在两端都成立。
 *
 * · ≥ 95% → good：追平了（留 5% 给在途）；
 * · ≥ 70% → neutral：在追，正常；
 * · ≥ 30% → warn：落后明显，多半是很久没建图；
 * · 否则 → bad：实测本机就是这一档（8.4%）——那是"建图基本没跑过"。
 *
 * ★ `head === 0` 时返回 null（不是 good）：那是**还没有任何数据**，
 * 而"追平了"会让一个空库看起来像一个健康的库。
 */
export interface GraphLagView {
  /** 已消化的比例 0~1；null = 还没有数据 */
  ratio: number | null
  /** 落后的条数 */
  behind: number
  tone: MetricTone
  /** 一句人话；null = 没什么要说的（已追平） */
  text: string | null
}

export const GRAPH_LAG_GOOD = 0.95
export const GRAPH_LAG_OK = 0.7
export const GRAPH_LAG_WARN = 0.3

export function readGraphLag(trends: DashboardTrends | null): GraphLagView | null {
  if (trends === null) return null
  const { head, build } = trends.graphLag
  if (head === 0) return null
  const ratio = Math.min(1, build / head)
  const behind = Math.max(0, head - build)
  if (ratio >= GRAPH_LAG_GOOD) {
    return { ratio, behind, tone: "good", text: null }
  }
  const pct = `${(ratio * 100).toFixed(1)}%`
  if (ratio >= GRAPH_LAG_OK) {
    return {
      ratio,
      behind,
      tone: "neutral",
      text: `已学习 ${pct}，还差 ${formatCount(behind)} 条`,
    }
  }
  if (ratio >= GRAPH_LAG_WARN) {
    return {
      ratio,
      behind,
      tone: "warn",
      text: `已学习 ${pct}（还差 ${formatCount(behind)} 条）—— 点「同步」补上`,
    }
  }
  return {
    ratio,
    behind,
    tone: "bad",
    /**
     * ★ 这句话**必须指出"上面的数字是局部的"**。
     *
     * 实测本机 8.4%：仪表盘显示 602 个实体、975 条事实，而那是从 2,871 条
     * （共 34,142 条）里学到的。用户会把那些数字当成"它了解我的全部"，
     * 于是搜不到东西时以为是检索不行 —— 而真正的原因是大部分聊天还没学。
     */
    text: `才学了 ${pct}（还差 ${formatCount(behind)} 条）—— 上面「认识的人和事」只覆盖这一小部分，点「同步」补上`,
  }
}

/**
 * fact 时间戳覆盖的一句话。
 *
 * ★ 这一条是**给时序图兜底的**：实测 54% 的 fact `timestamp=0`
 * （CAUSAL 类 70%）。任何"事实按时间"的图都会静默丢掉那些，
 * 所以必须有一句话说出被丢掉了多少。不说就是新的静默降级。
 *
 * `null` = 没什么要说的（全都有时间戳，或还没有 fact）。
 */
export function readFactTimestampGap(trends: DashboardTrends | null): string | null {
  if (trends === null) return null
  const { done, total } = trends.coverage.factsTimestamped
  if (total === 0) return null
  const missing = total - done
  if (missing === 0) return null
  const pct = ((missing / total) * 100).toFixed(0)
  return `另有 ${formatCount(missing)} 条事实没有时间戳（${pct}%），不计入按时间的统计`
}

/**
 * kl 原始 source_type → 用户友好名。
 *
 * kl 写的是 `message` / `minutes` / `wiki` 这类内部码，界面不该出现它们。
 * 不认识的类型原样显示（保底不至于漏一类，而不是显示成空）。
 */
const UNIT_TYPE_LABEL: Record<string, string> = {
  message: "聊天",
  minutes: "会议记录",
  wiki: "文档",
  doc: "文档",
  document: "文档",
}

function unitTypeLabel(type: string): string {
  return UNIT_TYPE_LABEL[type] ?? type
}

/**
 * 把「处理单元按类型」拼成一句人话：`聊天 32,828 · 会议记录 8 · 文档 94`。
 *
 * ★ 空数组（旧库没 units 表 / 还没建图）→ null，调用方那一级就只显示总数，
 * 不显示一句空的分类。按数量倒序，最大的那类排前面。
 */
export function describeUnitsByType(
  rows: ReadonlyArray<{ type: string; count: number }> | undefined,
): string | null {
  if (rows === undefined || rows.length === 0) return null
  return [...rows]
    .sort((a, b) => b.count - a.count)
    .map((r) => `${unitTypeLabel(r.type)} ${formatCount(r.count)}`)
    .join(" · ")
}
