/**
 * EgoGraphPanel —— 图谱那一块的**外壳**：图例、渠道筛选、画布、邻居列表。
 *
 * ## 为什么与画布分成两个文件
 *
 * `ego-graph.tsx` 里全是 G6 的 options（canvas，jsdom 跑不了、只能靠探针验）。
 * 而"降级时说什么话""渠道怎么筛""选中一个节点显示什么"这些是普通 React，
 * 混在一起会让整块都变成探针才能验的东西。
 *
 * ## ★ 图 + 一列排好序的邻居，而不是只有图
 *
 * 这一条解决的是"不够直观"的**根因**：力导向图的节点位置是不稳定的
 * （每次布局都不一样），所以它答不了"谁最重要"——而那恰好是用户
 * 第一个想问的。一个按共现数降序的列表给了确定的阅读顺序。
 *
 * 两者互补而不是重复：**图看结构**（谁和谁一起出现、有几团），
 * **列表看排名**（前三名是谁、差多少）。而 hover 双向联动把它们
 * 缝成一个东西 —— 在列表里找到名字，图上那个点就亮了。
 *
 * ## ★ 三种"没有图"必须说不同的话
 *
 * · 还没建图 → 给「重新建图」按钮；
 * · 图里没有我 → 那是身份或覆盖面的问题，建图再跑一次也一样；
 * · 有我但没有共现 → 建议跑「优化图谱」。
 *
 * 合成一句"暂无数据"会让用户不知道该做什么 —— 而这三件事的下一步
 * 完全不同。原因由主进程的 `graphEgo()` 给（`reason` 字段），
 * 这一层只负责把它显示出来并配上对应的动作。
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { Button, IconButton, Panel, cn } from "@mycontext/design"
import type { KlGraphEgo } from "@mycontext/ipc-contract"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { useTheme } from "../../lib/use-theme.js"
import { FocusIcon } from "../shell/icons.js"
import { EgoGraph } from "./ego-graph.js"
import { SplashCursor } from "./splash-cursor.js"
import {
  CHANNEL_FALLBACK,
  CHANNEL_STROKE,
  ENTITY_TYPES,
  SELF_COLOR,
  entityColor,
} from "./palette.js"

export interface EgoGraphPanelProps {
  data: KlGraphEgo | undefined
  loading: boolean
  /** 建图中 —— 那时按钮要禁用且文案不同 */
  building: boolean
  onRebuild: () => void
  /** 点邻居 → 把事实面板筛到这个实体（这一块与下面那一块要连起来） */
  onPickEntity?: (name: string) => void
  /**
   * 当前**已经作为事实筛选条件**的实体名。
   *
   * ## ★ 为什么它与 `selected` 不是一回事
   *
   * `selected` 是"我刚点了看一眼"（浮层显示详情，点画布空白就消失）。
   * 这个是"下面那批事实现在按他筛着" —— 一个**持续**的状态，
   * 而它原来在图这一侧完全没有表现：用户点完之后浮层一关，
   * 图上再也看不出"是他在筛"。于是回头想改筛选条件时，
   * 他要去一屏之外的筹码上找。
   */
  focusedName?: string | null
}

