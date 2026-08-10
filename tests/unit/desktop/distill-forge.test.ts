/**
 * DistillService 与 forge 的接缝。
 *
 * ## ★ 锁的是四条"不报错但功能等于没有"的性质
 *
 * 1. **forge 的结果必须到得了 UI。** 那五个数（语料 / 配对 / 问我 / 产物 /
 *    等级）曾经在 `attach` 的回调边界上被压成 `{ok, reason}` 丢掉，而
 *    `distill_tasks` 在只跑 forge 时恒空 —— 于是界面永远显示「等待开始」，
 *    尽管引擎跑了几分钟并发布了十几个文件。
 * 2. **`asks === 0` 必须浮到界面上。** 一条「别人问我」都没挖到时决策层
 *    整个是默认值，而风格层照常有数字 —— 产物看起来是完整的。
 * 3. **「重新蒸馏」必须清 forge 自己的水位。** 那个水位在 forge 的派生库里，
 *    只清 `distill_tasks` 的话按钮的文案在骗人：什么都没重来。
 * 4. **「停止」必须真的打断在跑的那一轮。** 只跑 forge 时轮次定时器根本
 *    不存在，`clearInterval` 对它完全无效，而一轮的超时上限近半小时。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { ManualClock, createLogger } from "@mycontext/kernel"
import { LlmClient, staticLlmProvider } from "@mycontext/llm"
import { DistillService, type ForgeRunOutcome } from "@main/services/distill.service.js"
import { ChangelogRepository } from "@mycontext/store"
import { openTestVault } from "../../helpers/vault.js"

const NOW = 1_785_000_000_000
const logger = createLogger("Test", { level: "error" })

afterEach(() => {
  vi.useRealTimers()
})

/**
 * 一个不打网络的假 LLM。返回一条形状合法但内容为空的 JSON —— work 层那几条
 * 只关心"有没有发起调用"，不关心抽出了什么（那由 map.test.ts 覆盖）。
 */
function fakeLlm(): LlmClient {
  return new LlmClient({
    baseUrl: "https://fake.invalid",
    apiKey: "k",
    model: "m",
    sleep: () => Promise.resolve(),
    fetchImpl: () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "[]" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        text: () => Promise.resolve(""),
      } as unknown as Response),
  })
}

/** 一轮成功的 forge 结果。用具名字段而不是 0，好让断言有区分度。 */
function ok(overrides: Partial<ForgeRunOutcome> = {}): ForgeRunOutcome {
  return {
    ok: true,
    failedStep: null,
    reason: null,
    messages: 4400,
    turns: 210,
    asks: 87,
    files: 14,
    grade: "B",
    ...overrides,
  }
}

function makeService(options: {
  runForge?: (
    signal?: AbortSignal,
    onStep?: (step: "pull" | "build" | "publish") => void,
    since?: number | null,
    windowDays?: number | null,
  ) => Promise<ForgeRunOutcome>
  resetForge?: () => boolean
  forgeAvailability?: () => { ok: boolean; reason: string | null }
  autoIntervalMs?: number
  onProfileChanged?: () => void
  onCorpusReady?: () => void
  /** LLM 抽取那半。缺省关（与生产一致）—— 只有"遗留任务"那组要打开它对照 */
  llmFacets?: boolean
  /**
   * 可变的开关（模拟用户在设置页现改）。给它就忽略 `llmFacets`。
   *
   * 单独一个字段而不是让 `llmFacets` 收函数：绝大多数 case 只想说
   * "开着/关着"，用 boolean 读起来清楚得多。
   */
  llmFacetsRef?: { on: boolean }
  /**
   * 可用的假 LLM。缺省是 `null`（= 未配置模型），因为绝大多数 case 只跑 forge。
   *
   * work 层那几条要它：判据里有一条 `llmReady`（没配模型就不跑，见
   * work-refresh.ts）—— 不给的话那些 case 会因为"没模型"而跳过，
   * 于是断言的其实不是它想断言的那件事。
   */
  llm?: LlmClient | null
  /**
   * 在 `attach()` **之前**往 changelog 写一条。
   *
   * attach 里那一次评估读的是当时的 changelog head —— 测"登录时开关已是开"
   * 那条必须让数据先在库里，否则判据给 `no-new-data`，而那样这条用例就
   * 成了一条永远绿的空用例（它验的是"空库不跑"）。
   */
  seedChangelog?: boolean
  /** work 层落盘。给"攒批"那组用来观察它有没有被跑起来 */
  writeWorkFile?: (content: string | null) => void
  workArtifactExists?: () => boolean
  /** 建图在跑吗 —— 给"让路"那组用 */
  graphBusy?: () => boolean
}) {
  const clock = new ManualClock(NOW)
  const vault = openTestVault()
  const service = new DistillService({
    clock,
    logger,
    llmProvider: staticLlmProvider(options.llm ?? null),
    getWindow: () => null,
    // 缺省关掉自动重蒸：只有那一组用例要它，别处开着会让计数不稳
    autoIntervalMs: options.autoIntervalMs ?? 0,
    /**
     * ★ `llmFacets` 是**回调**（用户可在设置页随时改，见它的注释）。
     * 测试仍用 boolean 表达意图，在这里包成回调 —— 那样每个 case 读起来
     * 是"开着/关着"，而不是"传了个函数"。
     */
    ...(options.llmFacetsRef !== undefined
      ? { llmFacets: () => options.llmFacetsRef?.on === true }
      : options.llmFacets === undefined
        ? {}
        : { llmFacets: () => options.llmFacets === true }),
    ...(options.runForge === undefined ? {} : { runForge: options.runForge }),
    ...(options.resetForge === undefined ? {} : { resetForge: options.resetForge }),
    ...(options.forgeAvailability === undefined
      ? {}
      : { forgeAvailability: options.forgeAvailability }),
    ...(options.onProfileChanged === undefined
      ? {}
      : { onProfileChanged: options.onProfileChanged }),
    ...(options.onCorpusReady === undefined ? {} : { onCorpusReady: options.onCorpusReady }),
    ...(options.graphBusy === undefined ? {} : { graphBusy: options.graphBusy }),
  })
  if (options.seedChangelog === true) {
    new ChangelogRepository(vault.db).append([
      {
        op: "upsert" as const,
        entityType: "message" as const,
        entityId: "m-seed",
        channelId: "dingtalk" as const,
        domain: "chat" as const,
        occurredAt: NOW,
        emittedAt: NOW,
        digest: "d-seed",
      },
    ])
  }
  service.attach(vault.db, undefined, undefined, options.writeWorkFile, options.workArtifactExists)
  return { service, vault, clock }
}

