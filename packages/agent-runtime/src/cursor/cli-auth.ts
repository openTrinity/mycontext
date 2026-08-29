/**
 * 本机 `cursor-agent` CLI 登录与 `@cursor/sdk` Agent API Key 之间的桥。
 *
 * CLI 登录落在钥匙串（account=`cursor-user`，service=`cursor-access-token`），
 * 是 **access/refresh token**；SDK / `Agent.create` 只认 **User API Key**。
 * 两者不等价：access token 直接塞进 `apiKey` 会得到 `Invalid User API Key`。
 *
 * 桥接做法：用 CLI 的 access token 调 Dashboard `CreateUserApiKey` 铸造一把
 * 有过期时间的 User API Key，并写入 `~/.cursor/sdk/auth.json`（与
 * `Cursor.auth.login()` 同形），供后续解析与 SDK 回落共用。
 *
 * 解析优先级：显式配置 > 环境变量 > SDK 存储 > CLI 铸造。
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import {
  FileCredentialStore,
  getDefaultSdkAuthPath,
  type StoredSdkCredentials,
} from "@cursor/sdk"

export type CursorCliAuthStatus = {
  authenticated: boolean
  hasAccessToken: boolean
  hasRefreshToken: boolean
}

export type CursorCredentialSource =
  | "explicit"
  | "env"
  | "sdk-store"
  | "cli-login"
  | "missing"

export type EnsuredCursorCredential = {
  apiKey: string
  source: CursorCredentialSource
}

const CLI_KEYCHAIN_ACCOUNT = "cursor-user"
const CLI_ACCESS_TOKEN_SERVICE = "cursor-access-token"
const DEFAULT_BACKEND_URL = "https://api2.cursor.sh"
/** 与 SDK `DEFAULT_LOGIN_API_KEY_TTL_MS` 对齐：90 天。 */
const DEFAULT_API_KEY_TTL_MS = 90 * 24 * 60 * 60 * 1000
const MINTED_KEY_NAME = "MyContext (cursor-agent CLI)"

/** 解析 `cursor-agent status --format json` 的输出（值全当未知处理）。 */
export function parseCursorAgentStatusJson(raw: unknown): CursorCliAuthStatus {
  if (raw === null || typeof raw !== "object") {
    return { authenticated: false, hasAccessToken: false, hasRefreshToken: false }
  }
  const o = raw as Record<string, unknown>
  const authenticated = o.isAuthenticated === true || o.status === "authenticated"
  return {
    authenticated,
    hasAccessToken: o.hasAccessToken === true,
    hasRefreshToken: o.hasRefreshToken === true,
  }
}

export type ReadCliAccessToken = () => string | null

/**
 * 从本机钥匙串读 CLI access token（darwin）。
 * 其它平台 / 找不到 / 解锁失败 → null，不抛到调用方。
 */
export function readCursorCliAccessTokenFromKeychain(
  options: { home?: string; platform?: NodeJS.Platform } = {},
): string | null {
  const platform = options.platform ?? process.platform
  if (platform !== "darwin") return null
  const home = options.home ?? homedir()
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-a", CLI_KEYCHAIN_ACCOUNT, "-s", CLI_ACCESS_TOKEN_SERVICE, "-w"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: home },
        timeout: 5_000,
      },
    )
    const token = out.trim()
    return token !== "" ? token : null
  } catch {
    return null
  }
}

export type MintFromAccessToken = (accessToken: string) => Promise<{ apiKey: string }>

/**
 * 用 CLI access token 铸造 User API Key（Connect JSON）。
 */
