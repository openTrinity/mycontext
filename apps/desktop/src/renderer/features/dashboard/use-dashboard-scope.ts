/**
 * 仪表盘的**渠道作用域** —— 一个页面一个取值范围，一处收口。
 *
 * ## ★★ 为什么必须是一个 hook，而不是各组件各自判
 *
 * 这一页的每个数字都属于某个渠道，而"当前是哪个渠道"来自页头那枚 picker。
 * 上一版是**一处一处打补丁**：`useKlGraphEgo(ch)`、`useKlGraphOverview(ch)`、
 * 手写一个 `scopedSnapshot` 叠 `perChannel`…… 七处各自判渠道。
 *
 * 后果是漏了就静默不切，而且**真的漏了两处**（实测）：
 * · `feed`（知识加工落后）→ 飞书采了 8 条，却显示「落后 11,309 条」
 *   （那是钉钉的水位）；
 * · `persona`（数字分身那一排）→ 显示的是钉钉的草稿数。
 *
 * 两个数字都不报错，只是**属于另一个渠道**。这正是本仓库最贵的那类 bug。
 *
 * 收进一个 hook 之后，"这一页的数据"只有一个来源：漏字段变成拿不到值，
 * 而不是拿到一个别的渠道的值。
 *
 * ## ★ 为什么不在主进程按渠道拆
 *
 * 因为"当前看哪个渠道"是**界面状态**（用户点的那枚 picker），主进程不该知道。
 * 主进程只负责"能按渠道给"（`perChannel` / `channelId` 参数），
 * 挑哪一个是这一层的事。
 */
import { useMemo } from "react"
import type { ChannelSummary, IngestSnapshot } from "@mycontext/ipc-contract"
import {
  useChannels,
  useDistillProgress,
  useFeedInfo,
  useIngestSnapshot,
  useKlGraphEgo,
  useKlGraphOverview,
  useKlServerStatus,
  usePersonaSnapshot,
} from "../../lib/queries.js"
import { canRunPersona } from "../../lib/channel-capability.js"

/**
 * 主渠道 id —— 「语料归属」的判据（不是「谁能跑分身」，那个走 `canRunPersona`）。
 *
 * ★ 这两件事曾经共用一个常量，而它们会分叉：将来某个非主渠道开了发送能力时
 * 「能跑分身」变成两个渠道，而「语料来自哪个库」仍然只有主渠道一个
 * （`DistillService` 只有一个 `this.db`）。
 */
const PRIMARY_CHANNEL_ID = "dingtalk"

/**
 * 把顶层快照替换成**某个渠道**的那一份。
 *
 * ★ 逐字段叠而不是整份换：`storage`（整个 vault 的文件体积）与 `eventStream`
 * （主渠道特有的长连接）不是渠道级的 —— 它们在 `perChannel` 里压根没有，
 * 而整份换会把它们变成 undefined。
 */
function scopeSnapshot(snap: IngestSnapshot | null, channelId: string | undefined) {
  if (snap === null || channelId === undefined) return snap
  const row = (snap.perChannel ?? []).find((item) => item.channelId === channelId)
  // 单渠道 / 那个渠道还没挂上 → 顶层那份就是它
  if (row === undefined) return snap
  /**
   * ★★ 逐字段兜底（`?? snap.x`），**不要**裸取 `row.x`。
   *
   * 实测过一次整页白屏：主进程还在跑旧代码（这些字段是后加的），渲染层已经
   * 热更 —— `row.ftsIndexed` 是 undefined，`toLocaleString()` 抛错，整棵树崩。
   * 开发态热更时这个错配是常态，打包态在「新渲染层 + 旧主进程」的升级窗口
   * 里也会出现。一个字段缺失不该让整页看不见。
   */
  return {
    ...snap,
    channelId: row.channelId ?? snap.channelId,
    messages: row.messages ?? snap.messages,
    conversations: row.conversations ?? snap.conversations,
    mediaAssets: row.mediaAssets ?? snap.mediaAssets,
    ftsIndexed: row.ftsIndexed ?? snap.ftsIndexed,
    ftsLag: row.ftsLag ?? snap.ftsLag,
    unjudged: row.unjudged ?? snap.unjudged,
    outboxHead: row.outboxHead ?? snap.outboxHead,
    minutes: row.minutes ?? snap.minutes,
    probeIntervalMs: row.probeIntervalMs ?? snap.probeIntervalMs,
    probeThrottled: row.probeThrottled ?? snap.probeThrottled,
    selfConfirmed: row.selfConfirmed ?? snap.selfConfirmed,
    /**
     * ★ 存储用量也是渠道级的（各渠道一个物理库）。
     *
     * 漏了它的表现：选着飞书，运行状态页显示「库体积 187.7 MB · 原生留存
     * 7,666」，而飞书库真值是 640 KB / 4 条 —— 那两个数是主库的。
     * 数量级差 300 倍，界面上没有任何痕迹说这是别人的数。
     */
    storage: row.storage ?? snap.storage,
    running: row.running ?? snap.running,
    lastError: row.lastError ?? snap.lastError,
    blockedReason: row.blockedReason ?? snap.blockedReason,
  }
}