describe("★ forge 的结果必须到得了 UI", () => {
  it("五个数原样透出（曾经在回调边界上被丢掉）", async () => {
    const { service, vault } = makeService({ runForge: () => Promise.resolve(ok()) })

    service.start()
    // start 里是 fire-and-forget，等在途那轮收尾
    await vi.waitFor(() => {
      expect(service.progress().forge.lastRunAt).not.toBeNull()
    })

    const forge = service.progress().forge
    expect(forge.messages).toBe(4400)
    expect(forge.turns).toBe(210)
    expect(forge.asks).toBe(87)
    expect(forge.files).toBe(14)
    expect(forge.grade).toBe("B")
    expect(forge.lastOk).toBe(true)

    await service.detach()
    vault.close()
  })

  /**
   * ★ 没蒸过与蒸过是两个状态，必须能区分。
   *
   * `lastRunAt === null` 是"这个 vault 还没蒸过"，界面据此提示用户点按钮。
   * 如果它和"蒸过但 0 条"长得一样，那句提示就会一直挂着。
   */
  it("没跑过时 lastRunAt 是 null，而不是 0", () => {
    const { service, vault } = makeService({ runForge: () => Promise.resolve(ok()) })
    const forge = service.progress().forge
    expect(forge.lastRunAt).toBeNull()
    expect(forge.lastOk).toBeNull()
    void service.detach()
    vault.close()
  })

  it("开跑就推一次「正在跑」（否则界面几分钟不动，与卡住无法区分）", async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { service, vault } = makeService({
      runForge: async () => {
        await gate
        return ok()
      },
    })

    service.start()
    expect(service.progress().forge.running).toBe(true)
    // `running_` 也要跟着真 —— 界面用它禁「开始」按钮
    expect(service.progress().running_).toBe(true)

    release?.()
    await vi.waitFor(() => {
      expect(service.progress().forge.running).toBe(false)
    })

    await service.detach()
    vault.close()
  })

  it("失败时带上停在哪一步与原因", async () => {
    const { service, vault } = makeService({
      runForge: () =>
        Promise.resolve(
          ok({ ok: false, failedStep: "build", reason: "语料库里一条都没有", grade: null }),
        ),
    })

    service.start()
    await vi.waitFor(() => {
      expect(service.progress().forge.lastOk).toBe(false)
    })

    const forge = service.progress().forge
    expect(forge.failedStep).toBe("build")
    expect(forge.reason).toContain("一条都没有")

    await service.detach()
    vault.close()
  })

  /** 抛异常与返回 `ok: false` 都是失败，不能只处理一种。 */
  it("回调抛异常也算失败（不是静默什么都不发生）", async () => {
    const { service, vault } = makeService({
      runForge: () => Promise.reject(new Error("python 没了")),
    })

    service.start()
    await vi.waitFor(() => {
      expect(service.progress().forge.lastOk).toBe(false)
    })
    expect(service.progress().forge.reason).toContain("python")

    await service.detach()
    vault.close()
  })
})

/**
 * ★ `asks === 0` 是失败，不是「这个人没被问过」。
 *
 * 挖不到 ask 时决策层整个退化成默认值，而风格层照常有数字 —— 产物
 * 看起来是完整的。forge 为这种情况专门判 D 级，但没人会主动去翻
 * 产物里的 `fidelity.md`。
 */
describe("★ 挖不到「别人问我」要在界面上说", () => {
  it("asks 为 0 时 reason 非空，且说清了后果", async () => {
    const { service, vault } = makeService({
      runForge: () => Promise.resolve(ok({ asks: 0, grade: "D" })),
    })

    service.start()
    await vi.waitFor(() => {
      expect(service.progress().forge.lastRunAt).not.toBeNull()
    })

    const forge = service.progress().forge
    // 仍然是"成功"（产物发布了），但必须带上说明
    expect(forge.lastOk).toBe(true)
    expect(forge.reason).not.toBeNull()
    expect(forge.reason).toContain("决策层")

    await service.detach()
    vault.close()
  })

  it("asks 非 0 时不加这条说明（否则它退化成恒显示的噪音）", async () => {
    const { service, vault } = makeService({ runForge: () => Promise.resolve(ok()) })

    service.start()
    await vi.waitFor(() => {
      expect(service.progress().forge.lastRunAt).not.toBeNull()
    })
    expect(service.progress().forge.reason).toBeNull()

    await service.detach()
    vault.close()
  })
})

describe("★ 引擎不可用要在跑之前就能看见", () => {
  it("透出人话原因（缺 Python 时蒸馏根本不会启动）", () => {
    const { service, vault } = makeService({
      runForge: () => Promise.resolve(ok()),
      forgeAvailability: () => ({ ok: false, reason: "未检测到可用的 Python 3.9+" }),
    })

    const forge = service.progress().forge
    expect(forge.available).toBe(false)
    expect(forge.unavailableReason).toContain("Python")
    /**
     * 原因优先报"不能跑"：两者同时存在时（上次失败了、现在 Python 也没了），
     * 先说不能跑 —— 那是用户当下要解决的，而上一轮的失败很可能就是它导致的。
     */
    expect(forge.reason).toContain("Python")

    void service.detach()
    vault.close()
  })

  it("可用时不编造原因", () => {
    const { service, vault } = makeService({ runForge: () => Promise.resolve(ok()) })
    expect(service.progress().forge.available).toBe(true)
    expect(service.progress().forge.unavailableReason).toBeNull()
    void service.detach()
    vault.close()
  })
})

/**
 * ★ 「重新蒸馏」必须清 forge 自己的水位。
 *
 * `--since auto` 是从 forge 派生库里的 `pulledThrough` 续跑的，而 reset
 * 原来只清 `distill_tasks` 与 `distill_sources` —— 那两张表现在只有 LLM
 * runner 在用（默认还关着）。于是用户点了「重新蒸馏」，forge 照旧增量跑，
 * 什么都没重来，而按钮看起来生效了。
 */
describe("★ reset 要真的让下一轮从头蒸", () => {
  it("调用注入的 resetForge", () => {
    let called = 0
    const { service, vault } = makeService({
      runForge: () => Promise.resolve(ok()),
      resetForge: () => {
        called += 1
        return true
      },
    })

    service.reset()
    expect(called).toBe(1)

    void service.detach()
    vault.close()
  })

  it("★ 一并清掉上一轮的数字（否则界面还显示 4400 条与等级 B）", async () => {
    const { service, vault } = makeService({
      runForge: () => Promise.resolve(ok()),
      resetForge: () => true,
    })

    service.start()
    await vi.waitFor(() => {
      expect(service.progress().forge.messages).toBe(4400)
    })

    service.reset()
    /**
     * 清空而不是留着：语料库刚被要求从头蒸，而"4400 条 / 等级 B"
     * 会让用户以为不用再跑了。
     */
    const forge = service.progress().forge
    expect(forge.messages).toBe(0)
    expect(forge.grade).toBeNull()
    expect(forge.lastRunAt).toBeNull()

    await service.detach()
    vault.close()
  })

  it("没有注入 resetForge 时不抛（清不掉只是降级成增量）", () => {
    const { service, vault } = makeService({ runForge: () => Promise.resolve(ok()) })
    expect(() => service.reset()).not.toThrow()
    void service.detach()
    vault.close()
  })
})

