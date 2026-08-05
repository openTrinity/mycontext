/**
 * 敏感信息脱敏。
 *
 * 日志与任何跨进程返回值都必须先过这里。默认策略是「按 key 名判定」而非猜内容：
 * 内容启发式（比如像不像 token）在真实数据上误判率太高，宁可对可疑 key 一律遮蔽。
 */

const SENSITIVE_KEY = /(password|passwd|secret|token|api[-_]?key|authorization|cookie|credential)/i

/** 遮蔽字符串：保留头尾各 2 字符便于对照，中间固定长度掩码。 */
export function maskValue(value: string): string {
  if (value.length === 0) return ""
  if (value.length <= 8) return "****"
  return `${value.slice(0, 2)}****${value.slice(-2)}`
}

/**
 * 递归脱敏结构化字段。
 * - 命中敏感 key：值替换为掩码（保留「有值/无值」的信息，便于排障）
 * - 其余值原样保留（调用方有责任不把消息正文塞进日志字段）
 */
export function redact(input: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]"
  if (input === null || input === undefined) return input
  if (Array.isArray(input)) return input.map((item) => redact(item, depth + 1))
  if (typeof input === "object") {
    if (input instanceof Error) return { name: input.name, message: input.message }
    const output: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) {
        output[key] = typeof value === "string" && value.length > 0 ? maskValue(value) : "[unset]"
        continue
      }
      output[key] = redact(value, depth + 1)
    }
    return output
  }
  return input
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key)
}