export interface DashboardScope {
  /** 生效的渠道 id。`undefined` = 还没读到渠道列表 */
  channelId: string | undefined
  /** 已授权的渠道（页头 picker 列它们） */
  channels: readonly ChannelSummary[]
  authorizedChannelIds: readonly string[]
  /**
   * 数字分身在这个渠道上可用吗。
   *
   * `false` 时这一页的数字分身那一块要显示「暂未开通」而不是**另一个渠道的
   * 草稿数** —— 后者会让用户以为那些草稿会发到当前渠道。
   */
  personaSupported: boolean
  /**
   * 主渠道现在连上了吗 —— 给「以下是历史数据」那句提示用。
   *
   * ## ★ 为什么归这个 hook
   *
   * 它原来写在 `dashboard-module.tsx` 里、自己读一次 `useChannels()`。
   * 而这个 hook 已经读了那个查询（算 `authorizedChannelIds`）——
   * 两处各读一遍意味着两处的结论可能不一致，而"渠道作用域"本来就是
   * 这个 hook 的职责（见文件头）。
   *
   * `null`（还在查）= 不下结论：那时不显示"历史数据"，
   * 免得已连接的账号首帧闪一下。
   */
  channelConnected: boolean | null
  /** 采集快照，已切到当前渠道 */
  ingest: IngestSnapshot | null
  /**
   * 以下几项都已按当前渠道取。
   *
   * ★ 类型是 `T | null` 而不是 `T | undefined`：`null` 是"没有数据"这个
   * **明确**的状态（还没加载 / 这个渠道不支持），而消费方（`readPersona` 等）
   * 的签名收的正是 `T | null`。让 undefined 漏出去会让每个调用点都要
   * 多写一次 `?? null`。
   */
  feed: NonNullable<ReturnType<typeof useFeedInfo>["data"]> | null
  persona: NonNullable<ReturnType<typeof usePersonaSnapshot>["data"]> | null
  distill: NonNullable<ReturnType<typeof useDistillProgress>["data"]> | null
  kl: ReturnType<typeof useKlServerStatus>
  ego: ReturnType<typeof useKlGraphEgo>
  overview: ReturnType<typeof useKlGraphOverview>
  building: boolean
}

/**
 * @param pickedChannelId 页头 picker 选中的渠道。`null` = 没选过 → 取第一个已授权的。
 */
export function useDashboardScope(pickedChannelId: string | null): DashboardScope {
  const channels = useChannels()
  const authorizedChannelIds = useMemo(
    () =>
      (channels.data ?? [])
        .filter((c) => c.available && c.status.state === "authorized")
        .map((c) => c.id),
    [channels.data],
  )
  /**
   * 生效的渠道：选过就用它，否则**第一个已授权**的。
   *
   * ★ 于是"只连了飞书"时整页默认展示飞书，而不是一个空的钉钉视图。
   */
  const channelId = pickedChannelId ?? authorizedChannelIds[0] ?? undefined

  const kl = useKlServerStatus()
  const building = kl?.building === true
  const ingest = useIngestSnapshot(true)
  const feed = useFeedInfo(true, channelId)
  const persona = usePersonaSnapshot(true)
  const distill = useDistillProgress(true)
  const ego = useKlGraphEgo(building, channelId)
  const overview = useKlGraphOverview(building, channelId)

  /**
   * ★ 判据是**能力**（`sendAs`）而不是渠道 id —— 见 `canRunPersona`。
   *
   * `channelId === undefined`（渠道列表还没加载）时给 `true`：那一刻界面
   * 还没决定展示哪个渠道，给 false 会让分身那一块先闪一下"暂未开通"。
   */
  const personaSupported =
    channelId === undefined ||
    canRunPersona(channels.data?.find((item) => item.id === channelId))
  /**
   * ★ 判据是**主渠道**的授权态，而不是"当前选中的渠道连没连"。
   *
   * 那句提示说的是「这些数字还在增长吗」，而增长靠的是采集 ——
   * 引导走完之后应用不再判授权（`onboarding.isDismissed()` 只看四步走过没有），
   * 所以登录态过期时仪表盘会一直显示历史数据而不给任何说明。
   * 见 `readIngest` 的 `staleData`。
   *
   * ★ 这里问的是「主渠道是谁」，与上面那个「谁能跑分身」是**两件事**，
   * 所以仍然用 `PRIMARY_CHANNEL_ID` 而不是能力判据：采集这条链的语料
   * 归属确实是按主渠道定的（`DistillService` 只读主库）。
   */
  const primaryState = channels.data?.find((item) => item.id === PRIMARY_CHANNEL_ID)?.status.state
  const channelConnected = primaryState === undefined ? null : primaryState === "authorized"

  return {
    channelId,
    channels: channels.data ?? [],
    authorizedChannelIds,
    personaSupported,
    channelConnected,
    ingest: scopeSnapshot(ingest.data ?? null, channelId),
    feed: feed.data ?? null,
    /**
     * ★ 数字分身**不按渠道取数**（它只在主渠道跑），而是在不支持的渠道上
     * 整块换成一句说明 —— 见 `personaSupported`。
     * 所以这里在不支持时给 `null`，让消费方走"没有数据"那条路。
     */
    persona: personaSupported ? (persona.data ?? null) : null,
    distill: personaSupported ? (distill.data ?? null) : null,
    kl,
    ego,
    overview,
    building,
  }
}
