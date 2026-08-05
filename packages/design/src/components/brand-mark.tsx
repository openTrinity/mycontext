/**
 * BrandMark — MyContext 自有标识。
 *
 * 纯 SVG：墨滴 + 笔画的抽象组合（inkling = 墨迹/初念）。
 * currentColor 取色，因此可直接放在任意背景上由外层控制颜色。
 */
import { cn } from "../lib/cn.js"

export interface BrandMarkProps {
  className?: string
  /** 边长（px） */
  size?: number
}

export function BrandMark({ className, size = 32 }: BrandMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={cn("shrink-0", className)}
      role="img"
      aria-label="MyContext"
    >
      {/* 墨滴主体 */}
      <path
        d="M16 3.5c4.6 5.1 7.9 9.4 7.9 13.6 0 4.6-3.5 8-7.9 8s-7.9-3.4-7.9-8c0-4.2 3.3-8.5 7.9-13.6Z"
        fill="currentColor"
        fillOpacity="0.92"
      />
      {/* 高光：让墨滴有体积感 */}
      <path
        d="M13.1 11.4c-1.5 2-2.3 3.9-2.3 5.7 0 .6.1 1.2.2 1.7"
        stroke="currentColor"
        strokeOpacity="0.35"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      {/* 笔画：向右下延伸的书写轨迹 */}
      <path
        d="M6.5 27.5c4-1.4 7.6-2.1 10.8-2.1 3.2 0 6 .5 8.2 1.4"
        stroke="currentColor"
        strokeOpacity="0.55"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}
