/**
 * `dws auth status -f json` 的输出解析。
 *
 * 独立成纯函数（不碰子进程）以便单测覆盖各种返回形态。
 *
 * 容错策略：**不信任 exit code 也不信任字段齐全**。
 * 已实测的成功形态是 exit 0 + authenticated:true + 完整字段；
 * 未授权/异常形态无法实测（跑 `auth logout` 会清掉用户终端的真实登录态），
 * 因此这里把「非成功」的各种可能都归到 unauthorized / expired，
 * 任何解析不出来的情况一律按 unauthorized 处理——
 * 宁可多问一次授权，也不能把未授权误判成已授权（那会让后续采集全部失败且难排查）。
 */
import type { AuthStatus } from "../../types.js"

/** DWS auth status 的已知字段（全部按可选处理，避免版本差异导致解析崩） */
interface DwsAuthStatusPayload {
  success?: unknown
  authenticated?: unknown
  token_valid?: unknown
  refresh_token_valid?: unknown
  expires_at?: unknown
  refresh_expires_at?: unknown
  corp_id?: unknown
  corp_name?: unknown
  user_id?: unknown
  user_name?: unknown
  error?: unknown
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

/**
 * 从可能混有日志行的输出里提取 JSON。
 * DWS 在某些子命令下会先打人类可读的横幅再打 JSON，因此不能直接 JSON.parse 整段。
 */
export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === "") return undefined

  // 优先整体解析（正常情况）
  try {
    return JSON.parse(trimmed)
  } catch {
    // 退回到「找第一个 { 到最后一个 }」
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start === -1 || end <= start) return undefined
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}

export function daysUntil(iso: string, now: Date): number {
  const target = Date.parse(iso)
  if (Number.isNaN(target)) return 0
  return Math.floor((target - now.getTime()) / MS_PER_DAY)
}

/**
 * 解析 auth status 输出为 AuthStatus。
 *
 * @param stdout 命令的标准输出（允许混有日志行）
 * @param now 便于测试注入
 */
export function parseAuthStatus(stdout: string, now: Date = new Date()): AuthStatus {
  const parsed = extractJsonObject(stdout)
  if (parsed === undefined || typeof parsed !== "object" || parsed === null) {
    return { state: "unauthorized" }
  }

  const payload = parsed as DwsAuthStatusPayload

  // 明确的错误返回（exit code 可能是 0，所以必须看 body）
  if (payload.error !== undefined && payload.error !== null) {
    return { state: "unauthorized" }
  }

  const corpName = asString(payload.corp_name)
  const userName = asString(payload.user_name)
  const refreshExpiresAt = asString(payload.refresh_expires_at)

  if (payload.authenticated !== true) {
    // 有身份痕迹说明登录过，只是失效了 —— 这种情况提示「重新授权」比「去授权」更准确。
    if (corpName !== undefined || userName !== undefined) {
      return {
        state: "expired",
        ...(corpName === undefined ? {} : { corpName }),
        ...(userName === undefined ? {} : { userName }),
      }
    }
    return { state: "unauthorized" }
  }

  // refresh token 失效等同于要重新扫码，即使 authenticated 仍为 true。
  const refreshExpired =
    payload.refresh_token_valid === false ||
    (refreshExpiresAt !== undefined && Date.parse(refreshExpiresAt) <= now.getTime())
  if (refreshExpired) {
    return {
      state: "expired",
      ...(corpName === undefined ? {} : { corpName }),
      ...(userName === undefined ? {} : { userName }),
    }
  }

  const corpId = asString(payload.corp_id)
  const userId = asString(payload.user_id)
  const accessExpiresAt = asString(payload.expires_at)

  // 已授权但关键字段缺失：不敢当作可用（后续采集会以 corpId/userId 为准）。
  if (
    corpId === undefined ||
    corpName === undefined ||
    userId === undefined ||
    userName === undefined ||
    refreshExpiresAt === undefined
  ) {
    return { state: "unauthorized" }
  }

  return {
    state: "authorized",
    corpId,
    corpName,
    userId,
    userName,
    accessExpiresAt: accessExpiresAt ?? refreshExpiresAt,
    refreshExpiresAt,
    daysUntilRefreshExpiry: daysUntil(refreshExpiresAt, now),
  }
}

// ---------------------------------------------------------------
// 登录输出解析
// ---------------------------------------------------------------

/**
 * loopback 流程里的授权 URL。
 * 实测输出形如：`  https://login.dingtalk.com/oauth2/auth?client_id=...&redirect_uri=...`
 */
export function extractAuthUrl(line: string): string | undefined {
  const match = /https:\/\/login\.dingtalk\.com\/oauth2\/auth\?\S+/.exec(line)
  return match?.[0]
}

/**
 * PAT 推荐权限的确认页。
 *
 * DWS 的 table 输出形如：
 * `授权链接: https://open-dev.dingtalk.com/...#/personalAuthorization?...`
 * 旧版也可能把 hash route URL 编码成 `%2FpersonalAuthorization`。
 */
export function extractPatAuthorizationUrl(line: string): string | undefined {
  const cleanLine = line
    .split(String.fromCharCode(27))
    .map((part, index) => (index === 0 ? part : part.replace(/^\[[0-9;]*m/, "")))
    .join("")
  const urls = cleanLine.match(/https:\/\/[^\s│|]+/g)
  if (urls === null) return undefined
  for (const raw of urls) {
    const url = raw.replace(/["'}\]),.]+$/, "")
    const normalized = url.toLowerCase()
    if (
      normalized.includes("personalauthorization") ||
      normalized.includes("%2fpersonalauthorization")
    ) {
      return url
    }
  }
  return undefined
}

/**
 * device 流程里的授权码与验证页。
 * 实测输出形如：`│    授权码: GFZP-MCVP` 与
 * `https://login.dingtalk.com/oauth2/device/verify.htm?user_code=GFZP-MCVP`
 */
export function extractDeviceCode(line: string): string | undefined {
  // 授权码是 4-4 大写字母数字；限定格式避免把别的内容误当成码。
  const withLabel = /授权码[:：]\s*([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(line)
  if (withLabel?.[1] !== undefined) return withLabel[1]
  const fromUrl = /user_code=([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(line)
  return fromUrl?.[1]
}

export function extractDeviceVerifyUrl(line: string): string | undefined {
  const match = /https:\/\/login\.dingtalk\.com\/oauth2\/device\/verify\.htm\S*/.exec(line)
  if (match?.[0] === undefined) return undefined
  // 去掉可能被表格边框粘上的尾字符
  return match[0].replace(/[│|\s]+$/, "")
}

/** device 授权码有效期，实测输出形如「授权码将在 900 秒后过期。」 */
export function extractDeviceExpiry(line: string): number | undefined {
  const match = /授权码将在\s*(\d+)\s*秒后过期/.exec(line)
  if (match?.[1] === undefined) return undefined
  return Number.parseInt(match[1], 10)
}
