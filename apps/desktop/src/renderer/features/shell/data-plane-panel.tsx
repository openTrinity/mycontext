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
import { Button } from "@mycontext/design"
import type { IngestSnapshot } from "@mycontext/ipc-contract"
import { SelfIdentityPanel } from "../settings/self-identity-panel.js"
import {
  useClearIngestBlocked,
  useIngestProgress,
  useIngestSnapshot,
  useRunIngestOnce,
} from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

export function DataPlanePanel({ enabled }: { enabled: boolean }) {
  const { t } = useDynamicTranslation("settings")
  const snapshot = useIngestSnapshot(enabled)
  const runOnce = useRunIngestOnce()
  const clearBlocked = useClearIngestBlocked()
  // 订阅主进程推来的快照：入库后立刻更新，不轮询
  useIngestProgress()

  const data = snapshot.data
  if (data === undefined) return null

  return (
    <section className="flex flex-col gap-[var(--gap-section-sm)]">
      <div className="flex items-center justify-between gap-3">
        <h2 className="typography-title-small-500 text-[var(--text-base-primary)]">
          {t("status.sections.dataPlane")}
        </h2>
        <Button
          size="sm"
          variant="secondary"
          disabled={!data.running || runOnce.isPending}
          onClick={() => runOnce.mutate()}
        >
          {t("status.dataPlane.syncNow")}
        </Button>
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

      {data.unjudged > 0 && (
        <p className="typography-body-small-400 text-[var(--text-base-tertiary)]">
          {t("status.dataPlane.unjudgedHint", { count: data.unjudged })}
        </p>
      )}

      {/*
        ★ 身份确认入口。
        未确认时蒸馏会拒掉**全部**语料且不报错 —— 这是那类失效的唯一出口，
        所以放在状态页最显眼的位置（就在"未判定 N 条"那行下面）。
      */}
      <SelfIdentityPanel confirmed={data.selfConfirmed} unjudged={data.unjudged} />

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
        ★★ 逐渠道的采集数字 —— 上面那一份**只是其中一个渠道**。

        顶层快照来自 `snapshotIngest()`，它挑**一个**渠道返回（主渠道活跃就
        只返回主渠道）。于是另一个渠道采集彻底停了、blocked 了、或一条都没采到，
        界面上完全看不出来：显示的数字看起来很正常，只是它不是那个渠道的。

        ★ 只在真有多个渠道时渲染（单渠道时与上面说的是同一件事）。
      */}
      {(data.perChannel ?? []).length > 1 && (
        <div className="flex flex-col gap-1">
          {(data.perChannel ?? []).map((row) => (
            <div key={row.channelId} className="flex flex-wrap items-center gap-2">
              <span className="typography-caption-400 min-w-16 text-[var(--text-base-tertiary)]">
                {t(`status.dataPlane.channel.${row.channelId}`, { defaultValue: row.channelId })}
              </span>
              <span
                className={`typography-caption-400 ${
                  row.running ? "text-[var(--status-success)]" : "text-[var(--text-base-tertiary)]"
                }`}
              >
                {t(row.running ? "status.dataPlane.running" : "status.dataPlane.idle")}
              </span>
              <span className="typography-caption-400 font-mono-token text-[var(--text-base-tertiary)]">
                {t("status.dataPlane.messages")} {row.messages.toLocaleString()} ·{" "}
                {t("status.dataPlane.conversations")} {row.conversations.toLocaleString()}
              </span>
              {/* ★ blocked / lastError 逐渠道给 —— 顶层那份只是一个渠道的 */}
              {row.blockedReason !== null && (
                <span className="typography-caption-400 text-[var(--status-warning)]">
                  {t(`status.dataPlane.blocked.${row.blockedReason}`, {
                    defaultValue: row.blockedReason,
                  })}
                </span>
              )}
              {row.lastError !== null && (
                <span className="typography-caption-400 break-all text-[var(--status-error)]">
                  {row.lastError}
                </span>
              )}
            </div>
          ))}
        </div>
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