/**
 * ★ 「停止」必须真的打断在跑的那一轮。
 *
 * 只跑 forge 时轮次定时器根本不存在，所以原来的 `clearInterval` 对它
 * 完全无效 —— 而一轮的超时上限是 pull 10min + build 15min + publish 2min。
 * 用户点了停之后没有任何东西会停，而按钮看起来生效了。
 */
describe("★ stop 要能打断在跑的 forge", () => {
  it("signal 被传进回调并在 stop 时 abort", async () => {
    let seen: AbortSignal | undefined
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { service, vault } = makeService({
      runForge: async (signal) => {
        seen = signal
        await gate
        return ok()
      },
    })

    service.start()
    expect(seen, "回调必须拿到 signal，否则子进程杀不掉").toBeDefined()
    expect(seen?.aborted).toBe(false)

    service.stop()
    expect(seen?.aborted).toBe(true)

    release?.()
    await vi.waitFor(() => {
      expect(service.progress().forge.running).toBe(false)
    })

    await service.detach()
    vault.close()
  })

  /**
   * ★ 停过之后还能再开。
   *
   * 复用同一个 AbortController 的话，第一次 `stop()` 之后它永久是 aborted，
   * 于是之后每次「开始」都会立刻被自己取消 —— 表现是点了没反应。
   */
  it("停过之后「开始」仍然有效（AbortController 每轮新建）", async () => {
    const signals: AbortSignal[] = []
    const { service, vault } = makeService({
      runForge: (signal) => {
        if (signal !== undefined) signals.push(signal)
        return Promise.resolve(ok())
      },
    })

    service.start()
    await vi.waitFor(() => {
      expect(service.progress().forge.lastRunAt).not.toBeNull()
    })
    service.stop()

    service.start()
    await vi.waitFor(() => {
      expect(signals).toHaveLength(2)
    })
    // 第二轮那个不能是已 abort 的
    expect(signals[1]?.aborted).toBe(false)

    await service.detach()
    vault.close()
  })
})

/**
 * ★ 自动重蒸。
 *
 * 画像原来只在引导第 4 步那个按钮被点时更新 —— 走完引导之后它就再也
 * 不会变了，而新语料与新的「别人问我」（决策层的全部证据）都进不去。
 * forge 一轮是纯本地测量、零模型调用，所以定期跑的代价接近于零。
 */
