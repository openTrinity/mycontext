/**
 * ShinyText — running 态文字的高光扫过。
 *
 * ## 为什么是这种实现
 *
 * 移植参考实现的做法：**rAF 只改 DOM 的 `background-position`，不触发 React
 * 重渲染**。这一点是刻意的 —— 流式回答期间可能有好几行同时在 running，
 * 若每帧 setState，React 每帧要 reconcile 整条事件流（而事件流本身正在
 * 逐 token 增长），实测就是那种"越答越卡"。
 *
 * 效果本身是 `linear-gradient` + `background-clip:text`：文字被裁成渐变的窗口，
 * 移动 `background-position` 就得到一条光带从左扫到右。
 *
 * `prefers-reduced-motion` 与 `disabled` 下回退为纯色文字（不保留透明裁剪态 ——
 * 那会让文字彻底看不见，是移植时最容易踩的坑）。
 */
import { useEffect, useRef } from "react"
import { cn } from "@mycontext/design"
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion.js"

export interface ShinyTextProps {
  text: string
  /** 一次扫过的时长（秒） */
  speed?: number
  /** 两次扫过之间的停顿（秒） */
  delay?: number
  className?: string
  /** 基础字色（CSS 颜色值，通常传 design token 的 var()） */
  color?: string
  /** 光带最亮处的颜色 */
  shineColor?: string
  /** 渐变角度 */
  spread?: number
  disabled?: boolean
}

export function ShinyText({
  text,
  speed = 2,
  delay = 0,
  className,
  color = "var(--text-base-tertiary)",
  shineColor = "var(--text-base-primary)",
  spread = 120,
  disabled = false,
}: ShinyTextProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const reduceMotion = usePrefersReducedMotion()
  const still = disabled || reduceMotion

  useEffect(() => {
    const element = ref.current
    if (element === null || still) return

    const duration = Math.max(speed, 0.01) * 1000
    const pause = Math.max(delay, 0) * 1000
    let elapsed = 0
    let lastFrame: number | null = null
    let frame = 0

    // 150% → -50%：光带从右侧外面进来、扫到左侧外面去。
    const setProgress = (progress: number): void => {
      element.style.backgroundPosition = `${150 - progress * 2}% center`
    }
    setProgress(0)

    const tick = (time: number): void => {
      if (lastFrame === null) {
        lastFrame = time
        frame = requestAnimationFrame(tick)
        return
      }
      elapsed += time - lastFrame
      lastFrame = time

      const cycle = duration + pause
      const inCycle = elapsed % cycle
      setProgress(inCycle < duration ? (inCycle / duration) * 100 : 100)
      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [speed, delay, still])

  return (
    <span
      ref={ref}
      className={cn("inline-block", className)}
      // 静止态**必须**把字色写回来：只留裁剪态会让文字透明到看不见。
      style={
        still
          ? { color, WebkitTextFillColor: color }
          : {
              backgroundImage: `linear-gradient(${String(spread)}deg, ${color} 0%, ${color} 35%, ${shineColor} 50%, ${color} 65%, ${color} 100%)`,
              backgroundPosition: "150% center",
              backgroundSize: "200% auto",
              backgroundClip: "text",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }
      }
    >
      {text}
    </span>
  )
}
