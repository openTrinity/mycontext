/**
 * FactsExplorer —— 「它从聊天里读出了什么」：可检索的事实面板。
 *
 * ## 为什么不是"最近 12 条"
 *
 * 图里有 6663 条事实、跨一整月。一个静态的"最近 12 条"回答不了任何具体
 * 问题 —— 而用户真正会问的是"上周关于沙箱的决策有哪些""小吴这个月说过
 * 什么"。那要求四个维度：时间范围、类型、实体、关键词。
 *
 * ## ★ 过滤器的布局按规范定（dataviz 的 `interaction.md`）
 *
 * · **一行，在内容上方** —— 不放进卡片里，不做逐图过滤；
 * · **时间范围排第一** —— 那是每个读者第一个去点的东西；
 * · **预设成行，不做日历网格** —— 没人愿意为"近 30 天"跟日历较劲；
 * · **过滤器 scope 下方全部内容** —— 类型分布与列表用同一个切片，
 *   所以两边的数字永远一致；
 * · **重取时保持上一次渲染并降低不透明度** —— 不做骨架屏、不跳布局
 *   （`useKlGraphFacts` 里的 `keepPreviousData` 就是这一条）。
 *
 * ## 事实类型用**有序**色阶，不是分类色
 *
 * 五个类型有强弱之分（决策 > 指派 > 因果 > 状态 > 一般）——
 * 按 `choosing-a-form.md`：nominal 才用 categorical，ordered 用单色 ramp。
 * 所以这里是品牌蓝的几个步进，而不是五个不同的色相。
 * 状态色（成功/警告/错误）**不参与** —— 那是保留给"好/坏"的。
 */
import { useEffect, useMemo, useState } from "react"
import { Button, Panel, cn } from "@mycontext/design"
import type { KlGraphFacts, KlGraphFactsInput } from "@mycontext/ipc-contract"
import { useKlGraphFacts } from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { Distribution } from "../dashboard/primitives.js"

/** 时间范围预设。`null` = 全部。 */
const RANGES: ReadonlyArray<{ days: number | null; key: string }> = [
  { days: 7, key: "range7" },
  { days: 30, key: "range30" },
  { days: 90, key: "range90" },
  { days: null, key: "rangeAll" },
]

/**
 * 事实类型的色阶来自 `palette.ts`（**一份**，与图例、画布共用）。
 *
 * 那里是有序单色 ramp 而不是分类色 —— 五个类型有强弱之分
 * （决策 > 指派 > 因果 > 状态 > 一般），按 `choosing-a-form.md`
 * ordered 用 ramp、nominal 才用 categorical。亮度单调已验证。
 */
import { FACT_TYPES as TYPE_ORDER, factColor } from "./palette.js"

export interface FactsExplorerProps {
  /** 类型分布（来自 graphOverview，用于分布条与"共几条"） */
  typeCounts: ReadonlyArray<{ type: string; count: number }>
  /**
   * 当前聚焦的实体名。**受控** —— 由仪表盘持有。
   *
   * ★ 为什么不是这一层的内部 state：上面的 ego 图点一个人时要能把
   * 这一栏筛过去，而那意味着状态必须在两者的**共同父级**。
   * 放在这里的话点了图没反应 —— 那正是"图谱与事实是两页"的老问题。
   */
  entityFocus?: string | null
  onEntityFocusChange?: (name: string | null) => void
  /**
   * 当前筛出来的总条数，查到就回传。
   *
   * ## ★ 为什么由这一层报出去，而不是让联动带自己查
   *
   * 那个数字是这一层查出来的（同一份过滤条件）。让联动带再查一次会得到
   * **两次请求两个答案** —— 分页/类型/关键词任何一处不同步，同一屏上
   * 就会出现两个互相矛盾的总数，而那是读者最没法处理的一种不一致。
   *
   * `null` = 还在查（联动带那时不显示条数，而不是显示 0）。
   */
  onTotalChange?: (total: number | null) => void
}

