/**
 * 仪表盘的展示原语。
 *
 * ## 这个文件为什么存在
 *
 * 仪表盘上的数字来自四条完全不同的链路，而它们的**外观必须一致** ——
 * 写在各自的板块里时，"这一组的数字为什么比那一组小一号"会随改动慢慢跑偏。
 *
 * ## ★ 视觉规格不是审美偏好，是有出处的
 *
 * 下面的尺寸与间距按数据可视化规范定（见 `dataviz` skill 的
 * `marks-and-anatomy.md`）：
 *
 * · 条形 **≤24px 厚**（不填满槽位，剩下的留白）；
 * · **数据端 4px 圆角、基线端方角** —— 圆角标记"这一端是值"；
 * · 相邻条之间 **2px 表面色间隔**（用留白分隔，不画边框）；
 * · 轨道是**同色系的浅步进**，不是灰 —— 于是"填了多少"在整条上都读得出；
 * · 网格/轴线一律 hairline 且不虚线（虚线是噪声）。
 *
 * ## ★ 大数字用**比例数字**，不用 tabular-nums
 *
 * 规范里写得很直白：`tabular-nums` 让每个数字都占 `0` 的宽度，
 * 大字号下 `121` 会显得松散。它只该用于**需要纵向对齐的列**
 * （表格行、轴刻度）—— 而 stat tile 的值是单独一个数，不需要对齐。
 *
 * 这是对首版的一处修正：那时给 tile 的值套了 `tabular-nums`。
 *
 * ## ★ 排版类只能用**真实存在**的那几个
 *
 * `packages/design` 的排版组合类是一张固定表（title-large/base/small、
 * body-base/large/small、caption）。首版这一页写的是
 * `typography-heading-md-600` / `typography-body-xs-400` 这类**不存在**的名字
 * —— Tailwind 不认识它们，于是那几行样式**静默失效**，所有数字都退回
 * 浏览器默认字号。这正是"看起来很丑"的直接原因，而它不报任何错。
 *
 * 所以：能用 token 的用 token；token 表里没有的字号（stat tile 的 28px、
 * hero 的 48px）写显式 `text-[NNpx]` —— 那是**明确的**，
 * 而不是一个看起来像 token 的假名字。
 */
import type { ReactNode } from "react"
import { Panel, cn, type PanelTone } from "@mycontext/design"

/**
 * 指标的语气。
 *
 * ★ `muted` 是给「这个数字现在没有意义」用的（还没采集时的"落后 0 条"）——
 * 它与 `0` 不是一回事：0 是一个真实的、好的值，而"没有意义"是没有值。
 * 两者同样式的话，一个空系统看起来会像一个健康系统。
 */
export type MetricTone = "neutral" | "good" | "warn" | "bad" | "muted"

const TONE_VALUE: Record<MetricTone, string> = {
  neutral: "text-[var(--text-base-primary)]",
  good: "text-[var(--status-success)]",
  warn: "text-[var(--status-warning)]",
  bad: "text-[var(--status-error)]",
  muted: "text-[var(--text-base-tertiary)]",
}

export interface StatTileProps {
  /** 句子式大小写，不带尾冒号 */
  label: string
  /** 主数字。已格式化 —— 千分位/单位的口径留在调用方一处 */
  value: string
  /** 副文本：单位、口径，或"为什么是这个值" */
  hint?: string
  tone?: MetricTone
  /** 右上角小标（如「实时」） */
  badge?: string
  /**
   * 容器层级。**与 `tone` 是两个维度**，不要混。
   *
   * · `tone` 说的是**数值语气**（这个数字是好的/该警觉的）；
   * · `surface` 说的是**它待在哪一层**（凹槽 / 独立一张卡）。
   *
   * ## ★ 默认是 `sunken`（凹槽），这个默认值被改过一次
   *
   * 原来默认 `raised`，于是分身卡里那四个数字与承载它们的卡是**同一个
   * 色值**（都 `bg-card-z1`，真应用里量到两者都是 `rgb(38,38,38)`）——
   * "框里的框"，只靠 1px 描边区分。
   *
   * 现在这一页的两个场景（分身卡内、去框后直接坐在页面上）**都**该是
   * 凹槽，所以把对的那个设成默认 —— "忘了传"的结果就不再是错的。
   * `raised` 留着给真的需要独立一张卡的地方。
   */
  surface?: PanelTone
}

