/**
 * 数据量时序图（面积图）。
 *
 * ## ★★ 这个文件是**唯一**引 recharts 的地方，而且被懒加载
 *
 * 实测（`electron-vite build` 的真实产物，不是估算）：
 *
 * ```
 * trend-chart-*.js   801 KiB raw / 164 KiB gzip   ← 这一整块是延后加载的
 * 首屏 entry         6003 KiB → 6028 KiB          ← 只涨了 25 KiB（0.4%）
 * ```
 *
 * 那 25 KiB 是 recharts 与 renderer 共用的那几个依赖被提到 entry 里
 * （`react-dom` 的 shim、`EventEmitter` 之类）—— 它们本来就在共享图上，
 * 不是 recharts 独有的开销。
 *
 * Electron 从本地磁盘加载，没有网络传输，成本只是**解析**。但仪表盘是
 * 打开应用第一眼看的那一页 —— 首屏多解析 800 KiB 换一张要滚一下才看到的图
 * 不值得。所以调用方用 `React.lazy` 包它（见 `dashboard-module.tsx`）。
 *
 * ★ 因此这里**不能**导出任何非组件的东西 —— 一旦别处 `import { X } from`
 * 这个文件，整个 chunk 就被拉回首屏，懒加载白做。类型除外（编译期擦除）。
 *
 * ★ 验过一次，别再退回去：产物里 `grep -c recharts` 在这个 chunk 里是 75，
 * 在首屏 entry 里是 **0**。改动这个文件的 import 之后要重新量一次。
 *
 * ## 视觉出处
 *
 * 渐变面积 + monotone 平滑 + 只留横向网格 + 无常驻圆点：这套配方来自
 * databuddy 的 Traffic Trends（`components/ui/composables/chart.tsx`）。
 *
 * ★ 一处**刻意偏离**：他们的网格是 `strokeDasharray="2 4"`（虚线），
 * 而本仓库的规范写明「网格/轴线一律 hairline 且**不虚线** —— 虚线是噪声」
 * （见 `primitives.tsx` 文件头）。所以这里用实线 + 低不透明度。
 * 遵守自己的规范比照抄参考实现重要。
 *
 * ## ★ 配色不是挑的
 *
 * 两条线用 `features/graph/palette.ts` 里 `Person` / `System` 两个 slot ——
 * 那两组色跑过 `dataviz` 的 `validate_palette.js`（`ALL CHECKS PASS`，
 * 最差相邻 CVD ΔE 9.1）。改值要重跑那个脚本。
 *
 * 「进了图谱」那条用**中性灰**而不是第三个 slot：它与前两条不是同一个
 * 维度（前两条是消息的方向，它是"这些消息被消化了多少"），
 * 给它一个分类色会让人以为那是第三种消息。
 */
import { useMemo } from "react"
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import type { DashboardTrends } from "@mycontext/ipc-contract"
import { ENTITY_NEUTRAL, entityColor, type ThemeMode } from "../graph/palette.js"
import { formatCount } from "./dashboard-data.js"

export interface TrendChartProps {
  days: DashboardTrends["days"]
  mode: ThemeMode
  /**
   * 图库读不到时不画「进了图谱」那条线。
   *
   * ★ 与"那条线全是 0"必须区分：0 意味着"一条都没消化"（真结论），
   * 而读不到意味着"还没建图"（未知）。画一条贴底的线会把未知说成零。
   */
  showChunks: boolean
  /** 高度。默认 260 —— 与参考实现的 240~280 同档 */
  height?: number
}

interface Row {
  at: number
  inbound: number
  outbound: number
  chunks: number
  /** x 轴标签（预算好，避免 tickFormatter 每帧算一次 Date） */
  label: string
}

/**
 * x 轴日期标签。
 *
 * ★ 手写 `M-D` 而不是 `toLocaleDateString()`：后者跟随系统区域，
 * 同一张图在不同机器上的刻度长得不一样（截图与门禁都对不上）。
 * 与 `formatCount` 同一个理由。
 */
function dayLabel(at: number): string {
  const d = new Date(at)
  return `${String(d.getMonth() + 1)}-${String(d.getDate())}`
}

