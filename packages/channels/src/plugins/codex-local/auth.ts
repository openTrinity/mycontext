/**
 * 本地编码助手记录的授权。
 *
 * 这里的“授权”不是 OAuth：记录已经在本机磁盘上。它只负责保存一份按 vault
 * 隔离的显式同意标记，避免应用一发现目录就自动读取用户历史。
 */
import { constants } from "node:fs"
import { access, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AppError } from "@mycontext/kernel"
import type { AuthContext, AuthStatus, ChannelAuth } from "../../types.js"

const CONSENT_FILE = "enabled.json"
const LOCAL_CORP_ID = "local-machine"
const LOCAL_USER_ID = "local-user"

export interface CodexLocalAuthOptions {
  /** 外部记录根目录。通常是 `$CODEX_HOME`，未设置时由宿主传默认目录。 */
  recordsRoot: () => string
  /** 当前 vault 内的授权标记目录；未登录时为空串。 */
  consentRoot: () => string
}

function markerPath(options: CodexLocalAuthOptions): string | null {
  const root = options.consentRoot().trim()
  return root === "" ? null : join(root, CONSENT_FILE)
}

async function readable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

function authorizedStatus(): Extract<AuthStatus, { state: "authorized" }> {
  return {
    state: "authorized",
    corpId: LOCAL_CORP_ID,
    corpName: "本机",
    userId: LOCAL_USER_ID,
    userName: "本机用户",
    accessExpiresAt: null,
    refreshExpiresAt: null,
    daysUntilRefreshExpiry: null,
  }
}

export class CodexLocalAuth implements ChannelAuth {
  constructor(private readonly options: CodexLocalAuthOptions) {}

  supportedModes() {
    return ["loopback" as const]
  }

  describeStepKeys(): string[] {
    return ["channels:codex.steps.review", "channels:codex.steps.enable"]
  }

  async status(): Promise<AuthStatus> {
    const marker = markerPath(this.options)
    if (marker === null || !(await readable(marker))) return { state: "unauthorized" }
    if (!(await readable(this.options.recordsRoot()))) {
      return {
        state: "expired",
        corpName: "本机",
        userName: "本机用户",
      }
    }
    return authorizedStatus()
  }

  async login(ctx: AuthContext): Promise<AuthStatus> {
    ctx.signal.throwIfAborted()
    ctx.onProgress({ phase: "starting" })

    const recordsRoot = this.options.recordsRoot()
    if (!(await readable(recordsRoot))) {
      throw new AppError("CHANNEL_LOCAL_RECORDS_UNAVAILABLE", "找不到可读的本地记录目录", {
        retryable: false,
        messageKey: "errors:channel.localRecordsUnavailable",
      })
    }

    const marker = markerPath(this.options)
    if (marker === null) {
      throw new AppError("CHANNEL_NOT_READY", "请先登录 MyContext 再连接本地记录", {
        retryable: false,
        messageKey: "errors:channel.localRecordsNeedLogin",
      })
    }

    ctx.signal.throwIfAborted()
    await mkdir(this.options.consentRoot(), { recursive: true })
    await writeFile(marker, `${JSON.stringify({ version: 1 })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
    const status = authorizedStatus()
    ctx.onProgress({ phase: "succeeded", status })
    return status
  }

  async logout(): Promise<boolean> {
    const marker = markerPath(this.options)
    if (marker === null) return false
    const existed = await readable(marker)
    await rm(marker, { force: true })
    return existed
  }
}

export const CODEX_LOCAL_IDENTITY = {
  userId: LOCAL_USER_ID,
  openIds: [{ kind: "local_user", value: LOCAL_USER_ID }],
  displayNames: ["本机用户"],
  corpId: LOCAL_CORP_ID,
  corpName: "本机",
  source: "get-self" as const,
}
