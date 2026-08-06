/**
 * PersonaService 的门禁：workspace 物化与 skill 装入。
 *
 * ## ★ 锁的是三条"缺了不报错"的性质
 *
 * 1. **forge 的产物必须复制进 workspace。** harness 的 skill 发现是
 *    **按 cwd** 走的（`<cwd>/.opencode/skills/<name>/SKILL.md`）；
 *    只放在产物目录里 agent **看不到它**，表现为"不像本人"。
 * 2. **产物的正文必须真的进 system。** 只断言"文件被拷过去了"证明不了
 *    模型看见了它 —— 所以每份放一个哨兵串，断言哨兵串出现在请求里。
 * 3. **`AGENTS.md` 必须被读进 system。** 它带着会话身份、授权模式与用户
 *    手写的 `personaNote`。它曾经只被写出来没有读者，于是 personaNote
 *    完全失效 —— 落库了、进了文件、然后停在那里。
 *
 * 另外锁：产物缺失时**退回内置最小指引**而不是给空 system。
 * 给空的话模型会开始替本人承诺时间与结论 —— 那种草稿一旦发出去，
 * 代价不可逆。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ManualClock, createLogger } from "@mycontext/kernel"
import { LlmClient, staticLlmProvider } from "@mycontext/llm"
import {
  DEFAULT_RATE_LIMIT,
  DEFAULT_WORK_HOURS,
  IDLE_EVICT_MS,
  MAX_BATCH_SIZE,
  MAX_CONCURRENT_TURNS,
  MAX_RESIDENT_AGENTS,
  SEND_SCOPE,
} from "@mycontext/persona"
import {
  ConversationRepository,
  MessageRepository,
  PersonaConfigRepository,
  PersonaRunRepository,
  ProfileFacetRepository,
} from "@mycontext/store"
import { PersonaService } from "../../../apps/desktop/src/main/services/persona.service.js"
import { isScopeOnlyDowngrade } from "../../../apps/desktop/src/main/services/persona.service.js"
import type { PersonaGateLike } from "../../../apps/desktop/src/main/services/persona-gate.js"
import { openTestVault } from "../../helpers/vault.js"

const NOW = 1_785_000_000_000
const logger = createLogger("Test", { level: "error" })
const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/**
 * 造一个 forge 已发布过的 skill 目录。
 *
 * 形状照 forge 真实产物：`<slug>-persona/` 与 `<slug>-inbox/` 两个包，
 * 决策层在 `references/decisions.md`（+ 机器可读孪生 `rules.json`）。
 * 每份放一个哨兵串，用来断言它到底有没有被读进 system 指引 ——
 * 只断言"文件被拷过去了"证明不了模型看见了它。
 */
function makeForgeSkillRoot(): string {
  const dir = tempDir("mycontext-forge-skills-")
  const persona = join(dir, "persona-persona", "references")
  mkdirSync(persona, { recursive: true })
  writeFileSync(join(persona, "decisions.md"), "# 该不该回\n哨兵串：DECISIONS_SENTINEL\n", "utf8")
  writeFileSync(join(persona, "style.md"), "# 怎么说\n哨兵串：STYLE_SENTINEL\n", "utf8")
  writeFileSync(join(persona, "rules.json"), JSON.stringify({ policy: {} }), "utf8")
  // SKILL.md 带硬规则与「你在替谁说话」——它在 system 里必须排最后
  writeFileSync(
    join(dir, "persona-persona", "SKILL.md"),
    "# persona\n## Hard rules\n哨兵串：HARD_RULES_SENTINEL\n",
    "utf8",
  )
  const inbox = join(dir, "persona-inbox")
  mkdirSync(inbox, { recursive: true })
  writeFileSync(join(inbox, "SKILL.md"), "# inbox\n", "utf8")
  return dir
}

/**
 * 造一个"会调用检索工具"的假 LLM。
 *
 * 第一次请求返回 `tool_calls`，第二次返回正文 —— 与真实网关的形态一致
 * （实测 `finish_reason: "tool_calls"`）。
 * `bodies` 收集每次请求体，便于断言工具声明与回传形状。
 */
function toolCallingLlm(bodies: unknown[]): LlmClient {
  let call = 0
  return new LlmClient({
    baseUrl: "https://fake.invalid",
    apiKey: "k",
    model: "m",
    sleep: () => Promise.resolve(),
    fetchImpl: (_url, init) => {
      bodies.push(JSON.parse(String((init as RequestInit).body)))
      call += 1
      const message =
        call === 1
          ? {
              content: "",
              tool_calls: [
                {
                  id: "toolu_1",
                  type: "function",
                  function: {
                    name: "recall_conversation_history",
                    arguments: JSON.stringify({ query: "沙箱" }),
                  },
                },
              ],
            }
          : { content: "查到了，沙箱那事已经好了" }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            choices: [{ message, finish_reason: call === 1 ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }),
        text: () => Promise.resolve(""),
      } as unknown as Response)
    },
  })
}

/** 记录每次请求的 system 提示，便于断言"指引从哪来"。 */
function recordingLlm(systems: string[]): LlmClient {
  return new LlmClient({
    baseUrl: "https://fake.invalid",
    apiKey: "k",
    model: "m",
    sleep: () => Promise.resolve(),
    fetchImpl: (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as {
        messages: { role: string; content: string }[]
      }
      systems.push(body.messages.find((item) => item.role === "system")?.content ?? "")
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "好的" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        text: () => Promise.resolve(""),
      } as unknown as Response)
    },
  })
}

/**
 * 从实际跑出去的命令行里取某个 flag 的值。
 *
 * ★ 断言"审计表记的 == 真正传给 CLI 的"必须这么比：拿两个我们自己算的
 * 常量互相比是同义反复，只有拿**命令行实参**当真源才能发现"审计记了另一个值"。
 */
function sendArgAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

function seed() {
  const vault = openTestVault()
  new ConversationRepository(vault.db).upsert({
    id: "conv-1",
    channelId: "dingtalk",
    externalId: "cid-1",
    type: "group",
    title: "沙箱项目群",
    memberCount: 12,
    createdAt: NOW,
  })
  new MessageRepository(vault.db).upsertMany([
    {
      id: "m1",
      channelId: "dingtalk",
      conversationId: "conv-1",
      externalId: "ext-m1",
      senderExternalId: "other",
      senderDisplayName: "小李",
      contentText: "沙箱环境好了吗",
      sentAt: NOW,
      direction: "inbound",
      isSelf: false,
      createdAt: NOW,
    },
  ])
  // 一条画像结论 —— 物化时它会进 profile.md
  new ProfileFacetRepository(vault.db).write(
    {
      id: "f1",
      facet: "tone",
      scope: "global",
      scopeRef: "",
      key: "formality",
      value: "偏随意，爱用 bro",
      confidence: 0.9,
      evidence: ["m1"],
      source: "llm",
    },
    NOW,
  )
  new PersonaConfigRepository(vault.db).upsert("conv-1", { triggerMode: "all" }, NOW)
  return vault
}

function makeService(
  vault: ReturnType<typeof openTestVault>,
  options: { llm?: LlmClient; forgeSkillRoot?: string } = {},
) {
  const workspaceRoot = tempDir("mycontext-ws-")
  /**
   * 时钟要能**前进**：合并窗口比较的是 `now() - enqueuedAt`，
   * 冻住的时钟让差值恒为 0，于是 `takeBatch` 永远取不出批次
   * （表现是 tick 什么都不做，看起来像"调度没跑"）。
   * 用例里投递完显式 advance 过窗口。
   */
  const clock = new ManualClock(NOW)
  const service = new PersonaService({
    clock,
    logger,
    llmProvider: staticLlmProvider(options.llm ?? null),
    getWindow: () => null,
  })
  // 蒸馏产物按 vault 隔离，所以从 attach 传（与生产一致：登录时才知道是哪个 vault）
  // ★ agent 目录按 vault（attach 时给）：workspace 与 HOME 分身份，npm 缓存共用
  const dirs = {
    workspaceRoot,
    home: join(workspaceRoot, "agent-home"),
    npmCache: join(workspaceRoot, "npm-cache"),
  }
  service.attach(vault.db, options.forgeSkillRoot, dirs)
  // ★ `dirs` 一并返回：用例里模拟"重启"要重挂一次，那时必须是**同一套**目录
  // （同一个身份）—— 让用例自己再拼一份等于给了一个拼错的机会。
  return { service, workspaceRoot, clock, dirs }
}

/**
 * 走真实调度：投递 → **推过合并窗口与静默期** → tick。
 *
 * 推时钟而不是 sleep：真等的话每个用例慢好几秒。而两个判据本身要留着 ——
 * 合并窗口是"群里连发五条合成一轮回复"的实现，静默期是"不在对方打字中途
 * 起草"的实现（见 mailbox 的 DEFAULT_QUIET_MS）。
 *
 * ★ 推的量必须**同时**过两条线。只推 5 秒（够窗口、不够静默期）时
 * `takeBatch` 返回空批次，于是这一组用例全部拿不到草稿 —— 而失败信息是
 * "expected [] to have a length of 1"，看不出是时钟没推够。
 */
async function runOneTurn(
  service: PersonaService,
  vault: ReturnType<typeof openTestVault>,
  clock: ManualClock,
): Promise<void> {
  const supervisor = service.inboundSupervisor
  if (supervisor === null) throw new Error("supervisor 未就绪")
  // 这组测试关注 policy/发送行为，不测试历史消息过期；触发消息对齐当前测试时钟。
  vault.db.prepare("UPDATE messages SET sent_at = ? WHERE id = 'm1'").run(clock.now())
  const message = new MessageRepository(vault.db).findById("m1")
  const conversation = new ConversationRepository(vault.db).findById("conv-1")
  if (message === null || conversation === null) throw new Error("种子数据缺失")
  supervisor.onInbound({
    message,
    conversation,
    config: new PersonaConfigRepository(vault.db).get("conv-1"),
    mentionsSelf: false,
  })
  clock.advance(10_000)
  await service.tick()
}

describe("★ 画像与 skill 都必须进 workspace", () => {
  it("createAgent 写出 AGENTS.md，但**不再**渲染 facet 画像", async () => {
    const vault = seed()
    const { service, workspaceRoot, clock } = makeService(vault, {
      llm: recordingLlm([]),
    })
    await runOneTurn(service, vault, clock)

    const cwd = join(workspaceRoot, "persona", "conv-1")
    // AGENTS.md 是**复数** —— 单数不会被 harness 加载且不报错
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true)
    /**
     * ★ 画像整体改由 forge 产出，`knowledge/*.md` 不再生成。
     *
     * 断言它们**不存在**而不只是「不读它们」：留在盘上的旧文件会让
     * 两个真源并存 —— 同一件事（这个人怎么说话）由 LLM 抽的结论和 forge
     * 测的数字各说一遍，而模型会同时读到，冲突时谁也不知道该信哪个。
     */
    for (const stale of ["profile.md", "expertise.md", "spec.md", "rules.md"]) {
      expect(existsSync(join(cwd, "knowledge", stale)), `${stale} 不该再生成`).toBe(false)
    }
    // 入口仍要带会话身份与授权模式 —— 那是 forge 不可能知道的
    const entry = readFileSync(join(cwd, "AGENTS.md"), "utf8")
    expect(entry).toContain("沙箱项目群")
    expect(entry).toContain("只出草稿")

    await service.detach()
    vault.close()
  })

  /**
   * ★ 随包分发的 `reply` skill 已经删掉，不该再被装。
   *
   * 它的正文是一张指路表，指向 `knowledge/profile.md` / `rules.md` 等
   * 四个**已经不再生成**的文件，而它排在 system 的第一段 —— 也就是
   * prompt 的开头在说「先读 rules.md，它覆盖一切」，而那个文件不存在。
   *
   * 断言它不在，锁的是「不要为了兼容又把它加回来」：两套指引并存时
   * 模型会在 forge 的六步流程与那份自由文本之间自己挑一套，而挑哪套
   * 既不可预测也无法审计。
   */
  it("★ 不再装随包 reply skill（唯一入口是 forge 的 persona-persona）", async () => {
    const vault = seed()
    const { service, workspaceRoot, clock } = makeService(vault, {
      forgeSkillRoot: makeForgeSkillRoot(),
      llm: recordingLlm([]),
    })
    await runOneTurn(service, vault, clock)

    const skills = join(workspaceRoot, "persona", "conv-1", ".opencode", "skills")
    /**
     * ★ workspace 里既**不**该有 `reply/` 也**不**该有 `persona-persona/`。
     *
     * 走 opencode `skills.paths` 之后 skill 从共享目录扫，workspace 里不落副本 ——
     * 副本是 bug（旧行为），会让 61 个会话 = 61 份 skill，且蒸馏更新要等下次
     * createAgent 才生效。
     *
     * 曾经这里断言 `persona-persona/` 应在 workspace 里 —— 那锁的是旧的
     * cpSync 行为。现在锁的是"**不**要有副本"。
     */
    expect(existsSync(join(skills, "reply"))).toBe(false)
    expect(existsSync(join(skills, "persona-persona"))).toBe(false)

    await service.detach()
    vault.close()
  })
})

