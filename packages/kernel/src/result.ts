/**
 * Result 类型：跨进程边界（IPC）不抛异常，改为返回可序列化的结果。
 *
 * Error 无法结构化克隆通过 IPC，直接 throw 会在 renderer 侧丢掉 code。
 */
import { toAppError, type ErrorCode } from "./errors.js"

export interface ResultFailure {
  ok: false
  error: {
    code: ErrorCode
    message: string
    retryable: boolean
    /** 用户可见文案的 i18n key；渲染层据此翻译，而不是直接显示 message */
    messageKey?: string
    /** messageKey 的插值参数 */
    messageParams?: Record<string, string | number>
  }
}

export interface ResultSuccess<T> {
  ok: true
  data: T
}

export type Result<T> = ResultSuccess<T> | ResultFailure

export function success<T>(data: T): ResultSuccess<T> {
  return { ok: true, data }
}

export function failure(value: unknown): ResultFailure {
  const error = toAppError(value)
  return {
    ok: false,
    error: {
      code: error.code,
      // message 是中文的开发者可读信息，供日志与兜底；UI 优先用 messageKey。
      message: error.message,
      retryable: error.retryable,
      ...(error.messageKey === undefined ? {} : { messageKey: error.messageKey }),
      ...(error.messageParams === undefined ? {} : { messageParams: error.messageParams }),
    },
  }
}

/** 执行一段可能抛错的逻辑并收敛成 Result。 */
export async function attempt<T>(operation: () => Promise<T> | T): Promise<Result<T>> {
  try {
    return success(await operation())
  } catch (error) {
    return failure(error)
  }
}
