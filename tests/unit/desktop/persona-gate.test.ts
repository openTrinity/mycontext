/**
 * 判定闸（`PersonaGate`）—— 参数拼装与「判定不可得」的每一条路。
 *
 * ## ★ 这个门禁锁的是三条「静默失效」
 *
 * 1. **`null` 不许等于放行。** 缺 Python、还没蒸馏过、输出读不懂、超时 ——
 *    全都返回 null，而调用点必须把它当降级。反过来做（读不懂就当通过）
 *    会让"没装 Python"变成"自动发送全放行"，而那在界面上与一切正常
 *    完全一样。这里只验闸自己返回 null；「null 时到底发不发」在
 *    `persona-service.test.ts` 里验（那边有真的发送路径）。
 *
 * 2. **单聊必须带 `--peer-open-id`。** `persona.py` 的 `_tail_with_lag` 在
 *    `single && !peer_open_id` 时直接返回空消息集 → `brief` 拿不到上下文、
 *    `fresh` 判 stale。也就是**所有单聊永远降级**，而单聊恰恰是最该
 *    自动回的那一类。这个错误不报错，只是"数字人不怎么自动回"。
 *
 * 3. **传的 id 必须是本地 id。** 判定层读我们自己的 `core.sqlite`
 *    （vault 源，`m.conversation_id` / `m.id` 都是本地主键）。传
 *    external_id 的话它一条都查不到 —— 同样静默。
 *
 * 用假 `ProcessRunner` 而不是真起 Python：真跑要有一份已发布的产物，
 * 而这里要验的是**我们**怎么拼参数、怎么处理坏输出 —— 那两件事与
 * 产物在不在无关。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createLogger } from "@mycontext/kernel"
import type { ResolvedPython } from "@mycontext/runtime-env"
import { PersonaGate } from "../../../apps/desktop/src/main/services/persona-gate.js"

const logger = createLogger("test", { level: "error" })
const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

const PYTHON: ResolvedPython = { path: "/usr/bin/python3", version: [3, 11, 0], source: "system" }

/**
 * 造一个「已发布过」的 skill 目录。
 *
 * 两个文件都要有：`available()` 断言的是**脚本与规则都在**，
 * 而不是"目录在" —— `installForgeSkills` 在还没蒸馏过时装 0 个包，
 * 那时目录存在但里面什么都没有。
 */
function publishedSkill(): string {
  const dir = mkdtempSync(join(tmpdir(), "mycontext-gate-"))
  dirs.push(dir)
  mkdirSync(join(dir, "scripts"), { recursive: true })
  mkdirSync(join(dir, "references"), { recursive: true })
  writeFileSync(join(dir, "scripts", "persona.py"), "# stub\n", "utf8")
  writeFileSync(join(dir, "references", "rules.json"), JSON.stringify({ policy: {} }), "utf8")
  return dir
}

/** 假 runner：记下每次 exec 的 spec，返回预设的 stdout / 退出码，或抛。 */
function fakeProcesses(behavior: { stdout?: string; exitCode?: number; throws?: unknown } = {}) {
  const specs: { args: string[]; cwd: string | undefined; timeoutMs: number | undefined }[] = []
  return {
    specs,
    processes: {
      exec: (spec: { args: string[]; cwd?: string; timeoutMs?: number }) => {
        specs.push({ args: spec.args, cwd: spec.cwd, timeoutMs: spec.timeoutMs })
        if (behavior.throws !== undefined) return Promise.reject(behavior.throws)
        return Promise.resolve({
          exitCode: behavior.exitCode ?? 0,
          stdout: behavior.stdout ?? "{}",
          stderr: "",
          timedOut: false,
        })
      },
    } as unknown as ConstructorParameters<typeof PersonaGate>[0]["processes"],
  }
}

function makeGate(
  behavior?: Parameters<typeof fakeProcesses>[0],
  python: ResolvedPython | null = PYTHON,
) {
  const runner = fakeProcesses(behavior)
  return { runner, gate: new PersonaGate({ logger, processes: runner.processes, python }) }
}

