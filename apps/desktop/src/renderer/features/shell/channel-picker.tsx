/**
 * ChannelPicker —— 「当前在看/用哪个渠道」。
 *
 * ## ★★ 必须是下拉，而且浮层必须退出窗口拖拽区
 *
 * 两个坑都是实测踩出来的：
 *
 * ① **分段平铺**（第一版）的宽度随渠道数线性增长，而这个控件出现在页头、
 *    与页面标题同排 —— 三个渠道就会把标题挤掉。下拉的宽度只由当前值决定。
 *
 * ② 页头是 `-webkit-app-region: drag` 区域。触发器是 `button`（`globals.css`
 *    里那条规则给它 `no-drag`），但**浮层是 absolute 定位的 div，超出触发器
 *    的范围** —— 超出的那部分（也就是全部菜单项）落在拖拽区上，于是菜单能
 *    展开却**一个都点不动**。修在 `DropdownMenu` 里（`data-no-drag`），
 *    其它用它的地方一起受益。
 *
 * ## 视觉：图标承载识别，文字只是补充
 *
 * 「钉钉/飞书」这两个词在扫视时几乎一样长、一样重 —— 真正被认出来的是那两个
 * 品牌图标（一个蓝、一个青）。所以：
 *
 * · 触发器**无边框**（页头已经有自己的边界，再套一个框是框中框），
 *   只在 hover/open 时给一层极淡底色 —— 那是"可点"的最小暗示；
 * · 图标 14px 带 `rounded`（品牌 logo 本身是方的，切一点角才不像贴纸）；
 * · caret 用 chevron 而不是实心三角 —— 后者在 8px 尺寸下是一个黑点。
 *
 * ## ★ 单个选项时不渲染成可点的控件
 *
 * 仍然显示（它回答"这些数字是哪来的"，那个问题在单渠道时同样存在），
 * 但不给下拉：点开只有一项的菜单是假的可配置性，而用户点一次就学会不再点。
 *
 * ## ★ `unsupported` 是给「选了但那个渠道还不支持」用的
 *
 * 数字分身只在主渠道工作（其余是只读接入）。那一处需要"能选中、但选中后
 * 页面说明为什么" —— 所以这里允许某项**可选中而不可用**。不在这里挡住选择：
 * 挡住的话用户不知道为什么，而藏起来的话"它连上了怎么不在这儿"没有答案。
 */
import { DropdownMenu, DropdownMenuItem, cn } from "@mycontext/design"
import { CHANNEL_BRAND_ICONS } from "../channels/channel-icons.js"

export interface ChannelPickerOption {
  id: string
  label: string
  /** 这一项当前不可用（如数字分身不支持飞书）。仍可选中 —— 见文件头。 */
  unsupported?: boolean
}

export interface ChannelPickerProps {
  options: readonly ChannelPickerOption[]
  activeId: string | null
  onChange: (id: string) => void
  /** 无障碍标签（各使用位置语义不同：看哪个渠道 / 检索哪个渠道…）。 */
  ariaLabel: string
  /** 左侧前缀文字（如「检索范围」）。不给则只显示当前值。 */
  prefix?: string
  /**
   * 浮层往哪边开。**默认往下**（`"bottom"`）。
   *
   * ★★ 必须显式传：`DropdownMenu` 自己的默认是 `"top"`（那是给页面**底部**
   * 的触发器准备的），而这个 picker 全部在页面上半部 —— 不传就会向上开，
   * 表现是"菜单往标题栏方向飞出去"。
   *
   * 只有触发器贴着视口底部时才该给 `"top"`。
   */
  side?: "top" | "bottom"
  className?: string
}

/** 品牌图标。★ 保留官方色，不套 currentColor —— 品牌色是识别的一部分。 */
function BrandIcon({ id, className }: { id: string; className?: string }) {
  const Icon = CHANNEL_BRAND_ICONS[id]
  if (Icon === undefined) return null
  return <Icon className={cn("size-3.5 shrink-0 rounded-[4px]", className)} />
}

