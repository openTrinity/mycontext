/**
 * 工具语义图标集。
 *
 * 参考实现的图标来自它自己的内部 UI 包（基于第三方图标库），按工具名匹配。
 * 我们**不搬那个包**（商标 + 依赖），但搬它的**语义**：一个工具该长什么样
 * ——「执行命令」是终端提示符、「读取文件」是文档、「搜索」是放大镜。
 * 图标是"这一步在做什么"的第一眼线索，比状态字更快被读到。
 *
 * 自绘 SVG，16 viewBox / 1.6 描边 / currentColor 取色，与 `features/shell/icons.tsx`
 * 的规范一致（那里是 1.4，这里给 1.6：工具行的图标只有 16px 且常态是三级灰，
 * 1.4 在暗色下会细到看不出形状）。
 */
import type { ReactNode } from "react"

interface IconProps {
  className?: string | undefined
}

const BASE = "size-4 shrink-0"

function Svg({ children, className }: { children: ReactNode; className?: string | undefined }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={className ?? BASE}
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      stroke="currentColor"
    >
      {children}
    </svg>
  )
}

/** 执行命令：终端提示符 `>_`。 */
export function TerminalIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2" />
      <path d="M4.8 6.6 6.6 8.4 4.8 10.2M8.6 10.4h2.6" />
    </Svg>
  )
}

/** 读取文件：文档 + 折角。 */
export function FileTextIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M9.2 1.8H4.4a1.6 1.6 0 0 0-1.6 1.6v9.2a1.6 1.6 0 0 0 1.6 1.6h7.2a1.6 1.6 0 0 0 1.6-1.6V5.8Z" />
      <path d="M9.2 1.8v4h4M5.6 9h4.8M5.6 11.4h3.2" />
    </Svg>
  )
}

/** 修改文件：铅笔。 */
export function PencilIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M11.1 2.3a1.6 1.6 0 0 1 2.26 2.26l-7.3 7.3-3.06.8.8-3.06Z" />
      <path d="M9.9 3.5l2.6 2.6" />
    </Svg>
  )
}

/** 搜索内容：放大镜。 */
export function SearchIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="7.2" cy="7.2" r="4.4" />
      <path d="M10.5 10.5l3 3" />
    </Svg>
  )
}

/** 获取网页：地球。 */
export function GlobeIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M1.8 8h12.4M8 1.8c1.6 1.7 2.5 3.9 2.5 6.2S9.6 12.5 8 14.2C6.4 12.5 5.5 10.3 5.5 8S6.4 3.5 8 1.8Z" />
    </Svg>
  )
}

/** 分析问题 / 思考：灯泡。 */
export function LightbulbIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M6.4 12.4a4.2 4.2 0 1 1 3.2 0" />
      <path d="M6.4 12.4v1a1.2 1.2 0 0 0 1.2 1.2h.8a1.2 1.2 0 0 0 1.2-1.2v-1M6.4 12.4h3.2" />
    </Svg>
  )
}

/** 使用技能：拼图块（参考实现的 IconSkill 同语义）。 */
export function SkillIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M6.4 2.4a1.4 1.4 0 0 1 2.8 0v.8h2a1.2 1.2 0 0 1 1.2 1.2v2h.8a1.4 1.4 0 0 1 0 2.8h-.8v2a1.2 1.2 0 0 1-1.2 1.2h-2v-.8a1.4 1.4 0 0 0-2.8 0v.8h-2a1.2 1.2 0 0 1-1.2-1.2v-2h-.8a1.4 1.4 0 0 1 0-2.8h.8v-2A1.2 1.2 0 0 1 4.4 3.2h2Z" />
    </Svg>
  )
}

/** 知识图谱：三节点连边（mycontext 自己的语义，参考实现没有对应项）。 */
export function GraphIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="8" cy="3.4" r="1.7" />
      <circle cx="3.4" cy="12" r="1.7" />
      <circle cx="12.6" cy="12" r="1.7" />
      <path d="M6.7 4.7 4.4 10.4M9.3 4.7l2.3 5.7" />
    </Svg>
  )
}

/** 失败：圆圈叉。 */
export function CircleXIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M10 6 6 10M6 6l4 4" />
    </Svg>
  )
}

/** 取消：禁止符。 */
export function BanIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M3.6 3.6l8.8 8.8" />
    </Svg>
  )
}

/** 跳过：快进条。 */
export function SkipForwardIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M3.4 3.6l6 4.4-6 4.4z" />
      <path d="M12.4 3.6v8.8" />
    </Svg>
  )
}

/** 兜底：扳手。 */
export function WrenchIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M9.6 6.4a2.6 2.6 0 1 1 3.2-3.9l-2 2 1.7 1.7 2-2a2.6 2.6 0 0 1-3.9 3.2l-4 4a1.6 1.6 0 1 1-2.3-2.3z" />
    </Svg>
  )
}

/** 折叠箭头（chevron-down；由调用方旋转）。 */
export function ChevronDownIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={className ?? "size-3.5 shrink-0"}
    >
      <path
        d="M4 6.2l4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