describe("★ 判定不可得的每一条路都返回 null", () => {
  it("缺 Python → null，而且**根本没起进程**", async () => {
    const dir = publishedSkill()
    const { gate, runner } = makeGate({}, null)

    expect(await gate.brief(dir, target({ messageId: "m1" }))).toBeNull()
    expect(await gate.check(dir, "收到")).toBeNull()
    expect(await gate.fresh(dir, target({ lastSeenId: "m1" }))).toBeNull()
    /**
     * 断言"没起进程"而不只是"返回 null"：拿一个不存在的解释器去 spawn
     * 也会返回 null（catch 住），但那要等一次进程启动失败 —— 而这一步
     * 每轮每会话都跑，缺 Python 的机器上会变成一串无谓的 spawn。
     */
    expect(runner.specs).toHaveLength(0)
  })

  it("还没蒸馏过（缺脚本/规则）→ null，不起进程", async () => {
    const empty = mkdtempSync(join(tmpdir(), "mycontext-gate-empty-"))
    dirs.push(empty)
    const { gate, runner } = makeGate()

    expect(await gate.brief(empty, target({ messageId: "m1" }))).toBeNull()
    expect(runner.specs).toHaveLength(0)
    expect(gate.available(empty)).toBe(false)
  })

  it("★ 只有目录、没有 rules.json → 仍然不可用", async () => {
    const half = mkdtempSync(join(tmpdir(), "mycontext-gate-half-"))
    dirs.push(half)
    mkdirSync(join(half, "scripts"), { recursive: true })
    writeFileSync(join(half, "scripts", "persona.py"), "# stub\n", "utf8")
    const { gate } = makeGate()
    /**
     * `rules.json` 是判定的**全部**依据（风险词表、ask 分类、band、scope）。
     * 只看脚本在不在的话，`persona.py` 会以 `_unavailable` 跑起来并
     * 一律给 draft —— 行为是对的，但我们会白起一个进程，而且日志里
     * 看不出是"缺规则"还是"这条真该人工"。
     */
    expect(gate.available(half)).toBe(false)
  })

  it("输出不是 JSON → null", async () => {
    const dir = publishedSkill()
    const { gate } = makeGate({ stdout: "Traceback (most recent call last):" })
    expect(await gate.brief(dir, target({ messageId: "m1" }))).toBeNull()
  })

  it("输出是 JSON 数组 / 字符串 → null（形状不对也算读不懂）", async () => {
    const dir = publishedSkill()
    expect(await makeGate({ stdout: "[]" }).gate.check(dir, "收到")).toBeNull()
    expect(await makeGate({ stdout: '"pass"' }).gate.check(dir, "收到")).toBeNull()
  })

  it("非 0 退出（这台机器没有语料）→ null", async () => {
    const dir = publishedSkill()
    const { gate } = makeGate({
      exitCode: 1,
      stdout: JSON.stringify({ degraded: "markdown-only" }),
    })
    expect(await gate.brief(dir, target({ messageId: "m1" }))).toBeNull()
  })

  it("进程抛（超时被杀）→ null，不往外抛", async () => {
    const dir = publishedSkill()
    const { gate } = makeGate({ throws: new Error("进程超时（15000ms）已终止") })
    /**
     * 不许往外抛：`handleBatch` 里这三处如果抛出去，supervisor 会把整轮
     * 记成 turn 失败并重试三次 —— 而判定层超时是**预期**会偶发的事，
     * 正确的处置是这一轮降级为草稿，不是重跑三次。
     */
    await expect(gate.fresh(dir, target({ lastSeenId: "m1" }))).resolves.toBeNull()
  })

  it("认不出的 verdict → null（而不是当成 draft）", async () => {
    const dir = publishedSkill()
    const { gate } = makeGate({ stdout: JSON.stringify({ verdict: "maybe", because: [] }) })
    /**
     * 两者对自动发送的效果一样（都降级），但记的原因不同：上游改了取值时
     * 我们要看到"判定层对不上"，而不是以为这条恰好该人工。
     */
    expect(await gate.brief(dir, target({ messageId: "m1" }))).toBeNull()
  })

  it("★ fresh 缺 stale 字段 → null，绝不默认成「不 stale」", async () => {
    const dir = publishedSkill()
    const { gate } = makeGate({ stdout: JSON.stringify({ verdict: "safe to proceed" }) })
    /**
     * 这是三个方法里唯一**直接**挡在真发送前面的那个。默认成 false
     * 等于把"读不懂输出"变成"可以发" —— 而读不懂的常见原因恰恰是
     * 上游改了字段名，也就是我们最不该乐观的时刻。
     */
    expect(await gate.fresh(dir, target({ lastSeenId: "m1" }))).toBeNull()
  })
})

