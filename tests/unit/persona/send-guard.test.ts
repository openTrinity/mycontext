/**
 * SendGuard 的四层防线。
 *
 * ★ 最高优先级的断言：**即使 policy 全通过，测试环境下也 0 次真实发送。**
 *   来源应用的 help 明确警告 `send` 会真实发送且不可用于测试 ——
 *   而这不该靠"记得别在测试里发"，而是代码层面不可能发。
 *
 * 四层的失效原因互不相关（这才是"纵深"）：
 * ① 应用层短路（我们的逻辑错）
 * ② draftId 重读比对（DB 被改）
 * ③ CLI 参数（拼装错 / 外部行为变了）
 * ④ 宿主授权门（不在我们控制范围内）
 */
import { describe, expect, it, vi } from "vitest"
import { createLogger, ManualClock } from "@mycontext/kernel"
import {
  assertMentionPlaceholders,
  contentHash,
  SendGuard,
  type SendExecutor,
  type SendInput,
  type SendTarget,
} from "@mycontext/persona"

const NOW = 1_785_000_000_000

function setup(
  options: {
    draft?: { text: string; editedText: string | null } | null
    grant?: { id: string; expiresAt: number | null } | null
    executorResult?: { ok: true; externalId?: string } | { ok: false; code: string; detail: string }
    forceShortCircuit?: boolean
    /**
     * 授权被**明确拒绝**（撤销 / 过期）。
     *
     * ★ 与 `grant: null`（从没授权过）是两回事：后者现在照常发
     * （那道授权在真实环境上拿不到），前者必须拦。
     */
    denied?: boolean
    /**
     * 全局停摆（急停）开着。
     *
     * ★ 这是**所有**发送路径的总闸，包括 `yolo` 那一档与用户手点草稿箱
     * （那两条都不过 policy 的 `kill_switch_inactive`）。
     */
    killSwitchActive?: boolean
  } = {},
) {
  // 显式声明入参类型：vi.fn(() => …) 会把 mock.calls 推成空元组，
  // 于是 `calls[0]?.[0]` 变成类型错误（而我们要断言的正是传给执行器的那个 spec）。
  const send = vi.fn((_spec: Parameters<SendExecutor["send"]>[0]) =>
    Promise.resolve(options.executorResult ?? ({ ok: true, externalId: "sent-1" } as const)),
  )
  const revoked: string[] = []
  const verified: string[] = []
  const downgraded: { conversationId: string; reason: string }[] = []

  const guard = new SendGuard({
    drafts: {
      get: () =>
        options.draft === undefined
          ? { text: "沙箱环境部署完成了", editedText: null }
          : options.draft,
    },
    grants: {
      requireValid: () =>
        options.grant === undefined
          ? { id: "grant-1", expiresAt: NOW + 86_400_000 }
          : options.grant,
      /**
       * ★ 默认 false（"没有理由拦"）。
       *
       * 这个桩要能表达三种状态而不是两种：有效授权 / 从没授权过 / 被拒。
       * 第二与第三种在 `requireValid` 里都是 null，但处置**相反**
       * （前者照常发、后者拦住）—— 所以用例要能单独设 `denied`。
       */
      isDenied: () => options.denied ?? false,
      markRevoked: (id) => void revoked.push(id),
      touchVerified: (id) => void verified.push(id),
    },
    executor: { send },
    clock: new ManualClock(NOW),
    logger: createLogger("test", { level: "error" }),
    downgradeToDraft: (conversationId, reason) => void downgraded.push({ conversationId, reason }),
    // 默认关掉强制短路，好让后面的层能被测到；短路层单独测。
    forceShortCircuit: options.forceShortCircuit ?? false,
    killSwitchActive: () => options.killSwitchActive ?? false,
  })

  return { guard, send, revoked, verified, downgraded }
}

const target: SendTarget = { kind: "group", externalId: "cid-1" }