describe("★ system 指引来自 forge 的产物 + AGENTS.md，不是写死在代码里", () => {
  it("蒸馏过之后 system 里带 forge 产物的内容", async () => {
    const vault = seed()
    const systems: string[] = []
    const { service, clock } = makeService(vault, {
      forgeSkillRoot: makeForgeSkillRoot(),
      llm: recordingLlm(systems),
    })
    await runOneTurn(service, vault, clock)

    expect(systems).toHaveLength(1)
    // 产物里的哨兵串 —— 证明读的是文件而不是内置字符串
    expect(systems[0]).toContain("STYLE_SENTINEL")
    expect(systems[0]).toContain("DECISIONS_SENTINEL")
    expect(systems[0]).toContain("HARD_RULES_SENTINEL")
    /**
     * ★ facet 表里的结论**不该**再出现。
     *
     * `bro` 来自 seed 里那条 `tone` facet。它曾经被渲染进 profile.md 并拼进
     * system —— 现在画像只来自 forge，所以它必须消失。断言它不在，是防止
     * 「旧路径其实还留着一半」这种半迁移状态。
     */
    expect(systems[0]).not.toContain("bro")
    // 反面：有产物时**不该**出现退化标记
    expect(systems[0]).not.toContain("[内置退化指引]")

    await service.detach()
    vault.close()
  })

  it("★ 没蒸馏过时退回内置最小指引（不是给空 system）", async () => {
    const vault = seed()
    const systems: string[] = []
    // 不传 forgeSkillRoot → 一份产物都读不到 → 走退化路径
    const { service, clock } = makeService(vault, { llm: recordingLlm(systems) })
    await runOneTurn(service, vault, clock)

    expect(systems).toHaveLength(1)
    expect(systems[0]).not.toContain("STYLE_SENTINEL")
    /**
     * ★ 断言那个**可辨识的标记**，不是断言"不要编"这类措辞。
     *
     * 后者在 forge 的真产物里也存在，所以拿措辞当判据的话
     * 「把整段 fallback 删掉」照样全绿，门禁等于没有。
     * 标记只可能来自退化路径本身。
     */
    expect(systems[0]).toContain("[内置退化指引]")
    // 退化指引里那两条红线仍然要在（缺了模型会替本人承诺）
    expect(systems[0]).toContain("不要编")
    expect(systems[0]).toContain("承诺")

    await service.detach()
    vault.close()
  })

  /**
   * ★ AGENTS.md 必须真的进 system。
   *
   * 它曾经只被写出来、没有任何读者（注释说外部 harness 的
   * `instructionFiles` 会加载它 —— 那在走 opencode/ACP 的时代成立，
   * 而这条路径是自己拼 prompt 的）。后果是**用户手写的 personaNote
   * 完全失效**：落库了、进了文件、然后停在那里。
   *
   * 断言的是 personaNote 的原文出现在 system 里 —— 只断言
   * "AGENTS.md 存在" 证明不了模型看见了它，而那正是之前的状态。
   */
  it("★ AGENTS.md 进 system，用户手写的 personaNote 真的生效", async () => {
    const vault = seed()
    const systems: string[] = []
    new PersonaConfigRepository(vault.db).upsert(
      "conv-1",
      { triggerMode: "all", personaNote: "这个群只说中文，别用英文缩写" },
      NOW,
    )
    const { service, clock } = makeService(vault, {
      forgeSkillRoot: makeForgeSkillRoot(),
      llm: recordingLlm(systems),
    })
    await runOneTurn(service, vault, clock)

    const text = systems[0] ?? ""
    expect(text).toContain("这个群只说中文，别用英文缩写")
    // 会话身份也来自它（forge 的产物是全局的，不知道这是哪个群）
    expect(text).toContain("沙箱项目群")
    /**
     * 手写指示排在**最后**：同等篇幅下越靠后权重越高，而用户写定的
     * 东西必须压过一切测量结论（那是 renderEntry 里承诺的语义）。
     */
    expect(text.indexOf("这个群只说中文")).toBeGreaterThan(text.indexOf("STYLE_SENTINEL"))

    await service.detach()
    vault.close()
  })

  /**
   * ★ 必须明确否掉 forge SKILL.md 里那套命令。
   *
   * 那份文档是按命令驱动设计的（`persona.py brief` 给 verdict、
   * `facts` 核查事实），而这条路径只有一次模型调用加一个检索工具 ——
   * 那些命令跑不了。不说清的话模型会去调，失败之后的行为不可预测，
   * 而"自己编一个 verdict"是其中最坏的一种。
   */
  it("★ system 里说明这一轮没有 shell（否则模型会去跑 persona.py）", async () => {
    const vault = seed()
    const systems: string[] = []
    const { service, clock } = makeService(vault, {
      forgeSkillRoot: makeForgeSkillRoot(),
      llm: recordingLlm(systems),
    })
    await runOneTurn(service, vault, clock)

    const text = systems[0] ?? ""
    expect(text).toContain("persona.py")
    expect(text).toContain("跑不了")

    await service.detach()
    vault.close()
  })

  it("硬规则拼在最后（红线要压过前面的语气描述）", async () => {
    const vault = seed()
    const systems: string[] = []
    const { service, clock } = makeService(vault, {
      forgeSkillRoot: makeForgeSkillRoot(),
      llm: recordingLlm(systems),
    })
    await runOneTurn(service, vault, clock)

    const text = systems[0] ?? ""
    const styleAt = text.indexOf("STYLE_SENTINEL")
    const rulesAt = text.indexOf("HARD_RULES_SENTINEL")
    expect(styleAt).toBeGreaterThanOrEqual(0)
    /**
     * 同等篇幅下越靠后权重越高，所以顺序即优先级：
     * 「怎么说」→「该不该回」→「硬规则」。硬规则来自 forge 的 SKILL.md
     * （含「never approves, promises, commits」与「你在替谁说话」），
     * 它必须压过前面所有测出来的语气与倾向。
     */
    expect(rulesAt).toBeGreaterThan(styleAt)

    await service.detach()
    vault.close()
  })
})

describe("★ 蒸馏产出的 skill 包（forge）", () => {
  it("★ 不再拷进 `<cwd>/.opencode/skills/`（走 `skills.paths` 指目录）", async () => {
    const vault = seed()
    const { service, workspaceRoot, clock } = makeService(vault, {
      forgeSkillRoot: makeForgeSkillRoot(),
      llm: recordingLlm([]),
    })
    await runOneTurn(service, vault, clock)

    const skills = join(workspaceRoot, "persona", "conv-1", ".opencode", "skills")
    /**
     * ★ 断言这三个曾经必须在的路径**都不在** —— 那正是"不再 cpSync"这条
     * 变更的可查证据。
     *
     * 曾经每建一个 conversation workspace 就把 persona-persona 与 persona-inbox
     * 一整份拷过来（本机 61 个会话 = 61 份 forge 产物副本）。现在通过
     * `OPENCODE_CONFIG_CONTENT.skills.paths` 指到共享目录（见
     * `skill-workspace.test.ts` 的 spawn env 断言）。
     */
    expect(existsSync(join(skills, "persona-persona", "references", "decisions.md"))).toBe(false)
    expect(existsSync(join(skills, "persona-inbox", "SKILL.md"))).toBe(false)
    expect(existsSync(join(skills, "persona-persona", "references", "rules.json"))).toBe(false)

    await service.detach()
    vault.close()
  })

  it("★ 决策层与风格进了 system 指引（拷过去不等于模型看见了）", async () => {
    const vault = seed()
    const systems: string[] = []
    const { service, clock } = makeService(vault, {
      forgeSkillRoot: makeForgeSkillRoot(),
      llm: recordingLlm(systems),
    })
    await runOneTurn(service, vault, clock)

    // 断言哨兵串而不是"文件存在"：文件在 workspace 里却没被读进 system，
    // 表现是"回复不像本人"，而日志里什么都没有。
    expect(systems[0]).toContain("DECISIONS_SENTINEL")
    expect(systems[0]).toContain("STYLE_SENTINEL")

    await service.detach()
    vault.close()
  })

  it("顺序：怎么说 → 该不该回 → 硬规则", async () => {
    const vault = seed()
    const systems: string[] = []
    const { service, clock } = makeService(vault, {
      forgeSkillRoot: makeForgeSkillRoot(),
      llm: recordingLlm(systems),
    })
    await runOneTurn(service, vault, clock)

    const text = systems[0] ?? ""
    const styleAt = text.indexOf("STYLE_SENTINEL")
    const decisionsAt = text.indexOf("DECISIONS_SENTINEL")
    const rulesAt = text.indexOf("HARD_RULES_SENTINEL")
    /**
     * 顺序即优先级（同等篇幅下越靠后权重越高）：
     * 「该不该回」要压过「怎么说」，而两者都必须让位给硬规则 ——
     * 测出来的行为不能覆盖硬约束。三个都必须真的出现（>= 0），
     * 否则 -1 之间的比较会让这条断言恒真。
     */
    expect(styleAt).toBeGreaterThanOrEqual(0)
    expect(decisionsAt).toBeGreaterThan(styleAt)
    expect(rulesAt).toBeGreaterThan(decisionsAt)

    await service.detach()
    vault.close()
  })

  it("★ 没蒸馏过时照常建 workspace（缺产物是正常状态，不是错误）", async () => {
    const vault = seed()
    const systems: string[] = []
    // 不传 forgeSkillRoot → 还没蒸馏过
    const { service, workspaceRoot, clock } = makeService(vault, {
      llm: recordingLlm(systems),
    })
    await runOneTurn(service, vault, clock)

    const cwd = join(workspaceRoot, "persona", "conv-1")
    /**
     * 入口文件与退化指引照常在 —— 缺决策层只是能力降级，
     * 而且 AGENTS.md 必须如实说「还没蒸馏过这个账号」：
     * 不说的话模型会以为前面那段空白是它漏读了。
     */
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true)
    expect(systems[0]).toContain("[内置退化指引]")
    expect(systems[0]).toContain("还没有蒸馏过这个账号")
    expect(systems[0]).not.toContain("DECISIONS_SENTINEL")

    await service.detach()
    vault.close()
  })

  it("★ 不同 vault 的产物不会串（画像错人不可逆）", async () => {
    const vault = seed()
    const a = makeForgeSkillRoot()
    const { service, workspaceRoot, clock } = makeService(vault, {
      forgeSkillRoot: a,
      llm: recordingLlm([]),
    })
    await runOneTurn(service, vault, clock)
    await service.detach()

    /**
     * 重新 attach 到另一个产物目录（模拟切换账号）。
     * 构造时给 forgeSkillRoot 的话这里就切不掉 —— 而那个错误是静默的：
     * workspace 里有 skill、agent 读得到，只是那是**另一个人**的决策层。
     */
    const b = tempDir("mycontext-forge-b-")
    const bRefs = join(b, "persona-persona", "references")
    mkdirSync(bRefs, { recursive: true })
    writeFileSync(join(bRefs, "decisions.md"), "哨兵串：OTHER_ACCOUNT\n", "utf8")
    // ★ 只换画像目录、目录组不变（这一组测的是"画像跟着 vault 换"）
    service.attach(vault.db, b, dirs)
    const systems: string[] = []
    const second = makeService(vault, {
      forgeSkillRoot: b,
      llm: recordingLlm(systems),
    })
    await runOneTurn(second.service, vault, second.clock)
    expect(systems[0]).toContain("OTHER_ACCOUNT")
    expect(systems[0]).not.toContain("DECISIONS_SENTINEL")
    expect(existsSync(join(workspaceRoot, "persona", "conv-1"))).toBe(true)

    await second.service.detach()
    vault.close()
  })
})

describe("★ 决策与草稿都落库，且未自动发时必有原因", () => {
  it("一轮之后有 run 与 draft，decision_reason 非空", async () => {
    const vault = seed()
    const { service, clock } = makeService(vault, {
      llm: recordingLlm([]),
    })
    await runOneTurn(service, vault, clock)

    const runs = new PersonaRunRepository(vault.db)
    const recent = runs.recentRuns("conv-1", 10)
    expect(recent).toHaveLength(1)
    expect(recent[0]?.decision).toBe("drafted")
    /**
     * ★ 未自动发送时**必填**。
     * 用户开了 auto 却总在出草稿，不告诉他命中了哪条，
     * 他唯一能做的就是放弃这个功能。
     */
    expect(recent[0]?.decisionReason).not.toBeNull()

    const drafts = runs.pendingDrafts(10)
    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.notSentReason).not.toBeNull()
    // 引用的是触发它的那些消息（审阅时能点回原文）
    expect(drafts[0]?.citations).toContain("m1")

    await service.detach()
    vault.close()
  })

  it("没配 LLM → 出占位草稿且置信度 0（policy 必然拦住）", async () => {
    const vault = seed()
    const { service, clock } = makeService(vault, { forgeSkillRoot: makeForgeSkillRoot() })
    await runOneTurn(service, vault, clock)

    const runs = new PersonaRunRepository(vault.db)
    const recent = runs.recentRuns("conv-1", 10)
    expect(recent[0]?.confidence).toBe(0)
    /**
     * 置信度 0 而不是"什么都不做"：用户在草稿箱看到
     * "需要人工撰写（未配置模型）"就知道该去配什么；
     * 什么都看不到的话他只会以为功能坏了。
     */
    expect(runs.pendingDrafts(10)[0]?.text).toContain("未配置模型")

    await service.detach()
    vault.close()
  })

  it("kill switch 生效时 tick 不派发任何东西", async () => {
    const vault = seed()
    const { service, clock } = makeService(vault, {
      llm: recordingLlm([]),
    })
    service.setKillSwitch(true)
    await runOneTurn(service, vault, clock)

    expect(new PersonaRunRepository(vault.db).recentRuns("conv-1", 10)).toHaveLength(0)
    // 落库了：用户按下它是因为出了事，不该被一次重启撤销
    expect(service.snapshot().killSwitch).toBe(true)

    await service.detach()
    vault.close()
  })
})

describe("★ 审核反馈只进入当前 resident session", () => {
  it("丢弃会进入下一轮 prompt，session 销毁后不再继承", async () => {
    const vault = seed()
    const requestSystems: string[] = []
    const llm = new LlmClient({
      baseUrl: "https://fake.invalid",
      apiKey: "k",
      model: "m",
      sleep: () => Promise.resolve(),
      fetchImpl: (_url, init) => {
        const body = JSON.parse(String((init as RequestInit).body)) as {
          messages: { role: string; content: string }[]
        }
        requestSystems.push(
          body.messages
            .filter((item) => item.role === "system")
            .map((item) => item.content)
            .join("\n"),
        )
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      reply: "我看下",
                      holdForReview: true,
                      reviewReason: "需要确认",
                    }),
                  },
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          text: () => Promise.resolve(""),
        } as unknown as Response)
      },
    })
    const { service, clock, dirs } = makeService(vault, { llm })
    await runOneTurn(service, vault, clock)

    const firstDraft = service.drafts()[0]
    expect(firstDraft).toBeDefined()
    await service.resolveDraft({ draftId: firstDraft?.id ?? "", action: "discard" })

    const messages = new MessageRepository(vault.db)
    const conversation = new ConversationRepository(vault.db).findById("conv-1")
    if (conversation === null) throw new Error("会话缺失")
    const deliver = async (id: string, externalId: string, text: string, at: number) => {
      messages.upsertMany([
        {
          id,
          channelId: "dingtalk",
          conversationId: "conv-1",
          externalId,
          senderExternalId: "other",
          senderDisplayName: "小李",
          contentText: text,
          sentAt: at,
          direction: "inbound",
          isSelf: false,
          createdAt: at,
        },
      ])
      const message = messages.findById(id)
      const supervisor = service.inboundSupervisor
      if (message === null || supervisor === null) throw new Error("投递条件缺失")
      supervisor.onInbound({
        message,
        conversation,
        config: new PersonaConfigRepository(vault.db).get("conv-1"),
        mentionsSelf: false,
      })
      // 推过合并窗口与静默期（见 runOneTurn 的注释）
      clock.advance(10_000)
      await service.tick()
    }

    await deliver("m2", "ext-m2", "第二个问题", NOW + 10_000)
    expect(requestSystems[1]).toContain("用户丢弃过草稿：我看下")

    await service.detach()
    service.attach(vault.db, undefined, dirs)
    await deliver("m3", "ext-m3", "第三个问题", NOW + 20_000)
    expect(requestSystems[2]).not.toContain("用户丢弃过草稿")

    await service.detach()
    vault.close()
  })
})

/**
 * ★ policy 输入必须来自库，不是写死。
 *
 * ## 为什么这组门禁值得单独存在
 *
 * 首版这三项是写死的（`bannedPhraseHits: []` / `recentSends*: []`），
 * 而其中 `recentSends*` 传空数组时 `rate_limited` 这条判定**恒通过** ——
 * 也就是**限流完全没生效**。而它的外观与"限流正常"一模一样：
 * 没触到上限时两者行为相同，所以只有真的连发到第 3 条才会暴露。
 *
 * 而那是 8 条里唯一防"数字人在群里连发"的一条 —— 一旦有人打开 auto，
 * 没有它就没有任何东西拦着。
 */
