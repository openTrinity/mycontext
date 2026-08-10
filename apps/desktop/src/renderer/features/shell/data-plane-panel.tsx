/**
 * 数据面状态卡。
 *
 * 三条信息刻意都放在这里，而不是藏在日志里：
 *
 * 1. **存储体积**。实测 2 万条 ≈ 10MB 主库 + 10MB WAL，半年粗估几百 MB。
 *    桌面端悄悄占掉几百 MB 而没有任何提示，会被当成 bug 报上来。
 * 2. **blocked 原因**。登录过期与缺授权靠重试永远好不了 ——
 *    静默重试只会让用户以为功能坏了，必须显式引导。
 * 3. **离线消费者告警**。某个消费者心跳超期意味着它的数据已经不完整了，
 *    用户有权知道，而不是让它静默降级。
 */
import { useState } from "react"
import { Button } from "@mycontext/design"
import type { IngestSnapshot } from "@mycontext/ipc-contract"
import { SelfIdentityPanel } from "../settings/self-identity-panel.js"

/**
 * 主渠道 id。本人身份、数字分身这些只在它上面成立 —— 其余渠道是只读接入。
 */
const PRIMARY_CHANNEL_ID = "dingtalk"
import {
  useClearIngestBlocked,
  useIngestProgress,
  useIngestSnapshot,
  useRunIngestOnce,
} from "../../lib/queries.js"
import { ChannelPicker } from "./channel-picker.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