function input(overrides: Partial<SendInput> = {}): SendInput {
  return {
    draftId: "draft-1",
    conversationId: "conv-1",
    target,
    mentions: [],
    idempotencyKey: "uuid-1",
    dryRun: false,
    ...overrides,
  }
}

describe("★ 第 ① 层：应用层强制短路（绝不真发）", () => {
  it("dryRun=true 时 executor 0 次被调用", async () => {
    const context = setup()
    const outcome = await context.guard.send(input({ dryRun: true }))
    expect(outcome.state).toBe("short_circuited")
    expect(context.send).toHaveBeenCalledTimes(0)
  })

  /**
   * ★ 这是需求里最高优先级的那条：即使 policy 全通过、授权有效、
   * 草稿也对得上，测试环境下依然 0 次真实发送。
   */
  it("forceShortCircuit=true 时即使一切就绪也 0 次调用", async () => {
    const context = setup({ forceShortCircuit: true })
    const outcome = await context.guard.send(input())
    expect(outcome.state).toBe("short_circuited")
    expect(outcome.reason).toBe("test_env")
    expect(context.send).toHaveBeenCalledTimes(0)
  })

  it("短路优先于所有其它检查（草稿不存在也不会走到那一步）", async () => {
    const context = setup({ forceShortCircuit: true, draft: null })
    // 若短路不是第一层，这里会返回 draft_not_found
    expect((await context.guard.send(input())).state).toBe("short_circuited")
  })
})

describe("★ 第 ② 层：发的必须是被批准的那条", () => {
  it("草稿不存在 → 拒发", async () => {
    const context = setup({ draft: null })
    const outcome = await context.guard.send(input())
    expect(outcome).toEqual({ state: "blocked", reason: "draft_not_found" })
    expect(context.send).toHaveBeenCalledTimes(0)
  })

  it("发的是**库里那条**（用户编辑过的版本优先）", async () => {
    const context = setup({ draft: { text: "原始草稿", editedText: "用户改过的" } })
    await context.guard.send(input())
    expect(context.send.mock.calls[0]?.[0]).toMatchObject({ text: "用户改过的" })
  })

  it("空正文拒发（不发一条空消息出去）", async () => {
    const context = setup({ draft: { text: "   ", editedText: null } })
    expect((await context.guard.send(input())).state).toBe("blocked")
    expect(context.send).toHaveBeenCalledTimes(0)
  })

  /**
   * 这一层挡的是「policy 批准了 A，实际发出去 B」——
   * 比如内存里的 draft 被后续 turn 覆盖、或 UI 编辑与发送之间有竞态。
   * 失效原因（DB 被改）与第 ① 层（我们的逻辑错）完全无关，所以是独立的一层。
   */
  it("内存里的文本不作为发送依据（每次都重读库）", async () => {
    const context = setup({ draft: { text: "库里的内容", editedText: null } })
    await context.guard.send(input())
    // 入参里没有 text 字段 —— 想传也传不进来
    expect(context.send.mock.calls[0]?.[0]).toMatchObject({ text: "库里的内容" })
  })
})

describe("@ 占位符一致性（缺失时 @ 不生效但命令成功 = 静默失败）", () => {
  it("正文含占位符 → 通过", () => {
    expect(() => assertMentionPlaceholders("<@DeA> 看一下", ["DeA"])).not.toThrow()
  })

  it("正文缺占位符 → 抛错并列出缺哪些", () => {
    expect(() => assertMentionPlaceholders("看一下", ["DeA", "DeB"])).toThrow(/DeA, DeB/)
  })

  it("SendGuard 里占位符不一致直接拒发", async () => {
    const context = setup({ draft: { text: "没有占位符", editedText: null } })
    const outcome = await context.guard.send(input({ mentions: ["DeA"] }))
    expect(outcome.state).toBe("blocked")
    expect(context.send).toHaveBeenCalledTimes(0)
  })

  it("占位符齐全时正常发送", async () => {
    const context = setup({ draft: { text: "<@DeA> 收到", editedText: null } })
    expect((await context.guard.send(input({ mentions: ["DeA"] }))).state).toBe("sent")
  })
})

