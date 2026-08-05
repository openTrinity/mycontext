/**
 * FigureStudio — 形象定制主界面（"QQ 秀"）。
 *
 * ## 它解决的是什么
 *
 * 现状只有 `style` + `seed` 两个旋钮：换一个形象 = 抽奖，
 * 想"就把头发换了"做不到。而 DiceBear **本来就支持逐槽位钉死**
 * （实测：notionists 的 10 个可用槽位组合空间约 4×10^11），
 * 只是那个能力一直没暴露出来 —— 一个 10^11 的空间只开了 8 个抽样口。
 *
 * 所以这个组件不引新渲染引擎，只把已有能力铺成"一个槽位一个抽屉"。
 * 仍然是纯 SVG + React，跨平台不变，零新增运行时依赖。
 *
 * ## ★ 文案由调用方注入（`labels`），本组件不调 `t()`
 *
 * `packages/design` 对 `@mycontext/*` **零依赖**、`tsconfig` 无 `references`，
 * 且该包有明文约定：`welcome-header.tsx` 的注释写着「这个函数在 design 包里
 * （不该知道语言）」，`Composer` 的做法是收 `attachLabel` / `sendLabel` props。
 * 这里沿用同一个模式 —— 附带好处是单测不需要 i18n provider。
 *
 * ## 受控组件
 *
 * 引导页与设置页**共用这一个组件**，各自决定什么时候落盘
 * （引导页跟着步骤走，设置页有显式保存按钮）。
 * 共用不是整洁问题：`persona-identity.ts` 的文件头记录过教训 ——
 * 两处各自解析会导致"引导里看到形象 A、草稿卡上看到形象 B"。
 */
import { useDeferredValue, useEffect, useId, useMemo, useState } from "react"
import type { ReactNode } from "react"
import { cn } from "../../lib/cn.js"
import { Button } from "../button.js"
import {
  FIGURE_STYLES,
  PersonaFigure,
  nextFigureSeed,
  type FigureStyle,
} from "../persona-figure.js"
import {
  FIGURE_COLOR_OPTIONS,
  figureBackgroundOptionsFor,
  ColorSwatches,
} from "./color-swatches.js"
import {
  FIGURE_PRESETS,
  figureColorSlotOwner,
  figureColorSlotsFor,
  figureSlotsFor,
  sanitizeFigure,
  withBackground,
  withColor,
  withSlot,
  type FigureConfig,
} from "./figure-model.js"
import { SlotDrawer } from "./slot-drawer.js"

/**
 * 可见文案。**由调用方注入** —— design 包不该知道语言（见文件头）。
 *
 * 为什么 `slotLabel` 是**函数**而不是一整张文案表：槽位清单是**生成物**，
 * 会随 DiceBear 变化。传表意味着加一个风格要同步改表，漏了就显示空白；
 * 传函数则由调用方的 `t()` 带 `defaultValue` 兜底（apps 侧本来就有这个能力）。
 */
export interface FigureStudioLabels {
  /** 槽位名：`slotLabel("hair") → "头发"`。实现方负责兜底 */
  slotLabel: (slotKey: string) => string
  /** 风格名：`styleLabel("notionists") → "手绘"` */
  styleLabel: (style: FigureStyle) => string
  /** 预设名：`presetLabel("clean") → "干净"` */
  presetLabel: (presetId: string) => string
  /** 「不要」（可选槽位的第一格） */
  noneLabel: string
  /** 「换风格后有 N 件没保留」 */
  droppedNotice: (count: number) => string
  /** 分组标题 */
  /**
   * 「可深度定制」。
   *
   * ★ 它现在是挂在 `DEEP_STYLES` 那两个 chip 后面的**能力标记**，
   * 不再是整个风格块的标题 —— 那时它盖在全部六个风格上，
   * 而其中四个明确不可深度定制（见 `StyleGroup` 的 `badge`）。
   */
  styleGroup: string
  /** 「风格」——风格分区的标题 */
  styleSection: string
  /** 「细节调整」——槽位 + 变体网格那一块的标题（它原来没有标题） */
  detailSection: string
  quickStyles: string
  presets: string
  colors: string
  background: string
  radius: string
  /** 「跟随默认」（颜色盘的第一格） */
  followDefault: string
  /** 「更多颜色（N）」—— 折叠起来的那几个颜色槽 */
  moreColors: (count: number) => string
  /** 「收起颜色」 */
  fewerColors: string
  /**
   * 「你把<部件>关掉了，这个颜色现在不起作用」——
   * 该颜色依附的可选部件被显式关掉（`null`）时替换掉整行色板。
   *
   * 收**部件名**而不是一句现成的话：文案要说清是哪一件
   * （"你把眼镜关掉了"比"这个颜色不起作用"可操作得多 ——
   * 后者不告诉用户该去开哪个开关）。
   */
  colorNeedsPart: (partLabel: string) => string
  /**
   * 「这一件当前可能不出现」—— 该颜色依附的可选部件处于
   * 「由 seed 决定」（键不存在）时挂在色板旁边的一行小字。
   *
   * 实测那种状态下颜色改动的可见率不到一成（见 `figureColorSlotOwner`），
   * 而用户没有任何办法知道这件事。
   */
  colorPartMaybeAbsent: (partLabel: string) => string
  /** 「打开<部件>」—— 上面两条旁边的那个按钮，一键把部件钉上 */
  enablePart: (partLabel: string) => string
  random: string
  reset: string
}

