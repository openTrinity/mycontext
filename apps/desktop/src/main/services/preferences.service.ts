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
/**
 * 工作层抽取（LLM 抽职责/流程/经验 → skill 包里的 `work.md`）。
 *
 * ★ 与上面两个不同：这一位**控制的是花钱**。所以它的默认必须是关,
 * 而且"读不出来"也必须落到关 —— 见 `workLayerEnabled()`。
 */
export const WORK_LAYER_SETTING = "distill.workLayerEnabled"

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

  /**
   * 工作层抽取开着吗。**未设置 / 值非法都回落 false（关）。**
   *
   * ## ★ 为什么"读不出来"必须落到关
   *
   * 这一位与语言、退出确认不同类:它开着的时候每轮蒸馏会发起几万 token 的
   * 模型调用。一个读值失败就自动开始花钱的开关是不可接受的 —— 而且那笔钱
   * 是静默花掉的（蒸馏在后台跑,界面上只有一行"正在蒸馏"）。
   *
   * 所以这里刻意**不**用 `raw !== "false"` 这种写法:那会让任何脏值
   * （空串、旧版本写的 "1"、手改坏的 JSON）都变成"开"。只认字面的 "true"。
   */
  workLayerEnabled(): boolean {
    return this.settings.get(WORK_LAYER_SETTING) === "true"
  }

  setWorkLayerEnabled(enabled: boolean): true {
    const at = this.now().toISOString()
    this.settings.set(WORK_LAYER_SETTING, enabled ? "true" : "false", at)
    return true
  }
}