describe("★ 自动重蒸", () => {
  it("到周期就跑一轮", async () => {
    let runs = 0
    const { service, vault } = makeService({
      // 真等而不是用假时钟：`unref()` 与 fake timer 一起用时行为不直观，
      // 而这里要验的恰好是"定时器真的被起了"。40ms 够短。
      autoIntervalMs: 40,
      runForge: () => {
        runs += 1
        return Promise.resolve(ok())
      },
    })

    // 挂载时**不**立刻跑：那一刻采集还没开始，语料与上次退出时一样
    expect(runs).toBe(0)

    await vi.waitFor(
      () => {
        expect(runs).toBeGreaterThanOrEqual(1)
      },
      { timeout: 3_000, interval: 20 },
    )

    await service.detach()
    vault.close()
  }, 10_000)

  it("周期为 0 时不起定时器（能关掉）", async () => {
    let runs = 0
    const { service, vault } = makeService({
      autoIntervalMs: 0,
      runForge: () => {
        runs += 1
        return Promise.resolve(ok())
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(runs).toBe(0)

    await service.detach()
    vault.close()
  })

  /**
   * ★ `stop()` 不该关掉自动重蒸。
   *
   * 它的语义是"用户点了停止**这一轮**"。连自动更新一起关掉的话，
   * 点一次停止之后画像就永久不再更新了，而界面上没有任何地方
   * 能看出来自动更新被关了。
   */
  it("stop() 之后自动重蒸仍然活着", async () => {
    let runs = 0
    const { service, vault } = makeService({
      autoIntervalMs: 40,
      runForge: () => {
        runs += 1
        return Promise.resolve(ok())
      },
    })

    service.stop()
    await vi.waitFor(
      () => {
        expect(runs).toBeGreaterThanOrEqual(1)
      },
      { timeout: 3_000, interval: 20 },
    )

    await service.detach()
    vault.close()
  }, 10_000)

  it("detach() 之后不再跑（登出后不该继续写一个要关掉的库）", async () => {
    let runs = 0
    const { service, vault } = makeService({
      autoIntervalMs: 30,
      runForge: () => {
        runs += 1
        return Promise.resolve(ok())
      },
    })

    await service.detach()
    const after = runs
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(runs).toBe(after)

    vault.close()
  })
})

/**
 * ★★ 蒸出新画像必须**通知**数字人 —— 否则"蒸完了但没生效"。
 *
 * ## 这条线断掉的形态（实测踩到过）
 *
 * `PersonaSupervisor.acquire()` 对已常驻的会话直接返回，不调
 * `createAgent` —— 而装 skill 就在那里。所以蒸馏完成后正在聊的会话
 * 会继续用蒸馏前的 workspace，直到 idle（10 分钟）淘汰它。
 *
 * 实测：forge 跑出 grade A、11 个文件都在磁盘上，而 10 个 agent
 * workspace 里的 skill 数全是 0，回复照旧走兜底文案 —— 界面上
 * 看不出任何区别，用户刚点完「重新蒸馏」。
 */
describe("★★ 蒸出新画像要通知数字人换代", () => {
  it("成功一轮 → 通知一次", async () => {
    let notified = 0
    const { service, vault } = makeService({
      runForge: () => Promise.resolve(ok()),
      onProfileChanged: () => {
        notified += 1
      },
    })
    service.start()
    await vi.waitFor(() => {
      expect(service.progress().forge?.running).toBe(false)
    })
    expect(notified).toBe(1)
    vault.close()
  })

  it("★ 失败不通知（publish 没跑到，磁盘上还是旧的）", async () => {
    let notified = 0
    const { service, vault } = makeService({
      runForge: () =>
        Promise.resolve(ok({ ok: false, failedStep: "build", reason: "python 挂了" })),
      onProfileChanged: () => {
        notified += 1
      },
    })
    service.start()
    await vi.waitFor(() => {
      expect(service.progress().forge?.running).toBe(false)
    })
    /**
     * 失败时通知的话，supervisor 会为一份**没变**的画像重装所有
     * workspace —— 白做 IO，而且会掩盖"这一轮其实失败了"。
     */
    expect(notified).toBe(0)
    vault.close()
  })

  it("★ asks=0 那种「产物完整但决策层是默认值」也要通知", async () => {
    /**
     * 它仍然是一份**新产物**（publish 真的写了文件、覆盖了旧的）。
     * 不通知只会让内存里的认知与磁盘不一致 —— 而那比"画像很薄"更糟：
     * agent 读到的是新文件，而 supervisor 以为还是旧的那一代。
     */
    let notified = 0
    const { service, vault } = makeService({
      runForge: () => Promise.resolve(ok({ asks: 0, grade: "D" })),
      onProfileChanged: () => {
        notified += 1
      },
    })
    service.start()
    await vi.waitFor(() => {
      expect(service.progress().forge?.running).toBe(false)
    })
    expect(notified).toBe(1)
    vault.close()
  })
})

/**
 * ★★ 没有消费者的遗留任务不许算进进度。
 *
 * ## 这一组来自一次真实的界面谎言
 *
 * `start()` 在 `llmFacets` 关着时刻意**不入队**（见它的注释）。但库里
 * 可能**已经有**遗留任务 —— 早期版本入过队、或者有人短暂打开过那个开关。
 * 实测本机 vault 里就有 6 条 `pending` / `attempts=0` 的行，于是引导第 4 步
 * 永远显示：
 *
 *   进度 0 / 6 · 跳过 0 · 失败 0 · 待跑 6
 *
 * 而**同一屏上面**写着「上次蒸馏成功 · 产物 11 个 · 覆盖度等级 A」。
 * 两个数字互相矛盾，且那个 `0/6` 永远不会动（没有消费者）——
 * 用户唯一能得出的结论是"坏了"。
 *
 * 一个永远不动的进度条比没有进度条更糟：它在说一件不会发生的事。
 */
describe("★★ llmFacets 关着时不报任务计数", () => {
  /** 直接往 `distill_tasks` 塞几条 pending —— 模拟遗留数据。 */
  function plantLegacyTasks(vault: ReturnType<typeof openTestVault>, count: number): void {
    const insert = vault.db.prepare(
      `INSERT INTO distill_tasks
         (id, facet, scope, scope_ref, window_start, window_end, state,
          attempts, created_at, updated_at)
       VALUES (?, ?, 'global', '', ?, ?, 'pending', 0, ?, ?)`,
    )
    for (let i = 0; i < count; i += 1) {
      insert.run(`legacy-${String(i)}`, `facet-${String(i)}`, NOW - 86_400_000, NOW, NOW, NOW)
    }
  }

  it("★ 遗留的 pending 任务不出现在进度里（默认路径：只跑 forge）", () => {
    const { service, vault } = makeService({ runForge: () => Promise.resolve(ok()) })
    plantLegacyTasks(vault, 6)
    const progress = service.progress()
    /**
     * 判据是**这几个数**全为 0，而不只是 `total`：UI 上那行
     * 「跳过 0 · 失败 0 · 待跑 6」是分开读 `pending` 的，
     * 只归零 total 会让进度条消失而那行文字仍写着"待跑 6"。
     */
    expect(progress.total).toBe(0)
    expect(progress.pending).toBe(0)
    expect(progress.running).toBe(0)
    expect(progress.done).toBe(0)
    expect(progress.failed).toBe(0)
    expect(progress.skipped).toBe(0)
    vault.close()
  })

  it("★ 反面：`llmFacets` 打开时照常报（那时它们真的会被跑）", () => {
    /**
     * 这一条是上面那条的对照。少了它，"永远归零"这个实现照样绿 ——
     * 而那会让真正打开 LLM 抽取的人完全看不到进度。
     */
    const { service, vault } = makeService({ llmFacets: true })
    plantLegacyTasks(vault, 6)
    const progress = service.progress()
    expect(progress.total).toBe(6)
    expect(progress.pending).toBe(6)
    vault.close()
  })

  it("归零不动库 —— `progress()` 是只读的", () => {
    const { service, vault } = makeService({ runForge: () => Promise.resolve(ok()) })
    plantLegacyTasks(vault, 3)
    service.progress()
    /**
     * 在一个只读方法里删库是超出职责的副作用；而且万一有人重新打开
     * `llmFacets`，那些切好的窗口就得重新算一遍。清理归 `reset()`
     * （那是用户显式要求"重来一遍"）。
     */
    const left = vault.db
      .prepare<[], { n: number }>("SELECT count(*) AS n FROM distill_tasks")
      .get()
    expect(left?.n).toBe(3)
    vault.close()
  })

  it("forge 的那几个数不受影响（它们不来自任务表）", () => {
    const { service, vault } = makeService({ runForge: () => Promise.resolve(ok()) })
    plantLegacyTasks(vault, 6)
    // forge 卡片是常显的，归零任务计数不该把它一起抹掉
    expect(service.progress().forge).not.toBeUndefined()
    vault.close()
  })
})

/**
 * 阶段（`forge.step`）必须到得了 UI。
 *
 * ## ★ 为什么这组用例值得存在
 *
 * `forgeStatus.step` 这个字段在 IPC 契约里**声明了很久**，而主进程一直
 * 写死 `null`（注释写着「具体到哪一步要 forge 逐行回调，暂不接」）。
 * 于是界面在几十秒到几分钟里只能显示一句「正在蒸馏…」，看不出走到哪 ——
 * 用户的原话是「很塑料，很拉」。
 *
 * 一个**声明了但永远是 null** 的字段最坏的地方是它看起来是接好的：
 * 读代码的人会以为阶段已经有了，而界面上没显示是渲染层的疏漏。
 * 所以这里锁的是「这条链路真的通」，而不只是「类型对得上」。
 */
describe("★ forge 阶段要能推到 UI（那个字段曾经永远是 null）", () => {
  it("★ 阶段回调 → progress().forge.step 跟着变", async () => {
    const seen: (string | null)[] = []
    const { service, vault } = makeService({
      runForge: (_signal, onStep) => {
        // 按真实顺序走一遍三个阶段，每步之后记一次界面能看到的值
        onStep?.("pull")
        seen.push(service.progress().forge.step)
        onStep?.("build")
        seen.push(service.progress().forge.step)
        onStep?.("publish")
        seen.push(service.progress().forge.step)
        return Promise.resolve(ok())
      },
    })
    service.start()
    await vi.waitFor(() => {
      expect(service.progress().forge.lastRunAt).not.toBeNull()
    })
    expect(seen).toEqual(["pull", "build", "publish"])
    await service.detach()
    vault.close()
  })

  it("跑之前是 null（没在跑就没有「正在哪一步」）", () => {
    const { service, vault } = makeService({ runForge: () => Promise.resolve(ok()) })
    expect(service.progress().forge.step).toBeNull()
    void service.detach()
    vault.close()
  })

  it("跑完之后回到 null（成功时「停在哪」没有意义）", async () => {
    const { service, vault } = makeService({
      runForge: (_signal, onStep) => {
        onStep?.("publish")
        return Promise.resolve(ok())
      },
    })
    service.start()
    await vi.waitFor(() => {
      expect(service.progress().forge.lastRunAt).not.toBeNull()
    })
    expect(service.progress().forge.running).toBe(false)
    expect(service.progress().forge.step).toBeNull()
    await service.detach()
    vault.close()
  })

  it("★ 意外抛出时**保留** step —— 那是「崩在哪」的唯一线索", async () => {
    /**
     * 正常失败走 `result.failedStep`（run 不抛，每步失败都带着停在哪返回）。
     * 走到 catch 里说明是意外（进程崩 / Python 环境炸），那时
     * `failedStep` 是 null —— 如果连 step 也清掉，就没有任何定位信息了。
     */
    const { service, vault } = makeService({
      runForge: (_signal, onStep) => {
        onStep?.("build")
        return Promise.reject(new Error("python 进程没了"))
      },
    })
    service.start()
    await vi.waitFor(() => {
      expect(service.progress().forge.lastOk).toBe(false)
    })
    const forge = service.progress().forge
    expect(forge.running).toBe(false)
    expect(forge.failedStep).toBeNull()
    // ★ 崩在 build —— 这一条是这组用例的全部意义
    expect(forge.step).toBe("build")
    await service.detach()
    vault.close()
  })
})

/**
 * ★★ 用户选的时间范围必须真的传到 forge。
 *
 * ## 修复前的形态：`days` 走到 `start()` 就沉了
 *
 * 引导第 3 步那个「30 / 90 / 180 天」选择器把 `days` 一路传进
 * `distill.start({ days })`，而 `start()` **只在 LLM 那条路上读它**
 * （`runner.plan`）。forge 那条路（也就是默认路径）调的是
 * `runForgeStep()` —— 一个不接参数的方法，于是 `since` 恒为 `null`。
 *
 * 后果不报错、也不显示：forge 按 `--since auto` 跑，首次退化成
 * `analysisStart`（库里最早那条消息的日期）。也就是**选什么都一样**。
 * 实测这台机器：`scope_json` 记着 `{"since":1770080941327}`（180 天前），
 * 而 forge 实际从 2026-07-23（10 天前）起跑 —— 两处不一致且无人对账。
 */
describe("★★ 选的时间范围要真的到 forge", () => {
  it("★★ days 换算成绝对起点传给 runForge（曾经恒为 null）", async () => {
    let seen: number | null | undefined = undefined
    const { service, vault } = makeService({
      runForge: (_signal, _onStep, since) => {
        seen = since
        return Promise.resolve(ok())
      },
    })

    service.start({ days: 180 })
    await vi.waitFor(() => {
      expect(service.progress().forge.lastOk).toBe(true)
    })

    // 180 天前那个绝对时间点 —— 不是 undefined，也不是 null
    expect(seen, "days 必须换算成 since 传下去，否则选多久都一样").toBe(NOW - 180 * 86_400_000)
    await service.detach()
    vault.close()
  })

  it("★ 不同的 days 得到不同的 since（锁住「真的读了那个值」）", async () => {
    /**
     * 上一条只证明"传了个数"。这一条证明传的是**用户选的那个数** ——
     * 写死成任何常量（比如永远 180 天）都会让这条红。
     */
    const seen: (number | null | undefined)[] = []
    const { service, vault } = makeService({
      runForge: (_signal, _onStep, since) => {
        seen.push(since)
        return Promise.resolve(ok())
      },
    })

    service.start({ days: 30 })
    // 等这一轮真正收尾：`inFlight` 非空时 `start` 会被幂等地忽略
    await vi.waitFor(() => expect(service.progress().forge.running).toBe(false))
    service.start({ days: 90 })
    await vi.waitFor(() => expect(seen).toHaveLength(2))

    expect(seen[0]).toBe(NOW - 30 * 86_400_000)
    expect(seen[1]).toBe(NOW - 90 * 86_400_000)
    await service.detach()
    vault.close()
  })

  it("★ 不传 days = null（不限范围，走 forge 自己的增量水位）", async () => {
    let seen: number | null | undefined = undefined
    const { service, vault } = makeService({
      runForge: (_signal, _onStep, since) => {
        seen = since
        return Promise.resolve(ok())
      },
    })

    service.start()
    await vi.waitFor(() => {
      expect(service.progress().forge.lastOk).toBe(true)
    })

    // null 而不是 undefined：`--since auto` 是一个明确的选择，不是"忘了传"
    expect(seen).toBeNull()
    await service.detach()
    vault.close()
  })

  it("★★ 自动重蒸走 null，**不**沿用用户选的范围", async () => {
    /**
     * 那个范围是"这次重来一遍，回溯多远"的意思 —— 一次性的动作参数。
     * 自动重蒸要的是"把新攒的语料续上"，拿 180 天去跑定时任务
     * 等于每 6 小时重测半年，而 `--since auto` 正是为这件事存在的。
     */
    vi.useFakeTimers()
    const seen: (number | null | undefined)[] = []
    const { service, vault } = makeService({
      autoIntervalMs: 1000,
      runForge: (_signal, _onStep, since) => {
        seen.push(since)
        return Promise.resolve(ok())
      },
    })

    // 用户显式跑一轮，选 180 天
    service.start({ days: 180 })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toBe(NOW - 180 * 86_400_000)

    // 定时器到点自动跑一轮
    await vi.advanceTimersByTimeAsync(1100)
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(2))

    expect(seen[1], "自动重蒸不该重测半年").toBeNull()
    await service.detach()
    vault.close()
  })
})

/**
 * ★★ 选的时间范围还要限住**测量**，不只是采集。
 *
 * ## 为什么修完 `since` 还不够
 *
 * 上面那组锁住了「days → since」，也就是**采集**下界。但 forge 的 `build`
 * 从不受 `since` 约束：它每次都全量重扫派生库里的**全部**语料。
 *
 * 于是只要语料库里已经有更早的历史 —— 用户上次选过宽范围，或
 * `ForgeService.resolveSince` 判定"vault 比 forge 语料更早"而回扫补过 ——
 * 选 30 天与选 180 天**产出仍然完全相同**。症状与那个已修的 bug 一模一样，
 * 而且同样静默：pull 如实只采 30 天，build 照常出数字，grade 可能还是 A。
 *
 * 所以同一个 days 还要作为 `build --window-days` 传下去。窗口是非破坏性的：
 * 语料一条不删，下次选「不限」就又是全量（见 `Rules.window_clause`）。
 */
describe("★★ 选的时间范围要限住测量窗口，不只是采集", () => {
  it("★★ days 同时作为测量窗口传给 runForge", async () => {
    let seen: number | null | undefined = undefined
    const { service, vault } = makeService({
      runForge: (_signal, _onStep, _since, windowDays) => {
        seen = windowDays
        return Promise.resolve(ok())
      },
    })

    service.start({ days: 30 })
    await vi.waitFor(() => {
      expect(service.progress().forge.lastOk).toBe(true)
    })

    expect(seen, "只限采集不限测量 → 库里已有的更早语料照样被测进画像").toBe(30)
    await service.detach()
    vault.close()
  })

  it("★ 不同的 days 得到不同的窗口（锁住「真的读了那个值」）", async () => {
    const seen: (number | null | undefined)[] = []
    const { service, vault } = makeService({
      runForge: (_signal, _onStep, _since, windowDays) => {
        seen.push(windowDays)
        return Promise.resolve(ok())
      },
    })

    service.start({ days: 30 })
    await vi.waitFor(() => expect(service.progress().forge.running).toBe(false))
    service.start({ days: 180 })
    await vi.waitFor(() => expect(seen).toHaveLength(2))

    expect(seen[0]).toBe(30)
    expect(seen[1]).toBe(180)
    await service.detach()
    vault.close()
  })

  it("★ 不传 days = null（全量测量）", async () => {
    let seen: number | null | undefined = undefined
    const { service, vault } = makeService({
      runForge: (_signal, _onStep, _since, windowDays) => {
        seen = windowDays
        return Promise.resolve(ok())
      },
    })

    service.start()
    await vi.waitFor(() => {
      expect(service.progress().forge.lastOk).toBe(true)
    })

    // null 而不是 undefined：「不限」是一个明确的选择，不是"忘了传"
    expect(seen).toBeNull()
    await service.detach()
    vault.close()
  })

  it("★★ 自动重蒸**沿用**测量窗口（与 since 相反）", async () => {
    /**
     * 两个参数的时效性不同，所以自动重蒸对它们的处理必须相反：
     *
     * · `since` 是一次性动作参数（「这次回溯多远」）→ 不沿用，否则每 6 小时
     *   重采半年；
     * · `windowDays` 是长期口味（「我要一个反映最近 30 天的画像」）→ 必须沿用，
     *   否则用户选的 30 天窗口会在 6 小时后被定时任务悄悄换回全量，
     *   而界面上没有任何迹象说画像变了。
     */
    vi.useFakeTimers()
    const seen: { since?: number | null; windowDays?: number | null }[] = []
    const { service, vault } = makeService({
      autoIntervalMs: 1000,
      runForge: (_signal, _onStep, since, windowDays) => {
        seen.push({ since, windowDays })
        return Promise.resolve(ok())
      },
    })

    service.start({ days: 30 })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]?.windowDays).toBe(30)

    await vi.advanceTimersByTimeAsync(1100)
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(2))

    expect(seen[1]?.since, "自动重蒸不该重采半年").toBeNull()
    expect(seen[1]?.windowDays, "自动重蒸不该把窗口悄悄换回全量").toBe(30)
    await service.detach()
    vault.close()
  })
})

