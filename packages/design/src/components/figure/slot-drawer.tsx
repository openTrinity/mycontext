/**
 * SlotDrawer — 一个槽位的变体网格（QQ 秀的"一个抽屉"）。
 *
 * ## ★ 缩略图必须是真实渲染，不能是"色块 + 文字 variant07"
 *
 * 每格渲染的是**当前配置只把这一格的槽位换掉**之后的完整形象。
 * 于是用户看到的是"换成这件之后我长什么样"，而不是一个编号。
 * 这是"美工更好看"这条诉求在交互上的落点 —— 也是它比现状
 * （整体抽样的 8 宫格）强的地方：现状换 seed 是整张脸都变，
 * 想"就把头发换了"做不到。
 *
 * ## ★ 只显缩略图，不显变体名
 *
 * 变体名实测含 `mrT` / `dannyPhantom`（第三方角色名）、`pissed` /
 * `faceMask`、以及上游拼写错误 `tound` —— 既难看又有商标面。
 * `aria-label` 用「<槽位名> <序号>」（如"头发 7"），这同时让 i18n
 * 不必翻译 ~250 个变体名（只需 ~30 个槽位名）。
 *
 * ## 两种形态
 *
 * · `toggleOnly`（单变体 + 有概率槽，实测只有 lorelei 的 `freckles` /
 *   `hairAccessories`）→ 渲染成**开关**。一格网格是纯噪声；
 *   而这两个槽位是"要不要雀斑 / 要不要发饰"这种真开关（实测 prob 0 vs 100
 *   产物不同），一律过滤掉会砍掉两个用户想得到的定制项。
 *   两格各自只对自己那一态亮 —— **未触碰时两格都不亮**，见下方那段注释：
 *   把「未触碰」与「明确不要」画成同一个样子是一次真实的错误显示。
 * · 其余 → 变体网格。`optional` 的槽位第一格是「不要」。
 */
import { useDeferredValue, useEffect, useMemo, useState } from "react"
import { cn } from "../../lib/cn.js"
import { PersonaFigure, type FigureStyle } from "../persona-figure.js"
import { withSlot, type FigureConfig } from "./figure-model.js"
import type { FigureSlot } from "./slots.generated.js"

export interface SlotDrawerProps {
  slot: FigureSlot
  style: FigureStyle
  seed: string
  value: FigureConfig
  onChange: (next: FigureConfig) => void
  /** 槽位的可见名（用于 aria-label）。文案由调用方注入 —— design 包不知道语言 */
  slotLabel: string
  /** 「不要」 */
  noneLabel: string
  /** 每格边长（px） */
  cellSize: number
}

/**
 * 一屏铺多少格。
 *
 * 8 列 × 4 行 = 32 格。`hair` 有 64 个变体 —— 一次全铺开不只是性能问题：
 * 64 个 40px 缩略图在视觉上是一堵墙，用户找不到自己想要的。
 * 限高之后"还有更多"这件事是可见的（滚动条），比无限长的墙好。
 *
 * ★ 这两个常量现在**同时**是渲染批次的大小，见下方 `revealed`。
 */
const MAX_ROWS = 4
const COLUMNS = 8
/** 一批 = 一屏。滚动到底部附近时再放一批出来。 */
const PAGE = MAX_ROWS * COLUMNS
/** 距底部还有这么多像素就预取下一批 —— 让滚动看起来是连续的，不是"滚到底才长出来" */
const PREFETCH_PX = 120

