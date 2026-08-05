/**
 * EgoGraph —— 以「我」为中心的关系图（Graphin / G6 v5）。
 *
 * ## ★ 为什么这一块值得画成图，而全图不值得
 *
 * 全图 2170 实体 / 54826 边画出来是一团毛线：既看不出结构也点不准节点。
 * 但**「我」周围**不是 —— 一跳邻居上限 24 个，那是一屏能看清、
 * 每个都点得到的量，而且它回答的正是用户最关心的问题：
 * 我常和谁一起出现、涉及哪些系统、这些关系来自哪个 IM。
 *
 * ## 视觉编码（四个维度，都要能一眼读出来）
 *
 * · **位置** —— 我在中心，邻居按力导向散开；
 * · **大小** —— 提及数（对数缩放，见 `nodeRadius`：线性会让小节点消失）；
 * · **填充色** —— 实体类型（`palette.ts` 里验证过的 categorical slot）；
 * · **描边色** —— **IM 渠道**（现在只有钉钉；多渠道时每个渠道一个色）。
 *
 * ★ 渠道用描边而不是填充：填充那一维已经给了实体类型，而"这条关系
 * 从哪个 IM 来"是元信息 —— 它该是一个边框而不是抢主色。
 *
 * ## ★ 中心节点有一圈 halo，而那不是装饰
 *
 * 「我」原来只靠颜色与旁边的点区分。但在 CVD 下那个色差可能不够，
 * 而"哪个是我"是这张图最基本的一个问题 —— 答错了整张图就读反了。
 * 所以加了一圈同色低透明外环（`badge` 那一层做不到，用 `halo` 样式）：
 * 形状是**第二重编码**，颜色失效时它还在。
 *
 * ## ★ hover 是默认交付物，不是升级项
 *
 * `interaction.md`：一个 HTML/SVG 图**就是**交互的，bar/dot/cell 形式
 * 默认带逐标记 tooltip。这里用 G6 的 `tooltip` 插件 —— 命中区比节点大
 * （`enterable: false` + 节点本身 ≥24px 直径，见 `nodeRadius` 的下限）。
 *
 * ## ★ 高亮由外部驱动（`highlightId`）
 *
 * 右侧的邻居列表 hover 时要点亮图上对应的节点，反之亦然。
 * 那意味着"当前高亮的是谁"这个状态**不能**只活在 G6 内部 ——
 * 它在父组件里，两边都读它。G6 这一侧用 `setElementState` 应用。
 *
 * ## 为什么数据逻辑不在这个文件里
 *
 * G6 要 canvas，jsdom 里跑不起来 —— 这个组件只能靠 CDP 探针验。
 * 而"取谁、算多少、边怎么定权"那些判断必须能单测，所以它们在
 * `ego-graph-data.ts`（纯函数）。这里只负责把数据翻译成 G6 的 options。
 */
import { useEffect, useMemo, useRef } from "react"
import { Graphin } from "@antv/graphin"
import type { Graph, IElementEvent, Tooltip } from "@antv/g6"
import type { KlGraphEgo } from "@mycontext/ipc-contract"
import { nodeRadius, tooltipHtml } from "./ego-graph-data.js"
import { CHANNEL_STROKE, EDGE_COLOR, SELF_COLOR, type ThemeMode, entityColor } from "./palette.js"