/**
 * ★★ 蒸馏完要**立刻**踢一轮图谱同步。
 *
 * ## 这修的是"点了开始学习不会建图"
 *
 * 建图由 `GraphSync` 的定时轮询驱动（10 分钟一轮），而蒸馏完成原来
 * **不叫醒它**。用户点完「开始学习」，蒸馏几十秒就跑完了，图谱那边
 * 却毫无动静 —— 最多要干等 10 分钟。同事机器实测的时间线：
 *
 * ```
 * 09:53:35  forge run finished          ← 蒸馏完了
 * 09:59:43  graph export synced         ← 6 分钟后才轮到
 * 10:01:10  graph auto-built
 * ```
 * 中间 6 分钟零动作。所以那个判断从用户视角看是对的 —— 它只是没接上。
 *
 * ★ 这条线**断了不会有任何报错**（图谱迟一会儿仍然会建），所以只能靠
 * 测试锁住。而它恰好又是最容易在重构里被顺手删掉的那种一行注入。
 */
describe("★★ 蒸馏完立刻踢图谱同步（否则要干等 10 分钟）", () => {
  it("★★ 成功一轮 → 踢一次", async () => {
    let kicked = 0
    const { service, vault } = makeService({
      runForge: () => Promise.resolve(ok()),
      onCorpusReady: () => {
        kicked += 1
      },
    })
    service.start()
    await vi.waitFor(() => {
      expect(service.progress().forge?.running).toBe(false)
    })
    expect(kicked).toBe(1)
    vault.close()
  })

  /**
   * ★ 蒸馏失败**也要**踢 —— 与 `onProfileChanged` 刻意不同。
   *
   * 那个通知的语义是"画像变了"（失败时磁盘上还是旧的，所以不通知）；
   * 这个的语义是"该看一眼要不要同步图谱了"，而**导出与蒸馏是两件事**：
   * 蒸馏挂了不代表那批消息不该进图谱。要不要真建由 `decideAutoBuild`
   * 自己判（没新数据 / 没配网关时它跳过，不会白烧 LLM）。
   */
  it("★ 蒸馏失败也踢（导出与蒸馏是两件事）", async () => {
    let kicked = 0
    const { service, vault } = makeService({
      runForge: () =>
        Promise.resolve(ok({ ok: false, failedStep: "build", reason: "python 挂了" })),
      onCorpusReady: () => {
        kicked += 1
      },
    })
    service.start()
    await vi.waitFor(() => {
      expect(service.progress().forge?.running).toBe(false)
    })
    expect(kicked).toBe(1)
    vault.close()
  })
})

