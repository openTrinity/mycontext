/**
 * `send → openTaskId → query-send-status → openMessageId` 的真进程验证。
 *
 * 判据在调用方（`check-send-linkage.mjs`）：这里只负责**如实报告**
 * 两次调用的返回，不做断言。分开是因为"发一条消息"这件事有副作用，
 * 而副作用的代码越薄越好读。
 */
import { createLogger } from "@mycontext/kernel"
import { ProcessRunner, RuntimeEnv } from "@mycontext/runtime-env"
import { DwsCli, createSendExecutor } from "@mycontext/channels"

export interface SendLinkageReport {
  send: { ok: boolean; externalId?: string; taskId?: string } | null
  status: { externalId: string; delivered: boolean } | null
}

export async function runSendLinkageCheck(options: {
  binDir: string
  /**
   * DWS 的 profile 目录 —— **必须**与应用用的那个同一个。
   *
   * 登录态存在它里面；给一个空目录会让命令以"未登录"失败，
   * 而那个失败看起来与"关联链断了"一模一样（都是发送失败）。
   */
  dwsConfigDir: string
}): Promise<SendLinkageReport> {
  const logger = createLogger("SendLinkage", { level: "error" })
  const processes = new ProcessRunner(logger)
  const runtime = new RuntimeEnv({
    binDir: options.binDir,
    dwsConfigDir: options.dwsConfigDir,
    env: process.env as Record<string, string>,
  })
  const cli = new DwsCli({ runtime, processes, logger })
  const executor = createSendExecutor(cli)

  /**
   * ★ 目标是**自己**，且带可辨识的前缀。
   *
   * `--user` 传当前登录用户的 userId —— DWS 会把它解析成 openDingTalkId
   * （debug 行可见）。不接受外部传目标：见脚本头。
   */
  const sent = await executor.send({
    target: { kind: "user", externalId: SELF_USER_ID },
    text: "【mycontext 自检】忽略这条：验证 send → query-send-status 关联链",
    mentions: [],
    idempotencyKey: `linkage-${String(Date.now())}`,
    dryRun: false,
  })

  if (!sent.ok) {
    // ★ 失败原因要打出来 —— 「发送失败」四个字无法排查
    console.error(`send 失败：code=${sent.code} detail=${sent.detail}`)
    return { send: null, status: null }
  }

  const send = {
    ok: true as const,
    ...(sent.externalId === undefined ? {} : { externalId: sent.externalId }),
    ...(sent.taskId === undefined ? {} : { taskId: sent.taskId }),
  }
  /**
   * 已经有消息 id 就不必再跳一次（哪天上游直接给了就是这条路）。
   * 只有 taskId 时才换 —— 那是现在的真实形态。
   */
  if (sent.externalId !== undefined) {
    return { send, status: { externalId: sent.externalId, delivered: true } }
  }
  if (sent.taskId === undefined) return { send, status: null }

  const status = await executor.querySendStatus(sent.taskId)
  return {
    send,
    status: status === null ? null : { externalId: status.externalId, delivered: status.delivered },
  }
}

/**
 * 当前登录用户的 userId。
 *
 * ★ 写成常量而不是参数：这个脚本**只**给自己发消息。
 * 做成参数的话它就变成一个"能给任意人发消息"的工具，而那个能力
 * 不该以一个随手可跑的脚本的形式存在于仓库里。
 *
 * 换账号时改这里 —— 改动本身就是一次显式的确认。
 *
 * 仓库里留的是占位值（真 userId 是身份信息，不入 git）：跑之前先换成
 * 自己的，或用 `MYCONTEXT_SELF_USER_ID` 覆盖。
 */
const SELF_USER_ID = process.env["MYCONTEXT_SELF_USER_ID"] ?? "100001"
