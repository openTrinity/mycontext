/**
 * 顶栏为 macOS 原生交通灯让位的间距。
 *
 * 交通灯由主进程绘制在窗口左上角（hiddenInset）。侧栏展开时它落在侧栏里，
 * 由侧栏自己让位；侧栏收起后窗口左上角就是内容区顶栏，需要在这里补间距，
 * 否则标题与按钮会压在交通灯上。
 *
 * 全屏态系统隐藏交通灯，此时不需要留白。
 */
import { useEffect, useState } from "react"

/** 交通灯 + 右侧安全间距的总宽度（实测 mac 三颗按钮约 70px） */
const TRAFFIC_LIGHT_WIDTH = 74

const IS_MAC =
  typeof window !== "undefined" && window.navigator.platform.toLowerCase().includes("mac")

export function useTrafficLightPadding(sidebarOccupiesTopLeft: boolean) {
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    if (!IS_MAC) return
    // 全屏切换没有专门事件，用窗口尺寸与屏幕尺寸的关系判定即可满足布局需要。
    const check = () => setIsFullscreen(window.outerHeight >= window.screen.height)
    check()
    window.addEventListener("resize", check)
    return () => window.removeEventListener("resize", check)
  }, [])

  const needsPadding = IS_MAC && !isFullscreen && !sidebarOccupiesTopLeft

  return {
    needsPadding,
    paddingLeft: needsPadding ? TRAFFIC_LIGHT_WIDTH : 0,
  }
}