export function DataPlanePanel({
  enabled,
  channelId: controlledChannel = null,
  onChannelChange,
}: {
  enabled: boolean
  /**
   * 受控的渠道选择。★ 由 `StatusView` 持有 —— 这一页只有一个取值范围，
   * 而下面的建图按钮必须跟它说同一个渠道（见 `KlPanel` 的注释）。
   */
  channelId?: string | null
  onChannelChange?: (id: string) => void
}) {
  const { t } = useDynamicTranslation("settings")
  const snapshot = useIngestSnapshot(enabled)
  const runOnce = useRunIngestOnce()
  const clearBlocked = useClearIngestBlocked()
  // 订阅主进程推来的快照：入库后立刻更新，不轮询
  useIngestProgress()

  /**
   * 当前在看哪个渠道。`null` = 没选过 → 第一个（主渠道排在前）。
   *
   * ★ 这一页的每个数字都跟着它走，而「立即同步」也只跑它 ——
   * 不然用户在飞书那栏点同步，跑的却是钉钉那 1600 条的一轮。
   */
  /** 非受控时的内部态（独立使用这个组件时用）。 */
  const [ownChannel, setOwnChannel] = useState<string | null>(null)
  const pickedChannel = onChannelChange === undefined ? ownChannel : controlledChannel
  const setPickedChannel = onChannelChange ?? setOwnChannel

  const raw = snapshot.data
  if (raw === undefined) return null

  const perChannel = raw.perChannel ?? []
  const channel = pickedChannel ?? perChannel[0]?.channelId ?? raw.channelId
  /**
   * ★★ 按渠道取数 —— 顶层快照只是**其中一个**渠道的。
   *
   * 顶层来自主进程的 `snapshotIngest()`，它挑一个渠道返回（主渠道活跃就只
   * 返回主渠道）。直接用它的话切到飞书之后这一页一动不动，
   * 而用户以为自己在看飞书的采集情况。
   */
  const row = perChannel.find((item) => item.channelId === channel)
  /**
   * ★★ 逐字段兜底（`?? raw.x`），**不要**裸取 `row.x`。
   *
   * 实测过一次整页白屏：主进程还在跑旧代码（那几个字段是后加的），而渲染层
   * 已经热更 —— 于是 `row.ftsIndexed` 是 undefined，`toLocaleString()` 抛错，
   * 整棵 React 树崩掉。开发态热更时这个错配是**常态**，而打包态在
   * 「新渲染层 + 旧主进程」的升级窗口里也会出现。
   *
   * 一个字段缺失不该让整页看不见。兜底到顶层那份（它一定有这些字段，
   * 因为它就是 `IngestSnapshot` 本身）—— 值可能属于另一个渠道，
   * 但那比白屏好，而且下一次热更就对了。
   */
  const data =
    row === undefined
      ? raw
      : {
          ...raw,
          channelId: row.channelId,
          messages: row.messages ?? raw.messages,
          conversations: row.conversations ?? raw.conversations,
          mediaAssets: row.mediaAssets ?? raw.mediaAssets,
          ftsIndexed: row.ftsIndexed ?? raw.ftsIndexed,
          ftsLag: row.ftsLag ?? raw.ftsLag,
          unjudged: row.unjudged ?? raw.unjudged,
          outboxHead: row.outboxHead ?? raw.outboxHead,
          minutes: row.minutes ?? raw.minutes,
          probeIntervalMs: row.probeIntervalMs ?? raw.probeIntervalMs,
          probeThrottled: row.probeThrottled ?? raw.probeThrottled,
          selfConfirmed: row.selfConfirmed ?? raw.selfConfirmed,
          /**
           * ★ 存储用量也是渠道级的（各渠道一个物理库）。
           *
           * 漏了它的表现：选着飞书，这一页显示「库体积 187.7 MB · 原生留存
           * 7,666」，而飞书库真值是 640 KB / 4 条 —— 那是主库的数
           * （192 MB / 7,684）。差 300 倍而界面上毫无痕迹。
           */
          storage: row.storage ?? raw.storage,
          running: row.running ?? raw.running,
          lastError: row.lastError ?? raw.lastError,
          blockedReason: row.blockedReason ?? raw.blockedReason,
        }

  return (
    <section className="flex flex-col gap-[var(--gap-section-sm)]">
      <div className="flex items-center justify-between gap-3">
        <h2 className="typography-title-small-500 text-[var(--text-base-primary)]">
          {t("status.sections.dataPlane")}
        </h2>
        <div className="flex items-center gap-2">
          {/*
            ★ 渠道选择器：这一页的每个数字都跟着它，而「立即同步」也只跑它。
            单渠道时 `ChannelPicker` 自己退化成静态标识（判断在它那一处）。
          */}
          <ChannelPicker
            options={perChannel.map((item) => ({
              id: item.channelId,
              label: t(`status.dataPlane.channel.${item.channelId}`, {
                defaultValue: item.channelId,
              }),
            }))}
            activeId={channel}
            onChange={setPickedChannel}
            ariaLabel={t("status.dataPlane.channelPickerLabel", { defaultValue: "选择渠道" })}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!data.running || runOnce.isPending}
            /**
             * ★★ 禁用时给出**原因**。
             *
             * 实测：用户点「立即同步」，什么都没发生、日志里一条记录都没有 ——
             * 因为按钮是 disabled 的（`data.running` 为假），而 disabled 的按钮
             * 点下去与"跑了但没拉到新消息"在界面上**完全一样**。
             *
             * `running` 在主进程是「这个渠道进了 activeChannels **且**
             * 采集器在跑」，也就是"这个渠道现在没在采"。这句话用户能看懂、
             * 也知道下一步去哪（授权那一页）。
             */
            title={
              data.running
                ? undefined
                : t("status.dataPlane.syncNowDisabled", {
                    defaultValue: "这个渠道当前没有在采集，先完成授权",
                  })
            }
            onClick={() => runOnce.mutate({ channelId: channel })}
          >
            {t("status.dataPlane.syncNow")}
          </Button>
        </div>
      </div>

      {data.blockedReason !== null && (
        <BlockedBanner
          reason={data.blockedReason}
          onDismiss={() => clearBlocked.mutate()}
          label={t(`status.dataPlane.blocked.${data.blockedReason}`)}
          action={t("status.dataPlane.blocked.retry")}
        />
      )}

      {data.staleConsumers.length > 0 && (
        <p className="typography-body-small-400 rounded-[var(--radius-md)] bg-[var(--status-fill-warning-container)] px-3 py-2 text-[var(--status-warning)]">
          {t("status.dataPlane.staleConsumers", { list: data.staleConsumers.join(", ") })}
        </p>
      )}

      {/* ★ 归属判定同样只对主渠道成立（它依赖身份行）—— 见下面 SelfIdentityPanel */}
      {channel === PRIMARY_CHANNEL_ID && data.unjudged > 0 && (
        <p className="typography-body-small-400 text-[var(--text-base-tertiary)]">
          {t("status.dataPlane.unjudgedHint", { count: data.unjudged })}
        </p>
      )}

      {/*
        ★ 身份确认入口。
        未确认时蒸馏会拒掉**全部**语料且不报错 —— 这是那类失效的唯一出口，
        所以放在状态页最显眼的位置（就在"未判定 N 条"那行下面）。
      */}
      {/*
        ★★ 本人身份**只对主渠道**有意义。
        
        `readSelfIdentity()` 返回的是主渠道那一行（主进程里写死
        `plugin.meta.id`），而非主渠道压根没有身份行。于是选了飞书时这一块
        会弹出**钉钉的**身份卡（工号/组织/"779 条本人消息"）并要求"解析身份"
        —— 一个用户按了也不会有正确结果的操作，而它指向的是另一个渠道。
        
        非主渠道要有身份确认，得先让 `readSelfIdentity` 支持按渠道取
        （那需要每个渠道各自的身份行）。在那之前不显示比显示错的好。
      */}
      {channel === PRIMARY_CHANNEL_ID ? (
        <SelfIdentityPanel confirmed={data.selfConfirmed} unjudged={data.unjudged} />
      ) : null}

      {/*
        ★ 九个数字**分两层**，不再一个 3×3 网格平铺。

        ## 为什么原来那样读不出信息

        九个 `Metric` 同字号（13px）同颜色，排成 3×3 —— 那是一张**电子表格**
        而不是状态页。用户来这一页只有一个问题：「采集在正常干活吗」，
        而回答它只需要两个数：**采到了多少条**、**其中多少能搜到**。
        其余七个（水位、探针周期、向量数、库体积、原生留存、身份、会话数）
        是排查时才看的 —— 它们与那两个同权重，等于让人每次都读九遍。

        ## 分层的判据是"回答哪个问题"

        · **主行**（大号）：已采集消息 + 已建索引 —— 这两个一起回答
          "在干活吗"，而且它们的**差值**就是"索引落后多少"（ftsLag）；
        · **详情行**（小号、灰）：其余七个，排查时看。

        `title-base-600`（18px）而不是 `title-large-600`（26px）：
        这一页不是仪表盘，26px 会让状态页看起来像营销页；而 18px 对 13px
        已经是清晰的两级。★ 也因此这里**不占用** hero 那一档 ——
        「每屏只有一个 hero」是那一档成立的前提，而它属于仪表盘。
      */}
      <div className="flex flex-col gap-[var(--gap-component-md)]">
        <dl className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
          <Lead
            label={t("status.dataPlane.messages")}
            value={data.messages.toLocaleString()}
            /**
             * ★ 副标里的数字也要千位分隔。
             *
             * i18next 的 `{{count}}` 插值**不做**本地化格式化 —— 直接给
             * 数字会渲染成 `12074`，与上面那行 `12,074` 一眼就能看出不一致，
             * 而"同一个数在同一块里写成两种样子"比两处都不分隔更显得随意。
             * 所以传**已经格式化好的字符串**。
             *
             * ★ 占位符叫 `indexed` 而不是 `count`：`count` 是 i18next 的
             * **复数魔法键**，传字符串进去会让复数解析拿到一个非数字。
             */
            hint={t("status.dataPlane.ftsCovered", {
              indexed: data.ftsIndexed.toLocaleString(),
            })}
            warn={data.ftsLag > 0}
          />
        </dl>

        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3">
          <Metric
            label={t("status.dataPlane.conversations")}
            value={data.conversations.toLocaleString()}
          />
          <Metric
            label={t("status.dataPlane.outboxHead")}
            value={data.outboxHead.toLocaleString()}
          />
          <Metric
            label={t("status.dataPlane.probeInterval")}
            value={`${Math.round(data.probeIntervalMs / 1000)}s${data.probeThrottled ? " ↓" : ""}`}
          />
          {data.eventStream !== null && (
            <Metric
              label={t("status.dataPlane.eventStream")}
              value={t(`status.dataPlane.eventStreamState.${data.eventStream.state}`)}
            />
          )}
          <Metric label={t("status.dataPlane.vectors")} value={`${data.storage.vectors} (int8)`} />
          <Metric
            label={t("status.dataPlane.dbSize")}
            value={`${formatBytes(data.storage.mainBytes)} + WAL ${formatBytes(data.storage.walBytes)}`}
          />
          <Metric
            label={t("status.dataPlane.rawRecords")}
            value={`${data.storage.rawRecords.toLocaleString()}${
              data.storage.rawPruned > 0 ? ` (${data.storage.rawPruned} 已裁剪)` : ""
            }`}
          />
        </dl>
      </div>

      {data.lastError !== null && (
        <p className="typography-caption-400 font-mono-token break-all text-[var(--status-error)]">
          {data.lastError}
        </p>
      )}

      {/*
        「接通但零投递」的告警：ready 且从没收到过事件。实测这个账号会稳定
        停在这里（记忆 dws-event-consume-connects-but-delivers-nothing）——
        必须说清"正在靠轮询兜底"，否则用户会以为实时通路在工作。
      */}
      {data.eventStream !== null &&
        data.eventStream.state === "ready" &&
        data.eventStream.delivered === 0 && (
          <p className="typography-caption-400 text-[var(--status-warning)]">
            {t("status.dataPlane.eventStreamIdleHint")}
          </p>
        )}

      {/*
        ★ 订阅**覆盖面**。与上面那条状态分开显示，因为它们答的是两个问题：
        状态 = 通路通不通；覆盖面 = 通了也只覆盖哪些会话。
        钉钉只有「@我」是一个订阅覆盖全部群，单聊/指定群要逐会话订阅 ——
        不写出来的话"实时事件：投递中"会被读成"所有消息都秒级到"。
      */}
      {data.eventStream?.audit != null && data.eventStream.audit.error === null && (
        <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {t("status.dataPlane.eventCoverage", {
            active: data.eventStream.audit.activeSubscriptions,
            global: data.eventStream.audit.globalKeys.length,
            perConversation: data.eventStream.audit.perConversationKeys.length,
          })}
        </p>
      )}
    </section>
  )
}

