/**
 * AppShell — 已登录后的应用外壳。
 *
 * 侧边栏结构对齐参考设计系统的侧栏规范：
 *   1. System-bar（48px）：mac 下左侧为原生交通灯预留空间，整条作为窗口拖动区，
 *      右侧放折叠按钮
 *   2. 品牌区：logo + 产品名
 *   3. 导航区：三个业务模块（仪表盘 / 数字人 / 搜索）+ 基建的「运行状态」
 *   4. 底部账号区：邮箱 + 主题切换 + 退出登录
 *
 * 两种展开方式（见 useSidebarState 的注释）：
 *   固定展开 — 侧栏参与布局，内容区被推开
 *   浮层预览 — 收起态下 hover 顶栏按钮，侧栏盖在内容之上，布局宽度不变
 *
 * 三个业务模块本阶段均未开放（见 modules.tsx 的 available 标记），
 * 点击后内容区显示说明而非空白页。
 */
import { BrandWordmark, cn } from "@mycontext/design"
import { resolveDisplayName, type AuthSession } from "@mycontext/ipc-contract"
import { useCallback, useRef, useState } from "react"
import type { ReactNode, UIEvent } from "react"
import {
  useBootstrapState,
  useChannels,
  useLogout,
  useSearchSessionMutations,
  useSearchSessions,
} from "../../lib/queries.js"
import { useSidebarState } from "../../lib/use-sidebar-state.js"
import { useTheme } from "../../lib/use-theme.js"
import { AppHeader } from "./app-header.js"
import { HeaderSlotProvider } from "./header-slot.js"
import { ComingSoonPanel } from "./coming-soon-panel.js"
import { PersonaModule } from "../persona/persona-module.js"
import { DashboardModule } from "../dashboard/dashboard-module.js"
import { ScopeChip } from "../dashboard/scope-chip.js"

import { DEFAULT_MODULE, FEATURE_MODULES, type ModuleId } from "./modules.js"
import { SidebarNavItem } from "./sidebar-nav-item.js"
import { SidebarResizer } from "./sidebar-resizer.js"
import { SidebarToggle } from "./sidebar-toggle.js"
import { SettingsDialog } from "../settings/settings-dialog.js"
import { SidebarUserButton } from "./sidebar-user-button.js"
import { SearchModule } from "../search/search-module.js"
import { SidebarSessionList } from "./sidebar-session-list.js"
import { StatusPanel } from "./status-panel.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

const IS_MAC = window.navigator.platform.toLowerCase().includes("mac")

export interface AppShellProps {
  session: AuthSession
}