export interface FigureStudioProps {
  /** 当前风格 */
  style: FigureStyle
  /** 当前 seed。未定制的槽位仍由它决定 —— 这让"部分定制"天然成立 */
  seed: string
  /** 逐槽位定制 */
  value: FigureConfig
  onChange: (next: { style: FigureStyle; seed: string; custom: FigureConfig }) => void
  /** 上传的图片。有值时**优先于**生成的形象 → 整个定制区禁用 */
  imageSrc?: string | null
  labels: FigureStudioLabels
  className?: string
}

/**
 * 分组标签用的「可深度定制」那一组。
 *
 * ## ★ 它**只影响风格按钮的分组标签**，不影响抽屉开不开
 *
 * 上一版的注释（三处，还包括计划里的决策 C）写的是"只有这两个进抽屉，
 * 其余只给随机 + 预设 + 颜色盘"。**那与代码不符**：抽屉是
 * `figureSlotsFor(style)` 驱动的，六个风格一视同仁 —— 实测
 * micah 渲染 10 个页签 43 个格子、thumbs 3 个页签 46 个格子。
 *
 * 保留这个分组是因为**组合数差三到六个数量级**，那对用户是有意义的信息：
 *
 * | 风格       | 页签 | 格子 | 组合数  |
 * | ---------- | ---- | ---- | ------- |
 * | notionists | 10   | 197  | 4×10^11 |
 * | lorelei    | 11   | 139  | 3×10^9  |
 * | micah      | 10   | 43   | 7×10^5  |
 * | bottts     | 6    | 57   | 6×10^5  |
 * | thumbs     | 3    | 46   | 9×10^2  |
 * | funEmoji   | 2    | 30   | 2×10^2  |
 *
 * 所以标签说的是"这两个能调出真正独一无二的形象"，而不是
 * "只有这两个能调"。**满编抽屉是刻意保留的** —— 给 micah 关掉 10 个
 * 页签只会让它变得更差，而"抽屉里格子少"本来就自解释。
 */
const DEEP_STYLES: readonly FigureStyle[] = ["notionists", "lorelei"]

/**
 * 其余风格归到「快速」一组。它们**同样有抽屉**（见上方那张表）。
 *
 * **不删任何现有风格** —— 库里已有用户的 `figureStyle` 存的就是这 6 个之一，
 * 删掉会让他们的形象变成缺省（数据丢失）。
 */
const QUICK_STYLES: readonly FigureStyle[] = FIGURE_STYLES.filter(
  (item) => !DEEP_STYLES.includes(item),
)

/**
 * 圆角的三档。`radius` 是 core 选项，六风格通用，实测都生效。
 *
 * ## ★ 为什么这里的"未触碰"与"明确选方角"可以共用一个选中态
 *
 * 首格 `value: undefined` 会让 `aria-pressed` 对**未触碰**与
 * **明确选了方角**同时为真 —— 而 `slot-drawer.tsx` 有一整段论证
 * "三态不能压成两态"。这里是**相反的写法，且它是对的**，区别在于：
 *
 * 那边的第三态**有可见后果**（`frecklesProbability` 的 schema 默认值是 5，
 * 400 个 seed 里 17 个真的长出雀斑 —— 于是"未触碰"与"不要"是两张不同的脸）；
 * 这里实测 `radius` 省略与 `radius: 0` **逐字节相同**（notionists / thumbs
 * 都验过）。两态在产物上不可区分，那么在界面上把它们画成同一个格子
 * 就不是错误显示，而是**如实**——多给一格"跟随默认"只会让用户在
 * 两个完全等价的选项之间做一次没有意义的选择。
 *
 * 判据因此是"这两态的**产物**是否可区分"，而不是"数据上有几种取值"。
 */
const RADIUS_STEPS: readonly { value: number | undefined; label: string }[] = [
  { value: undefined, label: "▢" },
  { value: 20, label: "▣" },
  { value: 50, label: "●" },
]

/**
 * 清定制但**留下背景**（底色 + 圆角）。
 *
 * 给「随机」与「重置」共用。见 `reset` 的注释：`background` 存在 `custom`
 * 里，但它在界面上读起来是全局装饰（与风格无关），
 * 所以"换张脸"与"还原五官"都不该把用户挑的配色一起抹掉。
 *
 * 没设过背景时返回 `{}` —— 不写一个 `background: undefined` 进去，
 * 那会让 `sanitizeFigure` 与相等判断多一个需要考虑的形态。
 */
function keepBackground(value: FigureConfig): FigureConfig {
  return value.background === undefined ? {} : { background: value.background }
}

