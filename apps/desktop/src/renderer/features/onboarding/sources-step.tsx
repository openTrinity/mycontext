/**
 * 蒸馏范围这一步：时间范围 + 会话（分组全选）+ 资料源勾选。
 *
 * ## ★ 「蒸馏范围」而不是「蒸馏资料源」
 *
 * 这一步同时决定**时间**、**哪些会话**、**哪几类数据** —— 三件事里
 * 只有第三件是"资料源"。叫"范围"才涵盖全部，也才让用户知道
 * 时间那一档不是可以跳过的装饰。
 *
 * ## ★ 会话列表一次全量加载，并按单聊/群聊分组
 *
 * 首版是"点开才拉"（那是一次约 4.8s 的三路子进程调用）。但实测下来
 * 用户**总是**要点开的 —— 指定会话是这一步的主要动作，而"点一下再等
 * 5 秒"比"进来就等 5 秒"更难受（前者要等两次注意力切换）。
 *
 * 分组是因为单聊与群聊的选择逻辑完全不同：单聊通常全选（那都是
 * 一对一的真实对话，语料质量最高），群聊要挑（大群里大半是与本人
 * 无关的噪声）。所以两组各有一个全选。
 *
 * ## ★ 单聊不显示人数
 *
 * 「2 人」是一句废话（单聊必然是两个人），而它占的位置本该给
 * 更有用的信息。群聊的人数有意义 —— 12 人群与 500 人群的语料密度
 * 完全不同。
 *
 * ## ★ 拿不全要说出来
 *
 * 渠道的会话列表分页是坏的（`--cursor` 无效 / `--limit` 硬顶 100 /
 * `hasMore` 恒 false），所以列表**可能不完整**。`truncated` 为真时必须提示 ——
 * 否则用户找不到某个群会以为是我们漏读了，而真相是渠道接口就拿不到。
 */
import { useMemo, useState } from "react"
import { Button, Checkbox, Input, cn } from "@mycontext/design"
import type { ChannelConversationView, DistillSourceId } from "@mycontext/ipc-contract"
import { useChannelConversations } from "../../lib/queries.js"
import { CHANNEL_BRAND_ICONS } from "../channels/channel-icons.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { useErrorText } from "../../lib/use-error-text.js"
import { StepSection, SubGroup } from "./step-section.js"

/**
 * 时间范围的预设。`null` 表示不限 —— 与"0 天"完全不同，别用 0 表示。
 *
 * ★ 加了 365：一年是"这个人今年是什么样"的自然单位，而原来最长的
 * 预设是 180 天（半年）—— 于是想蒸一整年的人只能选"不限"，
 * 而"不限"在一个用了三年的账号上是完全不同的成本。
 */
const RANGES: readonly { days: number | null; labelKey: string }[] = [
  { days: 30, labelKey: "sourcesStep.range30" },
  { days: 90, labelKey: "sourcesStep.range90" },
  { days: 180, labelKey: "sourcesStep.range180" },
  { days: 365, labelKey: "sourcesStep.range365" },
  { days: null, labelKey: "sourcesStep.rangeAll" },
]

/** 群人数档位。见 `inMemberBucket`。 */
export type MemberBucket = "all" | "0-100" | "101-200" | "201+"

const MEMBER_BUCKETS: readonly { bucket: MemberBucket; labelKey: string }[] = [
  { bucket: "all", labelKey: "sourcesStep.memberBucketAll" },
  { bucket: "0-100", labelKey: "sourcesStep.memberBucket0_100" },
  { bucket: "101-200", labelKey: "sourcesStep.memberBucket101_200" },
  { bucket: "201+", labelKey: "sourcesStep.memberBucket201Plus" },
]

/**
 * 一个群的人数落不落在选中的档位里。
 *
 * ## ★★ `memberCount === null` **恒通过**（不筛掉未知）
 *
 * 群列表接口当前对**所有**群都不返回人数（实测本机 73 个群 100% 为空）——
 * 若把 null 当成"不匹配"筛掉，一选人数档就会把整组群清空，那是"筛选把数据
 * 静默弄没了"（本仓库最忌讳的形态）。所以未知人数一律显示，宁可筛得松。
 * 界面另给一句「人数读不到」的提示，让"筛不动"看得见而不是看起来像坏了。
 *
 * ## 边界
 *
 * `0-100` = 1..100（0 人的群不存在，但 `<= 100` 覆盖它无害）；
 * `101-200` = 101..200；`201+` = >= 201。相邻档不重叠。
 */
