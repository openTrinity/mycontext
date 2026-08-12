/**
 * 数字人的运行参数 + 自动发送闸门（工作时间 + 频率上限）。
 *
 * ## 为什么这些要有 UI
 *
 * 它们原来是代码里的常量（`MAX_RESIDENT_AGENTS = 8` 等）。而它们的
 * 合适取值**依赖这台机器与这个账号** —— 86 个会话的重度用户与 5 个会话的
 * 轻度用户需要的常驻数完全不同，而"改并发"通常正是因为**现在**在被限流。
 *
 * ## ★ 白名单已删
 *
 * 曾经这里有一块"自动发送白名单"——用户把某个会话设成 auto 之后，还要
 * 在这份清单里再勾一次才真发。那道门删了（见 policy.ts 文件头）：选了
 * 「自动」本身就是授权。所以这一页现在只剩**运行时闸**：工作时间
 * （"这会儿别发"）与频率上限（"别连发"）—— 它们和"哪个会话自动发"
 * （在会话设置里逐个选）是正交的两件事。
 */
import { Disclosure, cn } from "@mycontext/design"
import type { PersonaRuntimeLimits } from "@mycontext/ipc-contract"
import { usePersonaLimits, useSavePersonaLimits } from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { WorkHoursEditor } from "./work-hours-editor.js"

/**
 * 数值型参数（有档位可选）的可选值。
 *
 * 用**离线的几档**而不是数字输入框：这些值没有"精确调优"的意义
 * （8 与 9 个常驻 agent 没有可感知的差别），而输入框会让用户去想
 * "填几合适"。给档位就是给建议。
 *
 * ★ 类型只覆盖数值字段 —— `workHours` 由单独的 `WorkHoursEditor` 处理。
 */
type NumericLimitKey =
  | "maxResident"
  | "maxConcurrentTurns"
  | "maxBatchSize"
  | "idleEvictMinutes"
  | "maxDraftsPerConversation"

const OPTIONS: Record<NumericLimitKey, readonly number[]> = {
  maxResident: [4, 8, 16, 32],
  maxConcurrentTurns: [1, 2, 3, 5, 8],
  maxBatchSize: [10, 30, 60, 120],
  idleEvictMinutes: [5, 10, 30, 60],
  maxDraftsPerConversation: [1, 3, 5, 10],
}

export interface PersonaRuntimePanelProps {
  /**
   * 这些参数存到**哪个渠道**名下（用户要求：分身设置按渠道拆）。
   *
   * ★ 由设置页传当前选中的渠道，而不是这里自己去查"主渠道是谁" ——
   * 那会造出第二份判据，而设置页头上那枚 picker 才是用户看到的真源。
   * 不传 = 旧的全局那一份（存量调用点行为不变）。
   */
  channelId?: string | undefined
}

export function PersonaRuntimePanel({ channelId }: PersonaRuntimePanelProps = {}) {
  const { t } = useDynamicTranslation("settings")
  const limits = usePersonaLimits(true, channelId)
  const saveLimits = useSavePersonaLimits()

  const current = limits.data

  /**
   * 收起时也能看到的工作时间摘要。
   *
   * ★ 这一行存在的理由：`outside_work_hours` 是挡住自动发送最频繁的一条，
   * 而用户从草稿卡上「不在你设定的工作时间内」跳过来，第一件想确认的事
   * 就是"到底设的是几点"。为看一个数字去展开一个分区是多余的一步。
   */
  const hoursSummary =
    current === undefined
      ? undefined
      : t("persona.workHours.summary", {
          days: current.workHours.days
            .slice()
            .sort((a, b) => a - b)
            .map((d) => t(`persona.workHours.day.${String(d)}`))
            .join("、"),
          from: current.workHours.startHour,
          to: current.workHours.endHour,
        })

  return (
    <div className="flex flex-col gap-[var(--gap-component-md)]">
      {/*
        ★ 分区顺序 = 用户来这一页的频率，不是概念上的从属关系。
        「自动发送」（工作时间 + 频率上限）是唯一有不可逆后果、也是唯一
        会被反复来改的一块，所以它默认展开、排最前。运行参数（常驻数、
        并发）改一次就再也不动，收起。
      */}
      <Disclosure
        title={t("persona.autoSendTitle")}
        hint={t("persona.autoSendHint")}
        summary={hoursSummary}
        defaultOpen
      >
        {current === undefined ? (
          <p className="typography-body-small-400 text-[var(--text-base-tertiary)]">
            {t("persona.loading")}
          </p>
        ) : (
          <div className="flex flex-col gap-[var(--gap-section-sm)]">
            {/*
              ★ 工作时间是自动发送的一道运行时闸（另一道是频率）。会话是否
              自动发由它自己的「回复方式=自动」决定（在会话设置里逐个选）；
              工作时间只回答"这会儿能不能发"。它默认"周一到周五 9-19 点"、
              之前没有 UI 入口，于是"点了自动却没自动发"的一大类原因是
              outside_work_hours —— 而用户看到`不在你设定的工作时间`会以为
              自己设过、其实从来没有。
            */}
            <WorkHoursEditor
              value={current.workHours}
              busy={saveLimits.isPending}
              onChange={(workHours) => saveLimits.mutate({ workHours, ...(channelId === undefined ? {} : { channelId }) })}
            />

            {/*
              ★ 频率上限：防"数字人在一个群里连发"。它只拦自动发送
              （手动点发送不受影响），超了就把这一轮降级成草稿。
              过去它藏在一个没有 UI 的独立键里，而草稿卡上「短时间发太多，
              去改频率上限」指向的就是这里 —— 现在那句话才名副其实。

              窗口固定（单会话按分钟、全局按小时），只让用户调**条数** ——
              两个维度（几条 + 多久）一起放开会让人不知道填什么，而实际
              想调的几乎总是"松一点/紧一点"，也就是条数。`0 = 不限`
              （见 policy 的 withinRateLimit 对 0 短路）。
            */}
            <RateLimitRows
              value={current.rateLimit}
              busy={saveLimits.isPending}
              onChange={(rateLimit) => saveLimits.mutate({ rateLimit, ...(channelId === undefined ? {} : { channelId }) })}
            />
          </div>
        )}
      </Disclosure>

      <Disclosure
        title={t("persona.limitsTitle")}
        hint={t("persona.limitsDescription")}
        summary={
          current === undefined
            ? undefined
            : t("persona.limitsSummary", {
                resident: current.maxResident,
                concurrent: current.maxConcurrentTurns,
              })
        }
      >
        {current === undefined ? (
          <p className="typography-body-small-400 text-[var(--text-base-tertiary)]">
            {t("persona.loading")}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {(Object.keys(OPTIONS) as NumericLimitKey[]).map((key) => (
              <LimitRow
                key={key}
                label={t(`persona.limits.${key}`)}
                hint={t(`persona.limitHints.${key}`)}
                value={current[key]}
                options={OPTIONS[key]}
                busy={saveLimits.isPending}
                onChange={(next) => saveLimits.mutate({ [key]: next, ...(channelId === undefined ? {} : { channelId }) })}
              />
            ))}
          </div>
        )}
      </Disclosure>
    </div>
  )
}

