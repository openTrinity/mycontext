/**
 * 数据平面**拓扑**面板 —— 谁在生产、谁在消费、谁落后、谁在等谁。
 *
 * ## ★★★ 为什么必须有这一块（它替换的那行文案说不出任何有用的话）
 *
 * 改动前状态页对消费者只有一行：
 *
 * ```
 * 离线消费者：distill, graph-export
 * ```
 *
 * 三件事读不出来，而它们的出路完全不同：
 *
 * · **落后多少** —— `distill` 落后 8 条与落后 80000 条是两种状况；
 * · **在等谁** —— `distill` 被 `graph-export` 夹住（依赖闸）时，它与
 *   "蒸馏卡住了"在数字上完全同形（lag 都在涨、processed 都是 0），
 *   但前者要去看图谱为什么慢，后者要去看蒸馏本身；
 * · **存不存在** —— `graph-export` 由 kl 服务侧推进，没起服务时它压根
 *   不注册。那时它既不 stale 也没有 lag，"追平了"与"不存在"同形。
 *
 * ## ★★ 为什么显示 `required`
 *
 * 它决定用户**该不该着急**：`required: true` 的消费者落后时**历史不能裁**
 * （丢了补不回来，如蒸馏语料）；`false` 的可以裁（三天前没回的消息现在回
 * 也没意义）。同样的 "落后 8000 条"，一个是待办、一个是无所谓。
 *
 * ## ★ 域那一列为什么要显示 `absent`
 *
 * `contact` 域在声明里存在，但**没有生产者**（通讯录属 PII，相关渠道命令
 * 不在白名单内）。不区分的话界面会显示"通讯录 0 条" —— 读起来像坏了，
 * 而事实是我们不采。「没做」与「做了没数据」必须能区分。
 *
 * ## 这里**不画进度条**
 *
 * 与覆盖面同一条理由：`lag` 有分子没分母（"还要多久追上"取决于消费速度，
 * 而那是变量）。给两个诚实的数字（已确认到 seq N，落后 M 条）比给一个
 * 编出来的百分比有用。
 */
import type { IngestSnapshot } from "@mycontext/ipc-contract"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

type ConsumerStatusView = IngestSnapshot["consumers"][number]
type DomainStatusView = IngestSnapshot["domains"][number]

/**
 * 一个消费者当前**最该说的那一句**。
 *
 * ★ 顺序即优先级，而且刻意让"结构性问题"压过"落后多少"：
 * 一个 `absent` 的消费者报"落后 8000 条"是误导（它压根不该追）。
 */
function consumerState(
  consumer: ConsumerStatusView,
): "absent" | "rebuild" | "stale" | "waiting" | "lagging" | "ok" {
  if (consumer.absent) return "absent"
  // 需要全量重建 = 历史已被裁剪，增量补不回来 —— 比 stale 更严重
  if (consumer.needsFullRebuild) return "rebuild"
  if (consumer.stale) return "stale"
  if (consumer.waitingForUpstream !== null) return "waiting"
  if (consumer.lag > 0) return "lagging"
  return "ok"
}

/** 状态 → 颜色。★ `waiting` 是**中性**的：按依赖顺序干活不是故障。 */
const STATE_TONE: Record<ReturnType<typeof consumerState>, string> = {
  absent: "text-[var(--text-base-tertiary)]",
  rebuild: "text-[var(--status-error)]",
  stale: "text-[var(--status-warning)]",
  waiting: "text-[var(--text-base-secondary)]",
  lagging: "text-[var(--status-warning)]",
  ok: "text-[var(--status-success)]",
}