export interface EgoGraphProps {
  data: KlGraphEgo
  /** 明暗 —— canvas 读不到 CSS 变量，所以必须显式传（见 palette.ts） */
  mode: ThemeMode
  /** 只显示这些渠道的关系；空集 = 全部（多渠道筛选用） */
  channelFilter?: ReadonlySet<string>
  /** 外部要求高亮的节点（邻居列表 hover 时传进来） */
  highlightId?: string | null
  onSelect?: (nodeId: string | null) => void
  /** 图上 hover 时反向通知父组件（让邻居列表同步高亮） */
  onHover?: (nodeId: string | null) => void
  /**
   * tooltip 上的文案。**由外部注入**，因为 i18n 的 `t` 在 React 上下文里，
   * 而这里的 options 是 `useMemo` 出来的纯数据。
   *
   * ★ 不注入的话 tooltip 上会显示 kl 给的原始类型名（`Person`/`System`），
   * 而同一屏的图例上写的是"人""系统" —— 同一个东西两种叫法。
   */
  labels?: {
    type: (type: string) => string
    mentions: (count: number) => string
    channel: (id: string) => string
  }
  /**
   * 复位视图的**命令出口** —— 父级把一个 ref 传进来，这一层往里塞函数。
   *
   * ## ★ 为什么是命令（imperative）而不是 `resetSignal` 那种状态
   *
   * "回到初始视图"是一个**动作**，不是一个可以被渲染的状态。
   * 用 signal（比如递增一个数字 + `useEffect` 监听）能实现，但那时
   * "按了按钮"与"视口真的动了"之间多一次渲染，而且那个数字本身
   * 没有任何意义 —— 它只是为了骗过 effect 的依赖比较。
   *
   * `fitView` 已经是 imperative 的（在 graph 实例上），
   * 所以这里保持同一种性质，不做无谓的状态化。
   */
  resetRef?: { current: (() => void) | null }
  /**
   * 视口被动过（拖/缩放/拖节点）时通知父级。
   *
   * ★ 父级用它决定复位按钮**要不要出现** —— 一个点了没有任何变化的
   * 按钮比没有更糟（这一块的渠道筛选就是按这条在单渠道时隐藏的）。
   *
   * 不在这一层自己判"要不要显示"：那个按钮画在**面板**上（画布右上角），
   * 而它还要看 selected/hovered/channels 三个也在面板层的状态。
   */
  onViewportChange?: () => void
}