export function inMemberBucket(memberCount: number | null, bucket: MemberBucket): boolean {
  if (bucket === "all") return true
  if (memberCount === null) return true
  if (bucket === "0-100") return memberCount <= 100
  if (bucket === "101-200") return memberCount >= 101 && memberCount <= 200
  return memberCount >= 201
}

export interface SourcesDraft {
  /** 往前多少天；null = 不限。与 `customRange` 互斥 */
  rangeDays: number | null
  /**
   * 自定义日期区间（`YYYY-MM-DD`）。
   *
   * 有值时**优先于** `rangeDays` —— 用户显式选的区间不该被一个预设覆盖。
   * 两个都可能为空串（只填了一头），那时按"没填"处理。
   */
  customRange?: { from: string; to: string } | null
  chatKinds: ("direct" | "group")[]
  conversationIds: string[]
  /** 勾选了哪些资料源 */
  enabledSources: DistillSourceId[]
}

export interface SourcesStepProps {
  value: SourcesDraft
  onChange: (next: SourcesDraft) => void
  /** 全部资料源（含采集器状态），由主进程给 */
  sources: readonly { kind: DistillSourceId; status: "ready" | "planned" }[]
  /**
   * 只列这些渠道的会话。`undefined` = 不过滤。
   *
   * ## ★★ 是集合，因为两个调用方要的范围不同
   *
   * · 运行状态页的采集范围面板一次只管一个渠道 → 单元素集合；
   * · 引导第 4 步要列**全部已连渠道** → 多元素集合。
   *
   * ## ★★ 这个字段被我改错过一次，值得记下来
   *
   * 上一版我把它当单个 id、并在引导页写死主渠道，理由是"这一步喂给蒸馏，
   * 而蒸馏只读主库"。那个推理**错在前提**：`conversationIds` 是**采集白名单**
   * （决定采哪些会话），而采集按渠道各自跑 —— 每个渠道的 `IngestService`
   * 读自己库里的白名单（见 `distill-source.service.ts` 里
   * 「`conversationIds` 里装的是**这个渠道的** external_id」那句）。
   *
   * 真机表现：只连了飞书时，列表里是**已退登渠道**的 55 个历史会话，
   * 而真正连着的飞书 4 个会话反倒看不见。
   *
   * ★ 空集 ≠ 不过滤：空集表示"一个渠道都没连"，那时列表本该是空的。
   */
  channelFilter?: ReadonlySet<string>
  /**
   * 其中**只读接入**的那些（`sendAs` 为空 —— 见 `canRunPersona`）。
   *
   * 给了且当前范围里真的有这类渠道时，会话区顶部多一句说明：选中的会话
   * 只进建图与搜索，不会进自动回复。
   *
   * ## ★ 为什么这句话必须有
   *
   * 这一步的标题是「学习范围」，而"学习"在用户心里等于"数字分身会学会
   * 这些话怎么说"。只读渠道上那件事**不会发生**（它的数据只进图谱与搜索）
   * —— 不说清的话用户会以为自己在给分身喂料，而分身永远不会用到它。
   *
   * ★ 传 id 集合而不是让这个组件自己查渠道列表：它现在只依赖
   * `useChannelConversations`，加一个 `useChannels()` 会让一个展示组件
   * 多一条数据依赖，而调用方本来就有那份数据。
   */
  readOnlyChannelIds?: ReadonlySet<string>
}

