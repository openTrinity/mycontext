/**
 * 粒子问候语 —— 「下午好，小王」由一片粒子**飞入聚拢**，随后在**同一层画布上**
 * 凝成**完整的实心黑体字**并冻住；鼠标划过再打散重聚。灵感来自 React Bits 的
 * `ParticleText`。
 *
 * ## ★ 为什么自己写而不是抄 React Bits 的源码
 *
 * 与同目录的 `count-up.tsx` 同一个理由：那个库是 **MIT + Commons Clause**
 * （"不得单独再分发组件本身"），而本仓库**源码公开**（Elastic License 2.0，
 * 可再分发）。把它的文件 copy 进来 = 以可再分发协议再分发别人带
 * Commons Clause 的代码，授权链说不清。所以照它的**做法**重写。
 * 不引入任何新依赖（一块 canvas + rAF 就够）。
 *
 * ## ★★ 只有一层：全程 canvas，静止态就是实心黑体（用户两次反馈的落点）
 *
 * 踩过两版：
 * · 停在散点 → 用户："太稀疏、要完全实体化、类似黑体"；
 * · canvas 点阵层 + DOM 文字层**交叉淡化** → 用户："有两种层次、深浅不一"。
 *   病根是**两个叠加层**：点阵在淡出、文字在淡入，那 480ms 里同时半透明，
 *   看着就是两层不同质感的东西叠着。
 *
 * 现在**自始至终只有 canvas 这一层**：
 * 1. 飞入：画粒子；
 * 2. 凝固：在同一块 canvas 上，粒子淡出的同时用 `fillText` 把**实心字**画上来
 *    —— 因为是同一张画布，合成出来是**一张扁平图**，不存在"两层叠着"；
 * 3. 静止：canvas 上只剩 `fillText` 的实心黑体字，**停掉 rAF 冻住**（稳定、
 *    不漂、不闪，也不烧 CPU）；
 * 4. hover：重新打散→再走 1→3。
 *
 * ## ★ 字体/字号/颜色都从 greeting 的排版 class 量出来
 *
 * 采样与最终 `fillText` 用**同一套** font/color（从 `getComputedStyle` 读，
 * 见 greeting 的 `typography-title-jumbo-600`）——所以 canvas 画出来的实心字
 * 与页面别处的文字同形同色。颜色在挂载时读一次（主题切换后重挂即更新）。
 *
 * ## ★ 无障碍
 *
 * 真文字始终在 DOM 里（`sr-only`，视觉藏掉但读屏可读、可选中/复制），
 * canvas `aria-hidden`。`prefers-reduced-motion` 时**根本不画 canvas**、
 * 也不挂 hover，直接渲染那行普通文字（本身就是实心黑体）——
 * 前庭敏感的用户不被粒子晃到（与 `count-up.tsx` 同一惯例）。
 */
import { useEffect, useRef } from "react"
import { cn } from "@mycontext/design"
import { useReducedMotion } from "framer-motion"

export interface ParticleTextProps {
  /** 要拼出来的整行文字，如「下午好，小王」 */
  text: string
  /**
   * 套在外层 `<span>` 上的 class —— 传 greeting 那一行的排版 class
   * （`typography-title-jumbo-600` 等）。采样字形与 reduced-motion 回退都靠它。
   */
  className?: string
}

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  /** 归属目标（字形采样点，CSS px） */
  tx: number
  ty: number
}

/** 采样步长（px）：越小越密。飞入阶段密一点才读得出字形。 */
const SAMPLE_GAP = 2
/** 采样 alpha 阈值（0-255）：把抗锯齿边缘也算进来，轮廓更连续。 */
const ALPHA_THRESHOLD = 80
/** 归位弹簧 + 阻尼：给一个有减速尾巴的聚拢。 */
const SPRING = 0.06
const FRICTION = 0.84
/** 指针斥力半径（CSS px）与强度 —— 只在飞入阶段有意义。 */
const REPEL_RADIUS = 58
const REPEL_FORCE = 2.4
/** 飞入阶段的粒子边长（CSS px）。 */
const DOT = 2.0
/** 飞入时长（ms）：粒子聚拢到位。 */
const ASSEMBLY_MS = 900
/** 凝固时长（ms）：粒子淡出 + 实心字淡入（同一块 canvas 上）。 */
const SOLIDIFY_MS = 420

