/**
 * StepSection —— 引导页里的一个分区（标题 + 一句说明 + 右上角动作 + 内容）。
 *
 * ## 为什么要分区
 *
 * 一个步骤常常同时管几件事（步骤 3 是时间/会话/资料源，步骤 2 是预设/风格/细节），
 * 而原来它们只靠一行浅色小字分隔 —— 几段内容与它们的说明文字全是同一号字、
 * 同一个层级，读者看到的是一整片没有节奏的文本。给每段一个卡片边界 +
 * 一个比正文重的标题，「这一步要做几件事」才在**扫视**层面成立，
 * 而不是靠逐行读出来。
 *
 * ## ★ 为什么提到这里给四步共用
 *
 * 这个组件原来长在 `sources-step.tsx` 里，只有步骤 3 用。于是四步各排各的：
 * 步骤 1 是居中大图、步骤 2 是裸表单、步骤 3 是三张卡、步骤 4 是左对齐灰字
 * —— 用户反馈的「感觉还是没有啥设计感，可以更有规律的排布」说的正是这个。
 * "有规律"的前提是有一条规律可循，所以先把分区这件事统一。
 *
 * ## 标题层级只有三级
 *
 * 1. 步骤大标题 `title-base-600`（内容区顶部，由 `onboarding-view` 给）；
 * 2. **分区标题 `body-base-500`（就是这里）**；
 * 3. 分区内小标题 `caption-400 font-medium` + tertiary。
 *
 * 标题用 `body-base-500`（比正文重一档）而不是 heading 号：这是步骤**内部**
 * 的分节，不是页面标题 —— 用 heading 会与顶部步骤条的层级打架。
 *
 * ## ★ 卡片与标题行现在走 `Panel` / `PanelHeader`
 *
 * 这两块原来是手抄的类串，而同样一串在这个仓库里有 5 份（仪表盘、图谱、
 * 引导第 1 步各写了一份）。没有一处定义"一张卡长什么样"的话它必然漂移，
 * 而漂移在用户侧的观感就是「割裂」。
 * 视觉一个像素都没变 —— `Panel` 的类串就是从这里取的。
 */
import type { ReactNode } from "react"
import { Panel, PanelHeader, cn } from "@mycontext/design"

export interface StepSectionProps {
  title: string
  /** 一句说明。缺省时不占位（不是渲染一个空行） */
  hint?: string
  /** 右上角的动作区（按钮、计数 + 清空之类） */
  action?: ReactNode
  children: ReactNode
  className?: string
}

export function StepSection({ title, hint, action, children, className }: StepSectionProps) {
  return (
    <Panel as="section" className={cn("flex flex-col gap-[var(--gap-component-md)]", className)}>
      <PanelHeader
        title={title}
        {...(hint === undefined ? {} : { hint })}
        {...(action === undefined ? {} : { action })}
      />
      {children}
    </Panel>
  )
}

/**
 * 分区内的小标题（层级 3）。
 *
 * ## ★ 它存在的直接原因
 *
 * 步骤 2 里最大的那个控件（槽位 tablist + 上百个缩略图）原来**一个标题都没有**
 * —— 于是它读起来像是上面那个标题为「可深度定制」的分组的内容，
 * 而那正是用户说的「层级不对，哪些分类是统一登记的都很不明确」。
 *
 * 与 `StepSection` 的区别：这个**没有卡片边界**。分区已经有边界了，
 * 里面再套卡片会变成"框里的框"。层级靠字重与颜色表达，不靠再加一层容器。
 */
export function SubGroup({
  label,
  action,
  children,
}: {
  label: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="typography-caption-400 font-medium text-[var(--text-base-secondary)]">
          {label}
        </span>
        {action === undefined ? null : <span className="shrink-0">{action}</span>}
      </div>
      {children}
    </div>
  )
}