export default function TrendChart({ days, mode, showChunks, height = 260 }: TrendChartProps) {
  const rows = useMemo<Row[]>(
    () =>
      days.map((d) => ({
        at: d.at,
        inbound: d.inbound,
        outbound: d.outbound,
        chunks: d.chunks,
        label: dayLabel(d.at),
      })),
    [days],
  )

  const inboundColor = entityColor("Person", mode)
  const outboundColor = entityColor("System", mode)
  const chunkColor = ENTITY_NEUTRAL[mode]

  /**
   * 刻度密度：最多 8 个标签。
   *
   * 90 天窗口下每天一个标签会糊成一片灰。`interval` 给 recharts 一个
   * "每隔几个画一个"，而不是让它自己决定（它的默认策略在窄容器下
   * 会直接隐藏大部分标签，于是首尾对不上）。
   */
  const tickInterval = Math.max(0, Math.ceil(rows.length / 8) - 1)

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          {/* 渐变：顶部 0.30 → 底部 0.02。照 databuddy 的取值 */}
          <linearGradient id="mc-trend-inbound" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={inboundColor} stopOpacity={0.3} />
            <stop offset="100%" stopColor={inboundColor} stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="mc-trend-outbound" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={outboundColor} stopOpacity={0.3} />
            <stop offset="100%" stopColor={outboundColor} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        {/* ★ 实线 hairline（不用参考实现的虚线）—— 见文件头 */}
        <CartesianGrid
          stroke="var(--border-divider-light)"
          strokeOpacity={0.6}
          strokeWidth={1}
          vertical={false}
        />
        <XAxis
          dataKey="label"
          axisLine={false}
          tickLine={false}
          interval={tickInterval}
          tick={{ fill: "var(--text-base-tertiary)", fontSize: 11 }}
          /** 首尾各留一点，否则端点的标签会被容器裁掉 */
          padding={{ left: 4, right: 4 }}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
          width={44}
          tick={{ fill: "var(--text-base-tertiary)", fontSize: 11 }}
          tickFormatter={(v: number) => formatCount(v)}
        />
        <Tooltip
          /**
           * 自绘 tooltip：默认那个是白底黑字硬编码的，暗色主题下会闪一块白。
           * `cursor` 用一条竖线（参考实现同样的处理）——比默认的灰色方块
           * 更容易对准某一天。
           */
          cursor={{ stroke: "var(--border-medium)", strokeWidth: 1 }}
          wrapperStyle={{ outline: "none" }}
          content={({ active, payload }) => {
            if (active !== true || payload === undefined || payload.length === 0) return null
            const row = payload[0]?.payload as Row | undefined
            if (row === undefined) return null
            return (
              <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-pop)] px-3 py-2 shadow-lg">
                <p className="typography-caption-400 mb-1.5 text-[var(--text-base-tertiary)]">
                  {new Date(row.at).toLocaleDateString("zh-CN", {
                    month: "long",
                    day: "numeric",
                    weekday: "short",
                  })}
                </p>
                <TooltipRow color={inboundColor} label="收到" value={row.inbound} />
                <TooltipRow color={outboundColor} label="发出" value={row.outbound} />
                {showChunks ? (
                  <TooltipRow color={chunkColor} label="进图谱" value={row.chunks} />
                ) : null}
              </div>
            )
          }}
        />
        {/*
         * ★ `isAnimationActive={false}`。
         *
         * 这一页会**反复重取**（切周期、点刷新、建图中 5s 轮询）。开着动画的话
         * 每次重取都重播一次入场 —— 那不是"生动"，那是闪。
         * 入场动画的价值只在第一次，而 recharts 分不清这两者。
         */}
        <Area
          type="monotone"
          dataKey="inbound"
          stroke={inboundColor}
          strokeWidth={2}
          fill="url(#mc-trend-inbound)"
          dot={false}
          activeDot={{ r: 3.5, fill: inboundColor, stroke: "var(--bg-card-z1)", strokeWidth: 2 }}
          isAnimationActive={false}
        />
        <Area
          type="monotone"
          dataKey="outbound"
          stroke={outboundColor}
          strokeWidth={2}
          fill="url(#mc-trend-outbound)"
          dot={false}
          activeDot={{ r: 3.5, fill: outboundColor, stroke: "var(--bg-card-z1)", strokeWidth: 2 }}
          isAnimationActive={false}
        />
        {/*
         * 「进了图谱」：只描线不填充。
         *
         * ★ 填充会与上面两条的渐变叠在一起，而它本来就该读作
         * "前两条里被消化的那部分" —— 一条细线压在面积上正好表达这个关系。
         * 两条线的**裂口**就是图谱落后在时间上的分布。
         */}
        {showChunks ? (
          <Area
            type="monotone"
            dataKey="chunks"
            stroke={chunkColor}
            strokeWidth={1.5}
            fill="none"
            dot={false}
            activeDot={{ r: 3, fill: chunkColor, stroke: "var(--bg-card-z1)", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        ) : null}
      </AreaChart>
    </ResponsiveContainer>
  )
}

/** tooltip 里的一行：色点 + 名字 + 值。列对齐 → `tabular-nums` */
function TooltipRow({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
      <span className="typography-caption-400 flex-1 text-[var(--text-base-secondary)]">
        {label}
      </span>
      <span className="typography-caption-400 tabular-nums text-[var(--text-base-primary)]">
        {formatCount(value)}
      </span>
    </div>
  )
}
