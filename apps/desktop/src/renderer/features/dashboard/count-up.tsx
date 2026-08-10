/**
 * 数字滚动 —— 从 0 弹到目标值。
 *
 * ## ★ 为什么自己写而不是抄 React Bits 的 `CountUp`
 *
 * 那个库的许可是 **MIT + Commons Clause**（"不得单独售卖、再分发组件本身"），
 * 而本仓库是**源码公开**的（Elastic License 2.0）。把它的文件 copy 进来
 * 等于以 Elastic-2.0 再分发别人 Commons Clause 的代码 —— 那是一个
 * 说不清的授权链。
 *
 * 而它的实现就是 `useMotionValue` + `useSpring` + `useInView` 三个 hook，
 * 本仓库已经有 `framer-motion`（`packages/design` 在用）。所以自己写
 * 三十行，拿到同样的效果，不引入任何许可风险。
 *
 * ## ★ 为什么用 spring 而不是线性补间
 *
 * 线性计数（每帧 +N）到达终值时是**突停**的，读起来像秒表；spring 有
 * 减速尾巴，于是"数字停在这里"这件事本身有个交代。这是那个效果里
 * 唯一有意义的部分 —— 不是速度，是收尾。
 *
 * ## ★ 格式化必须复用 `formatCount`
 *
 * 不用 `toLocaleString()`：分隔符跟随系统区域，同一个数字在不同机器上
 * 长得不一样 —— 截图对不上、门禁也没法断言。那是 `dashboard-data.ts`
 * 里已经锚住的决定，这里只是遵守它。
 */
import { useEffect, useRef, useState } from "react"
import { useInView, useMotionValue, useReducedMotion, useSpring } from "framer-motion"
import { formatCount } from "./dashboard-data.js"

export interface CountUpProps {
  /** 目标值 */
  value: number
  /**
   * 弹簧硬度。默认值调得比 framer 的默认软 ——
   * 大数字（5 位）用默认会抖得像老虎机。
   */
  stiffness?: number
  className?: string
}

/**
 * 滚动到 `value` 的数字。
 *
 * ★ `useReducedMotion` 时**直接显示终值**，不播动画。这是 `design` 包
 * 已有的惯例（见 `greeting-name.tsx`），而且它不只是偏好问题：
 * 前庭功能障碍的用户会因为这类动效不适。
 */
export function CountUp({ value, stiffness = 60, className }: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const reduced = useReducedMotion()
  /**
   * ★ `once: true` —— 只在第一次进入视口时播。
   *
   * 不加的话每次滚动经过都会重播，而这一页是要**反复看**的
   * （用户切周期、点刷新）。一个每次滚过都重新数一遍的数字很快就变成噪声。
   */
  const inView = useInView(ref, { once: true })

  const motion = useMotionValue(0)
  const spring = useSpring(motion, { stiffness, damping: 20, mass: 1 })
  const [shown, setShown] = useState(reduced === true ? value : 0)

  useEffect(() => {
    if (reduced === true) {
      setShown(value)
      return
    }
    if (!inView) return
    motion.set(value)
  }, [inView, motion, reduced, value])

  useEffect(() => {
    if (reduced === true) return
    /**
     * ★ 订阅 spring 而不是在 rAF 里读它：`on("change")` 只在值真的变了时
     * 回调，spring 静止后自动停 —— 而 rAF 循环会一直跑到组件卸载
     * （这一页常驻，那是白烧的 CPU）。
     */
    const unsubscribe = spring.on("change", (latest) => {
      setShown(Math.round(latest))
    })
    return unsubscribe
  }, [reduced, spring])

  return (
    <span ref={ref} className={className}>
      {formatCount(shown)}
    </span>
  )
}