describe("★ 第 ③ 层：CLI 参数（--uuid 是服务端幂等）", () => {
  it("idempotencyKey 原样传给执行器", async () => {
    const context = setup()
    await context.guard.send(input({ idempotencyKey: "stable-uuid-42" }))
    expect(context.send.mock.calls[0]?.[0]).toMatchObject({ idempotencyKey: "stable-uuid-42" })
  })

  it("真实发送时 dryRun 传 false（短路层已经处理了 dry-run）", async () => {
    const context = setup()
    await context.guard.send(input())
    expect(context.send.mock.calls[0]?.[0]).toMatchObject({ dryRun: false })
  })

  it("target 原样传（三选一由类型保证，不会「都没传」）", async () => {
    const context = setup()
    await context.guard.send(input({ target: { kind: "user", externalId: "DeX" } }))
    expect(context.send.mock.calls[0]?.[0]).toMatchObject({
      target: { kind: "user", externalId: "DeX" },
    })
  })
})

describe("★ 第 ④ 层：授权门", () => {
  /**
   * ★ 「没有授权记录」**不再**阻塞发送 —— 一次刻意的放宽。
   *
   * 原来这里断言的是"没授权就不调命令"。实测那个前提错了：
   * `chat chmod chat.message:send` 在真实环境上授不下来（服务端
   * `scope未配置授权规则`，`chat.group:destroy` 同样），而
   * `chat message send --dry-run` 干净通过、没有权限抱怨。
   *
   * 硬性要求一个拿不到的东西 = 把功能永久焊死。
   * "渠道允不允许发"改由**真发一次的返回**回答（见下面那条）。
   */
  it("没有授权记录时照样发（那道授权在真实环境上拿不到）", async () => {
    const context = setup({ grant: null })
    const outcome = await context.guard.send(input())
    expect(outcome.state).toBe("sent")
    expect(context.send).toHaveBeenCalledTimes(1)
  })

  it("没有授权记录时不去 touchVerified（没有记录可 touch）", async () => {
    const context = setup({ grant: null })
    await context.guard.send(input())
    expect(context.verified).toEqual([])
  })

  /**
   * ★ 被**拒**（撤销/过期）仍然拦住 —— 这是放宽之后最容易一起漏掉的一条。
   *
   * 「从没授权过」与「被撤销」在 `requireValid` 里都是 null，
   * 但处置**相反**：前者照常发（那道授权拿不到），后者必须拦
   * （渠道明确说过不行，白调一次没有意义，而且可能在宿主侧再弹一次窗）。
   *
   * 把两者塞进同一个判断的话，放宽前者就等于把后者也放开了。
   */
  it("授权被撤销/过期 → 拦住，一次命令都不调", async () => {
    const context = setup({ grant: null, denied: true })
    const outcome = await context.guard.send(input())
    expect(outcome).toEqual({ state: "blocked_no_grant", reason: "grant_denied" })
    expect(context.send).toHaveBeenCalledTimes(0)
  })

  it("发送成功时刷新 last_verified（这是「授权确实有效」的唯一证据）", async () => {
    const context = setup()
    await context.guard.send(input())
    expect(context.verified).toEqual(["grant-1"])
  })

  /**
   * ★ `expires_at` 是本地推算值，宿主侧手动撤销我们感知不到 ——
   * 所以正确性只来自"真发一次看返回什么"。
   *
   * 三件事必须同时发生：标撤销 + 立即降级 + **不重试**。
   * 重试对授权问题永远没用，只会反复弹窗骚扰用户。
   */
  it("权限错误 → 标撤销 + 降级为草稿 + 不重试", async () => {
    const context = setup({
      executorResult: { ok: false, code: "PERMISSION_REQUIRED", detail: "not authorized" },
    })
    const outcome = await context.guard.send(input())

    expect(outcome).toEqual({ state: "blocked_no_grant", reason: "permission_denied" })
    expect(context.revoked).toEqual(["grant-1"])
    expect(context.downgraded).toEqual([{ conversationId: "conv-1", reason: "permission_denied" }])
    // ★ 只调用了一次 —— 没有重试
    expect(context.send).toHaveBeenCalledTimes(1)
  })

  it("GRANT_REVOKED 走同一条路径", async () => {
    const context = setup({
      executorResult: { ok: false, code: "GRANT_REVOKED", detail: "revoked by user" },
    })
    await context.guard.send(input())
    expect(context.revoked).toEqual(["grant-1"])
  })

  it("网络类错误不标撤销（那是可重试的，不是授权问题）", async () => {
    const context = setup({
      executorResult: { ok: false, code: "PROCESS_FAILED", detail: "connection reset" },
    })
    const outcome = await context.guard.send(input())
    expect(outcome.state).toBe("failed")
    expect(context.revoked).toEqual([])
    expect(context.downgraded).toEqual([])
  })
})

