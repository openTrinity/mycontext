/**
 * `prefers-reduced-motion` 的响应式读取。
 *
 * 全局 CSS 已经把 transition/animation 压到 0.01ms（见 globals.css），
 * 但那管不到**用 JS 驱动的**动效：ShinyText 每帧改 inline style，
 * CSS 那条规则拦不住它。所以 JS 动效必须自己问一次。
 *
 * 不用 design 包的 framer-motion `useReducedMotion`：renderer 目前不直接依赖
 * framer-motion（只有 design 包内部用），为一个布尔值把它拉进 renderer 的
 * 依赖图不值得 —— matchMedia 就是标准答案，10 行。
 */
import { useEffect, useState } from "react"

const QUERY = "(prefers-reduced-motion: reduce)"

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => globalThis.matchMedia !== undefined && globalThis.matchMedia(QUERY).matches,
  )

  useEffect(() => {
    if (globalThis.matchMedia === undefined) return
    const media = globalThis.matchMedia(QUERY)
    const onChange = (): void => setReduced(media.matches)
    // 系统设置可以在运行时改，订阅而不是只读一次。
    media.addEventListener("change", onChange)
    setReduced(media.matches)
    return () => media.removeEventListener("change", onChange)
  }, [])

  return reduced
}