export function SlotDrawer({
  slot,
  style,
  seed,
  value,
  onChange,
  slotLabel,
  noneLabel,
  cellSize,
}: SlotDrawerProps) {
  const current = value.slots?.[slot.key]

  /**
   * 已经"放出来"的格子数 —— 超出的格子渲染成占位框，不生成 SVG。
   *
   * ## ★★ 为什么必须分批（`MAX_ROWS`/`COLUMNS` 只限了**高度**）
   *
   * 上一版把整个 `slot.variants` 一次性渲染，`maxHeight` 只是让多出来的
   * 部分滚动 —— 也就是说滚动区**外**的 32+ 格早就全部生成并解码了。
   * 实测 64 格 = **1279KB** dataUri 字符串（UTF-16 约 2.5MB）
   * 外加浏览器侧解码出的位图，而用户在挑到第 33 个之前一格都看不到它们。
   *
   * 更糟的是它与"换 seed"相乘：seed 一变这 64 张全部作废重建。
   *
   * 首批就是一屏（32 格），滚动接近底部时再放一批。
   * ★ 占位格**保留同样的尺寸**，所以滚动条长度从一开始就是对的 ——
   * 一个会随滚动变长的滚动条比"滚到底才长出来"更让人迷惑。
   */
  const [revealed, setRevealed] = useState(PAGE)

  /**
   * 切槽位/切风格时把批次收回第一屏。
   *
   * 不收的话从 `hair`（放到 64）切到 `nose`（20 格）再切回来，
   * 会一次性材质化 64 格 —— 那正好绕过了分批。
   */
  useEffect(() => {
    setRevealed(PAGE)
  }, [slot.key, style])

  /**
   * ★★ 缩略图跟一个**延后的** seed，输入框跟当前 seed。
   *
   * ## 那个卡顿长什么样
   *
   * 引导页的 seed 由名字派生，所以**敲一个字符就换一次 seed**，而 seed
   * 是每一格的 memo 依赖 —— 实测一次 keystroke = 71 次 `createAvatar`
   * ≈ 1.4MB 新字符串，且那些 dataUri 会同时触发 `<img>` 重新解码。
   * CPU 侧只有几毫秒，但字符串分配 + 位图解码会让中文输入法逐字上屏
   * 时有可感知的延迟。
   *
   * `useDeferredValue` 让 React 先把输入框那次更新画完，再用空闲时间
   * 重算这一屏缩略图。**大预览不走这里**（它在 `FigureStudio` 里，
   * 只有一张，用当前 seed）—— 于是用户看到的主形象是即时跟着名字变的，
   * 只有几十张小图会晚一帧，而那是看不出来的。
   *
   * ★ 点击回传的 `onChange` 用的是**当前** `value`，不是延后的值：
   * 延后只影响"画什么"，不影响"点了以后存什么"。否则会变成
   * 一个真正的数据 bug（存进去的是上一个状态）。
   */
  const deferredSeed = useDeferredValue(seed)

  /**
   * 每格的预览配置：当前配置 + 把这一格换成该变体。
   *
   * 在这里一次算好而不是在渲染时内联算 —— 内联会让每次重渲染都新建
   * 64 个对象，而 `PersonaFigure` 的 memo 依赖是从 `custom` 算出来的
   * 规范化字符串，新对象本身不会击穿它，但白建 64 个对象也没必要。
   */
  const cells = useMemo(
    () => slot.variants.map((variant) => ({ variant, config: withSlot(value, slot.key, variant) })),
    [slot.variants, slot.key, value],
  )

  if (slot.toggleOnly === true) {
    /**
     * 开关形态。
     *
     * ## ★★ 三态不能压成两态
     *
     * 上一版写的是 `const on = current !== null && current !== undefined`
     * 然后 `aria-pressed={!on}` —— 于是 `undefined`（未触碰）与 `null`
     * （明确不要）**都让「不要」显示成选中**。那是一条真实的错误显示：
     * 实测 `figureToOptions("lorelei", {})` 不写 `frecklesProbability`，
     * 而它的 schema 默认值是 **5**，400 个 seed 里 **17 个真的长出雀斑**
     * —— 界面上「不要」却是高亮的。用户看到的是"我明明选了不要，
     * 它还是有雀斑"，而这直接推翻了 `figure-model.ts` 大段论证的
     * "`null` 与键不存在必须可区分"。
     *
     * 所以两格各自只对**自己那一态**亮，未触碰时**两格都不选中**
     * （与下面网格分支的写法一致 —— 那边一直是对的）。
     * 第三态在 UI 上没有自己的格子，但它现在是**可见**的：
     * 两格都不亮就是"还没决定，由 seed 决定"。
     */
    const first = slot.variants[0]
    const off = current === null
    const on = typeof current === "string"
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={off}
          onClick={() => onChange(withSlot(value, slot.key, null))}
          className={cn(cellClass(off), "px-3 py-2")}
        >
          <span className="typography-caption-400">{noneLabel}</span>
        </button>
        <button
          type="button"
          aria-pressed={on}
          aria-label={`${slotLabel} 1`}
          onClick={() => onChange(withSlot(value, slot.key, first ?? null))}
          className={cn(cellClass(on), "p-1")}
        >
          <PersonaFigure
            seed={deferredSeed}
            style={style}
            custom={withSlot(value, slot.key, first ?? null)}
            size={cellSize}
            decoding="async"
          />
        </button>
      </div>
    )
  }

  return (
    <div
      className="overflow-y-auto"
      /**
       * 限高而不是分页：滚动保留了"一眼看到很多个"的浏览体感
       * （挑发型本来就是扫视的过程），分页会把它切成需要点击的步骤。
       *
       * ★ 但**渲染**是分批的（见 `revealed`）：限高只管可视区域，
       * 上一版把 64 格全部生成了，其中 32+ 格在滚动区外没人看得见。
       */
      style={{ maxHeight: (cellSize + 10) * MAX_ROWS + 8 }}
      /**
       * 滚到接近底部就放下一批。
       *
       * 用 `onScroll` 而不是 `IntersectionObserver`：这里要的判断只有
       * "还差多少到底"一条，而 observer 要多一个 ref + 一个哨兵节点 +
       * 一套 jsdom 里没有的 API（那会让单测需要一个桩）。
       */
      onScroll={(event) => {
        if (revealed >= cells.length) return
        const node = event.currentTarget
        const remaining = node.scrollHeight - node.scrollTop - node.clientHeight
        if (remaining <= PREFETCH_PX) {
          setRevealed((prev) => Math.min(cells.length, prev + PAGE))
        }
      }}
    >
      <div
        className="grid gap-1.5"
        style={{ gridTemplateColumns: `repeat(${String(COLUMNS)}, minmax(0, 1fr))` }}
      >
        {/* 可选槽位的第一格是「不要」—— 实现是把概率置 0，见 figureToOptions */}
        {slot.optional ? (
          <button
            type="button"
            aria-pressed={current === null}
            onClick={() => onChange(withSlot(value, slot.key, null))}
            className={cn(cellClass(current === null), "aspect-square")}
            style={{ minHeight: cellSize }}
          >
            <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
              {noneLabel}
            </span>
          </button>
        ) : null}

        {cells.map(({ variant, config }, index) => (
          <button
            key={variant}
            type="button"
            aria-pressed={variant === current}
            /* ★ 序号而不是变体名：`mrT` / `tound` 不该出现在界面上 */
            aria-label={`${slotLabel} ${String(index + 1)}`}
            onClick={() => onChange(withSlot(value, slot.key, variant))}
            className={cn(cellClass(variant === current), "p-0.5")}
            /**
             * ★ 按钮**总是**在 DOM 里，只有缩略图分批材质化。
             *
             * 不把整个按钮也省掉，是因为那会让序号（`aria-label` 里的
             * `index + 1`）与"第几个可点的东西"随滚动位置变化 ——
             * 读屏器用户听到的编号会漂，而 CDP 探针靠这个 label 定位格子。
             * 空按钮只是一个带边框的方块，代价接近零；
             * 真正贵的是那张 10-15KB 的 SVG。
             */
            style={index >= revealed ? { minHeight: cellSize } : undefined}
          >
            {index < revealed ? (
              <PersonaFigure
                seed={deferredSeed}
                style={style}
                custom={config}
                size={cellSize}
                /**
                 * ★ 让解码离开主线程。
                 *
                 * dataUri 不走网络，所以 `loading="lazy"` 帮不上忙
                 * （没有请求可以省），但**解码**仍然是同步发生在主线程上的
                 * —— 一屏 32 张 52px 位图就是它。`async` 让浏览器
                 * 自己排期，这是这里唯一真正省得下来的一笔。
                 */
                decoding="async"
              />
            ) : null}
          </button>
        ))}
      </div>
    </div>
  )
}

/** 变体格的样式。选中态用主题色描边 —— 与现有 persona-step 的 8 宫格一致。 */
function cellClass(selected: boolean): string {
  return cn(
    "flex items-center justify-center overflow-hidden rounded-[var(--radius-md)] border transition-colors duration-150",
    selected
      ? "border-[var(--text-accent-normal)] bg-[var(--bg-card-z0)]"
      : "border-[var(--border-divider-light)] hover:bg-[var(--bg-card-z0)]",
  )
}
