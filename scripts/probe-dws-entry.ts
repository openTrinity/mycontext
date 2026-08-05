/**
 * 真跑一轮**授权 + 采集**，用来验证一个 DWS 二进制与本仓库的接线是否兼容。
 *
 * ## 为什么需要它（`dws --help` 对不上是不够的）
 *
 * 判定「换一个 dws 能不能用」有三个层次，只有最后一层才是结论：
 * ① 命令与 flag 存在 —— `--help` 能查，但查得到 ≠ 返回形状一样；
 * ② 响应信封是 `{success, result}` —— 变了的话 `unwrapEnvelope` 会静默
 *    返回整个根对象，下游解析器找不到业务键、**返回空数组而不报错**；
 * ③ `auth status` 的字段名（`corp_id` / `refresh_expires_at` …）——
 *    少一个，`parseAuthStatus` 就按 fail-closed 判 `unauthorized`，
 *    表现是"要求重新授权"而实际登录态好着。
 *
 * 三者都不抛异常。所以这个探针走的是与生产**完全相同**的
 * `plugin.auth.status()` 与 `plugin.ingest`，判据是**数字与字段**：
 * 解析出的身份是否完整、拉到几条消息。
 *
 * 与 check-docs 同一套做法（共享包源码、真调 CLI、消耗接口配额）。
 */
import { homedir } from "node:os"
import { join } from "node:path"
import { createDingTalkPlugin } from "@mycontext/channels"
import { loadConfig } from "@mycontext/kernel"
import { ProcessRunner, RuntimeEnv } from "@mycontext/runtime-env"

export interface DwsProbeOptions {
  /** 二进制所在目录。缺省用仓库的 resources/bin（即 `pnpm prepare:bin` 的落点）。 */
  binDir?: string | undefined
  /** 应用目录（内含 `dws/` profile）。缺省 InklingsDevelop。 */
  appDir?: string | undefined
  /** 回看多少小时的消息。 */
  hours: number
  onProgress?: ((line: string) => void) | undefined
}

export interface DwsProbeReport {
  binPath: string
  version: string
  /** auth status 解析结果：state + 解析出来的身份字段 */
  authState: string
  identity: Record<string, string> | null
  /** 探针（`chat message list-unread-conversations`）报告的未读会话数 */
  unreadConversations: number | null
  /** 一轮采集拉到的消息条数 —— ★ 信封变了的话这里是 0 而不是报错 */
  messages: number
  conversations: number
  /** 身份解析（`contact user get-self`，与 auth status 不同源） */
  resolvedSelf: string | null
  ok: boolean
  issues: string[]
}