export function DataPlaneTopologyPanel({
  consumers,
  domains,
}: {
  consumers: readonly ConsumerStatusView[]
  domains: readonly DomainStatusView[]
}) {
  const { t } = useDynamicTranslation("settings")

  /**
   * 未登录时 `consumers` 是空数组（"还没有库，这个问题现在没有答案"），
   * 而 `domains` 仍是全量声明。两者分别判空 —— 合起来判会让未登录时
   * 连"我们支持哪些域"都不显示。
   */
  if (consumers.length === 0 && domains.length === 0) return null

  return (
    <div className="flex flex-col gap-3 border-t border-[var(--border-divider-light)] pt-3">
      <div className="flex items-baseline gap-2">
        {/*
          ★ 用 `typography-title-small-500` 而不是 `body-small-500`：
          后者**不在**排版表里（`check:typography` 抓到了）—— 那种 className
          不生成任何样式，文字会静默退回浏览器默认字号且不报错。
          这一块是卡内的小标题，与状态页其余 section 标题同档。
        */}
        <p className="typography-title-small-500 text-[var(--text-base-primary)]">
          {t("status.topology.title", { defaultValue: "数据平面" })}
        </p>
        <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {t("status.topology.subtitle", {
            defaultValue: "生产者投变更、消费者按依赖序消费",
          })}
        </span>
      </div>

      {consumers.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {consumers.map((consumer) => (
            <ConsumerRow key={consumer.id} consumer={consumer} />
          ))}
        </div>
      )}

      {domains.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {domains.map((domain) => (
            <DomainChip key={domain.id} domain={domain} />
          ))}
        </div>
      )}
    </div>
  )
}

function ConsumerRow({ consumer }: { consumer: ConsumerStatusView }) {
  const { t } = useDynamicTranslation("settings")
  const state = consumerState(consumer)

  /**
   * 右侧那句话。★ 每种状态说**不同的**话，而不是统一说"落后 N 条" ——
   * 那是这一整块存在的理由（见文件头）。
   */
  const detail =
    state === "absent"
      ? t("status.topology.absent", { defaultValue: "未注册（这套部署里没有它）" })
      : state === "rebuild"
        ? t("status.topology.rebuild", { defaultValue: "需要全量重建（历史已裁剪）" })
        : state === "waiting"
          ? t("status.topology.waiting", {
              defaultValue: "在等 {{upstream}}",
              upstream: consumer.waitingForUpstream ?? "",
            })
          : state === "ok"
            ? t("status.topology.caughtUp", { defaultValue: "已追平" })
            : t("status.topology.lag", { defaultValue: "落后 {{lag}} 条", lag: consumer.lag })

  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="typography-body-small-400 shrink-0 text-[var(--text-base-primary)]">
          {consumer.id}
        </span>
        {/* ★ purpose 来自声明（`ConsumerSpec.purpose`）——界面不再自己编文案 */}
        <span className="typography-caption-400 truncate text-[var(--text-base-tertiary)]">
          {consumer.purpose}
        </span>
      </div>
      <div className="flex shrink-0 items-baseline gap-2">
        {/*
          ★★ `required` 决定"落后了要不要紧"：true = 历史不能裁（丢了补不回来）。
          只在落后/等待时显示 —— 追平时它是一句废话。
        */}
        {consumer.required && state !== "ok" && state !== "absent" && (
          <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
            {t("status.topology.required", { defaultValue: "不可裁剪" })}
          </span>
        )}
        <span className={`typography-caption-400 ${STATE_TONE[state]}`}>{detail}</span>
      </div>
    </div>
  )
}

function DomainChip({ domain }: { domain: DomainStatusView }) {
  const { t } = useDynamicTranslation("settings")
  const absent = domain.producedBy === "absent"
  return (
    <span className="typography-caption-400 flex items-baseline gap-1">
      <span
        className={
          absent ? "text-[var(--text-base-tertiary)]" : "text-[var(--text-base-secondary)]"
        }
      >
        {domain.id}
      </span>
      {/*
        ★★★ `absent` 说清**为什么没有**，而不是显示一个 0。
        显示 0 会让"我们不采通讯录"看起来像"通讯录采失败了"。
      */}
      <span className="text-[var(--text-base-tertiary)]">
        {absent
          ? (domain.absentReason ?? t("status.topology.noProducer", { defaultValue: "无生产者" }))
          : t("status.topology.head", { defaultValue: "水位 {{head}}", head: domain.head })}
      </span>
    </span>
  )
}
