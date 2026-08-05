/**
 * StepBar — 顶部横向步骤条（贯通进度轨道 + 状态点 + 下方标题）。
 *
 * ## ★ 为什么从竖排改成横排（前身是 `step-rail.tsx`）
 *
 * 旧组件的文件头论证过"为什么是竖的"：每一步要带一句说明
 * （"扫码授权钉钉，之后才能读到消息"），横排塞不进说明文字，
 * 只能显示光秃秃的标题 —— 而用户最需要的正是"这步是干什么的"。
 *
 * **那个论证的前提没错，结论选错了地方。** 说明确实要有，但它不必长在
 * 步骤条上：现在它作为**当前步骤的副标题**显示在内容区顶部
 * （见 `onboarding-view.tsx`），字号更大、就在眼睛落点上，
 * 比挤在 248px 宽的侧栏里更容易被读到。
 *
 * 换来的是：内容区从 ~800px 变成整个窗口宽度，四步的**全局位置感**
 * 一眼可见（竖排在小窗口里要滚动才看得全），而这是引导页的主要职责。
 *
 * ## ★ 进度轨道是**一条**贯通的线，不是每格各画一段
 *
 * 这是横向步骤条看起来"整"而不是"散"的唯一关键。
 * 每格各画一段的话，四段线的长度由各自标题的宽度决定 ——
 * 于是视觉上是四个独立的小控件，而不是一条路径。
 *
 * 实现是两层叠加：底层一条贯通的灰轨道，上层一条按进度百分比宽度的
 * 高亮条。轨道**只铺在首末两个圆点之间**（左右各留半格），
 * 否则线会从第一个点向左伸出去一截，看起来像断了。
 *
 * ## 状态有四种，不是三种
 *
 * `done` / `skipped` / `current` / `pending`。`skipped` 必须与 `pending`
 * 可区分：用户明确跳过之后重进引导，那一步该显示"已跳过"而不是"还没做" ——
 * 后者会让人以为上次的操作没生效。（这条判断从旧组件继承，它是对的。）
 *
 * ## 可以点着跳
 *
 * 引导不是向导（wizard）—— 用户可能先去配数字人再回来授权。
 * 强制线性会让"我只想改第 2 步"变成"从头点一遍"。
 * 唯一的例外交给调用方：某步依赖前置条件时由它自己在面板里说明。
 */
import { cn } from "@mycontext/design"

export type StepVisualState = "done" | "skipped" | "current" | "pending"

export interface StepBarItem {
  id: string
  label: string
  state: StepVisualState
  /** 该步是否已实装。未实装的标灰并加后缀 */
  implemented?: boolean
}

export interface StepBarProps {
  items: readonly StepBarItem[]
  activeId: string
  onSelect: (id: string) => void
  /** 未实装步骤的标注后缀（i18n 文案由调用方给） */
  comingSoonSuffix?: string
  /** 各状态的可读名（读屏器用；i18n 文案由调用方给） */
  stateLabels: Record<StepVisualState, string>
}

