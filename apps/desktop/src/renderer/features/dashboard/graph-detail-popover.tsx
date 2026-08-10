/**
 * 图谱的「详情」popover —— 把三类**不需要立刻动手**的信息收进来。
 *
 * ## 为什么是 popover 而不是常驻在版面上
 *
 * 这一轮往「它认识的人与事」板块顶部堆了四行常驻文字（建图失败、降级原因、
 * 调度倒计时、上一轮产出），把图挤下去大半屏。而后三行回答的都是
 * **"不是现在要做什么"**：调度是预告、产出是回顾、进度是那颗按钮已经在说的事。
 *
 * 判据留在 `classifyGraphReason`（纯函数）：只有"要用户动手"的那一档
 * 仍然常驻在板块里，其余进这里。
 *
 * ## ★ 骨架逐行照抄 `persona/chat-header.tsx` 的「历史处理结果」
 *
 * 那里的注释记了两个踩过的坑，这里同样适用：
 * · 滚动容器**必须**是有 `max-h` 的那一层（`min-h-0 flex-1 overflow-y-auto`）
 *   —— 挂在没有高度约束的祖先上是"能滚不动"的经典成因；
 * · 高度用 `max-h-[min(60vh,32rem)]` 而不是写死的 `max-h-72`（288px）——
 *   后者在 800px 高的窗口里只用掉 36%，明明有地方可以长却把自己压矮。
 *
 * 不新建 Popover 组件：design 包里没有，而这一处与 chat-header 那一处
 * 加起来才两个用例 —— 抽象成组件的收益还不如两处各自可读。
 */
import { useState } from "react"
import type { KlGraphOverview } from "@mycontext/ipc-contract"
import { cn, IconButton, Tooltip } from "@mycontext/design"
import {
  describeBuildSchedule,
  describeBuildVolume,
  formatCount,
  formatDuration,
} from "./dashboard-data.js"

export interface GraphDetailPopoverProps {
  overview: KlGraphOverview | null
  /** 进度类的状态说明（`classifyGraphReason` 判成 progress 的那一档） */
  progressNote: string | null
}

/**
 * 一行「标签 — 值」。
 *
 * ★ 用 `justify-between` 而不是表格：这里只有 5-6 行、标签长度接近，
 * 表格的对齐收益抵不上它带来的结构（`status-panel.tsx` 里同一款做法）。
 */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="typography-caption-400 shrink-0 text-[var(--text-base-tertiary)]">
        {label}
      </span>
      <span className="typography-body-small-400 text-right text-[var(--text-base-primary)]">
        {value}
      </span>
    </div>
  )
}

/** 分段标签：一个短词 + 一条填满剩余宽度的发丝线（与 RunTraceDialog 同款）。 */
function SectionLabel({ children }: { children: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="typography-caption-400 shrink-0 text-[var(--text-base-tertiary)]">
        {children}
      </span>
      <span className="h-px flex-1 bg-[var(--border-divider-light)]" aria-hidden />
    </div>
  )
}