export function EgoGraphPanel({
  data,
  loading,
  building,
  onRebuild,
  onPickEntity,
  focusedName = null,
}: EgoGraphPanelProps) {
  const { t } = useDynamicTranslation("graph")
  const { resolved: mode } = useTheme()
  const [selected, setSelected] = useState<string | null>(null)
  /** 图与列表共用的 hover 态 —— 双向联动就是这一个 state。 */
  const [hovered, setHovered] = useState<string | null>(null)
  const [channels, setChannels] = useState<ReadonlySet<string>>(new Set())
  /**
   * 视口被动过（平移/缩放/拖走节点）—— 决定复位按钮**要不要出现**。
   *
   * ## ★ 为什么需要这个 flag 而不是拿 zoom 值去比
   *
   * 初始构图走 `autoFit: "view"`，算出来的 zoom **本来就不是 1**
   * （它按内容缩放过）。拿 `zoom !== 1` 判断会让按钮一直亮着 ——
   * 而一个恒亮、点了没有任何变化的按钮比没有更糟（这一块的渠道筛选
   * 就是按这条在单渠道时隐藏的，见下面那段注释）。
   *
   * ## ⚠️ `fitView()` 自己也会触发 `aftertransform`
   *
   * 所以复位之后**不能**简单地 `setViewportDirty(false)` —— 那次
   * fitView 的回调会紧接着把它置回 true，按钮就永远不消失。
   * 处理办法见 `resetView` 里那个 `resettingRef`。
   */
  const [viewportDirty, setViewportDirty] = useState(false)
  /**
   * 正在复位中 —— 用来忽略 `fitView` 自己触发的那次视口回调。
   *
   * 用 ref 而不是 state：它只在两个回调之间传递一个瞬时标记，
   * 不需要触发渲染（用 state 会多一次无意义的重渲染，
   * 而且置位与读取在同一个 tick 里，state 还没更新）。
   */
  const resettingRef = useRef(false)
  /** `EgoGraph` 往里塞 `fitView` 的命令出口（见那一层的 `resetRef` 注释）。 */
  const resetViewportRef = useRef<(() => void) | null>(null)

  /**
   * ★★ 一键回到初始视图。
   *
   * 用户原话：「知识图谱区域得有一个按钮一键重置（focus 的那种 icon
   * 感觉）失去聚焦，回到原始的图的样子」。
   *
   * ## 清四件事 —— 缺一件都不算"回到原样"
   *
   * · **视口**：`fitView()` 回到 `autoFit: "view"` 的构图。这是真正
   *   缺出口的那一个 —— `drag-canvas`/`zoom-canvas`/`drag-element` 三个
   *   behavior 都能把画面弄歪，而在这个按钮之前**没有任何办法**回去
   *   （只能切走这一页再切回来，那会重新拉一次 ego 数据）；
   * · **selected**：关掉左上角那个详情浮层；
   * · **hovered**：退出聚焦/其余压暗的状态；
   * · **channels**：渠道筛选清空（回到"全部渠道"）。
   *
   * ## ★ 不碰 `focusedName`（下面那批事实的筛选）
   *
   * 它**已经有专门的出口** —— 图正下方联动带上的「看全部」
   * （`focus-bridge.tsx`）。而且它的作用范围**跨出了图谱区**：
   * 点"回到初始视图"时用户不会预期下面那批事实也跟着变。
   * 两个按钮各管一件事，比一个按钮管两件清楚。
   */
  const resetView = (): void => {
    resettingRef.current = true
    setSelected(null)
    setHovered(null)
    setChannels(new Set())
    resetViewportRef.current?.()
    setViewportDirty(false)
    /**
     * 下一个宏任务再放开标记 —— `fitView` 的视口回调会在这之前落地，
     * 于是那一次被忽略掉，而用户**之后**真的去拖画布时仍然能置脏。
     */
    setTimeout(() => {
      resettingRef.current = false
    }, 0)
  }

  /** 有东西可复位吗 —— 四个来源任一成立，按钮就该出现。 */
  const canReset = viewportDirty || selected !== null || hovered !== null || channels.size > 0

  /**
   * ★★ 最终兜底：**窗口级**的 pointermove —— 指针不在这块面板里就清 hover。
   *
   * ## 为什么前面那些都不够
   *
   * 这个 bug 我修了三轮都没修干净，因为每一层都有各自的漏洞：
   *
   * · G6 的 `node:pointerleave` 依赖它自己的拾取 —— 指针在两帧之间跨过
   *   整个画布时，中间那些图元没被"进入"过，也就不会"离开"；
   * · 邻居列表行的 `onMouseLeave` 走 React 的合成事件（依赖 `mouseout`
   *   逐级派发）—— 一步甩出去时那串事件不落到那一行上；
   * · 面板根的 `onPointerLeave` 只在**跨出边界**时派发 —— 指针停在面板内的
   *   空白处（图例、标题、图与列表之间）时它不触发，而那正是最常见的落点。
   *
   * 三条都是"等一个事件来告诉我离开了"，而每一条都有它收不到的路径。
   * 这一条反过来：**主动量**当前指针在不在面板矩形内。`pointermove` 在
   * document 上必然连续派发（浏览器保证），所以只要用户还在动鼠标，
   * 脏状态最多存活一帧。
   *
   * ## 为什么不是只用这一条
   *
   * 它要等用户"再动一下鼠标"。如果指针甩出去之后就停住不动了，
   * 这一条不会触发 —— 那时靠的是面板根那个 `onPointerLeave`
   * （跨出边界的瞬间就派发了）。两者的失效面正好互补。
   *
   * `passive` + 只在有 hover 时才装监听：没有脏状态时零开销。
   */
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (hovered === null) return
    const onMove = (event: PointerEvent) => {
      const root = rootRef.current
      if (root === null) return
      const box = root.getBoundingClientRect()
      const inside =
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom
      if (!inside) setHovered(null)
    }
    document.addEventListener("pointermove", onMove, { passive: true })
    return () => document.removeEventListener("pointermove", onMove)
  }, [hovered])

  /** 图里出现过的渠道。只有一个时不显示筛选（一个恒亮的开关是噪声）。 */
  const availableChannels = useMemo(
    () => [...new Set((data?.nodes ?? []).flatMap((n) => n.channels))].sort(),
    [data],
  )

  /**
   * 邻居按共现权重降序。
   *
   * ★ 排序键是**边权**（共现次数）而不是 `mentions`（全图提及数）：
   * 这一栏回答的是"谁和我最近"，而一个被全公司提到 900 次但只和我
   * 共现 2 次的人不该排在第一 —— 那时列表在说一件与图无关的事。
   */
  const neighbors = useMemo(() => {
    if (data === undefined || data.self === null) return []
    const selfId = data.self.id
    const weightOf = new Map<string, number>()
    for (const edge of data.edges) {
      if (edge.source === selfId) weightOf.set(edge.target, edge.weight)
      else if (edge.target === selfId) weightOf.set(edge.source, edge.weight)
    }
    const pass = (channelsOf: readonly string[]) =>
      channels.size === 0 || channelsOf.some((c) => channels.has(c))
    return data.nodes
      .filter((n) => n.hop !== 0 && pass(n.channels))
      .map((n) => ({ ...n, weight: weightOf.get(n.id) ?? 0 }))
      .sort((a, b) => b.weight - a.weight || b.mentions - a.mentions)
  }, [data, channels])

  /**
   * tooltip 的文案。
   *
   * ★ `useMemo` 是必需的而不是习惯：这个对象进了 `EgoGraph` 的
   * `options` 依赖数组，每次重渲染新建一个会让 d3-force **重新布局** ——
   * 而那时鼠标划过列表整张图就跳一下。
   */
  const labels = useMemo(
    () => ({
      type: (type: string) => t(`type.${type}`, { defaultValue: type }),
      mentions: (count: number) => t("mentions", { count }),
      channel: (id: string) => t(`channel.${id}`, { defaultValue: id }),
    }),
    [t],
  )

  const node = useMemo(
    () => (data?.nodes ?? []).find((n) => n.id === selected) ?? null,
    [data, selected],
  )

  if (loading) {
    return <Shell>{t("loading")}</Shell>
  }

  if (data === undefined || !data.available || data.self === null || data.nodes.length <= 1) {
    /**
     * ★ `nodes.length <= 1` 也算没有图：只有中心节点意味着一个邻居都没有，
     * 那时画一个孤零零的圆点比不画更糟（看起来像功能坏了）。
     *
     * ## ★ 空态背景放一层流体（SplashCursor）
     *
     * 这块是"还没建好图"的**等待态**——用户会盯着它看。一层跟指针晕开、
     * 空闲时自行流动的流体让"正在等"这件事不那么干等；它是**背景**，
     * 说明文字与「建图」按钮照旧压在上面且可点（canvas 是
     * `pointer-events-none`）。reduced-motion / 无 WebGL2 时它自己不出现，
     * 只剩静态底色 —— 见 `splash-cursor.tsx`。
     */
    return (
      <Shell>
        <SplashCursor />
        <div className="relative z-10 flex flex-col items-center gap-3 text-center">
          <p className="typography-body-small-400 max-w-[420px] text-[var(--text-base-secondary)]">
            {data?.reason ?? t("noGraph")}
          </p>
          <Button size="sm" variant="secondary" disabled={building} onClick={onRebuild}>
            {building ? t("building") : t("rebuild")}
          </Button>
        </div>
      </Shell>
    )
  }

  const maxWeight = neighbors[0]?.weight ?? 1

  return (
    /*
      ★★ `onPointerLeave` 在**整块面板**上，而不只在画布那一层。

      ## 那个 bug 长什么样

      `hovered` 是图与邻居列表**共用**的一个 state，两边都能把它设起来。
      而原来只有画布那个 div 有 `pointerLeave` —— 于是从**列表**行上把指针
      甩出去（一步跨到别的版块）时没有任何人清它：
      React 的 `onMouseLeave` 依赖 `mouseout` 逐级派发，而指针在两帧之间
      跨过整块面板时那一串事件压根不会落到那一行上。

      结果是图上一个节点亮着、其余全灰，而鼠标已经不在这一块里了 ——
      正是用户报的「离开知识图谱区域后还有 hover 特效」与
      「不聚焦时整体虚化」。

      实测（CDP，真实鼠标事件）：指针从「小吴」那一行移到 (5,5) 之后，
      截图里 小吴 仍是满亮、其余 20 个节点仍是 0.25 的淡色 ——
      等多久都不恢复。

      ## 为什么放在这一层就够

      `pointerleave` **不冒泡**但**必然成对**：浏览器保证指针离开元素边界时
      派发一次，无论中途经过什么、移动多快。而这一层是图与列表的**共同祖先**
      —— 指针无论从哪一边离开，都必然穿过它的边界。

      画布那一层的 `pointerLeave` 仍然留着（在 `EgoGraph` 里）：
      在面板**内部**从图移到列表时，这一层不会触发，而那时也该退出聚焦态。
      两条互补，不是重复。
    */
    <div ref={rootRef} className="flex flex-col gap-3" onPointerLeave={() => setHovered(null)}>
      {/* 图例 + 渠道筛选：一行装完，不占第二行 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="typography-caption-400 flex items-center gap-1.5 text-[var(--text-base-tertiary)]">
          {/* 「我」的图例也带那圈 halo —— 图上什么样，图例就什么样 */}
          <span
            className="size-2.5 rounded-full"
            style={{
              background: SELF_COLOR[mode],
              boxShadow: `0 0 0 3px color-mix(in oklab, ${SELF_COLOR[mode]} 18%, transparent)`,
            }}
          />
          {t("legendSelf", { name: data.self.name })}
        </span>
        {ENTITY_TYPES.map((type) => (
          <span
            key={type}
            className="typography-caption-400 flex items-center gap-1.5 text-[var(--text-base-tertiary)]"
          >
            <span
              className="size-2.5 rounded-full"
              style={{ background: entityColor(type, mode) }}
            />
            {t(`type.${type}`)}
          </span>
        ))}
        {/*
          ★ 渠道筛选只在**多渠道**时出现。
          单渠道时它是一个点了没有任何变化的开关 —— 而那比没有更糟
          （用户会以为筛选坏了）。描边色的含义仍在下面那行图例里说明。
        */}
        {availableChannels.length > 1 ? (
          <span className="ml-auto flex items-center gap-1.5">
            {availableChannels.map((id) => {
              const on = channels.size === 0 || channels.has(id)
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setChannels((prev) => {
                      const next = new Set(prev.size === 0 ? availableChannels : prev)
                      if (next.has(id)) next.delete(id)
                      else next.add(id)
                      // 全关等于全开（否则会得到一张空图）
                      return next.size === 0 ? new Set() : next
                    })
                  }
                  className={cn(
                    "typography-caption-400 rounded-full px-2 py-0.5 ring-1 transition-colors",
                    on
                      ? "text-[var(--text-base-primary)]"
                      : "text-[var(--text-base-disable)] ring-[var(--border-base-subtle)]",
                  )}
                  style={
                    on
                      ? { boxShadow: `inset 0 0 0 1px ${CHANNEL_STROKE[id] ?? CHANNEL_FALLBACK}` }
                      : {}
                  }
                >
                  {t(`channel.${id}`)}
                </button>
              )
            })}
          </span>
        ) : availableChannels[0] === undefined ? null : (
          <span className="typography-caption-400 ml-auto flex items-center gap-1.5 text-[var(--text-base-tertiary)]">
            {/* 单渠道：只说明描边色代表什么，不给开关 */}
            <span
              className="size-2.5 rounded-full ring-2"
              style={{
                boxShadow: `inset 0 0 0 2px ${CHANNEL_STROKE[availableChannels[0]] ?? CHANNEL_FALLBACK}`,
              }}
            />
            {t("legendChannel", { channel: t(`channel.${availableChannels[0]}`) })}
          </span>
        )}
      </div>

      {/*
        图与列表并排。窄屏堆叠 —— 一个 220px 的列表挤在 400px 宽的
        容器里会把画布压到看不清。
      */}
      <div className="flex flex-col gap-3 lg:flex-row">
        {/*
          ★ `pad="none"`：画布必须齐边。
          给它内边距会在图周围留一圈死区 —— 力导向布局会把节点甩到那里，
          于是节点看起来"贴在框上"而不是在画布里。
        */}
        <Panel pad="none" className="relative h-[420px] min-w-0 flex-1 overflow-hidden">
          <EgoGraph
            data={data}
            mode={mode}
            channelFilter={channels}
            labels={labels}
            highlightId={hovered}
            onSelect={setSelected}
            onHover={setHovered}
            resetRef={resetViewportRef}
            onViewportChange={() => {
              // 忽略 fitView 自己触发的那一次（见 resettingRef 的注释）
              if (resettingRef.current) return
              setViewportDirty(true)
            }}
          />
          {/*
            ── 一键回到初始视图 ─────────────────────────────

            ★ 放画布**右上角**：它改的是画布的视口，所以属于画布而不是
            上面那行图例（那一行的右侧已经被渠道筹码的 `ml-auto` 占了）。
            左上角是详情浮层（`left-3 top-3`），右上角正好对称、不会撞。

            ★ 只在**有东西可复位**时出现（`canReset`）—— 见它的注释。
          */}
          {canReset ? (
            <div className="absolute right-3 top-3">
              <IconButton
                label={t("resetView")}
                title={t("resetView")}
                size="sm"
                /**
                 * ★ `ghost`（有底色）而不是 `transparent`。
                 * 它浮在**画布**上 —— 画布里有节点、边、标签，一个纯透明的
                 * 图标会与它们混在一起读不出是个按钮。
                 * variant 只有 transparent|ghost 两种，ghost 是对的那个。
                 */
                variant="ghost"
                onClick={resetView}
              >
                <FocusIcon />
              </IconButton>
            </div>
          ) : null}

          {/*
            选中详情浮在画布上而不是另开一栏：右边已经有邻居列表了，
            再切一栏会让画布窄到看不清。

            ★ 必须能关掉 —— 这一条是截图自查抓到的。
            `setSelected` 有两个入口（图上点节点、邻居列表点一行），
            而原来**没有任何**出口：浮层一旦出现就永久压在画布左上角，
            挡住那一片的节点。它不报错、不影响数据，只是让图越用越糊 ——
            而用户唯一的办法是切走这一页再切回来。
          */}
          {node === null ? null : (
            <div className="absolute left-3 top-3 flex max-w-[240px] flex-col gap-1 rounded-[var(--radius-lg)] bg-[var(--bg-card-z0)] p-3 shadow-sm ring-1 ring-[var(--border-divider-light)]">
              <div className="flex items-start gap-2">
                <span className="typography-body-small-400 min-w-0 flex-1 truncate font-medium text-[var(--text-base-primary)]">
                  {node.name}
                </span>
                {/*
                  关掉。用 `aria-label` 而不是可见文字："×" 对读屏器
                  只是一个符号，而这是浮层唯一的出口。
                */}
                <button
                  type="button"
                  aria-label={t("closeDetail", { defaultValue: "关闭" })}
                  onClick={() => setSelected(null)}
                  className="-mr-1 -mt-1 shrink-0 rounded-full px-1.5 leading-none text-[var(--text-base-tertiary)] transition-colors duration-150 hover:bg-[var(--overlay-on-container-hover)] hover:text-[var(--text-base-primary)]"
                >
                  ×
                </button>
              </div>
              <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
                {t(`type.${node.type}`)} · {t("mentions", { count: node.mentions })}
              </span>
              {node.channels.length === 0 ? null : (
                <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
                  {node.channels.map((c) => t(`channel.${c}`)).join(" · ")}
                </span>
              )}
              {onPickEntity === undefined ? null : (
                <Button size="sm" variant="ghost" onClick={() => onPickEntity(node.name)}>
                  {t("seeFacts")}
                </Button>
              )}
            </div>
          )}
        </Panel>

        {/* ── 邻居列表：图看结构，这里看排名 ──────────────────── */}
        {/*
          ★ `pad="sm"`（8px）而不是默认的 16px：列表行的 hover 底色要
          贴近卡的边缘。16px 会让每一行的可点区域缩在中间一条，
          于是"整行可点"读不出来。
        */}
        <Panel
          pad="sm"
          className="flex h-[420px] w-full shrink-0 flex-col gap-1 overflow-hidden lg:w-[240px]"
        >
          <span className="typography-caption-400 shrink-0 px-1 pb-1 text-[var(--text-base-tertiary)]">
            {t("neighborsTitle", { count: neighbors.length })}
          </span>
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {neighbors.map((n) => {
              /**
               * ★ 这一行是不是"正在筛的那个"。
               *
               * 与 hover / selected 是三种不同的东西：hover 是鼠标在哪，
               * selected 是刚点开详情，而这个是**下面那批事实按谁筛着** ——
               * 它要在鼠标离开、浮层关掉之后**仍然看得见**。
               */
              const focused = focusedName !== null && n.name === focusedName
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    // 读屏器也要知道"当前是他" —— 视觉高亮之外的那一半
                    aria-current={focused ? "true" : undefined}
                    onMouseEnter={() => setHovered(n.id)}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={() => setHovered(n.id)}
                    onBlur={() => setHovered(null)}
                    onClick={() => {
                      setSelected(n.id)
                      onPickEntity?.(n.name)
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-1.5 py-1 text-left",
                      "transition-colors duration-150 hover:bg-[var(--overlay-on-container-hover)]",
                      hovered === n.id ? "bg-[var(--overlay-on-container-hover)]" : "",
                      selected === n.id ? "bg-[var(--overlay-on-container-selected)]" : "",
                      /**
                       * 正在筛的那一行：底色 + 一条左侧强调边。
                       * 用 `ring-inset` 的左边而不是外描边 —— 列表项之间只有
                       * 1px 间隙，外描边会与相邻行叠在一起。
                       */
                      focused
                        ? "bg-[var(--status-fill-info-container)] font-medium shadow-[inset_2px_0_0_0_var(--status-link)]"
                        : "",
                    )}
                    title={t("mentions", { count: n.mentions })}
                  >
                    {/* 类型点：与图上的填充色是同一个值（palette.ts 那一份） */}
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: entityColor(n.type, mode) }}
                      aria-hidden
                    />
                    <span className="typography-caption-400 min-w-0 flex-1 truncate text-[var(--text-base-primary)]">
                      {n.name}
                    </span>
                    {/*
                      共现数用一段细条 + 数字。
                      只给数字的话"3 和 47 差多远"要读者自己算；
                      只给条的话看不出确切值 —— 而这一列窄，两者都放得下。
                    */}
                    <span
                      className="h-[6px] w-[28px] shrink-0 overflow-hidden rounded-[2px]"
                      style={{
                        background: `color-mix(in oklab, ${entityColor(n.type, mode)} 12%, transparent)`,
                      }}
                      aria-hidden
                    >
                      <span
                        className="block h-full rounded-l-[2px] rounded-r-[3px]"
                        style={{
                          width: `${String(Math.max(8, (n.weight / maxWeight) * 100))}%`,
                          background: entityColor(n.type, mode),
                        }}
                      />
                    </span>
                    {/* 列对齐 → tabular-nums（这是它该用的地方） */}
                    <span className="typography-caption-400 w-6 shrink-0 text-right tabular-nums text-[var(--text-base-tertiary)]">
                      {n.weight}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </Panel>
      </div>

      <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
        {t("hint", { count: data.nodes.length - 1 })}
      </p>
    </div>
  )
}

/** 空态/加载态共用的外框：高度与画布一致，避免切换时页面跳动。 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <Panel
      pad="none"
      // `relative overflow-hidden`：给空态里的 SplashCursor 一个定位上下文，
      // 让那层 `absolute inset-0` 的流体铺满这块、并被圆角裁住。
      className="typography-body-small-400 relative flex h-[420px] items-center justify-center overflow-hidden text-[var(--text-base-tertiary)]"
    >
      {children}
    </Panel>
  )
}