export function FactsExplorer({
  typeCounts,
  entityFocus = null,
  onEntityFocusChange,
  onTotalChange,
}: FactsExplorerProps) {
  const { t } = useDynamicTranslation("graph")
  /**
   * ★ 默认「全部」而不是「近 30 天」。
   *
   * 图里的事实来自**历史导入**，多数带的是当时的聊天时间戳（实测本机最新
   * 一条 fact 是两个月前），而且约一半 fact 的 `timestamp=0`（抽取没落上
   * 时间）。默认卡 30 天的话，点任何一个人都筛出 0 条 —— 看起来像"这人
   * 没有事实"，其实只是都落在窗外。默认全部，用户想收窄再点时间预设。
   */
  const [days, setDays] = useState<number | null>(null)
  const [types, setTypes] = useState<ReadonlySet<string>>(new Set())
  const [keyword, setKeyword] = useState("")
  /**
   * 输入框是本地态，只在**提交时**才进 query。
   *
   * 逐字符查会让每敲一个键都打一次 IPC + 一次 FTS ——
   * 而这一页的检索是"我想找某个东西"，不是即时补全。
   */
  const [draft, setDraft] = useState("")
  /**
   * 非受控时的内部兜底。
   *
   * 父级不给 `onEntityFocusChange` 时（比如单独用这个组件）这一栏仍要
   * 能筛实体 —— 否则事实卡上那些名字点了没反应，而"点了没反应"是这个
   * 项目里反复出现的那类失效。
   */
  const [localEntity, setLocalEntity] = useState<string | null>(null)
  const entityName = onEntityFocusChange === undefined ? localEntity : entityFocus
  const [page, setPage] = useState(0)
  /**
   * ★ 实体一换就回第一页 —— 在**渲染中**调整，不在 effect 里。
   *
   * 受控时这个值可能被**父级**改（上面的图点了一个人），而那条路径
   * 不经过这里的任何 setter —— 所以不能包进 `setEntityName`。
   *
   * 但也不能放 `useEffect`：effect 在渲染**之后**跑，于是那一帧会带着
   * 旧的 `offset` 发一次查询（单测抓到过：offset=20 打进了新实体的
   * 第一次请求）。返回的是空列表，而"共 12 条"就写在上面 ——
   * 一个看起来像"查询坏了"的 bug，且只在从第 2 页起点图时出现。
   *
   * 这是 React 文档里 "adjusting state when props change" 那一条：
   * 上一次的 prop 存成 state，渲染中发现不一致就立刻改并重渲染。
   * 那一次多余的渲染发生在**提交之前**，所以查询看不到中间态。
   */
  const [lastEntity, setLastEntity] = useState<string | null>(entityName)
  if (lastEntity !== entityName) {
    setLastEntity(entityName)
    setPage(0)
  }

  const PAGE = 20
  const input: KlGraphFactsInput = useMemo(
    () => ({
      days,
      types: [...types],
      entityName,
      keyword,
      limit: PAGE,
      offset: page * PAGE,
    }),
    [days, types, entityName, keyword, page],
  )
  const query = useKlGraphFacts(input)
  const data: KlGraphFacts | undefined = query.data

  /** 改任何过滤条件都要回到第一页 —— 否则会停在一个不存在的页码上。 */
  const reset =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value)
      setPage(0)
    }
  /** 受控/非受控两条路走同一个入口，于是"回到第一页"不会漏。 */
  const setEntityName = (name: string | null) => {
    if (onEntityFocusChange === undefined) setLocalEntity(name)
    else onEntityFocusChange(name)
  }

  const rows = useMemo(
    () =>
      TYPE_ORDER.filter((type) => typeCounts.some((row) => row.type === type)).map((type) => ({
        label: t(`factType.${type}`),
        value: typeCounts.find((row) => row.type === type)?.count ?? 0,
        color: factColor(type),
      })),
    [typeCounts, t],
  )
  /** 分布条点一下就筛那个类型 —— 图与过滤器是同一个东西的两面。 */
  const labelToType = useMemo(
    () => new Map(TYPE_ORDER.map((type) => [t(`factType.${type}`), type as string])),
    [t],
  )
  const selectedLabels = useMemo(
    () => new Set([...types].map((type) => t(`factType.${type}`))),
    [types, t],
  )

  const total = data?.total ?? 0
  const maxPage = Math.max(0, Math.ceil(total / PAGE) - 1)

  /**
   * 把总数报给父级（联动带用它显示"N 条"）。
   *
   * 查询在途时报 `null` 而不是上一次的值：一个"正在变"的数字停在旧值上
   * 会让用户以为筛选没生效。
   */
  useEffect(() => {
    onTotalChange?.(data === undefined ? null : data.total)
  }, [data, onTotalChange])

  return (
    <div className="flex flex-col gap-4">
      {/* ── 过滤器：一行，在内容上方 ─────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        {/* 时间范围排第一 */}
        <div className="flex items-center gap-0.5 rounded-full bg-[var(--bg-card-z0)] p-0.5">
          {RANGES.map((range) => (
            <button
              key={range.key}
              type="button"
              /**
               * ★ 标出这是**哪一组**时间范围。
               *
               * 仪表盘上现在有两组「近 7/30/90 天」——这一组筛事实，
               * 另一组（`data-range-scope="trends"`）切时序图的窗口。
               * 两组都是匿名的 `button[aria-pressed]` + 相同文案时，
               * 按文案找元素的探针会**命中错的那一组**：实测
               * `check-dashboard-ui` 因此把时序图切成 7 天，然后报
               * 「事实过滤器没生效」—— 一个完全错误的结论。
               *
               * 所以这个属性是给门禁用的**稳定锚点**，不是样式钩子。
               */
              data-range-scope="facts"
              aria-pressed={days === range.days}
              onClick={() => reset(setDays)(range.days)}
              className={cn(
                "typography-caption-400 rounded-full px-2.5 py-1 transition-colors duration-150",
                days === range.days
                  ? "bg-[var(--bg-card-z1)] font-medium text-[var(--text-base-primary)] shadow-sm"
                  : "text-[var(--text-base-tertiary)] hover:text-[var(--text-base-secondary)]",
              )}
            >
              {t(range.key)}
            </button>
          ))}
        </div>

        {/* 关键词：回车提交（不逐字符查） */}
        <form
          className="flex min-w-[200px] flex-1 items-center gap-1.5 rounded-full bg-[var(--bg-card-z0)] px-3 py-1"
          onSubmit={(event) => {
            event.preventDefault()
            reset(setKeyword)(draft.trim())
          }}
        >
          <SearchIcon className="size-3.5 shrink-0 text-[var(--text-base-tertiary)]" />
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t("searchPlaceholder")}
            className="typography-caption-400 min-w-0 flex-1 bg-transparent text-[var(--text-base-primary)] outline-none placeholder:text-[var(--text-base-tertiary)]"
          />
          {keyword === "" ? null : (
            <button
              type="button"
              onClick={() => {
                setDraft("")
                reset(setKeyword)("")
              }}
              className="typography-caption-400 shrink-0 text-[var(--text-base-tertiary)] hover:text-[var(--text-base-primary)]"
            >
              {t("clear")}
            </button>
          )}
        </form>

        {/* 实体过滤只在真的选了之后才显示 —— 一个空的下拉框是噪声 */}
        {entityName === null ? null : (
          <button
            type="button"
            onClick={() => setEntityName(null)}
            className="typography-caption-400 flex shrink-0 items-center gap-1 rounded-full bg-[var(--status-fill-info-container)] px-2.5 py-1 text-[var(--status-link)]"
            title={t("clearEntity")}
          >
            {t("aboutEntity", { name: entityName })}
            <span aria-hidden>×</span>
          </button>
        )}
      </div>

      {/* ── 类型分布：既是图也是过滤器 ───────────────────────── */}
      <Distribution
        rows={rows}
        selected={selectedLabels}
        onPick={(label) => {
          const type = labelToType.get(label)
          if (type === undefined) return
          reset(setTypes)(
            (() => {
              const next = new Set(types)
              if (next.has(type)) next.delete(type)
              else next.add(type)
              return next
            })(),
          )
        }}
      />

      {/* ── 列表 ─────────────────────────────────────────────── */}
      <div
        className={cn(
          "flex flex-col gap-2 transition-opacity duration-150",
          // 重取时保持上一次渲染并降透明度（不做骨架屏、不跳布局）
          query.isFetching ? "opacity-60" : "",
        )}
      >
        <div className="flex items-baseline justify-between gap-2">
          {/*
            ★ 列表标题带上被筛的那个人。
            原来只有一句「共 N 条」，而"这 N 条是关于谁的"要用户回头看
            过滤器行里那枚小筹码 —— 上面那张图与这批结果之间的联系
            在这里断了一次。
          */}
          <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
            {entityName === null
              ? t("factsTotal", { count: total })
              : t("factsAbout", { name: entityName, count: total })}
          </span>
          {maxPage === 0 ? null : (
            <span className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                {t("prev")}
              </Button>
              <span className="typography-caption-400 tabular-nums text-[var(--text-base-tertiary)]">
                {page + 1} / {maxPage + 1}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={page >= maxPage}
                onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
              >
                {t("next")}
              </Button>
            </span>
          )}
        </div>

        {data?.reason === null || data?.reason === undefined ? null : (
          <p className="typography-caption-400 rounded-[var(--radius-md)] bg-[var(--bg-card-z0)] px-3 py-2 text-[var(--text-base-secondary)]">
            {data.reason}
          </p>
        )}

        <ul className="flex flex-col gap-1.5">
          {(data?.facts ?? []).map((fact) => (
            <Panel as="li" pad="ms" key={fact.id} className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                {/* 类型用一个色点 + 文字：色点给扫读，文字给确定性 */}
                <span className="typography-caption-400 flex shrink-0 items-center gap-1 text-[var(--text-base-tertiary)]">
                  <span
                    className="size-2 rounded-full"
                    style={{ background: factColor(fact.type) }}
                    aria-hidden
                  />
                  {t(`factType.${fact.type}`)}
                </span>
                {/* 这条事实在说谁 —— 点一下就筛那个实体 */}
                {fact.entities.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => setEntityName(name)}
                    className="typography-caption-400 max-w-[160px] truncate rounded-full bg-[var(--bg-card-z0)] px-2 py-0.5 text-[var(--text-base-secondary)] transition-colors duration-150 hover:bg-[var(--overlay-on-container-hover)]"
                    title={t("filterByEntity", { name })}
                  >
                    {name}
                  </button>
                ))}
                <span className="typography-caption-400 ml-auto shrink-0 tabular-nums text-[var(--text-base-tertiary)]">
                  {fact.at === null ? "" : formatDay(fact.at)}
                </span>
              </div>
              {/* 正文可断在任意位置：抽出来的句子里可能有长 URL 与 id */}
              <p className="typography-body-small-400 wrap-anywhere text-[var(--text-base-primary)]">
                {fact.text}
              </p>
            </Panel>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** `07-30` 这种短日期。列表里日期只是次要信息，年份没必要占位置。 */
function formatDay(ms: number): string {
  const date = new Date(ms)
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <circle cx="7" cy="7" r="4.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.2 10.2 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