/**
 * ★★ work 层必须攒批，不能跟着 forge 每轮都跑。
 *
 * forge 免费（零模型调用，实测 4400 条约 5 秒），所以它挂在 6 小时定时器上
 * 无所谓。work 层每个 facet 是一次上万 token 的调用 —— 挂同一个定时器就是
 * **每天 4 次为同一批老语料付钱**，而那正是 LLM 那半当年被整个关掉的原因
 * （产出没人读、成本照付、且不报错）。原样复活那个成本模型等于把当时的结论作废。
 *
 * 判据本身在 `tests/unit/distill/work-refresh.test.ts` 里逐条锁了；
 * 这里锁的是**接线**：定时器真的走了那个判据，而不是绕过它直接抽。
 */
describe("★★ 自动轮里的 work 层要过攒批判据", () => {
  it("★★ 默认（llmFacets 关）自动轮不跑 work 层", async () => {
    vi.useFakeTimers()
    let wrote = 0
    const { service, vault } = makeService({
      autoIntervalMs: 1000,
      runForge: () => Promise.resolve(ok()),
      writeWorkFile: () => {
        wrote += 1
      },
      // 产物不在 = 判据的「首次」分支成立 —— 唯一挡住它的只能是 llmFacets 关着
      workArtifactExists: () => false,
    })

    await vi.advanceTimersByTimeAsync(1100)
    await vi.waitFor(() => expect(service.progress().forge.lastRunAt).not.toBeNull())

    /**
     * forge 跑了，work 层没跑。这条红了意味着一个默认配置的用户
     * 每 6 小时被计一次费，而他从没打开过这个功能。
     *
     * ★ 断言的是**结果**（没有产生费用）而不是某一行代码，所以实现怎么变
     * 它都还成立 —— 那是刻意的：这里要守的性质是"默认配置不花钱"。
     *
     * （曾经这里写着"有两道防线，其中一道是关着时 runner 根本没被造出来"。
     * runner 现在是**懒建**的了 —— 因为按开关建一次会让"登录后打开开关"
     * 静默无效。也就是说那一道防线已经不存在，而这条断言不受影响。）
     */
    expect(wrote, "关着的 work 层不该被定时器跑起来").toBe(0)
    await service.detach()
    vault.close()
  })

  /**
   * ★★ 开关是**运行中**可改的 —— 打开之后下一轮就该生效，不用重启。
   *
   * ## 这条锁的是一个真实踩过的形态
   *
   * `attach()` 只在登录那一刻跑,而开关在设置页里随时能改。原来 runner 是在
   * `attach()` 里"按开关建一次"的,于是「登录 → 打开开关」这条最自然的路径下
   * runner 永远是 null,那一轮 `if (runner === null) return` **静默返回**：
   * 用户看到"我开了开关但它没反应",日志里连一行都没有。
   *
   * 所以 runner 改成懒建。这条断言就是那个改动的门禁 —— 它红了说明
   * "打开开关要重启才生效"回来了,而那件事在界面上是看不出来的。
   */
  it("★★ 运行中打开开关,下一轮就生效（不需要重启/重新登录）", async () => {
    vi.useFakeTimers()
    const ref = { on: false }
    let wrote = 0
    const { service, vault } = makeService({
      autoIntervalMs: 1000,
      llmFacetsRef: ref,
      llm: fakeLlm(),
      runForge: () => Promise.resolve(ok()),
      writeWorkFile: () => {
        wrote += 1
      },
      workArtifactExists: () => false,
    })

    /**
     * ★ 先让库里有"新数据"。
     *
     * 判据的「首次」分支要求 `latestSeq > 0`（`latestSeq === 0` → `no-new-data`）
     * —— 空库里 work 层无论开关如何都会跳过，那样这条用例就成了一条
     * 永远绿的空用例：它验的是"空库不跑"，而不是"开关生效"。
     */
    new ChangelogRepository(vault.db).append([
      {
        op: "upsert" as const,
        entityType: "message" as const,
        entityId: "m-1",
        channelId: "dingtalk" as const,
        domain: "chat" as const,
        occurredAt: NOW,
        emittedAt: NOW,
        digest: "d-1",
      },
    ])

    // 第一轮：关着 —— 不该有任何花费
    await vi.advanceTimersByTimeAsync(1100)
    await vi.waitFor(() => expect(service.progress().forge.lastRunAt).not.toBeNull())
    expect(wrote, "关着时不该跑").toBe(0)

    // 用户在设置页打开开关（服务已经 attach 过了，不重启、不重新登录）
    ref.on = true

    /**
     * 第二轮：开着 —— 现在该跑起来了。
     *
     * ★ 断言 `>= 1` 而不是 `=== 1`：这里要守的是"打开之后真的会跑",
     * 而不是"恰好跑几次"。次数受攒批判据与轮数上限影响,钉死它会让
     * 一个正确的判据调整误报成回归。
     */
    await vi.advanceTimersByTimeAsync(1100)
    await vi.waitFor(() => expect(wrote).toBeGreaterThanOrEqual(1))
    await service.detach()
    vault.close()
  })

  /**
   * ★★ 打开开关要**立刻**评估一次，不等 6 小时的下一轮。
   *
   * 实测踩到的形态：开关打开于 19:33:57，而最后一轮蒸馏是 19:33:34（早 23 秒）
   * —— 于是那一晚什么都没发生。而界面上**不会说"在等下一轮"**，
   * 用户看到的就是"我开了开关，它没反应"。
   */
  it("★★ 打开开关立刻评估一次（不用等下一个周期）", async () => {
    const ref = { on: false }
    let wrote = 0
    const { service, vault } = makeService({
      // ★ 定时器**关掉** —— 那样"跑了"只可能是开关触发的，不会是周期到了
      autoIntervalMs: 0,
      llmFacetsRef: ref,
      llm: fakeLlm(),
      runForge: () => Promise.resolve(ok()),
      writeWorkFile: () => {
        wrote += 1
      },
      workArtifactExists: () => false,
    })
    new ChangelogRepository(vault.db).append([
      {
        op: "upsert" as const,
        entityType: "message" as const,
        entityId: "m-toggle",
        channelId: "dingtalk" as const,
        domain: "chat" as const,
        occurredAt: NOW,
        emittedAt: NOW,
        digest: "d-toggle",
      },
    ])

    // 用户在设置页打开开关 → IPC handler 落库后调这个
    ref.on = true
    service.workLayerToggled(true)

    await vi.waitFor(() => expect(wrote).toBeGreaterThanOrEqual(1))
    await service.detach()
    vault.close()
  })

  /**
   * ★ **关掉**开关不该产生任何花费。
   *
   * ★ 诚实说明这条能锁住什么：它断言的是**结果**（没有花钱），而这件事有
   * **两道**防线 —— `workLayerToggled` 里的 `if (!enabled) return`，以及判据
   * 自己的 `disabled` 分支。实测拆掉前者这条仍然绿（后者接住了）。
   *
   * 那是刻意保留的：这里要守的性质是"关着就不花钱"，而不是"哪一行挡住了它"
   * —— 与上面「默认配置不跑」那条同一个判断。想锁住某一行的方向，
   * 该锁的是那一行的单元行为，而不是把这条改成白盒断言。
   */
  it("★ 关掉开关不产生任何花费（结果断言，两道防线）", async () => {
    const ref = { on: true }
    let wrote = 0
    const { service, vault } = makeService({
      autoIntervalMs: 0,
      llmFacetsRef: ref,
      llm: fakeLlm(),
      runForge: () => Promise.resolve(ok()),
      writeWorkFile: () => {
        wrote += 1
      },
      workArtifactExists: () => false,
    })

    ref.on = false
    service.workLayerToggled(false)

    // 给它机会跑（如果真触发了，这段时间足够写一次）
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(wrote, "关掉开关竟然触发了一轮付费抽取").toBe(0)
    await service.detach()
    vault.close()
  })

  /**
   * ★★ 「开始学习」**只跑 forge**，绝不在引导里跑 work 层。
   *
   * ## 这一条锁的是引导流程的核心取舍
   *
   * 原来这里断言的是「手动跑完之后游标前进」—— 那个前提是"开始学习也跑
   * work 层"，而那正是被推翻的设计：
   *
   * | | forge | work 层 |
   * | --- | --- | --- |
   * | 耗时 | 实测 **5 秒** | 一轮最多 **40 分钟** |
   * | 成本 | 零（纯 Python） | 每轮几万 token |
   * | 产出 | 语气/句长/时延 —— 数字人**能用**的最小集 | 职责/流程/套路（增强） |
   *
   * 引导要回答的是「现在能用了吗」，而 forge 跑完就能用。让用户在引导页
   * 干等 40 分钟去换一层**增强**是把主次搞反了 —— 而且设置页那个开关的
   * 说明原文就写着「蒸馏在后台跑（6 小时一轮）」，同步跑等于当场违背它。
   *
   * ★ 所以这条断言反过来：开关开着时点「开始学习」，**forge 跑了、
   * work 层没跑**。work 层的入口只有后台三条（attach 评估 / 6 小时定时器 /
   * 用户打开开关）。
   */
  it("★★ 开关开着时点「开始学习」：forge 跑、work 层不跑", async () => {
    let forgeRuns = 0
    let wrote = 0
    const { service, vault } = makeService({
      // ★ 定时器与 attach 评估都关掉，那样"跑了"只可能是 start() 触发的
      autoIntervalMs: 0,
      llmFacets: true,
      llm: fakeLlm(),
      runForge: () => {
        forgeRuns += 1
        return Promise.resolve(ok())
      },
      writeWorkFile: () => {
        wrote += 1
      },
      // ★ 产物"已存在" → attach 那次评估会因攒批判据跳过，不干扰这条断言
      workArtifactExists: () => true,
    })

    service.start({ days: null })
    await vi.waitFor(() => expect(forgeRuns).toBeGreaterThanOrEqual(1), { timeout: 5000 })

    // ★ forge 跑了 —— 引导要等的就是它
    expect(forgeRuns, "点了开始学习却没跑 forge —— 引导页会一直等").toBe(1)
    /**
     * ★★ 而 work 层没写产物。
     *
     * 写了就说明它在引导里同步跑了 —— 那会让用户干等几十分钟，
     * 且与开关说明的「后台跑」矛盾。
     */
    expect(wrote, "「开始学习」把 work 层也跑了 —— 用户会被堵在引导页几十分钟").toBe(0)

    await service.detach()
    vault.close()
  })

  /**
   * ★★ 开关**已经是开**的情况必须被覆盖 —— 这是最常见的那一种。
   *
   * ## 实测踩到的形态
   *
   * 用户上次会话里开了开关，然后重启应用。这一次启动**没有"打开"这个动作**，
   * 于是三条路一条都不通：点击触发（这次没点）、自动轮（6 小时后）、
   * 手动「开始学习」（要主动点）。结果是**开关明明是开的，却什么都不发生**，
   * 而界面上不会说在等什么。
   *
   * 实测证据：开关 true、模型配着、语料 3.4 万条、任务 70 条 pending、
   * work.md 不存在、日志里 0 条 work layer 记录。
   *
   * 所以 `attach()`（每次登录/切 vault）要评估一次。
   */
  it("★★ 登录时开关已是开 → 评估一次（不需要重新点开关）", async () => {
    let wrote = 0
    // ★ 定时器关掉、不点开关、不点开始学习 —— 那样"跑了"只可能是 attach 触发的
    const { service, vault } = makeService({
      autoIntervalMs: 0,
      llmFacets: true,
      llm: fakeLlm(),
      runForge: () => Promise.resolve(ok()),
      writeWorkFile: () => {
        wrote += 1
      },
      workArtifactExists: () => false,
      // ★ 在 attach **之前**就把新数据放进库里：attach 那一次评估要看得到它
      seedChangelog: true,
    })

    await vi.waitFor(() => expect(wrote).toBeGreaterThanOrEqual(1), { timeout: 5000 })
    await service.detach()
    vault.close()
  })

  it("★★ 没有可用的 LLM 时不跑（不刷一轮注定失败的调用）", async () => {
    vi.useFakeTimers()
    let wrote = 0
    const { service, vault } = makeService({
      autoIntervalMs: 1000,
      llmFacets: true,
      runForge: () => Promise.resolve(ok()),
      writeWorkFile: () => {
        wrote += 1
      },
      workArtifactExists: () => false,
    })

    await vi.advanceTimersByTimeAsync(1100)
    await vi.waitFor(() => expect(service.progress().forge.lastRunAt).not.toBeNull())

    /**
     * `makeService` 注入的是 `staticLlmProvider(null)` —— 没有 client。
     * 起了的结果是每轮抛一次 `CONFIG_INVALID` 并刷一条同样的 warn，
     * 而用户以为它在抽。
     */
    expect(wrote).toBe(0)
    await service.detach()
    vault.close()
  })
})

