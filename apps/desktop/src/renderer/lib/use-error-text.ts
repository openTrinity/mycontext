/**
 * 错误文案：把任意 throw 出来的东西翻成一句用户能看懂的话。
 *
 * 三层兜底，顺序刻意如此：
 *   1. messageKey（主进程明确指定的文案，可带插值参数）
 *   2. errors:byCode.<CODE>（按错误码的通用说法）
 *   3. error.message（开发者可读的中文原文）
 *
 * 有第 2 层是因为新增错误码时很容易忘了配 messageKey；
 * 有第 3 层是因为宁可显示一句中文，也不能显示空白或一串 key。
 */
import { useTranslation } from "react-i18next"
import { ApiError } from "./api.js"
import { useDynamicTranslation } from "./use-dynamic-translation.js"

export function useErrorText(): (error: unknown) => string {
  // messageKey 来自主进程，是运行时字符串，走 dynamic 版本。
  const { t } = useDynamicTranslation("errors")
  const { i18n } = useTranslation()

  return (error: unknown): string => {
    if (error instanceof ApiError) {
      if (error.messageKey !== undefined && i18n.exists(error.messageKey)) {
        return t(error.messageKey, error.messageParams)
      }
      const byCode = `byCode.${error.code}`
      if (i18n.exists(`errors:${byCode}`)) return t(byCode)
      return error.message
    }
    if (error instanceof Error) return error.message
    return String(error)
  }
}