describe("★ policy 输入来自库而不是写死", () => {
  /**
   * 这一组必须跑在**工作时间内**。
   *
   * `NOW`（周日 01:20）落在 `DEFAULT_WORK_HOURS`（周一到周五 9-19 点）之外，
   * 于是 policy 先命中 `outside_work_hours` 就短路了 —— 后面的频率与
   * 禁止词根本不会被评估到，断言会看到一个"对但不是我们要验的"reason。
   *
   * 2026-07-29 14:30 是周三下午，落在窗口内。
   */
  const WORK_TIME = 1_785_306_600_000

  /** 与外层 makeService 同构，只是时钟落在工作时间内。 */
  function makeWorkTimeService(
    vault: ReturnType<typeof openTestVault>,
    options: { llm?: LlmClient; forgeSkillRoot?: string } = {},
  ) {
    const workspaceRoot = tempDir("mycontext-ws-")
    const clock = new ManualClock(WORK_TIME)
    const service = new PersonaService({
      clock,
      logger,
      llmProvider: staticLlmProvider(options.llm ?? null),
      getWindow: () => null,
    })
    // ★ agent 目录按 vault（attach 时给）—— 见 AgentDirs
    service.attach(vault.db, options.forgeSkillRoot, {
      workspaceRoot,
      home: join(workspaceRoot, "agent-home"),
      npmCache: join(workspaceRoot, "npm-cache"),
    })
    return { service, clock }
  }

  /** 造 n 条"已发送"记录，时间都在最近几分钟内。 */
  function seedSends(
    vault: ReturnType<typeof openTestVault>,
    count: number,
    options: { conversationId?: string; state?: string } = {},
  ): void {
    const statement = vault.db.prepare(
      `INSERT INTO dh_send_attempts
         (idempotency_key, conversation_id, target_kind, target_external_id,
          content_hash, state, attempted_at, sent_at)
       VALUES (?, ?, 'group', 'cid-1', 'h', ?, ?, ?)`,
    )
    for (let index = 0; index < count; index += 1) {
      statement.run(
        `key-${String(index)}-${options.conversationId ?? "conv-1"}`,
        options.conversationId ?? "conv-1",
        options.state ?? "sent",
        WORK_TIME - index * 1000,
        WORK_TIME - index * 1000,
      )
    }
  }

  it("★ 会话内窗口已发满 → 下一条判 rate_limited", async () => {
    const vault = seed()
    // 默认放宽后 perConversation = 5 / 1 分钟；seedSends 的时间戳都在几秒内、
    // 落在窗口里。发满 5 条，下一轮就该撞上限。★ 跟着 DEFAULT_RATE_LIMIT 走，
    // 写死 2 会让这条在默认值变化后悄悄失效。
    seedSends(vault, DEFAULT_RATE_LIMIT.perConversation)
    // auto 模式才会走到频率这一条（draft 模式先被 mode_not_auto 短路）
    new PersonaConfigRepository(vault.db).upsert("conv-1", { replyMode: "auto" }, WORK_TIME)

    const { service, clock } = makeWorkTimeService(vault, {
      llm: recordingLlm([]),
    })
    await runOneTurn(service, vault, clock)

    const recent = new PersonaRunRepository(vault.db).recentRuns("conv-1", 10)
    /**
     * ★ 断言 `failedConditions`，不是 `decisionReason`。
     *
     * `reason` 是 `reasons[0]`（第一个命中的），而 policy 的求值顺序里
     * `scene_allows_auto` 在频率之前 —— 一期 `sceneAllowsAuto` 恒 false，
     * 所以 reason 永远是 `scene_disallows_auto`，频率那条**看不出来**。
     *
     * `failedConditions` 是全部未通过的条件，它才能证明"频率真的被评估到
     * 并且判失败了"。这也正是那个字段存在的理由。
     */
    expect(recent[0]?.failedConditions).toContain("within_rate_limit")

    await service.detach()
    vault.close()
  })

  it("只发过 1 条 → 不判 rate_limited（否则这条判定退化成恒真）", async () => {
    const vault = seed()
    seedSends(vault, 1)
    new PersonaConfigRepository(vault.db).upsert("conv-1", { replyMode: "auto" }, WORK_TIME)

    const { service, clock } = makeWorkTimeService(vault, {
      llm: recordingLlm([]),
    })
    await runOneTurn(service, vault, clock)

    const recent = new PersonaRunRepository(vault.db).recentRuns("conv-1", 10)
    // 会被别的条件拦（scene / grant / confidence），但**不该**是频率
    expect(recent[0]?.failedConditions).not.toContain("within_rate_limit")

    await service.detach()
    vault.close()
  })

  it("★ 只算 state='sent'：reserved 与 blocked_no_grant 不算发过", async () => {
    const vault = seed()
    /**
     * 把它们算进来会让限流比实际更严 —— 用户看到"明明没发几条却被限流"，
     * 而 `reserved`（占位未发）在崩溃重启后可能大量存在。
     */
    seedSends(vault, 5, { state: "reserved" })
    new PersonaConfigRepository(vault.db).upsert("conv-1", { replyMode: "auto" }, WORK_TIME)

    const { service, clock } = makeWorkTimeService(vault, {
      llm: recordingLlm([]),
    })
    await runOneTurn(service, vault, clock)

    expect(
      new PersonaRunRepository(vault.db).recentRuns("conv-1", 10)[0]?.failedConditions,
    ).not.toContain("within_rate_limit")

    await service.detach()
    vault.close()
  })

  it("别的会话发过不影响本会话的会话级限额", async () => {
    const vault = seed()
    seedSends(vault, 2, { conversationId: "conv-other" })
    new PersonaConfigRepository(vault.db).upsert("conv-1", { replyMode: "auto" }, WORK_TIME)

    const { service, clock } = makeWorkTimeService(vault, {
      llm: recordingLlm([]),
    })
    await runOneTurn(service, vault, clock)

    // 会话级是 2 条；别的会话那 2 条只计入全局（上限 20），所以不该触发
    expect(
      new PersonaRunRepository(vault.db).recentRuns("conv-1", 10)[0]?.failedConditions,
    ).not.toContain("within_rate_limit")

    await service.detach()
    vault.close()
  })

  it("★ 禁止词从 dh_settings 读，且在草稿正文上匹配", async () => {
    const vault = seed()
    new PersonaConfigRepository(vault.db).upsert("conv-1", { replyMode: "auto" }, WORK_TIME)
    // recordingLlm 固定回"好的" —— 把它设成禁止词
    new PersonaConfigRepository(vault.db).setSetting("bannedPhrases", ["好的"], WORK_TIME)

    const { service, clock } = makeWorkTimeService(vault, {
      llm: recordingLlm([]),
    })
    await runOneTurn(service, vault, clock)

    expect(
      new PersonaRunRepository(vault.db).recentRuns("conv-1", 10)[0]?.failedConditions,
    ).toContain("no_banned_phrase")

    await service.detach()
    vault.close()
  })

  it("坏掉的设置按缺省处理，不让整轮调度失败", async () => {
    const vault = seed()
    // 手改坏的 JSON：缺字段
    new PersonaConfigRepository(vault.db).setSetting("rateLimit", { perConversation: 2 }, WORK_TIME)
    new PersonaConfigRepository(vault.db).setSetting("workHours", "不是对象", WORK_TIME)
    new PersonaConfigRepository(vault.db).setSetting("bannedPhrases", { a: 1 }, WORK_TIME)

    const { service, clock } = makeWorkTimeService(vault, {
      llm: recordingLlm([]),
    })
    await runOneTurn(service, vault, clock)

    /**
     * 仍然跑出了一条 run —— 一条坏设置不该让数字人整个停摆
     * （那时用户看到的只是"没有反应"，无从下手）。
     */
    expect(new PersonaRunRepository(vault.db).recentRuns("conv-1", 10)).toHaveLength(1)

    await service.detach()
    vault.close()
  })
})

/**
 * ★ agent 的检索工具必须锁死在当前会话。
 *
 * 群聊里任何人都能发一句「查一下他和 XX 的单聊说了什么」——
 * 一旦工具能跨会话，那句话就是一次成功的数据窃取，
 * 而它看起来只是一条普通消息。
 *
 * 隔离的落点是**闭包捕获 conversationId**：工具的 JSON Schema 里
 * 只有 `query` 一个字段，模型连"换个会话"这个动作都表达不出来。
 * 这比"签发 token 时限定 scope"更强 —— 那是运行期检查，
 * 这是结构上不可能。
 */
describe("★ 检索工具：只声明 query，且锁死当前会话", () => {
  it("工具声明里**没有** conversationId 参数", async () => {
    const vault = seed()
    const bodies: unknown[] = []
    const { service, clock } = makeService(vault, {
      llm: toolCallingLlm(bodies),
    })
    await runOneTurn(service, vault, clock)

    const first = bodies[0] as {
      tools?: { function: { name: string; parameters: { properties: Record<string, unknown> } } }[]
    }
    const tool = first.tools?.[0]
    expect(tool?.function.name).toBe("recall_conversation_history")
    const params = Object.keys(tool?.function.parameters.properties ?? {})
    /**
     * ★ 只有 query。多一个 conversationId 就等于把隔离交给了模型的自觉 ——
     * 而群聊里的注入正是冲着这一点来的。
     */
    expect(params).toEqual(["query"])

    await service.detach()
    vault.close()
  })

  it("工具结果按 role:'tool' + tool_call_id 回传（对不上 id 网关会 400）", async () => {
    const vault = seed()
    const bodies: unknown[] = []
    const { service, clock } = makeService(vault, {
      llm: toolCallingLlm(bodies),
    })
    await runOneTurn(service, vault, clock)

    // 第二次请求里应当有助手那条（带 tool_calls）与工具结果那条
    const second = bodies[1] as { messages: { role: string; tool_call_id?: string }[] }
    const toolMessage = second.messages.find((item) => item.role === "tool")
    expect(toolMessage?.tool_call_id).toBe("toolu_1")
    const assistant = second.messages.find((item) => item.role === "assistant")
    expect(assistant).toBeDefined()

    await service.detach()
    vault.close()
  })

  it("多轮跑完后草稿用的是**最后一轮**的正文", async () => {
    const vault = seed()
    const bodies: unknown[] = []
    const { service, clock } = makeService(vault, {
      llm: toolCallingLlm(bodies),
    })
    await runOneTurn(service, vault, clock)

    const drafts = new PersonaRunRepository(vault.db).pendingDrafts(10)
    // 第一轮 content 是空串（模型在等工具结果）—— 不能把它当成草稿
    expect(drafts[0]?.text).toBe("查到了，沙箱那事已经好了")

    await service.detach()
    vault.close()
  })
})

/**
 * ★ 「看引用」必须能定位到窗口外的消息。
 *
 * ## 这个 bug 是在真应用里发现的，单测发现不了
 *
 * 草稿的 `citations` 指向**当时**触发它的那些消息，而中栏只加载
 * 「最近 80 条」。实测真实数据：53 条引用**一条都不在**那 80 条里 ——
 * 于是点「看引用」什么都不会发生：没有报错、没有日志、就是没反应。
 *
 * 所以 `messages()` 必须接受 `includeIds` 并把它们捞回来。
 *
 * ## 顺便锁住一条安全性质
 *
 * `includeIds` 来自渲染层。拿它当"任意消息读取"用就是跨会话泄漏 ——
 * 所以别的会话的 id 必须被丢掉，而不是"因为传了就返回"。
 */
describe("★ messages(includeIds)：引用定位与跨会话防护", () => {
  /** 造一条很老的消息（落在"最近 N 条"窗口之外）。 */
  function seedOld(vault: ReturnType<typeof openTestVault>) {
    new MessageRepository(vault.db).upsertMany([
      {
        id: "old-1",
        channelId: "dingtalk",
        conversationId: "conv-1",
        externalId: "ext-old-1",
        senderExternalId: "other",
        senderDisplayName: "小李",
        contentText: "很久以前说过的那个方案",
        // 比 seed() 里那条早 30 天 —— 稳稳落在窗口外
        sentAt: NOW - 30 * 86_400_000,
        direction: "inbound",
        isSelf: false,
        createdAt: NOW,
      },
    ])
  }

  it("不传 includeIds 时，limit=1 只返回最近那条（窗口是真的在限）", async () => {
    const vault = seed()
    seedOld(vault)
    const { service } = makeService(vault)

    const ids = service.messages("conv-1", 1).map((m) => m.id)
    // 反面保护：如果窗口没在限，下一条断言就没有意义了
    expect(ids).toEqual(["m1"])

    await service.detach()
    vault.close()
  })

  it("★ 传了 includeIds → 窗口外那条被捞回来", async () => {
    const vault = seed()
    seedOld(vault)
    const { service } = makeService(vault)

    const rows = service.messages("conv-1", 1, ["old-1"])
    const ids = rows.map((m) => m.id)
    expect(ids).toContain("old-1")
    // 窗口内那条也还在（补齐不是"换成引用"）
    expect(ids).toContain("m1")
    /**
     * ★ 必须按时间排好序。
     * 补进来的比窗口内的更早，不重排的话它们会堆在列表末尾 ——
     * 那样"滚到引用处"会滚到对话的最后面，读起来是错的。
     */
    expect(rows.map((m) => m.sentAt)).toEqual([...rows.map((m) => m.sentAt)].sort((a, b) => a - b))

    await service.detach()
    vault.close()
  })

  it("★ 别的会话的 id 被丢掉（includeIds 不是任意消息读取的口子）", async () => {
    const vault = seed()
    new ConversationRepository(vault.db).upsert({
      id: "conv-2",
      channelId: "dingtalk",
      externalId: "cid-2",
      type: "direct",
      title: "私聊",
      memberCount: 2,
      createdAt: NOW,
    })
    new MessageRepository(vault.db).upsertMany([
      {
        id: "secret-1",
        channelId: "dingtalk",
        conversationId: "conv-2",
        externalId: "ext-secret-1",
        senderExternalId: "other",
        senderDisplayName: "小王",
        contentText: "薪酬调整的事",
        sentAt: NOW - 1000,
        direction: "inbound",
        isSelf: false,
        createdAt: NOW,
      },
    ])
    const { service } = makeService(vault)

    const rows = service.messages("conv-1", 80, ["secret-1"])
    /**
     * 这是**安全断言**：渲染层传什么都不能让这一页看到别的会话。
     * 只按 id 捞不校验会话的话，这里会返回那条单聊消息。
     */
    expect(rows.map((m) => m.id)).not.toContain("secret-1")
    expect(rows.every((m) => m.id !== "secret-1")).toBe(true)

    await service.detach()
    vault.close()
  })

  it("不存在的 id 直接跳过（消息可能已被隐私删除）", async () => {
    const vault = seed()
    const { service } = makeService(vault)
    // 不抛异常，也不返回一个空壳条目
    expect(service.messages("conv-1", 80, ["nope"]).map((m) => m.id)).toEqual(["m1"])
    await service.detach()
    vault.close()
  })
})

/**
 * ★ 「选了自动就真自动」—— 白名单那道门删掉之后的核心不变式。
 *
 * ## 为什么这一组必须存在
 *
 * 曾经自动发送要过**两道**门：`replyMode === "auto"` **且**会话在一份
 * 全局白名单里。于是用户在会话设置里选了「自动」，功能却仍然只出草稿，
 * 而原因（`not_whitelisted`）是一条静默降级 —— 他唯一能做的是放弃这个功能。
 *
 * 现在 auto 这个**显式选择**就是那次授权。这一组锁三件事：
 * · 只设 auto（不做任何别的动作）就不再有"白名单"类条件挡着；
 * · `autoReplyCount` 与列表里 auto 的会话数一致（两处各算一遍会算出两个值）；
 * · 真正的误发防线（场景 / 工作时间 / 频率 / 授权）**还在** ——
 *   删门不等于删闸，这条反面保护不能少。
 */
