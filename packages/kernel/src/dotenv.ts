/**
 * 极简 .env 解析。
 *
 * 只做本仓库需要的语法（KEY=VALUE、引号、注释、空行），不引 dotenv：
 * 依赖越少，主进程启动路径越可控。解析结果由调用方交给 loadConfig()，
 * 本函数不写 process.env（避免污染全局与掩盖优先级）。
 */

export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {}

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue

    const separator = trimmed.indexOf("=")
    if (separator === -1) continue

    const key = trimmed.slice(0, separator).trim()
    if (key === "") continue

    let value = trimmed.slice(separator + 1).trim()
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)

    if (quoted) {
      value = value.slice(1, -1)
    } else {
      // 仅未加引号时剥离行尾注释：带引号的值可能合法包含 " #"。
      const comment = value.indexOf(" #")
      if (comment !== -1) value = value.slice(0, comment).trim()
    }

    result[key] = value
  }

  return result
}
