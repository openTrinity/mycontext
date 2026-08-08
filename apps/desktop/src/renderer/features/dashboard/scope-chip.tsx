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
 * ## ★ 多渠道是**分段切换**而不是下拉
 *
 * 原来是原生 `<select>`（那时只有一个取值，下拉是占位）。第二个渠道接上
 * 之后它成了一个真正会被点的控件，而这里的取值域**只有两三个** ——
 * 分段控件把全部选项摊开，一眼看到"有哪些"且一次点击就切完；
 * 下拉要两次点击，还藏起了"我能看什么"这个信息。
 *
 * ★ 带官方品牌图标（走 `CHANNEL_BRAND_ICONS`，与设置页共用一张表）：
 * 「钉钉/飞书」这两个词在扫视时很像，图标才是真正被认出来的东西。
 *
 * ## ★★ 切换会改整页的每一个数字
 *
 * 那六个清点数、那张关系图、下面的事实列表 —— 全都跟着这个值走
 * （见 `DashboardModule` 的 `activeChannelId`）。这也是它必须在**页头**、
 * 与页面标题同级的理由：一个作用于整页的取值范围画在页面内部，
 * 读起来像"只影响这一小块"。
 *
 * `onChange` 的接口现在就留好，第二个渠道接上时**不需要改这个组件**。
 */
import type { ChannelSummary } from "@mycontext/ipc-contract"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { ChannelPicker } from "../shell/channel-picker.js"
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

  /**
   * 多渠道：下拉选择器（见 `ChannelPicker` 文件头为什么不是分段平铺）。
   *
   * ★ 这里不做"只有一个就不显示"的判断 —— `ChannelPicker` 自己在单选项时
   * 退化成静态标识。判断放在一处，两边不会漂。
   */
  return (
    <ChannelPicker
      options={connected.map((item) => ({
        id: item.id,
        label: t(`${item.id}.label`, { defaultValue: item.id }),
      }))}
      activeId={activeChannelId}
      onChange={onChannelChange}
      ariaLabel={t("switcherLabel", { defaultValue: "选择渠道" })}
    />
  )
}
