/**
 * Onboarding 状态。
 *
 * 状态落在**账号自己的 vault 库**而不是应用级设置里：「引导过了」是某个账号的
 * 事实，换个账号登录理应重新引导。放在 app_settings 会让第二个账号一登录
 * 就跳过引导，而它其实还没连过任何渠道。
 *
 * 因此本服务的仓储是**登录后才绑定**的：装配阶段还不知道是哪个账号，
 * 也就还没有 vault 可开。未绑定时一律按「不需要引导」处理——
 * 未登录时先过登录门禁，此时问 onboarding 没有意义。
 *
 * ## ★ 判据是「四步的进度」，不是「有没有授权」
 *
 * 首版判据是 `已登录 && !dismissed && !hasAnyAuthorized()`。
 * 在只有"授权"一步时它是对的；引导变成 4 步之后它**把授权当成了引导完成** ——
 * 实测症状：vault 里没有任何 onboarding 记录（说明没被 dismiss），
 * 但 `dws auth status` 返回 `authenticated: true` → 引导直接不出现，
 * 用户永远看不到"数字人 / 蒸馏源 / 蒸馏进度"那三步。
 *
 * 现在判据只看 `onboarding_progress`：**四步都不是 pending** 才算走完
 * （done 与 skipped 都算走过）。授权与否交给第一步自己判断。
 */
import type { OnboardingRepository, OnboardingStep, SettingsRepository } from "@mycontext/store"

/** 旧版的整体标记。只为**兼容**已有用户，见 isDismissed 的注释。 */
const LEGACY_COMPLETED_KEY = "onboarding.completedAt"
const LEGACY_SKIPPED_KEY = "onboarding.skippedAt"

export class OnboardingService {
  /** 当前登录账号的 vault 设置；未登录时为 null。 */
  private settings: SettingsRepository | null = null
  private progress: OnboardingRepository | null = null

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** 登录（或恢复会话）后绑定当前账号的 vault 仓储；登出时传 null。 */
  bind(settings: SettingsRepository | null, progress: OnboardingRepository | null = null): void {
    this.settings = settings
    this.progress = progress
  }

  /**
   * 是否不再自动弹引导。
   *
   * 两个来源：
   * · 新版 —— `onboarding_progress` 四步都不是 pending；
   * · 旧版 —— `vault_settings` 里的 completedAt/skippedAt（v9 之前的记录）。
   *
   * 保留旧键的读取是**兼容已有用户**：他们的库里只有旧标记，
   * 忽略它会让升级后引导又弹一次（而他们明明已经走过了）。
   */
  isDismissed(): boolean {
    if (this.progress !== null && this.progress.isComplete()) return true
    if (this.settings === null) return false
    return (
      this.settings.get(LEGACY_COMPLETED_KEY) !== null ||
      this.settings.get(LEGACY_SKIPPED_KEY) !== null
    )
  }

  /** 读四步的进度（引导页用它决定停在哪一步、回填哪些表单）。 */
  steps(): ReturnType<OnboardingRepository["list"]> {
    return this.progress?.list() ?? []
  }

  /** 标记某一步完成（可带该步的产物，如数字人名字）。 */
  completeStep(step: OnboardingStep, payload?: unknown): true {
    this.progress?.setStep(step, "done", this.now().getTime(), payload)
    return true
  }

  /** 跳过某一步。与 pending 可区分 —— 重进引导时显示"已跳过"。 */
  skipStep(step: OnboardingStep): true {
    this.progress?.setStep(step, "skipped", this.now().getTime())
    return true
  }

  /**
   * 整体完成：把还是 pending 的步骤标成 **skipped**。
   *
   * 用户点"完成"而某几步没做时，那几步的事实就是**跳过**而不是完成 ——
   * 一律标 done 会让状态页显示"蒸馏已完成"而其实一条都没蒸。
   */
  complete(): true {
    this.settleRemaining()
    this.writeLegacy(LEGACY_COMPLETED_KEY)
    return true
  }

  /**
   * 暂时跳过整个引导。
   * 必须提供这条出口：用户可能没网或不想现在授权，
   * 没有跳过就会被卡在引导页进不了应用。
   */
  skip(): true {
    this.settleRemaining()
    this.writeLegacy(LEGACY_SKIPPED_KEY)
    return true
  }

  /**
   * 重新走引导（设置页的入口）。
   *
   * 必须清掉旧的整体标记 —— 否则 `isDismissed` 仍会因为旧键为真而不弹，
   * 表现是"点了重新引导没反应"。
   * 各步的 payload 保留（见 OnboardingRepository.reset 的注释）。
   */
  restart(): true {
    this.progress?.reset(this.now().getTime())
    this.settings?.delete(LEGACY_COMPLETED_KEY)
    this.settings?.delete(LEGACY_SKIPPED_KEY)
    return true
  }

  private settleRemaining(): void {
    const at = this.now().getTime()
    for (const row of this.steps()) {
      if (row.state === "pending") this.progress?.setStep(row.step, "skipped", at)
    }
  }

  /**
   * 未登录时静默忽略而不抛错：这些方法只可能由引导页触发，
   * 而引导页在未登录时根本不会挂载。真出现了也只是状态没记上，
   * 不值得让一次点击变成错误弹窗。
   */
  private writeLegacy(key: string): void {
    if (this.settings === null) return
    const at = this.now().toISOString()
    this.settings.set(key, at, at)
  }
}
