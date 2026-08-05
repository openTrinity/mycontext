/**
 * 工作时间选择器 —— 数字分身**只在这个窗口内允许自动发送**。
 *
 * ## 为什么单独抽一个组件
 *
 * 设置面板与 onboarding 都要挂一份，两份实现分开落几乎必然漂：一处能勾
 * 周末、另一处不能；一处 0-24、另一处 0-23。UI 上看起来是"两个东西"，
 * 而实际上后端只有一份 `workHours` 存储 —— 让它们对上是这个组件存在的理由。
 *
 * ## 判据
 *
 * · `days` 是**多选**（0=周日 … 6=周六，与 `Date.getDay()` 同源）；
 * · `startHour < endHour` 是硬约束 —— 反着填 `withinWorkHours` 恒 false，
 *   表现是"改完时间就再也不发了"。所以本地校验挡住这条组合并**不 emit**
 *   变更，与后端 `limitsSave` 的判据同源（两处都判是刻意的：UI 早报告，
 *   后端做最后一道保险）。
 * · `endHour === 24` **允许**（"到当天结束"）：`withinWorkHours` 用
 *   `hour < endHour`，只到 23 会让 23:00-23:59 永远发不出去。
 */
import { cn } from "@mycontext/design"
import type { PersonaRuntimeLimits } from "@mycontext/ipc-contract"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

type WorkHours = PersonaRuntimeLimits["workHours"]

/** 与 `Date.getDay()` 同源：0=周日、6=周六。 */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const

export function WorkHoursEditor({
  value,
  busy,
  onChange,
}: {
  value: WorkHours
  busy: boolean
  onChange: (next: WorkHours) => void
}) {
  const { t } = useDynamicTranslation("settings")
  const daySet = new Set(value.days)
  /**
   * 反着填的组合不 emit —— 见文件头。UI 上按钮组会阻止：`endHour <= startHour`
   * 的按钮设为 disabled，且换 `startHour` 时如果 `endHour` 变得不合法就一并推大。
   */
  const setStart = (next: number) => {
    if (next === value.startHour) return
    const nextEnd = value.endHour <= next ? Math.min(24, next + 1) : value.endHour
    onChange({ ...value, startHour: next, endHour: nextEnd })
  }
  const setEnd = (next: number) => {
    if (next === value.endHour || next <= value.startHour) return
    onChange({ ...value, endHour: next })
  }
  const toggleDay = (day: number) => {
    const nextDays = daySet.has(day) ? value.days.filter((d) => d !== day) : [...value.days, day]
    // 至少一天 —— 全去掉等于关掉自动发送，那用 killSwitch 表达更清楚
    if (nextDays.length === 0) return
    onChange({ ...value, days: [...new Set(nextDays)].sort((a, b) => a - b) })
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="flex flex-col">
        <span className="typography-body-small-400 text-[var(--text-base-primary)]">
          {t("persona.workHours.label")}
        </span>
        <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {t("persona.workHours.hint")}
        </span>
      </span>

      {/* 周日子多选 —— 星期一在前，与国内周历约定一致 */}
      <div className="flex flex-wrap gap-1">
        {DAY_ORDER.map((day) => (
          <button
            key={day}
            type="button"
            disabled={busy}
            aria-pressed={daySet.has(day)}
            onClick={() => toggleDay(day)}
            className={cn(
              "typography-caption-400 min-w-9 rounded-[var(--radius-sm)] px-2 py-0.5 transition-colors duration-150",
              daySet.has(day)
                ? "bg-[var(--overlay-on-container-selected)] text-[var(--text-base-primary)]"
                : "text-[var(--text-base-secondary)] hover:bg-[var(--overlay-on-container-hover)]",
              busy ? "cursor-not-allowed opacity-60" : "",
            )}
          >
            {t(`persona.workHours.day.${day}`)}
          </button>
        ))}
      </div>

      {/* 起止小时 —— 两个 native select 简单可靠，不为一个每人一次的操作造轮子 */}
      <div className="flex items-center gap-2">
        <span className="typography-caption-400 text-[var(--text-base-secondary)]">
          {t("persona.workHours.from")}
        </span>
        <HourSelect value={value.startHour} min={0} max={23} disabled={busy} onChange={setStart} />
        <span className="typography-caption-400 text-[var(--text-base-secondary)]">
          {t("persona.workHours.to")}
        </span>
        <HourSelect
          value={value.endHour}
          min={value.startHour + 1}
          max={24}
          disabled={busy}
          onChange={setEnd}
        />
      </div>
    </div>
  )
}

function HourSelect({
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  value: number
  min: number
  max: number
  disabled: boolean
  onChange: (next: number) => void
}) {
  const options: number[] = []
  for (let h = min; h <= max; h += 1) options.push(h)
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(Number(event.target.value))}
      className={cn(
        "typography-caption-400 rounded-[var(--radius-sm)] border border-[var(--border-divider-light)] bg-[var(--bg-card-z1)] px-2 py-0.5 text-[var(--text-base-primary)]",
        disabled ? "cursor-not-allowed opacity-60" : "",
      )}
    >
      {options.map((h) => (
        <option key={h} value={h}>
          {formatHour(h)}
        </option>
      ))}
    </select>
  )
}

function formatHour(h: number): string {
  // `24:00` 是"到当天结束"的常见写法。0-9 补 0 让下拉里对齐。
  const pad = h < 10 ? `0${h}` : `${h}`
  return `${pad}:00`
}
