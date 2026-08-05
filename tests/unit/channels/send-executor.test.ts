/**
 * 发送执行器的门禁（`SendGuard` 四层里的第 ③ 层）。
 *
 * ## ★ 锁的是"参数拼对了"与"错误分类对了"
 *
 * 这一层不做"该不该发"的判断（那在守卫与 policy 里），它只有两个职责，
 * 而两个都有静默失败的形态：
 *
 * 1. **`--uuid` 必须传**。它是服务端幂等键（实测 24h 内同值不重复投递），
 *    漏了的后果是崩溃重启后**真的重发一遍** —— 而那时命令是成功的，
 *    日志里什么都看不出来。
 * 2. **权限类错误必须分出来**。守卫对它的处置完全不同（标撤销 + 降级 +
 *    不重试）。归类成普通失败的后果是每 8 秒重试一次授权问题，
 *    反复弹窗骚扰用户，而授权问题重试永远没用。
 *
 * 另外锁 `@人` 的参数形态：`--at-open-dingtalk-ids` 缺失时
 * **@ 不生效但命令成功**，那是这个渠道最典型的静默失败。
 */
import { describe, expect, it } from "vitest"
import { AppError } from "@mycontext/kernel"
import { createSendExecutor } from "@mycontext/channels"

/** 记录每次调用的参数，并按需抛错。 */
function fakeCli(behavior?: { throws?: unknown; returns?: unknown }) {
  const calls: string[][] = []
  return {
    calls,
    cli: {
      json: <T>(args: readonly string[]): Promise<T> => {
        calls.push([...args])
        if (behavior?.throws !== undefined) return Promise.reject(behavior.throws)
        return Promise.resolve((behavior?.returns ?? {}) as T)
      },
    },
  }
}

const SPEC = {
  target: { kind: "group" as const, externalId: "cidFAKE" },
  text: "收到",
  mentions: [] as readonly string[],
  idempotencyKey: "key-1",
  dryRun: false,
}

describe("★ 命令参数：目标三选一 + --uuid 幂等键", () => {
  it("群聊用 --group", async () => {
    const { calls, cli } = fakeCli()
    await createSendExecutor(cli).send(SPEC)
    expect(calls[0]).toContain("--group")
    expect(calls[0]).toContain("cidFAKE")
  })

  it("单聊用 --open-dingtalk-id（不是 --group）", async () => {
    const { calls, cli } = fakeCli()
    await createSendExecutor(cli).send({
      ...SPEC,
      target: { kind: "open_id", externalId: "DeFAKE" },
    })
    expect(calls[0]).toContain("--open-dingtalk-id")
    expect(calls[0]).not.toContain("--group")
  })

  it("userId 用 --user", async () => {
    const { calls, cli } = fakeCli()
    await createSendExecutor(cli).send({ ...SPEC, target: { kind: "user", externalId: "12345" } })
    expect(calls[0]).toContain("--user")
  })

  /**
   * ★ 这一条锁的是"崩溃重启不会重发"。
   *
   * `--uuid` 漏传时命令**照样成功** —— 只是失去了服务端幂等。
   * 于是"我们崩了一次然后重发"变成对方真的收到两条，
   * 而日志与返回值都正常。这是那种只在事故里才暴露的缺失。
   */
  it("--uuid 必须传，且值就是 idempotencyKey（服务端幂等的唯一依据）", async () => {
    const { calls, cli } = fakeCli()
    await createSendExecutor(cli).send({ ...SPEC, idempotencyKey: "idem-abc" })
    const args = calls[0] ?? []
    const index = args.indexOf("--uuid")
    expect(index).toBeGreaterThanOrEqual(0)
    expect(args[index + 1]).toBe("idem-abc")
  })

  it("正文用 --text 传（不靠位置参数 —— 以 - 开头的正文会被当成 flag）", async () => {
    const { calls, cli } = fakeCli()
    await createSendExecutor(cli).send({ ...SPEC, text: "-- 这条以横线开头" })
    const args = calls[0] ?? []
    const index = args.indexOf("--text")
    expect(index).toBeGreaterThanOrEqual(0)
    expect(args[index + 1]).toBe("-- 这条以横线开头")
  })
})