export function SourcesStep({
  value,
  onChange,
  sources,
  channelFilter,
  readOnlyChannelIds,
}: SourcesStepProps) {
  const { t } = useDynamicTranslation("onboarding")
  const errorText = useErrorText()
  /**
   * ★ 一进来就拉，不再"点开才拉"。
   *
   * 那是一次约 4.8s 的三路子进程调用，但指定会话是这一步的**主要动作**
   * —— 让用户先点一下再等 5 秒，等于把一次等待拆成两次注意力切换。
   */
  const conversations = useChannelConversations(true)
  /** 自定义区间的展开态。默认按 payload 里有没有值决定。 */
  const [customOpen, setCustomOpen] = useState(
    value.customRange !== null && value.customRange !== undefined,
  )

  const custom = value.customRange ?? null

  const toggleConversation = (externalId: string) => {
    const next = value.conversationIds.includes(externalId)
      ? value.conversationIds.filter((item) => item !== externalId)
      : [...value.conversationIds, externalId]
    onChange({ ...value, conversationIds: next })
  }

  const toggleSource = (kind: DistillSourceId) => {
    const next = value.enabledSources.includes(kind)
      ? value.enabledSources.filter((item) => item !== kind)
      : [...value.enabledSources, kind]
    onChange({ ...value, enabledSources: next })
  }

  /**
   * 按类型分成两组。
   *
   * ★ 不再按 `chatKinds` 过滤掉一整类：那个复选框原本既是"我要哪种"
   * 又是"列表里显示哪种"，于是取消勾选"单聊"会让已经选中的单聊
   * **从列表里消失但仍留在 conversationIds 里** —— 用户看不到它们，
   * 却在蒸馏时被算进去。现在两组都显示，选中与否只看 `conversationIds`。
   */
  const groups = useMemo(() => {
    const all = conversations.data?.items ?? []
    /**
     * ★ 按渠道过滤（见 `channelFilter`）。**没有 channelId 的项保留** ——
     * 那是存量数据的形状（旧记录不带它），丢掉会让用户的历史勾选看不见。
     */
    const items =
      channelFilter === undefined
        ? all
        : all.filter((item) => item.channelId === undefined || channelFilter.has(item.channelId))
    return {
      direct: items.filter((item) => item.kind === "direct"),
      group: items.filter((item) => item.kind === "group"),
    }
  }, [conversations.data, channelFilter])

  /**
   * 当前列表里**真的有**只读渠道的会话吗。
   *
   * ★ 判据是"列出来的东西里有"，不是"传进来的集合非空"：只连了只读渠道
   * 但它一条会话都没采到时，那句说明是多余的（用户面对一个空列表，
   * 而旁边写着"选中的会话只用于…"）。
   */
  const hasReadOnlyItems = useMemo(() => {
    if (readOnlyChannelIds === undefined || readOnlyChannelIds.size === 0) return false
    return [...groups.direct, ...groups.group].some(
      (item) => item.channelId !== undefined && readOnlyChannelIds.has(item.channelId),
    )
  }, [groups, readOnlyChannelIds])

  /**
   * 当前**列表里可见**的那些 externalId。
   *
   * ## ★★ 顶部计数与「清空」都要按这个来，不能用整个 `conversationIds`
   *
   * `conversationIds` 是**跨渠道**的一份（保存时才按渠道分桶），所以按渠道
   * 过滤之后它里面有一批**看不见**的 id。实测（真机截图）：只连飞书时
   * 顶部写着「已选 13 个」而列表里是 4/4 —— 那 9 个是钉钉的旧勾选，
   * 用户会以为自己选了 13 个飞书会话。
   *
   * 「清空」更严重：它原来清掉整个数组，也就是**连看不见的那 9 个一起清** ——
   * 用户在飞书这一屏点"清空"，钉钉的白名单跟着没了，而屏幕上没有任何痕迹。
   * 那与这一轮修过的那次数据丢失是同一形状。
   */
  const visibleIds = useMemo(
    () => new Set([...groups.direct, ...groups.group].map((item) => item.externalId)),
    [groups],
  )
  const visibleChosen = value.conversationIds.filter((id) => visibleIds.has(id))

  /** 一组的全选/全不选。已经全选了就变成全不选（同一个按钮两个方向）。 */
  const toggleAll = (items: readonly ChannelConversationView[]) => {
    const ids = items.map((item) => item.externalId)
    const allSelected = ids.length > 0 && ids.every((id) => value.conversationIds.includes(id))
    const next = allSelected
      ? value.conversationIds.filter((id) => !ids.includes(id))
      : [...new Set([...value.conversationIds, ...ids])]
    onChange({ ...value, conversationIds: next })
  }

  return (
    <div className="flex flex-col gap-[var(--gap-section-md)]">
      {/* 时间范围 */}
      <StepSection
        title={t("sourcesStep.sectionRange")}
        hint={t("sourcesStep.sectionRangeHint")}
        action={
          <Button size="sm" variant="ghost" onClick={() => setCustomOpen((open) => !open)}>
            {customOpen ? t("sourcesStep.usePreset") : t("sourcesStep.useCustom")}
          </Button>
        }
      >
        {customOpen ? (
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              {/*
                原生 `<input type="date">` 而不是引一个日期库。
                它自带本地化、键盘输入与系统日历面板 —— 一个自己写的
                日期选择器要几百行才能追上，而这里只需要"选两个日期"。
              */}
              <input
                type="date"
                value={custom?.from ?? ""}
                max={custom?.to === undefined || custom.to === "" ? undefined : custom.to}
                onChange={(event) =>
                  onChange({
                    ...value,
                    customRange: { from: event.target.value, to: custom?.to ?? "" },
                  })
                }
                className="typography-body-small-400 rounded-[var(--radius-sm)] border border-[var(--border-divider-light)] bg-[var(--bg-base-normal)] px-2 py-1 text-[var(--text-base-primary)]"
              />
              <span className="typography-body-small-400 text-[var(--text-base-tertiary)]">
                {t("sourcesStep.rangeTo")}
              </span>
              <input
                type="date"
                value={custom?.to ?? ""}
                min={custom?.from === undefined || custom.from === "" ? undefined : custom.from}
                onChange={(event) =>
                  onChange({
                    ...value,
                    customRange: { from: custom?.from ?? "", to: event.target.value },
                  })
                }
                className="typography-body-small-400 rounded-[var(--radius-sm)] border border-[var(--border-divider-light)] bg-[var(--bg-base-normal)] px-2 py-1 text-[var(--text-base-primary)]"
              />
            </div>
            <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
              {t("sourcesStep.customHint")}
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {RANGES.map((range) => (
              <button
                key={String(range.days)}
                type="button"
                onClick={() =>
                  // 选预设时清掉自定义区间 —— 两者互斥，留着会让"哪个生效"说不清
                  onChange({ ...value, rangeDays: range.days, customRange: null })
                }
                aria-pressed={custom === null && value.rangeDays === range.days}
                className={cn(
                  "typography-body-small-400 rounded-full border px-3 py-1 transition-colors duration-150",
                  custom === null && value.rangeDays === range.days
                    ? "border-[var(--text-accent-normal)] bg-[var(--bg-card-z0)] text-[var(--text-base-primary)]"
                    : "border-[var(--border-divider-light)] text-[var(--text-base-secondary)] hover:bg-[var(--bg-card-z0)]",
                )}
              >
                {t(range.labelKey)}
              </button>
            ))}
          </div>
        )}
      </StepSection>

      {/* 会话：两组各自全选 */}
      <StepSection
        title={t("sourcesStep.sectionConversations")}
        hint={t("sourcesStep.conversationHint")}
        action={
          visibleChosen.length > 0 ? (
            <span className="flex items-center gap-2">
              <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
                {t("sourcesStep.selectedCount", { count: visibleChosen.length })}
              </span>
              <Button
                size="sm"
                variant="ghost"
                /**
                 * ★★ 只清**可见**的那些 —— 见 `visibleChosen` 的注释。
                 *
                 * 清整个数组会把别的渠道的白名单一起清掉，而屏幕上没有任何
                 * 痕迹说那件事发生了。
                 */
                onClick={() =>
                  onChange({
                    ...value,
                    conversationIds: value.conversationIds.filter((id) => !visibleIds.has(id)),
                  })
                }
              >
                {t("sourcesStep.clearSelection")}
              </Button>
            </span>
          ) : null
        }
      >
        {conversations.isLoading ? (
          <ConversationSkeleton label={t("sourcesStep.conversationLoading")} />
        ) : conversations.error !== null ? (
          <p className="typography-body-small-400 text-[var(--status-error)]">
            {errorText(conversations.error)}
          </p>
        ) : (
          <div className="flex flex-col gap-[var(--gap-component-md)]">
            {/* 截断提示放在列表**上方**：滚到底才看到就已经太晚了 */}
            {conversations.data?.truncated === true ? (
              <p className="typography-caption-400 rounded-[var(--radius-md)] bg-[var(--bg-card-z0)] px-3 py-2 text-[var(--text-base-tertiary)]">
                {t("sourcesStep.truncatedWarning")}
              </p>
            ) : null}

            {/*
              ★★ 只读渠道的会话选了**不会**进自动回复 —— 必须说出来。

              这一步叫「学习范围」，而"学习"在用户心里等于"分身会学会这些话
              怎么说"。只读渠道上那件事不会发生（数据只进图谱与搜索），
              不说清的话用户以为自己在给分身喂料，而分身永远用不到它。
            */}
            {hasReadOnlyItems ? (
              <p className="typography-caption-400 rounded-[var(--radius-md)] bg-[var(--bg-card-z0)] px-3 py-2 text-[var(--text-base-tertiary)]">
                {t("sourcesStep.readOnlyChannelHint")}
              </p>
            ) : null}

            <ConversationGroup
              titleKey="sourcesStep.kindDirect"
              items={groups.direct}
              selected={value.conversationIds}
              onToggle={toggleConversation}
              onToggleAll={(visible) => toggleAll(visible)}
              // ★ 单聊不显示人数：「2 人」是废话
              showMemberCount={false}
            />
            <ConversationGroup
              titleKey="sourcesStep.kindGroup"
              items={groups.group}
              selected={value.conversationIds}
              onToggle={toggleConversation}
              onToggleAll={(visible) => toggleAll(visible)}
              showMemberCount
              // 群才有人数档位筛选（单聊「2 人」无意义）
              memberBuckets
            />
          </div>
        )}
      </StepSection>

      {/* 资料源勾选 */}
      <StepSection
        title={t("sourcesStep.sectionSources")}
        hint={t("sourcesStep.sectionSourcesHint")}
      >
        {/*
          ★ 「现在可用」与「排期中」**分成两组**。

          9 个源里只有 2 个真能采（chat / minutes），另外 7 个的采集器还没写
          （判据在主进程的 `READY_SOURCES`）。改动前它们平铺在一个两列网格里，
          只靠一个浅色后缀区分 —— 于是用户很自然地全勾上，然后第 4 步
          显示"已启用 9 个资料源"，而实际工作的只有 2 个。
          那个数字会误导人，所以分组是必要的，不只是好看。

          排期中的**不可勾**（见下面那个 Checkbox 的注释）：勾了却没有采集器
          就是"静默无效"。等真接上采集器（`READY_SOURCES` 里出现）再放开。
        */}
        <SubGroup label={t("sourcesStep.sourcesReady")}>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {sources
              .filter((source) => source.status === "ready")
              .map((source) => (
                <Checkbox
                  key={source.kind}
                  checked={value.enabledSources.includes(source.kind)}
                  onChange={() => toggleSource(source.kind)}
                  label={
                    <span className="typography-body-small-400 text-[var(--text-base-primary)]">
                      {t(`sourceKinds.${source.kind}`)}
                    </span>
                  }
                />
              ))}
          </div>
        </SubGroup>

        {sources.every((source) => source.status === "ready") ? null : (
          <SubGroup label={t("sourcesStep.sourcesPlanned")}>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              {sources
                .filter((source) => source.status !== "ready")
                .map((source) => (
                  <Checkbox
                    key={source.kind}
                    /**
                     * ★ 排期中的源**不可勾、恒不选**。
                     *
                     * 之前它们可勾、可写进 `distill_sources`、然后什么都不发生
                     * —— 那是"静默无效"：用户以为选了文档，实际没有采集器。
                     * 禁用之后"还没做"是**看得见**的，而不是勾了却没反应。
                     * 等真接了采集器（有 READY 判据）再放开。
                     */
                    checked={false}
                    disabled
                    onChange={() => undefined}
                    label={
                      <span className="typography-body-small-400 text-[var(--text-base-tertiary)]">
                        {t(`sourceKinds.${source.kind}`)}
                      </span>
                    }
                  />
                ))}
            </div>
            {/*
              ★ 只留这一条说明，删掉了原来那个 `title`（native tooltip）。
              两者说的是同一件事，而 tooltip 只有 hover 才看得到 ——
              一条必须靠悬停才能读到的关键信息等于没写。
            */}
            <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
              {t("sourcesStep.plannedExplain")}
            </p>
          </SubGroup>
        )}
      </StepSection>
    </div>
  )
}

