/**
 * 侧栏模块清单。
 *
 * ## 为什么「运行状态」与三个业务模块同组
 *
 * 首版把它与「设置」一起放在分割线**下面**（"基建"分组）。但设置已经改成
 * 用户菜单里的弹窗，分割线就没有分隔对象了 —— 剩一条线孤零零地把
 * 「运行状态」推到远处，读起来像是"另一类东西"，而用户看它的频率
 * 与看仪表盘/搜索是同一量级（"数据采到哪了"是日常问题）。
 *
 * 所以现在只有**一组**导航项，没有分割线。
 */
import type { ReactNode } from "react"
import { DashboardIcon, GaugeIcon, PersonaIcon, SearchIcon } from "./icons.js"

export type ModuleId = "status" | "settings" | "dashboard" | "persona" | "search"

export interface ModuleManifest {
  id: ModuleId
  labelKey: string
  icon: ReactNode
  /** 是否已落地；false 时侧栏项禁用并显示「暂未开放」 */
  available: boolean
  /** 未开放时展示给用户的说明（点击后在内容区提示） */
  descriptionKey: string
}

/**
 * 侧栏导航项：仪表盘 / 数字人 / 搜索 / 运行状态。
 *
 * 「设置」不在这里 —— 它是用户菜单里的弹窗（见 features/settings/settings-dialog.tsx）。
 *
 * ## ★「知识图谱」曾是这里的第四项，现在没有了
 *
 * 两个原因，都不是"少一栏更清爽"这种整洁问题：
 * · **那个名字本身是技术词** —— 用户不会为了"看看它认识我周围的谁"
 *   点进一个叫图谱的地方；
 * · **它与仪表盘讲的是同一个故事的两段** —— 分开之后两边都不完整
 *   （仪表盘不知道图里有什么，图谱页不知道分身在干什么）。
 *
 * 整块搬进了仪表盘（ego 图 + 邻居排名 + 类型分布 + 可检索的事实面板），
 * 见 `features/dashboard/dashboard-module.tsx` 的文件头。
 */
export const FEATURE_MODULES: readonly ModuleManifest[] = [
  {
    id: "dashboard",
    labelKey: "modules.dashboard.label",
    icon: <DashboardIcon />,
    /**
     * 用户打开应用第一眼看的那一页：分身状态 + 掌握的数据 + 关系图。
     *
     * ★ 刻意**不含**「知识管道」与「画像蒸馏」那两块技术指标
     * （Outbox 的 acked_seq、distill_tasks 的状态机）——
     * 它们要求用户理解我们的架构，而他要的答案只有"能不能用、有没有出事"。
     * 那两块的失效信号压成一行人话（见 `readProcessing`），
     * 技术细节留在「运行状态」页。
     *
     * ★ 数据**全部**来自已有 IPC，没有为这一页新增任何统计查询 ——
     * 那些 COUNT 是全表的，而这一页恰好是用户最常停留的一页。
     */
    available: true,
    descriptionKey: "modules.dashboard.description",
  },
  {
    id: "persona",
    labelKey: "modules.persona.label",
    icon: <PersonaIcon />,
    /**
     * 已落地：会话监听配置 + 消息可视化（@我 高亮）+ 草稿箱 + 运行日志。
     *
     * ★ 两处降级在界面上明示而不是静默：
     * · 没配 LLM → 顶部横幅（仍走完调度，但草稿是占位文本）；
     * · 「发送」只标状态不真发（真发需要渠道侧授权，入口还没做）。
     */
    available: true,
    descriptionKey: "modules.persona.description",
  },
  {
    id: "search",
    labelKey: "modules.search.label",
    icon: <SearchIcon />,
    // M2 落地：欢迎区 + 输入框 + 会话历史 + 本地检索。
    // Agent 编排缺失时降级为直出召回列表（在 UI 上明示，不静默降质）。
    available: true,
    descriptionKey: "modules.search.description",
  },
  {
    id: "status",
    labelKey: "modules.status.label",
    icon: <GaugeIcon />,
    available: true,
    descriptionKey: "modules.status.description",
  },
]

/**
 * 运行状态。
 *
 * ★ 它已经**不是**默认落地页了（见下面的 `DEFAULT_MODULE`），但仍然导出：
 * 侧栏结构的门禁（tests/unit/desktop/sidebar-structure.test.ts）按它定位
 * 模块清单的结尾，而且诊断类入口将来可能直接跳到这一页。
 */
export const STATUS_MODULE: ModuleManifest = FEATURE_MODULES.find(
  (m) => m.id === "status",
) as ModuleManifest

/**
 * 默认落地页 = 仪表盘。
 *
 * ★ 原来落在「运行状态」—— 那一页摆的是探针周期、Outbox 位点、消费者
 * 租约这些**给我们排查用**的东西。用户打开应用第一眼看到它，
 * 得到的印象是"这是个需要运维的系统"，而不是"这是我的数字分身"。
 *
 * 仪表盘回答的是他真正关心的三件事：分身在做什么、掌握了我多少、
 * 认识我周围的谁。
 */
export const DEFAULT_MODULE: ModuleManifest = FEATURE_MODULES.find(
  (m) => m.id === "dashboard",
) as ModuleManifest