describe("★ @人：有才加参数，逗号分隔", () => {
  it("没有 @人 时不加 --at-open-dingtalk-ids（空值会让命令报错）", async () => {
    const { calls, cli } = fakeCli()
    await createSendExecutor(cli).send({ ...SPEC, mentions: [] })
    expect(calls[0]).not.toContain("--at-open-dingtalk-ids")
  })

  it("有 @人 时逗号分隔（形态与 reference 一致）", async () => {
    const { calls, cli } = fakeCli()
    await createSendExecutor(cli).send({ ...SPEC, mentions: ["DeA", "DeB"] })
    const args = calls[0] ?? []
    const index = args.indexOf("--at-open-dingtalk-ids")
    expect(index).toBeGreaterThanOrEqual(0)
    expect(args[index + 1]).toBe("DeA,DeB")
  })
})

describe("★ dry-run 根本不调命令（第 ① 层之外的冗余一道）", () => {
  it("dryRun 时不 spawn，且返回 ok:false", async () => {
    const { calls, cli } = fakeCli()
    const result = await createSendExecutor(cli).send({ ...SPEC, dryRun: true })
    /**
     * 判据是**一次都没调**，不是"返回了失败"。
     * 只验返回值的话，一个"先发出去再返回失败"的实现也能通过 ——
     * 而那正是最坏的结果。
     */
    expect(calls).toHaveLength(0)
    expect(result.ok).toBe(false)
  })
})

describe("★ 返回里取 openMessageId（关联发出去的那条）", () => {
  /**
   * 拿到它才能把"我们发的"与"采集回来的"对上。对不上的后果是
   * 数字人自己发的消息被当成新入站消息再处理一遍 —— 自问自答。
   * （准入闸有 `origin_agent` 那一条，但它依赖这个关联键。）
   */
  it.each([
    ["顶层 openMessageId", { openMessageId: "msgFAKE" }],
    ["下划线风格", { open_message_id: "msgFAKE" }],
    ["包在 data 里", { data: { openMessageId: "msgFAKE" } }],
    ["包在 result 里", { result: { messageId: "msgFAKE" } }],
  ])("%s → 取出来", async (_label, payload) => {
    const { cli } = fakeCli({ returns: payload })
    const result = await createSendExecutor(cli).send(SPEC)
    expect(result).toEqual({ ok: true, externalId: "msgFAKE" })
  })

  it("取不到 id 不算失败（命令成功就是发出去了，只是少一个关联键）", async () => {
    const { cli } = fakeCli({ returns: { success: true } })
    const result = await createSendExecutor(cli).send(SPEC)
    expect(result.ok).toBe(true)
  })

  /**
   * ★★ **真实返回**里根本没有 openMessageId —— 只有 `openTaskId`。
   *
   * ## 这条锁的是一个活了很久的静默 bug
   *
   * 上面那几条用的都是我们**臆想**的形状（顶层 / 下划线 / 包在 data 里），
   * 一条都不是真的。实测发一条自检消息，`dws chat message send` 返回：
   *
   * ```json
   * {"success": true, "result": {"openTaskId": "qQrC8yRZwg5c…"}}
   * ```
   *
   * 于是 `readMessageId` 恒 undefined，后果是一整条链断掉且**全程不报错**：
   * `dh_send_attempts.sent_message_external_id` 全 NULL（实测 32 条已发全 NULL）
   * → `claimAgentOrigin` 匹配不到 → `messages.origin` 恒 `human`
   * （实测 12052 条消息里 `origin='agent'` **零条**，而 runs 里有 43 条 auto_sent）
   * → 界面上那个「分身发的」标签从来没渲染过
   * → 更糟：分身的回复被当本人语料再蒸一遍（自我强化漂移）。
   *
   * ## 为什么这条测试必须用**真实**返回
   *
   * 上面四条全绿而 bug 活着 —— 那正是"用自己编的形状测解析"的代价。
   * 这一条的 payload 是从真进程 dump 里抄的，改协议时它才会红。
   */
  it("★★ 真实返回（只有 openTaskId）→ 拿到 taskId", async () => {
    const { cli } = fakeCli({
      returns: {
        arguments: [],
        errorCode: null,
        errorMsg: null,
        result: { openTaskId: "qQrC8yRZwg5cmSigfENBJrBWMA6zWhr1ZvyI9InqUj4=" },
        success: true,
      },
    })
    const result = await createSendExecutor(cli).send(SPEC)
    expect(result.ok).toBe(true)
    // taskId 必须被取出来 —— 它是换 openMessageId 的唯一入口
    expect(result.ok ? result.taskId : null).toBe("qQrC8yRZwg5cmSigfENBJrBWMA6zWhr1ZvyI9InqUj4=")
  })

  /**
   * ★ `query-send-status` 把 taskId 换成真正的消息 id。
   *
   * 实测返回：
   * `{"openConversationId":"cid…","openMessageId":"msgIbwJ0…","sendStatus":"SUCCESS"}`
   *
   * 这一跳是**必需**的：没有它就没有任何东西能把"我们发的"与"采集回来的"对上。
   */
  it("★ querySendStatus：taskId → openMessageId", async () => {
    const { cli, calls } = fakeCli({
      returns: {
        result: {
          openConversationId: "cidFAKE",
          openMessageId: "msgFAKE0003xxxxxxxxxxxxxx==",
          sendStatus: "SUCCESS",
        },
        success: true,
      },
    })
    const status = await createSendExecutor(cli).querySendStatus("taskFAKE")
    expect(status?.externalId).toBe("msgFAKE0003xxxxxxxxxxxxxx==")
    expect(status?.delivered).toBe(true)
    // 命令与参数名都不能猜错（`--open-task-id`，实测）
    expect(calls[0]).toEqual(["chat", "message", "query-send-status", "--open-task-id", "taskFAKE"])
  })

  it("★ 换不到 id 时返回 null，而不是抛（消息已经发出去了）", async () => {
    const { cli } = fakeCli({ returns: { success: true, result: {} } })
    expect(await createSendExecutor(cli).querySendStatus("taskFAKE")).toBeNull()
  })

  it("★ sendStatus 不是 SUCCESS 时 delivered=false（在途/失败要能区分）", async () => {
    const { cli } = fakeCli({
      returns: { result: { openMessageId: "msgX", sendStatus: "SENDING" }, success: true },
    })
    const status = await createSendExecutor(cli).querySendStatus("taskFAKE")
    expect(status?.delivered).toBe(false)
  })
})

