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
type ProducerStatusView = IngestSnapshot["producers"][number]

/**
 * 一个消费者当前**最该说的那一句**。
 *
 * ★ 顺序即优先级，而且刻意让"结构性问题"压过"落后多少"：
 * 一个 `absent` 的消费者报"落后 8000 条"是误导（它压根不该追）。
 *
 * ★★ `unwired` 排在**最前面**：它是"这套代码没接这个消费者"（产品决定），
 * 比 `absent`（这套部署没起它）更根本 —— 一个没接线的消费者当然也没注册，
 * 所以两个条件同时成立，而先报 `absent` 会让用户去找"为什么那个服务没起来"，
 * 而那个服务从来就不存在。
 */
function consumerState(
  consumer: ConsumerStatusView,
): "unwired" | "absent" | "rebuild" | "stale" | "waiting" | "lagging" | "ok" {
  if (consumer.wiring === "unwired") return "unwired"
  if (consumer.absent) return "absent"
  // 需要全量重建 = 历史已被裁剪，增量补不回来 —— 比 stale 更严重
  if (consumer.needsFullRebuild) return "rebuild"
  if (consumer.stale) return "stale"
  if (consumer.waitingForUpstream !== null) return "waiting"
  if (consumer.lag > 0) return "lagging"
  return "ok"
}

/** 状态 → 颜色。★ `waiting` 与 `unwired` 都是**中性**的：都不是故障。 */
const STATE_TONE: Record<ReturnType<typeof consumerState>, string> = {
  unwired: "text-[var(--text-base-tertiary)]",
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
  producers = [],
}: {
  consumers: readonly ConsumerStatusView[]
  domains: readonly DomainStatusView[]
  /**
   * 生产者的运行时（修 G16）。缺省空数组 —— 既有调用方不传它时
   * 那一块整个不渲染，而不是崩。
   */
  producers?: readonly ProducerStatusView[]
}) {
  const { t } = useDynamicTranslation("settings")

  /**
   * 未登录时 `consumers` 是空数组（"还没有库，这个问题现在没有答案"），
   * 而 `domains` 仍是全量声明。两者分别判空 —— 合起来判会让未登录时
   * 连"我们支持哪些域"都不显示。
   */
  if (consumers.length === 0 && domains.length === 0 && producers.length === 0) return null

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

      {/*
        ── ★★★ 生产者那一段（修 G16）─────────────────────────────────

        ## 为什么它必须在消费者**之前**

        数据是从生产者流向消费者的，而排查也是这个方向：「图谱落后」的
        第一个问题是"有数据进来吗"。把生产者放在下面会让人先看到一堆
        消费者 lag，而真因可能是某个域压根没在采（范围没就绪）。

        ## 这一块回答三件原来读不出来的事
        （见 `IngestSnapshot.producers` 的注释）

        · **谁丢的** —— 原来 chat 与 doc 累加进同一对全局字段；
        · **范围就绪了吗** —— `scopeNotReady` 原来完全不可见；
        · **上一轮抽干了吗** —— 原来要从三个地方拼。
      */}
      {producers.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {producers.map((producer) => (
            <ProducerRow key={producer.id} producer={producer} />
          ))}
        </div>
      )}

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

/**
 * 一个生产者一行 —— **最该说的那一句**，而不是一堆数字。
 *
 * ## ★★★ 顺序即优先级，且刻意让"结构性问题"压过"丢了多少"
 *
 * 与 `ConsumerRow` 同一条判据：一个"这个渠道没有这个域"的生产者报
 * "丢了 0 条"是误导（它压根不该采）。所以判据的顺序是：
 *
 * ① 渠道没这个能力 → 说"这个渠道没有…"（出路：去连另一个渠道）；
 * ② 范围读不出来（坏 JSON）→ 说"重存一次范围"（用户自己能修）；
 * ③ 范围让它一条都不采 → 说"还没选要学什么"（出路：去改勾选）；
 * ④ 丢过东西 → 说丢了多少（★ 按域，这是 G16 的实质）；
 * ⑤ 上一轮没抽干 → 说"还没翻完"；
 * ⑥ 都正常 → 说它在干什么。
 *
 * ★ 每一档的**出路都不同** —— 那正是这一块存在的理由。合成一句
 * "生产者异常"会让用户无从下手。
 */