/**
 * 缩略图边长。
 *
 * 细节槽位（鼻子 20 个变体、眉毛 13 个）在 40px 下实测**看不出差别**
 * —— 而 `size` 不改变 SVG 内容（它只写进 `width`/`height`），所以
 * 给大格子不额外花任何字符串开销。别指望用户眯眼看。
 */
const CELL_SIZE = 52
const CELL_SIZE_DETAIL = 64
/** 需要更大格子的细节槽位（差别都在几个像素上）。 */
const DETAIL_SLOTS = new Set(["nose", "brows", "eyebrows", "lips", "mouth", "eyes", "freckles"])

/**
 * 默认展开的颜色槽 —— 改动最大的那几个。
 *
 * lorelei / micah 各有 10 个颜色槽（实测），全铺开是 190 个色块，
 * 而用户真正想改的「发色」「肤色」会沉到第 7、第 10 位。
 * 其余收进「更多颜色」。
 *
 * ## ★ 这张表是**展示顺序**，不跟生成物的 schema 顺序
 *
 * 它**不需要**随 `slots.generated.ts` 同步，也不该被"补全"成
 * 覆盖所有颜色槽 —— 那样折叠就失效了（漏在表外的自动进「更多颜色」，
 * 这正是想要的行为）。判据是"用户最想先改哪几个"，
 * 而 schema 顺序是上游按字母/内部结构给的，两者没有关系。
 * 表里出现一个某风格没有的 key 也无害：下面 `filter` 会把它滤掉
 * （所以这里可以同时写 lorelei 的 `skinColor` 与 micah 的 `baseColor`）。
 */
const PRIMARY_COLOR_SLOTS: readonly string[] = [
  "hairColor",
  "skinColor",
  "baseColor",
  "eyesColor",
  "mouthColor",
  "shirtColor",
]

