/**
 * WelcomeHeader — 欢迎区的标题与描述。
 *
 * 移植的是**动效结构**（stagger + 上浮 + 去模糊），不是品牌资产：
 * 参考实现里的 logo / GIF / CDN 资源解析一概不搬（商标 + 体积 + 我们有自己的品牌）。
 *
 * 问候语按小时分段由调用方决定（它需要知道语言与用户名），
 * 这里只负责渲染与动效 —— 组件不该知道"早上好"这三个字怎么来的。
 */
import type { ReactNode } from "react"
import { motion, useReducedMotion } from "framer-motion"
import { cn } from "../lib/cn.js"

const COPY_VARIANTS = {
  hidden: { opacity: 0, y: 12, filter: "blur(8px)" },
  visible: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { type: "spring" as const, damping: 25, stiffness: 120 },
  },
}

const REDUCED_VARIANTS = {
  hidden: { opacity: 1, y: 0, filter: "blur(0px)" },
  visible: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: 0 } },
}

export interface WelcomeHeaderProps {
  /** 主标题。个性化模式下它是问候语前缀（"下午好，"），用户名由 children 提供 */
  title: string
  /** 副标题 */
  description?: string
  /**
   * 标题行尾追加的内容（用来放 GreetingName）。
   *
   * 用 children 而不是 `greetingName?: string`：
   * 前者让 design 包不必知道彩蛋组件的存在，
   * 也让调用方可以换成别的东西（头像、状态点）而不用改这里。
   */
  children?: ReactNode
  /** 变化时重播动效（切换会话/重置输入时用） */
  animationKey?: string | number
  className?: string
}

export function WelcomeHeader({
  title,
  description,
  children,
  animationKey = 0,
  className,
}: WelcomeHeaderProps) {
  const reduceMotion = useReducedMotion() ?? false
  const variants = reduceMotion ? REDUCED_VARIANTS : COPY_VARIANTS

  return (
    <motion.div
      key={animationKey}
      className={cn("flex w-full flex-col gap-[var(--gap-section-sm)]", className)}
      initial="hidden"
      animate="visible"
      variants={{
        hidden: { opacity: 0 },
        visible: {
          opacity: 1,
          // stagger 让标题先出、描述后出。reduceMotion 时同时出现。
          transition: reduceMotion ? { duration: 0 } : { staggerChildren: 0.1, delayChildren: 0.1 },
        },
      }}
    >
      <motion.h1
        variants={variants}
        style={{ willChange: "transform, opacity, filter" }}
        className="typography-title-large-600 flex w-full min-w-0 flex-wrap items-center text-[var(--text-base-primary)]"
      >
        <span className="shrink-0 whitespace-pre">{title}</span>
        {children}
      </motion.h1>
      {description !== undefined && description !== "" && (
        <motion.p
          variants={variants}
          style={{ willChange: "transform, opacity, filter" }}
          className="typography-body-base-400 text-[var(--text-base-secondary)]"
        >
          {description}
        </motion.p>
      )}
    </motion.div>
  )
}

/**
 * 按小时分段的问候语 key。
 *
 * 返回 i18n key 而不是文案：这个函数在 design 包里（不该知道语言），
 * 而调用方本来就有 `t()`。
 *
 * 分段取的是通俗直觉而不是天文定义：凌晨 5 点算"早上"、
 * 下午 6 点算"晚上" —— 用户不会因为 17:59 显示"下午好"而困惑。
 */
export function greetingKeyForHour(hour: number): string {
  if (hour < 5) return "greeting.lateNight"
  if (hour < 12) return "greeting.morning"
  if (hour < 18) return "greeting.afternoon"
  return "greeting.evening"
}
