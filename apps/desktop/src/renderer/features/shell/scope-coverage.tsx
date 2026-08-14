/**
 * 「这段日期已有多少 / 齐没齐」—— 学习范围的覆盖面。
 *
 * ## ★★★ 这里**不画进度条**，因为分母拿不到
 *
 * 用户问的是「要多少、共已经有了多少」。前半个数**在渠道 API 里不存在**
 * （`packages/channels/src/types.ts` 只有 `hasMore` / `nextCursor`，
 * 没有"某会话某天共 N 条"）。所以这个组件只说能观测到的事：
 *
 * · `drained = true` 的天 → 「已采完」，那天的条数就是全部；
 * · `drained = false` 的天 → 「还在回溯」，条数是**下界**。
 *
 * 硬要一个百分比就只能编分母，而这个项目已经为此吃过一次：仪表盘那句
 * 红字「才学了 0.0%」是假的（拿一个从没推过的游标当分子）。所以这里
 * 宁可显示两个诚实的数字（已采完 X 天 / 还在回溯 Y 天），也不显示一个
 * 好看但没有意义的比例。
 */
import { useMemo } from "react"
import type { CoverageDomain } from "@mycontext/ipc-contract"
import { useChatCoverage } from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

/**
 * 把一个时间戳算成 `YYYY-MM-DD`（**本地时区**）。
 *
 * ★ 必须与写入侧 `@mycontext/store` 的 `toDayBucket` 用同一个判据 ——
 * 那边按本地时区算，这里若用 UTC，查询区间就会偏一天，而两边的数字
 * 都"看起来对"。渲染层不能 import 主进程的 store 包，所以这里是一份
 * 刻意的同构实现，改一处必须改两处。
 */
function toDayBucket(at: number): string {
  const date = new Date(at)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

/**
 * 每个域的**量词**与名字。
 *
 * ## ★★ 为什么必须按域给量词，而不是统一说"条"
 *
 * 「已有 300 条文档」是错的中文（文档按**篇**、会议按**场**）。
 * 而这不只是文案洁癖：三栏并排显示时，量词是用户区分
 * "这一行讲的是哪类数据"的**唯一**线索 —— 三行都说"条"读起来像
 * 同一个数字被显示了三遍。
 *
 * ★ `label` 也在这里给：界面上那三行需要一个标题，而把它交给调用方
 * 会让三处各写一份（然后其中一处漂成"文件"）。
 */
const DOMAIN_WORDS: Record<CoverageDomain, { label: string; unit: string }> = {
  chat: { label: "消息", unit: "条" },
  minutes: { label: "会议听记", unit: "场" },
  doc: { label: "文档", unit: "篇" },
}

export function ScopeCoverage({
  channelId,
  /**
   * 学习范围的时间设定 —— 直接收 `SourcesDraft` 的那两个字段。
   *
   * ★ 收 `rangeDays`/`customRange` 而不是一个 unix 时间戳：草稿里本来就是
   * 这两个形状，而 `customRange` 已经是 `YYYY-MM-DD` —— 让调用方先转成
   * 时间戳、这里再转回日期串，等于把时区换算做两遍（错一次就整体偏一天）。
   */
  rangeDays,
  customRange,
  /**
   * 查哪个域。缺省 `chat`（既有调用方不传它）。
   *
   * ★ 三个域走**同一个组件**：它们只差一个域名与两个量词（条/场/篇），
   * 而"分母拿不到所以不给百分比"这条判据三个域完全一样。各写一个组件
   * 会让那条判据有三处可以漂 —— 而漂的方向是"某一栏编了个百分比"。
   */
  domain = "chat",
}: {
  channelId: string | null
  rangeDays: number | null
  customRange?: { from: string; to: string } | null
  domain?: CoverageDomain
}) {
  const { t } = useDynamicTranslation("settings")
  const range = useMemo(() => {
    const now = Date.now()
    const todayDay = toDayBucket(now)
    /**
     * 上限 90 天：`rangeDays = null`（不限）时查全部会随库增长越查越慢，
     * 而用户看的是"最近这段齐不齐"。被夹住时下面会明说。
     */
    const capDay = toDayBucket(now - 90 * 86_400_000)
    // ★ 自定义区间优先（与 SourcesStep 里同一条判据：显式选的不该被预设覆盖）
    if (
      customRange !== undefined &&
      customRange !== null &&
      customRange.from !== "" &&
      customRange.to !== ""
    ) {
      return {
        fromDay: customRange.from < capDay ? capDay : customRange.from,
        toDay: customRange.to,
        clamped: customRange.from < capDay,
      }
    }
    if (rangeDays === null) return { fromDay: capDay, toDay: todayDay, clamped: true }
    const wanted = toDayBucket(now - rangeDays * 86_400_000)
    return {
      fromDay: wanted < capDay ? capDay : wanted,
      toDay: todayDay,
      clamped: wanted < capDay,
    }
  }, [rangeDays, customRange])

  const coverage = useChatCoverage(
    channelId ?? undefined,
    range.fromDay,
    range.toDay,
    channelId !== null,
    domain,
  )

  if (channelId === null) return null

  const data = coverage.data
  /**
   * ★ 「还没有数据」与「这段时间没有消息」必须是**两句不同的话**。
   *
   * `dayCount === 0` 只说明这张表里没有这段区间的行 —— 那既可能是
   * 采集还没跑到，也可能是那几天真的没消息。把它说成"0 条消息"
   * 就是把一个我们不知道的事讲成事实（v27 迁移注释里同一个取舍）。
   */
  const words = DOMAIN_WORDS[domain]
  if (data === undefined || data.dayCount === 0) {
    return (
      <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
        {coverage.isPending
          ? t("status.scope.coverage.loading", {
              defaultValue: "正在统计已有的{{label}}…",
              label: words.label,
            })
          : t("status.scope.coverage.empty", {
              /**
               * ★ 空态也要说清**是哪个域**空的：三行并排时一句不带域名的
               * "还没有记账数据"会让用户不知道是哪一类没采到。
               */
              defaultValue:
                "{{label}}：这段日期还没有记账数据 —— 采集跑过之后这里会显示每天已有多少。",
              label: words.label,
            })}
      </p>
    )
  }

  const pendingDays = data.dayCount - data.drainedDays
  return (
    <div className="flex flex-col gap-1">
      <p className="typography-caption-400 text-[var(--text-base-secondary)]">
        {t("status.scope.coverage.summary", {
          defaultValue: "{{label}}：{{from}} 起已有 {{count}} {{unit}}，覆盖 {{days}} 天",
          label: words.label,
          from: range.fromDay,
          count: data.localCount.toLocaleString(),
          unit: words.unit,
          days: data.dayCount,
        })}
      </p>
      <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
        {pendingDays === 0
          ? t("status.scope.coverage.allDrained", {
              defaultValue: "这些天都已采完（翻到没有更多为止）。",
            })
          : t("status.scope.coverage.pending", {
              // ★ 说"还在回溯"而不是"缺 N 条"——缺多少我们不知道
              defaultValue: "其中 {{done}} 天已采完，{{pending}} 天还在往回补。",
              done: data.drainedDays,
              pending: pendingDays,
            })}
      </p>
      {range.clamped ? (
        <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {t("status.scope.coverage.clamped", {
            defaultValue: "（只统计最近 90 天；更早的历史仍在学习范围内）",
          })}
        </p>
      ) : null}
    </div>
  )
}
