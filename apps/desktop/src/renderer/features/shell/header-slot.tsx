/**
 * 顶栏内容槽 —— 让当前模块把自己的「状态 + 动作」注入到 `AppHeader` 右侧，
 * 而不是各自在内容区里再摆一条自己的栏。
 *
 * ## ★ 为什么需要它（用户反馈：上面两栏应该合并，且太重了）
 *
 * 原来数字分身是**两条**横栏：`AppHeader` 一条（只有标题「数字分身」），
 * 下面 `PersonaTopBar` 又一条（渠道 + 三个大数字 + 开关）。两条加起来
 * 占掉约 96px，而其中一条几乎是空的（只有一个标题）。
 *
 * 合并的障碍是：那些数字来自 `PersonaModule` 里的快照查询，而 `AppHeader`
 * 在 shell 里、是 `PersonaModule` 的**兄弟**不是它的子节点。要么把整套
 * 数据获取提到 shell（那会让 shell 知道每个模块的内部状态），要么让模块
 * 把一段 UI **递上去**。后者更干净：shell 不需要理解那段 UI 是什么，
 * 只负责把它放进标题右边。
 *
 * ## 语义：一个可空的插槽，模块挂载时填、卸载时清
 *
 * `setContent(node)` 设置，`setContent(null)` 清空。模块用一个 effect
 * 在卸载时清 —— 于是切走之后它的头部内容不会残留在别的模块的标题旁。
 *
 * 只有一个槽（不是每模块一个）：同一时刻只有一个模块可见，它的头部内容
 * 就是当前该显示的那个。两个模块同时想填是一个 bug（会互相覆盖），
 * 而那正是我们想让它显形而不是悄悄合并的。
 */
import { createContext, useContext, useEffect } from "react"
import type { ReactNode } from "react"

interface HeaderSlotValue {
  setContent: (node: ReactNode | null) => void
}

/**
 * 默认是 no-op：模块在没有 Provider 的地方（比如单测）渲染时不该崩。
 * 那时它的头部内容只是不显示 —— 而模块自己的功能不依赖它显示在哪。
 */
const HeaderSlotContext = createContext<HeaderSlotValue>({ setContent: () => undefined })

export function HeaderSlotProvider({
  value,
  children,
}: {
  value: HeaderSlotValue
  children: ReactNode
}) {
  return <HeaderSlotContext.Provider value={value}>{children}</HeaderSlotContext.Provider>
}

/**
 * 把一段内容挂进顶栏右侧，随组件卸载自动撤下。
 *
 * ★ 依赖用 `node` 本身：调用方应当把它 `useMemo` 起来（否则每次渲染都是
 * 新对象，effect 每帧重挂）。这个约束写在这里而不是内部包一层 memo，
 * 是因为"什么时候算变了"只有调用方知道（它依赖哪些 state）。
 */
export function useHeaderSlot(node: ReactNode): void {
  const { setContent } = useContext(HeaderSlotContext)
  useEffect(() => {
    setContent(node)
    return () => setContent(null)
  }, [node, setContent])
}
