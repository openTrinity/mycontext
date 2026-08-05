/**
 * 连续曲率圆角（superellipse / "squircle"）的 clip-path 生成。
 *
 * ## 为什么不用 CSS
 *
 * `corner-shape: squircle` 要 Chromium 139+。Electron 43 带的内核低于那个版本，
 * 于是只能自己算路径喂给 `clip-path: path()`。
 *
 * ## 为什么自己算，而不是拿现成的库
 *
 * 这一份是**从超椭圆方程直接采样**出来的，没有引入任何圆角库：
 *
 *   |x/a|^n + |y/b|^n = 1
 *
 * `n = 2` 是椭圆，`n → ∞` 趋近矩形，`n ≈ 4~5` 就是 iOS 图标那种"方中带圆"的观感。
 * 把四个角各采样若干点、连成一条闭合路径即可 —— 数学是公开的，实现只有几十行，
 * 比引一个库再迁就它的参数模型更好懂，也少一个依赖。
 *
 * ★ 采样而非贝塞尔拟合：贝塞尔要解控制点位置，而 `clip-path` 对顶点数不敏感
 * （浏览器直接光栅化），每角 24 个点在 4K 屏上肉眼已经看不出折线。
 * 顶点数固定，所以路径字符串长度可预期，不会因尺寸变大而膨胀。
 *
 * ## 半径夹紧的那个坑
 *
 * 圆角半径必须夹到 `min(width,height)/2`。不夹的话相邻两角的曲线会**交叉**，
 * 生成的路径自相交 —— 浏览器按 nonzero 填充规则处理，表现是元素中间被挖空
 * 一块。按钮高 28px 而设计稿写 16px 圆角时就会踩到（那不是笔误，是设计上想要
 * "尽量圆"）。夹紧之后自然退化成胶囊形，正是那种情况想要的结果。
 */
import { useCallback, useLayoutEffect, useRef, useState } from "react"
import type { MutableRefObject, Ref } from "react"

/**
 * 把多个 ref 接到同一个节点上。
 *
 * 需要它是因为组件既要把节点交给外部传进来的 ref，又要自己拿着做尺寸观察 ——
 * React 的 ref 属性只能给一个。
 */
export function attachRefs<T>(...targets: Array<Ref<T> | undefined | null>) {
  return (node: T | null): void => {
    for (const target of targets) {
      if (target === null || target === undefined) continue
      if (typeof target === "function") {
        target(node)
        continue
      }
      ;(target as MutableRefObject<T | null>).current = node
    }
  }
}

/** 每个角采样的点数。24 是"肉眼看不出折线"与"路径别太长"的平衡点。 */
const SAMPLES_PER_CORNER = 24

/**
 * 指数 n：控制方形与圆形之间的过渡。
 *
 * 4.2 是对着 iOS 图标轮廓比出来的 —— 3 以下偏圆（接近普通圆角），
 * 6 以上偏方（转折变生硬）。
 */
const SUPERELLIPSE_EXPONENT = 4.2

/**
 * 一个角的偏移序列：从"贴着直边"走到"角的对角线"，共 SAMPLES_PER_CORNER 个点。
 *
 * 模块级算一次并缓存 —— 它只依赖常量，而 clip-path 会随元素尺寸反复重算，
 * 每次重新跑三角函数是白费。
 */
const CORNER_OFFSETS: ReadonlyArray<readonly [number, number]> = Array.from(
  { length: SAMPLES_PER_CORNER + 1 },
  (_unused, index) => {
    // 参数角走 0 → 90°，用超椭圆的参数式取点（cos/sin 各自取 2/n 次幂）
    const theta = (index / SAMPLES_PER_CORNER) * (Math.PI / 2)
    const power = 2 / SUPERELLIPSE_EXPONENT
    const dx = Math.cos(theta) ** power
    const dy = Math.sin(theta) ** power
    return [dx, dy] as const
  },
)

/** 路径里的坐标保留三位小数：再多的精度浏览器也用不上，只让字符串变长。 */
function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * 生成一条闭合的超椭圆圆角矩形路径（SVG path 的 `d`）。
 *
 * 导出它是为了能单独测：给定宽高与半径，路径应当是确定的字符串，
 * 而 hook 那层混着 DOM 与 ResizeObserver，不好断言。
 */
export function superellipsePath(width: number, height: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2))
  if (r === 0)
    return `M 0 0 L ${round(width)} 0 L ${round(width)} ${round(height)} L 0 ${round(height)} Z`

  const points: string[] = []
  /**
   * 四个角，每个给出圆心（角内侧那个点）与两个方向符号。
   * 顺序是右下 → 左下 → 左上 → 右上，让路径整体顺着一个方向走，
   * 否则相邻角之间会出现回头的直线段。
   */
  const corners: ReadonlyArray<readonly [number, number, number, number]> = [
    [width - r, height - r, 1, 1],
    [r, height - r, -1, 1],
    [r, r, -1, -1],
    [width - r, r, 1, -1],
  ]

  for (const [cx, cy, signX, signY] of corners) {
    for (const [dx, dy] of CORNER_OFFSETS) {
      // 每个角内部：signX/signY 决定往哪个象限展开；两个角交替 dx/dy 的主次
      const x = cx + signX * r * (signY === signX ? dx : dy)
      const y = cy + signY * r * (signY === signX ? dy : dx)
      points.push(`${round(x)} ${round(y)}`)
    }
  }

  return `M ${points.join(" L ")} Z`
}

export interface SquircleOptions {
  /** 角半径（px）。会被夹到 min(width,height)/2；传 "full" 即取那个上限（胶囊态）。 */
  radius: number | "full"
  /** false 时不算路径，交由调用方回退到 CSS border-radius。 */
  enabled?: boolean
}

/**
 * 跟随元素尺寸的 squircle clip-path。
 *
 * 返回的 `ref` 要挂到目标元素上（多 ref 场景用 `attachRefs` 合并）。
 * `clipPath` 在尚未测量或 `enabled: false` 时是 undefined —— 调用方据此
 * 决定是否写 style，而不是写一个空串（空串会被当成"裁掉全部"，元素直接消失）。
 */
export function useSquircle<T extends HTMLElement>(options: SquircleOptions) {
  const { radius, enabled = true } = options
  const nodeRef = useRef<T | null>(null)
  const [clipPath, setClipPath] = useState<string | undefined>(undefined)

  const measure = useCallback(() => {
    const node = nodeRef.current
    if (node === null || !enabled) {
      setClipPath(undefined)
      return
    }
    const { width, height } = node.getBoundingClientRect()
    // 尺寸为 0 时不要写路径：那会把元素裁成不可见，且下一帧就会再来一次
    if (width <= 0 || height <= 0) return
    const resolved = radius === "full" ? Math.min(width, height) / 2 : radius
    setClipPath(`path("${superellipsePath(width, height, resolved)}")`)
  }, [enabled, radius])

  const setRef = useCallback(
    (node: T | null) => {
      nodeRef.current = node
      if (node !== null) measure()
    },
    [measure],
  )

  useLayoutEffect(() => {
    const node = nodeRef.current
    if (node === null || !enabled) return
    measure()
    const observer = new ResizeObserver(() => measure())
    observer.observe(node)
    return () => observer.disconnect()
  }, [enabled, measure])

  return { ref: setRef, clipPath }
}
