/**
 * 联动带 —— 图与事实之间那条**看得见的**因果。
 *
 * ## ★ 它解决的具体问题
 *
 * 用户原话：「我点个图谱的点我很难感知到下面会有筛选的感觉」。
 *
 * 代码上联动一直是通的（`dashboard-module` 把 `entityFocus` 提到页面级，
 * 两个子组件都接好了）。断的是**反馈**：点一个节点之后，唯一的变化是
 * 大约一屏之外的筛选器行里多了一枚小筹码「关于 小周 ×」。页面不滚、
 * 不高亮、图上那个点也不显示"我已经是筛选条件了"。
 *
 * 一个通了但看不见的联动，在用户侧与没做完全一样 —— 这正是这个仓库
 * 反复记录的那类失效（"点了没反应"）。
 *
 * ## 三个同时发生的信号
 *
 * ① **没选中时也在**：一行「点图上任意一个点 → 下面只看关于他的事实」。
 *    把那条暗线**写出来**。不写的话用户没有任何理由去点一个点 ——
 *    可发现性不能靠"试一下就知道了"。
 * ② **选中后变成一条实心带**：`正在看 [色点]小周 的事实`。色点用
 *    `entityColor(type, mode)` —— 与图上那个点**同一个值**。颜色是
 *    "上面那个点 = 这条带 = 下面这批事实"三者之间的连接件，
 *    而不是装饰。
 * ③ **位置**：它就在图与事实列表**中间**。合并成一个板块之后这条缝
 *    是唯一能同时被两边看到的地方 —— 放在图上面（用户在看图）或
 *    列表下面（滚过去才看到）都不成立。
 *
 * 滚动跟随由调用方做（它才知道自己在哪个容器里）—— 见
 * `dashboard-module` 里那个 `useEffect`。
 */
import { cn } from "@mycontext/design"

export interface FocusBridgeProps {
  /** 当前筛选的实体名。`null` = 没筛 */
  focus: string | null
  /** 这个实体在图里的类型色。`null` = 不在 ego 图里（比如从事实列表点进来的） */
  color: string | null
  /** 当前筛出来多少条。`null` = 还在查 */
  count: number | null
  onClear: () => void
}

export function FocusBridge({ focus, color, count, onClear }: FocusBridgeProps) {
  if (focus === null) {
    /**
     * 提示态：低对比、无边框、不占卡片 —— 它是一句说明，不是一个控件。
     * 用 `border-l` 而不是整框：竖线把"这句话属于下面那块"表达出来，
     * 而一个完整的框会让它看起来像一个可点的东西。
     */
    return (
      <p className="typography-caption-400 border-l-2 border-[var(--border-divider-light)] pl-3 text-[var(--text-base-tertiary)]">
        点图上任意一个点 —— 下面只看关于他的事实
      </p>
    )
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] px-3 py-2",
        // 实心底 + 左侧色条：与提示态形成明确的"状态变了"的对比
        "bg-[var(--status-fill-info-container)]",
      )}
      role="status"
    >
      {/* 色点与图上那个节点同一个填充色（见文件头） */}
      {color === null ? null : (
        <span
          aria-hidden
          className="size-2.5 shrink-0 rounded-full"
          style={{ background: color }}
        />
      )}
      <span className="typography-body-small-400 min-w-0 text-[var(--text-base-primary)]">
        正在看 <span className="font-medium">{focus}</span> 的事实
      </span>
      {count === null ? null : (
        <span className="typography-caption-400 shrink-0 tabular-nums text-[var(--text-base-secondary)]">
          {count} 条
        </span>
      )}
      <button
        type="button"
        onClick={onClear}
        className="typography-caption-400 ml-auto shrink-0 rounded-full px-2 py-0.5 text-[var(--status-link)] transition-colors duration-150 hover:bg-[var(--overlay-on-container-hover)]"
      >
        看全部
      </button>
    </div>
  )
}
