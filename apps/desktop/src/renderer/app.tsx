/**
 * App — 启动门禁。
 *
 * bootstrap 状态是唯一的路由依据，顺序刻意如此：
 *   未登录 → 登录页（主壳与引导都不挂载）
 *   需引导 → Onboarding（首次没有任何渠道授权时）
 *   否则   → 主壳
 * 判定都在主进程完成，渲染层不做二次推断，避免两处逻辑漂移。
 */
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@mycontext/design"
import { resolveLanguage } from "@mycontext/i18n"
import { useBootstrapState, useRuntimeConfigSync } from "./lib/queries.js"
import { useErrorText } from "./lib/use-error-text.js"
import { useTheme } from "./lib/use-theme.js"
import { AuthView } from "./features/auth/auth-view.js"
import { OnboardingView } from "./features/onboarding/onboarding-view.js"
import { AppShell } from "./features/shell/app-shell.js"
import { QuitConfirmDialog } from "./features/shell/quit-confirm-dialog.js"
import { QuittingOverlay } from "./features/shell/quitting-overlay.js"

export function App() {
  // 在门禁之前调用：主题必须在两种分支下都生效。
  useTheme()
  /**
   * 网关配置变了 → 失效受影响的 query（见 `useRuntimeConfigSync`）。
   *
   * 挂在 App 级而不是设置页：**引导页也读**「配了模型没有」，而它与设置页
   * 是两个分支（App 的路由二选一）。挂在其中任一个的话另一个收不到 ——
   * 实测过的表现就是引导第 5 步一直说「没配模型」，而模型早配好了、
   * kl 也已经带着新网关重启完。
   */
  useRuntimeConfigSync()
  const { t, i18n } = useTranslation()
  const errorText = useErrorText()
  const bootstrap = useBootstrapState()

  /**
   * 退出流的两个渲染层职责。
   *
   * ① `quitRequested` —— 主进程在问"真要退出吗"。弹我们自己画的确认框
   *    （见 quit-confirm-dialog.tsx 文件头：为什么不用原生 messageBox）。
   *    用户选完必须回话，否则主进程会等到超时（3s）后按确认处理。
   * ② `quitting` —— 用户已确认，dispose 正在跑。挂遮罩锁死界面。
   *
   * 两个都挂在 App 级而不是 AppShell：退出可能发生在**任何**状态下
   * （登录页 / 引导页 / 加载态 / 主壳），挂最外层保证总能盖住当前视图。
   */
  const [quitRequested, setQuitRequested] = useState(false)
  const [quitting, setQuitting] = useState(false)
  useEffect(() => {
    const offRequested = window.mycontext.app.onQuitRequested(() => setQuitRequested(true))
    const offQuitting = window.mycontext.app.onQuitting(() => setQuitting(true))
    return () => {
      offRequested()
      offQuitting()
    }
  }, [])

  /**
   * 回话给主进程。
   *
   * 先关弹窗再回话：确认时主进程紧接着会推 `shell:quitting`，遮罩要能
   * 干净地接管屏幕；留着确认框会让两层浮层短暂叠在一起。
   */
  const answerQuit = (confirmed: boolean, dontAskAgain: boolean) => {
    setQuitRequested(false)
    void window.mycontext.app.quitDecision({ confirmed, dontAskAgain })
  }

  /**
   * 把持久化的语言偏好应用到 i18n。
   *
   * i18n 初始化时用的是系统语言（首帧不能等 IPC），这里拿到用户的选择后校正。
   * 已经一致时不调 changeLanguage——那会触发一次无谓的全局重渲染。
   */
  const preference = bootstrap.data?.language
  useEffect(() => {
    if (preference === undefined) return
    const target = resolveLanguage(preference)
    if (i18n.language !== target) void i18n.changeLanguage(target)
  }, [preference, i18n])

  /**
   * 主体路由。抽成局部变量而不是多个 return：应用级的退出确认框与遮罩
   * 要与每一个分支**并列**渲染，早 return 的话就得把它们复制 4 次。
   */
  const body = renderBody()
  return (
    <>
      {body}
      {/* 遮罩挂上后确认框已经关了（见 answerQuit），两者不会同时可见 */}
      <QuitConfirmDialog
        open={quitRequested}
        onCancel={() => answerQuit(false, false)}
        onConfirm={(dontAskAgain) => answerQuit(true, dontAskAgain)}
      />
      <QuittingOverlay visible={quitting} />
    </>
  )

  function renderBody() {
    if (bootstrap.isLoading) {
      return (
        <div className="flex h-full items-center justify-center bg-[var(--bg-base-normal)]">
          <span className="typography-body-base-400 text-[var(--text-base-tertiary)]">
            {t("app.starting")}
          </span>
        </div>
      )
    }

    if (bootstrap.error !== null) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 bg-[var(--bg-base-normal)] p-6">
          <p className="typography-body-base-400 text-[var(--status-error)]">
            {errorText(bootstrap.error)}
          </p>
          <Button size="sm" variant="secondary" onClick={() => void bootstrap.refetch()}>
            {t("app.retry")}
          </Button>
        </div>
      )
    }

    const state = bootstrap.data
    if (state === undefined) return null

    if (state.session === null) return <AuthView hasAccount={state.hasAccount} />
    if (state.needsOnboarding) return <OnboardingView />
    return <AppShell session={state.session} />
  }
}