/** 一行参数：标签 + 一排档位。 */
/**
 * 频率上限的两行（单会话 / 全局），窗口固定、只调条数。
 *
 * ★ 复用 `LimitRow` 的离散 chip —— 与运行参数那几行同一个交互。
 * `0` 那一档显示成「不限」（`format`），落库就是 0，policy 对 0 短路。
 * 窗口不暴露给用户改：单会话恒 1 分钟、全局恒 1 小时（默认值里的窗口），
 * 用户改的时候把它原样带回去，只覆盖条数。
 */
function RateLimitRows({
  value,
  busy,
  onChange,
}: {
  value: PersonaRuntimeLimits["rateLimit"]
  busy: boolean
  onChange: (next: PersonaRuntimeLimits["rateLimit"]) => void
}) {
  const { t } = useDynamicTranslation("settings")
  const fmt = (n: number): string => (n === 0 ? t("persona.rateLimit.off") : String(n))
  return (
    <div className="flex flex-col gap-2 border-t border-[var(--border-divider-light)] pt-3">
      <span className="typography-body-small-400 text-[var(--text-base-primary)]">
        {t("persona.rateLimit.title")}
      </span>
      <LimitRow
        label={t("persona.rateLimit.perConversation")}
        hint={t("persona.rateLimit.perConversationHint")}
        value={value.perConversation}
        options={[0, 3, 5, 10, 20]}
        busy={busy}
        format={fmt}
        onChange={(perConversation) => onChange({ ...value, perConversation })}
      />
      <LimitRow
        label={t("persona.rateLimit.global")}
        hint={t("persona.rateLimit.globalHint")}
        value={value.global}
        options={[0, 50, 100, 200, 500]}
        busy={busy}
        format={fmt}
        onChange={(global) => onChange({ ...value, global })}
      />
    </div>
  )
}

/**
 * 一行「标签 + 说明 + 离散档位 chip」。
 *
 * 导出给采集周期面板复用（`ingest-intervals-panel`）：那边的档位是毫秒，
 * 显示要换算成 `10s`/`2min`，所以留一个 `format` 钩子 —— 缺省显示原值。
 * 不给自由输入是刻意的：一个手填的 `0` 会让轮询/调度永远不动。
 */
export function LimitRow({
  label,
  hint,
  value,
  options,
  busy,
  onChange,
  format,
}: {
  label: string
  hint: string
  value: number
  options: readonly number[]
  busy: boolean
  onChange: (next: number) => void
  /** 档位的显示文案。不给时显示原始数字。 */
  format?: (value: number) => string
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="flex min-w-0 flex-col">
        <span className="typography-body-small-400 text-[var(--text-base-primary)]">{label}</span>
        <span className="typography-caption-400 text-[var(--text-base-tertiary)]">{hint}</span>
      </span>
      <span className="flex shrink-0 gap-1">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            disabled={busy}
            aria-pressed={option === value}
            onClick={() => onChange(option)}
            className={cn(
              "typography-caption-400 min-w-7 rounded-[var(--radius-sm)] px-1.5 py-0.5 transition-colors duration-150",
              option === value
                ? "bg-[var(--overlay-on-container-selected)] text-[var(--text-base-primary)]"
                : "text-[var(--text-base-secondary)] hover:bg-[var(--overlay-on-container-hover)]",
              busy ? "cursor-not-allowed opacity-60" : "",
            )}
          >
            {format === undefined ? option : format(option)}
          </button>
        ))}
      </span>
    </div>
  )
}