export function FigureStudio({
  style,
  seed,
  value,
  onChange,
  imageSrc = null,
  labels,
  className,
}: FigureStudioProps) {
  const disabled = imageSrc !== null && imageSrc !== ""
  const slots = figureSlotsFor(style)
  const colorSlots = figureColorSlotsFor(style)

  /**
   * 页签与面板的 id 前缀。
   *
   * `useId` 而不是写死字符串：引导页与设置页理论上可以同时挂两个
   * `FigureStudio`（比如设置页开着、引导页在弹层里），而重复的 id
   * 会让 `aria-controls` 指向**另一个组件**的面板 ——
   * 那种 a11y bug 在视觉上完全看不见。
   */
  const tabIdPrefix = useId()

  /**
   * 当前打开的抽屉。
   *
   * 只渲染这一个 —— 这是**唯一真正减少同时存在的缩略图数量**的手段。
   * 实测瓶颈不是 CPU（64 次渲染仅 ~2.5ms）而是字符串内存与 DOM 节点：
   * 64 张 dataUri 累计 851KB。切页签即卸载上一组。
   */
  const [openSlot, setOpenSlot] = useState<string | null>(slots[0]?.key ?? null)

  /**
   * 切风格后当前打开的抽屉可能不存在了（notionists 的 `lips` 在 lorelei 里没有）。
   * 落回第一个槽位 —— 否则会看到一个空白的抽屉区，而"空白"与"坏了"没法区分。
   */
  useEffect(() => {
    if (slots.length === 0) {
      setOpenSlot(null)
      return
    }
    setOpenSlot((prev) =>
      prev !== null && slots.some((slot) => slot.key === prev) ? prev : (slots[0]?.key ?? null),
    )
  }, [slots])

  /**
   * 切风格时丢掉了多少件。
   *
   * ★ 必须显示出来：DiceBear 对不认识的槽位**静默忽略**，用户会看到
   * 自己配的部件悄悄消失一半而界面上什么都不说 ——
   * "换个风格头发没了没人告诉我"与"功能坏了"在用户侧不可区分。
   *
   * ★★ 但它必须在**下一次操作时消失**。
   *
   * 上一版只在切风格/随机/重置/预设时更新，于是点变体、切页签、调颜色
   * 都不会清掉它 —— 实测那句提示会一直挂着。一个不会消失的提示很快
   * 会被当成背景噪声，而它**下一次真的该出现时就没有信息量了**
   * （"那句话一直在那儿"）。所以下面所有 `onChange` 都过 `emit`，
   * 由它统一清零：提示因此严格是"刚才那一次切换的结果"。
   */
  const [droppedCount, setDroppedCount] = useState(0)

  /**
   * 统一的回传出口 —— **除了切风格**，任何改动都清掉丢弃提示。
   *
   * 抽成一个函数而不是在每个 handler 里记得写 `setDroppedCount(0)`：
   * "记得写"就是漏写的成因，而漏写的表现是一句挂着不走的提示。
   */
  const emit = (next: { style: FigureStyle; seed: string; custom: FigureConfig }) => {
    setDroppedCount(0)
    onChange(next)
  }

  /**
   * 颜色槽是否全部展开。
   *
   * 默认收起（只显 `PRIMARY_COLOR_SLOTS` 里那几个）——
   * 理由见下方那一段注释：10 个槽位 × 19 个色块是一堵墙。
   */
  const [showAllColors, setShowAllColors] = useState(false)
  /** 主要颜色槽按 `PRIMARY_COLOR_SLOTS` 的展示顺序排，不跟 schema 顺序。 */
  const primaryColorSlots = PRIMARY_COLOR_SLOTS.filter((key) => colorSlots.includes(key))
  const hiddenColorSlots = colorSlots.filter((key) => !primaryColorSlots.includes(key))
  const visibleColorSlots = showAllColors
    ? [...primaryColorSlots, ...hiddenColorSlots]
    : primaryColorSlots

  /** 换风格：保留能保留的，报告丢掉的。 */
  const switchStyle = (next: FigureStyle) => {
    const { config, dropped } = sanitizeFigure(next, value)
    // ★ 唯一**不**走 emit 的出口：这里正是要把计数设上去，而不是清零
    setDroppedCount(dropped.length)
    onChange({ style: next, seed, custom: config })
  }

  /**
   * 「随机」= 换 seed **且清空 custom**。
   *
   * 不清空的话用户会点了随机却发现头发不变 —— 那是"点了没反应"的一种，
   * 而那类 bug 只在真应用里暴露。
   *
   * ★ 轮次由 `nextFigureSeed` 从 **seed 自己**解析，不存组件 state：
   * 上一版用 `useState` 存轮次并拼 `${seed}|r${round}`，而 `seed` 已经是
   * 拼过的结果 —— 实测每点一次长 5 个字符、无上界地落进 vault，
   * 且卸载重挂后轮次归零会产出 `…|r1#0|r1#0`（连点随机回到同一张脸）。
   * 详见 `nextFigureSeed` 的注释。
   */
  const randomize = () => {
    emit({ style, seed: nextFigureSeed(seed), custom: keepBackground(value) })
  }

  /**
   * 「重置」= 清掉逐件定制，**保留 seed、风格与背景/圆角**。
   *
   * ## ★ 为什么保留 background
   *
   * 改动前它清的是整个 `custom`，而 `background`（底色 + 圆角）就存在
   * `custom` 里 —— 于是"重置形象"会连带把用户挑的底色与圆角一起清掉。
   *
   * 而那两项在界面上读起来是**全局装饰**（它们与风格无关，圆角对六个风格
   * 完全一样）。"我想把脸还原，但底色留着"是一个完全合理的意图，
   * 而改动前做不到 —— 且清掉是静默的，用户只会觉得"怎么颜色也变了"。
   *
   * 「随机」同理：它换的是**脸**（seed），不是配色方案。
   */
  const reset = () => {
    emit({ style, seed, custom: keepBackground(value) })
  }

  /**
   * 预设过一遍 `sanitizeFigure`。
   *
   * 预设是手写的常量，而手写的变体名会错（`micah.nose` 的正确拼写是
   * 上游的 `tound` 而不是 `round`）。过一遍校验让"写错了"变成
   * "那一项不生效"而不是"静默地被 DiceBear 丢掉"—— 同时门禁能测出来。
   */
  const presets = useMemo(
    () =>
      FIGURE_PRESETS.map((preset) => ({
        id: preset.id,
        style: preset.style,
        config: sanitizeFigure(preset.style, preset.config).config,
      })),
    [],
  )

  const activeSlot = slots.find((slot) => slot.key === openSlot)

  /**
   * 当前用的是哪个预设（没有则 null）。
   *
   * ## ★ 为什么必须有这个
   *
   * 改动前预设按钮**没有任何选中态**。而点一个预设会覆写 `style` 与整个
   * `custom`（它是所有控件的父级），于是点完之后上面的风格行会跳，
   * 而"我现在在哪个预设上"这个信息在界面上完全不存在。
   *
   * 更要紧的是**脱离**：下面任何一次微调（换个发型、改个底色）都会让
   * 当前配置不再等于那个预设。有了选中态，那次脱离是看得见的
   * —— 高亮消失就是"你已经在自己调了"。
   *
   * 判据是 `style` 与 `custom` **同时**匹配：只比 style 会让
   * clean/scholar（都是 notionists）互相误亮。
   * 用 JSON 比而不是逐字段比：`custom` 是嵌套的普通对象（slots/colors/
   * background），而预设那侧已经过了 `sanitizeFigure` —— 两边键序同源，
   * 所以序列化后可比。这里不需要通用的深比较。
   */
  const activePresetId = useMemo(() => {
    const current = JSON.stringify(value)
    return (
      presets.find((p) => p.style === style && JSON.stringify(p.config) === current)?.id ?? null
    )
  }, [presets, style, value])

  /**
   * 缩略图用的 seed（延后一帧）。
   *
   * 大预览用**当前** `seed`，只有这一排小预设图用它 —— 理由与
   * `SlotDrawer` 里那一段相同：引导页的 seed 由名字派生，敲一个字符
   * 就要重算这一屏所有缩略图（实测一次 keystroke 71 次 `createAvatar`
   * ≈1.4MB 字符串）。主形象即时跟着变，小图晚一帧看不出来。
   */
  const deferredSeed = useDeferredValue(seed)

  return (
    <div className={cn("flex flex-col gap-[var(--gap-component-md)]", className)}>
      {/*
        ★★ 层级按**真实依赖**排：预设 → 风格 → 细节。

        这是本次重排的核心。真实的依赖关系是：

        ```
        预设   → 一键覆写 style + slots + colors + background（所有东西的父级）
         └ 风格 → 决定有哪些槽位/颜色槽；换风格会 sanitize 掉不兼容的定制
            ├ 槽位 → 决定下面网格显示哪一组变体
            │   └ 变体网格 → 写 custom.slots[key]
            ├ 颜色（按风格；手绘/表情压根没有这一块）
            └ 背景色板（按风格微调）
         圆角  → 真正全局（core radius，与风格无关）
        ```

        而改动前它们**全渲染成同级**，且预设排在它自己的子级**下面**、
        没有任何选中态 —— 于是点了预设，上面的风格行会跳，而用户不知道
        发生了什么。用户的原话是「层级不对…第几层然后选了再选谁，
        哪些分类是统一登记的都很不明确」。
      */}

      {/*
        ① 预设：最省力的那条路，放最上面。

        ★ 给了**选中态**（改动前没有）：判据是 style 与 custom 同时匹配。
        没有选中态时"我现在用的是哪个预设"这个信息在界面上完全不存在，
        而预设是会被下面任何一次微调"脱离"的 —— 那时更需要看出来已经脱离了。
      */}
      {disabled ? null : (
        <FieldGroup title={labels.presets}>
          <div className="flex flex-wrap items-center gap-2">
            {presets.map((preset) => {
              const picked = activePresetId === preset.id
              return (
                <button
                  key={preset.id}
                  type="button"
                  aria-label={labels.presetLabel(preset.id)}
                  aria-pressed={picked}
                  onClick={() => emit({ style: preset.style, seed, custom: preset.config })}
                  className={cn(
                    "flex items-center gap-1 rounded-full border p-0.5 pr-2 transition-colors duration-150",
                    picked
                      ? "border-[var(--text-accent-normal)] bg-[var(--overlay-on-container-selected)]"
                      : "border-[var(--border-divider-light)] hover:bg-[var(--bg-card-z0)]",
                  )}
                >
                  {/*
                    预设缩略图也跟延后的 seed（见 SlotDrawer 里那段）：
                    这一排有 6 张，敲名字时它们与抽屉里那几十张一起重算。
                  */}
                  <PersonaFigure
                    seed={deferredSeed}
                    style={preset.style}
                    custom={preset.config}
                    size={28}
                    decoding="async"
                  />
                  <span
                    className={cn(
                      "typography-caption-400",
                      picked
                        ? "text-[var(--text-base-primary)]"
                        : "text-[var(--text-base-secondary)]",
                    )}
                  >
                    {labels.presetLabel(preset.id)}
                  </span>
                </button>
              )
            })}
          </div>
        </FieldGroup>
      )}

      <div className="flex items-start gap-4">
        {/* 大预览：抽屉里的缩略图看不清整体效果 */}
        <div className="flex shrink-0 flex-col items-center gap-2">
          <PersonaFigure
            seed={seed}
            style={style}
            imageSrc={imageSrc}
            custom={value}
            size={128}
            className="rounded-[var(--radius-lg)]"
          />
          <span className="flex gap-1">
            <Button size="sm" variant="ghost" disabled={disabled} onClick={randomize}>
              {labels.random}
            </Button>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={reset}>
              {labels.reset}
            </Button>
          </span>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-[var(--gap-component-md)]">
          {/*
            ② 风格。

            ★ 标题就叫「风格」，不再叫「可深度定制」——
            那个标题原来盖在**全部**风格上，而其中四个明确不可深度定制
            （见 DEEP_STYLES / QUICK_STYLES）。一个说反了的分组标题
            比没有标题更糟。"可深度定制"这件事改成挂在那两个 chip 上。
          */}
          <FieldGroup title={labels.styleSection}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <StyleGroup
                items={DEEP_STYLES}
                current={style}
                disabled={disabled}
                onPick={switchStyle}
                labels={labels}
                /* 只有这两个标"可深度定制"——那是它们与另外四个的真实差别 */
                badge={labels.styleGroup}
              />
              <StyleGroup
                title={labels.quickStyles}
                items={QUICK_STYLES}
                current={style}
                disabled={disabled}
                onPick={switchStyle}
                labels={labels}
              />
            </div>
          </FieldGroup>

          {droppedCount > 0 ? (
            <p
              className="typography-caption-400 text-[var(--status-warning)]"
              /* 状态变化要让读屏器也知道 —— 它是对用户操作的一个回应 */
              role="status"
            >
              {labels.droppedNotice(droppedCount)}
            </p>
          ) : null}

          {/*
            ③ 细节调整：槽位页签 + 变体网格。

            ★ 这一块原来**一个标题都没有** —— 而它是屏上最大的控件
            （10 个页签 + 最多 197 个缩略图）。没有标题的后果是它读起来像
            上面那个分组（标题曾是"可深度定制"）的**内容**，
            于是"哪些分类是统一登记的"完全说不清。

            现在它有自己的标题，与「预设」「风格」并列 —— 三块的关系
            从"一坨"变成"一键 / 换风格 / 抠细节"三条递进的路。
          */}
          {slots.length === 0 ? null : (
            <FieldGroup title={labels.detailSection}>
              <div className="flex flex-wrap gap-1" role="tablist">
                {slots.map((slot, index) => (
                  <button
                    key={slot.key}
                    type="button"
                    role="tab"
                    id={`${tabIdPrefix}-tab-${slot.key}`}
                    aria-controls={`${tabIdPrefix}-panel`}
                    disabled={disabled}
                    aria-selected={slot.key === openSlot}
                    tabIndex={slot.key === openSlot ? 0 : -1}
                    onClick={() => setOpenSlot(slot.key)}
                    onKeyDown={(event) => {
                      /**
                       * 只处理左右箭头 —— Home/End 也在 APG 里，但它们在一个
                       * 最多 11 格的横排里省下的按键数接近零，而每个额外分支
                       * 都是一处要维护的行为。走到有人真的需要再加。
                       */
                      const step =
                        event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0
                      if (step === 0) return
                      event.preventDefault()
                      // 绕回：走到头再按不该"卡住"（那与坏了不可区分）
                      const next = slots[(index + step + slots.length) % slots.length]
                      if (next === undefined) return
                      setOpenSlot(next.key)
                      /**
                       * 焦点要跟着走，否则下一次箭头还从原来那格算 ——
                       * 表现是"按了两次才动一格"。用 id 查而不是 ref 数组：
                       * 这里本来就需要 id（`aria-controls` 要对得上）。
                       */
                      document.getElementById(`${tabIdPrefix}-tab-${next.key}`)?.focus()
                    }}
                    className={cn(
                      "typography-caption-400 rounded-full px-2 py-0.5 transition-colors duration-150",
                      slot.key === openSlot
                        ? "bg-[var(--overlay-on-container-selected)] text-[var(--text-base-primary)]"
                        : "text-[var(--text-base-secondary)] hover:bg-[var(--overlay-on-container-hover)]",
                      disabled ? "cursor-not-allowed opacity-40" : "",
                    )}
                  >
                    {labels.slotLabel(slot.key)}
                  </button>
                ))}
              </div>

              {/*
                只渲染当前页签那一组（见 openSlot 的注释）。

                ★ `tabpanel` 这一层**总是**渲染（哪怕里面是空的），因为
                `aria-controls` 指向的 id 必须真的存在 —— 指向一个不存在的
                节点与不写 `aria-controls` 在读屏器上同样是"找不到面板"，
                但前者更糟：它看起来已经做了。
              */}
              <div
                id={`${tabIdPrefix}-panel`}
                role="tabpanel"
                {...(activeSlot === undefined
                  ? {}
                  : { "aria-labelledby": `${tabIdPrefix}-tab-${activeSlot.key}` })}
              >
                {activeSlot === undefined || disabled ? null : (
                  <SlotDrawer
                    slot={activeSlot}
                    style={style}
                    seed={seed}
                    value={value}
                    onChange={(custom) => emit({ style, seed, custom })}
                    slotLabel={labels.slotLabel(activeSlot.key)}
                    noneLabel={labels.noneLabel}
                    cellSize={DETAIL_SLOTS.has(activeSlot.key) ? CELL_SIZE_DETAIL : CELL_SIZE}
                  />
                )}
              </div>
            </FieldGroup>
          )}
        </div>
      </div>

      {/*
        风格级颜色槽。notionists 实测为空 → 对它这一栏不出现。

        ## ★ 为什么颜色槽要**折叠**而不是全部平铺

        lorelei / micah 各有 **10 个**颜色槽，每个 19 个色块 —— 全铺开是
        190 个圆点，而这一屏本来还有 64 个发型缩略图。实测截图确认那是
        一堵墙：用户真正想改的「发色」「肤色」排在第 7 与第 10 位，
        在视觉上完全沉底了。

        所以只默认展开 `PRIMARY_COLOR_SLOTS`（发色/肤色/眼睛/嘴/衣服 ——
        改动最大的那几个），其余收进「更多颜色」。
        这不是性能问题（色块是纯 CSS，不生成 SVG），是**信息密度**问题：
        "美工要更好看"这条诉求里，克制的排布与素材本身同等重要。
      */}
      {colorSlots.length === 0 || disabled ? null : (
        <FieldGroup title={labels.colors}>
          <div className="flex flex-col gap-1.5">
            {visibleColorSlots.map((colorKey) => (
              <ColorSlotRow
                key={colorKey}
                colorKey={colorKey}
                style={style}
                value={value}
                labels={labels}
                onChange={(custom) => emit({ style, seed, custom })}
              />
            ))}
            {hiddenColorSlots.length === 0 ? null : (
              <button
                type="button"
                aria-expanded={showAllColors}
                onClick={() => setShowAllColors((prev) => !prev)}
                className="typography-caption-400 self-start rounded-full px-2 py-0.5 text-[var(--text-base-tertiary)] transition-colors duration-150 hover:bg-[var(--overlay-on-container-hover)]"
              >
                {showAllColors ? labels.fewerColors : labels.moreColors(hiddenColorSlots.length)}
              </button>
            )}
          </div>
        </FieldGroup>
      )}

      {/*
        背景 + 圆角。它们是 **core** 选项，六个风格全都支持（实测都改变产物），
        是"更好看"里性价比最高的一块：不需要任何新素材，却能让形象从
        "一个头像"变成"一张有设计感的卡片"。
        对 notionists 更重要 —— 它没有任何风格级颜色槽，背景色是它
        **唯一**的颜色维度。

        刻意**不做渐变**：`backgroundType: gradientLinear` 在只给一个颜色时
        实测**无可见变化**（要 ≥2 个颜色），做进 UI 会得到一个
        "选了渐变但看不出来"的控件。等有设计稿再说。
      */}
      {disabled ? null : (
        <FieldGroup title={labels.background}>
          <ColorSwatches
            /**
             * ★ 按风格取子集：`transparent` 对 notionists / lorelei /
             * micah / bottts 与**不写**逐字节相同（实测），
             * 而 UI 把它与「跟随默认」并列成两个各自会亮的控件 ——
             * 点「透明」时选中态会亮、配置会存、画面一动不动。
             * 见 `figureBackgroundOptionsFor`。
             */
            options={figureBackgroundOptionsFor(style)}
            value={value.background?.color}
            onChange={(next) =>
              emit({ style, seed, custom: withBackground(value, { color: next }) })
            }
            label={labels.background}
            resetLabel={labels.followDefault}
          />
        </FieldGroup>
      )}

      {/*
        ★ 圆角**单独一组**，不再塞在「背景」标题下面。

        两者的作用域不同：背景色板是**按风格**的（`figureBackgroundOptionsFor`
        对不同风格给不同选项，透明色块只对 thumbs/funEmoji 出现），
        而圆角是 core 选项、六个风格完全一样。
        塞在一个标题下会让人以为改风格会影响圆角 —— 那是错的。
      */}
      {disabled ? null : (
        <FieldGroup title={labels.radius}>
          <span className="flex items-center gap-1.5">
            {RADIUS_STEPS.map((step) => (
              <button
                key={String(step.value)}
                type="button"
                aria-pressed={value.background?.radius === step.value}
                aria-label={`${labels.radius} ${step.label}`}
                onClick={() =>
                  emit({ style, seed, custom: withBackground(value, { radius: step.value }) })
                }
                className={cn(
                  "typography-caption-400 rounded-[var(--radius-md)] border px-2 py-0.5 transition-colors duration-150",
                  value.background?.radius === step.value
                    ? "border-[var(--text-accent-normal)] text-[var(--text-base-primary)]"
                    : "border-[var(--border-divider-light)] text-[var(--text-base-secondary)] hover:bg-[var(--bg-card-z0)]",
                )}
              >
                {step.label}
              </button>
            ))}
          </span>
        </FieldGroup>
      )}
    </div>
  )
}

