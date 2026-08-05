/**
 * 页头那枚**取值范围**筹码 —— 「这一页的数据来自哪个渠道」。
 *
 * ## ★ 为什么它不在身份卡里
 *
 * 上一版把「钉钉」贴在我名字后面（`高鹏 [钉钉]`），读起来是
 * "**钉钉的**高鹏" —— 一个属性。但它实际上是**整页的取值范围**：
 * 那 12,034 条消息、那张关系图、那些事实，全都只来自这一个渠道。
 *
 * 一个作用于整页的筛选条件贴在页面**内部某个人**的名字上，会让
 * 读者以为换掉它只影响那一小块。所以它升到页头、与页面标题同级 ——
 * 那是"我在看什么范围的数据"该待的位置（与很多工具的
 * workspace / project 选择器同一个位置，读者不用学）。
 *
 * ## ★ 只有一个渠道时不做下拉
 *
 * 实测飞书 `available: false`（`plugins/feishu/index.ts:25`），也就是当前
 * 只有钉钉真的可用。给一个只有一项的下拉是**假的可配置性** ——
 * 与 `facts-explorer.tsx` 里那条注释同一个判断：「一个空的下拉框是噪声」。
 *
 * 判据（哪些算已连接、要不要给切换器）走 `readIdentityBar` ——
 * 与身份卡共用同一个纯函数，那样"算不算已连接"不会两处判得不一样。
 *
 * `onChange` 的接口现在就留好，第二个渠道接上时**不需要改这个组件**。
 */
import { cn } from "@mycontext/design"
import type { ChannelSummary } from "@mycontext/ipc-contract"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { ChannelBadge } from "../persona/channel-badge.js"
import { readIdentityBar } from "./dashboard-data.js"

export interface ScopeChipProps {
  channels: readonly ChannelSummary[]
  /** 当前看的渠道。`null` = 还没读到渠道列表 */
  activeChannelId: string | null
  onChannelChange: (channelId: string) => void
}

export function ScopeChip({ channels, activeChannelId, onChannelChange }: ScopeChipProps) {
  const { t } = useDynamicTranslation("channels")
  const view = readIdentityBar({
    channels,
    // 这两个与渠道判定无关 —— 给中性值，只取 connectedChannelIds / showChannelPicker
    personaName: "x",
    selfConfirmed: true,
  })
  const connected = channels.filter((item) => view.connectedChannelIds.includes(item.id))

  // 一个渠道都没连：什么都不画（页头不该出现一个空的范围）
  if (connected[0] === undefined) return null

  if (!view.showChannelPicker) {
    /**
     * 单渠道：一枚静态标识。
     *
     * ★ 仍然显示（而不是"只有一个就不显示"）—— 它回答的是
     * "这些数字是**哪来的**"，那个问题在只有一个渠道时同样存在。
     */
    return <ChannelBadge channelId={connected[0].id} />
  }

  /**
   * 多渠道：原生 `<select>`。
   *
   * 这是一个"从 N 个里选一个"的动作，原生控件自带键盘、读屏器语义与
   * 系统外观。自己写一个下拉要几十行才追上，而这里没有任何原生做不到的需求。
   *
   * ★ 选项文字用 i18n 的渠道名，不用 `item.id`。
   * `dingtalk` 这种内部 id 出现在用户界面上是"漏出实现"的典型形态，
   * 而 `channels` 那份 i18n 里本来就有 `<id>.label`（`ChannelBadge` 在用）。
   */
  return (
    <select
      value={activeChannelId ?? connected[0].id}
      onChange={(event) => onChannelChange(event.target.value)}
      aria-label={t("switcherLabel", { defaultValue: "选择渠道" })}
      className={cn(
        "typography-caption-400 rounded-[var(--radius-sm)] px-1.5 py-0.5",
        "border border-[var(--border-divider-light)] bg-[var(--bg-card-z0)]",
        "text-[var(--text-base-secondary)]",
      )}
    >
      {connected.map((item) => (
        <option key={item.id} value={item.id}>
          {t(`${item.id}.label`, { defaultValue: item.id })}
        </option>
      ))}
    </select>
  )
}