describe("★ 选了自动就真自动（白名单已删）", () => {
  it("★ 只把 replyMode 设成 auto → 不再有白名单类条件挡着", async () => {
    const vault = seed()
    // 只设 auto，**不做任何别的动作**（曾经这里还要再加一次白名单）
    new PersonaConfigRepository(vault.db).upsert("conv-1", { replyMode: "auto" }, NOW)
    const { service, clock } = makeService(vault, { llm: recordingLlm([]) })
    await runOneTurn(service, vault, clock)

    const recent = new PersonaRunRepository(vault.db).recentRuns("conv-1", 10)
    const failed = recent[0]?.failedConditions ?? []
    /**
     * 断言"没有任何叫得上白名单的条件" —— 用两个名字一起查，
     * 是因为这条门若被以别的名字复活（换个 key 再加一道"再确认"），
     * 这个断言仍然要红。
     */
    expect(failed).not.toContain("in_send_whitelist")
    expect(failed.join(",")).not.toContain("whitelist")
    // 模式这一条也必须是过的 —— 否则上面两条会因为"根本没评估"而假绿
    expect(failed).not.toContain("mode_is_auto")
    await service.detach()
    vault.close()
  })

  it("★ draft 模式仍然判 mode_not_auto（模式这道门本身没被删掉）", async () => {
    const vault = seed()
    new PersonaConfigRepository(vault.db).upsert("conv-1", { replyMode: "draft" }, NOW)
    const { service, clock } = makeService(vault, { llm: recordingLlm([]) })
    await runOneTurn(service, vault, clock)

    const recent = new PersonaRunRepository(vault.db).recentRuns("conv-1", 10)
    expect(recent[0]?.failedConditions).toContain("mode_is_auto")
    await service.detach()
    vault.close()
  })

  it("★ autoReplyCount 与列表里 auto 的会话数一致", () => {
    const vault = seed()
    const { service } = makeService(vault)
    service.saveConfig({ conversationId: "conv-1", replyMode: "auto" })

    const fromList = service.conversations().filter((item) => item.replyMode === "auto").length
    expect(service.snapshot().autoReplyCount).toBe(fromList)
    expect(fromList).toBe(1)
    vault.close()
  })

  it("改回 draft 之后 autoReplyCount 归零（取消授权要真的生效）", () => {
    const vault = seed()
    const { service } = makeService(vault)
    service.saveConfig({ conversationId: "conv-1", replyMode: "auto" })
    expect(service.snapshot().autoReplyCount).toBe(1)
    service.saveConfig({ conversationId: "conv-1", replyMode: "draft" })
    expect(service.snapshot().autoReplyCount).toBe(0)
    vault.close()
  })

  /**
   * ★ 渠道 id 要一路透到 UI 读路径上。
   *
   * `conversations.channel_id` 从一开始就在落库，但 `listWithConversations()`
   * 的 SELECT 里没取它 —— 于是界面上无从知道"这个会话属于哪个 IM"。
   * 多渠道之后（飞书接进来）这是一个**会导致误发**的缺口：
   * 用户看不出会话在哪个渠道，就无法判断草稿会落到谁的手机上。
   *
   * 断言读路径而不是写路径：写一直是对的，缺的是读。
   */
  it("★ conversations() 透出会话所属渠道（渠道标识要有数据可渲染）", () => {
    const vault = seed()
    const { service } = makeService(vault)
    expect(service.conversations()[0]?.channelId).toBe("dingtalk")
    vault.close()
  })
})

/**
 * ★ 运行参数：改一项不能把其余三项擦回缺省。
 *
 * `exactOptionalPropertyTypes` 下 `{...current, ...patch}` 里一个**显式的
 * `undefined`**（zod `.partial()` 的产物、或 JSON 往返）会把当前值覆盖成
 * undefined → 落库成 null → 下次读出来退回缺省。
 * 表现是"我明明把并发调成 1 了，重启又变回 3"。
 */
describe("★ 运行参数（LRU / 并发 / 批次上限）", () => {
  it("缺省值与 persona 包的常量同源", () => {
    const vault = seed()
    const { service } = makeService(vault)
    expect(service.limits()).toEqual({
      maxResident: MAX_RESIDENT_AGENTS,
      maxConcurrentTurns: MAX_CONCURRENT_TURNS,
      maxBatchSize: MAX_BATCH_SIZE,
      idleEvictMinutes: Math.round(IDLE_EVICT_MS / 60_000),
      maxDraftsPerConversation: 3,
      workHours: DEFAULT_WORK_HOURS,
      rateLimit: DEFAULT_RATE_LIMIT,
    })
    vault.close()
  })

  it("★ 只改并发 → 其余三项不被擦回缺省", () => {
    const vault = seed()
    const { service } = makeService(vault)
    service.limitsSave({ maxResident: 16 })
    service.limitsSave({ maxConcurrentTurns: 1 })

    const after = service.limits()
    expect(after.maxConcurrentTurns).toBe(1)
    // 上一步设的 16 必须还在
    expect(after.maxResident).toBe(16)
    vault.close()
  })

  it("显式 undefined 也当成「没传」（zod .partial() 会产出它）", () => {
    const vault = seed()
    const { service } = makeService(vault)
    service.limitsSave({ maxResident: 16 })
    service.limitsSave({ maxResident: undefined, maxConcurrentTurns: 2 })
    expect(service.limits().maxResident).toBe(16)
    vault.close()
  })

  it("★ 越界值被夹住（maxConcurrentTurns: 0 会让调度永远什么都不做）", () => {
    const vault = seed()
    const { service } = makeService(vault)
    // 手改坏库里的值
    new PersonaConfigRepository(vault.db).setSetting(
      "runtimeLimits",
      { maxConcurrentTurns: 0, maxResident: 9999 },
      NOW,
    )
    const limits = service.limits()
    /**
     * 0 并发 = 调度永远跳过所有会话，而表现只是"数字人没反应"，
     * 日志里也看不出为什么。所以下界必须夹到 1。
     */
    expect(limits.maxConcurrentTurns).toBe(1)
    expect(limits.maxResident).toBe(64)
    vault.close()
  })

  it("★ 改完立刻对**在跑的** supervisor 生效（不是下次重启）", () => {
    const vault = seed()
    const { service, clock } = makeService(vault)
    const supervisor = service.inboundSupervisor
    expect(supervisor).not.toBeNull()

    // 先攒 5 条，再把上限热改成 2。
    // dh_inbox 有到 messages 的外键，所以这些消息要真落库。
    const ids = Array.from({ length: 5 }, (_, index) => `m-batch-${String(index)}`)
    new MessageRepository(vault.db).upsertMany(
      ids.map((id) => ({
        id,
        channelId: "dingtalk" as const,
        conversationId: "conv-1",
        externalId: `ext-${id}`,
        senderExternalId: "other",
        senderDisplayName: "小李",
        contentText: "又一条",
        sentAt: NOW,
        direction: "inbound" as const,
        isSelf: false,
        createdAt: NOW,
      })),
    )
    for (const id of ids) {
      supervisor?.mailbox.push({ messageId: id, conversationId: "conv-1" })
    }
    service.limitsSave({ maxBatchSize: 2 })
    // 推过合并窗口与静默期（这个用例验的是批次上限，不是时序）
    clock.advance(10_000)

    /**
     * 判据是 `takeBatch` 真的按新上限切 —— 而不是"设置存进库了"。
     * 只验落库的话"存了但没传给 supervisor"这个 bug 照样绿，
     * 而那正是"设置项看起来能改、实际不生效"的形态。
     */
    const batch = supervisor?.mailbox.takeBatch("conv-1")
    expect(batch?.entries).toHaveLength(2)
    expect(batch?.overflow).toBe(3)
    vault.close()
  })
})

/**
 * ★★ 工作时间：**曾经完全没有 UI 入口**，于是所有人都跑默认周一到周五 9-19 点。
 *
 * ## 为什么这一组必须存在
 *
 * `outside_work_hours` 是 policy 8 条里挡住自动发送最频繁的一条，而它的
 * 值原来只能靠手改 `dh_settings`。用户看到草稿卡写着「不在**你设定的**
 * 工作时间内 · 下一步：改工作时间」，而那个入口根本不存在 —— 一句指向
 * 空气的引导比不给引导更糟。
 *
 * 这一组锁的是"能改、且改坏了不会把自动发送焊死"：
 * `startHour >= endHour` 时 `withinWorkHours` 恒 false（`h >= s && h < e`
 * 在 s>=e 时永远不成立），表现是"我改完时间之后就再也不发了"。
 */
describe("★★ 工作时间可配置", () => {
  it("★ 存得下、读得回（全时段 = 7 天 0-24）", () => {
    const vault = seed()
    const { service } = makeService(vault)
    const saved = service.limitsSave({
      workHours: { days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 },
    })
    expect(saved.workHours).toEqual({ days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 })
    // 重新读一次（走 readRuntimeLimits 的解析路径，而不是 limitsSave 的返回值）
    expect(service.limits().workHours).toEqual({
      days: [0, 1, 2, 3, 4, 5, 6],
      startHour: 0,
      endHour: 24,
    })
    vault.close()
  })

  it("★ 改工作时间不擦掉其余四项", () => {
    const vault = seed()
    const { service } = makeService(vault)
    service.limitsSave({ maxResident: 16, maxConcurrentTurns: 1 })
    service.limitsSave({ workHours: { days: [1], startHour: 8, endHour: 22 } })
    const after = service.limits()
    expect(after.maxResident).toBe(16)
    expect(after.maxConcurrentTurns).toBe(1)
    expect(after.workHours).toEqual({ days: [1], startHour: 8, endHour: 22 })
    vault.close()
  })

  it("★ 反面：`startHour >= endHour` 被拒（那个组合会让自动发送恒不可达）", () => {
    const vault = seed()
    const { service } = makeService(vault)
    /**
     * ★ 先存一个**非默认**的合法值。
     *
     * 不这么做的话这条断言是**假绿**：坏值即使被 `limitsSave` 放行落了库，
     * `readRuntimeLimits` 的 `validHours` 也会在读的时候把它判掉并退回
     * `DEFAULT_WORK_HOURS` —— 而"拒收成功"与"落库了但读时退回默认"两种
     * 结果都等于默认值，断言分不出来（实测：去掉 limitsSave 那道 start<end
     * 判断，这条用例照样绿）。
     *
     * 用一个非默认基线之后，两者就分开了：拒收 → 保持基线；放行 → 变默认。
     */
    const baseline = { days: [1, 2, 3], startHour: 8, endHour: 22 }
    service.limitsSave({ workHours: baseline })
    expect(service.limits().workHours).toEqual(baseline)

    // 21 点到 9 点 —— 用户想表达"跨夜"，但当前判定不支持跨夜
    service.limitsSave({ workHours: { days: [1, 2], startHour: 21, endHour: 9 } })
    /**
     * 保持**基线**而不是接受它：`withinWorkHours` 用 `hour >= 21 && hour < 9`，
     * 那个条件**任何小时都不成立** —— 落库就等于永久关掉自动发送，
     * 而用户以为自己只是调了个时间段。
     */
    expect(service.limits().workHours).toEqual(baseline)
    vault.close()
  })

  it("★ 反面：`days` 为空被拒（等于关掉，用急停表达更清楚）", () => {
    const vault = seed()
    const { service } = makeService(vault)
    // 同上：基线必须非默认，否则分不出"拒收"与"读时退回默认"
    const baseline = { days: [1, 2, 3], startHour: 8, endHour: 22 }
    service.limitsSave({ workHours: baseline })
    service.limitsSave({ workHours: { days: [], startHour: 9, endHour: 19 } })
    // 空 days 让 `days.includes(getDay())` 恒 false —— 与上面同一类"静默焊死"
    expect(service.limits().workHours).toEqual(baseline)
    vault.close()
  })

  it("越界的小时被拒（endHour 25 / startHour -1）", () => {
    const vault = seed()
    const { service } = makeService(vault)
    const baseline = { days: [1, 2, 3], startHour: 8, endHour: 22 }
    service.limitsSave({ workHours: baseline })
    service.limitsSave({ workHours: { days: [1], startHour: 0, endHour: 25 } })
    expect(service.limits().workHours).toEqual(baseline)
    service.limitsSave({ workHours: { days: [1], startHour: -1, endHour: 19 } })
    expect(service.limits().workHours).toEqual(baseline)
    vault.close()
  })

  it("days 去重并排序（UI 上重复点同一天不该落两份）", () => {
    const vault = seed()
    const { service } = makeService(vault)
    service.limitsSave({ workHours: { days: [5, 1, 5, 3, 1], startHour: 9, endHour: 19 } })
    expect(service.limits().workHours.days).toEqual([1, 3, 5])
    vault.close()
  })

  it("★ 兼容旧的独立 `workHours` 设置键（迁移期不能把用户配过的值丢掉）", () => {
    const vault = seed()
    const { service } = makeService(vault)
    /**
     * 这个键是本次改动之前唯一的落点（`WORK_HOURS_KEY`）。一台机器上如果
     * 只写过它、还没通过新入口保存过，读的时候必须仍然认它 ——
     * 不认的话用户手配过的工作时间会悄悄退回默认（周一到周五 9-19 点），
     * 而那正是他配它想避开的。
     */
    new PersonaConfigRepository(vault.db).setSetting(
      "workHours",
      { days: [0, 6], startHour: 10, endHour: 23 },
      NOW,
    )
    expect(service.limits().workHours).toEqual({ days: [0, 6], startHour: 10, endHour: 23 })
    vault.close()
  })

  it("新键存在时以新键为准（它是通过新入口写的、更新）", () => {
    const vault = seed()
    const { service } = makeService(vault)
    const configs = new PersonaConfigRepository(vault.db)
    configs.setSetting("workHours", { days: [0], startHour: 1, endHour: 2 }, NOW)
    service.limitsSave({ workHours: { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 19 } })
    expect(service.limits().workHours).toEqual({
      days: [1, 2, 3, 4, 5],
      startHour: 9,
      endHour: 19,
    })
    vault.close()
  })

  it("★ 坏形状（缺字段 / days 不是数组）退回默认，不抛", () => {
    const vault = seed()
    const { service } = makeService(vault)
    new PersonaConfigRepository(vault.db).setSetting(
      "runtimeLimits",
      { workHours: { days: "everyday", startHour: 9 } },
      NOW,
    )
    /**
     * 一条手改坏的设置不该让整轮调度失败（那会让数字人整个停摆，
     * 而用户看到的只是"没有反应"）。
     */
    expect(() => service.limits()).not.toThrow()
    expect(service.limits().workHours).toEqual(DEFAULT_WORK_HOURS)
    vault.close()
  })
})

/**
 * ★★ 频率上限可配（原来存在一个没有 UI 的独立键，用户改不了）。
 *
 * 与工作时间同构：并进 `runtimeLimits` 这条统一面、整体接受或整体丢弃、
 * 兼容旧的独立 `rateLimit` 键。这里测的是那几条不变量在读写往返里成立。
 */
describe("★★ 频率上限可配置", () => {
  const RL = {
    perConversation: 8,
    perConversationWindowMs: 30_000,
    global: 200,
    globalWindowMs: 7_200_000,
  }

  it("★ 存得下、读得回（走 readRuntimeLimits 的解析路径）", () => {
    const vault = seed()
    const { service } = makeService(vault)
    const saved = service.limitsSave({ rateLimit: RL })
    expect(saved.rateLimit).toEqual(RL)
    expect(service.limits().rateLimit).toEqual(RL)
    vault.close()
  })

  it("★ 改频率不擦掉其余项", () => {
    const vault = seed()
    const { service } = makeService(vault)
    service.limitsSave({ maxResident: 16, workHours: { days: [1], startHour: 8, endHour: 22 } })
    service.limitsSave({ rateLimit: RL })
    const after = service.limits()
    expect(after.rateLimit).toEqual(RL)
    expect(after.maxResident).toBe(16)
    expect(after.workHours).toEqual({ days: [1], startHour: 8, endHour: 22 })
    vault.close()
  })

  it("★★ 0 存得下（关掉那一关）—— 不被当成非法值丢弃", () => {
    const vault = seed()
    const { service } = makeService(vault)
    /**
     * ★ 反证：如果校验把下限写成 `>= 1`（跟着 maxResident 那种"1 起"的直觉），
     * 0 会被判非法、整份 rateLimit 退回默认（5）—— 用户想关却关不掉。
     * 所以 0 必须能存进去、读得回。
     */
    const off = { ...RL, perConversation: 0, global: 0 }
    service.limitsSave({ rateLimit: off })
    expect(service.limits().rateLimit.perConversation).toBe(0)
    expect(service.limits().rateLimit.global).toBe(0)
    vault.close()
  })

  it("★★ 半份 rateLimit（缺窗口）被整体丢弃，保留当前值", () => {
    const vault = seed()
    const { service } = makeService(vault)
    service.limitsSave({ rateLimit: RL })
    /**
     * 只传条数、不传窗口 —— 那是个语义错乱的组合（"8 条 / 未知窗口"）。
     * 整体丢弃、保留上一次的完整值，而不是拼出半份。
     */
    service.limitsSave({
      rateLimit: { perConversation: 999 } as unknown as typeof RL,
    })
    expect(service.limits().rateLimit).toEqual(RL)
    vault.close()
  })

  it("★ 兼容旧的独立 `rateLimit` 设置键（迁移期不丢用户配过的值）", () => {
    const vault = seed()
    const { service } = makeService(vault)
    /**
     * 本次改动之前的唯一落点。只写过它、还没通过新入口保存过时，
     * 读的时候必须仍然认它 —— 否则用户配过的频率会悄悄退回默认。
     */
    new PersonaConfigRepository(vault.db).setSetting("rateLimit", RL, NOW)
    expect(service.limits().rateLimit).toEqual(RL)
    vault.close()
  })

  it("★ 坏形状（缺字段）退回默认，不抛", () => {
    const vault = seed()
    const { service } = makeService(vault)
    new PersonaConfigRepository(vault.db).setSetting(
      "runtimeLimits",
      { rateLimit: { perConversation: 5 } },
      NOW,
    )
    expect(() => service.limits()).not.toThrow()
    expect(service.limits().rateLimit).toEqual(DEFAULT_RATE_LIMIT)
    vault.close()
  })
})

