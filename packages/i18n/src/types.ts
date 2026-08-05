/**
 * i18next 的类型增强。
 *
 * 从 zh 的语言包反推 key 的类型，因此 `t("auth:login.title")` 有补全，
 * 而拼错 key 是**编译错误**而不是界面上显示一串原样的 key。
 *
 * 以 zh 为准（而不是 en）：它是先写的那份，也是 fallbackLng。
 * en 缺 key 会被 i18n.test.ts 的「两语 key 集合必须一致」拦住，
 * 不需要在类型层再管一次。
 */
import "i18next"

import type zhCommon from "./locales/zh/common.json"
import type zhAuth from "./locales/zh/auth.json"
import type zhChannels from "./locales/zh/channels.json"
import type zhOnboarding from "./locales/zh/onboarding.json"
import type zhSettings from "./locales/zh/settings.json"
import type zhErrors from "./locales/zh/errors.json"
import type zhSearch from "./locales/zh/search.json"
import type zhPersona from "./locales/zh/persona.json"
import type zhGraph from "./locales/zh/graph.json"

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common"
    resources: {
      common: typeof zhCommon
      auth: typeof zhAuth
      channels: typeof zhChannels
      onboarding: typeof zhOnboarding
      settings: typeof zhSettings
      errors: typeof zhErrors
      search: typeof zhSearch
      persona: typeof zhPersona
      graph: typeof zhGraph
    }
  }
}
