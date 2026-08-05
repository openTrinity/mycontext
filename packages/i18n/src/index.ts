/**
 * i18n 装配。
 *
 * 只在渲染层使用：主进程目前没有需要翻译的界面（无原生菜单/托盘），
 * 它流向 UI 的文案一律传 i18n key（见 ChannelSummary、AppError.messageKey），
 * 由这里翻译。这样「用户当前是什么语言」只有渲染层需要知道一次。
 *
 * 语言包静态 import 打进产物，配合 `initAsync: false` 在首帧前同步注册完成。
 * 若改成异步加载，React 会先渲染出翻译 key 再闪成文案。
 */
import i18next, { type i18n as I18nInstance } from "i18next"
import { initReactI18next } from "react-i18next"
import { LANGUAGES, type Language, type LanguagePreference } from "@mycontext/ipc-contract"

// 副作用导入：把 CustomTypeOptions 的模块增强带给所有引用本包的地方，
// 这样 t() 的 key 补全与拼写检查在 app 里也生效，不需要各自再 import 一次。
import "./types.js"

import zhCommon from "./locales/zh/common.json" with { type: "json" }
import zhAuth from "./locales/zh/auth.json" with { type: "json" }
import zhChannels from "./locales/zh/channels.json" with { type: "json" }
import zhOnboarding from "./locales/zh/onboarding.json" with { type: "json" }
import zhSettings from "./locales/zh/settings.json" with { type: "json" }
import zhErrors from "./locales/zh/errors.json" with { type: "json" }
import zhSearch from "./locales/zh/search.json" with { type: "json" }
import zhPersona from "./locales/zh/persona.json" with { type: "json" }
import zhGraph from "./locales/zh/graph.json" with { type: "json" }
import enCommon from "./locales/en/common.json" with { type: "json" }
import enAuth from "./locales/en/auth.json" with { type: "json" }
import enChannels from "./locales/en/channels.json" with { type: "json" }
import enOnboarding from "./locales/en/onboarding.json" with { type: "json" }
import enSettings from "./locales/en/settings.json" with { type: "json" }
import enErrors from "./locales/en/errors.json" with { type: "json" }
import enSearch from "./locales/en/search.json" with { type: "json" }
import enPersona from "./locales/en/persona.json" with { type: "json" }
import enGraph from "./locales/en/graph.json" with { type: "json" }

export const NAMESPACES = [
  "common",
  "auth",
  "channels",
  "onboarding",
  "settings",
  "errors",
  "search",
  "persona",
  "graph",
] as const

export type Namespace = (typeof NAMESPACES)[number]

export const resources = {
  zh: {
    common: zhCommon,
    auth: zhAuth,
    channels: zhChannels,
    onboarding: zhOnboarding,
    settings: zhSettings,
    errors: zhErrors,
    search: zhSearch,
    persona: zhPersona,
    graph: zhGraph,
  },
  en: {
    common: enCommon,
    auth: enAuth,
    channels: enChannels,
    onboarding: enOnboarding,
    settings: enSettings,
    errors: enErrors,
    search: enSearch,
    persona: enPersona,
    graph: enGraph,
  },
} as const

/** 语言的自称：语言选择器里每一项都用它自己的语言显示，而不是当前界面语言。 */
export const languageNames: Record<Language, string> = {
  zh: "中文",
  en: "English",
}

export { LANGUAGES }
export type { Language, LanguagePreference }

/**
 * 把系统语言映射到支持的语言。
 *
 * 只看前缀：`zh-CN` / `zh-TW` / `zh-Hant` 都归到 zh。
 * 本期不区分简繁——给繁体用户看简体，比给他们看英文更接近他们想要的。
 */
export function detectSystemLanguage(locale?: string): Language {
  const tag = (locale ?? (typeof navigator === "undefined" ? "" : navigator.language)).toLowerCase()
  return tag.startsWith("zh") ? "zh" : "en"
}

/** 把偏好（可能是 `system`）解析成一个确定的语言。 */
export function resolveLanguage(preference: LanguagePreference, locale?: string): Language {
  return preference === "system" ? detectSystemLanguage(locale) : preference
}

/**
 * 兜底语言选 zh 而不是 en。
 *
 * 现有文案都是中文先写的，zh 是最完整的那份；en 万一漏了一个 key，
 * 回落到中文至少还能读，回落到 key 名（i18next 的默认行为）则是彻底坏掉。
 */
const FALLBACK: Language = "zh"

export function createI18n(preference: LanguagePreference = "system"): I18nInstance {
  const instance = i18next.createInstance()
  void instance.use(initReactI18next).init({
    // 同步初始化：语言包已在产物里，没有异步加载，首帧就能拿到文案。
    // 若走默认的异步装载，React 会先渲染出翻译 key 再闪成文案。
    // （i18next 26 把这个开关从 initImmediate 改名为反义的 initAsync。）
    initAsync: false,
    resources,
    lng: resolveLanguage(preference),
    fallbackLng: FALLBACK,
    defaultNS: "common",
    ns: [...NAMESPACES],
    interpolation: {
      // React 自己会转义，i18next 再转一次会把中文引号之类的东西变成实体。
      escapeValue: false,
    },
  })
  return instance
}

/**
 * 动态 key 的翻译函数。
 *
 * `t()` 的 key 是字面量联合类型，这正是我们想要的（拼错就编译不过）。
 * 但有一类 key 天生是运行时字符串：主进程通过 IPC 传来的 `labelKey`、
 * 以及 `Record<状态, key>` 这类映射表。它们没法在编译期收窄成字面量。
 *
 * 与其在几十个调用点各写一次断言，不如在这里收口成一个显式命名的类型：
 * 名字里带 Dynamic，读代码时就知道「这个 key 的正确性由别处保证」——
 * 对 IPC 传来的 key，由 i18n.test.ts 的 key 集合一致性检查保证；
 * 对映射表，由 Record 的键必须覆盖所有枚举值保证。
 */
export type TranslateDynamic = (key: string, params?: Record<string, unknown>) => string