export function EgoGraph({
  data,
  mode,
  channelFilter,
  highlightId,
  onSelect,
  onHover,
  labels,
  resetRef,
  onViewportChange,
}: EgoGraphProps) {
  /**
   * 拿住 graph 实例才能在 `highlightId` 变化时应用状态。
   *
   * 不能走 options 重建：那会让 d3-force 重新布局 —— 而列表 hover
   * 时整张图跳一下是完全不可接受的（用户会以为点错了）。
   */
  const graphRef = useRef<Graph | null>(null)

  const options = useMemo(() => {
    const visible =
      channelFilter === undefined || channelFilter.size === 0
        ? data.nodes
        : // 我自己永远保留：把中心筛掉之后剩下的不再是 ego 图
          data.nodes.filter((n) => n.hop === 0 || n.channels.some((c) => channelFilter.has(c)))
    const visibleIds = new Set(visible.map((n) => n.id))

    return {
      autoFit: "view" as const,
      padding: 32,
      node: {
        /**
         * ★ hover/高亮态在这里声明，不是在事件里改样式。
         *
         * G6 的 state 机制会在 `setElementState` 时做过渡动画，
         * 而手改样式不会 —— 那时高亮是"跳"出来的。
         */
        state: {
          /**
           * ★ `active` 必须**显式写回** `opacity` / `labelOpacity`。
           *
           * 这是"hover 之后画面变虚且不恢复"的根因之一。G6 的 state 样式是
           * **叠加**在基础样式上的，而一个节点从 `inactive` 变成 `active` 时，
           * 只有 `active` 里列出的属性会被重写 —— 没列的（这里就是 opacity）
           * 保留上一个状态的值。于是被 hover 的那个点自己也是 0.25 的淡色，
           * 而它本该是全屏最实的那一个。
           *
           * 写死 1 而不是"删掉 inactive 里的 opacity"：压暗其余是这张图的
           * 主要表达（"是这个"而不是"这个更亮一点"），不能去掉。
           */
          active: {
            lineWidth: 3,
            shadowBlur: 12,
            shadowColor: "rgba(0,0,0,0.25)",
            opacity: 1,
            labelOpacity: 1,
          },
          // 有人被高亮时其余压暗：那是"这个"而不是"这个更亮一点"
          inactive: { opacity: 0.25, labelOpacity: 0.25 },
        },
      },
      data: {
        nodes: visible.map((node) => {
          const r = nodeRadius(node.mentions, node.hop)
          const stroke = node.channels
            .map((c) => CHANNEL_STROKE[c])
            .find((c): c is string => c !== undefined)
          const fill = node.hop === 0 ? SELF_COLOR[mode] : entityColor(node.type, mode)
          return {
            id: node.id,
            /** tooltip 要读的字段（G6 的 tooltip 拿 `data`，不是 `style`） */
            data: {
              name: node.name,
              typeLabel: labels?.type(node.type) ?? node.type,
              mentionsLabel: labels?.mentions(node.mentions) ?? String(node.mentions),
              channels: node.channels.map((c) => labels?.channel(c) ?? c).join(" · "),
              self: node.hop === 0,
            },
            style: {
              size: r * 2,
              fill,
              // 描边 = 渠道。取不到渠道时不描边（而不是描一个错的颜色）
              lineWidth: stroke === undefined ? 0 : 2,
              stroke: stroke ?? "transparent",
              labelText: node.name,
              // 中心节点的名字更大 —— 它是这张图的锚点
              labelFontSize: node.hop === 0 ? 14 : 11,
              labelPlacement: "bottom" as const,
              labelBackground: true,
              /**
               * ★ 只有中心节点有 halo（形状 = 第二重编码）。
               *
               * `haloLineWidth` 给得比描边大一截，透明度压到 0.18 ——
               * 它要在余光里可见但不能盖住邻居的标签。
               */
              ...(node.hop === 0
                ? { halo: true, haloStroke: fill, haloLineWidth: 10, haloStrokeOpacity: 0.18 }
                : {}),
            },
          }
        }),
        edges: data.edges
          // 端点被渠道筛掉的边也要去掉，否则 G6 会因为找不到节点而报错
          .filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
          .map((edge) => ({
            source: edge.source,
            target: edge.target,
            style: {
              // 共现越多越粗。上限 6 —— 再粗会盖住节点
              lineWidth: Math.min(6, 1 + Math.log2(edge.weight + 1)),
              stroke: EDGE_COLOR[mode],
              endArrow: false,
            },
          })),
      },
      layout: {
        type: "d3-force",
        /**
         * ★ `linkDistance` 按边权反比：共现多的拉近。
         *
         * 不这么做的话所有邻居等距排一圈 —— 那时"谁更亲近"这个信息
         * 只剩边的粗细，而距离这一维被浪费了。
         */
        link: { distance: 140, strength: 0.6 },
        collide: { radius: 42 },
        manyBody: { strength: -240 },
      },
      behaviors: [
        "drag-canvas",
        "zoom-canvas",
        "drag-element",
        { type: "click-select", multiple: false },
        /**
         * ★ **没有** `hover-activate`，而那是一个实测出来的决定。
         *
         * 加上它之后整张图在**刚加载时**就是灰的：G6 的 `hover-activate`
         * 会在初始化时把所有节点置成 `inactive`（而不是等真的 hover），
         * 于是下面那个 `inactive: { opacity: 0.25 }` 立刻生效 ——
         * 结果是"图例上写着蓝色，图里的点是淡蓝"。
         *
         * 量过：截图里图区的高饱和像素从 61124 掉到 5140（差 12 倍）。
         * 而这个 bug 完全不报错，只是"看起来没设计感"。
         *
         * hover 高亮改由父组件统一驱动（`highlightId` + 下面那个 effect）——
         * 反正邻居列表与图要**双向**联动，状态本来就必须在父级。
         * 一份状态两处应用，比让 G6 自己管一层再叠加要少一个失效面。
         */
      ],
      plugins: [
        {
          type: "tooltip",
          /**
           * ★ 给 key —— 不是可选的美化。
           *
           * `graph.getPluginInstance(key)` 是**唯一**能拿到 tooltip 实例、
           * 从而在指针离开整块图区时调 `hide()` 的途径（见下面那个
           * `hideTooltip`）。不给 key 就拿不到实例，于是"鼠标已经走了、
           * 浮窗还挂在图上"这件事没有出口。
           */
          key: "ego-tooltip",
          /**
           * ★ 不可进入（`enterable: false`）。
           *
           * 可进入的 tooltip 在密集的力导向图里会挡住旁边的节点，
           * 而这张图的节点最近可以贴到 42px（`collide.radius`）。
           */
          enterable: false,
          trigger: "hover" as const,
          /**
           * ★ 内容由 `tooltipHtml` 拼（纯函数，在 `ego-graph-data.ts`）。
           *
           * 那里记着两个踩过的坑：字段在 `model.data` 里、返回值必须
           * 只有一个根节点 —— 两个都表现为"hover 出一个空白浮窗"而不报错。
           * 抽成纯函数是为了能单测（canvas 在 jsdom 里跑不起来）。
           */
          getContent: (_evt: unknown, items: ReadonlyArray<Record<string, unknown>>) =>
            tooltipHtml(items[0]),
        },
      ],
    }
  }, [data, channelFilter, mode, labels])

  /**
   * 外部高亮 → G6 状态。
   *
   * `null` 时把所有节点清回空状态（而不是只清上一个）——
   * 只清上一个会在快速划过列表时留下几个卡住的高亮。
   *
   * ## ★ 必须防并发：`setElementState` 是 async 的
   *
   * 它内部 `await element.draw({ stage: "state" })`，而那一步走 G6 的动画
   * 队列。我们原来是 fire-and-forget 地调它 —— 快速 hover 进出会发出多次
   * 重叠的 draw，**后发的可能先完成**，于是最后落在画面上的是那次"压暗"
   * 而不是"清空"。表现正是用户报的：hover 之后画面变虚，**而且不恢复**。
   *
   * 修法：记一个单调序号，每次异步完成后检查自己是否仍是最新那一次；
   * 不是就**重放**当前意图。重放是安全的，因为我们每次下发的是**全量**
   * 节点状态（不是增量），重复应用同一个意图是幂等的。
   *
   * 不用 `await` 串行化（高亮会跟不上手），也不用防抖
   * （那会让"移开鼠标"也延迟，比现在更难受）。
   */
  const stateSeqRef = useRef(0)
  /** 最新意图（hover 目标）。重放时读它，而不是读闭包里那个已过期的值。 */
  const wantRef = useRef<string | null>(null)

  /**
   * 关掉 tooltip。
   *
   * ## ★ 为什么必须手动关
   *
   * G6 的 tooltip 靠**图元**的 `pointerleave` 自己收（`onPointerLeave`）。
   * 而指针从一个节点直接掠出整块画布时那个事件收不到 —— 与
   * `node:pointerleave` 完全同一个失效面（见下面那个 div 的注释）。
   * 于是浮窗留在画布上，而鼠标已经在别的版块了。
   *
   * 实测（CDP）：把指针移到 (20,20)（图区外）之后，
   * `.tooltip` 仍是 `visibility: visible; opacity: 1`，
   * 文字停在最后那个节点上（"小周 · 被提及 3700 次"）——
   * 等 2.5s 也不消失。
   *
   * `hide()` 不传参数就是"外部调用"（它的签名里写明了 `event?`），
   * 正是给这种场景留的口子。
   *
   * ## ★ 必须判 `destroyed`
   *
   * `graphRef` 是我们自己存的，G6 销毁实例时**不会**把它清空 ——
   * 而这个组件会被销毁重建（HMR、换主题、数据换一批都可能）。
   * 对一个已销毁的实例调方法，G6 打
   * `[G6 v5.1.1] The graph instance has been destroyed` 并抛，
   * 实测在控制台里见到过一次（还带一个 Uncaught in promise）。
   * 那不是错误，只是我们晚了一步 —— 判一下就好。
   */
  const hideTooltip = (): void => {
    const graph = graphRef.current
    if (graph === null || graph.destroyed) return
    try {
      const tooltip = graph.getPluginInstance<Tooltip>("ego-tooltip")
      tooltip?.hide()
    } catch {
      // 插件还没装好 / 已销毁：没有 tooltip 要关，什么都不用做
    }
  }

  /**
   * 回到初始视图 —— 重新 `fitView`。
   *
   * ## ★ 为什么 fitView 就是"原始的样子"
   *
   * 初始构图是 options 里的 `autoFit: "view"` + `padding: 32` 算出来的
   * （见上面那个 `useMemo`）。`fitView()` 走的是**同一套**计算，
   * 所以它给出的正是用户第一次看到这张图时的那个视口。
   *
   * ★ **不**重新布局（不碰 d3-force）：那会让每个节点的位置全变 ——
   * 力导向的布局结果每次都不一样，那是"换一张图"而不是"回到原样"。
   * 用户拖走的那个节点会留在它被拖到的地方，而这是对的：
   * 复位的是**视口**（我从哪儿看），不是图本身。
   *
   * ## 两条防护都是这个文件已经踩过的坑
   *
   * 1. `graph.destroyed` 判空 —— `graphRef` 是我们自己存的，G6 销毁实例时
   *    **不会**清空它（HMR / 换主题 / 数据换一批都会重建）。对已销毁的
   *    实例调方法会抛 `The graph instance has been destroyed`；
   * 2. `.catch()` 吞掉 rejection —— `fitView` 返回 Promise 且带视口动画，
   *    动画被打断（用户马上又拖了一下、或组件卸载）是**常态**而不是错误。
   *    与 `setElementState` 那处同一个理由。
   */
  const resetViewport = (): void => {
    const graph = graphRef.current
    if (graph === null || graph.destroyed) return
    /**
     * 顺手关掉 tooltip：视口一动，那个浮窗就指向错的位置了 ——
     * G6 的 tooltip 不跟着视口重算位置。
     */
    hideTooltip()
    try {
      void graph.fitView().catch(() => {
        // 视口动画被打断（又拖了一下 / 组件卸载）—— 不是错误
      })
    } catch {
      // 图还没渲染完就按了：没有视口可复位，什么都不用做
    }
  }

  /**
   * 把复位这个**命令**挂到父级传进来的 ref 上。
   *
   * ★ 在 effect 里挂而不是渲染期直接赋值：渲染期写 ref 是副作用
   * （StrictMode 下会跑两次），而卸载时要清掉 —— 否则父级手里那个 ref
   * 还指向一个已卸载组件的闭包，按下按钮时对已销毁的 graph 调方法。
   */
  useEffect(() => {
    if (resetRef === undefined) return
    resetRef.current = resetViewport
    return () => {
      resetRef.current = null
    }
  })

  useEffect(() => {
    const graph = graphRef.current
    // 同上：实例可能已经被销毁（HMR / 重建），那时什么都不该做
    if (graph === null || graph.destroyed) return
    wantRef.current = highlightId ?? null
    const seq = (stateSeqRef.current += 1)

    const apply = (target: string | null): void => {
      // 图还没渲染完 / 已销毁时 getNodeData/setElementState 会抛（拿不到图元）
      if (graph.destroyed) return
      try {
        const nodes = graph.getNodeData()
        /**
         * ★ 目标必须**真的在图上**，否则一律清空。
         *
         * 压暗是"其余"的样式，而"其余"只有在**有一个亮着的**时才成立。
         * 如果 `target` 指向一个当前不在图上的节点（被渠道筛掉了、
         * 或数据刚换了一批而 hover 态还停在旧节点上），那么下发的结果是
         * **所有**节点都拿到 `inactive`、没有一个拿到 `active` ——
         * 整张图一起变虚，而画面上根本没有"被聚焦的那一个"。
         *
         * 那正是用户报的「不聚焦在某个点的时候整体虚化」。
         * 判一下存在性，把这种情况归到"没有高亮"那一支去。
         */
        const present = target !== null && nodes.some((n) => String(n.id) === target)
        const effective = present ? target : null
        const states = Object.fromEntries(
          nodes.map((n) => [
            String(n.id),
            effective === null ? [] : String(n.id) === effective ? ["active"] : ["inactive"],
          ]),
        )
        void Promise.resolve(graph.setElementState(states))
          .then(() => {
            /**
             * 这一次的 draw 完成时，用户的鼠标可能已经移到别处了。
             *
             * 那意味着**更晚**的那次 draw 与这次重叠过，而 G6 的动画队列
             * 不保证后发后完成 —— 画面可能停在这一次的中途（半透明）。
             * 所以完成后对一下最新意图：不一致就再应用一次最新的那个。
             * 全量下发让重放天然幂等，不会累积。
             */
            if (seq === stateSeqRef.current) return
            const want = wantRef.current
            if (want !== target) apply(want)
          })
          .catch(() => {
            // 状态动画被后一次 hover 打断，不是错误
          })
      } catch {
        // 图未就绪：下一次 highlightId 变化会再来一遍，不需要重试
      }
    }

    apply(highlightId ?? null)
    // 没有高亮目标 = 不该有浮窗。两者是同一个"退出聚焦态"的动作。
    if (highlightId === null || highlightId === undefined) hideTooltip()
  }, [highlightId])

  return (
    /*
      ★★ 这一层 div 是为了**兜住"指针离开了整块图区"**这件事。

      ## 那个 bug 长什么样

      G6 的 `node:pointerleave` 只在指针从**一个节点**上离开时触发。
      而指针如果直接从节点掠出整块画布（沿边缘划出去、或快速甩到别的
      版块），那个事件**收不到** —— 于是 `hovered` 永久停在最后那个节点上，
      图上一个节点亮着、其余全灰，而鼠标已经不在图谱区域里了。

      实测量过（CDP，截图数高饱和像素）：
      · 无 hover：11,918
      · hover 中：116,704（约 10 倍，高亮生效）
      · **离开图区后：116,822 —— 一点没退回去**

      而且这个 bug 不报错、数据也没问题，只是"看起来花了"。

      ## 为什么用 DOM 的 pointerleave 而不是 G6 的 canvas 事件

      `pointerleave` 是**不冒泡**且**必然成对**的：浏览器保证指针离开
      元素边界时派发一次，无论中途经过什么、移动多快。
      而 G6 的图元事件依赖它自己的拾取（hit-test），指针在两帧之间
      跨过整个画布时中间那些图元压根没被"进入"过，也就不会"离开"。

      放在**外层 div** 而不是 canvas 上：G6 会在容器里重建 canvas
      （数据变化、resize 都可能），挂在 canvas 上的监听会随之丢掉。
    */
    <div
      className="size-full"
      /*
        ★ 清高亮**和**关浮窗是同一个动作的两半。

        只清高亮的话画面会退回全亮，但那个 tooltip 还挂在原地 ——
        实测指针移到 (20,20) 之后 `.tooltip` 仍是
        `visibility: visible; opacity: 1`，文字停在最后那个节点上，
        等多久都不消失（G6 的 tooltip 只听图元的 leave，而那个事件
        在"一步甩出画布"时收不到，与 `node:pointerleave` 同一个失效面）。
      */
      onPointerLeave={() => {
        onHover?.(null)
        hideTooltip()
      }}
      /*
        ★ `onBlur` 也要清 —— 键盘用户 Tab 出这一块时同样该退出聚焦态，
        而那时压根没有指针事件。
      */
      onBlur={() => {
        onHover?.(null)
        hideTooltip()
      }}
    >
      <Graphin
        options={options}
        style={{ width: "100%", height: "100%" }}
        onReady={(graph) => {
          graphRef.current = graph
          graph.on("node:click", (event: IElementEvent) => {
            /**
             * `event.target.id` 是 G6 图元的 id —— 我们建节点时把实体 id
             * 原样给了它，所以这里拿到的就是实体 id。
             */
            const id = (event.target as { id?: unknown } | undefined)?.id
            onSelect?.(typeof id === "string" ? id : null)
          })
          graph.on("canvas:click", () => onSelect?.(null))
          graph.on("node:pointerenter", (event: IElementEvent) => {
            const id = (event.target as { id?: unknown } | undefined)?.id
            onHover?.(typeof id === "string" ? id : null)
          })
          /*
            节点级的 leave 仍然要留着：在图**内部**从一个节点移到空白处时，
            外层 div 的 pointerleave 不会触发（指针还在 div 里），
            而那时确实该退出聚焦态。两条互补，不是重复。
          */
          graph.on("node:pointerleave", () => onHover?.(null))
          /**
           * ★★ 第三条兜底：**画布**上的 pointermove。
           *
           * ## 为什么前两条不够
           *
           * · `node:pointerleave` 依赖 G6 自己的拾取（hit-test）——
           *   指针在两帧之间跨过整个画布时，中间那些图元压根没被"进入"过，
           *   也就不会"离开"；
           * · 外层 div 的 `pointerLeave` 只在指针**跨出 div 边界**时派发 ——
           *   而从一个节点移到画布**空白处**（还在 div 里）不触发。
           *
           * 于是有一条真实路径两条都漏：在节点上停住 → 快速划到画布空白 →
           * 再从那里移出去。第一步没触发 leave（跳过了拾取），
           * 第二步 div 的 leave 虽然触发了，但那时 `hovered` 早已经是脏的
           * —— 而更常见的是用户就停在空白处，于是画面一直虚着。
           *
           * `canvas:pointermove` 在**整个画布**上派发，与拾取无关。
           * 判一下 `targetType`：只要当前落点不是节点，就说明没聚焦在谁身上。
           */
          graph.on("canvas:pointermove", () => {
            onHover?.(null)
            hideTooltip()
          })

          /**
           * ★★ 视口/节点被动过 → 通知父级（它据此决定复位按钮要不要出现）。
           *
           * ## 事件名是查出来的，不是猜的
           *
           * G6 v5 **没有** `viewportchange` 这个事件（我一开始就是这么写的）。
           * 枚举在 `@antv/g6/lib/constants/events/graph.d.ts` 里，
           * 真正对应的两个是：
           *
           * · `aftertransform`（`AFTER_TRANSFORM`）——「可视区域变化之后」，
           *   `drag-canvas` 平移与 `zoom-canvas` 缩放都走它；
           * · `afterelementtranslate`（`AFTER_ELEMENT_TRANSLATE`）——
           *   「元素平移之后」，也就是 `drag-element` 拖走一个节点。
           *
           * 两个都要听：只听前者的话"拖走一个节点"不会让按钮出现，
           * 而那也是一种"回不去原样"的状态。
           *
           * ⚠️ `fitView()` 自己也会触发 `aftertransform` —— 所以父级那边
           * 复位之后不能简单地把 flag 置 false（会被这次回调又置回 true）。
           * 处理在面板层（见 `ego-graph-panel.tsx` 里 `viewportDirty` 的注释）。
           */
          graph.on("aftertransform", () => onViewportChange?.())
          graph.on("afterelementtranslate", () => onViewportChange?.())
        }}
      />
    </div>
  )
}
