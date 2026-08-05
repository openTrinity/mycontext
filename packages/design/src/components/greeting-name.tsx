/**
 * GreetingName — 用户名的 hover 彩蛋。
 *
 * 移植自参考实现的欢迎区：hover 时用户名交叉滑出、颜文字滑入，
 * 带 blur 与轻微横向缩放。这是需求点名要的那个效果。
 *
 * 三个实现细节值得留意（照抄外观时最容易丢掉的部分）：
 *
 * 1. **用 `inline-grid` 把两层叠在同一格**（都是 `col-start-1 row-start-1`），
 *    而不是绝对定位。这样容器宽度由内容决定，且切换时不会跳动。
 * 2. 额外放两个 `invisible` 的度量层（名字 + 最长的颜文字），
 *    容器宽度取两者的较大值 —— 否则 hover 瞬间宽度会突变，
 *    右侧的兄弟元素跟着抖一下。
 * 3. `transformOrigin: left center` + `willChange`：
 *    从左侧展开而不是居中缩放，视觉上更像"名字被换掉"而不是"整块在缩放"。
 *
 * 无障碍：`useReducedMotion` 为真时不做位移与模糊（只切换内容），
 * 尊重系统的"减少动态效果"设置。
 */
import { useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { cn } from "../lib/cn.js"

/**
 * 颜文字池。
 *
 * 刻意用纯 ASCII/kaomoji 而不是 emoji：emoji 的字形随平台变化，
 * 而这个彩蛋的趣味恰恰在于等宽字体下的字符画。
 */
const FUN_FACES = ["¯\\_(ツ)_/¯", "(⌐■_■)", "ʕ•ᴥ•ʔ", "\\ (•◡•) /", "(>‿<)", "ᕙ(⇀‸↼‶)ᕗ"] as const

/** 度量用的最长颜文字：容器宽度要能容纳它，否则 hover 时会突然变宽。 */
const WIDEST_FACE = "ᕙ(⇀‸↼‶)ᕗ"

const SWAP_TRANSITION = {
  duration: 0.34,
  ease: [0.16, 1, 0.3, 1] as const,
}

export interface GreetingNameProps {
  name: string
  className?: string
}

export function GreetingName({ name, className }: GreetingNameProps) {
  const reduceMotion = useReducedMotion() ?? false
  const [hovering, setHovering] = useState(false)
  const [faceIndex, setFaceIndex] = useState(0)

  /**
   * 换一个**不同于当前**的颜文字。
   *
   * 不去重的话有 1/6 概率抽到同一个，用户会看到"动画播了但没变" ——
   * 那看起来像卡了一下，而不像彩蛋。
   */
  const pickNextFace = (): void => {
    if (FUN_FACES.length <= 1) return
    let next = Math.floor(Math.random() * FUN_FACES.length)
    while (next === faceIndex) next = Math.floor(Math.random() * FUN_FACES.length)
    setFaceIndex(next)
  }

  const enter = (): void => {
    pickNextFace()
    setHovering(true)
  }

  // 减少动态效果时：不位移不模糊，直接切内容。
  const variants = reduceMotion
    ? {
        initial: { opacity: 1 },
        animate: { opacity: 1 },
        exit: { opacity: 1 },
      }
    : null

  return (
    <span
      className={cn(
        "relative -ml-2 inline-grid h-8 min-w-0 max-w-[60vw] cursor-pointer items-center",
        "overflow-hidden rounded-[var(--radius-lg)] px-2 transition-colors duration-200",
        "hover:bg-[var(--overlay-on-container-hover)] active:bg-[var(--overlay-on-container-pressed)]",
        "sm:max-w-96",
        className,
      )}
      dir="auto"
      data-testid="greeting-name"
      data-hovering={hovering ? "true" : "false"}
      // 当前选中的颜文字。暴露它是为了让「每次换一个不同的」可测 ——
      // 从 textContent 里反推不可靠：退场动画期间两层同时在 DOM 里，
      // 而度量层还常驻着一个固定的颜文字。
      data-face={FUN_FACES[faceIndex]}
      onMouseEnter={enter}
      onMouseLeave={() => setHovering(false)}
      onFocus={enter}
      onBlur={() => setHovering(false)}
      // 键盘可达：这是个纯装饰性彩蛋，但既然能 hover 触发就该能聚焦触发
      tabIndex={0}
    >
      {/* 度量层 ①：名字本身 */}
      <span
        aria-hidden="true"
        className="invisible col-start-1 row-start-1 flex min-w-0 max-w-full items-center font-semibold"
      >
        <span className="min-w-0 truncate">{name}</span>
      </span>
      {/* 度量层 ②：最长的颜文字。两层取大者 = 容器宽度不会因 hover 突变 */}
      <span
        aria-hidden="true"
        className="font-mono-token invisible col-start-1 row-start-1 whitespace-nowrap text-[0.85em]"
      >
        {WIDEST_FACE}
      </span>

      <AnimatePresence initial={false}>
        {hovering ? (
          <motion.span
            key="face"
            className="font-mono-token col-start-1 row-start-1 whitespace-nowrap text-[0.85em] font-bold text-[var(--text-base-secondary)]"
            initial={
              variants?.initial ?? { x: -11, opacity: 0, filter: "blur(10px)", scaleX: 1.14 }
            }
            animate={variants?.animate ?? { x: 0, opacity: 1, filter: "blur(0px)", scaleX: 1 }}
            exit={variants?.exit ?? { x: 10, opacity: 0, filter: "blur(9px)", scaleX: 1.12 }}
            transition={reduceMotion ? { duration: 0 } : SWAP_TRANSITION}
            style={{ transformOrigin: "left center", willChange: "transform, filter, opacity" }}
          >
            {FUN_FACES[faceIndex]}
          </motion.span>
        ) : (
          <motion.span
            key="name"
            className="col-start-1 row-start-1 flex min-w-0 max-w-full items-center font-semibold"
            initial={variants?.initial ?? { x: 11, opacity: 0, filter: "blur(10px)", scaleX: 1.14 }}
            animate={variants?.animate ?? { x: 0, opacity: 1, filter: "blur(0px)", scaleX: 1 }}
            exit={variants?.exit ?? { x: -10, opacity: 0, filter: "blur(9px)", scaleX: 1.12 }}
            transition={reduceMotion ? { duration: 0 } : SWAP_TRANSITION}
            style={{ transformOrigin: "left center", willChange: "transform, filter, opacity" }}
          >
            <span className="min-w-0 truncate">{name}</span>
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  )
}

/** 供测试与其它组件复用（例如"再随机一个"按钮）。 */
export { FUN_FACES }