/**
 * 一个可配置模块：一条标题 + 内容。
 *
 * ## ★ 为什么加它
 *
 * 这个定制器有五块可配置的东西（预设 / 风格 / 逐件部位 / 颜色 / 背景与圆角），
 * 而原来它们**全是同一层级**：每块只有一条浅灰小字标签，与内容里的其他
 * 小字没有任何区别。截图确认的后果是"看不出有哪些可配置模块" ——
 * 用户看到的是一整片按钮，而不是五组选择。
 *
 * 所以给每块一条**比内容重一档**的标题（`caption-400 + 中等字重 + 更深的墨色`）
 * 与一条左侧引导线。不用卡片边框：这个组件会被嵌进设置页的 Disclosure 与
 * 引导页的表单里，再套一层框就是三重嵌套。
 */
function FieldGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <span className="typography-caption-400 font-medium text-[var(--text-base-secondary)]">
        {title}
      </span>
      {children}
    </section>
  )
}

/**
 * 一个颜色槽的一行。
 *
 * ## ★★ 为什么它不能只是「标签 + 色板」
 *
 * 颜色只在它染的那个部件**存在时**才有效果，而部件是三态的
 * （见 `FigureConfig.slots` 的注释）。实测（见 `figureColorSlotOwner`
 * 的那张表）：`lorelei.glassesColor` 在未钉眼镜时 200 个 seed 里只有
 * **17 次**有可见变化；用户显式关掉眼镜之后是 **0/50**。
 * 而它与 `hairColor`（200/200）在界面上长得一模一样、点了一样会亮 ——
 * 这就是"点了没反应"，只不过 91% 的时候是这样。
 *
 * 所以按**依附部件的当前状态**分三种渲染：
 *
 * | 部件状态          | 这一行长什么样                                  |
 * | ----------------- | ----------------------------------------------- |
 * | `null`（明确不要）| 色板换成一句「你把 X 关掉了」+ 「打开 X」按钮   |
 * | 键不存在（由 seed）| 色板照给，旁边一行「X 当前可能不出现」+ 同一个按钮 |
 * | 钉住了 / 必填部件 | 就是普通的一行（`hairColor` 走这条）            |
 *
 * 第一种**不保留一个禁用的色板**：一个灰着的色板不解释为什么，
 * 与"坏了"仍然不可区分。给一句话 + 一个能立刻解决它的按钮才是出口
 * —— 这与 `persona-figure-panel.tsx` 里"禁用要说明理由"同一条规矩。
 */