function BlockedBanner({
  reason,
  label,
  action,
  onDismiss,
}: {
  reason: NonNullable<IngestSnapshot["blockedReason"]>
  label: string
  action: string
  onDismiss: () => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] bg-[var(--status-fill-error-container)] px-3 py-2">
      <p className="typography-body-small-400 text-[var(--status-error)]" data-reason={reason}>
        {label}
      </p>
      <Button size="sm" variant="secondary" onClick={onDismiss}>
        {action}
      </Button>
    </div>
  )
}

/**
 * 主行：这一页真正要回答的那个数。
 *
 * ## ★ 为什么只有一个而不是两个并列
 *
 * 「已采集 12,074」与「已建索引 12,074」在正常状态下**是同一个数** ——
 * 两个大号数字并排显示同一个值，读者会以为自己看错了。
 * 所以主数字只放"采到了多少"，而索引那件事作为它的**副标**出现
 * （"其中 N 条已能被搜到"）—— 那才是它们的真实关系：一个是全集，
 * 一个是它的子集。
 *
 * 落后时（`ftsLag > 0`）副标转成警示色：那时两个数**真的不同**，
 * 而"搜不到刚才那条消息"正是用户会遇到的现象。
 *
 * ## 字号选 18px 而不是 26px
 *
 * 这一页是排查页不是仪表盘。26px（`title-large-600`）是 hero 那一档，
 * 而"每屏只有一个 hero"是它成立的前提 —— 那一档属于仪表盘与蒸馏结果。
 * 18px 对 13px 已经是清晰的两级。
 */
function Lead({
  label,
  value,
  hint,
  warn,
}: {
  label: string
  value: string
  hint: string
  warn: boolean
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="typography-caption-400 text-[var(--text-base-tertiary)]">{label}</dt>
      <dd className="flex flex-col gap-0.5">
        {/* 不加 tabular-nums：大号独立数字用比例字形（等宽会让它发散） */}
        <span className="typography-title-base-600 text-[var(--text-base-primary)]">{value}</span>
        <span
          className={
            warn
              ? "typography-caption-400 text-[var(--status-warning)]"
              : "typography-caption-400 text-[var(--text-base-tertiary)]"
          }
        >
          {hint}
        </span>
      </dd>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="typography-caption-400 text-[var(--text-base-tertiary)]">{label}</dt>
      <dd className="typography-body-small-400 break-all text-[var(--text-base-primary)]">
        {value}
      </dd>
    </div>
  )
}