function ProducerRow({ producer }: { producer: ProducerStatusView }) {
  const { t } = useDynamicTranslation("settings")

  const detail = !producer.supportedByChannel
    ? /**
       * ★★ 与"范围没就绪"必须分开：前者的出路是"去连另一个渠道"，
       * 后者是"去改范围"。合成一个会让用户对着范围设置反复调，
       * 而问题在别处（修 G17 的界面那一半）。
       */
      t("status.topology.producer.unsupported", {
        defaultValue: "当前渠道没有这类数据",
      })
    : producer.scopeUnreadable
      ? /**
         * ★★★ 这一档用户**自己能修**（在设置页重存一次范围），
         * 所以必须与"没配过"分开说 —— 而它们现在都表现为"不采"。
         */
        t("status.topology.producer.unreadable", {
          defaultValue: "范围读不出来 —— 在设置里重存一次该数据源的范围即可恢复",
        })
      : !producer.scopeReady
        ? t("status.topology.producer.notReady", {
            defaultValue: "范围里一条都不许采 —— 去学习范围勾选要学的内容",
          })
        : producer.droppedOutOfScope > 0
          ? /**
             * ★★★ 这是 G16 的实质：**按域**的丢弃数。
             *
             * 原来 chat 与 doc 累加进同一对全局字段，于是
             * 「文档挡掉 300 篇」与「聊天挡掉 300 条」是同一个数字 ——
             * 而前者去改空间白名单、后者去改会话勾选。
             *
             * ★ `droppedUnknownTime` 单独说：「超出你选的日期」与
             * 「这条数据渠道没给时间」是两个事实，出路也不同
             * （后者要去看渠道解析）。
             */
            producer.droppedUnknownTime > 0
            ? t("status.topology.producer.droppedWithUnknown", {
                defaultValue: "范围外丢弃 {{dropped}}（其中 {{unknown}} 条渠道没给时间）",
                dropped: producer.droppedOutOfScope.toLocaleString(),
                unknown: producer.droppedUnknownTime.toLocaleString(),
              })
            : t("status.topology.producer.dropped", {
                defaultValue: "范围外丢弃 {{dropped}}",
                dropped: producer.droppedOutOfScope.toLocaleString(),
              })
          : producer.drained === false
            ? /**
               * ★ 只在**明确没抽干**时说（`false`）。`null` 表示这个调度
               * 压根没有"抽干"概念（watermark / stream）—— 那时说
               * "还没翻完"是一句对聊天永远成立的废话。
               */
              t("status.topology.producer.notDrained", {
                defaultValue: "上一轮没翻完（条数是下界）",
              })
            : producer.purpose

  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="typography-caption-400 text-[var(--text-base-secondary)]">
        {producer.id}
      </span>
      <span className="typography-caption-400 truncate text-[var(--text-base-tertiary)]">
        {detail}
      </span>
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
    state === "unwired"
      ? /**
         * ★★★ 说清**为什么没接**，而不是"未启用"。
         *
         * 「未启用」读起来像"去设置里打开它"，而这里根本没有那个开关 ——
         * `unwiredReason` 才是用户需要的那句话（如"向量检索要远程
         * embedding，本期不默认开启"）。与域的 `absentReason` 同一条判据。
         */
        (consumer.unwiredReason ?? t("status.topology.unwired", { defaultValue: "本期未接入" }))
      : state === "absent"
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
        {/*
          ★★ `required` 决定"落后了要不要紧"：true = 历史不能裁（丢了补不回来）。
          只在落后/等待时显示 —— 追平时它是一句废话，而 absent / unwired 时
          它是**误导**（一个没接线的消费者"不可裁剪"读起来像个待办，
          而实际它不注册游标、压根不参与裁剪判据）。
        */}
        {consumer.required && state !== "ok" && state !== "absent" && state !== "unwired" && (
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