export function StepBar({
  items,
  activeId,
  onSelect,
  comingSoonSuffix = "",
  stateLabels,
}: StepBarProps) {
  /**
   * 高亮轨道走到哪里。
   *
   * 判据是「**走过的**步数」= 最后一个 done/skipped 的下标 + 1，
   * 而不是"当前是第几步"。两者在用户往回点时会分叉：
   * 站在第 2 步回看时前两步已经走过，轨道不该跟着缩回去 ——
   * 那会让人以为进度丢了。
   */
  const passed = items.reduce(
    (acc, item, index) => (item.state === "done" || item.state === "skipped" ? index + 1 : acc),
    0,
  )
  /**
   * 轨道两端各留半格：线只连接圆点，不向外伸出。
   * `items.length - 1` 是段数（4 个点 = 3 段），所以进度按段算。
   */
  const segments = Math.max(items.length - 1, 1)
  const progress = Math.min(passed, segments) / segments

  return (
    <ol className="relative mx-auto flex w-full max-w-[880px] items-start">
      {/*
        进度轨道。`aria-hidden`：它表达的信息已经由每个 li 的状态文字
        给到读屏器了，再读一遍轨道只是噪音。

        left/right 各留 `calc(100%/n/2)` —— 即半格，让线正好起止于
        首末两个圆点的圆心。用百分比而不是像素：格子是 flex-1 等分的，
        像素值在窗口变宽时会对不上。
      */}
      <span
        aria-hidden="true"
        className="absolute top-[13px] h-px bg-[var(--border-divider-light)]"
        style={{
          left: `calc(100% / ${items.length} / 2)`,
          right: `calc(100% / ${items.length} / 2)`,
        }}
      />
      <span
        aria-hidden="true"
        className="absolute top-[13px] h-px bg-[var(--text-accent-normal)] transition-[width] duration-300"
        style={{
          left: `calc(100% / ${items.length} / 2)`,
          width: `calc((100% - 100% / ${items.length}) * ${progress})`,
        }}
      />

      {items.map((item, index) => {
        const isActive = item.id === activeId
        return (
          <li key={item.id} className="min-w-0 flex-1">
            <button
              type="button"
              onClick={() => onSelect(item.id)}
              // aria-current 让读屏器知道"当前在这一步"，视觉上靠圆点与字色表达
              aria-current={isActive ? "step" : undefined}
              className={cn(
                "group flex w-full flex-col items-center gap-1.5 rounded-[var(--radius-md)] px-2 py-1",
                "transition-colors duration-150",
              )}
            >
              <StepDot state={item.state} index={index} active={isActive} />
              <span className="flex min-w-0 flex-col items-center gap-0.5">
                <span
                  className={cn(
                    "typography-body-small-400 max-w-full truncate transition-colors duration-150",
                    isActive
                      ? "font-medium text-[var(--text-base-primary)]"
                      : "text-[var(--text-base-tertiary)] group-hover:text-[var(--text-base-secondary)]",
                  )}
                >
                  {item.label}
                </span>
                {/*
                  ## ★ 状态词只给读屏器，不占视觉行

                  原来「已完成」是标题下方的一行绿字。后果是**只有做完的步骤变高**
                  —— 整条的基线参差不齐，做完两步时尤其明显（那也是用户说
                  "横栏要更有设计感"的一部分）。

                  而那行字是冗余的：done 是绿色对勾、current 是实心+柔光环、
                  pending 是空心数字、skipped 是横线 —— 圆点本身已经把四态区分开了。

                  读屏器不能靠颜色与形状，所以状态词保留在 `sr-only` 里。
                */}
                <span className="sr-only">{stateLabels[item.state]}</span>
                {/*
                  未实装后缀**仍然**占视觉行 —— 它不是状态而是一条能力预告，
                  不说出来用户会去点一个点不动的步骤。
                */}
                {item.implemented === false && comingSoonSuffix !== "" ? (
                  <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
                    {comingSoonSuffix}
                  </span>
                ) : null}
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * 状态点：done 打勾、skipped 画横线、current 实心+柔光环、pending 空心。
 *
 * ★ 圆点必须有**不透明的底色**：它压在进度轨道上面，
 * 透明底会让那条线从圆点中间穿过去。
 *
 * ★ current 的柔光环（`ring`）是"你在这里"最省事的强调手段 ——
 * 比放大尺寸好，因为尺寸变化会让整条的基线跟着跳。
 */
function StepDot({
  state,
  index,
  active,
}: {
  state: StepVisualState
  index: number
  active: boolean
}) {
  const base =
    "relative flex size-[26px] shrink-0 items-center justify-center typography-caption-400 rounded-full font-medium transition-all duration-200"

  if (state === "done") {
    return (
      <span className={cn(base, "bg-[var(--status-success)] text-[var(--theme-white-white-100)]")}>
        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden="true">
          <path
            d="M3.5 8.5l3 3 6-6.5"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    )
  }

  if (state === "skipped") {
    return (
      <span
        className={cn(
          base,
          "border border-[var(--border-divider-light)] bg-[var(--bg-base-normal)] text-[var(--text-base-tertiary)]",
        )}
      >
        {/* 一条横线：视觉上明确"走过但没做"，与空心的 pending 不会混 */}
        <span className="h-px w-2.5 bg-current" />
      </span>
    )
  }

  if (active || state === "current") {
    return (
      <span
        className={cn(
          base,
          "bg-[var(--control-core-button-default)] text-[var(--theme-white-white-100)]",
          "ring-4 ring-[var(--control-core-button-default)]/15",
        )}
      >
        {index + 1}
      </span>
    )
  }

  return (
    <span
      className={cn(
        base,
        "border border-[var(--border-divider-light)] bg-[var(--bg-base-normal)] text-[var(--text-base-tertiary)]",
      )}
    >
      {index + 1}
    </span>
  )
}
