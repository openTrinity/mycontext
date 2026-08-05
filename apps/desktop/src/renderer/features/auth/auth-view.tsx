/**
 * AuthView — 登录 / 注册页。
 *
 * 布局沿用设计系统的登录页规范：
 *   左栏：标题 + 描述 + 表单 + 主按钮（56px 内边距）
 *   右栏：品牌氛围面板（深色底 + 扩散光环 + 居中 logo 方块），固定 320px
 *
 * 首启（无任何账号）默认进注册态，其余进登录态；两态共用一套表单，
 * 只切换标题、按钮文案与校验强度。
 */
import { useState } from "react"
import type { FormEvent } from "react"
import { useTranslation } from "react-i18next"
import { AmbientRings, BrandMark, Button, Checkbox, Field, Input } from "@mycontext/design"
import { PASSWORD_MIN_LENGTH, REMEMBER_SESSION_DAYS } from "@mycontext/ipc-contract"
import { useLogin, useRegister } from "../../lib/queries.js"
import { useErrorText } from "../../lib/use-error-text.js"

export interface AuthViewProps {
  /** 是否已存在账号：决定默认进入登录还是注册 */
  hasAccount: boolean
}

export function AuthView({ hasAccount }: AuthViewProps) {
  const { t } = useTranslation("auth")
  const errorText = useErrorText()
  const [mode, setMode] = useState<"login" | "register">(hasAccount ? "login" : "register")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  // 默认不记住：勾上意味着拿到这台设备就能直接进应用，必须由用户显式选择。
  const [remember, setRemember] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const login = useLogin()
  const register = useRegister()
  const pending = login.isPending || register.isPending
  const remoteError = mode === "login" ? login.error : register.error

  const isRegister = mode === "register"

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setLocalError(null)

    if (isRegister) {
      if (password.length < PASSWORD_MIN_LENGTH) {
        setLocalError(t("validation.passwordTooShort", { min: PASSWORD_MIN_LENGTH }))
        return
      }
      if (password !== confirm) {
        setLocalError(t("validation.passwordMismatch"))
        return
      }
      register.mutate({ email, password, remember })
      return
    }
    login.mutate({ email, password, remember })
  }

  const switchMode = () => {
    setMode(isRegister ? "login" : "register")
    setLocalError(null)
    setConfirm("")
    login.reset()
    register.reset()
  }

  const displayError = localError ?? (remoteError === null ? null : errorText(remoteError))

  return (
    /*
      登录页铺满整个窗口，不做居中卡片：
      这是应用的第一屏且窗口本身就是"弹窗"，再套一层浮起的卡片只会在四周
      留下一圈无用留白（mac 无边框窗口下还会露出桌面透出的 vibrancy）。
      左右分栏直接贴到窗口边缘，右侧品牌面板与窗口同高。
    */
    <div className="flex h-full bg-[var(--bg-card-z1)]">
      {/* 左栏：文案 + 表单。表单本身限宽居中，避免宽屏下输入框被拉得过长 */}
      <div
        data-window-drag
        className="flex min-w-0 flex-1 items-center justify-center overflow-y-auto px-10 py-12"
      >
        {/* 表单区不参与窗口拖动，否则输入框无法选中文本 */}
        <div
          data-no-drag
          className="flex w-full max-w-[380px] flex-col gap-[var(--gap-section-xxl)]"
        >
          <div className="flex flex-col gap-[var(--gap-section-lg)]">
            <h1 className="typography-title-large-600 text-[var(--text-base-primary)]">
              {isRegister ? t("register.title") : t("login.title")}
            </h1>
            <p className="typography-body-base-400 whitespace-pre-line text-[var(--text-base-secondary)]">
              {isRegister ? t("register.subtitle") : t("login.subtitle")}
            </p>
          </div>

          <form className="flex flex-col gap-[var(--gap-section-sm)]" onSubmit={submit}>
            <Field label={t("fields.email")} required>
              {(attributes) => (
                <Input
                  {...attributes}
                  size="lg"
                  type="email"
                  autoComplete="username"
                  placeholder={t("fields.emailPlaceholder")}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={pending}
                />
              )}
            </Field>

            <Field
              label={t("fields.password")}
              required
              {...(isRegister
                ? { description: t("fields.passwordHint", { min: PASSWORD_MIN_LENGTH }) }
                : {})}
            >
              {(attributes) => (
                <Input
                  {...attributes}
                  size="lg"
                  type="password"
                  autoComplete={isRegister ? "new-password" : "current-password"}
                  placeholder="••••••••"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={pending}
                />
              )}
            </Field>

            {isRegister ? (
              <Field label={t("fields.confirmPassword")} required>
                {(attributes) => (
                  <Input
                    {...attributes}
                    size="lg"
                    type="password"
                    autoComplete="new-password"
                    placeholder="••••••••"
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                    disabled={pending}
                  />
                )}
              </Field>
            ) : null}

            {displayError === null ? null : (
              <p
                role="alert"
                className="typography-body-small-400 radius-md bg-[var(--status-fill-error-container)] px-3 py-2 text-[var(--status-error)]"
              >
                {displayError}
              </p>
            )}

            <Checkbox
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              disabled={pending}
              label={t("fields.remember", { days: REMEMBER_SESSION_DAYS })}
            />

            <div className="mt-1 flex flex-col gap-[var(--gap-component-md)]">
              <Button type="submit" size="lg" block loading={pending}>
                {isRegister ? t("register.submit") : t("login.submit")}
              </Button>
              <button
                type="button"
                onClick={switchMode}
                disabled={pending}
                className="typography-body-small-400 cursor-pointer text-[var(--text-base-tertiary)] transition-colors hover:text-[var(--text-accent-normal)] disabled:cursor-not-allowed"
              >
                {isRegister ? t("register.switch") : t("login.switch")}
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* 右栏：品牌氛围，与窗口同高，直接贴边 */}
      <div className="relative hidden h-full w-[38%] max-w-[420px] shrink-0 overflow-hidden bg-[var(--bg-brand-panel)] md:block">
        <AmbientRings className="absolute inset-0 size-full" />
        <div className="absolute left-1/2 top-1/2 flex size-[72px] -translate-x-1/2 -translate-y-1/2 items-center justify-center radius-3xl bg-[var(--theme-black-black-40)] text-[var(--theme-white-white-100)]">
          <BrandMark size={40} />
        </div>
        <p className="typography-caption-400 absolute bottom-8 left-0 w-full text-center text-[var(--theme-white-white-50)]">
          MyContext
        </p>
      </div>
    </div>
  )
}