export function GraphDetailPopover({ overview, progressNote }: GraphDetailPopoverProps) {
  const [open, setOpen] = useState(false)

  const schedule = describeBuildSchedule(overview?.buildSchedule ?? null)
  const volumeText = describeBuildVolume(overview?.lastBuild ?? null)
  const lastBuild = overview?.lastBuild ?? null
  const sched = overview?.buildSchedule ?? null

  /**
   * ★ 三段都空 → **不渲染这颗按钮**。
   *
   * 一个点开之后什么都没有的入口比没有入口更糟：用户会以为它坏了。
   * 未登录 / 没接自动构建 / 还没建过图时就是这个状态。
   */
  const hasAnything = schedule !== null || volumeText !== null || progressNote !== null
  if (!hasAnything) return null

  /**
   * hover 的摘要：优先说"下次什么时候更新"——那是这颗按钮最常被问到的事。
   * 没有调度信息时退回进度说明。
   */
  const summary = schedule?.text ?? progressNote ?? "图谱详情"

  return (
    <div className="relative">
      <Tooltip content={summary} placement="bottom">
        <IconButton
          label="图谱详情"
          size="sm"
          onClick={() => {
            setOpen((v) => !v)
          }}
          aria-expanded={open}
        >
          <InfoGlyph />
        </IconButton>
      </Tooltip>

      {open ? (
        <>
          {/* 点外面收起 —— 一个透明的全屏捕获层，不压暗（它只是个小 popover） */}
          <div
            className="fixed inset-0 z-30"
            aria-hidden
            onClick={() => {
              setOpen(false)
            }}
          />
          {/*
            ★ 宽 300 而不是 340（chat-header 那个是 380）。
            实测截图：340 会盖住右侧「直接关联」那一列的权重条 ——
            那一列是这个板块的主要内容之一，遮住它比省几个换行糟。
            这里的内容都是短行（标签 + 一个数），300 够用。
          */}
          <div className="absolute right-0 top-full z-40 mt-1 flex max-h-[min(60vh,32rem)] w-[300px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-pop)] shadow-[var(--shadow-lg)]">
            <div className="flex shrink-0 flex-col gap-0.5 border-b border-[var(--border-divider-light)] px-3 py-2.5">
              <span className="typography-body-small-400 font-medium text-[var(--text-base-primary)]">
                图谱详情
              </span>
              <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
                建了多少、下次什么时候建
              </span>
            </div>

            {/* ★ 只有这一层滚（见文件头：min-h-0 缺了就顶破 max-h 而不是滚动） */}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
              <div className="flex flex-col gap-4">
                {/*
                  ① 上一轮建了多少 —— 拆成行而不是一长句。
                  那句话在版面上是一行 80 字，扫不出重点；拆开之后
                  「跳过 36,613」与「处理 41」的对比一眼就看得到（那正是
                  增量真的生效了的证据）。
                */}
                {lastBuild === null ? null : (
                  <section className="flex flex-col gap-1.5">
                    <SectionLabel>上一轮建了多少</SectionLabel>
                    <Row
                      label="新增"
                      value={`${signed(lastBuild.entities)} 实体 · ${signed(lastBuild.facts)} 事实 · ${signed(lastBuild.edges)} 关系`}
                    />
                    {lastBuild.unitsProcessed > 0 ? (
                      <Row
                        label="处理语料"
                        value={`${formatCount(lastBuild.unitsProcessed)} 条（切 ${formatCount(lastBuild.chunksCreated)} 块）`}
                      />
                    ) : null}
                    {/*
                      ★ 跳过那行要说清它**是好事**（已抽过 = 省了 LLM 调用）。
                      光报数字会被读成"漏了 N 条"—— 那是数据缺失的语气，
                      而这里恰恰相反。
                    */}
                    {lastBuild.unitsSkipped > 0 ? (
                      <Row
                        label="增量省下"
                        value={`${formatCount(lastBuild.unitsSkipped)} 条已抽过，跳过`}
                      />
                    ) : null}
                  </section>
                )}

                {/* ② 下次什么时候建 */}
                {schedule === null ? null : (
                  <section className="flex flex-col gap-1.5">
                    <SectionLabel>下次什么时候建</SectionLabel>
                    <p
                      className={cn(
                        "typography-body-small-400",
                        schedule.tone === "warn"
                          ? "text-[var(--status-warning)]"
                          : "text-[var(--text-base-primary)]",
                      )}
                    >
                      {schedule.text}
                    </p>
                    {/*
                      ★ 两个阈值都报：用户看到"还差 N 条"时会想知道 N 是相对
                      什么。而它们是**可配置**的（设置里那两项）——
                      不报的话那句话读起来像写死的规则。
                    */}
                    {sched === null ? null : (
                      <>
                        <Row label="攒够条数" value={`${formatCount(sched.lagThreshold)} 条`} />
                        <Row label="最小间隔" value={formatDuration(sched.minIntervalMs)} />
                      </>
                    )}
                  </section>
                )}

                {/*
                  ③ 当前状态 —— 只有进度那一档进来（要动手的那档仍常驻在
                  板块里，见 `classifyGraphReason`）。
                */}
                {progressNote === null ? null : (
                  <section className="flex flex-col gap-1.5">
                    <SectionLabel>当前状态</SectionLabel>
                    <p className="typography-body-small-400 text-[var(--text-base-secondary)]">
                      {progressNote}
                    </p>
                  </section>
                )}
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

/**
 * 净增带符号。
 *
 * ★ 负数原样显示：`fresh` 重建先清空、或上游合并了重复实体都会让某项减少。
 * 夹到 0 会把"合并生效了"说成"没变化"（与 `describeBuildVolume` 同一条理由）。
 */
function signed(n: number): string {
  return n > 0 ? `+${formatCount(n)}` : formatCount(n)
}

function InfoGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden="true">
      <circle cx="8" cy="8" r="5.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 7.1v3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="5.2" r="0.8" fill="currentColor" />
    </svg>
  )
}