describe("参数拼装", () => {
  it("★ 单聊带上 peer id 与 --single true", async () => {
    const dir = publishedSkill()
    const { gate, runner } = makeGate({
      stdout: JSON.stringify({ verdict: "reply", because: ["measured default"] }),
    })

    const verdict = await gate.brief(dir, {
      conversationExternalId: "conv-1",
      single: true,
      peerOpenId: "DPEER1",
      messageId: "m9",
    })

    expect(verdict).toMatchObject({
      verdict: "reply",
      because: ["measured default"],
      // 理解类字段：这个 stdout 里没有，于是各自的"没有"形态。
      // ★ `answering: null` 而不是一个空串的对象 —— 起草侧据此退回
      // 「回最后一条」，而一个 text 为空的对象会渲染出一个空引用块。
      answering: null,
      respondingTo: null,
      precedents: [],
    })
    /**
     * ★★ 测量面缺失时的**每一个**缺省方向。
     *
     * 这个 stdout 只有 `verdict` + `because`（老形态），所以它同时是
     * "上游把这些字段删了"的负例。三条缺省方向各有理由，混了任一条
     * 都会让"该拦的没拦"：
     */
    // ① 能力元数据 → false（判不了 → guard 必须更保守）。
    //    给 true 的话"上游改了字段名"会变成"风险检测恒通过"。
    expect(verdict?.classification.riskDetectable).toBe(false)
    expect(verdict?.classification.askKindDetectable).toBe(false)
    // ② 三态字段 → null（**判不了**），而不是 false（"确实不是"）。
    //    forge 自己的口径也是这个：every "cannot tell" is reported as null.
    expect(verdict?.classification.genuineAsk).toBeNull()
    expect(verdict?.classification.chitchat).toBeNull()
    // ③ 收件人认不出 → resolved false + band 视作最保守那一档
    expect(verdict?.recipient.resolved).toBe(false)
    // ④ 建议表为空 → defaultAction 退回 draft（一律出草稿，安全的那一侧）
    expect(verdict?.advice.defaultAction).toBe("draft")
    /**
     * ⑤ ★ 没有 context 段 → 当成**不是当前的**。
     *
     * 这一条方向最容易搞反：`source` 认不出时给 `"live"` 就是拿几小时前的
     * 语料当实时读。而 `degraded` 在真实产物里是**字符串**
     * （`"no live read available"`），写 `=== true` 会把它读成 false ——
     * `scripts/check-gate-parity.mjs` 拿真产物锁住了这一点。
     */
    expect(verdict?.context).toEqual({ source: "none", degraded: true })
    const args = runner.specs[0]?.args ?? []
    expect(args).toContain("brief")
    // 会话与消息都传**本地** id —— 判定层读的是我们自己的库
    expect(args).toContain("conv-1")
    expect(args).toContain("m9")
    // ★ 少了这两个，所有单聊永远降级（见文件头第 2 条）
    expect(args).toContain("--peer-open-id")
    expect(args).toContain("DPEER1")
    expect(args[args.indexOf("--single") + 1]).toBe("true")
    // `-B`：不许在产物目录里写 __pycache__（那个目录每次建 agent 都被覆盖拷）
    expect(args[0]).toBe("-B")
    // 有超时：没有的话一个卡住的判定进程会把这一轮永远挂住
    expect(runner.specs[0]?.timeoutMs).toBeGreaterThan(0)
  })

  it("群聊传 --single false，peer id 为空串", async () => {
    const dir = publishedSkill()
    const { gate, runner } = makeGate({
      stdout: JSON.stringify({ verdict: "draft", because: ["band S"] }),
    })

    const verdict = await gate.brief(dir, {
      conversationExternalId: "conv-2",
      single: false,
      peerOpenId: "",
      messageId: null,
    })

    expect(verdict?.verdict).toBe("draft")
    const args = runner.specs[0]?.args ?? []
    expect(args[args.indexOf("--single") + 1]).toBe("false")
    // messageId 为 null 时不传那个 flag（`brief` 会自己找最新的非本人消息）
    expect(args).not.toContain("--message-id")
  })

  it("check 把草稿正文原样传进去，并透出命中的问题", async () => {
    const dir = publishedSkill()
    const { gate, runner } = makeGate({
      stdout: JSON.stringify({ verdict: "block", issues: ["states a commitment"] }),
    })

    const review = await gate.check(dir, "我来处理，明天给你")

    expect(review?.verdict).toBe("block")
    expect(review?.issues).toEqual(["states a commitment"])
    const args = runner.specs[0]?.args ?? []
    expect(args).toContain("--text")
    expect(args).toContain("我来处理，明天给你")
  })

  it("fresh 把滞后原因带出来（那是唯一能解释「为什么没发」的地方）", async () => {
    const dir = publishedSkill()
    const { gate } = makeGate({
      stdout: JSON.stringify({
        stale: true,
        lagReason: "the local store is 300s behind (limit 150s)",
      }),
    })

    const freshness = await gate.fresh(dir, {
      conversationExternalId: "conv-1",
      single: true,
      peerOpenId: "DPEER1",
      lastSeenId: "m1",
    })

    expect(freshness?.stale).toBe(true)
    expect(freshness?.reason).toContain("300s behind")
  })

  it("issues / because 不是数组时退成空数组（不抛）", async () => {
    const dir = publishedSkill()
    const { gate } = makeGate({ stdout: JSON.stringify({ verdict: "pass", issues: "none" }) })
    /**
     * 坏形状不该让整轮失败：那会让 supervisor 重试三次，而重试改不了
     * 一个格式问题。降级成"没有细节"，判定本身仍然可用。
     */
    expect(await gate.check(dir, "收到")).toMatchObject({ verdict: "pass", issues: [] })
  })

  /**
   * ★★ 要到的是**另一条**消息时，`answering` 必须是 null。
   *
   * ## 这一条来自一次真机踩坑
   *
   * 会话 id 传了平台的 external id，而 forge 的语料按宿主内部 id 存 ——
   * 于是 `brief` 读到一个空窗口，回退到"最新那条对方消息"，输出一份
   * **形状完整、`verdict` 正常**的判定。没有任何报错，而它描述的是另一条
   * 消息（或什么都不是）。
   *
   * 产物侧现在带上 `requestedMessageFound: false`；这里必须把它当成
   * "没有理解"，否则起草会照着一条错的消息去写，而那在界面上与一切正常
   * 完全一样 —— 正是这个项目里反复出现的静默失效。
   */
  it("★ 指定的 message-id 没找到 → answering 为 null（不照着错的那条起草）", async () => {
    const dir = publishedSkill()
    const { gate } = makeGate({
      stdout: JSON.stringify({
        verdict: "reply",
        because: ["measured default"],
        answering: {
          // 产物回退到了别的消息：text 非空，但明确说了没找到要的那条
          text: "另一条消息的正文",
          lastText: "另一条消息的正文",
          messageCount: 1,
          requestedMessageId: "m-does-not-exist",
          requestedMessageFound: false,
        },
      }),
    })

    const verdict = await gate.brief(dir, {
      conversationExternalId: "conv-1",
      single: true,
      peerOpenId: "DPEER1",
      messageId: "m-does-not-exist",
    })

    // 判定本身仍然带出来（它只会更保守），但"要回什么"必须是"不知道"
    expect(verdict?.verdict).toBe("reply")
    expect(verdict?.answering).toBeNull()
  })
})