/**
 * ★ 投递之后**必须叫醒调度** —— 否则那批消息要等兜底定时器。
 *
 * ## 这一条锁的是一个"看起来已经做了"的性质
 *
 * 快通道（`inbound.message` → `createPersonaFastPath` → `onInbound`）
 * 一直是毫秒级的，注释里也写着"入库即投递、不等那 8 秒 tick"。
 * 但**投递完没有叫醒任何人**：唯一的取件人是 `TICK_MS = 8s` 的定时器。
 * 于是「投递是订阅式的、处理仍是轮询式的」，一条 @我 的消息平均多等 4 秒。
 *
 * 这个 bug 在任何单测里都不会红：手动调 `tick()` 的测试永远看不出
 * "生产环境里谁来调它"。所以这里断言的是**定时器被排了**，
 * 而不是"tick 能工作"。
 *
 * 用假定时器而不是真等：唤醒延迟是 3.2 秒，真等的话这几个用例慢 10 秒。
 */
describe("★ 投递即处理：wake() 排唤醒而不是等 8 秒兜底", () => {
  it("onDelivered 之后在「合并窗口 + 余量」处就跑了一轮（不是 8 秒）", async () => {
    vi.useFakeTimers()
    try {
      const vault = seed()
      const { service, clock } = makeService(vault)
      const supervisor = service.inboundSupervisor
      const message = new MessageRepository(vault.db).findById("m1")
      const conversation = new ConversationRepository(vault.db).findById("conv-1")
      if (supervisor === null || message === null || conversation === null) {
        throw new Error("种子数据缺失")
      }

      /**
       * ★ 不调 `start()` —— 那会起 8 秒兜底定时器，于是"跑了一轮"
       * 有两个可能的来源，断言就分不出是唤醒还是兜底干的。
       * 这里只有唤醒这一条路。
       */
      supervisor.onInbound({
        message,
        conversation,
        config: new PersonaConfigRepository(vault.db).get("conv-1"),
        mentionsSelf: false,
      })
      service.onDelivered()

      // 两条线都没到（窗口 3s / 静默期 6s）—— 这时不该有人取件
      await vi.advanceTimersByTimeAsync(2_000)
      clock.advance(2_000)
      expect(supervisor.mailbox.takeBatch("conv-1").entries).toHaveLength(0)

      /**
       * 推过 `max(窗口, 静默期) + 余量`：唤醒该触发了。
       *
       * `clock` 要同步推 —— `takeBatch` 比较的是 `clock.now() - enqueuedAt`，
       * 只推假定时器的话唤醒会跑但取到空批次（那正是"立刻跑"的失败形态）。
       *
       * ★ 唤醒的延迟必须跟着静默期一起变。只按窗口排的话，唤醒总是早于
       * `takeBatch` 的静默判据 → 每次都空批次 → 这一批要等 8 秒兜底才动，
       * 也就是唤醒白接了（"修了个假"的另一种形态）。
       */
      clock.advance(5_000)
      await vi.advanceTimersByTimeAsync(5_000)

      /**
       * 判据：那一批**已经被取走了**（pending 空了）。
       *
       * 断言"取走了"而不是"生成了草稿"：这个用例没配 LLM，
       * 而 pending 空掉恰好证明有人在 3.2 秒处调了 tick。
       */
      expect(supervisor.mailbox.pendingConversations()).toHaveLength(0)
      vault.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it("连续投递只排一个唤醒（一个活跃群 3 秒来 20 条不该排 20 个定时器）", async () => {
    vi.useFakeTimers()
    try {
      const vault = seed()
      const { service, clock } = makeService(vault)
      const supervisor = service.inboundSupervisor
      if (supervisor === null) throw new Error("supervisor 未就绪")

      const ids = ["b1", "b2", "b3", "b4", "b5"]
      new MessageRepository(vault.db).upsertMany(
        ids.map((id) => ({
          id,
          channelId: "dingtalk" as const,
          conversationId: "conv-1",
          externalId: `ext-${id}`,
          senderExternalId: "other",
          senderDisplayName: "小李",
          contentText: "连发",
          sentAt: NOW,
          direction: "inbound" as const,
          isSelf: false,
          createdAt: NOW,
        })),
      )
      for (const id of ids) {
        supervisor.mailbox.push({ messageId: id, conversationId: "conv-1" })
        service.onDelivered()
      }

      /**
       * 判据是**唤醒只跑了一轮**。
       *
       * 数定时器总数是不行的：`onDelivered` 还会排一个快照节流的尾部定时器
       * （那一个也是"最多一个"，见 emitSnapshotThrottled）。所以这里数的是
       * "推进到唤醒点时跑了几轮 tick" —— 排 5 个唤醒的后果正是 5 次重复
       * tick，前 4 次拿到空批次或半批，而那在日志与结果上几乎看不出来。
       *
       * ★ 接入静默期后 `wake()` 改成 debounce（每次投递**重排**而不是沿用
       * 第一个定时器），所以这条断言的语义从"只排了一个"变成"只跑了一轮" ——
       * 后者才是真正要的性质，前者只是当时的实现方式。重排本身是必需的：
       * 沿用旧定时器会让唤醒在对方仍在连发时触发，取到空批次。
       */
      let ticks = 0
      const originalTick = service.tick.bind(service)
      service.tick = async () => {
        ticks += 1
        return originalTick()
      }

      // 那一次唤醒要把 5 条**一起**带走（合并语义不能因为唤醒而变）。
      // 推进量要同时过合并窗口与静默期 —— 与 runOneTurn 同一个理由。
      clock.advance(10_000)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(ticks).toBe(1)
      expect(supervisor.mailbox.pendingConversations()).toHaveLength(0)
      vault.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it("stop() 清掉待触发的唤醒（否则它会在 detach 之后查已关闭的库）", async () => {
    vi.useFakeTimers()
    try {
      const vault = seed()
      const { service } = makeService(vault)
      const supervisor = service.inboundSupervisor
      if (supervisor === null) throw new Error("supervisor 未就绪")

      supervisor.mailbox.push({ messageId: "m1", conversationId: "conv-1" })
      service.onDelivered()
      expect(vi.getTimerCount()).toBeGreaterThan(0)

      /**
       * ★ 这一条不是洁癖：唤醒在 `detach()` 之后触发会调 `tick()`，
       * 而那时 `db` 已经是 null → 抛一个无人 catch 的
       * `The database connection is not open`（登出时稳定复现的那一类）。
       */
      service.stop()
      expect(vi.getTimerCount()).toBe(0)
      vault.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * ★ 真发送：「标记已发」换成真的发出去。
 *
 * ## 这一组锁的是"什么时候**不该**发"
 *
 * 发出去的动作不可逆，所以断言的重点不是"能发"而是**每一道门都真的拦得住**：
 * 没授权 → 不发；停摆 → 不发；正文被改过 → 发的是改后的那份。
 *
 * 还有一条容易被忽略的：**发失败时草稿必须留在 pending**。
 * 标成 sent 的话它从草稿箱消失，而它其实没发出去 ——
 * 那正是原来"标记已发"那个假状态的问题（用户以为发过了）。
 */
describe("★ 真发送：四道门 + 失败不改状态", () => {
  function sendCli(behavior?: { throws?: unknown; returns?: unknown }) {
    const calls: string[][] = []
    return {
      calls,
      runner: {
        json: <T>(args: readonly string[]): Promise<T> => {
          calls.push([...args])
          if (behavior?.throws !== undefined) return Promise.reject(behavior.throws)
          return Promise.resolve((behavior?.returns ?? { openMessageId: "msgFAKE" }) as T)
        },
        run: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
      },
    }
  }

  function serviceForSend(
    vault: ReturnType<typeof openTestVault>,
    cli: { json: <T>(args: readonly string[]) => Promise<T>; run: () => Promise<unknown> },
  ) {
    const clock = new ManualClock(NOW)
    const service = new PersonaService({
      clock,
      logger,
      llmProvider: staticLlmProvider(null),
      getWindow: () => null,
      cli: cli as never,
      /** ★ 关掉短路：不关的话第 ① 层会拦住一切，这一组就什么都没验到 */
      forceSendShortCircuit: false,
    })
    // ★ agent 目录按 vault（attach 时给）—— 见 AgentDirs
    const ws = tempDir("mycontext-ws-")
    service.attach(vault.db, undefined, {
      workspaceRoot: ws,
      home: join(ws, "agent-home"),
      npmCache: join(ws, "npm-cache"),
    })
    return { service, clock }
  }

  /** 造一条待审草稿。 */
  function seedDraft(vault: ReturnType<typeof openTestVault>, text = "收到") {
    const runs = new PersonaRunRepository(vault.db)
    runs.insertRun(
      {
        id: "run-1",
        conversationId: "conv-1",
        triggerMessageId: "m1",
        draftText: text,
        confidence: null,
        decision: "drafted",
        decisionReason: "grant_missing",
        failedConditions: [],
        latencyMs: 1,
        costTokens: null,
        error: null,
      },
      NOW,
    )
    runs.insertDraft(
      {
        id: "d1",
        runId: "run-1",
        conversationId: "conv-1",
        replyToExternalId: "ext-m1",
        text,
        citations: ["m1"],
        notSentReason: "grant_missing",
      },
      NOW,
    )
    return runs
  }

  /**
   * ★ 没有本地授权记录也能发 —— 这是一次刻意的放宽。
   *
   * 原来这里断言的是"没授权 → 一次命令都不调"。实测证明那个前提错了：
   * `chat chmod chat.message:send` 在真实环境上**授不下来**
   * （服务端 `scope未配置授权规则`，`chat.group:destroy` 同样），
   * 而 `chat message send --dry-run` **干净通过**、没有权限抱怨。
   *
   * 硬性要求一个拿不到的东西 = 把功能永久焊死。所以"渠道允不允许发"
   * 改由**真发一次的返回**回答（权限类错误 → 降级 + 不重试，见下面那条）。
   */
  it("没有本地授权记录也能发（那道授权在真实环境上拿不到）", async () => {
    const vault = seed()
    seedDraft(vault)
    const { calls, runner } = sendCli()
    const { service } = serviceForSend(vault, runner)

    const result = await service.resolveDraft({ draftId: "d1", action: "send" })

    expect(result.delivered).toBe(true)
    // 真的调了发送命令
    expect(calls.some((args) => args[1] === "message" && args[2] === "send")).toBe(true)

    await service.detach()
    vault.close()
  })

  /**
   * ★ 渠道拒绝时**降级并不重试**。
   *
   * 这条路径比以前更重要了：既然不再有"必须先授权"的前置，
   * 那么"渠道到底允不允许我们发"就**只能**从真发一次的返回里知道。
   */
  it("渠道返回权限错误 → 不发成功、该会话降级为 draft、草稿留着", async () => {
    const vault = seed()
    seedDraft(vault)
    const { runner } = sendCli({
      throws: new Error("permission denied: scope chat.message:send"),
    })
    const { service } = serviceForSend(vault, runner)

    // 先把这个会话设成自动，才能看出"降级"真的发生了
    new PersonaConfigRepository(vault.db).upsert("conv-1", { replyMode: "auto" }, NOW)

    const result = await service.resolveDraft({ draftId: "d1", action: "send" })
    expect(result.delivered).toBe(false)

    /**
     * 降级是关键：不降的话这个会话会一直尝试自动发、一直被拒 ——
     * 而用户看到的是"数字人不回了"，看不出是权限问题。
     */
    expect(new PersonaConfigRepository(vault.db).get("conv-1")?.replyMode).toBe("draft")
    // 草稿还在，用户还能手动处理
    expect(service.drafts().some((d) => d.id === "d1")).toBe(true)

    await service.detach()
    vault.close()
  })

  it("真发：命令被调、草稿标 sent、写了 dh_send_attempts", async () => {
    const vault = seed()
    seedDraft(vault)
    const { calls, runner } = sendCli()
    const { service } = serviceForSend(vault, runner)

    const result = await service.resolveDraft({ draftId: "d1", action: "send" })

    expect(result.delivered).toBe(true)
    const sendCall = calls.find((args) => args[1] === "message" && args[2] === "send")
    expect(sendCall).toBeDefined()
    expect(sendCall).toContain("--uuid")
    // 草稿从待审里消失了（真发成功才该消失）
    expect(service.drafts().some((d) => d.id === "d1")).toBe(false)

    /**
     * ★ 必须写 `dh_send_attempts` —— 否则 policy 的频率限制永远不触发。
     * 这一条把"真发"与"限流能生效"连起来。
     */
    const runs = new PersonaRunRepository(vault.db)
    expect(runs.recentSendTimestamps({ conversationId: "conv-1", sinceMs: 0 })).toHaveLength(1)

    await service.detach()
    vault.close()
  })

  it("发的是**编辑后**的正文（先落库再发，否则发的是原稿）", async () => {
    const vault = seed()
    seedDraft(vault, "原稿")
    const { calls, runner } = sendCli()
    const { service } = serviceForSend(vault, runner)

    await service.resolveDraft({ draftId: "d1", action: "send", editedText: "改过的正文" })

    const sendCall = calls.find((args) => args[1] === "message" && args[2] === "send") ?? []
    const textIndex = sendCall.indexOf("--text")
    /**
     * ★ 顺序敏感：先发后落库的话这里会是「原稿」——
     * 而用户以为自己改过了。守卫第 ② 层按 draftId 重读库比对 contentHash，
     * 读到的必须是用户实际批准的那一份。
     */
    expect(sendCall[textIndex + 1]).toBe("改过的正文")

    await service.detach()
    vault.close()
  })

  it("全局停摆时不发（kill switch 是用户的第一反应，必须立刻生效）", async () => {
    const vault = seed()
    seedDraft(vault)
    const { calls, runner } = sendCli()
    const { service } = serviceForSend(vault, runner)

    const beforeSend = calls.length
    service.setKillSwitch(true)

    const result = await service.resolveDraft({ draftId: "d1", action: "send" })
    expect(result.delivered).toBe(false)
    // 停摆之后没有新的命令调用
    expect(calls).toHaveLength(beforeSend)

    await service.detach()
    vault.close()
  })

  it("★ 发送失败时草稿**留在 pending**（标 sent 会让它从草稿箱消失）", async () => {
    const vault = seed()
    seedDraft(vault)
    const { runner } = sendCli({ throws: new Error("ETIMEDOUT") })
    const { service } = serviceForSend(vault, runner)

    const result = await service.resolveDraft({ draftId: "d1", action: "send" })
    expect(result.delivered).toBe(false)
    /**
     * ★ 这一条是整组里最重要的之一：网关失败之后草稿必须还在。
     * 原来那个"标记已发"就是这个问题的极端版本 —— 状态是假的，
     * 而没有任何东西能纠正它。
     */
    expect(service.drafts().some((d) => d.id === "d1")).toBe(true)

    // 失败也要落一行（"连续失败很多次"本身是要能看见的信号）
    const row = vault.db
      .prepare<[], { state: string }>(`SELECT state FROM dh_send_attempts LIMIT 1`)
      .get()
    expect(row?.state).toBe("failed")

    await service.detach()
    vault.close()
  })

  it("丢弃不调命令（那条路上不该有任何对外调用）", async () => {
    const vault = seed()
    seedDraft(vault)
    const { calls, runner } = sendCli()
    const { service } = serviceForSend(vault, runner)

    const result = await service.resolveDraft({ draftId: "d1", action: "discard" })
    expect(result.ok).toBe(true)
    expect(result.delivered).toBe(false)
    expect(calls).toHaveLength(0)
    expect(service.drafts().some((d) => d.id === "d1")).toBe(false)

    await service.detach()
    vault.close()
  })
})

/**
 * ★ 自动发送：判定说能发 → **真的发出去**，而不是只记一行。
 *
 * ## 为什么这一组的核心是"审计表不许说谎"
 *
 * `evaluatePolicy` 全过时返回 `decision: "auto_sent"`。那个值曾经被原样写进
 * `dh_runs` 就结束了 —— `sendDraft` 的唯一调用者是用户在草稿箱手点。
 * 当时因为 `grant` 硬编码成 null，这个状态到不了，所以问题是潜伏的；
 * 授权接上之后它会立刻浮出来：
 *
 * `dh_runs.decision = 'auto_sent'`，而 `dh_send_attempts` 里没有对应行、
 * 消息也没发出去。那比不发更坏 —— 而且 policy 的频率限制读的正是那张表，
 * 于是"防连发"那一条也跟着失效。
 *
 * 所以断言的是两张表**互相自洽**：说发了就得有发送记录，说没发就得有原因。
 */
describe("★ 自动发送：auto_sent 必须真的发出去", () => {
  /** 周三下午，落在 DEFAULT_WORK_HOURS 内（周日会先被 outside_work_hours 短路）。 */
  const WORK_TIME = 1_785_306_600_000

  function sendCli(behavior?: { throws?: unknown }) {
    const calls: string[][] = []
    return {
      calls,
      runner: {
        json: <T>(args: readonly string[]): Promise<T> => {
          calls.push([...args])
          if (behavior?.throws !== undefined) return Promise.reject(behavior.throws)
          return Promise.resolve({ openMessageId: "msgAUTO1" } as T)
        },
        run: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
      },
    }
  }

  /**
   * 一个「判定层全放行」的假闸。
   *
   * ★ 必须注入：判定层现在是 `agent_allows_auto` 那一条 policy 的唯一输入，
   * 而真实现要 spawn 已发布产物里的 `persona.py` —— 测试机上没有那个产物，
   * 于是三个方法都会返回 null（判定不可得）→ 一律降级。那时这一组的
   * "没发"是恒真的，也就什么都没验到。
   *
   * 记下每次调用，好让下面的用例断言**三关都真的跑过**：
   * 少跑一关（比如忘了在真发前跑 `fresh`）时，行为上仍然"发出去了"，
   * 只有调用记录能看出那一关被跳过了。
   */
  function passingGate(): {
    gate: PersonaGateLike
    seen: string[]
    /** 每次被调收到的 skillDir —— 用来断言"gate 读的是 forgeSkillRoot，不是 workspace 副本"。 */
    dirs: string[]
    freshness: { stale: boolean; reason: string | null } | null
  } {
    const seen: string[] = []
    const dirs: string[] = []
    const state = {
      seen,
      dirs,
      freshness: { stale: false, reason: null } as {
        stale: boolean
        reason: string | null
      } | null,
      gate: {
        brief: (dir: string, target: { messageId: string | null }) => {
          seen.push(`brief:${target.messageId ?? ""}`)
          dirs.push(dir)
          /**
           * ★ 带上理解类字段：判定闸现在同时供给"能不能发"（verdict）与
           * "要回什么"（answering / respondingTo / precedents）。这个替身
           * 模拟真产物的形态 —— 折了两条、有指向、有一条先例 ——
           * 于是起草提示词走的是真实分支而不是 null 退化分支。
           */
          return Promise.resolve({
            verdict: "reply" as const,
            because: ["measured default"],
            answering: {
              text: "在改\n好了叫我",
              lastText: "好了叫我",
              messageCount: 2,
              sender: "对方",
            },
            respondingTo: { sender: "我", text: "推了吗" },
            precedents: [{ given: "[them] 推了吗", theyReplied: "好 推了说一声" }],
          })
        },
        check: (dir: string, text: string) => {
          seen.push(`check:${text}`)
          dirs.push(dir)
          return Promise.resolve({ verdict: "pass" as const, issues: [] })
        },
        fresh: (dir: string, target: { lastSeenId: string | null }) => {
          seen.push(`fresh:${target.lastSeenId ?? ""}`)
          dirs.push(dir)
          return Promise.resolve(state.freshness)
        },
      },
    }
    return state
  }

  /**
   * 一个「所有闸都开着」的服务：auto 模式 + 白名单 + 已授权 + 工作时间内。
   *
   * 每一条都要显式打开，因为它们本来就是独立的门 —— 少开一条这组用例
   * 会因为**别的原因**不发，而那时断言"没发"是恒真的。
   */
  function serviceReadyToAutoSend(
    vault: ReturnType<typeof openTestVault>,
    cli: { json: <T>(args: readonly string[]) => Promise<T>; run: () => Promise<unknown> },
    llm: LlmClient,
    gate: PersonaGateLike,
  ) {
    const clock = new ManualClock(WORK_TIME)
    const service = new PersonaService({
      clock,
      logger,
      llmProvider: staticLlmProvider(llm),
      getWindow: () => null,
      cli: cli as never,
      gate,
      // ★ 关掉短路，否则第 ① 层拦住一切，这一组什么都没验到
      forceSendShortCircuit: false,
    })
    /**
     * ★ 必须给 forgeSkillRoot —— 判定闸的 skill 目录从它推。
     *
     * `gateSkillDir()` 现在返回 `<forgeSkillRoot>/persona-persona`（改
     * `skills.paths` 之后 workspace 里不再有副本）。不给它 = gate 目录不可得
     * = 三关全返回 null = 每一轮都降级成草稿 —— 而那时"没自动发"是恒真的，
     * 这一组用例什么都验不到。
     */
    const ws = tempDir("mycontext-ws-")
    service.attach(vault.db, makeForgeSkillRoot(), {
      workspaceRoot: ws,
      home: join(ws, "agent-home"),
      npmCache: join(ws, "npm-cache"),
    })
    service.saveConfig({
      conversationId: "conv-1",
      replyMode: "auto",
      triggerMode: "all",
    })
    return { service, clock }
  }

  /** 直接写一条有效授权：走 requestGrant 会多一次 CLI 调用，混淆 calls 断言。 */
  function grantSend(vault: ReturnType<typeof openTestVault>): void {
    vault.db
      .prepare(
        `INSERT INTO dh_send_grants
           (id, conversation_id, scope, agent_code, grant_type, perm_params_json,
            granted_at, expires_at)
         VALUES ('g1', 'conv-1', ?, 'wukong', 'timed', '{}', ?, ?)`,
      )
      .run(SEND_SCOPE, WORK_TIME, WORK_TIME + 7 * 24 * 60 * 60_000)
  }

  /**
   * 标记「这条 @了本人」。
   *
   * ★ 这一组必须有它：`conv-1` 是**群聊**，而场景判定的第一条
   * （`is_direct_or_mentioned`）要求群里必须 @我 才允许自动发 ——
   * 那是"别人随口说的一句话不该触发以本人身份发言"。
   *
   * 写 `message_mentions` 而不是在正文里塞 `@`：`handleBatch` 读的是这张表
   * （采集时已解析落库），在正文里再匹配一遍会与准入闸的判据不一致。
   */
  function mentionSelf(vault: ReturnType<typeof openTestVault>): void {
    vault.db
      .prepare(
        `INSERT INTO message_mentions (message_id, actor_external_id, is_self)
         VALUES ('m1', 'self', 1)`,
      )
      .run()
  }

  /**
   * 让模型回一句**够短、无疑问、无承诺**的话。
   *
   * 场景判定（`evaluateScene`）是必过的一条，而它按实测语料卡在 60 字符、
   * 且拒绝问句与承诺句。回一句"收到"是为了让这组用例真的走到发送，
   * 而不是被场景拦住 —— 被场景拦住时"没发"同样是恒真的。
   */
  function shortReplyLlm(): LlmClient {
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
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      reply: "收到",
                      holdForReview: false,
                      reviewReason: "",
                    }),
                  },
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          text: () => Promise.resolve(""),
        } as unknown as Response),
    })
  }

  async function runTurn(
    service: PersonaService,
    vault: ReturnType<typeof openTestVault>,
    clock: ManualClock,
  ): Promise<void> {
    const supervisor = service.inboundSupervisor
    if (supervisor === null) throw new Error("supervisor 未就绪")
    const message = new MessageRepository(vault.db).findById("m1")
    const conversation = new ConversationRepository(vault.db).findById("conv-1")
    if (message === null || conversation === null) throw new Error("seed 不完整")
    vault.db.prepare("UPDATE messages SET sent_at = ? WHERE id = 'm1'").run(clock.now())
    supervisor.onInbound({
      message: { ...message, sentAt: clock.now() },
      conversation,
      config: new PersonaConfigRepository(vault.db).get("conv-1"),
      mentionsSelf: false,
    })
    // 推过合并窗口**与静默期**（见上面 runOneTurn 的注释）
    clock.advance(10_000)
    await service.tick()
  }

  it("★ 全部闸都过 → 真调了发送命令，且两张表自洽", async () => {
    const vault = seed()
    mentionSelf(vault)
    grantSend(vault)
    const { calls, runner } = sendCli()
    const gate = passingGate()
    const { service, clock } = serviceReadyToAutoSend(vault, runner, shortReplyLlm(), gate.gate)

    await runTurn(service, vault, clock)

    /**
     * ① 真的调了命令。缺了这条断言，"只记一行不发"的实现照样绿 ——
     * 那正是修复前的状态。
     */
    const send = calls.find((args) => args[0] === "chat" && args[1] === "message")
    expect(send, `没有调用发送命令；实际调用：${JSON.stringify(calls)}`).toBeDefined()

    // ② run 记的是 auto_sent
    const run = new PersonaRunRepository(vault.db).recentRuns("conv-1", 5)[0]
    expect(run?.decision).toBe("auto_sent")

    // ③ 审计表有对应行，且带着平台返回的消息 id（对账靠它）
    const attempt = vault.db
      .prepare<
        [],
        { state: string; ext: string | null; grant_id: string | null }
      >(`SELECT state, sent_message_external_id AS ext, grant_id FROM dh_send_attempts LIMIT 1`)
      .get()
    expect(attempt?.state).toBe("sent")
    expect(attempt?.ext).toBe("msgAUTO1")
    // grant_id 曾经恒 null —— 那让"凭哪个授权发的"永远查不到
    expect(attempt?.grant_id).toBe("g1")

    /**
     * ★★ 审计记的目标必须是**真正发出去的那个**。
     *
     * 群聊时 `--group <externalId>`，所以 target 就是会话 external_id ——
     * 这条在群聊上是恒真的。真正会咬人的是**单聊**：那时发送用的是对端
     * `openDingTalkId` 而审计原来记的是 `conversation.externalId`（cid），
     * 一行自相矛盾的审计。单聊那条断言在下面单独一个用例里
     * （群聊这里锁不住它 —— 两个值恰好相同）。
     */
    const target = vault.db
      .prepare<
        [],
        { kind: string; ext: string }
      >(`SELECT target_kind AS kind, target_external_id AS ext FROM dh_send_attempts LIMIT 1`)
      .get()
    expect(target?.kind).toBe("group")
    expect(target?.ext).toBe(sendArgAfter(send ?? [], "--group"))

    /**
     * ④ ★ 判定层的三关都真的跑过。
     *
     * 行为断言（"发出去了"）证明不了这个：少跑一关时它照样发。
     * 尤其是 `fresh` —— 它是唯一挡在真发之前的一关，跳过它的表现是
     * "库落后时照样把过时的话发出去"，而那在测试里完全看不出来。
     */
    expect(gate.seen).toEqual(["brief:m1", "check:收到", "fresh:m1"])

    /**
     * ④★ ★ gate 读的**必须是 forgeSkillRoot**，不是 workspace 副本。
     *
     * 之前 gateSkillDir 指到 `<cwd>/.opencode/skills/persona-persona`。改
     * `skills.paths` 之后 workspace **不再有副本**，那个路径就变成"目录不存在"
     * → `gate.available()` 恒 false → 每一轮返回 null → `runCheck` 强置
     * holdForReview 且记 reviewReason=`review_gate_unavailable`。
     *
     * 现象是**用户勾了白名单、开了 auto、蒸馏也发布了**，UI 上每条回复仍进待审。
     * 唯一稳定的判据是"gate 到底读了哪个目录"。锁一次，回归时就有可查证据。
     */
    for (const dir of gate.dirs) {
      expect(dir).toContain("persona-persona")
      // 反面：不能再指向 workspace 的 <cwd>/.opencode/skills/
      expect(dir).not.toContain(".opencode/skills")
    }

    /** ⑤ 自动发送必须记成 agent 自产 —— 采集回流后要标 origin='agent'。 */
    const source = vault.db
      .prepare<[], { source: string }>(`SELECT source FROM dh_send_attempts LIMIT 1`)
      .get()
    expect(source?.source).toBe("agent_auto")

    await service.detach()
    vault.close()
  })

  /**
   * ★★ 单聊：审计记的目标必须是**对端的人**，不是会话 id。
   *
   * ## 这一条锁的是一次真实的"审计说谎"
   *
   * 单聊发送用 `--open-dingtalk-id <对端 openDingTalkId>`，而审计原来记的是
   * `conversation.externalId`（`cid…`，会话 id）。实测本机那条记录就是
   * `target_kind=open_id` + `target_external_id=cid…` —— 一行**自相矛盾**的
   * 审计：声称"按人发"却记了个会话 id。
   *
   * 而这张表的唯一用途就是事后追"这条发给了谁"。真要追一次误发，
   * 那个值指向的东西在渠道里根本不是一个人，而 `target_kind` 又让人
   * 以为它是 —— 于是排查会从一开始就走错方向。
   *
   * ★ 断言形式：拿**实际命令行**里 `--open-dingtalk-id` 后面那个值当真源
   * （见 `sendArgAfter`）。拿两个我们自己算的常量互比是同义反复。
   */
  it("★★ 单聊：审计记的是对端 openDingTalkId，不是会话 cid", async () => {
    const vault = seed()
    // 把会话改成单聊，并给一个形状真实的对端（D… 33 字符）
    const peer = `D${"P".repeat(32)}`
    vault.db.prepare(`UPDATE conversations SET type = 'direct' WHERE id = 'conv-1'`).run()
    vault.db
      .prepare(`UPDATE messages SET sender_external_id = ?, is_self = 0 WHERE id = 'm1'`)
      .run(peer)
    mentionSelf(vault)
    grantSend(vault)
    const { calls, runner } = sendCli()
    const { service, clock } = serviceReadyToAutoSend(
      vault,
      runner,
      shortReplyLlm(),
      passingGate().gate,
    )

    await runTurn(service, vault, clock)

    const send = calls.find((args) => args[0] === "chat" && args[1] === "message")
    expect(send, `没有调用发送命令；实际调用：${JSON.stringify(calls)}`).toBeDefined()
    // 真传给 CLI 的那个值（真源）
    const sentTo = sendArgAfter(send ?? [], "--open-dingtalk-id")
    expect(sentTo).toBe(peer)

    const target = vault.db
      .prepare<
        [],
        { kind: string; ext: string }
      >(`SELECT target_kind AS kind, target_external_id AS ext FROM dh_send_attempts LIMIT 1`)
      .get()
    expect(target?.kind).toBe("open_id")
    // ★ 审计 == 真传的。改回记 conversation.externalId 时这条必红。
    expect(target?.ext).toBe(sentTo)
    // ★ 反面：显式钉住"不是会话 id"（造数据失误也不会让它假绿）
    expect(target?.ext).not.toBe("cid-1")

    await service.detach()
    vault.close()
  })

  /**
   * ★ 发送失败时 decision **不许**记 auto_sent。
   *
   * 这条是整组的反面：审计表说"发了"而实际没发，是比不发更坏的状态 ——
   * 事后没有任何东西能纠正它，而频率限制还会把它算成一次真发送。
   */
  it("★ 发送失败 → decision 退回 drafted，草稿留在箱里等人工", async () => {
    const vault = seed()
    mentionSelf(vault)
    grantSend(vault)
    const { runner } = sendCli({ throws: new Error("网络炸了") })
    const { service, clock } = serviceReadyToAutoSend(
      vault,
      runner,
      shortReplyLlm(),
      passingGate().gate,
    )

    await runTurn(service, vault, clock)

    const run = new PersonaRunRepository(vault.db).recentRuns("conv-1", 5)[0]
    expect(run?.decision).toBe("drafted")
    // 原因必须带上渠道给的那句，否则"判了能发却没发"无从下手
    expect(run?.decisionReason).toContain("send_failed")

    /**
     * 草稿留在 pending：用户还能改一改再试。
     * 标成 sent 的话它从箱里消失 —— 而它其实没发出去。
     */
    const drafts = service.drafts()
    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.notSentReason).not.toBeNull()

    await service.detach()
    vault.close()
  })

  /**
   * ★ 自动发送那条路**只**落一条草稿。
   *
   * 两条的后果很实际：一条已经发出去了，另一条还在箱里等用户点 ——
   * 于是同一句话很可能被发两次，而那是不可逆的社交成本。
   */
  it("★ 自动发送后草稿箱里没有重复的那一条", async () => {
    const vault = seed()
    mentionSelf(vault)
    grantSend(vault)
    const { runner } = sendCli()
    const { service, clock } = serviceReadyToAutoSend(
      vault,
      runner,
      shortReplyLlm(),
      passingGate().gate,
    )

    await runTurn(service, vault, clock)

    const total = vault.db
      .prepare<[], { c: number }>(`SELECT count(*) AS c FROM dh_drafts`)
      .get()?.c
    expect(total).toBe(1)
    // 而且它已经是 sent，不在待审阅列表里
    expect(service.drafts()).toHaveLength(0)

    await service.detach()
    vault.close()
  })

  it("没有本地授权记录也可自动发送（用户开启自动发送就是授权来源）", async () => {
    const vault = seed()
    mentionSelf(vault)
    const { calls, runner } = sendCli()
    const { service, clock } = serviceReadyToAutoSend(
      vault,
      runner,
      shortReplyLlm(),
      passingGate().gate,
    )

    await runTurn(service, vault, clock)

    expect(calls.some((args) => args[0] === "chat" && args[1] === "message")).toBe(true)
    const run = new PersonaRunRepository(vault.db).recentRuns("conv-1", 5)[0]
    expect(run?.decision).toBe("auto_sent")
    expect(run?.failedConditions).not.toContain("has_valid_grant")

    await service.detach()
    vault.close()
  })

  /**
   * ★★ 判定不可得 ≠ 放行。
   *
   * 这一组是整份文件里最重要的三条。缺 Python、还没蒸馏过、判定层输出
   * 读不懂 —— 三种都返回 null，而**其余所有闸都是开着的**。
   * 把 null 当通过的话，"这台机器没装 Python"就等于"自动发送全放行"，
   * 而那在界面上与一切正常完全一样：没有报错、没有横幅、消息照发。
   *
   * 断言的是 `calls` 为 0（**根本没进发送**），不是"进去了但被拒了"。
   */
  describe("★ 判定不可得时一律降级为草稿", () => {
    /** 一个三个方法全返回 null 的闸 —— 也就是缺 Python / 没蒸过的形态。 */
    const blindGate: PersonaGateLike = {
      brief: () => Promise.resolve(null),
      check: () => Promise.resolve(null),
      fresh: () => Promise.resolve(null),
    }

    it("完全没有判定层（gate 为 null）→ 不发，落草稿", async () => {
      const vault = seed()
      mentionSelf(vault)
      grantSend(vault)
      const { calls, runner } = sendCli()
      // 连 gate 都不传 —— 与生产上"这台机器没有解释器"同一个形态
      const clock = new ManualClock(WORK_TIME)
      const service = new PersonaService({
        clock,
        logger,
        llmProvider: staticLlmProvider(shortReplyLlm()),
        getWindow: () => null,
        cli: runner as never,
        forceSendShortCircuit: false,
      })
      const ws = tempDir("mycontext-ws-")
      service.attach(vault.db, undefined, {
        workspaceRoot: ws,
        home: join(ws, "agent-home"),
        npmCache: join(ws, "npm-cache"),
      })
      service.saveConfig({
        conversationId: "conv-1",
        replyMode: "auto",
        triggerMode: "all",
      })

      await runTurn(service, vault, clock)

      expect(calls, `判定不可得却真发了：${JSON.stringify(calls)}`).toHaveLength(0)
      const run = new PersonaRunRepository(vault.db).recentRuns("conv-1", 5)[0]
      expect(run?.decision).toBe("drafted")
      expect(run?.failedConditions).toContain("agent_allows_auto")
      // 草稿还在，并且写着可操作的原因（去装 Python / 先蒸一次）
      const drafts = service.drafts()
      expect(drafts).toHaveLength(1)
      expect(drafts[0]?.notSentReason).toBe("review_gate_unavailable")

      await service.detach()
      vault.close()
    })

    it("brief 读不懂（返回 null）→ 不发", async () => {
      const vault = seed()
      mentionSelf(vault)
      grantSend(vault)
      const { calls, runner } = sendCli()
      const { service, clock } = serviceReadyToAutoSend(vault, runner, shortReplyLlm(), blindGate)

      await runTurn(service, vault, clock)

      expect(calls).toHaveLength(0)
      expect(service.drafts()).toHaveLength(1)

      await service.detach()
      vault.close()
    })

    /**
     * ★ `fresh` 单独一条：它是唯一**直接**挡在真发送前面的那一关。
     *
     * 前两条被拦在 policy 那一层（`agent_allows_auto` 不通过，
     * 于是 `decision` 根本到不了 `auto_sent`）。这一条不同：
     * policy 全过、`decision === "auto_sent"`，只有 `fresh` 说不行。
     * 少了它，"库落后 5 分钟"时我们会把一条过时的话真发出去。
     */
    it("★ brief/check 都放行、只有 fresh 判 stale → 仍然不发", async () => {
      const vault = seed()
      mentionSelf(vault)
      grantSend(vault)
      const { calls, runner } = sendCli()
      const gate = passingGate()
      gate.freshness = { stale: true, reason: "the local store is 300s behind" }
      const { service, clock } = serviceReadyToAutoSend(vault, runner, shortReplyLlm(), gate.gate)

      await runTurn(service, vault, clock)

      expect(calls, `stale 却真发了：${JSON.stringify(calls)}`).toHaveLength(0)
      const run = new PersonaRunRepository(vault.db).recentRuns("conv-1", 5)[0]
      expect(run?.decisionReason).toBe("not_fresh")
      // 草稿留着 + 带着滞后原因：用户看一眼就知道该不该手动补发
      const drafts = service.drafts()
      expect(drafts).toHaveLength(1)
      expect(drafts[0]?.notSentReason).toContain("300s behind")

      await service.detach()
      vault.close()
    })

    /**
     * ★★ 「本人已经回过这一轮」—— 只挡自动发，**草稿必须留下**。
     *
     * ## 这一条锁的是一个被明确要求去掉的限制
     *
     * 曾经这里是 `finalizeRunDecision(silent)` + `return`：已经跑完、已经花了
     * 钱的 agent 产出被**整个丢掉**，用户永远看不到它。而"你已回过"不代表
     * 这条草稿没价值（可能想补一句、换个说法、或只是想看它会怎么答）。
     *
     * 现在的分工与 `fresh` 闸一致：不自动发（冗余消息不可逆）+ 草稿照样落，
     * 原因写 `already_answered`。
     */
    it("★★ 本人已回过 → 不自动发，但草稿仍然落库且原因是 already_answered", async () => {
      const vault = seed()
      mentionSelf(vault)
      grantSend(vault)
      const { calls, runner } = sendCli()
      const gate = passingGate()
      const { service, clock } = serviceReadyToAutoSend(vault, runner, shortReplyLlm(), gate.gate)

      /**
       * 造出"我已经自己回过这一轮"：在触发消息（ext-m1）之后插一条本人消息。
       * `isReplyTurnOpen` 的判据正是"同会话里有更晚的 is_self 消息"。
       */
      new MessageRepository(vault.db).upsertMany([
        {
          id: "m-self-later",
          channelId: "dingtalk",
          conversationId: "conv-1",
          externalId: "ext-self-later",
          senderExternalId: "me",
          senderDisplayName: "我",
          contentText: "我已经自己回了",
          sentAt: clock.now() + 60_000,
          direction: "outbound",
          isSelf: true,
          createdAt: clock.now() + 60_000,
        },
      ])

      await runTurn(service, vault, clock)

      // ① 不自动发 —— 这一半必须保留（发冗余消息不可逆）
      expect(calls, `已回过却仍然自动发了：${JSON.stringify(calls)}`).toHaveLength(0)
      // ② ★ 草稿**在**（改动前这里是 0 条 —— 产出被丢掉了）
      const drafts = service.drafts()
      expect(drafts, "已回过就把草稿丢了 —— 这正是要去掉的限制").toHaveLength(1)
      expect(drafts[0]?.notSentReason).toBe("already_answered")

      await service.detach()
      vault.close()
    })

    /**
     * ★★ 已回过的草稿**点发送能发出去**。
     *
     * 曾经 `resolveDraft` 会再查一次并拒掉（`reason: "draft_expired"`，
     * UI 显示"这轮消息已经被你回复，草稿已过期"）—— 那是把系统的猜测放在
     * 用户的明确意图之上：他看着草稿按了发送，我们回一句"已过期"。
     */
    it("★★ 已回过的草稿：用户点发送 → 真的发出去（不再被 draft_expired 拒）", async () => {
      const vault = seed()
      mentionSelf(vault)
      grantSend(vault)
      const { calls, runner } = sendCli()
      const gate = passingGate()
      const { service, clock } = serviceReadyToAutoSend(vault, runner, shortReplyLlm(), gate.gate)

      new MessageRepository(vault.db).upsertMany([
        {
          id: "m-self-later",
          channelId: "dingtalk",
          conversationId: "conv-1",
          externalId: "ext-self-later",
          senderExternalId: "me",
          senderDisplayName: "我",
          contentText: "我已经自己回了",
          sentAt: clock.now() + 60_000,
          direction: "outbound",
          isSelf: true,
          createdAt: clock.now() + 60_000,
        },
      ])

      await runTurn(service, vault, clock)
      const draft = service.drafts()[0]
      expect(draft).toBeDefined()
      // 自动发那一趟没发（上一条已锁），所以这里的调用数是干净的基线。
      expect(calls).toHaveLength(0)

      const outcome = await service.resolveDraft({ draftId: draft!.id, action: "send" })

      expect(outcome.reason, "已回过的草稿被拒发了").not.toBe("draft_expired")
      expect(outcome.delivered, "用户点了发送却没真发").toBe(true)
      expect(calls.length, "没有调到发送命令").toBeGreaterThan(0)

      await service.detach()
      vault.close()
    })

    /** `check` 判 block（草稿本身陈述了一个受限风险类）→ 降级。 */
    it("check 判 block → 降级为草稿，并把命中的问题写进原因", async () => {
      const vault = seed()
      mentionSelf(vault)
      grantSend(vault)
      const { calls, runner } = sendCli()
      const gate = passingGate()
      const blocking: PersonaGateLike = {
        ...gate.gate,
        check: () =>
          Promise.resolve({ verdict: "block" as const, issues: ["states a commitment"] }),
      }
      const { service, clock } = serviceReadyToAutoSend(vault, runner, shortReplyLlm(), blocking)

      await runTurn(service, vault, clock)

      expect(calls).toHaveLength(0)
      expect(service.drafts()[0]?.notSentReason).toBe("states a commitment")

      await service.detach()
      vault.close()
    })

    /**
     * ★ `verdict: silent` → 连草稿都不出，也不调模型。
     *
     * 判定层说这一轮没什么要答的（纯客套"好的""收到"）。那时出一条草稿
     * 是在给用户制造工作 —— 而这个队列的全部问题就是它太长了。
     */
    it("★ verdict=silent → 不调模型、不出草稿，run 记 silent", async () => {
      const vault = seed()
      mentionSelf(vault)
      grantSend(vault)
      const { runner } = sendCli()
      let llmCalls = 0
      const countingLlm = new LlmClient({
        baseUrl: "https://fake.invalid",
        apiKey: "k",
        model: "m",
        sleep: () => Promise.resolve(),
        fetchImpl: () => {
          llmCalls += 1
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                choices: [{ message: { content: "{}" } }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }),
            text: () => Promise.resolve(""),
          } as unknown as Response)
        },
      })
      const silentGate: PersonaGateLike = {
        brief: () =>
          Promise.resolve({
            verdict: "silent" as const,
            because: ["pure acknowledgement, not an ask"],
            answering: { text: "收到", lastText: "收到", messageCount: 1, sender: "对方" },
            respondingTo: null,
            precedents: [],
          }),
        check: () => Promise.resolve({ verdict: "pass" as const, issues: [] }),
        fresh: () => Promise.resolve({ stale: false, reason: null }),
      }
      const { service, clock } = serviceReadyToAutoSend(vault, runner, countingLlm, silentGate)

      await runTurn(service, vault, clock)

      // ★ 省掉的是一次模型调用 —— 那是这条路上唯一真花钱的东西
      expect(llmCalls).toBe(0)
      expect(service.drafts()).toHaveLength(0)
      const run = new PersonaRunRepository(vault.db).recentRuns("conv-1", 5)[0]
      expect(run?.decision).toBe("silent")
      // 原因要是判定层那句人话，而不是一个我们自己编的 code
      expect(run?.decisionReason).toContain("acknowledgement")

      await service.detach()
      vault.close()
    })
  })
})