describe("成功路径", () => {
  it("返回平台的消息 id（供后续关联与撤回）", async () => {
    const context = setup({ executorResult: { ok: true, externalId: "msg-remote-1" } })
    const outcome = await context.guard.send(input())
    expect(outcome).toEqual({ state: "sent", sentExternalId: "msg-remote-1" })
  })
})

describe("内容 hash", () => {
  it("同内容同 hash、不同内容不同 hash", () => {
    expect(contentHash("abc")).toBe(contentHash("abc"))
    expect(contentHash("abc")).not.toBe(contentHash("abd"))
  })

  it("hash 是 64 位十六进制（sha256）", () => {
    expect(contentHash("x")).toMatch(/^[0-9a-f]{64}$/)
  })
})

/**
 * ★★ 急停（kill switch）是**所有**发送路径的总闸。
 *
 * ## 为什么这一组必须存在
 *
 * UI 上那个按钮写着「立刻停止所有自动发送」。而两条路径**不过 policy**：
 * 用户在草稿箱手点发送、以及 `yolo` 档（policy 对它是旁路，直接放行）。
 * 也就是说 policy 里的 `kill_switch_inactive` 挡不住这两条 —— 它们唯一
 * 会经过的地方就是这个守卫。
 *
 * 加 `yolo` 那一档时我在设计里声明"急停仍然有效"，而当时这里**一条断言都没有**
 * （送出去的保证不该只是注释）。所以补上：并且断言它在**任何其它检查之前**
 * 生效 —— 急停时连执行器都不该被调到一次。
 */
describe("★★ 急停：所有路径的总闸（含 yolo 与手动发送）", () => {
  it("★★ 急停开着 → blocked，且执行器一次都没被调", async () => {
    const { guard, send } = setup({ killSwitchActive: true })
    const outcome = await guard.send(input())
    expect(outcome.state).toBe("blocked")
    expect(outcome.reason).toBe("kill_switch")
    // ★ 反证：没有走到 spawn —— 急停必须在任何其它检查之前
    expect(send).not.toHaveBeenCalled()
  })

  it("★ 急停优先于「草稿不存在」等后续判据（顺序对了才叫总闸）", async () => {
    // 草稿也是坏的：若顺序错，reason 会是 draft_not_found 而不是 kill_switch
    const { guard } = setup({ killSwitchActive: true, draft: null })
    const outcome = await guard.send(input())
    expect(outcome.reason).toBe("kill_switch")
  })

  it("★ 反证：急停关掉时同样的输入照常发出（证明上面拦住来自急停）", async () => {
    const { guard, send } = setup({ killSwitchActive: false })
    const outcome = await guard.send(input())
    expect(outcome.state).toBe("sent")
    expect(send).toHaveBeenCalledTimes(1)
  })
})
