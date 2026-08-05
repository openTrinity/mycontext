/**
 * SidebarUserButton — 侧栏底部的用户入口。
 *
 * 头像 + 显示名 + 展开指示；点开是账号菜单（偏好 / 设置 / 主题 / 语言 / 退出）。
 *
 * ## 为什么把这些集中到一个菜单里
 *
 * 首版把主题切换与退出登录做成底部两个 IconButton —— 那让**登出**
 * 变成一个 24px 的图标，与"切换主题"同等重量。而这两个动作的后果完全不同：
 * 一个可逆且无成本，另一个会结束会话。
 *
 * 菜单让登出需要"先展开、再选中"两步，且能带上文字标签 ——
 * 不是为了增加摩擦，而是让它**可读**（图标按钮只有 hover 才知道是什么）。
 *
 * 菜单向**上**弹（`side="top"`）：按钮在侧栏最底部，向下弹会超出视口。
 */
import {
  Avatar,
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
  cn,
} from "@mycontext/design"
import { languageNames, LANGUAGES } from "@mycontext/i18n"
import {
  resolveDisplayName,
  type AuthSession,
  type LanguagePreference,
} from "@mycontext/ipc-contract"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { useSetLanguage } from "../../lib/queries.js"
import type { ThemePreference } from "../../lib/use-theme.js"
import {
  ChevronUpDownIcon,
  GlobeIcon,
  LogOutIcon,
  MoonIcon,
  SettingsIcon,
  SunIcon,
} from "./icons.js"

export interface SidebarUserButtonProps {
  session: AuthSession
  /** 当前语言偏好（跟随系统时为 "system"） */
  language: LanguagePreference
  theme: {
    preference: ThemePreference
    resolved: "light" | "dark"
    setPreference: (next: ThemePreference) => void
  }
  onOpenSettings: () => void
  onSignOut: () => void
  signOutPending: boolean
}

/** 主题三档循环：跟随系统 → 亮 → 暗 → 跟随系统。 */
const THEME_ORDER: readonly ThemePreference[] = ["system", "light", "dark"]

export function SidebarUserButton({
  session,
  language,
  theme,
  onOpenSettings,
  onSignOut,
  signOutPending,
}: SidebarUserButtonProps) {
  const { t } = useDynamicTranslation()
  const setLanguage = useSetLanguage()
  const name = resolveDisplayName(session)

  const themeLabel = t(`theme.${theme.preference}`)
  const nextTheme =
    THEME_ORDER[(THEME_ORDER.indexOf(theme.preference) + 1) % THEME_ORDER.length] ?? "system"

  return (
    <DropdownMenu
      side="top"
      align="start"
      className="w-[calc(100%-8px)]"
      trigger={(props) => (
        <button
          type="button"
          {...props}
          className={cn(
            "flex w-full items-center gap-2 radius-md px-2 py-1.5 text-left",
            "transition-colors duration-150 ease-out",
            "hover:bg-[var(--overlay-on-container-hover)]",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]",
          )}
        >
          <Avatar name={name} src={session.avatarUrl} size="md" />
          <span className="min-w-0 flex-1">
            <span className="typography-body-small-400 block truncate text-[var(--text-base-primary)]">
              {name}
            </span>
            {/* 第二行给 email：名字可能是花名，email 才是"这是哪个账号"的答案 */}
            <span className="typography-caption-400 block truncate text-[var(--text-base-tertiary)]">
              {session.email}
            </span>
          </span>
          <span className="shrink-0 text-[var(--text-base-tertiary)]">
            <ChevronUpDownIcon />
          </span>
        </button>
      )}
    >
      {/* 头部：再显示一次头像+名字 —— 菜单可能盖住触发器，需要自带上下文 */}
      <div className="flex items-center gap-2 px-2 py-2">
        <Avatar name={name} src={session.avatarUrl} size="lg" />
        <span className="min-w-0">
          <span className="typography-body-small-400 block truncate text-[var(--text-base-primary)]">
            {name}
          </span>
          <span className="typography-caption-400 block truncate text-[var(--text-base-tertiary)]">
            {session.email}
          </span>
        </span>
      </div>
      <DropdownMenuSeparator />

      <DropdownMenuItem icon={<SettingsIcon />} onSelect={onOpenSettings}>
        {t("modules.settings.label")}
      </DropdownMenuItem>

      {/*
        主题与语言直接在菜单里切，不做二级子菜单：
        两者各只有 3 / 3 个取值，子菜单的展开成本高于直接循环切换。
        当前值放在 trailing 位置 —— 让"点一下会变成什么"可预期。

        ★ closeOnSelect={false}：这两项是**就地循环**（点一下换下一档），
        菜单要留着让人接着点；而"设置""退出"是终结动作，用默认的选中即关。
      */}
      <DropdownMenuItem
        icon={theme.resolved === "dark" ? <MoonIcon /> : <SunIcon />}
        trailing={<span className="typography-caption-400">{themeLabel}</span>}
        closeOnSelect={false}
        onSelect={() => theme.setPreference(nextTheme)}
      >
        {t("theme.menuLabel")}
      </DropdownMenuItem>

      <DropdownMenuItem
        icon={<GlobeIcon />}
        closeOnSelect={false}
        trailing={
          <span className="typography-caption-400">
            {language === "system" ? t("language.system") : languageNames[language]}
          </span>
        }
        onSelect={() => {
          // system → zh → en → system
          const order: LanguagePreference[] = ["system", ...LANGUAGES]
          const next = order[(order.indexOf(language) + 1) % order.length] ?? "system"
          setLanguage.mutate(next)
        }}
      >
        {t("language.label")}
      </DropdownMenuItem>

      <DropdownMenuSeparator />
      <DropdownMenuItem
        icon={<LogOutIcon />}
        disabled={signOutPending}
        onSelect={onSignOut}
        className="text-[var(--text-status-error)]"
      >
        {t("actions.signOut")}
      </DropdownMenuItem>
    </DropdownMenu>
  )
}
