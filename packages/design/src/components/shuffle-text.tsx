/**
 * ShuffleText — 逐字「滑条」洗牌：每个字母包在一个 `overflow-hidden` 的窄框里，
 * 框内是一条由若干同字glyph拼成的横条，用 GSAP 把这条滑到位、露出真正的字母。
 * 奇偶错峰 + 方向可选。还原 React Bits 的 `Shuffle`。
 *
 * ## ★ 为什么用真实的 GSAP 但**自己写**，而不是抄 React Bits 的源码文件
 *
 * 与 `count-up.tsx` 同一条纪律：React Bits 是 **MIT + Commons Clause**
 * （"不得单独再分发组件本身"），本仓库**源码公开**（Elastic License 2.0，
 * 可再分发）—— 把它的 .tsx 原样 copy 进来会污染授权链。所以：**依赖**用
 * 用户点名的那两个（`gsap` + `@gsap/react`，见 package.json），**效果**照它的
 * 做法（滑条几何 + 奇偶时间线）重写，是我们自己的集成代码。
 *
 * ## ★ 不引 ScrollTrigger / SplitText 这两个插件
 *
 * · ScrollTrigger 是"滚进视口才播"——侧栏字标**永远在视口里**，那个触发退化成
 *   "挂载即播"，直接在 mount 里跑一次就行，不必为它拉一个滚动插件；
 * · SplitText 是把**已排版**的文本按行/词/字拆开（处理换行）。字标是单行短词，
 *   我自己按字符建 span 就够，也省掉那个插件的加载与它历史上的付费顾虑。
 *
 * ## 无障碍
 *
 * 用 `useReducedMotion`（framer，仓库已依赖）：为真时**不建滑条、不播**，
 * 直接渲染静态文字。文本节点始终是真字符（滑条只是把它包进 per-char span，
 * `textContent` 不变），读屏与选中都正常，不需要额外的 `sr-only` 层。
 */
import { useCallback, useEffect, useRef } from "react"
import { gsap } from "gsap"
import { useGSAP } from "@gsap/react"
import { useReducedMotion } from "framer-motion"
import { cn } from "../lib/cn.js"

export type ShuffleDirection = "left" | "right" | "up" | "down"
export type ShuffleAnimationMode = "evenodd" | "random"

export interface ShuffleTextProps {
  /** 要显示的文字。 */
  text: string
  /** 套在容器上的排版 class（字号/字重/字距等）。 */
  className?: string
  /** 每个字母滑条滑向哪个方向来露出终字。默认 `"right"`。 */
  shuffleDirection?: ShuffleDirection
  /** 单个字母滑动时长（秒）。默认 `0.35`。 */
  duration?: number
  /** GSAP 缓动。默认 `"power3.out"`。 */
  ease?: string
  /** `evenodd` 模式下同组字母之间的错峰（秒）。默认 `0.03`。 */
  stagger?: number
  /** 滑过几个中间 glyph 再落到终字。默认 `1`。 */
  shuffleTimes?: number
  /** 奇偶错峰 / 每条随机延迟。默认 `"evenodd"`。 */
  animationMode?: ShuffleAnimationMode
  /** `random` 模式下每条的最大随机延迟（秒）。默认 `0`。 */
  maxDelay?: number
  /** 无限循环。默认 `false`。 */
  loop?: boolean
  /** 循环之间的间隔（秒）。默认 `0`。 */
  loopDelay?: number
  /**
   * 中间 glyph 的字符集。空串（默认）= 用真字的副本（纯滑动、不换字形）——
   * 这正是 React Bits 默认档的观感。给了字符集才会滑过随机字形。
   */
  scrambleCharset?: string
  /** hover 时（在上一轮播完后）可重播。默认 `true`。 */
  triggerOnHover?: boolean
  /** 挂载时自动播一次。默认 `true`（侧栏字标要一进来就有个亮相）。 */
  runOnMount?: boolean
}

/** 单个字母的滑条：包框 + 内条。 */
interface Strip {
  /** 内条元素（GSAP 平移它） */
  inner: HTMLElement
  /** 起点/终点位移（px），按方向落在 x 或 y */
  start: number
  final: number
}

