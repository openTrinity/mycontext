/**
 * ThinkingIndicator — 「还没有任何输出」那段空窗期的可见反馈。
 *
 * ## 为什么必须有
 *
 * 实测裸 opencode 从发出 prompt 到吐出第一个 token 约 3.8s（spawn→initialize
 * 另需 1.7s，但那是单例懒启动只付一次）。这几秒里事件流是**完全空白**的 ——
 * 用户看不出是在想、卡住了、还是坏了，而"看起来卡住"会让人直接关掉。
 *
 * 首字被 replay 宽限期白扣 5 秒那个 bug 已经单独修了（见 reducer 的
 * `beginTurn`）；剩下的这 3.8s 是模型自身的延迟，改不掉，只能让它可见。
 *
 * ## 三个元素，各自解决一件事
 *
 * · **呼吸三点**：证明"进程活着"。纯 CSS 旋转，不进 React 渲染。
 * · **流光文字**：证明"这一刻仍在推进"（静态文字看久了和卡住无法区分）。
 *   复用已有的 `ShinyText` —— 它用 rAF 只改 DOM 的 background-position，
 *   不触发重渲染（事件流正在逐 token 增长，每帧 setState 会卡）。
 * · **轮播文案**：每 6s 换一句，让"等待"有进展感。**只换文案不换语义** ——
 *   不说"正在查图谱"这种我们并不知道的事（那是在骗用户）。
 *
 * 超过 `EXTENDED_NOTICE_MS` 再补一句"复杂问题要多想一会儿"：这时用户已经开始
 * 怀疑坏了，一句解释比继续沉默有用。
 *
 * `prefers-reduced-motion` 下：不转、不流光、不轮播（只显示第一句），
 * 但**文字必须仍然可见** —— 流光的实现是把字裁成渐变窗口，静止态忘了写回
 * 字色就会全透明（`ShinyText` 内部已处理）。
 */
import { useEffect, useState } from "react"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { ShinyText } from "./shiny-text.js"
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion.js"

/** 轮播间隔。6s：够读完一句，又不至于让人觉得停住了。 */
const ROTATE_INTERVAL_MS = 6_000

/** 多久之后补一句"要多想一会儿"。20s 时用户已经在怀疑坏了。 */
const EXTENDED_NOTICE_MS = 20_000

/** 轮播文案的 i18n key。只描述"在想"，不宣称我们并不知道的具体动作。 */
const MESSAGE_KEYS = [
  "stream.waiting.thinking",
  "stream.waiting.reading",
  "stream.waiting.reasoning",
  "stream.waiting.composing",
] as const

export function ThinkingIndicator() {
  const { t } = useDynamicTranslation()
  const reduceMotion = usePrefersReducedMotion()
  const [index, setIndex] = useState(0)
  const [extended, setExtended] = useState(false)

  // 轮播：reduced-motion 下不换（避免文字反复跳动）。
  useEffect(() => {
    if (reduceMotion) return
    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % MESSAGE_KEYS.length)
    }, ROTATE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [reduceMotion])

  useEffect(() => {
    const timer = setTimeout(() => setExtended(true), EXTENDED_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [])

  const key = MESSAGE_KEYS[index % MESSAGE_KEYS.length] ?? MESSAGE_KEYS[0]

  return (
    <div className="flex flex-col gap-1" aria-live="polite" aria-busy>
      <div className="flex items-center gap-2">
        <ThinkingDots still={reduceMotion} />
        <ShinyText text={t(key)} className="typography-body-small-400" disabled={reduceMotion} />
      </div>
      {extended && (
        <span className="typography-caption-400 pl-6 text-[var(--text-base-tertiary)]">
          {t("stream.waiting.extended")}
        </span>
      )}
    </div>
  )
}

/**
 * 三点呼吸：整体旋转，三个点各自错相位地明暗。
 *
 * 纯 CSS keyframes（不用 framer-motion）：这东西在流式输出期间一直挂着，
 * 而 JS 驱动的动画每帧都要过 React/motion 的调度 —— 那正是"越答越卡"的来源。
 */
function ThinkingDots({ still }: { still: boolean }) {
  return (
    <span
      className="relative block size-4 shrink-0"
      aria-hidden
      style={still ? undefined : { animation: "mycontext-think-rotate 1.2s linear infinite" }}
    >
      <Dot style={{ top: 0, left: "50%", marginLeft: -2 }} delay={0} still={still} />
      <Dot style={{ bottom: 1, left: 1 }} delay={0.4} still={still} />
      <Dot style={{ bottom: 1, right: 1 }} delay={0.8} still={still} />
      <style>{`
        @keyframes mycontext-think-rotate { to { transform: rotate(360deg); } }
        @keyframes mycontext-think-dot { 0%,100% { opacity: .35 } 50% { opacity: 1 } }
        @media (prefers-reduced-motion: reduce) {
          [data-think-dot] { animation: none !important; opacity: .6 !important }
        }
      `}</style>
    </span>
  )
}

function Dot({
  style,
  delay,
  still,
}: {
  style: React.CSSProperties
  delay: number
  still: boolean
}) {
  return (
    <span
      data-think-dot
      className="absolute size-1 rounded-full bg-[var(--text-base-tertiary)]"
      style={{
        ...style,
        ...(still
          ? { opacity: 0.6 }
          : { animation: `mycontext-think-dot 1.2s ease-in-out ${String(delay)}s infinite` }),
      }}
    />
  )
}