/**
 * 指标卡。
 *
 * 三级字号对比（label 小而淡 / value 大而实 / hint 更小更淡）是这一页
 * "高级感"的主要来源 —— 不是阴影，也不是渐变。加重的只有数据。
 */
export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
  badge,
  surface = "sunken",
}: StatTileProps) {
  return (
    <Panel
      tone={surface}
      className={cn(
        "group flex min-w-0 flex-col gap-2",
        // hover 只把描边加深一档：一个"它是活的"的信号，而不是动画
        "transition-[box-shadow,background-color] duration-150",
        // ★ hover 反馈跟着层级走：raised 有描边可以加深，sunken 没有描边
        //   （见 panel.tsx），给它 `hover:ring-*` 会**凭空长出**一圈边。
        surface === "sunken"
          ? "hover:bg-[var(--overlay-on-container-hover)]"
          : "hover:ring-[var(--border-medium)]",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="typography-caption-400 truncate text-[var(--text-base-tertiary)]">
          {label}
        </span>
        {badge === undefined ? null : (
          <span className="typography-caption-400 shrink-0 rounded-full bg-[var(--bg-card-z0)] px-2 py-0.5 text-[var(--text-base-tertiary)]">
            {badge}
          </span>
        )}
      </div>
      {/* ★ 比例数字（无 tabular-nums）—— 见文件头 */}
      <span className={cn("typography-figure-base-600", TONE_VALUE[tone])}>{value}</span>
      {hint === undefined ? null : (
        <span className="typography-caption-400 truncate text-[var(--text-base-tertiary)]">
          {hint}
        </span>
      )}
    </Panel>
  )
}

export interface DistributionRow {
  label: string
  value: number
  /** 条的颜色。分类维度传 categorical slot，有序维度传同一 ramp 的步进 */
  color: string
}

export interface DistributionProps {
  rows: readonly DistributionRow[]
  /** 点一行做筛选（可选）。给了就变成可点的 */
  onPick?: (label: string) => void
  /** 当前被选中的那些 label（筛选态的视觉反馈） */
  selected?: ReadonlySet<string>
}

/**
 * 横向分布条。
 *
 * ## 为什么横排而不是饼图或竖排
 *
 * 类目名可以直接写在左边（饼图要么挤在扇形里、要么另起图例），
 * 而我们的类目名是中文短词 —— 横排最省地方也最好读。
 *
 * ## ★ 条的几何按规范定
 *
 * · 高 10px（远低于 24px 上限 —— 这是"细"的那一档，数据才是重的）；
 * · 数据端 4px 圆角、基线端方角；
 * · 轨道用**同色系的浅底**（`color-mix` 与表面混）而不是灰 ——
 *   于是空的那一段也在说"这一行是这个颜色"；
 * · 每行**直接标数值**：这是 relief 规则要求的（浅色主题下 aqua/yellow
 *   等 slot 对比度低于 3:1，验证脚本给了 WARN，必须有可见标签兜住）。
 */
export function Distribution({ rows, onPick, selected }: DistributionProps) {
  const max = rows.reduce((m, r) => (r.value > m ? r.value : m), 0)
  return (
    <div className="flex flex-col">
      {rows.map((row) => {
        const ratio = max === 0 ? 0 : row.value / max
        const active = selected === undefined || selected.size === 0 || selected.has(row.label)
        const Row = onPick === undefined ? "div" : "button"
        return (
          <Row
            key={row.label}
            {...(onPick === undefined
              ? {}
              : {
                  type: "button" as const,
                  onClick: () => onPick(row.label),
                  "aria-pressed": selected?.has(row.label) ?? false,
                })}
            className={cn(
              "flex w-full items-center gap-3 rounded-[var(--radius-sm)] px-1 text-left",
              // 2px 表面色间隔：用留白分隔相邻条，不画边框
              "py-[3px]",
              onPick === undefined
                ? ""
                : "transition-colors duration-150 hover:bg-[var(--overlay-on-container-hover)]",
              // 未选中的整行压暗，而不是把条变灰 —— 颜色跟着实体，不跟着状态
              active ? "" : "opacity-40",
            )}
          >
            <span className="typography-caption-400 w-[92px] shrink-0 truncate text-[var(--text-base-secondary)]">
              {row.label}
            </span>
            {/* 轨道：同色系浅底。`color-mix` 让它在浅色与暗色下都成立 */}
            <span
              className="relative h-[10px] min-w-0 flex-1 overflow-hidden rounded-[2px]"
              style={{ background: `color-mix(in oklab, ${row.color} 12%, transparent)` }}
            >
              {/* 数据端 4px 圆角、基线端方角 */}
              <span
                className="absolute inset-y-0 left-0 rounded-l-[2px] rounded-r-[4px]"
                style={{
                  width: `${String(Math.max(ratio * 100, row.value > 0 ? 1.5 : 0))}%`,
                  background: row.color,
                }}
              />
            </span>
            {/* 直接标数值（relief 规则要求的可见标签）。列对齐 → tabular-nums */}
            <span className="typography-caption-400 w-[52px] shrink-0 text-right tabular-nums text-[var(--text-base-secondary)]">
              {row.value.toLocaleString()}
            </span>
          </Row>
        )
      })}
    </div>
  )
}

export interface SectionProps {
  title: string
  subtitle?: string
  /** 右上角动作（按钮等） */
  action?: ReactNode
  children: ReactNode
  /** 内容是否走四列栅格（数字卡）。false 时原样放（图、列表） */
  grid?: boolean
}

/**
 * 板块外壳。
 *
 * 标题用 `tracking-tight`（收紧字距）—— 那是参考实现里最一致的一个
 * 排版特征，也是"设计过"与"默认样式"最省力的区别。
 *
 * ## ★ 它**故意不**走 `PanelHeader`，尽管两者长得像
 *
 * 收敛容器那一轮我本来打算把这里也换成 `PanelHeader`，查完之后没换 ——
 * 它们是**两个层级**，不是同一个东西的两份实现：
 *
 * · `Section` 是**页面级**分节，标题是 `<h2>` + `title-base-600`。
 *   那个 h2 进文档大纲，读屏器靠它跳转；
 * · `PanelHeader` 是**卡内部**的标题，`<span>` + `body-base-500`
 *   （见它自己的注释：用 heading 号会与页头的层级打架）。
 *
 * 换过去会把一个 h2 悄悄降成 span —— 大纲里少一级，字号也小一档。
 * 而这个 `Section` 也不是一张卡（没有底色与描边，只是标题 + 内容），
 * 所以它连 `Panel` 都不需要。
 *
 * 「两处代码长得像」不等于「它们是同一件事」—— 那是把巧合当成共性。
 */
export function Section({ title, subtitle, action, children, grid = true }: SectionProps) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="typography-title-base-600 tracking-tight text-[var(--text-base-primary)]">
            {title}
          </h2>
          {subtitle === undefined ? null : (
            <p className="typography-caption-400 text-[var(--text-base-tertiary)]">{subtitle}</p>
          )}
        </div>
        {action}
      </div>
      {grid ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>
      ) : (
        <div className="flex flex-col gap-3">{children}</div>
      )}
    </section>
  )
}