export function ParticleText({ text, className }: ParticleTextProps) {
  const reduced = useReducedMotion()
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    // reduced-motion：不画，走下面的真文字回退（本身就是实心黑体）。
    if (reduced === true) return
    if (text === "") return
    const canvas = canvasRef.current
    if (canvas === null) return
    const ctx = canvas.getContext("2d")
    if (ctx === null) return

    // ── 1. 量出真实字体与颜色 ────────────────────────────────
    const probe = document.createElement("span")
    probe.className = className ?? ""
    probe.style.position = "absolute"
    probe.style.visibility = "hidden"
    probe.style.whiteSpace = "pre"
    probe.style.pointerEvents = "none"
    probe.textContent = text
    document.body.appendChild(probe)
    const cs = getComputedStyle(probe)
    const fontSize = Number.parseFloat(cs.fontSize) || 48
    const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    const letterSpacing = cs.letterSpacing === "normal" ? "0px" : cs.letterSpacing
    const color = cs.color
    const measuredWidth = probe.getBoundingClientRect().width
    document.body.removeChild(probe)

    // 画布尺寸：宽=量到的文字宽 + 一点余量；高=字号的 1.3 倍（容标点升降部）。
    const cssW = Math.ceil(measuredWidth) + 4
    const cssH = Math.ceil(fontSize * 1.3)
    const baseline = cssH / 2
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2)
    canvas.width = Math.ceil(cssW * dpr)
    canvas.height = Math.ceil(cssH * dpr)
    canvas.style.width = `${cssW}px`
    canvas.style.height = `${cssH}px`

    // 一个可复用的"把 ctx 设成量到的字体"闭包（采样与最终实心字共用同一套）。
    const applyFont = (c: CanvasRenderingContext2D): void => {
      c.font = font
      try {
        c.letterSpacing = letterSpacing
      } catch {
        /* 老引擎没有这个属性，跳过 */
      }
      c.textBaseline = "middle"
    }

    // ── 2. 离屏采样字形 → 目标点 ──────────────────────────────
    const off = document.createElement("canvas")
    off.width = canvas.width
    off.height = canvas.height
    const octx = off.getContext("2d", { willReadFrequently: true })
    if (octx === null) return
    octx.scale(dpr, dpr)
    octx.fillStyle = "#fff"
    applyFont(octx)
    octx.fillText(text, 0, baseline)

    const image = octx.getImageData(0, 0, off.width, off.height).data
    const particles: Particle[] = []
    const stepPx = Math.max(1, Math.round(SAMPLE_GAP * dpr))
    for (let py = 0; py < off.height; py += stepPx) {
      for (let px = 0; px < off.width; px += stepPx) {
        const alpha = image[(py * off.width + px) * 4 + 3] ?? 0
        if (alpha < ALPHA_THRESHOLD) continue
        particles.push({ x: 0, y: 0, vx: 0, vy: 0, tx: px / dpr, ty: py / dpr })
      }
    }
    if (particles.length === 0) return

    // 把每个粒子甩到四散的随机起点（每一轮飞入/hover 都重新甩）。
    const scatter = (): void => {
      for (const p of particles) {
        const angle = Math.random() * Math.PI * 2
        const dist = 40 + Math.random() * Math.max(cssW, cssH)
        p.x = p.tx + Math.cos(angle) * dist
        p.y = p.ty + Math.sin(angle) * dist
        p.vx = 0
        p.vy = 0
      }
    }

    // ── 3. 指针（挂在容器上：canvas 是 pointer-events-none） ────────
    const surface = canvas.parentElement ?? canvas
    const pointer = { x: -9999, y: -9999, active: false }
    const onMove = (e: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect()
      pointer.x = e.clientX - rect.left
      pointer.y = e.clientY - rect.top
      pointer.active = true
    }
    const onLeave = (): void => {
      pointer.active = false
    }
    surface.addEventListener("pointermove", onMove as EventListener)
    surface.addEventListener("pointerleave", onLeave)

    // ── 4. 一轮动画：飞入 → 凝固成实心字 → 冻住 ───────────────
    ctx.scale(dpr, dpr)
    applyFont(ctx)
    let raf = 0
    let playing = false
    let startAt = 0

    /** 静止帧：canvas 上只画一次实心字，然后不再请求下一帧。 */
    const drawSolid = (): void => {
      ctx.clearRect(0, 0, cssW, cssH)
      ctx.globalAlpha = 1
      ctx.fillStyle = color
      ctx.fillText(text, 0, baseline)
    }

    const tick = (now: number): void => {
      if (startAt === 0) startAt = now
      const elapsed = now - startAt
      // 凝固进度：assembly 结束后从 0 涨到 1。
      const solid = elapsed <= ASSEMBLY_MS ? 0 : Math.min(1, (elapsed - ASSEMBLY_MS) / SOLIDIFY_MS)

      // 物理：弹簧归位 + 指针斥力（凝固阶段斥力渐弱，收束到静止）。
      const repelScale = 1 - solid
      for (const p of particles) {
        p.vx += (p.tx - p.x) * SPRING
        p.vy += (p.ty - p.y) * SPRING
        if (pointer.active && repelScale > 0) {
          const dx = p.x - pointer.x
          const dy = p.y - pointer.y
          const d2 = dx * dx + dy * dy
          if (d2 < REPEL_RADIUS * REPEL_RADIUS && d2 > 0.01) {
            const d = Math.sqrt(d2)
            const f = ((REPEL_RADIUS - d) / REPEL_RADIUS) * REPEL_FORCE * repelScale
            p.vx += (dx / d) * f
            p.vy += (dy / d) * f
          }
        }
        p.vx *= FRICTION
        p.vy *= FRICTION
        p.x += p.vx
        p.y += p.vy
      }

      // 同一块 canvas 上合成：粒子（淡出）+ 实心字（淡入）——一张扁平图，非两层。
      ctx.clearRect(0, 0, cssW, cssH)
      ctx.fillStyle = color
      if (solid < 1) {
        ctx.globalAlpha = 1 - solid
        for (const p of particles) ctx.fillRect(p.x, p.y, DOT, DOT)
      }
      if (solid > 0) {
        ctx.globalAlpha = solid
        ctx.fillText(text, 0, baseline)
      }
      ctx.globalAlpha = 1

      if (solid >= 1) {
        // 凝固完成：画一帧干净的实心字并**冻住**（停 rAF）。
        drawSolid()
        playing = false
        raf = 0
        return
      }
      raf = requestAnimationFrame(tick)
    }

    const run = (): void => {
      if (playing) return
      playing = true
      startAt = 0
      scatter()
      raf = requestAnimationFrame(tick)
    }

    // hover 重播：静止态划过就再来一遍飞入（正在播时忽略，免得抖）。
    const onEnter = (): void => run()
    surface.addEventListener("mouseenter", onEnter)

    // 挂载即播一次。
    run()

    return () => {
      if (raf !== 0) cancelAnimationFrame(raf)
      surface.removeEventListener("pointermove", onMove as EventListener)
      surface.removeEventListener("pointerleave", onLeave)
      surface.removeEventListener("mouseenter", onEnter)
    }
  }, [text, className, reduced])

  // reduced-motion：原样渲染那行字（排版 class 生效，本身就是实心黑体），不出现 canvas。
  if (reduced === true) {
    return <span className={className}>{text}</span>
  }

  return (
    <span className={cn("relative inline-flex items-center", className)}>
      {/* 真文字留给读屏与选中/复制，视觉上藏掉（唯一可见层是下面这块 canvas） */}
      <span className="sr-only">{text}</span>
      <canvas ref={canvasRef} aria-hidden className="block" />
    </span>
  )
}