function ColorSlotRow({
  colorKey,
  style,
  value,
  labels,
  onChange,
}: {
  colorKey: string
  style: FigureStyle
  value: FigureConfig
  labels: FigureStudioLabels
  onChange: (next: FigureConfig) => void
}) {
  const owner = figureColorSlotOwner(style, colorKey)
  const colorLabel = labels.slotLabel(colorKey)
  /** 依附部件的当前状态。没有依附部件时按"恒生效"处理 */
  const partState = owner === undefined ? undefined : value.slots?.[owner.key]
  const partLabel = owner === undefined ? "" : labels.slotLabel(owner.key)

  /**
   * 「打开 X」= 把那个部件钉成第一个变体。
   *
   * 钉变体而不是只把概率设成 100：`figureToOptions` 的三态表里
   * 「明确要」就是"变体 + 概率 100"，而只写概率没有对应的 config 形态
   * （那会变成第四种状态，而三态是被单测锁住的语义）。
   */
  const enablePart = () => {
    if (owner === undefined) return
    onChange(withSlot(value, owner.key, owner.variants[0] ?? null))
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="typography-caption-400 w-16 shrink-0 text-[var(--text-base-tertiary)]">
        {colorLabel}
      </span>
      {partState === null ? (
        /* 部件被明确关掉 → 这个颜色现在是逐字节空操作，别给一个假控件 */
        <span className="flex flex-wrap items-center gap-2">
          <span className="typography-caption-400 text-[var(--text-base-tertiary)]" role="status">
            {labels.colorNeedsPart(partLabel)}
          </span>
          <Button size="sm" variant="ghost" onClick={enablePart}>
            {labels.enablePart(partLabel)}
          </Button>
        </span>
      ) : (
        <>
          <ColorSwatches
            options={FIGURE_COLOR_OPTIONS}
            value={value.colors?.[colorKey]}
            onChange={(next) => onChange(withColor(value, colorKey, next))}
            label={colorLabel}
            resetLabel={labels.followDefault}
          />
          {/*
            部件由 seed 决定 → 色板是有效的，但**这一次**可能看不出变化
            （实测不到一成）。所以不禁用，只说明 + 给一个一键钉住的出口。
          */}
          {owner !== undefined && partState === undefined ? (
            <span className="flex flex-wrap items-center gap-1">
              <span
                className="typography-caption-400 text-[var(--text-base-tertiary)]"
                role="status"
              >
                {labels.colorPartMaybeAbsent(partLabel)}
              </span>
              <Button size="sm" variant="ghost" onClick={enablePart}>
                {labels.enablePart(partLabel)}
              </Button>
            </span>
          ) : null}
        </>
      )}
    </div>
  )
}

