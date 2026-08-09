/**
 * 钉钉 Stream 事件消费者（`dws event consume`）。
 *
 * ## 这个文件锁住的核心不变量
 *
 * 实测（记忆 dws-event-consume-connects-but-delivers-nothing）：这个账号上
 * `event consume` 会打 `[event] ready` + `state=connected`，但**零投递**。
 * 所以最要紧的一条断言是：**ready 不把状态推到 delivering**——只有 stdout 真
 * 收到一条事件才算"在投递"。ready 陷阱不锁住的话，状态页会把"接通但零投递"
 * 显示成"正常"，而它与网络安静在外观上完全一样。
 *
 * 另外锁：事件只当叫醒信号（回调会话 id，不落库）、event_id 去重、断线退避重连、
 * stop 时退订（`event stop --all`）。
 */
import { describe, expect, it } from "vitest"
import { createLogger, ManualClock } from "@mycontext/kernel"
import type { DuplexHandle, DuplexSpec, ExecResult } from "@mycontext/runtime-env"
import {
  DingTalkEventConsumer,
  parseEventLine,
} from "../../../packages/channels/src/plugins/dingtalk/events.js"

const NOW = 1_700_000_000_000

/**
 * 假 duplex：把最近一次 spawnDuplex 的 spec 抓出来，让测试能主动
 * ①喂 stderr（ready）②喂 stdout（真事件）③触发 onExit（断线）。
 */
function makeFakeProcesses() {
  const specs: DuplexSpec[] = []
  const execCalls: string[][] = []
  let alive = true
  const handle: DuplexHandle = {
    async writeLine() {},
    async close() {
      alive = false
      // close 后对端读到 EOF 退出 → 触发最近一条 spec 的 onExit。
      specs.at(-1)?.onExit?.({ code: 0, signal: null })
    },
    get alive() {
      return alive
    },
    get pid() {
      return 4242
    },
  }
  const processes = {
    spawnDuplex(spec: DuplexSpec): DuplexHandle {
      specs.push(spec)
      alive = true
      return handle
    },
    async exec(spec: { args: string[] }): Promise<ExecResult> {
      execCalls.push(spec.args)
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false }
    },
  }
  return {
    processes: processes as never,
    specs,
    execCalls,
    /** 最近一条长连接的 spec（喂事件 / 触发退出用）。 */
    last: () => specs.at(-1),
  }
}

function makeConsumer(
  onSignal: (conversationExternalId: string) => void,
  extra: Partial<{ sleep: (ms: number) => Promise<void> }> = {},
) {
  const clock = new ManualClock(NOW)
  const fake = makeFakeProcesses()
  const consumer = new DingTalkEventConsumer({
    runtime: {
      resolve: () => ({ path: "/fake/dws" }),
      buildEnv: () => ({}),
      /**
       * 这一组测的是长连接的状态机与投递，所以**必须**装成"已绑身份" ——
       * 未绑身份时 `spawnOnce` 直接不起长连接（见那处注释：不钉 profile 会
       * 订阅到 CLI 全局身份那个人的消息流）。
       *
       * `dwsProfileArgs` 仍给空数组：钉住的**参数**由
       * dws-profile-pinning.test.ts 单独锁，这里只需要过那道闸。
       */
      hasPinnedIdentity: () => true,
      dwsProfileArgs: () => [],
    } as never,
    processes: fake.processes,
    logger: createLogger("test-events", { level: "error" }),
    clock,
    onSignal: (signal) => onSignal(signal.conversationExternalId),
    // 默认不真 sleep：退避里 resolve 得极快，避免测试挂在真定时器上。
    sleep: extra.sleep ?? (async () => {}),
  })
  return { consumer, fake, clock }
}

/** 造一行事件 NDJSON（payload 形状照 M3 文档 1.1）。 */
function eventLine(eventId: string, conversationId: string): string {
  return JSON.stringify({
    event_id: eventId,
    conversation_id: conversationId,
    message_id: "m-x",
    content: "无关正文",
    sender_open_dingtalk_id: "peer",
    event_time: NOW,
  })
}

describe("parseEventLine", () => {
  it("取出 event_id 与 conversation_id（snake_case）", () => {
    expect(parseEventLine(eventLine("e1", "cid-1"))).toEqual({
      eventId: "e1",
      conversationExternalId: "cid-1",
    })
  })

  it("camelCase 与嵌套 data 也认", () => {
    const line = JSON.stringify({ eventId: "e2", data: { conversationId: "cid-2" } })
    expect(parseEventLine(line)).toEqual({ eventId: "e2", conversationExternalId: "cid-2" })
  })

  it("缺 conversation_id → null（不能当叫醒信号）", () => {
    expect(parseEventLine(JSON.stringify({ event_id: "e3" }))).toBeNull()
  })

  it("stderr 混进来的人类可读行 / 心跳 → null", () => {
    expect(parseEventLine("[event] ready event_key=… bus_pid=9445")).toBeNull()
    expect(parseEventLine("")).toBeNull()
  })
})

describe("DingTalkEventConsumer", () => {
  it("★ ready 只推到 ready，不推到 delivering（记忆里的零投递陷阱）", () => {
    const seen: string[] = []
    const { consumer, fake } = makeConsumer((c) => seen.push(c))
    consumer.start()

    fake.last()?.onStderr?.("[event] ready event_key=user_im_message_receive_at bus_pid=1")
    expect(consumer.health().state).toBe("ready")
    // ready 不是投递证据：没收到 stdout 事件，delivered 仍为 0。
    expect(consumer.health().delivered).toBe(0)
    expect(seen).toEqual([])
  })

  it("stdout 收到真事件 → delivering + 叫醒那个会话", () => {
    const seen: string[] = []
    const { consumer, fake, clock } = makeConsumer((c) => seen.push(c))
    consumer.start()

    fake.last()?.onLine(eventLine("e1", "cid-42"))
    expect(consumer.health().state).toBe("delivering")
    expect(consumer.health().delivered).toBe(1)
    expect(consumer.health().lastEventAt).toBe(clock.now())
    expect(seen).toEqual(["cid-42"])
  })

  it("同一个 event_id 重投 → 只叫醒一次", () => {
    const seen: string[] = []
    const { consumer, fake } = makeConsumer((c) => seen.push(c))
    consumer.start()

    fake.last()?.onLine(eventLine("dup", "cid-1"))
    fake.last()?.onLine(eventLine("dup", "cid-1"))
    expect(seen).toEqual(["cid-1"])
    expect(consumer.health().delivered).toBe(1)
  })

  it("断线 → 退避后重连（起了第二条长连接）", async () => {
    const waits: number[] = []
    const { consumer, fake } = makeConsumer(() => {}, { sleep: async (ms) => void waits.push(ms) })
    consumer.start()
    // 触发第一条长连接退出（对端崩）。
    fake.last()?.onExit?.({ code: 1, signal: null })
    // 让重连循环跑一拍。
    await new Promise((r) => setTimeout(r, 0))

    expect(waits.length).toBeGreaterThanOrEqual(1)
    // 起了不止一条长连接 = 重连发生了。
    expect(fake.specs.length).toBeGreaterThanOrEqual(2)
    await consumer.stop()
  })

  it("stop() 退订：跑了 event stop --all", async () => {
    const { consumer, fake } = makeConsumer(() => {})
    consumer.start()
    await consumer.stop()

    expect(consumer.health().state).toBe("stopped")
    expect(fake.execCalls).toContainEqual(["event", "stop", "--all"])
  })
})