/**
 * 会话列表的加载态。
 *
 * ## ★ 为什么是骨架而不是一行字
 *
 * 原来是一行 `读取会话列表…（要调三次渠道接口，约 5 秒）`。两个问题：
 *
 * · **它泄漏实现**。"三次渠道接口"是我们的事，用户不需要知道我们怎么
 *   拿数据；而"约 5 秒"是一个会被打破的承诺（网络慢就变 15 秒，
 *   那时这行字在说谎）。
 * · **它不占位**。5 秒后列表出现，整页内容**跳一下** —— 用户刚要点的
 *   东西位置变了。骨架把最终布局先占住，内容到位时不发生跳动。
 *
 * 行数固定 6 行：与真实列表的可视行数接近（那个框约 10 行），
 * 不必精确 —— 骨架的作用是"这里将会有一列东西"，不是预览。
 */
function ConversationSkeleton({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-live="polite">
      <span className="typography-caption-400 text-[var(--text-base-tertiary)]">{label}</span>
      <div className="flex flex-col gap-1 rounded-[var(--radius-md)] border border-[var(--border-divider-light)] p-2">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex items-center gap-2 px-1 py-1">
            <span className="size-4 shrink-0 animate-pulse rounded-[var(--radius-xs)] bg-[var(--bg-card-z0)]" />
            <span
              className="h-3 animate-pulse rounded-full bg-[var(--bg-card-z0)]"
              /**
               * 宽度逐行递减 —— 等宽的一叠条看起来像表格而不是列表。
               * 用行内 style 而不是几个 Tailwind 类：这几个宽度是**数据**
               * （骨架的形状），不是可复用的设计决定。
               */
              style={{ width: `${String(72 - index * 6)}%` }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * 一组会话（单聊 / 群聊），带该组的全选。
 *
 * 分组的理由见文件头：两类的选择逻辑不同，单聊通常全选、群聊要挑。
 */
function ConversationGroup({
  titleKey,
  items,
  selected,
  onToggle,
  onToggleAll,
  showMemberCount,
  memberBuckets = false,
}: {
  titleKey: string
  items: readonly ChannelConversationView[]
  selected: readonly string[]
  onToggle: (externalId: string) => void
  /**
   * 全选/取消全选。
   *
   * ★ 参数是**当前可见的**那批（搜索过滤后），不是全部 ——
   * 用户搜了"项目"再点全选，意思是"把这些都加进来"，
   * 而不是"把 88 个都加进来"。
   */
  onToggleAll: (visible: readonly ChannelConversationView[]) => void
  showMemberCount: boolean
  /** 显示人数档位筛选（只群聊传 true —— 单聊没有人数）。见 `inMemberBucket`。 */
  memberBuckets?: boolean
}) {
  const { t } = useDynamicTranslation("onboarding")
  /**
   * 组内搜索。
   *
   * ★ 88 个会话靠滚动去找是不现实的。实测这个账号：单聊 52 / 群聊 36。
   * 用户心里通常已经有目标了（"把和小李的单聊加进去"），
   * 搜索比滚动快一个数量级。
   *
   * ★ 搜索框**始终显示**（原来只在 `items.length > COLLAPSED_ROWS` 时出现）——
   * 用户明确要"加关键字筛选"，而一个只在会话多时才冒出来的搜索框等于没有：
   * 会话不到 8 个时想搜也搜不了，且"有时有有时没有"本身让人以为功能坏了。
   */
  const [keyword, setKeyword] = useState("")
  /** 群人数档位（`all` = 不按人数筛）。见 `inMemberBucket`。 */
  const [bucket, setBucket] = useState<MemberBucket>("all")
  /** 展开全部。收起时只显示前 `COLLAPSED_ROWS` 条 —— 见下方列表的注释。 */
  const [expanded, setExpanded] = useState(false)

  /**
   * 过滤只影响**显示**，不影响选择状态。
   *
   * ★ 「全选」作用在过滤后的那批上 —— 那正是搜索的意义
   * （"把所有带『项目』的群都加进来"）。作用在全部上的话，
   * 用户搜完再点全选会莫名其妙地把 88 个都勾上。
   *
   * ★ 关键字与人数档位**叠加取交集**：搜"项目" + 选 101-200 = 名字带项目
   * 且人数在这一档的群。人数未知（`memberCount===null`）的群不被档位筛掉
   * （见 `inMemberBucket`）。
   */
  const visible = items.filter((item) => {
    const matchesKeyword =
      keyword.trim() === "" ||
      (item.title ?? item.externalId).toLowerCase().includes(keyword.trim().toLowerCase())
    return matchesKeyword && inMemberBucket(item.memberCount, bucket)
  })

  /**
   * 这一组的群人数**全都读不到**吗（有档位筛选时才关心）。
   *
   * 群列表接口当前对所有群都不返回人数（见 `inMemberBucket` 的注释）。
   * 全为 null 时人数筛选实际筛不动任何东西 —— 那就说出来，别让一排点了
   * 没反应的按钮看起来像坏了（本仓库最忌讳的静默无效）。
   */
  const memberCountAllUnknown =
    memberBuckets && items.length > 0 && items.every((item) => item.memberCount === null)

  const chosen = items.filter((item) => selected.includes(item.externalId)).length
  /**
   * ★★ 按钮的**标签与行为必须同源** —— 都按「当前可见」算。
   *
   * 这里原来是个真 bug：标签算的是 `items`（全量）而 `onToggleAll` 收的是
   * `visible`（过滤后）。于是有搜索词时两者矛盾：69/69 全选中 + 搜一个关键词
   * → 标签显示「全不选」（因为全量都选中了），点下去只取消匹配的那几个，
   * 而标签**仍然**显示「全不选」。反过来 5/69 选中、关键词正好匹配那 5 个
   * → 标签显示「全选」，点下去却是取消。
   *
   * 判据换成 `visible` 之后两者同源，无论有没有搜索词都一致。
   */
  const visibleChosen = visible.filter((item) => selected.includes(item.externalId)).length
  const allVisibleSelected = visible.length > 0 && visibleChosen === visible.length

  /**
   * 收起时显示几条。
   *
   * ★ 这个数替换掉了原来的 `max-h-[320px] overflow-y-auto`。
   *
   * 那个定高滚动区嵌在页面滚动区里，两层都能滚 —— 而更要紧的是它把
   * 「资料源」那一整段挤出了视口（实测截图里完全看不到）。
   * 原注释担心的是"列表撑开会把下一步顶出视口"，那个顾虑对，
   * 但解法不是内层滚动条，而是**默认只显示一小截**：收起态 8 行，
   * 想看全部就展开，展开后跟着页面一起滚（只有一层滚动）。
   */
  const COLLAPSED_ROWS = 8
  const shown = expanded ? visible : visible.slice(0, COLLAPSED_ROWS)
  const hiddenCount = visible.length - shown.length

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="typography-caption-400 font-medium text-[var(--text-base-secondary)]">
          {t(titleKey)}
        </span>
        <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {t("sourcesStep.groupCount", { chosen, total: items.length })}
        </span>
        {items.length === 0 ? null : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onToggleAll(visible)}
            className="ml-auto"
          >
            {allVisibleSelected ? t("sourcesStep.deselectAll") : t("sourcesStep.selectAll")}
          </Button>
        )}
      </div>

      {/* 搜索框始终显示（会话再少也能搜）—— 见 keyword state 的注释 */}
      {items.length === 0 ? null : (
        <Input
          size="sm"
          value={keyword}
          placeholder={t("sourcesStep.searchPlaceholder")}
          onChange={(event) => setKeyword(event.target.value)}
        />
      )}

      {/* 群人数档位（只群聊有）—— pill 样式与时间范围那排一致 */}
      {memberBuckets && items.length > 0 ? (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap gap-2">
            {MEMBER_BUCKETS.map((option) => (
              <button
                key={option.bucket}
                type="button"
                onClick={() => setBucket(option.bucket)}
                aria-pressed={bucket === option.bucket}
                className={cn(
                  "typography-caption-400 rounded-full border px-2.5 py-0.5 transition-colors duration-150",
                  bucket === option.bucket
                    ? "border-[var(--text-accent-normal)] bg-[var(--bg-card-z0)] text-[var(--text-base-primary)]"
                    : "border-[var(--border-divider-light)] text-[var(--text-base-secondary)] hover:bg-[var(--bg-card-z0)]",
                )}
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>
          {/*
            人数全读不到时说出来 —— 否则档位按钮点了几乎不改变列表，
            看起来像坏了（见 `memberCountAllUnknown`）。
          */}
          {memberCountAllUnknown ? (
            <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
              {t("sourcesStep.memberCountUnavailable")}
            </p>
          ) : null}
        </div>
      ) : null}

      {items.length === 0 ? (
        <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {t("sourcesStep.conversationEmpty")}
        </p>
      ) : (
        <>
          {/*
            ★ 不再是定高滚动区（见上方 `COLLAPSED_ROWS` 的注释）。
            也不再有 border —— 收起态只有 8 行，不需要一个框来界定"这是个列表"，
            而那个框在卡片里会变成"框里的框"。
          */}
          <ul className="flex flex-col gap-1">
            {visible.length === 0 ? (
              <li className="typography-caption-400 px-1 py-2 text-[var(--text-base-tertiary)]">
                {t("sourcesStep.searchEmpty", { keyword })}
              </li>
            ) : null}
            {shown.map((item) => (
              <li key={item.externalId}>
                <Checkbox
                  checked={selected.includes(item.externalId)}
                  onChange={() => onToggle(item.externalId)}
                  label={
                    <span className="flex min-w-0 flex-1 items-baseline gap-2">
                      {/*
                        ★★ 渠道图标 —— 两个渠道的会话混在同一个列表里。

                        少了它用户分不清哪个群是哪个渠道的（群名可能重复，
                        而 external_id 不上屏）。而这个选择直接决定采什么，
                        选错了是"采了不该采的会话"——一个隐私问题。

                        只在**真有渠道信息**时显示（旧记录没有 channelId）。
                      */}
                      {(() => {
                        if (item.channelId === undefined) return null
                        const Icon = CHANNEL_BRAND_ICONS[item.channelId]
                        return Icon === undefined ? null : (
                          <Icon className="size-3.5 shrink-0 rounded-[3px]" />
                        )
                      })()}
                      <span className="typography-body-small-400 truncate text-[var(--text-base-primary)]">
                        {/*
                          ★ 没有会话名时显示 id 的**尾段**，而不是整串或一个占位词。

                          采集层拿不到名字时给的是 `null`（不写占位进库 ——
                          占位会覆盖掉已经拿到的真名，见 `parseLarkMessagePage`）。
                          那时这一行要能**互相区分**：几行一模一样的「飞书会话」
                          让人完全没法选（用户报过），而 id 尾段虽然不好看，
                          至少每行不同、且能与渠道里的会话对上。

                          取后 8 位：前缀（`oc_` / `cid`）对所有会话都一样，
                          区分度全在尾部。
                        */}
                        {item.title ?? `#${item.externalId.slice(-8)}`}
                      </span>
                      {showMemberCount && item.memberCount !== null ? (
                        <span className="typography-caption-400 shrink-0 text-[var(--text-base-tertiary)]">
                          {t("sourcesStep.memberCount", { count: item.memberCount })}
                        </span>
                      ) : null}
                      {item.lastMessageAt === null ? (
                        // 「还没采过」是事实而不是缺陷：群列表那一路没有时间字段
                        <span className="typography-caption-400 shrink-0 text-[var(--text-base-tertiary)]">
                          {t("sourcesStep.noMessages")}
                        </span>
                      ) : null}
                    </span>
                  }
                  className="w-full"
                />
              </li>
            ))}
          </ul>
          {/*
            ★ 「展开全部」带**数字** —— 没有数字的话用户不知道折叠掉了多少，
            也就无从判断要不要展开（"下面还有 3 个"与"还有 61 个"是两种决定）。
          */}
          {hiddenCount > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setExpanded(true)}
              className="self-start"
            >
              {t("sourcesStep.expandAll", { count: hiddenCount })}
            </Button>
          ) : expanded && visible.length > COLLAPSED_ROWS ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setExpanded(false)}
              className="self-start"
            >
              {t("sourcesStep.collapseList")}
            </Button>
          ) : null}
        </>
      )}
    </div>
  )
}
