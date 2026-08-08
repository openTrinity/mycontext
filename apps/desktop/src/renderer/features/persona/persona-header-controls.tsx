/**
 * PersonaHeaderControls —— 数字分身注入到**页头右侧**的那一小段。
 *
 * ## ★ 它替掉的是整整一条 `PersonaTopBar`
 *
 * 原来数字分身有两条横栏：页头（只有标题「数字分身」）+ 下面一条自己的
 * TopBar（渠道 + 三个 28px 大数字 + 一个二段开关 + 立即处理）。
 * 用户反馈是「上面这两栏应该合并，且太重了」。
 *
 * 现在这段东西挂进页头的 `actions` 槽（见 `header-slot.tsx`），
 * 与标题同一行。所以它必须**轻**：
 *
 * · 三个数字从 28px 的 figure 降成一行 `数字 标签` 的 inline 文字 ——
 *   页头是扫视区，不是仪表盘，28px 的数字在这里"太重了"；
 * · **「立即处理」去掉**（用户要求）。它原来解决的是"改完配置想立刻
 *   看效果"，但那更该是会话设置弹窗里改完就近的一个动作，而不是
 *   常驻页头的一个按钮 —— 常驻在这里它每次都在抢注意力；
 * · **运行/停止改成一个开关**，不是并排两段。用户反馈"运行中/已停止
 *   做成一个同时出现的 switch 样式换下" —— 二段控件把两个状态标签
 *   都显示出来，读起来像两个并列的东西；一个 Switch 只有一个滑块 +
 *   一句标签，眼睛只有一个焦点。
 *
 * ## 停止态的强调放在**开关的颜色**上，不再是"整条栏变红"
 *
 * 独立的 TopBar 停摆时整条转警示色。现在没有那条栏了，所以强调收进
 * 开关本身：停着时开关用警示色（`onColorVar`），旁边标签是「已停止」。
 * 那仍然显眼（页头右上角、一个亮色滑块），而不需要一整条红栏。
 */
import { Switch } from "@mycontext/design"
import type { PersonaSnapshotView } from "@mycontext/ipc-contract"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { ChannelPicker } from "../shell/channel-picker.js"
import { ChannelBadge } from "./channel-badge.js"

/**
 * 数字分身**只**在这个渠道上工作。
 *
 * 其余渠道是只读接入：不进自动回复、不进发消息链路（结构上就没挂
 * `personaSupervisor`，见 `DataPlaneService.attach` 里非主渠道那个分支）。
 * 所以这不是"还没做"，而是一条刻意的边界 —— 只读渠道不该能替用户说话。
 */
export const PERSONA_SUPPORTED_CHANNEL = "dingtalk"

export interface PersonaHeaderControlsProps {
  snapshot: PersonaSnapshotView | undefined
  /** 出现在会话列表里的渠道（从数据推，不写死 —— 见 persona-module） */
  channelIds: readonly string[]
  /**
   * 已授权的**全部**渠道 —— 与 `channelIds` 不同：那个是"列表里有哪些"，
   * 这个是"用户连了哪些"。选择器要列后者，否则飞书连上了却看不到入口，
   * 而"为什么飞书不在这里"就成了一个没有答案的问题。
   */
  authorizedChannelIds?: readonly string[]
  activeChannelId?: string | null
  onChannelChange?: (id: string) => void
  killSwitchBusy: boolean
  onToggleRunning: (running: boolean) => void
}

export function PersonaHeaderControls({
  snapshot,
  channelIds,
  authorizedChannelIds = [],
  activeChannelId = null,
  onChannelChange,
  killSwitchBusy,
  onToggleRunning,
}: PersonaHeaderControlsProps) {
  const { t } = useDynamicTranslation("persona")
  const { t: tc } = useDynamicTranslation("channels")
  const stopped = snapshot?.killSwitch === true
  const running = !stopped
  const drafts = snapshot?.pendingDrafts ?? 0

  return (
    <div className="flex items-center gap-3">
      {/*
        渠道：多个已授权时给**选择器**（后面那些数字的限定词），
        否则退回静态徽章。

        ★ 非主渠道标「暂未支持」：数字分身只在主渠道上工作 —— 飞书是**只读**
        接入（不进自动回复/发消息链路，结构上就没挂 personaSupervisor）。
        让它可选中而不是藏起来：藏起来的话"飞书连上了为什么这里没有"
        是一个没有答案的问题，而选中后页面会说清原因。
      */}
      {authorizedChannelIds.length > 1 && onChannelChange !== undefined ? (
        <ChannelPicker
          options={authorizedChannelIds.map((id) => ({
            id,
            label: tc(`${id}.label`, { defaultValue: id }),
            unsupported: id !== PERSONA_SUPPORTED_CHANNEL,
          }))}
          activeId={activeChannelId}
          onChange={onChannelChange}
          ariaLabel={t("channelPickerLabel", { defaultValue: "选择渠道" })}
        />
      ) : (
        channelIds.map((id) => <ChannelBadge key={id} channelId={id} />)
      )}

      {/*
        三个数字，inline 轻量式。
        「待审草稿」给强调色 —— 它是这一页唯一需要用户动手的那个数。
      */}
      <dl className="flex items-center gap-3">
        <InlineStat label={t("statAutoReply")} value={snapshot?.autoReplyCount ?? 0} />
        <InlineStat label={t("statPending")} value={snapshot?.pendingInbox ?? 0} />
        <InlineStat label={t("statDrafts")} value={drafts} accent={drafts > 0} />
      </dl>

      {/*
        ★ 单个开关，不是二段控件。
        停着时用警示色（`onColorVar`）—— "现在没在替我说话"是个需要知道的状态。
        标签跟着状态走：跑着显示「运行中」，停了显示「已停止」。
      */}
      <Switch
        checked={running}
        disabled={killSwitchBusy}
        ariaLabel={t("runStateLabel")}
        label={running ? t("runStateRunning") : t("runStateStopped")}
        title={running ? t("runStateRunningHint") : t("killSwitchHint")}
        onColorVar={running ? "--status-success" : "--status-warning"}
        onChange={(next) => onToggleRunning(next)}
      />
    </div>
  )
}

/**
 * 一个 inline 统计：`数字 标签`，横排。
 *
 * 与原来 `figure-base-600`（28px 上下堆叠）不同 —— 这里是页头，
 * 数字用 `body-base-500`（比标签重一档就够了），标签紧跟在后面。
 * `tabular-nums` 不加：三个数不构成需要对齐的列。
 */
function InlineStat({
  label,
  value,
  accent = false,
}: {
  label: string
  value: number
  accent?: boolean
}) {
  return (
    <span className="flex items-baseline gap-1">
      <dd
        className={
          accent
            ? "typography-body-base-500 text-[var(--text-accent-normal)]"
            : "typography-body-base-500 text-[var(--text-base-primary)]"
        }
      >
        {value.toLocaleString()}
      </dd>
      <dt className="typography-caption-400 text-[var(--text-base-tertiary)]">{label}</dt>
    </span>
  )
}