export function AppShell({ session }: AppShellProps) {
  const { t } = useDynamicTranslation()
  const logout = useLogout()
  const theme = useTheme()
  const sidebar = useSidebarState()
  const [activeId, setActiveId] = useState<ModuleId>(DEFAULT_MODULE.id)
  /**
   * 搜索模块的当前会话。
   *
   * 放在 shell 而不是 SearchModule 里：侧栏（在 shell）要能选中它，
   * 而「选中哪个会话」是这两者的共享状态。提到共同祖先比双向回调清楚。
   */
  const [searchSessionId, setSearchSessionId] = useState<string | null>(null)
  /** 设置弹窗。放 shell 而不是用户按钮内部：Esc 关闭后焦点要回到 shell。 */
  const [settingsOpen, setSettingsOpen] = useState(false)
  /**
   * 当前看的渠道 —— **整页的取值范围**（见 `scope-chip.tsx`）。
   *
   * ## ★ 为什么这个 state 在 shell 而不在仪表盘里
   *
   * 它原来在 `DashboardModule` 里，那枚「钉钉」筹码画在页面内容的右上角。
   * 但一个作用于**整页**的筛选条件画在页面内部，读起来像"只影响这一小块"
   * —— 而它其实限定了那一页的每一个数字。
   *
   * 现在它进 `AppHeader` 的 actions 槽，与页面标题同级（很多工具的
   * workspace / project 选择器就在这个位置，读者不用学）。
   * 于是 state 要提到 header 与内容的**共同祖先**，也就是这里。
   *
   * ★ 现在只有钉钉真的可用（飞书 `available:false`），所以它暂时只有一个
   * 取值 —— 留着它是为了第二个渠道接上时不需要改结构。
   */
  const [activeChannel, setActiveChannel] = useState<string | null>(null)
  /**
   * 当前模块注入顶栏右侧的内容（见 `header-slot.tsx`）。
   *
   * ★ 切模块时**主动清空**：`useHeaderSlot` 的卸载清理只在那个模块真的
   * 卸载时才跑，而模块切换是否卸载取决于下面那棵条件渲染树。这里在
   * `activeId` 变化的同一拍清掉，保证 A 模块的头部内容不会闪现在 B 的标题旁。
   */
  const [headerSlot, setHeaderSlot] = useState<ReactNode | null>(null)
  const setHeaderContent = useCallback((node: ReactNode | null) => setHeaderSlot(node), [])
  const headerSlotValue = useRef({ setContent: setHeaderContent }).current
  const bootstrap = useBootstrapState()
  /**
   * 渠道列表 —— 给页头那枚取值范围筹码。
   *
   * 它本身有 `staleTime: 30s`（查询会 spawn 子进程），所以挂在 shell 上
   * 不会变成一个高频请求。`ScopeChip` 只在仪表盘渲染，一个渠道都没连时
   * 它自己返回 `null`（见那个组件），所以这里不需要额外的开关。
   */
  const channels = useChannels()
  const searchSessions = useSearchSessions(activeId === "search")
  const sessionMutations = useSearchSessionMutations()

  // 内容滚动后顶栏才显分隔线：静止时顶栏与内容融为一体，滚动时才需要边界。
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrolled, setScrolled] = useState(false)
  const onContentScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    setScrolled(event.currentTarget.scrollTop > 2)
  }, [])

  const active = FEATURE_MODULES.find((item) => item.id === activeId)

  const toggle = (
    <SidebarToggle
      collapsed={sidebar.collapsed}
      floating={sidebar.floating}
      onToggle={sidebar.toggle}
      onPin={sidebar.pin}
      onHoverStart={sidebar.beginHover}
      onHoverEnd={sidebar.releaseHoverSuppression}
    />
  )

  return (
    <div className="relative flex h-full overflow-hidden">
      <aside
        // data-sidebar-panel：供 useSidebarState 判定「鼠标是否仍在浮层内」
        data-sidebar-panel
        // 浮层态脱离文档流盖在内容上；固定态参与布局把内容推开。
        className={cn(
          "flex flex-col overflow-hidden",
          /*
           * 固定态在 mac 下用半透明 material 让原生 vibrancy 透出
           * （窗口已开 vibrancy:"sidebar"），实色底会把它整块盖掉、白开一层系统模糊。
           *
           * 浮层态必须换回**实色**：此时侧栏身后不是桌面而是应用内容，
           * 半透明会让两层文字叠在一起，谁都读不清。参考实现同样在浮层态
           * 强制 sidebar-normal，注释里写的正是「避免混色影响可读性」。
           */
          sidebar.floating || !IS_MAC
            ? "bg-[var(--bg-sidebar-normal)]"
            : "bg-[var(--bg-sidebar-material)]",
          "motion-safe:transition-[width,flex-basis] motion-safe:duration-200 motion-safe:ease-out",
          sidebar.floating
            ? // 浮层从顶栏下沿开始（top-12），不覆盖顶栏：
              // 顶栏那个按钮既是 hover 触发点又是「点击钉住」的目标，
              // 一旦被浮层盖住，鼠标下方就不再是按钮，点击自然失效。
              "absolute bottom-2 left-2 top-12 z-30 radius-xl border border-[var(--border-light)] shadow-[var(--shadow-lg)]"
            : "relative border-r border-[var(--border-divider-light)]",
        )}
        /*
         * 同时给 width 与 flexBasis：作为 flex item，仅设 width 会被内容的
         * min-content 尺寸顶开（收起时表现为 style 已是 0 但实际仍有 228px）。
         * flexBasis + flexShrink:0 才能让它精确等于指定宽度。
         */
        style={{
          width: sidebar.visible ? sidebar.width : 0,
          flexBasis: sidebar.visible ? sidebar.width : 0,
          flexGrow: 0,
          flexShrink: 0,
          minWidth: 0,
        }}
        aria-hidden={!sidebar.visible}
      >
        {/*
          收起时不渲染内部结构：既避免宽度为 0 的容器里仍有可聚焦按钮
          （Tab 键会跳进看不见的控件），也避免出现两个同名的展开按钮。
        */}
        {sidebar.visible ? (
          <>
            {/*
              System-bar：mac 无边框窗口下为原生交通灯预留空间，整条可拖动窗口。
              折叠按钮紧跟在交通灯右侧（而不是右对齐到侧栏边缘）——参考实现如此，
              好处是按钮位置不随侧栏宽度变化，拖动调宽时鼠标不用重新找目标。
              浮层态整行不渲染：浮层已从顶栏下沿开始，交通灯与折叠按钮都在顶栏，
              这里再留一行只会多出一段空白。
            */}
            {sidebar.floating ? null : (
              <div
                data-window-drag
                className="flex h-12 shrink-0 items-center"
                style={IS_MAC ? { paddingLeft: 82 } : { paddingLeft: 8 }}
              >
                {toggle}
              </div>
            )}

            {/* 品牌区：文字版标识 + Beta 标签；浮层态顶部补间距，替代被省掉的 System-bar */}
            {/* 浮层态没有 System-bar，顶部给 pt-4 免得品牌区贴着浮层上边缘 */}
            <div className={cn("flex items-center px-3 pb-2", sidebar.floating && "pt-4")}>
              <BrandWordmark size={20} tag="Beta" />
            </div>

            {/* 导航区 */}
            <nav
              className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2"
              aria-label={t("sidebar.nav")}
            >
              {FEATURE_MODULES.map((item) => (
                <SidebarNavItem
                  key={item.id}
                  label={t(item.labelKey)}
                  icon={item.icon}
                  active={activeId === item.id}
                  badge={item.available ? undefined : t("modules.comingSoon")}
                  onClick={() => {
                    // 换模块时清掉上一个模块注入顶栏的内容（见 headerSlot 的注释）
                    if (item.id !== activeId) setHeaderSlot(null)
                    setActiveId(item.id)
                  }}
                />
              ))}

              {/* 搜索模块激活时，在导航下方挂它的历史会话列表。
                  只在激活时渲染：其它模块下这块空间应留给它们自己的内容。 */}
              {activeId === "search" && (
                <>
                  <div className="my-2 h-px bg-[var(--border-divider-light)]" />
                  {/*
                    ★ 「新建搜索」是这一栏唯一的**动作**，其余都是历史条目。

                    原来它与历史条目同字号、同颜色（`body-small-400` +
                    secondary），只靠一个 `+` 号区分 —— 于是整栏读起来是
                    一列长得一样的文字，用户要找"从哪开始"得先读一遍。

                    改成：加号进一个圆形底色块（图标化的动作提示）、文字用
                    primary 而不是 secondary。**不用 Button 组件**：那会带来
                    一个填色按钮，在侧栏里比历史列表还抢眼 —— 而它只是
                    "常用的那一个"，不是页面的主 CTA。
                  */}
                  <button
                    type="button"
                    onClick={() => setSearchSessionId(null)}
                    className="group typography-body-small-400 mx-1 mb-1 flex items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-left text-[var(--text-base-primary)] transition-colors hover:bg-[var(--overlay-on-container-hover)]"
                  >
                    <span
                      aria-hidden
                      className="flex size-4 shrink-0 items-center justify-center rounded-full bg-[var(--bg-card-z0)] text-[var(--text-base-secondary)] transition-colors group-hover:bg-[var(--control-core-button-default)] group-hover:text-[var(--text-inverted-primary)]"
                    >
                      +
                    </span>
                    {t("actions.newSearch")}
                  </button>
                  <SidebarSessionList
                    sessions={searchSessions.data ?? []}
                    activeId={searchSessionId}
                    onSelect={setSearchSessionId}
                    onRename={(sessionId, title) =>
                      sessionMutations.rename.mutate({ sessionId, title })
                    }
                    onTogglePin={(sessionId, pinned) =>
                      sessionMutations.pin.mutate({ sessionId, pinned })
                    }
                    onDelete={(sessionId) => {
                      sessionMutations.remove.mutate(sessionId)
                      if (searchSessionId === sessionId) setSearchSessionId(null)
                    }}
                  />
                </>
              )}
            </nav>

            {/*
              底部用户区。
              不再有「设置」导航项与那条分割线 —— 设置进了这个菜单，
              而「运行状态」已经与业务模块同组（见 modules.tsx 的说明）。
            */}
            <div className="border-t border-[var(--border-divider-light)] p-1">
              <SidebarUserButton
                session={session}
                language={bootstrap.data?.language ?? "system"}
                theme={theme}
                onOpenSettings={() => setSettingsOpen(true)}
                onSignOut={() => logout.mutate()}
                signOutPending={logout.isPending}
              />
            </div>

            {/* 拖拽调宽：浮层态不提供（浮层是临时预览，改宽度会让人误以为改了固定宽度） */}
            {sidebar.floating ? null : (
              <SidebarResizer width={sidebar.width} onWidthChange={sidebar.setWidth} />
            )}
          </>
        ) : null}
      </aside>

      {/*
        浮层遮罩：只做视觉压暗 + 点击收回，本身不参与 hover 判定。
        起点避开顶栏（top-12）：顶栏的展开按钮必须保持可 hover 与可点，
        否则鼠标从按钮往浮层移动的路上会先命中遮罩。
      */}
      {sidebar.floating ? (
        <div
          className="absolute inset-x-0 bottom-0 top-12 z-20 bg-[var(--bg-page-mask)] opacity-40 motion-safe:transition-opacity"
          onClick={sidebar.endHover}
          aria-hidden="true"
        />
      ) : null}

      <main className="flex min-w-0 flex-1 flex-col bg-[var(--bg-base-normal)]">
        {/*
          顶栏：收起态才把折叠按钮放进来（它同时是 hover 浮层的触发点）。
          浮层展开时**必须保留它**——若此时换成占位，用户正要点的目标就消失了，
          结果只剩 hover 一条路径。去重改为隐藏浮层内部那个（见 aside 的 System-bar）。
        */}
        <AppHeader
          title={active === undefined ? "" : t(active.labelKey)}
          sidebarOccupiesTopLeft={!sidebar.collapsed}
          showDivider={scrolled}
          {...(sidebar.collapsed ? { toggle } : {})}
          /**
           * ★ 取值范围筹码只在仪表盘出现。
           *
           * 它限定的是"这一页的数字来自哪个渠道" —— 而搜索、运行状态、
           * 数字人那几页不是按渠道取的数，给它们一枚筹码会是**假的**
           * 筛选提示（读者以为换掉它会改变那一页，其实不会）。
           */
          {...(active?.id === "dashboard"
            ? {
                actions: (
                  <ScopeChip
                    channels={channels.data ?? []}
                    activeChannelId={activeChannel}
                    onChannelChange={setActiveChannel}
                  />
                ),
              }
            : headerSlot !== null
              ? { actions: headerSlot }
              : {})}
        />
        <div ref={scrollRef} onScroll={onContentScroll} className="min-h-0 flex-1 overflow-auto">
          {active === undefined ? null : !active.available ? (
            <ComingSoonPanel module={active} />
          ) : active.id === "dashboard" ? (
            <DashboardModule />
          ) : active.id === "persona" ? (
            <HeaderSlotProvider value={headerSlotValue}>
              <PersonaModule />
            </HeaderSlotProvider>
          ) : active.id === "search" ? (
            <SearchModule
              /**
               * ★ 与侧栏底部**同一个**解析器，不再自己切 email。
               *
               * 原来这里写 `session.email.split("@")[0]` —— 于是同一屏上
               * 出现两个身份：侧栏写「高鹏」（`resolveDisplayName`），
               * 而搜索首屏的问候语写「gaopeng」（email 前缀）。
               * 用户看到的是"这是同一个我吗"，而那种不一致比两处都用
               * email 前缀更糟：它让人怀疑自己有两个账号。
               *
               * `resolveDisplayName` 已经处理了 displayName 为空时退回
               * email 前缀 —— 所以这里不需要任何兜底逻辑，
               * 只需要**别再写第二份**。
               */
              userName={resolveDisplayName(session)}
              activeSessionId={searchSessionId}
              onSessionCreated={setSearchSessionId}
            />
          ) : (
            <div className="p-6">
              <StatusPanel />
            </div>
          )}
        </div>
      </main>

      {/* 设置弹窗：受 shell 状态控制，Esc/点遮罩关闭 */}
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
