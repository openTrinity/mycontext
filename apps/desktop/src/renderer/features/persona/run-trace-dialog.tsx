/**
 * RunTraceDialog —— 「这句话是怎么来的」：一轮 run 的完整回看，**独立弹窗**。
 *
 * ## ★★ 为什么必须是弹窗，不能是就地展开
 *
 * 它替掉的是 `RunTraceDisclosure`（一个就地展开的折叠块）。那个形态有两处
 * 硬伤，而两处都不是审美问题：
 *
 * 1. **展开区被两层滚动容器夹住**。历史处理结果挂在中栏右上角一个 360px 宽、
 *    `max-h-72`（288px）的 popover 里，而 popover 自己又在
 *    `persona-module` 那个 `overflow-hidden` 的区域里（那一层是布局必需的，
 *    见它的注释）。于是一段几十条 tool_call 的 trace 要**从一个 288px 的
 *    窗口里、并且是在列表滚动条里再套一层内容**去读 —— 用户报的
 *    「没法 scroll、看不全」说的就是这个：能滚，但滚的是外层那条列表，
 *    过程本身永远只露出三四行。
 * 2. **一条 trace 的信息量与"一个折叠块"不匹配**。它是 thinking + 正文 +
 *    工具调用组，本身就有内部折叠（见 `EventStream`）。把一个有内部层级的
 *    东西塞进另一个折叠块，用户点第三层才看到内容。
 *
 * 走 `Dialog`（原生 `<dialog>` + `showModal()`）解决的正是第 1 条：
 * top layer **不受祖先 `overflow`/`z-index`/`transform` 影响** ——
 * 而这一页从中栏区域到 popover 一路都是 `overflow-hidden`。
 * 顺带白拿焦点陷阱与 inert 背景（见 `packages/design/src/components/dialog.tsx`）。
 *
 * ## ★ 全弹窗**只有一个**滚动容器
 *
 * 头部固定（那是"这是哪一轮"），下面整块 `min-h-0 flex-1 overflow-y-auto`。
 * 触发消息、判定、过程、最终发出的那句话全都在**同一条**滚动流里，
 * 按时间顺序读下来就是这一轮的经过。
 *
 * ★ 特别是触发消息与 trace 里的工具输出**不再各给一个 `max-h`**：
 * 嵌套滚动容器正是上面第 1 条的成因，在这里重新引入一个就等于把 bug 搬了个家。
 *
 * ## ★ 两个查询都只在弹窗打开时才发（`open` 直接当 enabled）
 *
 * 历史面板一屏可能 20 条。各预取一遍 trace + 元信息是 40 次库查询
 * （每条要读 `dh_run_trace` 并解析 JSON），而其中 19 条用户不会点开。
 * 所以调用方**只在有目标时才挂载本组件**，`open` 同时是 enabled。
 *
 * ## ★★ 「没有过程」要能说出来，但它**不该是常态**
 *
 * 走直连降级那条路（`via: "llm"`）的轮次不写 trace，升级前生成的也没有 ——
 * 所以空态必须是一句解释，而不是一片空白（否则「没有」与「没加载出来」
 * 在界面上不可区分，那正是本项目最怕的静默降级）。
 *
 * ★★ 但"实测 6 轮里 4 轮空"曾被当成正常并写进注释，那是**误判**：
 * 真实原因是 `appendTrace` 的行主键不带 runId（`dh_run_trace.id` 是
 * PRIMARY KEY，而 item id 来自进程内自增的 turnSeq），重启后新轮次
 * 把旧轮次那一行 `INSERT OR REPLACE` 改嫁走了。已修（见 store 侧
 * `appendTrace` 的注释与 `run-trace-collision.test.ts`）。
 *
 * 所以：**空态普遍出现是写入侧的 bug 信号**，不要再用"直连降级"解释它。
 */
import { useId, useMemo } from "react"
import { Dialog, IconButton, Tag, Tooltip } from "@mycontext/design"
import { usePersonaRunDetail, usePersonaRunTrace } from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { EventStream } from "../agent-stream/event-stream.js"
import { toChatItems } from "../agent-stream/to-chat-items.js"
import { CloseIcon } from "../shell/icons.js"
import { DECISION_STATUS } from "./labels.js"
import { explainDecisionReason } from "./decision-reason.js"
import { fullLabel } from "./message-time.js"