export async function runDwsProbe(options: DwsProbeOptions): Promise<DwsProbeReport> {
  const log = options.onProgress ?? ((): void => {})
  const issues: string[] = []

  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string, context?: unknown) =>
      log(`  ⚠ ${message} ${context === undefined ? "" : JSON.stringify(context)}`),
    error: (message: string, context?: unknown) =>
      log(`  ✗ ${message} ${context === undefined ? "" : JSON.stringify(context)}`),
    child: () => logger,
  }

  const appDir =
    options.appDir !== undefined && options.appDir !== ""
      ? options.appDir
      : join(homedir(), "Library", "Application Support", "InklingsDevelop")
  const binDir =
    options.binDir !== undefined && options.binDir !== ""
      ? options.binDir
      : join(process.cwd(), "apps/desktop/resources/bin")

  /**
   * 渠道号走 `loadConfig`（与生产同一个来源），而不是自己读环境变量 ——
   * 探针的意义在于"跑的是生产那条路"，配置来源也该同源。
   *
   * 缺省是**空**（开源发布不带渠道号，见 kernel/config.ts 的注释）。
   * 空值是可用姿态：上游三处读它都是 `if v != ""` 的守卫，空/未设置
   * 同样只是不发 `x-dws-channel` 头。真被组织限定了渠道时，
   * 症状是 `CHANNEL_NOT_ALLOWED`（终态，有明确原因码），不是静默失效。
   */
  const dwsChannel = loadConfig({ env: process.env }).values.dwsChannel
  const runtime = new RuntimeEnv({
    binDir,
    dwsChannel,
    dwsConfigDir: join(appDir, "dws"),
  })
  const processes = new ProcessRunner(logger as never)
  const binary = runtime.resolve("dws")
  log(`二进制：${binary.path}`)

  // ── ① 能跑起来吗 ────────────────────────────────────────────
  const versionResult = await processes.exec({
    executable: binary.path,
    args: ["--version"],
    env: runtime.buildEnv(),
    timeoutMs: 30_000,
  })
  const version = `${versionResult.stdout}${versionResult.stderr}`.trim().split("\n")[0] ?? ""
  log(`版本：${version}`)
  if (version === "") issues.push("`--version` 没有输出 —— 二进制跑不起来或被信号杀掉")

  const plugin = createDingTalkPlugin({
    runtime,
    processes,
    logger: logger as never,
    openExternal: () => Promise.resolve(),
  })

  // ── ② auth status 的**字段**（不是 exit code）────────────────
  log("① auth status（走 parseAuthStatus，字段少一个就判 unauthorized）…")
  const status = await plugin.auth.status()
  let identity: Record<string, string> | null = null
  if (status.state === "authorized") {
    identity = {
      corpId: status.corpId,
      corpName: status.corpName,
      userId: status.userId,
      userName: status.userName,
      refreshExpiresAt: status.refreshExpiresAt,
    }
    log(
      `   ${status.state}：${status.corpName} / ${status.userName}` +
        `（refresh 还有 ${String(status.daysUntilRefreshExpiry)} 天）`,
    )
  } else {
    log(`   ${status.state} —— 未授权时后面的采集必然为空，先跑 dws auth login`)
    issues.push(`auth status 解析为 ${status.state}，不是 authorized`)
  }

  // ── ③ 探针命令（未读会话数）──────────────────────────────────
  let unreadConversations: number | null = null
  const ingest = plugin.ingest
  if (ingest === undefined) {
    issues.push("插件没有 ingest 能力 —— 接线断了")
  } else {
    log("② 探针 chat message list-unread-conversations…")
    try {
      const probe = await ingest.probe()
      unreadConversations = probe === null ? null : probe.conversations.length
      log(`   未读会话 ${String(unreadConversations ?? "n/a")}`)
      if (probe !== null && probe.conversations.length === 0) {
        issues.push(
          "探针返回 0 个会话 —— 可能真的全已读，也可能 `conversations` 键名变了（静默失效）",
        )
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      log(`   探针失败：${detail}`)
      issues.push(`probe 失败：${detail}`)
    }
  }

  /**
   * ── ④ 身份解析（`contact user get-self` + `contact user search`）───
   *
   * 与 auth status **不同源**，且形状特别刁（信封剥掉后是数组，userId 在
   * `[0].orgEmployeeModel` 里）。解析不出的后果是静默的：
   * `is_self` 恒为 null → 蒸馏守卫拒掉全部语料，而采集侧完全看不见。
   */
  let resolvedSelf: string | null = null
  const identityCap = plugin.identity
  if (identityCap === undefined) {
    issues.push("插件没有 identity 能力 —— 接线断了")
  } else if (status.state === "authorized") {
    log("③ 身份解析 contact user get-self（形状：数组 + orgEmployeeModel 嵌套）…")
    try {
      const self = await identityCap.resolveSelf()
      resolvedSelf = `${self.userId}（openIds ${String(self.openIds.length)} 个）`
      log(`   userId=${self.userId}，openIds=${String(self.openIds.length)}`)
      if (self.openIds.length === 0) {
        issues.push("身份解析出 userId 但 openIds 为空 —— is_self 会恒为 null")
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      log(`   身份解析失败：${detail}`)
      issues.push(`resolveSelf 失败：${detail}`)
    }
  }

  // ── ⑤ 真拉一轮消息（★ 信封变了这里是 0 而不是报错）────────────
  let messages = 0
  let conversations = 0
  if (ingest !== undefined && status.state === "authorized") {
    const end = Date.now()
    const start = end - options.hours * 60 * 60 * 1000
    log(`④ 采集最近 ${String(options.hours)} 小时（chat message list-all）…`)
    try {
      const page = await ingest.pull({ start, end, limit: 50 })
      messages = page.messages.length
      conversations = page.conversations.length
      log(
        `   拉到 ${String(messages)} 条 / ${String(conversations)} 个会话` +
          `（itemCount=${String(page.itemCount)} hasMore=${String(page.hasMore)}）`,
      )
      if (page.itemCount > 0 && messages === 0) {
        // ★★ 这正是曾经真实发生过的那个故障：277 页原始响应、1678 条消息、落库 0 条。
        issues.push(
          `★ 原始响应有 ${String(page.itemCount)} 项但解析出 0 条消息 —— ` +
            "响应信封或业务键变了（这是静默失效：采集器会照常记成功并前移水位）",
        )
      } else if (messages === 0) {
        issues.push("采集拉到 0 条 —— 可能是这个时间窗真的安静，扩大 --hours 复核后再下结论")
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      log(`   采集失败：${detail}`)
      issues.push(`pull 失败：${detail}`)
    }
  }

  return {
    binPath: binary.path,
    version,
    authState: status.state,
    identity,
    unreadConversations,
    messages,
    conversations,
    resolvedSelf,
    ok: issues.length === 0,
    issues,
  }
}