/** 收起态与菜单项共用的「图标 + 名字」。 */
function ChannelFace({ option }: { option: ChannelPickerOption }) {
  return (
    <>
      <BrandIcon id={option.id} />
      <span className="truncate">{option.label}</span>
    </>
  )
}

export function ChannelPicker({
  options,
  activeId,
  onChange,
  ariaLabel,
  prefix,
  side = "bottom",
  className,
}: ChannelPickerProps) {
  if (options[0] === undefined) return null
  const active = options.find((item) => item.id === activeId) ?? options[0]

  const prefixNode =
    prefix === undefined ? null : (
      <span className="typography-caption-400 shrink-0 text-[var(--text-base-tertiary)]">
        {prefix}
      </span>
    )

  // 单个：静态标识，不做下拉（见文件头）
  if (options.length === 1) {
    return (
      <span className={cn("inline-flex items-center gap-1.5", className)}>
        {prefixNode}
        <span className="typography-body-small-400 inline-flex items-center gap-1.5 text-[var(--text-base-secondary)]">
          <ChannelFace option={active} />
        </span>
      </span>
    )
  }

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      {prefixNode}
      <DropdownMenu
        align="start"
        side={side}
        trigger={({ "aria-expanded": expanded, ...props }) => (
          <button
            {...props}
            aria-expanded={expanded}
            type="button"
            aria-label={ariaLabel}
            className={cn(
              "typography-body-small-400 inline-flex items-center gap-1.5",
              "radius-md px-2 py-1 text-[var(--text-base-primary)]",
              "transition-colors duration-150 ease-out",
              // 无边框：hover/open 时才给一层极淡底色（见文件头）
              expanded
                ? "bg-[var(--overlay-on-container-hover)]"
                : "hover:bg-[var(--overlay-on-container-hover)]",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]",
            )}
          >
            <ChannelFace option={active} />
            {/*
              chevron 而不是实心三角（后者在这个尺寸下是一个黑点），
              `rotate` 跟随展开态 —— "这个面板是我打开的"最便宜的反馈。

              ★ 路径要**在 viewBox 里居中**，不然看着像朝上的。
              前一版是 `M3 4.5 6 7.5 9 4.5`：y 只落在 4.5~7.5，也就是在 12px
              的框里画一个 3px 高的 V —— 视觉重心明显偏上，读起来是个上箭头。
              现在 y 走 4.5→8（高度 3.5、中心 6.25≈框心），且横向留 2.5 边距。
            */}
            <svg
              viewBox="0 0 12 12"
              className={cn(
                "size-3 shrink-0 text-[var(--text-base-tertiary)]",
                "transition-transform duration-150 ease-out",
                expanded ? "rotate-180" : "",
              )}
              aria-hidden="true"
            >
              <path
                d="M2.5 4.75 6 8.25 9.5 4.75"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      >
        {options.map((option) => (
          <DropdownMenuItem
            key={option.id}
            onSelect={() => onChange(option.id)}
            icon={<BrandIcon id={option.id} />}
            /**
             * ★ 选中态用**对勾**而不是给整行加底色：菜单项的底色在这套 token
             * 里已经是 hover 的语义，两者共用一个信号会让"我悬停在哪"和
             * "当前是哪个"分不开。
             */
            trailing={
              option.id === active.id ? (
                <svg viewBox="0 0 12 12" className="size-3" aria-hidden="true">
                  <path
                    d="M2.5 6.5 5 9l4.5-6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : undefined
            }
          >
            <span className="inline-flex items-baseline gap-1.5">
              <span className="truncate">{option.label}</span>
              {/*
                「暂未支持」标在选项上而不是把它禁掉 —— 禁掉的话用户不知道
                为什么，而选中之后由调用方的页面解释后果。
              */}
              {option.unsupported === true ? (
                <span className="typography-caption-400 shrink-0 text-[var(--text-base-tertiary)]">
                  暂未支持
                </span>
              ) : null}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenu>
    </span>
  )
}
