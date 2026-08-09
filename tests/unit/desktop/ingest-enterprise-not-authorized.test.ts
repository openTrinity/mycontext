/**
 * 客户端对该企业没开通能力（`ENTERPRISE_NOT_AUTHORIZED`）→ 终态，停止重试。
 *
 * ## 这一组锁的是一场**真实发生过的刷屏**
 *
 * 来源是一次真实会话的日志：8 分钟内约 50 条同一个错，三个 operation
 * 轮着报（`chat/unread_message_conversation_list`、`im/list_all_conversations`、
 * `chat/search_messages_by_time_range`），而**界面上什么都不说** ——
 * 用户只看到"没有新消息"，日志里 `blocked: null`。
 *
 * 成因是分类漏了一个码：`ENTERPRISE_NOT_AUTHORIZED` 不在 `SERVER_ERROR_CODES`
 * 里 → 落到兜底的 `PROCESS_FAILED{retryable:true}` → 每一轮都失败、
 * 每一次都判定可重试。
 *
 * 与 `classifyDwsError` 注释里记的那次 `not_authenticated` 事故**同一个形状**：
 * 分类漏一个码 → 终态被当可重试 → 无限重试 + 界面无感。所以这里锁两件事：
 * ① 置位 `blockedReason`（重试停下来）；
 * ② **不**被误判成 `session_expired`（那会让用户去反复扫码，而扫码对
 *    "客户端缺能力"永远无效）。
 *
 * ## ★ 为什么用 `classifyDwsError` 的真实产物而不是手写 AppError
 *
 * 手写等于把"分类正确"这个前提假设掉，而那恰恰是出事的地方。
 * 这里喂真实 stderr fixture 过一遍分类器，拿它的输出当输入 ——
 * 分类一旦退回去，这组测试立刻红。
 */
import { describe, expect, it } from "vitest"
import { createLogger, ManualClock } from "@mycontext/kernel"
import { classifyDwsError, type ChannelPlugin } from "@mycontext/channels"
import { IngestService } from "@main/services/ingest.service.js"
import { openTestVault } from "../../helpers/vault.js"
import { REAL_ERR_ENTERPRISE_NOT_AUTHORIZED } from "../../fixtures/dingtalk-real-payloads.js"

const START = 1_700_000_000_000
const CHANNEL = "dingtalk"

/**
 * 探针每次都抛「客户端没开通能力」。
 *
 * `probeCalls` 用来证明**重试真的停了** —— 只断言 `blockedReason` 不够：
 * 那个字段置上了但下一轮照样发命令的话，刷屏依然存在。
 */
function setup(): {
  service: IngestService
  readonly probeCalls: number
  readonly authCalls: number
  close: () => void
} {
  const vault = openTestVault()
  let probeCalls = 0
  let authCalls = 0
  const plugin = {
    meta: { id: CHANNEL },
    auth: {
      status: async () => {
        authCalls += 1
        return { state: "authorized" as const }
      },
    },
    ingest: {
      probe: async () => {
        probeCalls += 1
        /**
         * ★ 过一遍真实分类器：把「真实 stderr → AppError」这一步也纳入
         * 断言范围。手写 AppError 会把出事的那一步假设成正确的。
         */
        const classified = classifyDwsError(REAL_ERR_ENTERPRISE_NOT_AUTHORIZED)
        throw classified ?? new Error("分类器没认出这段真实输出")
      },
    },
  } as unknown as ChannelPlugin

  const service = new IngestService({
    db: vault.db,
    clock: new ManualClock(START),
    logger: createLogger("test-enterprise-not-authorized", { level: "error" }),
    plugin,
    dbPath: vault.path,
    autoStart: false,
  })
  service.start()
  return {
    service,
    get probeCalls() {
      return probeCalls
    },
    get authCalls() {
      return authCalls
    },
    close: () => vault.close(),
  }
}

describe("★★ 客户端缺能力 → 终态，不再无限重试", () => {
  it("★★ 一轮之后置位 permission_required", async () => {
    const h = setup()

    await h.service.tickProbe()

    expect(h.service.snapshot().blockedReason).toBe("permission_required")
    h.close()
  })

  /**
   * ★★ 本组最重要的一条：**后续轮次不再发命令**。
   *
   * 这才是刷屏的直接反面。只断言 `blockedReason` 会漏掉"字段置上了但
   * 照样每 10 秒跑一次"那种情况 —— 而用户感知到的正是后者。
   */
  it("★★ 置闸之后再跑三轮，探针一次都不再被调用", async () => {
    const h = setup()

    await h.service.tickProbe()
    expect(h.probeCalls).toBe(1)

    await h.service.tickProbe()
    await h.service.tickProbe()
    await h.service.tickProbe()

    // 仍然是 1 —— 闸门挡住了后面三轮
    expect(h.probeCalls).toBe(1)
    h.close()
  })

  /**
   * ★★ 不能是 `session_expired`。
   *
   * 那个终态带**自动复核 + 自动解闸**（`recheckSessionIfBlocked`）——
   * 而"客户端没开通能力"复核一万次也不会变，只会每 5 分钟白烧一个子进程；
   * 更糟的是界面会提示"重新授权"，用户扫完码问题一动不动。
   */
  it("★★ 不是 session_expired（否则会让用户反复扫码）", async () => {
    const h = setup()

    await h.service.tickProbe()

    expect(h.service.snapshot().blockedReason).not.toBe("session_expired")
    h.close()
  })

  /**
   * ★ 不该去复核 `auth status`。
   *
   * 登录态本来就是好的（`ENTERPRISE_NOT_AUTHORIZED` 是能力问题不是登录问题），
   * 去问一次只会得到"authorized"然后什么都做不了 —— 纯浪费一个子进程。
   * 这条同时反向证明了它走的**不是** `session_expired` 那条分支。
   */
  it("★ 不复核登录态（能力问题问 auth status 没有意义）", async () => {
    const h = setup()

    await h.service.tickProbe()

    expect(h.authCalls).toBe(0)
    h.close()
  })

  /**
   * ★ 失败原因要留在快照里 —— 状态页要能说出"为什么停了"。
   *
   * 置了闸却不留原因，用户看到的就是"采集停了但不知道为什么"，
   * 而那与刷屏是同一类问题的两面（一个太吵、一个太静）。
   */
  it("★ lastError 留下可读的原因", async () => {
    const h = setup()

    await h.service.tickProbe()

    const { lastError } = h.service.snapshot()
    expect(lastError).not.toBeNull()
    // 文案要指向"换客户端"，不能是"渠道命令失败（exit N）"那种无信息量的话
    expect(lastError).toContain("客户端")
    h.close()
  })
})