/**
 * ★ 数字人自己发的消息必须被标出来（防自我强化漂移）。
 *
 * ## 为什么只能自己记
 *
 * 钉钉客户端上那条「通过 AI 发送」的角标**没有从 OpenAPI 透出来** ——
 * 核对过 1429 条真实消息对象，字段只有 content / createTime /
 * openConversationId / openMessageId / sender / senderOpenDingTalkId 六个。
 * （`search-advanced --only-robot-messages` 过滤的是**机器人**消息，
 * 与"用户通过 AI 发送"不是一回事。）
 *
 * ## 不标的后果
 *
 * 数字人的回复被采集回来，当成本人的真实语料再蒸一遍 —— 于是它开始
 * 模仿自己。forge 的 vault 适配器专门读 `origin='agent'` 来排除它们，
 * 而那是它相对 dws 适配器唯一的优势（dws 只能靠本地日志重建）。
 */
describe("★ agent 自产消息的来源标记", () => {
  it("按平台 id 认领，且不误伤别人的消息", () => {
    const vault = seed()
    const messages = new MessageRepository(vault.db)
    messages.upsertMany([
      {
        id: "m-agent",
        channelId: "dingtalk",
        conversationId: "conv-1",
        externalId: "msgAGENT",
        senderExternalId: "self",
        contentText: "收到",
        sentAt: NOW + 1000,
        direction: "outbound",
        isSelf: true,
        createdAt: NOW + 1000,
      },
    ])

    const claimed = messages.claimAgentOrigin("dingtalk", ["msgAGENT"])
    expect(claimed).toBe(1)
    expect(messages.findById("m-agent")?.origin).toBe("agent")
    // 别人的那条（seed 里的 m1）不能被动到
    expect(messages.findById("m1")?.origin).toBe("human")

    /**
     * 幂等：重放同一批返回 0 而不是反复写。
     * Outbox 消费者可能因为抢占重放，而"每次都改一行"会让
     * 变更计数一直涨，看起来像有新数据。
     */
    expect(messages.claimAgentOrigin("dingtalk", ["msgAGENT"])).toBe(0)

    vault.close()
  })

  /**
   * ★ 标了之后**真的**被蒸馏排除。
   *
   * 只断言"这一列被改了"证明不了排除生效 —— 那一列有两个读者
   * （本地索引与 forge 的 vault 适配器），而它们各自查一遍。
   */
  it("标记后不再作为蒸馏候选", () => {
    const vault = seed()
    const messages = new MessageRepository(vault.db)
    const window = { start: NOW - 1000, end: NOW + 10_000, limit: 50 }

    expect(messages.distillableInWindow(window).map((row) => row.id)).toContain("m1")
    messages.claimAgentOrigin("dingtalk", ["ext-m1"])
    expect(messages.distillableInWindow(window).map((row) => row.id)).not.toContain("m1")

    vault.close()
  })

  /**
   * ★★ 白名单按 **external_id** 过滤，不是内部 PK。
   *
   * 这锁的是一个潜伏的定时炸弹：`distill_sources` 存的会话白名单是
   * external_id（`cid-1`），而 `messages.conversation_id` 是内部 PK（`conv-1`）。
   * 曾经这里直接 `conversation_id IN (?)` + 传 external_id → 永不相等 → 匹配 0 行。
   * 现在走子查询把 external_id 翻成内部 id 再过滤。
   */
  it("白名单用 external_id 命中（传内部 PK 反而匹配 0 行）", () => {
    const vault = seed()
    const messages = new MessageRepository(vault.db)
    const window = { start: NOW - 1000, end: NOW + 10_000, limit: 50 }

    // ★ 正确用法：external_id（cid-1）→ 命中 m1
    expect(
      messages
        .distillableInWindow({ ...window, conversationExternalIds: ["cid-1"] })
        .map((row) => row.id),
    ).toContain("m1")

    // 不在白名单里的 external_id → 一条都不返回
    expect(
      messages.distillableInWindow({ ...window, conversationExternalIds: ["cid-not-exist"] }),
    ).toHaveLength(0)

    // ★ 反证那个炸弹：传**内部 PK**（conv-1）当白名单 → 0 行（它不是 external_id）
    expect(
      messages.distillableInWindow({ ...window, conversationExternalIds: ["conv-1"] }),
    ).toHaveLength(0)

    vault.close()
  })

  it("发送记录只暴露真发成功的平台 id", () => {
    const vault = seed()
    const runs = new PersonaRunRepository(vault.db)
    const base = {
      draftId: null,
      conversationId: "conv-1",
      targetKind: "group" as const,
      targetExternalId: "cid-1",
      atExternalIds: [],
      contentHash: "h",
      grantId: null,
      usedDryRun: false,
      error: null,
      attemptedAt: NOW,
      source: "agent_auto" as const,
    }
    runs.recordSendAttempt({
      ...base,
      idempotencyKey: "k-sent",
      state: "sent",
      sentMessageExternalId: "msgOK",
      sentAt: NOW,
    })
    /**
     * 失败的那条**没有**平台 id（它没发出去）。把它算进来会让对账
     * 去标一个不存在的 external_id —— 无害但会掩盖"为什么没标上"。
     */
    runs.recordSendAttempt({
      ...base,
      idempotencyKey: "k-failed",
      state: "failed",
      sentMessageExternalId: null,
      sentAt: null,
    })

    expect(runs.agentSentExternalIds(NOW - 1000)).toEqual(["msgOK"])
    // 时间窗之前的不返回（这张表会一直长，对账只覆盖刚采回来的）
    expect(runs.agentSentExternalIds(NOW + 1000)).toEqual([])

    vault.close()
  })
})