/** 一组风格按钮（主推 / 快速）。抽出来是因为两组样式完全相同。 */
function StyleGroup({
  title,
  badge,
  items,
  current,
  disabled,
  onPick,
  labels,
}: {
  /** 组内子标签。省略时不渲染（外层 FieldGroup 已经给了组标题） */
  title?: string
  /**
   * 挂在这一组**后面**的能力标记（如"可深度定制"）。
   *
   * ★ 它原来是外层 FieldGroup 的标题，于是盖在**全部**风格上 ——
   * 而其中四个明确不可深度定制。挂到组上才对得上：
   * 这个标记描述的是 `DEEP_STYLES` 这两个，不是所有风格。
   */
  badge?: string
  items: readonly FigureStyle[]
  current: FigureStyle
  disabled: boolean
  onPick: (style: FigureStyle) => void
  labels: FigureStudioLabels
}) {
  return (
    <span className="flex items-center gap-1">
      {title === undefined ? null : (
        <span className="typography-caption-400 text-[var(--text-base-tertiary)]">{title}</span>
      )}
      {items.map((item) => (
        <button
          key={item}
          type="button"
          disabled={disabled}
          aria-pressed={item === current}
          onClick={() => onPick(item)}
          className={cn(
            "typography-caption-400 rounded-full px-2 py-0.5 transition-colors duration-150",
            item === current
              ? "bg-[var(--overlay-on-container-selected)] text-[var(--text-base-primary)]"
              : "text-[var(--text-base-secondary)] hover:bg-[var(--overlay-on-container-hover)]",
            disabled ? "cursor-not-allowed opacity-40" : "",
          )}
        >
          {labels.styleLabel(item)}
        </button>
      ))}
      {badge === undefined ? null : (
        <span className="typography-caption-400 text-[var(--text-base-tertiary)]">{badge}</span>
      )}
    </span>
  )
}
