/**
 * ColorSwatches — 颜色盘。
 *
 * 两个用处：
 * · **风格级颜色槽**（lorelei 与 micah 各 10 个：hairColor / skinColor …）；
 * · **core 的 `backgroundColor`**（六个风格通用）。
 *
 * ## 为什么颜色值不带 `#`
 *
 * DiceBear 的 schema pattern 是 `^(transparent|[a-fA-F0-9]{6})$` ——
 * 带 `#` 是**非法值**，而非法值会被静默忽略（不抛错，那一项直接不生效）。
 * 所以模型层存的是裸 hex，只在 CSS 里拼 `#`。
 *
 * ## 为什么是固定色板而不是取色器
 *
 * 取色器（`<input type="color">`）能给无限种颜色，但也能给出
 * "浅黄头发配浅黄背景"这种看不见的组合。固定色板是**美工的一部分**：
 * 每个色都是能用的色。真正需要任意颜色的用户可以上传图片。
 */
import { cn } from "../../lib/cn.js"
import { figureSupportsTransparentBackground } from "./figure-model.js"
import type { FigureStyle } from "../persona-figure.js"

export interface ColorSwatchesProps {
  /** 可选的颜色（裸 hex，不带 #）。`"transparent"` 也是合法值 */
  options: readonly string[]
  /** 当前值；undefined = 未定制（由 seed 或风格默认决定） */
  value: string | undefined
  onChange: (next: string | undefined) => void
  /** 每个色块的 aria-label 前缀（如"头发颜色"）。文案由调用方注入 */
  label: string
  /** 「跟随默认」那一格的文案；不传则不给这一格 */
  resetLabel?: string | undefined
}

/**
 * 缺省色板。
 *
 * 取自 DiceBear 各风格 schema 的 `default` 数组（那些是上游设计者
 * 挑过的、与素材配得上的颜色），再补几个中性色。
 * 直接抄默认值而不是自己配一套：上游的色是**跟着素材画风调过**的，
 * 我们凭空配一套很可能与画风打架。
 */
export const FIGURE_COLOR_OPTIONS: readonly string[] = [
  "000000",
  "ffffff",
  "77311d",
  "ac6651",
  "f9c9b6",
  "d2eff3",
  "e0ddff",
  "ffeba4",
  "ffedef",
  "0a5b83",
  "1c799f",
  "69d2e7",
  "f1f4dc",
  "f88c49",
  "fcbc34",
  "d84be5",
  "059ff2",
  "71cf62",
]

/**
 * 背景色板。
 *
 * ## ★ `transparent` **不是**无条件给的
 *
 * 实测它只对 schema 自带 `backgroundColor` 默认值的风格（thumbs / funEmoji）
 * 有效果；对 notionists / lorelei / micah / bottts 与**不写**逐字节相同
 * —— 那四个风格本来就没有背景，"透明"与"没有背景"是同一件事。
 * 无条件给的话用户点了它选中态会亮、配置会存、**画面一动不动**。
 *
 * 所以这张表只是**全集**，调用方要按风格取子集：
 * 用 `figureBackgroundOptionsFor(style)`，不要直接用这个常量。
 * 保留导出是因为它同时是"色板本身"的定义（门禁与测试要引它）。
 */
export const FIGURE_BACKGROUND_OPTIONS: readonly string[] = ["transparent", ...FIGURE_COLOR_OPTIONS]

/** 「透明」那一格的值。抽成常量让上面那张表与下面的过滤不会写岔。 */
export const TRANSPARENT_COLOR = "transparent"

/**
 * 该风格**真的能用**的背景色板。
 *
 * 见 `FIGURE_BACKGROUND_OPTIONS`：`transparent` 对四个风格是逐字节空操作，
 * 而一个点了没反应的控件比没有这个控件更糟 —— 用户会以为是功能坏了，
 * 而不是"这个风格没有背景可以透"。
 *
 * 剔除只发生在**消费侧**、只有这一个函数，与 `usableColorSlots` 同一个理由：
 * UI 与校验各自剔除会出现"UI 不显示但校验放行"这种更难查的不一致
 * （`sanitizeFigure` 走的是 `figureSupportsTransparentBackground`，
 * 也就是这里同一个判断）。
 */
export function figureBackgroundOptionsFor(style: FigureStyle): readonly string[] {
  if (figureSupportsTransparentBackground(style)) return FIGURE_BACKGROUND_OPTIONS
  return FIGURE_BACKGROUND_OPTIONS.filter((color) => color !== TRANSPARENT_COLOR)
}

export function ColorSwatches({ options, value, onChange, label, resetLabel }: ColorSwatchesProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {resetLabel === undefined ? null : (
        <button
          type="button"
          aria-pressed={value === undefined}
          onClick={() => onChange(undefined)}
          className={cn(
            "typography-caption-400 rounded-full px-2 py-0.5 transition-colors duration-150",
            value === undefined
              ? "bg-[var(--overlay-on-container-selected)] text-[var(--text-base-primary)]"
              : "text-[var(--text-base-secondary)] hover:bg-[var(--overlay-on-container-hover)]",
          )}
        >
          {resetLabel}
        </button>
      )}
      {options.map((color, index) => (
        <button
          key={color}
          type="button"
          aria-pressed={color === value}
          aria-label={`${label} ${String(index + 1)}`}
          onClick={() => onChange(color)}
          className={cn(
            "size-6 rounded-full border-2 transition-transform duration-150 hover:scale-110",
            color === value
              ? "border-[var(--text-accent-normal)]"
              : "border-[var(--border-divider-light)]",
          )}
          style={
            color === TRANSPARENT_COLOR
              ? {
                  /**
                   * 透明用棋盘格表示 —— 纯白色块与"白色"这个选项
                   * 在界面上无法区分，而它们是两件不同的事。
                   */
                  backgroundImage:
                    "linear-gradient(45deg, var(--border-divider-light) 25%, transparent 25%, transparent 75%, var(--border-divider-light) 75%), linear-gradient(45deg, var(--border-divider-light) 25%, transparent 25%, transparent 75%, var(--border-divider-light) 75%)",
                  backgroundSize: "8px 8px",
                  backgroundPosition: "0 0, 4px 4px",
                }
              : { backgroundColor: `#${color}` }
          }
        />
      ))}
    </div>
  )
}