/**
 * ★ 「永远不可达的 gate」—— brief 的 scope=draft_only 单独降级
 *
 * ## 为什么这组测试重要
 *
 * `forge.service.ts:427` 硬写 `autonomy.scope = "draft_only"`，所以
 * `persona.py brief` 每次都追加同一句 downgrade。表现是**每一条 run**
 * 的 `risks_json` 都含 `agent_allows_auto` —— 用户明明设了 auto+白名单+
 * 工作时间都对，但 agent 层永不通。这就是"永远不可达的 gate"。
 *
 * `isScopeOnlyDowngrade` 识别"降级理由只有这一条"的情况，让 host 的白名单
 * 授权顶掉这次挡；有别的降级理由时（风险类、band、recipient 未 resolve），
 * forge 挡得对，host 就不越权。
 */
describe("★ isScopeOnlyDowngrade：把「forge 那边 allowlist 没配」这类挡去掉", () => {
  it("brief=null → false（判定不可得，不能当作 scope-only）", () => {
    expect(isScopeOnlyDowngrade(null)).toBe(false)
  })

  it("verdict=reply → false（本来就通了，不用顶掉）", () => {
    expect(isScopeOnlyDowngrade({ verdict: "reply", because: ["all clear"] })).toBe(false)
  })

  it("★ verdict=draft 且 because 只含 scope-only + measured-default → true", () => {
    // "measured default …" 是分类记录（persona.py:200），不是 downgrade 原因
    expect(
      isScopeOnlyDowngrade({
        verdict: "draft",
        because: [
          "measured default for `technical_question` is answer",
          "autonomy scope is draft_only — sending is disabled",
        ],
      }),
    ).toBe(true)
  })

  it("★ 反证：只要含**别的** downgrade 就不能算 scope-only", () => {
    // 风险类是 forge 的独立判定 —— host 侧的白名单授权顶不了它
    expect(
      isScopeOnlyDowngrade({
        verdict: "draft",
        because: [
          "risk class `commitment` — never settled by the owner alone",
          "autonomy scope is draft_only — sending is disabled",
        ],
      }),
    ).toBe(false)
  })

  it("★ 反证：band S 的降级不能被顶掉（那是对接收方的判定）", () => {
    expect(
      isScopeOnlyDowngrade({
        verdict: "draft",
        because: [
          "tone band S — most conservative handling",
          "autonomy scope is draft_only — sending is disabled",
        ],
      }),
    ).toBe(false)
  })

  it("verdict=handoff / silent → false（不是要求人看，而是别的判定）", () => {
    expect(
      isScopeOnlyDowngrade({
        verdict: "handoff",
        because: ["autonomy scope is draft_only — sending is disabled"],
      }),
    ).toBe(false)
    expect(
      isScopeOnlyDowngrade({
        verdict: "silent",
        because: ["pure acknowledgement, not an ask"],
      }),
    ).toBe(false)
  })

  it("空 because → false（这本不该发生，但要 fail closed）", () => {
    // brief 走到 verdict=draft 的路径 `downgrade()` 都会 append 一条，
    // 空 because 意味着我们对不上这个输出的形状 —— 当读不懂而不是当放行。
    expect(isScopeOnlyDowngrade({ verdict: "draft", because: [] })).toBe(false)
  })
})