/**
 * ★★ `check` 的字段名 —— 一次真机对不上导致的全量降级。
 *
 * ## 这一组来自一次真实故障
 *
 * 真机跑 `python3 scripts/persona.py check --text "不知道"` 的实际输出是：
 *
 * ```json
 * { "result": "pass", "codepoints": 3, "problems": [], "guidance": "..." }
 * ```
 *
 * 而 gate 原来只读 `payload["verdict"]` / `payload["issues"]` —— 两个名字
 * **全对不上**，于是 `verdict` 恒 undefined → 落"未知 verdict"分支 → 返回 null
 * → `runCheck` 把 holdForReview 强置 true 并记 `review_gate_unavailable`。
 *
 * 现象：用户勾了白名单、开了 auto、蒸馏也发布了，**每一条草稿都进待审**，
 * UI 上写着一个看起来像"环境没装好"的原因 —— 而 gate 跑得好好的、还判了 pass。
 * 这正是本项目反复出现的那类失效：不报错、外观正常、能力静默消失。
 */
describe("★★ check 读产物真实字段（result / problems）", () => {
  it("★ `result: pass` + `problems: []` → pass（这是产物的真实形态）", async () => {
    const dir = publishedSkill()
    const { gate } = makeGate({
      // 与真机输出逐字段同形（`persona.py:328-330`）
      stdout: JSON.stringify({
        result: "pass",
        codepoints: 3,
        problems: [],
        guidance: "Matches the measured shape.",
      }),
    })
    expect(await gate.check(dir, "不知道")).toMatchObject({
      verdict: "pass",
      issues: [],
      // ★ 正文长度从产物读（guard 拿它与硬上限比，见 CheckVerdict 的注释）
      codepoints: 3,
      riskTags: [],
    })
  })

  it("★ `result: block` + problems 是对象数组 → 取每条的 detail 给用户看", async () => {
    const dir = publishedSkill()
    const { gate } = makeGate({
      stdout: JSON.stringify({
        result: "block",
        problems: [
          { severity: "block", kind: "risk", detail: "states a commitment" },
          { severity: "warn", kind: "length", detail: "longer than measured median" },
        ],
      }),
    })
    /**
     * `problems` 是 `{severity,kind,detail}` 的数组，不是字符串数组 ——
     * 直接 `stringList()` 会全部过滤掉，于是草稿卡上"为什么被扣下"是空的。
     * 用户看到一个没有原因的待审草稿，只会以为功能坏了。
     */
    expect(await gate.check(dir, "我来处理")).toMatchObject({
      verdict: "block",
      issues: ["states a commitment", "longer than measured median"],
    })
  })

  /**
   * ★ 结构化字段必须带出来，而不是让 guard 去匹配英文句子。
   *
   * `check` 在新架构里是**对草稿正文的测量**（见 docs/persona-architecture.md
   * 4.5）：它回答"这段正文里有什么"，由 guard 决定"那意味着什么"。
   * 只给 `issues`（人话）的话 guard 只能靠字符串匹配判断命中了哪一类 ——
   * 而那正是 `isScopeOnlyDowngrade` 当年干的事，也正是这次要消灭的形态。
   */
  it("★ risk_in_draft 以结构化形态带出（guard 不靠匹配英文句子判断）", async () => {
    const dir = publishedSkill()
    const { gate } = makeGate({
      stdout: JSON.stringify({
        result: "block",
        codepoints: 42,
        problems: [
          { severity: "block", kind: "risk_in_draft", detail: "the draft touches commitment" },
          { severity: "warn", kind: "joined_clauses", detail: "they would split this" },
        ],
      }),
    })

    const review = await gate.check(dir, "我来处理，明天给你")

    expect(review?.riskTags).toEqual(["the draft touches commitment"])
    expect(review?.codepoints).toBe(42)
    // `problems` 保留 kind/severity —— guard 按 severity 判"要不要人看"
    expect(review?.problems).toEqual([
      { severity: "block", kind: "risk_in_draft", detail: "the draft touches commitment" },
      { severity: "warn", kind: "joined_clauses", detail: "they would split this" },
    ])
  })

  it("codepoints 缺失时按正文长度兜底（而不是 0 —— 那会让长度闸恒通过）", async () => {
    const dir = publishedSkill()
    const { gate } = makeGate({ stdout: JSON.stringify({ result: "pass", problems: [] }) })
    // 产物没报 codepoints 时不能给 0：guard 拿它与上限比，0 意味着"永远不超长"
    expect((await gate.check(dir, "四个字啊"))?.codepoints).toBe(4)
  })

  it("`verdict` / `issues` 的老命名仍然认（留给产物改名）", async () => {
    const dir = publishedSkill()
    const { gate } = makeGate({
      stdout: JSON.stringify({ verdict: "warn", issues: ["something"] }),
    })
    expect(await gate.check(dir, "收到")).toMatchObject({ verdict: "warn", issues: ["something"] })
  })

  it("★ 反面：两个名字都没有 → 仍然 null（fail closed，不当成 pass）", async () => {
    const dir = publishedSkill()
    // 只有 problems、没有任何判定字段 —— 那是我们读不懂的输出
    const { gate } = makeGate({ stdout: JSON.stringify({ problems: [], codepoints: 3 }) })
    expect(await gate.check(dir, "收到")).toBeNull()
  })

  /**
   * ★★ 形状读不懂时**不能**静默变成"没有风险"。
   *
   * 压成 `[]` 在**字段缺失**时安全（那时 `riskDetectable` 必然 false）。
   * 但**类型不对**时不安全：上游哪天把 `"commitment"` 从数组改成标量，
   * 而 `riskDetectable` 仍正确地是 `true` —— 那时会得到"零个风险类"**且**
   * 没有第 ⑦ 条降级，于是判 reply。Python 侧会逐元素降级。
   *
   * 修法：形状读不懂时连带把 `riskDetectable` 打成 false，让 guard 走第 ⑦ 条。
   */
  it("★★ riskTags 是标量（上游改了形状）→ riskDetectable 打成 false", async () => {
    const dir = publishedSkill()
    const { gate } = makeGate({
      stdout: JSON.stringify({
        verdict: "reply",
        because: [],
        classification: {
          askKind: "status_chase",
          // 上游把它从数组改成了标量
          riskTags: "commitment",
          riskDetectable: true,
          askKindDetectable: true,
        },
      }),
    })
    const verdict = await gate.brief(dir, target({ messageId: "m1" }))
    expect(verdict?.classification.riskTags).toEqual([])
    expect(
      verdict?.classification.riskDetectable,
      "读不懂 riskTags 却仍报「风险可判」→ 该拦的一条都不拦",
    ).toBe(false)
  })

  it("★ 数组里混进非字符串 → 同样打成 false（那也是「读不懂」）", async () => {
    const dir = publishedSkill()
    const { gate } = makeGate({
      stdout: JSON.stringify({
        verdict: "reply",
        because: [],
        classification: {
          riskTags: ["commitment", 42],
          riskDetectable: true,
          askKindDetectable: true,
        },
      }),
    })
    expect(
      (await gate.brief(dir, target({ messageId: "m1" })))?.classification.riskDetectable,
    ).toBe(false)
  })

  it("★ 反面：形状正常时 riskDetectable 照实透出", async () => {
    const dir = publishedSkill()
    const { gate } = makeGate({
      stdout: JSON.stringify({
        verdict: "reply",
        because: [],
        classification: {
          riskTags: ["commitment"],
          riskDetectable: true,
          askKindDetectable: true,
        },
      }),
    })
    const verdict = await gate.brief(dir, target({ messageId: "m1" }))
    expect(verdict?.classification.riskDetectable).toBe(true)
    expect(verdict?.classification.riskTags).toEqual(["commitment"])
  })

  it("★ 反面：`result` 是认不出的取值 → null（不猜）", async () => {
    const dir = publishedSkill()
    const { gate } = makeGate({ stdout: JSON.stringify({ result: "maybe", problems: [] }) })
    expect(await gate.check(dir, "收到")).toBeNull()
  })
})

/** 三个方法共用的目标。默认单聊 + 有 peer id（也就是**能**判定的那种）。 */
function target<T extends Record<string, unknown>>(
  extra: T,
): { conversationExternalId: string; single: boolean; peerOpenId: string } & T {
  return { conversationExternalId: "conv-1", single: true, peerOpenId: "DPEER1", ...extra }
}