export async function mintUserApiKeyFromAccessToken(
  accessToken: string,
  options: {
    backendUrl?: string
    name?: string
    expiresAtMs?: number
    fetchImpl?: typeof fetch
  } = {},
): Promise<{ apiKey: string }> {
  const backendUrl = (options.backendUrl ?? DEFAULT_BACKEND_URL).replace(/\/$/, "")
  const fetchImpl = options.fetchImpl ?? fetch
  const expiresAtMs = options.expiresAtMs ?? Date.now() + DEFAULT_API_KEY_TTL_MS
  const name = options.name ?? MINTED_KEY_NAME
  const url = `${backendUrl}/aiserver.v1.DashboardService/CreateUserApiKey`
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      "connect-protocol-version": "1",
    },
    body: JSON.stringify({
      name,
      expiresAt: String(Math.floor(expiresAtMs)),
    }),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`CreateUserApiKey failed: HTTP ${res.status}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new Error("CreateUserApiKey returned non-JSON")
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("CreateUserApiKey returned unexpected shape")
  }
  const apiKey = (parsed as { apiKey?: unknown; api_key?: unknown }).apiKey
  const alt = (parsed as { api_key?: unknown }).api_key
  const key = typeof apiKey === "string" ? apiKey : typeof alt === "string" ? alt : ""
  if (key.trim() === "") {
    throw new Error("CreateUserApiKey returned empty apiKey")
  }
  return { apiKey: key.trim() }
}

export interface EnsureCursorApiKeyOptions {
  /** 设置 / keychain 里已有的明文；非空则直接用。 */
  explicitKey?: string
  env?: NodeJS.ProcessEnv
  loadSdkStore?: () => Promise<{ apiKey: string } | undefined>
  saveSdkStore?: (credentials: StoredSdkCredentials) => Promise<void>
  readCliAccessToken?: ReadCliAccessToken
  mintFromAccessToken?: MintFromAccessToken
  backendUrl?: string
  nowMs?: () => number
  fetchImpl?: typeof fetch
}

function trimKey(value: string | undefined | null): string {
  return value?.trim() ?? ""
}

async function defaultLoadSdkStore(): Promise<{ apiKey: string } | undefined> {
  const store = new FileCredentialStore()
  const creds = await store.load()
  if (creds === undefined) return undefined
  if (trimKey(creds.apiKey) === "") return undefined
  if (
    creds.apiKeyExpiresAtMs !== undefined &&
    creds.apiKeyExpiresAtMs <= Date.now()
  ) {
    return undefined
  }
  return { apiKey: creds.apiKey }
}

async function defaultSaveSdkStore(credentials: StoredSdkCredentials): Promise<void> {
  const store = new FileCredentialStore()
  await store.save(credentials)
}

/**
 * 同步读 `~/.cursor/sdk/auth.json` 里未过期的 apiKey。
 * bootstrap 同步路径用；坏文件 / 过期 / 不存在 → null。
 */
export function tryReadSdkAuthApiKeySync(nowMs: () => number = Date.now): string | null {
  try {
    const raw = readFileSync(getDefaultSdkAuthPath(), "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== "object") return null
    const apiKey = (parsed as { apiKey?: unknown }).apiKey
    if (typeof apiKey !== "string" || apiKey.trim() === "") return null
    const expires = (parsed as { apiKeyExpiresAtMs?: unknown }).apiKeyExpiresAtMs
    if (typeof expires === "number" && expires <= nowMs()) return null
    return apiKey.trim()
  } catch {
    return null
  }
}

/**
 * 解析出可供 `Agent.create` 使用的 User API Key。
 * 失败不抛：返回 `source: "missing"` 与空串，由上层决定降级。
 */
export async function ensureCursorApiKey(
  options: EnsureCursorApiKeyOptions = {},
): Promise<EnsuredCursorCredential> {
  const explicit = trimKey(options.explicitKey)
  if (explicit !== "") {
    return { apiKey: explicit, source: "explicit" }
  }

  const env = options.env ?? process.env
  const fromEnv =
    trimKey(env.CURSOR_API_KEY) || trimKey(env.MYCONTEXT_CURSOR_API_KEY)
  if (fromEnv !== "") {
    return { apiKey: fromEnv, source: "env" }
  }

  const loadSdkStore = options.loadSdkStore ?? defaultLoadSdkStore
  try {
    const stored = await loadSdkStore()
    if (stored !== undefined && trimKey(stored.apiKey) !== "") {
      return { apiKey: trimKey(stored.apiKey), source: "sdk-store" }
    }
  } catch {
    // store 坏了当没有
  }

  const readCli = options.readCliAccessToken ?? readCursorCliAccessTokenFromKeychain
  const accessToken = trimKey(readCli())
  if (accessToken === "") {
    return { apiKey: "", source: "missing" }
  }

  const nowMs = options.nowMs ?? Date.now
  const expiresAtMs = nowMs() + DEFAULT_API_KEY_TTL_MS
  const backendUrl = options.backendUrl ?? DEFAULT_BACKEND_URL
  const mint =
    options.mintFromAccessToken ??
    ((token: string) =>
      options.fetchImpl !== undefined
        ? mintUserApiKeyFromAccessToken(token, {
            backendUrl,
            expiresAtMs,
            fetchImpl: options.fetchImpl,
          })
        : mintUserApiKeyFromAccessToken(token, { backendUrl, expiresAtMs }))

  try {
    const { apiKey } = await mint(accessToken)
    const key = trimKey(apiKey)
    if (key === "") return { apiKey: "", source: "missing" }

    const saveSdkStore = options.saveSdkStore ?? defaultSaveSdkStore
    try {
      await saveSdkStore({
        version: 1,
        backendUrl,
        apiKey: key,
        apiKeyExpiresAtMs: expiresAtMs,
        createdAtMs: nowMs(),
      })
    } catch {
      // 持久化失败仍返回内存 key —— 本进程还能用
    }
    return { apiKey: key, source: "cli-login" }
  } catch {
    return { apiKey: "", source: "missing" }
  }
}
