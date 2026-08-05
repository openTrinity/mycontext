/**
 * BrandWordmark — 文字版标识（字标 + 可选版本标签）。
 *
 * 字标不做成图片：用字体渲染才能跟随主题变色、跟随系统字号缩放，
 * 也不会在 2x/3x 屏之间出现模糊。
 *
 * ## 风格：还原设计稿的「粗黑体 + 描边 BETA」
 *
 * 参考实现的字标是一张**设计好的 SVG**（`mask-image` + `currentColor` 上色）。
 * 我们没有对应的 "MyContext" 资源，所以用字体还原它的三个特征：
 * · 极重字重 + 收紧字距（见 `typography-wordmark`）；
 * · BETA 是**描边胶囊**、全大写、字距**放开** —— 与字标的"收紧"形成对比，
 *   这是设计稿里那个小标签能被看成"附注"而不是"第二个词"的原因；
 * · 两者同色（都吃 `--text-base-primary`），所以整体读起来是一个单元。
 *
 * ★ BETA 刻意**不用** `Tag` 组件：Tag 是**语义状态**标记（info/success/error），
 * 有填充底色。品牌标签不是状态，它是字标的一部分 ——
 * 用 Tag 会让它染上蓝色并与"提示信息"同形（实测首版就是蓝底，与设计稿不符）。
 *
 * ## ★ 墨滴图标默认不渲染
 *
 * 侧栏品牌区**只留字标**：一个不认识的抽象图标不传达任何信息，
 * 而它占掉的横向空间在收起态是稀缺的。产品名本身已经说明「这是什么」，
 * 「BETA」说明「处在什么阶段」—— 图标在这两件事上都是冗余的。
 *
 * `mark` 留成可选：登录页与 onboarding 是**大留白**布局，
 * 那里需要一个视觉锚点，与侧栏的诉求正好相反。
 */
import { cn } from "../lib/cn.js"
import { BrandMark } from "./brand-mark.js"

export interface BrandWordmarkProps {
  className?: string
  /** 墨滴尺寸（px）；仅在 `mark` 为 true 时生效 */
  size?: number
  /**
   * 是否渲染墨滴图标。默认 **false** —— 见文件头。
   * 登录页/onboarding 这类大留白布局传 true。
   */
  mark?: boolean
  /**
   * 版本/阶段标签，如 "Beta"（渲染为全大写）。
   * 不传则不渲染——正式发布后去掉这个 prop 即可，不用改布局。
   */
  tag?: string
}

export function BrandWordmark({ className, size = 20, mark = false, tag }: BrandWordmarkProps) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      {mark ? <BrandMark size={size} className="text-[var(--text-accent-normal)]" /> : null}
      <span className="typography-wordmark min-w-0 truncate text-[var(--text-base-primary)]">
        MyContext
      </span>
      {tag === undefined ? null : (
        /*
          描边胶囊。几个值都是为了还原设计稿里那个小标签：
          · `border` + 透明底 —— 描边而非填充；
          · `uppercase` + 轻微字距 —— 全大写，字距只放开一点点（设计稿里 BETA 四个
 *   字母是**紧凑**的一组，放太开会散成四个独立字母）；
          · 字号压到 9px 但字重给 700 —— 小而不弱（纯变小会看起来像被压扁的正文）。
          `leading-none` 让胶囊高度只由 padding 决定，不受行高影响。
        */
        <span
          className={cn(
            "inline-flex shrink-0 items-center rounded-full border px-[5px] pb-[2px] pt-[3px]",
            "border-[var(--text-base-primary)] text-[var(--text-base-primary)]",
            "text-[10px] font-bold uppercase leading-none tracking-[0.02em]",
          )}
        >
          {tag}
        </span>
      )}
    </span>
  )
}