export interface RunTraceDialogProps {
  /**
   * 那一轮 run 的 id。
   *
   * ★ **调用方负责在 null 时不渲染本组件**。`runId` 为 null 意味着
   * "这条本来就不是 agent 生成的"（用户自己写的 / 升级前的旧记录），
   * 根本没有过程可言 —— 给一个点了只会说"没有过程"的入口，
   * 等于让用户白点一次才知道这里没东西，而那与"有 run 但没留下 trace"
   * 是两种不同的事实，不该长成同一个样子。
   */
  runId: string
  open: boolean
  onClose: () => void
  /**
   * 这一轮最终发出的那句话。
   *
   * 草稿卡传 undefined —— 用户眼前正在审的就是那条草稿，
   * 在弹窗里再抄一遍是同一句话说两次。
   */
  resultText?: string
  /** 来源标签（"自动发送" / "已采纳"）。草稿卡没有（它还没发） */
  kindLabel?: string
  /** 这一轮发生的时间。草稿卡可以给创建时间 */
  occurredAt?: number
}

export function RunTraceDialog({
  runId,
  open,
  onClose,
  resultText,
  kindLabel,
  occurredAt,
}: RunTraceDialogProps) {
  const { t } = useDynamicTranslation("persona")
  const { t: tc } = useDynamicTranslation()
  const titleId = useId()

  // ★ enabled = open：关着时一次库都不查（见文件头）
  const trace = usePersonaRunTrace(runId, open)
  const detail = usePersonaRunDetail(runId, open)
  const items = useMemo(() => toChatItems(trace.data ?? []), [trace.data])

  const data = detail.data ?? null
  const explained = explainDecisionReason(data?.decisionReason ?? null)
  /**
   * 判定的可读名。
   *
   * ★ 未登记的 decision **原样显示**那个机器码，而不是套一个兜底词：
   * 兜底会把一个我们还没处理的新状态伪装成已知态（`run-log` 同口径）。
   */
  const decisionLabel =
    data === null
      ? null
      : DECISION_STATUS[data.decision] === undefined
        ? data.decision
        : t(`decisions.${data.decision}`)

  return (
    <Dialog open={open} onClose={onClose} className="radius-xl" labelledBy={titleId}>
      <div
        className="relative flex flex-col overflow-hidden radius-xl border border-[var(--border-light)] bg-[var(--bg-base-normal)] shadow-[var(--shadow-lg)]"
        style={{
          width: "min(760px, calc(100vw - 96px))",
          height: "min(720px, calc(100vh - 96px))",
        }}
      >
        {/*
          ── 头部：这是哪一轮 ─────────────────────────────
          固定不滚。标题回答的是这个弹窗要解决的问题（"这句话是怎么来的"），
          副行是可核对的事实：来源 / 时间 / 耗时 token。

          ★ 副行的每一项都可空（老记录、直连降级那条路不记耗时），
          全空时整行不渲染 —— 而不是显示 "· —s · — tokens" 那种噪音。
        */}
        <header className="flex shrink-0 items-start gap-2 border-b border-[var(--border-divider-light)] px-5 py-3.5">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2
              id={titleId}
              className="typography-body-base-500 min-w-0 truncate text-[var(--text-base-primary)]"
            >
              {t("traceDialogTitle")}
            </h2>
            <div className="typography-caption-400 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[var(--text-base-tertiary)]">
              {kindLabel === undefined ? null : (
                <Tag size="sm" status="accent">
                  {kindLabel}
                </Tag>
              )}
              {occurredAt === undefined ? null : <span>{fullLabel(occurredAt)}</span>}
              {data === null || (data.latencyMs === null && data.costTokens === null) ? null : (
                <>
                  {kindLabel === undefined && occurredAt === undefined ? null : (
                    <span aria-hidden className="text-[var(--text-base-disable)]">
                      ·
                    </span>
                  )}
                  <span>
                    {t("runDetailCost", {
                      seconds: ((data.latencyMs ?? 0) / 1000).toFixed(1),
                      tokens: data.costTokens ?? 0,
                    })}
                  </span>
                </>
              )}
            </div>
          </div>
          <Tooltip content={tc("actions.close")} placement="left">
            <IconButton label={tc("actions.close")} size="sm" onClick={onClose}>
              <CloseIcon />
            </IconButton>
          </Tooltip>
        </header>

        {/*
          ── 唯一的滚动容器 ───────────────────────────────
          ★ 这一层是本次修复的核心：整段经过在**一条**滚动流里，
          `min-h-0` 让 flex 子项真的能被压缩（缺了它 `flex-1` 不会收缩，
          内容会把弹窗顶破而不是滚动 —— 那是 flex 布局里最常见的"滚不动"成因）。
          `overscroll-contain` 让滚到底时不把滚动传给背后的页面。
        */}
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-4">
          {detail.isPending ? null : data === null ? (
            /**
             * 查不到那一轮（老库 / 已被保留策略清掉）—— 明说，而不是不显示。
             * 不显示会让人以为"这条就是没有元信息"，而事实是"记录没了"。
             */
            <p className="typography-body-small-400 text-[var(--text-base-tertiary)]">
              {t("runDetailMissing")}
            </p>
          ) : (
            <>
              {/*
                触发消息：回答"为什么这一轮会跑"。
                ★ 不给 `max-h`：嵌套滚动容器正是本次修复的对象（见文件头）。
              */}
              {data.trigger === null ? null : (
                <section className="flex flex-col gap-1.5">
                  <SectionLabel>{t("runDetailTrigger")}</SectionLabel>
                  <div className="flex flex-col gap-1 radius-md bg-[var(--bg-card-z0)] px-3 py-2">
                    <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
                      {data.trigger.senderDisplayName ?? t("recordSearchUnknownSender")}
                    </span>
                    <p className="typography-body-small-400 whitespace-pre-wrap break-words text-[var(--text-base-secondary)]">
                      {data.trigger.contentText ?? ""}
                    </p>
                  </div>
                </section>
              )}

              {/*
                判定与原因。
                ★ 原因复用 `explainDecisionReason` —— 同一个 reason 在运行日志、
                草稿卡与这里必须是**同一句话**，否则用户会以为是两回事。
                那个函数用 `Record<DecisionReason, …>`，policy 加一条新 reason
                时不补就编译不过。
              */}
              <section className="flex flex-col gap-1.5">
                <SectionLabel>{t("runDetailDecision")}</SectionLabel>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Tag size="sm" status={DECISION_STATUS[data.decision] ?? "default"}>
                    {decisionLabel}
                  </Tag>
                  {explained === null ? null : (
                    <span className="typography-body-small-400 text-[var(--text-base-secondary)]">
                      {t(explained.labelKey)}
                    </span>
                  )}
                </div>
                {data.error === null ? null : (
                  <p className="typography-caption-400 whitespace-pre-wrap break-words text-[var(--status-error)]">
                    {data.error}
                  </p>
                )}
              </section>
            </>
          )}

          {/* agent 的真实过程：thinking / 正文 / 工具调用组 */}
          <section className="flex flex-col gap-2">
            <SectionLabel>{t("traceSectionProcess")}</SectionLabel>
            {trace.isPending ? (
              <p className="typography-body-small-400 text-[var(--text-base-tertiary)]">
                {t("dockTraceLoading")}
              </p>
            ) : items.length === 0 ? (
              /**
               * ★ 没有痕迹要**说出来**（见文件头「没有过程」那一段）——
               * 显示一片空白等于让"没有"与"没加载出来"不可区分。
               */
              <p className="typography-body-small-400 text-[var(--text-base-tertiary)]">
                {t("dockTraceEmpty")}
              </p>
            ) : (
              <EventStream items={items} />
            )}
          </section>

          {/*
            最终发出的那句话 —— 放在最后是因为这一屏是按**时间顺序**读的：
            触发 → 判定 → 过程 → 结果。草稿卡不传（用户眼前就是那条草稿）。
          */}
          {resultText === undefined ? null : (
            <section className="flex flex-col gap-1.5">
              <SectionLabel>{t("traceSectionResult")}</SectionLabel>
              <p className="typography-body-reading-400 whitespace-pre-wrap break-words radius-md bg-[var(--bg-card-accent)] px-3 py-2 text-[var(--text-base-primary)]">
                {resultText}
              </p>
            </section>
          )}
        </div>
      </div>
    </Dialog>
  )
}

/**
 * 分段标签：一个短词 + 一条填满剩余宽度的发丝线。
 *
 * ## ★ 为什么不用小标题（`h3` + 加重字号）
 *
 * 这一屏有四段，而它们都不是"内容"—— 是内容的**索引**。用标题号会让
 * 四个标签比它们标注的东西更抢眼（`EventStream` 的正文才是这一屏的重心）。
 * caption 号 + 一条线把"这里换段了"说清，同时不加视觉重量。
 *
 * 线用 `aria-hidden`：它是纯视觉的，读屏器念一个空 span 只是噪音。
 */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="typography-caption-400 shrink-0 text-[var(--text-base-tertiary)]">
        {children}
      </span>
      <span aria-hidden className="h-px min-w-0 flex-1 bg-[var(--border-divider-light)]" />
    </div>
  )
}
