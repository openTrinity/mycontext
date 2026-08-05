/**
 * IPC 调用封装。
 *
 * main 侧返回的是 Result<T>，这里统一在 react-query 边界上把 failure 转成 throw：
 * 组件里就能用 query.error / mutation.error 处理错误，不必每处手写 if (!ok)。
 *
 * 错误文案不在这里定：ApiError 只搬运 code / messageKey / 参数，
 * 翻译由 useErrorText() 在组件里做——文案取决于用户当前语言，
 * 而这是渲染层的状态，主进程不知道。
 */
import type { Result } from "@mycontext/kernel"

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    /** 用户可见文案的 i18n key（主进程给的） */
    readonly messageKey?: string,
    readonly messageParams?: Record<string, string | number>,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

/** 解包 Result：失败抛 ApiError。 */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.data
  const { code, message, retryable, messageKey, messageParams } = result.error
  throw new ApiError(code, message, retryable, messageKey, messageParams)
}