/**
 * ★★ 触发点过时了 → **改回最新那条**，而不是跳过这一轮。
 *
 * ## 这一组来自一次真机的消息丢失
 *
 * 曾经的"被新消息顶替"过期只作废 `dh_drafts`，而 `takeBatch` 取走那批时
 * `dh_inbox` 已经标成 `done`，`restore()` 又只捞 `pending` 的。于是"草稿被作废"
 * 之后那几条消息**既不在草稿箱、也不在队列里**：真机上留下 4 条等回复的消息，
 * 本人一条没回，系统永远不会再为它们起草。
 *
 * 所以起草前发现过时**不能跳过**（跳过会复现同一个丢失），而是把触发点推进到
 * 最新那条对方消息 —— 一轮就收敛，且新目标之后不可能再有更新的对方消息，
 * 事后清理也不会再作废它。
 */
/** 真 `LlmClient` + 假 fetch（与本文件既有做法一致），并收集请求体。 */
function capturingLlm(bodies: unknown[]): LlmClient {
  return new LlmClient({
    baseUrl: "https://fake.invalid",
    apiKey: "k",
    model: "m",
    sleep: () => Promise.resolve(),
    fetchImpl: (_url, init) => {
      bodies.push(JSON.parse(String((init as RequestInit).body)))
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: JSON.stringify({ reply: "好", holdForReview: false, reviewReason: "" }),
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        text: () => Promise.resolve(""),
      } as unknown as Response)
    },
  })
}

describe("★ 触发点过时时改回最新那条", () => {
  it("★ 起草的是**最新**那条，而不是跳过、也不是回旧的", async () => {
    const vault = seed()
    const bodies: unknown[] = []
    const { service, clock } = makeService(vault, { llm: capturingLlm(bodies) })
    const supervisor = service.inboundSupervisor
    const messages = new MessageRepository(vault.db)
    const conversation = new ConversationRepository(vault.db).findById("conv-1")
    const trigger = messages.findById("m1")
    if (supervisor === null || conversation === null || trigger === null) {
      throw new Error("seed 不完整")
    }

    vault.db.prepare("UPDATE messages SET sent_at = ? WHERE id = 'm1'").run(clock.now())
    supervisor.onInbound({
      message: { ...trigger, sentAt: clock.now() },
      conversation,
      config: new PersonaConfigRepository(vault.db).get("conv-1"),
      mentionsSelf: false,
    })

    // ★ 这一轮跑起来之前，对方又说了一句 —— 那才是该回的
    messages.upsertMany([
      {
        id: "m-newer",
        channelId: "dingtalk",
        conversationId: "conv-1",
        externalId: "ext-m-newer",
        senderExternalId: "other",
        senderDisplayName: "小李",
        contentText: "算了说点别的",
        sentAt: clock.now() + 1_000,
        direction: "inbound",
        isSelf: false,
        createdAt: clock.now() + 1_000,
      },
    ])

    clock.advance(10_000)
    await service.tick()

    // ① 确实起草了（不是跳过 —— 跳过就是那个消息丢失的坑）
    expect(bodies).toHaveLength(1)
    // ② run 记的触发点是**新**那条，否则事后清理会立刻作废这条草稿
    const run = vault.db
      .prepare<
        [],
        { trigger_message_id: string | null }
      >("SELECT trigger_message_id FROM dh_agent_runs ORDER BY created_at DESC LIMIT 1")
      .get()
    expect(run?.trigger_message_id).toBe("m-newer")
    // ③ 草稿回的也是新那条（reply_to 跟着触发点走）
    const draft = vault.db
      .prepare<
        [],
        { reply_to_external_id: string | null; state: string }
      >("SELECT reply_to_external_id, state FROM dh_drafts ORDER BY created_at DESC LIMIT 1")
      .get()
    expect(draft?.reply_to_external_id).toBe("ext-m-newer")
    // ④ 草稿留在箱里等人工（上游已把"被新消息顶替"那条时效过期删掉，
    //    改为每会话数量上限 —— 见 v18 迁移与 `pruneDrafts`）
    expect(draft?.state).toBe("pending")
    vault.close()
  })

  it("★ 反面：只有**本人**说了新话 → 触发点不动（那是另一条规则管的）", async () => {
    const vault = seed()
    const bodies: unknown[] = []
    const { service, clock } = makeService(vault, { llm: capturingLlm(bodies) })
    const supervisor = service.inboundSupervisor
    const messages = new MessageRepository(vault.db)
    const conversation = new ConversationRepository(vault.db).findById("conv-1")
    const trigger = messages.findById("m1")
    if (supervisor === null || conversation === null || trigger === null) {
      throw new Error("seed 不完整")
    }

    vault.db.prepare("UPDATE messages SET sent_at = ? WHERE id = 'm1'").run(clock.now())
    supervisor.onInbound({
      message: { ...trigger, sentAt: clock.now() },
      conversation,
      config: new PersonaConfigRepository(vault.db).get("conv-1"),
      mentionsSelf: false,
    })

    /**
     * 本人自己发的新消息（`is_self = 1`）**不该**改变触发点：它的语义是
     * "本人已经自己回了"，由 `expireAnsweredDrafts` 覆盖。混进同一个判据会让
     * 两条规则互相掩盖，而"哪条规则生效了"决定了给用户看什么原因。
     */
    messages.upsertMany([
      {
        id: "m-self-newer",
        channelId: "dingtalk",
        conversationId: "conv-1",
        externalId: "ext-m-self-newer",
        senderExternalId: "self",
        senderDisplayName: "我",
        contentText: "我自己回了",
        sentAt: clock.now() + 1_000,
        direction: "outbound",
        isSelf: true,
        createdAt: clock.now() + 1_000,
      },
    ])

    clock.advance(10_000)
    await service.tick()

    const run = vault.db
      .prepare<
        [],
        { trigger_message_id: string | null }
      >("SELECT trigger_message_id FROM dh_agent_runs ORDER BY created_at DESC LIMIT 1")
      .get()
    expect(run?.trigger_message_id).toBe("m1")
    vault.close()
  })
})

/**
 * ★★ 「正在生成」的在途登记必须**一定**被清掉。
 *
 * ## 为什么这条比"能不能显示"更重要
 *
 * 界面上那个标记的语义是"数字人现在正在处理这几条"。它挂住不消失时
 * 用户看到的是**永久转圈** —— 而那比不显示更糟：不显示他会去点"立即处理"，
 * 永久转圈他会一直等。
 *
 * `runBatch` 有好几条早退路径（判定层 silent、生成抛异常、db 为 null）。
 * 所以登记必须在 `finally` 里删 —— 只在末尾删的话任何一条早退
 * 都会让那个会话永远显示"生成中"。
 *
 * 这一组不验"显示成什么样"（那在渲染层测试里），只验**状态机干净**。
 */
describe("★★ 生成中状态：跑完必须清掉（否则界面永久转圈）", () => {
  it("★ 一轮跑完后 snapshot.generating 是空的", async () => {
    const vault = seed()
    const { service, clock } = makeService(vault, { llm: recordingLlm(["收到"]) })
    await runOneTurn(service, vault, clock)
    // 跑完了 —— 不能还留着在途登记
    expect(service.snapshot().generating).toEqual([])
    await service.detach()
    vault.close()
  })

  it("★★ 生成抛异常时也要清掉（早退路径最容易漏）", async () => {
    const vault = seed()
    /**
     * 让 LLM 抛错 —— `runBatch` 会在 catch 里记 error 并继续落库 run，
     * 但无论走哪条路，在途登记都必须消失。
     */
    const failing = {
      completeWithTools: () => Promise.reject(new Error("网关挂了")),
      complete: () => Promise.reject(new Error("网关挂了")),
    } as unknown as LlmClient
    const { service, clock } = makeService(vault, { llm: failing })
    await runOneTurn(service, vault, clock)
    expect(service.snapshot().generating).toEqual([])
    await service.detach()
    vault.close()
  })

  it("★ 未 attach 时是空数组，不是 undefined（渲染层直接 .find）", () => {
    const vault = openTestVault()
    const { service } = makeService(vault)
    void service.detach()
    // 降级分支也要给出这个字段 —— 缺了它渲染层 `.find` 会崩
    expect(makeService(vault).service.snapshot().generating).toEqual([])
    vault.close()
  })
})