describe("★ 错误分类：权限类要与普通失败分开", () => {
  /**
   * 守卫看到 `PERMISSION_REQUIRED` / `GRANT_REVOKED` 会标授权撤销 +
   * 降级为 draft + **不重试**。归类错了的后果是每轮重试一次授权问题：
   * 反复弹窗，而且永远不会成功。
   */
  it("AppError(PERMISSION_REQUIRED) → PERMISSION_REQUIRED", async () => {
    const { cli } = fakeCli({
      throws: new AppError("PERMISSION_REQUIRED", "缺少授权", { retryable: false }),
    })
    const result = await createSendExecutor(cli).send(SPEC)
    expect(result).toMatchObject({ ok: false, code: "PERMISSION_REQUIRED" })
  })

  it("登录过期 → GRANT_REVOKED（对守卫来说处置相同：降级 + 不重试）", async () => {
    const { cli } = fakeCli({
      throws: new AppError("SESSION_EXPIRED", "登录已过期", { retryable: false }),
    })
    const result = await createSendExecutor(cli).send(SPEC)
    expect(result).toMatchObject({ ok: false, code: "GRANT_REVOKED" })
  })

  /**
   * 裸 Error 也要能分类：CLI 的权限错误不一定被包成 AppError
   * （比如子进程 stderr 直接冒上来）。判据复用 `classifyDwsError`，
   * 与其他命令同一份匹配规则 —— 各写一遍会让"两处分类不同"成为
   * 一个极难发现的 bug。
   */
  it("裸 Error 里含权限字样也能分类（复用 classifyDwsError）", async () => {
    const { cli } = fakeCli({ throws: new Error("permission denied: scope chat.message:send") })
    const result = await createSendExecutor(cli).send(SPEC)
    expect(result).toMatchObject({ ok: false, code: "PERMISSION_REQUIRED" })
  })

  it("网络类错误 → SEND_FAILED（可重试，不该标授权撤销）", async () => {
    const { cli } = fakeCli({ throws: new Error("ETIMEDOUT") })
    const result = await createSendExecutor(cli).send(SPEC)
    expect(result).toMatchObject({ ok: false, code: "SEND_FAILED" })
  })
})
