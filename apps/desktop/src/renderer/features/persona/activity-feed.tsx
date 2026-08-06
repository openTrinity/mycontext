/**
 * ActivityFeed —— 「处理结果」：分身替我发过的、和我采纳过的那些回复。
 *
 * ## ★ 每一项都能点开看**那一轮的处理过程**
 *
 * 原来这一栏每项只有：标签 + 时间 + 正文前三行，**没有任何点击**。
 * 也就是用户看得到"发了这句话"，却看不到**为什么发的、怎么想出来的**
 * —— 而这恰恰是分身替他说过话之后最需要回答的问题。
 *
 * 现在每项下面有一个「看处理过程」，展开后给两层：
 * · 元信息（触发消息 / 判定与原因 / 耗时 token）—— 回答"为什么会跑、判成什么"；
 * · agent 的 trace（thinking / 正文 / tool）—— 回答"这句话怎么想出来的"。
 *
 * 两者是**两个查询**，都只在展开时才发（见 `RunTraceDisclosure` 与
 * `usePersonaRunDetail` 的 enabled 门控）：一屏 20 条各预取一遍是白花的
 * 库查询，而其中 19 条用户不会展开。
 *
 * ## ★★ 三种状态必须长得不一样
 *
 * ```
 * runId 为 null            → 不给入口（本来就不是 agent 生成的，没有过程可言）
 * 有 runId 但 trace 为空   → 给入口，展开说"这一轮没有留下过程"
 * 有 runId 且有 trace      → 给入口，展开是完整过程
 * ```
 * 中间那种必须能说出来：把它显示成一片空白，就等于让「没有」与
 * 「没加载出来」不可区分。
 *
 * ★★ 但它**不该普遍出现**。曾经"6 轮里 4 轮如此"被归因为"走了直连降级
 * 那条路"—— 那是误判：真实原因是 `appendTrace` 的行主键不带 runId，
 * 重启后新轮次把旧轮次的痕迹整行改嫁走了（已修，见 store 侧那个方法）。
 * 再次普遍出现时先查写入侧，别照抄那个解释。
 */
import { Tag } from "@mycontext/design"
import type { PersonaActivityView } from "@mycontext/ipc-contract"
import { usePersonaRunDetail } from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { explainDecisionReason } from "./decision-reason.js"
import { RunTraceDisclosure } from "./run-trace-disclosure.js"

export interface ActivityFeedProps {
  activities: readonly PersonaActivityView[]
}

function timeLabel(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms))
}

export function ActivityFeed({ activities }: ActivityFeedProps) {
  const { t } = useDynamicTranslation("persona")

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="typography-body-small-400 font-medium text-[var(--text-base-primary)]">
          {t("activityTitle")}
        </h3>
        <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {t("activityDescription")}
        </p>
      </div>

      {activities.length === 0 ? (
        <div className="flex flex-col gap-1 rounded-[var(--radius-md)] border border-dashed border-[var(--border-divider-light)] p-3">
          <p className="typography-body-small-400 text-[var(--text-base-secondary)]">
            {t("activityEmpty")}
          </p>
          <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
            {t("activityEmptyHint")}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {activities.map((activity) => (
            <li
              key={activity.id}
              className="flex flex-col gap-1 border-b border-[var(--border-divider-light)] px-1 py-2 last:border-b-0"
            >
              <div className="flex items-center gap-1.5">
                <Tag size="sm" status={activity.kind === "auto_sent" ? "success" : "accent"}>
                  {t(`activityKinds.${activity.kind}`)}
                </Tag>
                <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
                  {timeLabel(activity.occurredAt)}
                </span>
              </div>
              <p className="typography-body-small-400 line-clamp-3 whitespace-pre-wrap break-words text-[var(--text-base-secondary)]">
                {activity.text}
              </p>
              {/*
                ★ `runId` 为 null 时整块不渲染 —— 那是"用户自己写的"或
                升级前的旧记录，本来就没有过程。给一个点了只会说
                "没有过程"的按钮，等于让用户白点一次才知道这里没东西。
              */}
              {activity.runId === null ? null : (
                <RunTraceDisclosure
                  runId={activity.runId}
                  header={<RunMeta runId={activity.runId} />}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * 那一轮的元信息：触发消息 / 判定与原因 / 耗时 token。
 *
 * ## ★ 为什么它是 `RunTraceDisclosure` 的 `header` 而不是自己一块
 *
 * 它与 trace 回答的是同一个问题的两半（为什么跑 / 怎么想的），
 * 分成两个可展开块会让用户点两次才看全一件事。
 *
 * ★ 放在 header 位置还有一个实际作用：本组件**只在展开时才挂载** ——
 * 也就是那次 `usePersonaRunDetail` 只在用户真的要看时才发出去。
 */
function RunMeta({ runId }: { runId: string }) {
  const { t } = useDynamicTranslation("persona")
  // 挂载即查（本组件只在展开时被挂载，见上面的注释）
  const detail = usePersonaRunDetail(runId, true)

  if (detail.isPending) return null
  const data = detail.data
  if (data === null || data === undefined) {
    /**
     * 查不到那一轮（老库 / 已被保留策略清掉）—— 明说，而不是不显示。
     * 不显示会让人以为"这条就是没有元信息"，而事实是"记录没了"。
     */
    return (
      <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
        {t("runDetailMissing")}
      </span>
    )
  }

  /**
   * ★ 判定原因复用 `explainDecisionReason` —— 不在这里另写一份映射。
   *
   * 同一个 reason 在运行日志与这里必须是**同一句话**，否则用户会以为
   * 是两回事。而那个函数用 `Record<DecisionReason, …>`，policy 加一条
   * 新 reason 时不补就编译不过。
   */
  const explained = explainDecisionReason(data.decisionReason)
  const trigger = data.trigger

  return (
    <dl className="flex flex-col gap-0.5 radius-sm bg-[var(--bg-card-z0)] px-2 py-1.5">
      {trigger === null ? null : (
        <MetaRow
          label={t("runDetailTrigger")}
          value={`${trigger.senderDisplayName ?? "—"}：${trigger.contentText ?? ""}`}
        />
      )}
      <MetaRow
        label={t("runDetailDecision")}
        value={explained === null ? data.decision : `${data.decision} · ${t(explained.labelKey)}`}
      />
      {/*
        耗时与 token 都可空（老记录 / 直连降级那条路不记）—— 两个都没有
        就整行不渲染，而不是显示 "耗时 —s · — tokens" 那种噪音。
      */}
      {data.latencyMs === null && data.costTokens === null ? null : (
        <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {t("runDetailCost", {
            seconds: ((data.latencyMs ?? 0) / 1000).toFixed(1),
            tokens: data.costTokens ?? 0,
          })}
        </span>
      )}
    </dl>
  )
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="typography-caption-400 flex gap-1.5">
      <dt className="shrink-0 text-[var(--text-base-tertiary)]">{label}</dt>
      <dd className="min-w-0 truncate text-[var(--text-base-secondary)]">{value}</dd>
    </div>
  )
}
