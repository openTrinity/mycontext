/**
 * 渠道相关的界面图标与状态指示。
 *
 * 这里都是我们自绘的界面图标：只用 currentColor 与设计 token，跟随主题变色。
 *
 * 第三方**品牌标识**不在这里——那些是官方资产，放
 * `packages/design/src/assets/brands/`，由 `pnpm sync:brand-icons` 生成组件，
 * 并保留官方品牌色。自己描摹品牌标识既不准确也是商标风险。
 */

/**
 * 钉钉品牌识别色。
 *
 * 取自官方标识 SVG（assets/brands/dingtalk.svg 的底色），
 * 因此与徽标里的蓝完全一致——两处各写一个近似值会看出色差。
 * 刻意硬编码、不走语义 token：换暗色主题也不该让它变个颜色。
 */
export const DINGTALK_BRAND = "#0074FF"

/** 应用自身标识（连接关系图里的左侧） */
export function AppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M12 2.6c3.45 3.83 5.93 7.05 5.93 10.2A5.93 5.93 0 0 1 12 18.73a5.93 5.93 0 0 1-5.93-5.93c0-3.15 2.48-6.37 5.93-10.2Z"
        fill="currentColor"
        fillOpacity="0.92"
      />
      <path
        d="M9.8 8.55c-1.13 1.5-1.73 2.93-1.73 4.28 0 .45.04.9.15 1.28"
        stroke="currentColor"
        strokeOpacity="0.35"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function CheckCircleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <path
        d="M5 8.2 7 10.2l4-4.4"
        stroke="var(--bg-card-z1)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function ExchangeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M2.5 5.5h9l-2-2M13.5 10.5h-9l2 2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M8 1.8l4.8 1.7v4.1c0 3-2 5.3-4.8 6.3-2.8-1-4.8-3.3-4.8-6.3V3.5L8 1.8Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M5.9 8.1 7.4 9.6l3-3.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function KeyIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <circle cx="6" cy="6" r="3.2" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8.3 8.3 13 13M11 11l-1.2 1.2M13 9l-1.2 1.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function ToolsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M9.8 2.6a3 3 0 0 0 3.6 3.6l-6 6a3 3 0 0 1-3.6-3.6l6-6Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}
