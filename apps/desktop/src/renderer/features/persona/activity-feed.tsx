/**
 * ActivityFeed —— 「历史处理结果」：分身替我发过的、和我采纳过的那些回复。
 *
 * ## ★★ 每一条的过程是**一个独立弹窗**，不是就地展开
 *
 * 原来每项下面挂一个「看生成过程」的折叠块（`RunTraceDisclosure`），
 * 展开后就地铺开元信息 + trace。这个形态在真实数据上是读不了的：
 *
 * 这一栏住在中栏右上角一个 360px 宽、`max-h-72`（288px）的 popover 里，
 * 而 popover 又在 `persona-module` 那个 `overflow-hidden` 的布局区里。
 * 于是一段几十条 tool_call 的 trace 要从 288px 的窗口里读，滚的还是
 * **外层那条列表**的滚动条 —— 用户报的「没法 scroll、看不全」就是这个。
 * 而且展开一条会把列表里其余条目全推到视野外，用户丢失了"我在看哪一条"。
 *
 * 现在整行可点 → 开 `RunTraceDialog`（原生 `<dialog>`，top layer 不受
 * 祖先 overflow 影响）。列表本身回到它该做的事：**扫一眼有哪些**。
 *
 * ## ★★ 三种状态必须长得不一样
 *
 * ```
 * runId 为 null            → 整行不可点（本来就不是 agent 生成的，没有过程可言）
 * 有 runId 但 trace 为空   → 可点，弹窗里说"这一轮没有留下过程"
 * 有 runId 且有 trace      → 可点，弹窗里是完整过程
 * ```
 * 中间那种必须能说出来：把它显示成一片空白，就等于让「没有」与
 * 「没加载出来」不可区分。
 *
 * ★★ 但它**不该普遍出现**。曾经"6 轮里 4 轮如此"被归因为"走了直连降级
 * 那条路"—— 那是误判：真实原因是 `appendTrace` 的行主键不带 runId，
 * 重启后新轮次把旧轮次的痕迹整行改嫁走了（已修，见 store 侧那个方法）。
 * 再次普遍出现时先查写入侧，别照抄那个解释。
 *
 * ## ★ 一次只有一个弹窗（`openId` 是单值而不是 Set）
 *
 * 于是**至多一个** run 的 trace + 元信息在查库。原来每条各挂一个折叠块时
 * 用户可以展开好几条，那就是好几组查询同时在跑；而"同时读两条的过程"
 * 本来也不是一个真实的动作。
 */
import { useState } from "react"
import { Tag, cn } from "@mycontext/design"
import type { PersonaActivityView } from "@mycontext/ipc-contract"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { ChevronDownIcon } from "../agent-stream/tool-icons.js"
import { RunTraceDialog } from "./run-trace-dialog.js"

export interface ActivityFeedProps {
  activities: readonly PersonaActivityView[]
}

function timeLabel(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms))
}

export function ActivityFeed({ activities }: ActivityFeedProps) {
  const { t } = useDynamicTranslation("persona")
  /**
   * 哪一条的过程弹窗开着（`activity.id`，不是 runId —— 同一个 run 理论上
   * 可以对应两条活动记录，用 activity.id 才能保证"点的就是打开的那条"）。
   */
  const [openId, setOpenId] = useState<string | null>(null)
  const opened = activities.find((activity) => activity.id === openId) ?? null

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="typography-body-small-400 font-medium text-[var(--text-base-primary)]">
          {t("activityTitle")}
        </h3>
        <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {t("activityDescription")}
        </p>
      </div>

      {activities.length === 0 ? (
        <div className="flex flex-col gap-1 rounded-[var(--radius-md)] border border-dashed border-[var(--border-divider-light)] p-3">
          <p className="typography-body-small-400 text-[var(--text-base-secondary)]">
            {t("activityEmpty")}
          </p>
          <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
            {t("activityEmptyHint")}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col">
          {activities.map((activity) => (
            <li key={activity.id}>
              <ActivityRow
                activity={activity}
                kindLabel={t(`activityKinds.${activity.kind}`)}
                openHint={t("traceOpenHint")}
                noTraceHint={t("traceNoRunHint")}
                onOpen={() => setOpenId(activity.id)}
              />
            </li>
          ))}
        </ul>
      )}

      {/*
        ★ 弹窗**只在有目标时才挂载**，而不是恒挂一个 `open={false}` 的。
        `RunTraceDialog` 的两个查询以 `open` 当 enabled，恒挂虽然也不会查，
        但那时它需要一个假的 runId —— 而"给一个不存在的 id 只为了让组件
        挂得住"是下一个 bug 的入口。

        `opened.runId` 再判一次 null：`ActivityRow` 已经保证 null 时不可点，
        这里是类型收窄（也是那条不变式的第二道保险）。
      */}
      {opened === null || opened.runId === null ? null : (
        <RunTraceDialog
          /**
           * ★ `key` 带 activity.id：换一条时要**换一个**组件实例。
           * 复用同一个实例的话 `usePersonaRunTrace(runId)` 换了 key
           * 但组件还在旧的 isPending 状态里，会闪一下上一条的内容。
           */
          key={opened.id}
          runId={opened.runId}
          open
          onClose={() => setOpenId(null)}
          resultText={opened.text}
          kindLabel={t(`activityKinds.${opened.kind}`)}
          occurredAt={opened.occurredAt}
        />
      )}
    </section>
  )
}

