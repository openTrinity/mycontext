/**
 * AmbientRings — 登录页右侧品牌氛围面板。
 *
 * 纯 CSS/SVG 实现的扩散光环：不引 WebGL/three.js。
 * 登录页是应用的第一屏，为一个装饰动效拉进渲染引擎会拖慢首屏并增加包体与崩溃面。
 *
 * prefers-reduced-motion 下停止动画（保留静态构图）。
 */
import { cn } from "../lib/cn.js"

export interface AmbientRingsProps {
  className?: string
  /** 光环数量 */
  rings?: number
}

export function AmbientRings({ className, rings = 5 }: AmbientRingsProps) {
  return (
    <div
      className={cn("pointer-events-none relative overflow-hidden", className)}
      aria-hidden="true"
    >
      <style>{`
        @keyframes mycontext-ring-expand {
          0%   { transform: scale(0.35); opacity: 0; }
          18%  { opacity: 0.55; }
          100% { transform: scale(1.7); opacity: 0; }
        }
        .mycontext-ring {
          position: absolute;
          left: 50%;
          top: 50%;
          border-radius: 9999px;
          border: 1px solid var(--brand-brand-30);
          translate: -50% -50%;
          animation: mycontext-ring-expand 5.2s cubic-bezier(0.22, 0.61, 0.36, 1) infinite;
        }
        .mycontext-glow {
          position: absolute;
          left: 50%;
          top: 50%;
          translate: -50% -50%;
          border-radius: 9999px;
          background: radial-gradient(circle, var(--brand-brand-20) 0%, transparent 68%);
          filter: blur(18px);
        }
        @media (prefers-reduced-motion: reduce) {
          .mycontext-ring { animation: none; opacity: 0.28; }
        }
      `}</style>
      <div className="mycontext-glow size-[280px]" />
      {Array.from({ length: rings }, (_, index) => (
        <div
          key={index}
          className="mycontext-ring size-[220px]"
          style={{ animationDelay: `${(index * 5.2) / rings}s` }}
        />
      ))}
    </div>
  )
}