const HORIZONTAL = new Set<ShuffleDirection>(["left", "right"])

export function ShuffleText({
  text,
  className,
  shuffleDirection = "right",
  duration = 0.35,
  ease = "power3.out",
  stagger = 0.03,
  shuffleTimes = 1,
  animationMode = "evenodd",
  maxDelay = 0,
  loop = false,
  loopDelay = 0,
  scrambleCharset = "",
  triggerOnHover = true,
  runOnMount = true,
}: ShuffleTextProps) {
  const reduceMotion = useReducedMotion() ?? false
  const ref = useRef<HTMLSpanElement>(null)
  const playingRef = useRef(false)

  /**
   * 把容器文本拆成 per-char 的滑条，返回每条的内条 + 位移。
   * DOM 直接操作（不经 React）——文本子节点在挂载期间不会被 React 重渲染，
   * 只要在卸载前还原即可（`restore`）。
   *
   * ## 几何（横向为例，方向 `right`）
   *
   * 内条是一排等宽 glyph，包框只露出一个字宽的窗口。平移 `-i*w` 时窗口正好
   * 显示第 i 个 glyph。`right` 让平移从 `-rolls*w` 滑到 `0`：
   * 起始露出末尾的 scramble、结束露出**第 0 格 = 真字**，中途逐格滑过。
   * `left` 反过来：从 `0` 滑到 `-rolls*w`，真字放在**最后一格**。
   * 竖向把 w 换成 h、把 inline 换成 block，同理。
   */
  const buildStrips = useCallback((): Strip[] => {
    const el = ref.current
    if (el === null) return []
    const chars = Array.from(text)
    const isHorizontal = HORIZONTAL.has(shuffleDirection)
    const forward = shuffleDirection === "right" || shuffleDirection === "down"
    const rolls = Math.max(1, Math.floor(shuffleTimes))
    const font = getComputedStyle(el).fontFamily
    const pickScramble = (fallback: string): string =>
      scrambleCharset === ""
        ? fallback
        : scrambleCharset.charAt(Math.floor(Math.random() * scrambleCharset.length))

    // 清空后逐字重建（还原时把整段文本写回即可）。
    el.textContent = ""
    const strips: Strip[] = []

    for (const ch of chars) {
      // 先量这个字符的盒子（临时 span 拿宽高）。
      const probe = document.createElement("span")
      probe.className = "inline-block"
      probe.style.fontFamily = font
      probe.textContent = ch
      el.appendChild(probe)
      const rect = probe.getBoundingClientRect()
      const w = rect.width
      const h = rect.height
      const cellSize = isHorizontal ? w : h
      // 空格/零宽字符：没有宽度就原样保留，不做滑条。
      if (w === 0) {
        probe.textContent = ch
        continue
      }

      // 包框：只露出一个字宽/字高的窗口。
      const wrap = document.createElement("span")
      wrap.className = "inline-block overflow-hidden align-bottom"
      wrap.style.width = `${w}px`
      if (!isHorizontal) wrap.style.height = `${h}px`

      // 内条：一排（横）或一列（竖）的 glyph。
      const inner = document.createElement("span")
      inner.className = cn(
        "inline-block will-change-transform",
        isHorizontal ? "whitespace-nowrap" : "whitespace-normal",
      )

      const makeCell = (content: string): HTMLElement => {
        const cell = document.createElement("span")
        cell.className = isHorizontal ? "inline-block" : "block"
        cell.style.width = `${w}px`
        cell.style.fontFamily = font
        cell.textContent = content
        return cell
      }

      // forward(right/down)：真字在第 0 格；否则真字在最后一格。中间是 scramble。
      const cells: HTMLElement[] = []
      if (forward) {
        cells.push(makeCell(ch)) // 第 0 格 = 终字
        for (let k = 0; k < rolls; k++) cells.push(makeCell(pickScramble(ch)))
      } else {
        for (let k = 0; k < rolls; k++) cells.push(makeCell(pickScramble(ch)))
        cells.push(makeCell(ch)) // 最后一格 = 终字
      }
      for (const cell of cells) inner.appendChild(cell)

      wrap.appendChild(inner)
      el.replaceChild(wrap, probe)

      // forward：从 -rolls*size 滑到 0；否则从 0 滑到 -rolls*size。
      const startNeg = -rolls * cellSize
      strips.push({ inner, start: forward ? startNeg : 0, final: forward ? 0 : startNeg })
    }
    return strips
  }, [text, shuffleDirection, shuffleTimes, scrambleCharset])

  /** 还原成一段普通文本（卸载 / reduced-motion 前调）。 */
  const restore = useCallback(() => {
    const el = ref.current
    if (el !== null) el.textContent = text
  }, [text])

  const play = useCallback((): gsap.core.Timeline | null => {
    const strips = buildStrips()
    if (strips.length === 0) {
      restore()
      return null
    }
    const isHorizontal = HORIZONTAL.has(shuffleDirection)
    const axis = isHorizontal ? "x" : "y"

    // 初始位移
    for (const s of strips) gsap.set(s.inner, { [axis]: s.start, force3D: true })

    playingRef.current = true
    const tl = gsap.timeline({
      repeat: loop ? -1 : 0,
      repeatDelay: loop ? loopDelay : 0,
      onRepeat: () => {
        for (const s of strips) gsap.set(s.inner, { [axis]: s.start })
      },
      onComplete: () => {
        playingRef.current = false
        if (!loop) restore()
      },
    })

    const tweenTo = (targets: HTMLElement[], at: number): void => {
      tl.to(
        targets,
        {
          [axis]: (i: number, t: Element) => {
            const idx = strips.findIndex((s) => s.inner === t)
            return strips[idx]?.final ?? 0
          },
          duration,
          ease,
          force3D: true,
          stagger: animationMode === "evenodd" ? stagger : 0,
        },
        at,
      )
    }

    if (animationMode === "evenodd") {
      const odd = strips.filter((_, i) => i % 2 === 1).map((s) => s.inner)
      const even = strips.filter((_, i) => i % 2 === 0).map((s) => s.inner)
      const oddTotal = duration + Math.max(0, odd.length - 1) * stagger
      const evenStart = odd.length > 0 ? oddTotal * 0.7 : 0
      if (odd.length > 0) tweenTo(odd, 0)
      if (even.length > 0) tweenTo(even, evenStart)
    } else {
      // random：每条一个随机起播延迟（用索引+位移派生伪随机，避免 Math.random 的不确定）
      strips.forEach((s, i) => {
        const jitter = maxDelay <= 0 ? 0 : ((i * 2654435761) % 1000) / 1000 * maxDelay
        tl.to(s.inner, { [axis]: s.final, duration, ease, force3D: true }, jitter)
      })
    }
    return tl
  }, [
    buildStrips,
    restore,
    shuffleDirection,
    duration,
    ease,
    stagger,
    animationMode,
    maxDelay,
    loop,
    loopDelay,
  ])

  // 挂载即播一次（reduced-motion 时跳过，走静态回退）。
  useGSAP(
    () => {
      if (reduceMotion || text === "") return
      let tl: gsap.core.Timeline | null = null
      if (runOnMount) tl = play()
      return () => {
        tl?.kill()
        restore()
      }
    },
    { dependencies: [reduceMotion, text, runOnMount, play, restore], scope: ref },
  )

  // hover 重播（上一轮播完、且不在播时）。
  useEffect(() => {
    if (reduceMotion || !triggerOnHover) return
    const el = ref.current
    if (el === null) return
    const onEnter = (): void => {
      if (playingRef.current) return
      play()
    }
    el.addEventListener("mouseenter", onEnter)
    return () => el.removeEventListener("mouseenter", onEnter)
  }, [reduceMotion, triggerOnHover, play])

  // reduced-motion 或空文字：静态渲染，不建滑条、不挂 hover。
  if (reduceMotion || text === "") {
    return <span className={className}>{text}</span>
  }

  return (
    <span ref={ref} className={cn("inline-block", className)}>
      {text}
    </span>
  )
}