/**
 * 一条历史：来源标签 + 时间 + 正文前三行。
 *
 * ## ★ 整行可点，而不是行内再放一个「看过程」按钮
 *
 * 这一行**没有别的动作** —— 用户在这里唯一想做的事就是"看看这句是怎么来的"。
 * 那种情况下把点击目标缩小到一个 12px 的小字链接只是让人点得更费劲
 * （而它旁边的正文明明是这一行的主体）。
 *
 * ★ 用 `<button>` 而不是给 `<li>` 挂 onClick：点击能力必须落在可聚焦、
 * 有语义的元素上（键盘能 Tab 到并回车，读屏器会念"按钮"）。
 * 挂了 onClick 的 li 仍然只是一段文字 —— 这与 `message-thread` 里
 * `QuotedBlock` / `AgentSendBadge` 是同一条规则。
 *
 * ## ★ `runId` 为 null → 退回 `<div>`，不是一个 disabled 的按钮
 *
 * 那不是"暂时不能点"，而是**本来就不可点**（用户自己写的那条 / 升级前的
 * 旧记录，根本没有过程）。给个 disabled 按钮会让人反复去点，
 * 而给一句说明（`title`）能让人知道为什么。
 */
function ActivityRow({
  activity,
  kindLabel,
  openHint,
  noTraceHint,
  onOpen,
}: {
  activity: PersonaActivityView
  kindLabel: string
  openHint: string
  noTraceHint: string
  onOpen: () => void
}) {
  const inner = (
    <>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <Tag size="sm" status={activity.kind === "auto_sent" ? "success" : "accent"}>
            {kindLabel}
          </Tag>
          <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
            {timeLabel(activity.occurredAt)}
          </span>
        </div>
        <p className="typography-body-small-400 line-clamp-3 whitespace-pre-wrap break-words text-left text-[var(--text-base-secondary)]">
          {activity.text}
        </p>
      </div>
      {/*
        右指的 chevron —— "点了会打开一层"的标准提示。
        ★ 常态半透明、hover/focus 才变实：它是提示而不是装饰，
        一列常显的实心箭头会与正文抢注意力（`EventStream` 的工具行同款判据）。
      */}
      <ChevronDownIcon
        className={cn(
          "mt-0.5 size-3.5 shrink-0 -rotate-90 text-[var(--text-base-disable)]",
          "transition-[opacity,color] duration-150 ease-out motion-reduce:transition-none",
          "opacity-50 group-hover:opacity-100 group-hover:text-[var(--text-base-secondary)]",
          "group-focus-visible:opacity-100",
        )}
      />
    </>
  )

  const shared =
    "flex w-full items-start gap-2 border-b border-[var(--border-divider-light)] px-2 py-2.5 last:border-b-0"

  if (activity.runId === null) {
    return (
      <div className={shared} title={noTraceHint}>
        {inner}
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      title={openHint}
      className={cn(
        shared,
        "group -mx-1 rounded-[var(--radius-md)] px-3 text-left",
        "transition-colors duration-150 ease-out motion-reduce:transition-none",
        "hover:bg-[var(--overlay-on-container-hover)]",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]",
      )}
    >
      {inner}
    </button>
  )
}
