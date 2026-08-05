/**
 * 应用级偏好（语言、退出确认）。
 *
 * 存 control 库的 app_settings 而不是渲染层的 localStorage：
 * 登录页就要用它（此时还没有账号、没有 vault），清浏览器缓存不该把它清掉，
 * 而且主进程将来做原生菜单时也要读同一份值。
 *
 * 值非法（手改过、旧版本写的）时回落默认：
 * 语言 → `system`（错了只是显示语言不对，不该让启动失败）；
 * 退出确认 → `false`（不该因为读值失败而"再也不问"，会让 ⌘Q 一按即退）。
 */
import { languagePreferenceSchema, type LanguagePreference } from "@mycontext/ipc-contract"
import type { SettingsRepository } from "@mycontext/store"

export const LANGUAGE_SETTING = "ui.language"
/** 用户勾了"下次不再提醒"或在设置里主动关掉退出确认。 */
export const QUIT_CONFIRM_SUPPRESSED_SETTING = "ui.quitConfirmSuppressed"

export class PreferencesService {
  constructor(
    private readonly settings: SettingsRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  language(): LanguagePreference {
    const raw = this.settings.get(LANGUAGE_SETTING)
    if (raw === null) return "system"
    const parsed = languagePreferenceSchema.safeParse(raw)
    return parsed.success ? parsed.data : "system"
  }

  setLanguage(language: LanguagePreference): true {
    const at = this.now().toISOString()
    this.settings.set(LANGUAGE_SETTING, language, at)
    return true
  }

  /**
   * 读退出确认抑制位。返回 true 表示"下次不再问、直接退出"。
   *
   * 未设置 / 值非法都回落 false。**默认要问**：错误地保留提问只是让用户
   * 多按一下 Enter，而错误地跳过会让"我不小心按了 ⌘Q"变得不可挽回。
   */
  quitConfirmSuppressed(): boolean {
    const raw = this.settings.get(QUIT_CONFIRM_SUPPRESSED_SETTING)
    return raw === "true"
  }

  setQuitConfirmSuppressed(suppressed: boolean): true {
    const at = this.now().toISOString()
    this.settings.set(QUIT_CONFIRM_SUPPRESSED_SETTING, suppressed ? "true" : "false", at)
    return true
  }
}
