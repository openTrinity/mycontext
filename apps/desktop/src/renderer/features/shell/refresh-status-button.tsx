/**
 * RefreshStatusButton — 顶栏右上角的「刷新状态」图标按钮。
 *
 * ## 它做什么 / 不做什么
 *
 * 点它把这一屏的所有 query 失效重取一遍（`queryClient.invalidateQueries()`）——
 * **不**去拉新消息（那是 `ingest.runOnce`，另有入口）。文案必须说清这一点，
 * 否则用户会以为点一下就能把落后的消息补上来。
 *
 * ## ★ 为什么需要它（而不是自动轮询）
 *
 * 这一屏的数字平时靠**事件推送**保持新鲜（`useIngestProgress` 把主进程推来的
 * 快照直接写进 query cache）——采集在跑时它比任何轮询都实时、也更省。
 * 但采集**不跑**时就没有事件，而那恰好是最需要看状态的时候（身份没绑上、
 * 被 blocked、权限不足）：数字停在旧值上，用户唯一的出路是重启应用。
 * 所以刷新是一个**用户主动**的动作，与"系统自动保持新鲜"并存。
 *
 * ## ★ 为什么放在顶栏而不是仪表盘正文里
 *
 * 上一版它挂在 greeting 那一行（`ml-auto` 推到最右），落在问候语与大数字
 * 之间一片空白的奇怪位置（用户反馈）。刷新是**整屏**的动作、且与顶栏那枚
 * 渠道筹码（「钉钉」）同一类"这一屏的全局控制"，所以归到顶栏右侧、
 * 筹码的**左边** —— 与 macOS 交通灯/筹码在同一条操作带上。
 *
 * ## ★ 自包含
 *
 * 刷新逻辑只用 `useQueryClient`（全局的），不依赖仪表盘的任何 state，
 * 所以整块（按钮 + 转圈图标 + 失效逻辑）自成一个组件，放哪都行。
 */
import { useState } from "react"
import { IconButton, cn } from "@mycontext/design"
import { useQueryClient } from "@tanstack/react-query"

export function RefreshStatusButton() {
  /**
   * 用 `useQueryClient` 全失效而不是逐个 hook 的 `refetch()`：这一屏的数据来自
   * 十几个 query（采集/图谱/数字人/水位/身份…），逐个列举必然漏，
   * 而漏掉的那个恰好就是用户在看的那个。全失效的代价是一次多余的重取。
   */
  const queryClient = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)

  return (
    <IconButton
      label="刷新状态"
      size="sm"
      variant="ghost"
      disabled={refreshing}
      onClick={() => {
        setRefreshing(true)
        void queryClient.invalidateQueries().finally(() => setRefreshing(false))
      }}
      title="重新读取这一屏的状态（不会去拉新消息）"
    >
      <RefreshGlyph spinning={refreshing} />
    </IconButton>
  )
}

/** 循环箭头图标；刷新中转圈（`animate-spin`，reduced-motion 下不转）。 */
function RefreshGlyph({ spinning }: { spinning: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={cn("size-4", spinning ? "animate-spin motion-reduce:animate-none" : "")}
      aria-hidden="true"
    >
      {/* 循环箭头：一段近乎整圈的弧 + 一个箭头，读作"重新读一遍" */}
      <path
        d="M13 8a5 5 0 1 1-1.46-3.54"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M13.4 2.6v2.2h-2.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