/**
 * ★★ forge 与 work 层的**先后与让路**规则。
 *
 * ## 这一组锁的是一次真实的用户体验事故
 *
 * 原来的顺序是「work 层任务排空 → 才跑 forge」，而 work 层一轮最多 40 分钟。
 * 加上"建图在跑就让路"之后，`return` 把 forge 一起跳过了 —— 后果有两个，
 * 都不报错：
 *
 * · **语气那一层迟迟不出** —— 而 forge 是纯 Python、零模型调用、实测 5 秒；
 * · **`SKILL.md` 永远修不好** —— 那份索引表决定 ACP 路的 agent 能不能
 *   *发现* `references/work.md`。实测磁盘上那份是旧的（缺 work.md 一行），
 *   于是 work 层写了产物却没人读 —— 整层白做的那个形态。
 *
 * 现在的规则：**forge 先跑且从不让路 → work 层（可让路）→ 若跑完再 publish
 * 一次让索引表与产物对齐**。
 */
describe("★★ forge 先跑、不让路；work 完成后再 publish", () => {
  it("★★ 建图在跑时：forge 仍然跑，work 层让路", async () => {
    let forgeRuns = 0
    let wrote = 0
    const { service, vault } = makeService({
      autoIntervalMs: 0,
      llmFacets: true,
      llm: fakeLlm(),
      seedChangelog: true,
      workArtifactExists: () => false,
      graphBusy: () => true, // ← 建图一直在跑
      runForge: () => {
        forgeRuns += 1
        return Promise.resolve(ok())
      },
      writeWorkFile: () => {
        wrote += 1
      },
    })

    // makeService 里已经 attach → 那一次评估会跑（见「登录时开关已是开」那条）
    await vi.waitFor(() => expect(forgeRuns).toBeGreaterThanOrEqual(1), { timeout: 5000 })

    // ★ forge 跑了（语气那层是新的）—— 这是这条断言的全部意义
    expect(forgeRuns, "建图在跑就把 forge 一起跳过了 —— 语气层永远不更新").toBe(1)
    // ★ 而 work 层让路：没写产物（它在 graphBusy 分支前就 return 了）
    expect(wrote).toBe(0)
    await service.detach()
    vault.close()
  })

  it("★★ 建图空闲时：work 层跑完 → forge 再 publish 一次（索引表跟上产物）", async () => {
    let forgeRuns = 0
    const { service, vault } = makeService({
      autoIntervalMs: 0,
      llmFacets: true,
      llm: fakeLlm(),
      seedChangelog: true,
      workArtifactExists: () => false,
      graphBusy: () => false,
      runForge: () => {
        forgeRuns += 1
        return Promise.resolve(ok())
      },
      writeWorkFile: () => undefined,
    })

    await vi.waitFor(() => expect(forgeRuns).toBeGreaterThanOrEqual(2), { timeout: 8000 })

    /**
     * ★ 两次：开头一次（先出语气）+ 结尾一次（work 写完产物后让 SKILL.md 跟上）。
     *
     * 只有一次的话就回到那个 bug：产物变了而索引表没变，
     * ACP 路的 agent 发现不了 `references/work.md`。
     */
    expect(forgeRuns, "work 写完产物之后没有再 publish —— SKILL.md 会停在旧版").toBe(2)
    await service.detach()
    vault.close()
  })
})
