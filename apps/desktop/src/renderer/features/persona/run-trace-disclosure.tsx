/**
 * RunTraceDisclosure —— 「看处理过程」的可展开块。
 *
 * ## ★ 为什么提取成共用组件
 *
 * 两处需要它，而它们问的是同一个问题（这句话是怎么想出来的）：
 * · 草稿卡（`reply-dock`）—— 审这条草稿之前想看看它怎么来的；
 * · 历史处理结果（`activity-feed`）—— 事后回看分身替我说的那句话。
 *
 * 各写一份必然漂：这块有**四个状态**（收起 / 加载中 / 有内容 / 没有过程），
 * 而最后那个是最容易漏的 —— 漏了它「没有过程」与「没加载出来」在界面上
 * 长得一样，那正是本项目最怕的静默降级。
 *
 * ## ★★ 默认收起，展开才查库
 *
 * `usePersonaRunTrace(runId, open)` 的第二个参数是 `enabled`。
 * 一屏可能有 20 条历史，各预取一遍 trace 是真实的性能问题（每条都要读
 * `dh_run_trace` 并解析 JSON），而其中 19 条用户不会展开。
 *
 * ## ★ 「没有过程」是常态，不是异常
 *
 * 实测本机 6 轮里只有 2 轮有 trace：走**直连降级**那条路（`via: "llm"`）
 * 的轮次不写 trace，升级前生成的也没有。所以空态必须是一句解释，
 * 而不是一片空白。
 */
import { useMemo, useState } from "react"
import { EventStream } from "../agent-stream/event-stream.js"
import { toChatItems } from "../agent-stream/to-chat-items.js"
import { usePersonaRunTrace } from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

export interface RunTraceDisclosureProps {
  /** 那一轮 run 的 id。**调用方负责在 null 时不渲染本组件**（见下） */
  runId: string
  /**
   * 展开时先渲染的一段（元信息：触发消息 / 判定 / 耗时）。
   *
   * ★ 由调用方给而不是本组件自己查：草稿卡不需要它（用户正在看的就是
   * 那条草稿本身），而历史面板需要 —— 让本组件多查一次没人看的东西
   * 是白付的代价。
   */
  header?: React.ReactNode
}

/**
 * ★ `runId` 为 null 时**不要渲染本组件**（调用方判）。
 *
 * 那意味着"这条本来就不是 agent 生成的"（用户自己写的 / 升级前的旧记录），
 * 根本没有过程可言。渲染一个点了只会显示"没有过程"的按钮，
 * 等于让用户白点一次才知道这里没东西 —— 而那与"有 run 但没留下 trace"
 * 是两种不同的事实，不该长成同一个样子。
 */
export function RunTraceDisclosure({ runId, header }: RunTraceDisclosureProps) {
  const { t } = useDynamicTranslation("persona")
  const [open, setOpen] = useState(false)
  // ★ enabled = open：收起时一次库都不查（见文件头）
  const trace = usePersonaRunTrace(runId, open)
  const items = useMemo(() => toChatItems(trace.data ?? []), [trace.data])

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="typography-caption-400 self-start text-[var(--text-base-tertiary)] transition-colors duration-150 hover:text-[var(--text-base-secondary)]"
      >
        {open ? t("dockTraceHide") : t("dockTraceShow")}
      </button>
      {!open ? null : (
        <>
          {header}
          {trace.isPending ? (
            <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
              {t("dockTraceLoading")}
            </span>
          ) : items.length === 0 ? (
            /**
             * ★ 没有痕迹是**正常状态**（这一轮走的是直连降级那条路，
             * 或者是升级前生成的旧记录）—— 说清"没有"，而不是显示一个
             * 空白区域让人以为没加载出来。
             */
            <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
              {t("dockTraceEmpty")}
            </span>
          ) : (
            <EventStream items={items} />
          )}
        </>
      )}
    </div>
  )
}
