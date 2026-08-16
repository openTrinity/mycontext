/**
 * 监听范围的**模式选择器** —— 三个互斥选项，引导与设置页共用。
 *
 * ## ★★★ 为什么它必须存在（这修的是一个反直觉的默认值）
 *
 * 改动前引导第 5 步只有一个勾选列表 + 一句解释性文案：
 *
 * > 「一个都不勾 = 分身会盯上一步所有已勾选的会话」
 *
 * 那句话是**对的**（旧判据 `activeCount === 0` → 放行全部），但它要求
 * 用户从一句解释里推断出一个反直觉的默认值 —— 而相邻的上一步
 * （学习范围）的默认值方向恰好相反（`collect-nothing`，一个都不采）。
 *
 * 更实际的问题是**第三个意图压根表达不出来**：「我先都不盯，以后再开」。
 * 空数组在旧存储里与"从没配过"同形，于是那个选择没有任何落库痕迹。
 *
 * 三个互斥选项把同一件事变成一次**显式选择**，而 `mode` 让三者在库里
 * 可区分（见 `@mycontext/store` 的 `AttentionMode`）。
 *
 * ## ★★ 为什么是 button + `aria-pressed` 而不是 `<input type="radio">`
 *
 * 设计系统里没有 Radio，而这一组的视觉与 `sources-step` 的时间范围筹码
 * **是同一类交互**（一组互斥的选择）—— 复用那个形状让两步读起来是一套。
 * 引一个新的原生 radio 会带来一套需要单独适配深色模式与 focus 环的样式。
 *
 * ★ `role="radiogroup"` + `aria-checked` 让读屏软件仍然听到"这是一组互斥项"。
 */
import type { AttentionModeValue } from "@mycontext/ipc-contract"
import { cn } from "@mycontext/design"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

export interface AttentionModePickerProps {
  value: AttentionModeValue
  onChange: (next: AttentionModeValue) => void
  /**
   * 「盯全部」那一项要显示的会话数（来自学习范围的勾选）。
   *
   * ★ 显示它是因为"全部"这个词本身不含信息量 —— 用户需要知道
   * 那是 3 个群还是 300 个群，而那个数字决定他会不会选这一项。
   */
  learnedCount: number
  /** 「只盯我挑的」那一项当前挑了几个（0 时那一项仍可选，见下） */
  chosenCount: number
}

/**
 * 三个选项的顺序：**盯全部 → 只盯这几个 → 都不盯**。
 *
 * ★ 从宽到窄，而不是把"都不盯"放第一位：那个顺序会让最保守的选项
 * 显得像推荐值，而这一步的目的是让分身开始工作。
 *
 * ★ `unset` **不在这里** —— 它不是一个用户能选的状态，它的含义是
 * "还没表态"。把它做成一个选项会让用户能主动选择"我不表态"，
 * 而那正是这个组件要消灭的东西。
 */
const MODES: readonly { mode: Exclude<AttentionModeValue, "unset">; keySuffix: string }[] = [
  { mode: "all", keySuffix: "all" },
  { mode: "explicit", keySuffix: "explicit" },
]

export function AttentionModePicker({
  value,
  onChange,
  learnedCount,
  chosenCount,
}: AttentionModePickerProps) {
  const { t } = useDynamicTranslation("onboarding")

  /**
   * 「都不盯」是 `explicit` + 空名单，所以它不是第四个 mode ——
   * 它是 `explicit` 的一个**特例**。做成第三个按钮是为了让那个意图
   * 一次点击就能表达（否则用户要先选 explicit、再把勾选全清掉）。
   */
  const isNone = value === "explicit" && chosenCount === 0
  const isExplicit = value === "explicit" && chosenCount > 0

  const labelOf = (mode: Exclude<AttentionModeValue, "unset">): string =>
    mode === "all"
      ? t("attentionStep.mode.all", {
          defaultValue: "盯全部已学习的会话（{{count}} 个）",
          count: learnedCount,
        })
      : t("attentionStep.mode.explicit", {
          defaultValue: "只盯我挑的这几个",
        })

  return (
    <div
      role="radiogroup"
      aria-label={t("attentionStep.mode.label", { defaultValue: "监听范围" })}
      className="flex flex-col gap-1.5"
    >
      {MODES.map(({ mode, keySuffix }) => {
        const active = mode === "all" ? value === "all" : isExplicit
        return (
          <button
            key={keySuffix}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(mode)}
            className={cn(
              "typography-body-small-400 rounded-lg border px-3 py-2 text-left transition-colors duration-150",
              active
                ? "border-[var(--text-accent-normal)] bg-[var(--bg-card-z0)] text-[var(--text-base-primary)]"
                : "border-[var(--border-divider-light)] text-[var(--text-base-secondary)] hover:bg-[var(--bg-card-z0)]",
            )}
          >
            {labelOf(mode)}
          </button>
        )
      })}
      {/*
        ★★★ 第三个：「先都不盯」。

        它写 `mode: "explicit"` + 清空名单 —— 那个组合在旧存储里
        **表达不出来**（空名单会被路由读成"盯全部"，方向相反）。
      */}
      <button
        type="button"
        role="radio"
        aria-checked={isNone}
        onClick={() => onChange("explicit")}
        data-attention-mode="none"
        className={cn(
          "typography-body-small-400 rounded-lg border px-3 py-2 text-left transition-colors duration-150",
          isNone
            ? "border-[var(--text-accent-normal)] bg-[var(--bg-card-z0)] text-[var(--text-base-primary)]"
            : "border-[var(--border-divider-light)] text-[var(--text-base-secondary)] hover:bg-[var(--bg-card-z0)]",
        )}
      >
        {t("attentionStep.mode.none", {
          defaultValue: "先都不盯（以后在设置里开）",
        })}
      </button>
    </div>
  )
}
