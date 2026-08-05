/**
 * 真 opencode 进程的 ACP 握手与多 session 端到端。
 *
 * ## 为什么这条必须打真进程
 *
 * 我们的 `AcpClient` 单测用的是内存 transport —— 它验证的是**我们的**
 * 编解码，而不是「opencode 真的接受这个形状的 `session/new`」。
 * 实测差异都在这一层：字段名、`cwd` 是否必需、resume 的返回形状。
 * mock 永远不会告诉我们这些。
 *
 * ## 不进门禁
 *
 * `describe.skipIf(!hasOpencode)`：同事机器上没装 opencode 时跳过，
 * 否则门禁会随机变红，而随机变红的门禁最终等于没有门禁。
 * `pnpm test:externals` 会**显式打印**跳过了什么。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  AcpClient,
  AcpSupervisor,
  McpAuth,
  buildOpencodeSpawn,
  mapSessionUpdate,
  resolveGatewayModelConfig,
} from "@mycontext/agent-runtime"
import type { AgentEvent } from "@mycontext/agent-runtime"
import { AGENT_ENTRY_FILENAME } from "@mycontext/distill"
import { ManualClock, createLogger } from "@mycontext/kernel"
import { ProcessRunner } from "@mycontext/runtime-env"
import { resolveOpencode } from "../helpers/opencode.js"

const opencode = resolveOpencode()
const hasOpencode = opencode !== null

const logger = createLogger("acp-e2e", { level: "warn" })
const dirs: string[] = []
const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

/** 起一个真 opencode ACP 进程，返回接好的 client。 */
async function startAcp(
  options: {
    entryFile?: string
    agentsMd?: string
    allowKlCommand?: boolean
    extraPath?: string
    /** 隔离 HOME（验证用户全局 skill 不泄漏进 agent 视野）。 */
    agentHome?: string
    /** 覆盖 baseEnv 的若干键（造假的用户 HOME 用）。 */
    baseEnvOverride?: Record<string, string>
  } = {},
) {
  if (opencode === null) throw new Error("unreachable: skipIf 已挡住")
  const cwd = mkdtempSync(join(tmpdir(), "mycontext-acp-"))
  dirs.push(cwd)
  // opencode 只认 AGENTS.md（复数）—— 见 packages/distill/src/materializer/render.ts。
  // entryFile 可覆盖成单数，用来证明"写错文件名不报错、只是不加载"。
  writeFileSync(
    join(cwd, options.entryFile ?? AGENT_ENTRY_FILENAME),
    options.agentsMd ?? "# 测试工作区\n\n仅用于 ACP 握手验证。\n",
    "utf8",
  )

  // 加固后的 args/env：随机 server password、显式 127.0.0.1、白名单式权限。
  // ★ 注入网关模型配置（走 openai-compatible 内联 provider，绕开被墙的
  // models.dev 注册表）——否则"需真模型"的用例即便有 key 也会 0-token 静默失败。
  const modelConfig = resolveGatewayModelConfig(process.env)
  const baseEnv = {
    ...process.env,
    ...(options.extraPath === undefined
      ? {}
      : { PATH: `${options.extraPath}:${process.env["PATH"] ?? ""}` }),
    ...(options.baseEnvOverride ?? {}),
  }
  const spawnOpts = {
    baseEnv,
    ...(modelConfig !== null ? { modelConfig } : {}),
    ...(options.allowKlCommand === true ? { allowKlCommand: true } : {}),
    ...(options.agentHome === undefined ? {} : { agentHome: options.agentHome }),
  }
  const hardened = buildOpencodeSpawn(spawnOpts)
  const lines: string[] = []
  // transport 的 onLine 必须能看见 client，而 client 又要先有 transport ——
  // 用一个 holder 打破这个环，而不是 `let client!:`（那会被 prefer-const 抓）。
  const holder: { client?: AcpClient } = {}

  const transport = new ProcessRunner(logger).spawnDuplex({
    executable: opencode.path,
    // hardened.args 已经是 ["acp", "--hostname", "127.0.0.1"] —— 不要再追加 "acp"
    args: hardened.args,
    env: hardened.env,
    cwd,
    onLine: (line: string) => {
      lines.push(line)
      holder.client?.handleLine(line)
    },
    onStderr: (line: string) => logger.debug("opencode stderr", { line }),
  })
  const notifications: { method: string; params: unknown }[] = []
  const client = new AcpClient({
    transport,
    logger,
    onNotification: (method, params) => notifications.push({ method, params }),
    // 反向请求必须应答：不实现的话实测所有工具调用被静默拒绝
    reverseHandlers: {
      "session/request_permission": () => ({ outcome: { outcome: "selected", optionId: "allow" } }),
      "fs/read_text_file": () => ({ content: "" }),
      "fs/write_text_file": () => null,
    },
    requestTimeoutMs: 60_000,
  })
  holder.client = client
  closers.push(async () => {
    client.close()
    await transport.close()
  })
  return { client, cwd, transport, lines, notifications }
}

describe.skipIf(!hasOpencode)("★ ACP 真进程端到端", () => {
  it("initialize 握手成功并返回协议版本", async () => {
    const { client } = await startAcp()
    const result = await client.request<{ protocolVersion: unknown }>("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })
    expect(result.protocolVersion).toBeDefined()
  }, 90_000)

  /**
   * ★ 用户明确问过的点：「单独启动 opencode acp 一个就够支持多 session 了吧」。
   * 这条测试就是那个问题的答案 —— 一个进程、两个 session、id 不同。
   */
  it("一个进程支持多 session（两个 id 互不相同）", async () => {
    const { client, cwd } = await startAcp()
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })

    const first = await client.request<{ sessionId: string }>("session/new", {
      cwd,
      mcpServers: [],
    })
    const second = await client.request<{ sessionId: string }>("session/new", {
      cwd,
      mcpServers: [],
    })

    expect(first.sessionId).toBeTruthy()
    expect(second.sessionId).toBeTruthy()
    expect(first.sessionId).not.toBe(second.sessionId)
  }, 90_000)

  /**
   * Supervisor 的降级路径：resume 一个**不存在**的 sessionId 必须落到
   * `session/new` 而不是抛错。这是「重进 session」在真实世界里最常见的形态
   * （对端重启过、session 被清理过）。
   */
  it("resume 不存在的 session → 降级重建并标记待回灌", async () => {
    const { client, cwd } = await startAcp()
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })

    const changed: { id: string; acp: string }[] = []
    const supervisor = new AcpSupervisor({
      client,
      mcpAuth: new McpAuth({ clock: new ManualClock(1_785_000_000_000) }),
      mcpPort: 47_999,
      logger,
      onSessionIdChanged: (id, acp) => changed.push({ id, acp }),
      beginReplaySuppression: () => () => {},
    })

    const result = await supervisor.ensureSession({
      id: "sess-1",
      acpSessionId: "definitely-not-a-real-session-id",
      cwd,
      kind: "search",
      scopeId: "sess-1",
    })

    expect(result.rebuilt).toBe(true)
    expect(result.acpSessionId).not.toBe("definitely-not-a-real-session-id")
    expect(changed).toEqual([{ id: "sess-1", acp: result.acpSessionId }])
    // 降级重建后必须回灌历史，否则用户看到的是「它忘了刚才说的话」
    expect(supervisor.needsContextReplay(result.acpSessionId)).toBe(true)
  }, 90_000)
})

/**
 * 把「`type` 只能是 http」这个结论**钉在真进程上**。
 *
 * 单测里断言的是我们发出的字符串是 `"http"`，那只能防我们自己改回去；
 * 防不了 opencode 升级后又改回收 `"remote"`（或者只收别的值）。
 * 这条测试直接问对端 —— 它是那条注释的证据本身。
 */
describe.skipIf(!hasOpencode)("★ MCP server 形态（真进程校验）", () => {
  async function trySessionNew(server: Record<string, unknown>) {
    const { client, cwd } = await startAcp()
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })
    try {
      const result = await client.request<{ sessionId: string }>("session/new", {
        cwd,
        mcpServers: [server],
      })
      return { ok: true as const, sessionId: result.sessionId }
    } catch (error) {
      return { ok: false as const, message: error instanceof Error ? error.message : String(error) }
    }
  }

  const base = {
    name: "mycontext",
    url: "http://127.0.0.1:47999/mcp",
    headers: [{ name: "Authorization", value: "Bearer probe" }],
  }

  it('type:"http" 被接受', async () => {
    const result = await trySessionNew({ ...base, type: "http" })
    expect(result.ok).toBe(true)
  }, 90_000)

  it('type:"remote" 被拒（这就是读源码会读错的那个值）', async () => {
    const result = await trySessionNew({ ...base, type: "remote" })
    expect(result.ok).toBe(false)
  }, 90_000)

  it("省略 type 也被拒（不会有默认值兜着）", async () => {
    const result = await trySessionNew({ ...base })
    expect(result.ok).toBe(false)
  }, 90_000)
})

/**
 * ★ 画像包**真的被加载** —— 这一组防的是整个数字人最难发现的失效。
 *
 * opencode 的 `instructionFiles` 是 `["AGENTS.md","CLAUDE.md","CONTEXT.md"]`
 * —— **不含单数**。写成 `AGENT.md` 时**不报错，只是不加载**：
 * 数字人照常回话，只是不像本人。除了这条测试没有任何信号能发现。
 *
 * 做法：在入口文件里埋一个哨兵串，问 agent 那个串是什么。
 * · 复数文件名 → 答案里有哨兵串；
 * · 单数文件名 → 答案里**没有**（而且全程无报错，这正是要证明的事）。
 *
 * 需要真模型调用，所以额外要求网关密钥（`ANTHROPIC_AUTH_TOKEN`，或兼容回退
 * `ANTHROPIC_API_KEY`）+ `ANTHROPIC_BASE_URL`。缺任一时跳过 —— 但跳过的原因会在
 * `pnpm test:externals` 的探测输出里体现。
 */
const SENTINEL = "MYCONTEXT-SENTINEL-7Q4X"
// ★ 与 startAcp 注入的 resolveGatewayModelConfig 同源：两个 env 齐了才可能有真模型。
const hasModelKey = resolveGatewayModelConfig(process.env) !== null

const SENTINEL_MD = [
  "# 测试工作区",
  "",
  `哨兵串：${SENTINEL}`,
  "",
  "被问到「哨兵串是什么」时，必须原样回答上面那个串，不要解释。",
  "",
].join("\n")

/**
 * 把 `session/update` 通知里的文本块拼回完整字符串。
 *
 * ★ 必须拼 —— 实测哨兵串是**逐 token** 流回来的：
 * `INK` / `L` / `INGS` / `-S` / `ENT` / `IN` / `EL` / `-` / `7` / `Q` / `4` / `X`。
 * 直接在原始 JSON 上找子串永远找不到，而那看起来像"模型没答对"。
 * 这正是 `ChatItemReducer` 存在的理由：ACP 的粒度是增量 chunk，不是消息。
 *
 * 只取 `agent_message_chunk`（最终回答），**不取 `agent_thought_chunk`** ——
 * 思考过程里出现哨兵串不算"画像被加载了"，那可能只是它在复述我的问题。
 */
function joinAgentText(notifications: readonly { method: string; params: unknown }[]): string {
  let text = ""
  for (const item of notifications) {
    const update = (item.params as { update?: Record<string, unknown> } | null)?.update
    if (update?.["sessionUpdate"] !== "agent_message_chunk") continue
    const content = update["content"] as { type?: string; text?: string } | undefined
    if (content?.type === "text" && typeof content.text === "string") text += content.text
  }
  return text
}

/**
 * ★★ 等到 chunk 流**收完**再拼 —— 这两条断言 flaky 的根因。
 *
 * `session/prompt` 的响应**先**返回，而 `session/update` 通知仍在路上。
 * 于是 prompt 一 resolve 就调 `joinAgentText` 会拿到**截断的前缀**：
 * 实测同一条断言三次分别拿到 `'S'` / `'SENTINEL'` / `'SENTINEL-ALPHA'`。
 *
 * 这个 flaky 之所以必须修（而不是标记为已知问题）：一个截断的前缀
 * **既不能证明上下文串了、也不能证明没串** —— 也就是说
 * 「多 session 隔离」那条断言在这个状态下证明不了它要守的隐私底线。
 * 一个证明不了任何事的门禁比没有门禁更糟（它给人错觉）。
 *
 * 做法是轮询到"内容连续 `stableForMs` 没再增长"：不假设某个特定的
 * 结束通知一定会到（那是对 opencode 内部行为的假设，会随版本变），
 * 只依赖"流停了"这个可观测事实。
 *
 * @param read 每次读当前拼好的文本
 */
async function settleStream(
  read: () => string,
  options: { stableForMs?: number; timeoutMs?: number } = {},
): Promise<string> {
  const stableFor = options.stableForMs ?? 1_500
  const timeout = options.timeoutMs ?? 60_000
  const startedAt = Date.now()
  let last = read()
  let lastChangedAt = Date.now()

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const current = read()
    if (current !== last) {
      last = current
      lastChangedAt = Date.now()
    } else if (current !== "" && Date.now() - lastChangedAt >= stableFor) {
      // 有内容且已经稳定 → 收完了
      return current
    }
    if (Date.now() - startedAt > timeout) {
      // 超时也把已有内容返回：让断言报「拿到了什么」而不是「超时了」——
      // 前者能直接看出是"模型没答对"还是"一条都没回来"。
      return current
    }
  }
}

/** 发一轮 prompt，返回拼好的最终回答（等流收完）。 */
async function promptOnce(entryFile: string): Promise<string> {
  const { client, cwd, notifications } = await startAcp({ entryFile, agentsMd: SENTINEL_MD })
  await client.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  })
  const session = await client.request<{ sessionId: string }>("session/new", {
    cwd,
    mcpServers: [],
  })
  await client.request("session/prompt", {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "哨兵串是什么？只回答那个串本身。" }],
  })
  // 文本走 session/update 通知，不在 prompt 的响应里 ——
  // 且通知在 prompt 响应之后还会继续到，所以必须等它稳定（见 settleStream）。
  return settleStream(() => joinAgentText(notifications))
}

describe.skipIf(!hasOpencode || !hasModelKey)("★ 画像包加载（需真模型）", () => {
  it("AGENTS.md（复数）→ 哨兵串出现在回答里", async () => {
    expect(await promptOnce(AGENT_ENTRY_FILENAME)).toContain(SENTINEL)
  }, 180_000)

  /**
   * 反面：单数文件名不被加载，**且不报错**。
   *
   * 这条断言的是"没有哨兵串"—— 一个反面断言，本身比较弱。
   * 它的价值在于与上一条**成对**：两条一起才说明「文件名是那个差别」，
   * 而不是「模型今天不听话」。
   */
  it("AGENT.md（单数）→ 哨兵串不出现，且全程无报错", async () => {
    const output = await promptOnce("AGENT.md")
    expect(output).not.toContain(SENTINEL)
  }, 180_000)
})

/**
 * ★ 注入 deny-all 后 `webfetch` 确实**不可用**。
 *
 * 这是 PLAN 测试 16③：验证 `Permission.merge` 的 `flat()+findLast` 顺序依赖。
 * opencode 升级把 `findLast` 改成 `find`、或把 user ruleset 挪到前面，
 * 我们不会收到任何报错 —— 只会在某天发现 agent 能 webfetch 了。
 *
 * 断言方式：让它去 fetch 一个**本机上不存在的端口**。
 * · 权限生效 → 工具压根没被调用（输出里不该出现 webfetch 的成功结果）；
 * · 权限失效 → 它会真去连，然后报连接错误。
 * 两者的区别是「有没有出现 webfetch 这个工具调用」，不是「有没有网络错误」。
 */
describe.skipIf(!hasOpencode || !hasModelKey)("★ deny-all 生效（需真模型）", () => {
  it("webfetch 不被允许调用", async () => {
    const { client, cwd, notifications } = await startAcp()
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })
    const session = await client.request<{ sessionId: string }>("session/new", {
      cwd,
      mcpServers: [],
    })
    await client.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [
        {
          type: "text",
          text: "用 webfetch 工具抓取 http://127.0.0.1:1/nope 并告诉我内容。",
        },
      ],
    })

    const output = JSON.stringify(notifications)
    // 工具调用的通知里会带工具名。deny 生效时不该有一条成功的 webfetch。
    const calledWebfetch = /"(?:toolName|name|tool)"\s*:\s*"webfetch"/.test(output)
    expect(calledWebfetch).toBe(false)
  }, 180_000)
})

/**
 * ★ M5：精确放行 `kl` 命令生效，且**没有**顺带放开 bash（需真模型）。
 *
 * 这是 M5 安全形状的真进程证据（单测只证明我们发出的 JSON 形状）：
 * 注入 `KL_SKILL_PERMISSION`（`bash:{"*":"deny","kl":"allow","kl *":"allow"}`）后，
 *
 *  · agent 跑 `kl …` → 真的执行（工具结果里出现我们埋的哨兵）；
 *  · agent 跑非 kl 的 bash（`cat`）→ **不执行**（哨兵不出现）。
 *
 * 用一个 PATH 前插的**假 kl**（打印哨兵）验证，不依赖真 kl-server ——
 * 这条测的是"权限放行哪条命令"，与 kl 本身是否就绪无关。
 *
 * 哨兵走**工具结果**（tool_call_update 的 content）判定，不看 agent 的自述文本 ——
 * 实测模型会在没真跑命令时"脑补"一段像样的输出，只有工具结果不可伪造。
 */
const KL_SENTINEL = "KL-PERM-OK-7X2"
function toolResultsText(notifications: readonly { method: string; params: unknown }[]): string {
  let text = ""
  for (const item of notifications) {
    if (item.method !== "session/update") continue
    const update = (item.params as { update?: Record<string, unknown> } | null)?.update
    if (update?.["sessionUpdate"] !== "tool_call_update") continue
    const content = update["content"]
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const inner = (block as { content?: { text?: string } })?.content
      if (typeof inner?.text === "string") text += inner.text
    }
  }
  return text
}

describe.skipIf(!hasOpencode || !hasModelKey)("★ M5 精确放行 kl 命令（需真模型）", () => {
  /** 铺一个 PATH 前插的假 kl（打印哨兵）+ 一个 kl 查询 skill。 */
  function makeFakeKl(): { binDir: string } {
    const binDir = mkdtempSync(join(tmpdir(), "mycontext-klbin-"))
    dirs.push(binDir)
    writeFileSync(join(binDir, "kl"), `#!/bin/bash\necho "${KL_SENTINEL} args=$*"\n`, {
      encoding: "utf8",
      mode: 0o755,
    })
    return { binDir }
  }

  it("agent 能跑 kl（哨兵出现在工具结果里）", async () => {
    const { binDir } = makeFakeKl()
    const skill =
      "---\nname: kl\ndescription: Query workplace chat history.\n---\n" +
      '# kl\nRun the `kl` CLI via bash, e.g. `kl ask "<q>"`, then report its raw output.\n'
    const { client, cwd, notifications } = await startAcp({
      allowKlCommand: true,
      extraPath: binDir,
    })
    // 把 kl skill 铺进工作区（opencode 自动发现 <cwd>/.opencode/skills/<name>/）。
    mkdirSync(join(cwd, ".opencode/skills/kl"), { recursive: true })
    writeFileSync(join(cwd, ".opencode/skills/kl/SKILL.md"), skill, "utf8")

    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })
    const session = await client.request<{ sessionId: string }>("session/new", {
      cwd,
      mcpServers: [],
    })
    await client.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "用 kl skill 跑 `kl ask 谁部署了沙箱` 并原样报告它的输出。" }],
    })
    await settleStream(() => toolResultsText(notifications))
    expect(toolResultsText(notifications)).toContain(KL_SENTINEL)
  }, 180_000)

  it("非 kl 的 bash（cat）不被允许（哨兵不出现）", async () => {
    const { binDir } = makeFakeKl()
    const { client, cwd, notifications } = await startAcp({
      allowKlCommand: true,
      extraPath: binDir,
    })
    // 把哨兵藏进一个文件，诱导它 cat；权限生效时 cat 跑不起来 → 哨兵不出现。
    writeFileSync(join(cwd, "secret.txt"), `${KL_SENTINEL}\n`, "utf8")
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })
    const session = await client.request<{ sessionId: string }>("session/new", {
      cwd,
      mcpServers: [],
    })
    await client.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "用 bash 工具跑 `cat secret.txt` 并原样报告输出。" }],
    })
    await settleStream(() => toolResultsText(notifications), { timeoutMs: 20_000 })
    // cat 被 deny → 工具结果里不该出现文件内容（哨兵）。
    expect(toolResultsText(notifications)).not.toContain(KL_SENTINEL)
  }, 180_000)
})

/**
 * ★ 两个 session 交替对话，上下文**不串**。
 *
 * 这是"一个进程承载多 session"的**正确性**部分 —— 前面那条只证明了
 * 两个 id 不同，而 id 不同但共享上下文的话，隔离是假的。
 *
 * 做法：给两个 session 各埋一个不同的哨兵，交替提问，
 * 断言各自只答出自己那个。串了的话 A 会答出 B 的串。
 *
 * 为什么这条重要：数字人是**每会话一个 session**。上下文串了意味着
 * 群聊里的内容会漏进单聊的回答里 —— 那是隐私事故，不是功能 bug。
 */
describe.skipIf(!hasOpencode || !hasModelKey)("★ 多 session 隔离（需真模型）", () => {
  it("两个 session 交替提问，各自只知道自己的哨兵", async () => {
    const { client, notifications } = await startAcp()
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })

    /** 给一个 session 一个独立 workspace + 独立哨兵。 */
    const makeSession = async (tag: string) => {
      const cwd = mkdtempSync(join(tmpdir(), `mycontext-iso-${tag}-`))
      dirs.push(cwd)
      writeFileSync(
        join(cwd, AGENT_ENTRY_FILENAME),
        `# 工作区 ${tag}\n\n哨兵串：SENTINEL-${tag}\n\n被问到哨兵串时原样回答，不解释。\n`,
        "utf8",
      )
      const created = await client.request<{ sessionId: string }>("session/new", {
        cwd,
        mcpServers: [],
      })
      return created.sessionId
    }

    const alpha = await makeSession("ALPHA")
    const beta = await makeSession("BETA")

    const ask = async (sessionId: string) => {
      const before = notifications.length
      await client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "哨兵串是什么？只回答那个串本身。" }],
      })
      // ★ 等这一轮的 chunk 流收完 —— 直接读会拿到截断的前缀
      // （实测拿到过 'S' / 'SENTINEL'），而截断的前缀既不能证明
      // 上下文串了也不能证明没串，这条隔离断言就白做了。
      return settleStream(() => joinAgentText(notifications.slice(before)))
    }

    // 交替：A → B → A。第三轮尤其关键 —— 若上下文共享，A 这时已被 B 污染。
    const first = await ask(alpha)
    const second = await ask(beta)
    const third = await ask(alpha)

    expect(first).toContain("SENTINEL-ALPHA")
    expect(first).not.toContain("SENTINEL-BETA")
    expect(second).toContain("SENTINEL-BETA")
    expect(second).not.toContain("SENTINEL-ALPHA")
    expect(third).toContain("SENTINEL-ALPHA")
    expect(third).not.toContain("SENTINEL-BETA")
  }, 300_000)
})

/**
 * ★ 杀进程后重启：会话**真的能续上**。
 *
 * ## 一个被实测纠正的假设
 *
 * 我原本以为「进程被杀 → 旧 sessionId 失效 → 走降级重建」，写了那样一条断言，
 * 它**红了**：`rebuilt` 是 false，因为 resume **成功**了。
 *
 * 原因：opencode 的 session 落在磁盘上
 * （`~/.local/share/opencode/storage/session/` + `opencode.db`），
 * 不在进程内存里。所以进程死了 session 还在。
 *
 * 这是比我假设的**更好**的结果，但把它记下来才有价值 —— 否则下一个人
 * 也会以为"进程重启要重建"，然后为一个不存在的问题写一堆恢复逻辑。
 *
 * ## 降级重建的真实触发条件
 *
 * 不是进程重启，而是**磁盘上那个 session 真的没了**：用户清了缓存、
 * 换了机器、opencode 升级改了存储格式、或 session 被它自己的保留策略清掉。
 * 那条路径由上面「resume 不存在的 session」覆盖。
 *
 * 所以这条测试断言的是"续上了"（rebuilt=false + 不需要回灌），
 * 而 `acp_session_id` 可为空的设计仍然必要 —— 它覆盖的是磁盘态丢失的情况。
 */
describe.skipIf(!hasOpencode)("★ 杀进程后续会话", () => {
  it("硬杀进程后，新进程仍能 resume 同一个 session（session 在磁盘上）", async () => {
    // 第一个进程：建一个真 session
    const first = await startAcp()
    await first.client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })
    const created = await first.client.request<{ sessionId: string }>("session/new", {
      cwd: first.cwd,
      mcpServers: [],
    })
    // 硬杀：不走 session/close，模拟崩溃而不是优雅退出
    process.kill(first.transport.pid ?? 0, "SIGKILL")
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(first.transport.alive).toBe(false)

    // 第二个进程：拿旧 id 走 Supervisor
    const second = await startAcp()
    await second.client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })
    let suppressions = 0
    const supervisor = new AcpSupervisor({
      client: second.client,
      mcpAuth: new McpAuth({ clock: new ManualClock(1_785_000_000_000) }),
      mcpPort: 47_999,
      logger,
      onSessionIdChanged: () => {},
      beginReplaySuppression: () => {
        suppressions += 1
        return () => {}
      },
    })

    const result = await supervisor.ensureSession({
      id: "sess-restart",
      acpSessionId: created.sessionId,
      // ★ cwd 必须是原来那个：resume 按 (directory, sessionID) 定位
      cwd: first.cwd,
      kind: "search",
      scopeId: "sess-restart",
    })

    // 续上了 —— 不需要重建，也不需要回灌历史
    expect(result.rebuilt).toBe(false)
    expect(result.acpSessionId).toBe(created.sessionId)
    expect(supervisor.needsContextReplay(result.acpSessionId)).toBe(false)
    // 但仍然进过抑制窗口：「resume 不 replay」是号称，不是契约
    expect(suppressions).toBe(1)
  }, 120_000)
})

/**
 * ★ M1.10 —— mapper 的**真进程**断言（补 §11.1 的真空）。
 *
 * 单测（session-update-mapper.test.ts）用手写 fixture 验的是「我们的翻译逻辑」；
 * 但 fixture 的字段名/嵌套形状是**我读 opencode 源码抄来的**，源码读错、或
 * opencode 升级改了线上形状，单测照样绿 —— 那正是「模型不说话」的静默失败。
 * 这一组把真 opencode 进程吐出的 `session/update` **原样喂进 mapper**，断言：
 *
 *  1. 至少收到过 `agent_message_chunk`，且 mapper 把它翻成非空 `text_delta`
 *     （证明 content.text 口径没漂）；
 *  2. 收到的**每一条** update 过 mapper 都不抛、且产出的 AgentEvent 结构合法
 *     （turnId 贯穿、tool_result 只在终态出、citation 有 label…）——
 *     即便这次没触发 tool/plan，也证明未知/被忽略子类型不会把流打断。
 *
 * 需要真模型（否则一条 chunk 都不会来），所以 `skipIf(!hasModelKey)`。
 * 缺 key 时在 `pnpm test:externals` 的探测输出里显式体现，不静默跳。
 */
describe.skipIf(!hasOpencode || !hasModelKey)("★ M1.10 mapper 真进程口径", () => {
  it("真 opencode 的 session/update 逐条过 mapper：结构合法且 message→text_delta", async () => {
    const { client, cwd, notifications } = await startAcp()
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })
    const session = await client.request<{ sessionId: string }>("session/new", {
      cwd,
      mcpServers: [],
    })
    await client.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "用一句话回答：1+1 等于几？" }],
    })
    // 通知在 prompt 响应之后仍在路上 —— 等流稳定（见 settleStream 头注释）
    await settleStream(() => joinAgentText(notifications))

    const TURN = "turn_real_1"
    const allEvents: AgentEvent[] = []
    for (const { method, params } of notifications) {
      if (method !== "session/update") continue
      // ★ 核心断言之一：真形状喂进来，mapper 不抛
      const events = mapSessionUpdate(params, TURN)
      allEvents.push(...events)
    }

    // 结构合法性：turnId 贯穿；mapper 永不产 turn_end；tool_result 只有终态
    for (const ev of allEvents) {
      expect(ev.turnId).toBe(TURN)
      expect(ev.type).not.toBe("turn_end")
      if (ev.type === "tool_result") expect(["success", "error"]).toContain(ev.status)
      if (ev.type === "citation") expect(typeof ev.label).toBe("string")
    }

    // message chunk 口径没漂：至少一条非空 text_delta
    const textDeltas = allEvents.filter((e) => e.type === "text_delta")
    expect(textDeltas.length).toBeGreaterThan(0)
    expect(textDeltas.every((e) => e.type === "text_delta" && e.text.length > 0)).toBe(true)
  }, 180_000)
})

/**
 * ★ `session/cancel` 真的让 opencode 停下（停止按钮的对端契约）。
 *
 * 为什么必须打真进程：这条断言的对象**不是我们的代码**，而是「opencode 收到
 * `session/cancel` 会中止当轮」这个外部行为。mock 里我们自己扮演对端，
 * 想让它停就停 —— 证明不了任何事。
 *
 * 起因是个真 bug：`SearchService.cancel()` 原来只让 reducer 丢事件、
 * 不给 opencode 发通知，于是"停止"只停了 UI，模型继续烧 token。
 * 修的时候先用探针量过（对照组不取消 9.4s / 102 update / 2817 token；
 * 取消组在取消那刻 resolve、之后 0 条 update、0 token），这条把那个结论固化下来。
 *
 * 断言选的是**相对量**（取消组的 update 数明显少于对照组）而不是绝对时长/条数：
 * 后者跟模型速度与网关负载绑定，会变成随机红灯，而随机红灯等于没有门禁。
 */
describe.skipIf(!hasOpencode || !hasModelKey)("★ session/cancel 中止当轮（需真模型）", () => {
  const COUNT_PROMPT = "从 1 数到 400，每个数字单独一行，中间不要停。"

  it("取消后 prompt 立即 settle，且不再有新 update 涌入", async () => {
    const { client, cwd, notifications } = await startAcp()
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })
    const session = await client.request<{ sessionId: string }>("session/new", {
      cwd,
      mcpServers: [],
    })

    const promptSettled = client
      .request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: COUNT_PROMPT }],
      })
      .then(
        () => "resolved" as const,
        () => "rejected" as const,
      )

    // 等它真的开始流（否则取消发在开工之前，测不到中止）
    await new Promise((resolve) => setTimeout(resolve, 6_000))
    expect(notifications.length).toBeGreaterThan(0)

    await client.notify("session/cancel", { sessionId: session.sessionId })

    // 取消后 prompt 应当很快 settle（不是等它把 400 个数字数完）
    const outcome = await Promise.race([
      promptSettled,
      new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), 20_000)),
    ])
    expect(outcome).not.toBe("still-pending")

    // 停下来之后不该再有新内容涌进来。留 3s 观察窗；
    // 允许 ±1 条（取消瞬间已在管道里的那条属于正常）。
    const atCancel = notifications.length
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    expect(notifications.length - atCancel).toBeLessThanOrEqual(1)
  }, 200_000)
})

/**
 * ★★ 隔离漏洞门禁：搜索 agent 只该看得到我们指定的 skill 目录。
 *
 * 真机发现的问题：env 原来把整个 `process.env` 原样拷进子进程，`HOME` 因此被
 * 继承 —— 而 opencode 从 `$HOME/.claude/skills` 发现 skill。于是用户自己装的
 * 全部 skill（实测 8 个：docx / pdf / pptx / xlsx / frontend-design /
 * skill-creator / web-artifacts-builder，以及一个名叫 `test-leak-skill` 的
 * **探针**）都出现在搜索 agent 的可见列表里。那个探针的 SKILL.md 原文：
 *
 * > If a chat agent sees this skill, isolation is broken and the user's
 * > `~/.claude/skills/` is leaking into the sandboxed session.
 *
 * ## ★ 现在有**两道**独立的闸，一起守这件事
 *
 * ① `agentHome` → `HOME` 换成我们的空目录。opencode 的 global 侧扫的是
 *    `os.homedir()/.claude/skills`，而 `os.homedir()` 尊重 `HOME`。
 * ② `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`（无条件注）。这一条**必须有**：
 *    opencode 除了 global 侧还会**沿文件系统父目录 findUp** 扫
 *    `.claude/skills` 与 `.agents/skills`（`packages/opencode/src/skill/index.ts:196-202`）。
 *    workspace 在 `<userData>/agents/persona/<id>`，向上到 `/` 会经过
 *    `/Users/<user>/` —— 那里的 `~/.claude/skills` / `~/.agents/skills` 正好命中
 *    （本机实测 `~/.agents/skills/find-skills` 存在）。换 `HOME` **不改变
 *    文件系统**，只有 ① 挡不住这条。
 *
 * ★ 因为 ② 是无条件的，"不隔离时会泄漏"这条反证在真进程上**已经不可复现**
 * （那正是我们要的结果）。它的语义搬到了单测
 * `tests/unit/agent-runtime/spawn-hardening.test.ts` 的「屏蔽用户本地 opencode
 * 配置与外部 skill」那一组 —— 那里断言 env 真的被注入、且用户显式 `=0`
 * 也覆盖不掉。这里只保留真进程能验的那半：**隔离后确实看不见**。
 */
describe.skipIf(!hasOpencode)("★ skill 隔离（真进程）", () => {
  /** 造一个假的"用户 HOME"，里面塞一个只有它才有的 skill。 */
  function plantUserSkill(name: string): string {
    const home = mkdtempSync(join(tmpdir(), "mycontext-fakehome-"))
    dirs.push(home)
    const dir = join(home, ".claude", "skills", name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: leak probe fixture\n---\n\nbody\n`,
      "utf8",
    )
    return home
  }

  /** 起 session 并收集 opencode 播的可见命令/skill 名单。 */
  async function visibleCommands(options: { userHome: string; agentHome?: string }) {
    const ctx = await startAcp({
      baseEnvOverride: { HOME: options.userHome },
      ...(options.agentHome === undefined ? {} : { agentHome: options.agentHome }),
    })
    await ctx.client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })
    await ctx.client.request("session/new", { cwd: ctx.cwd, mcpServers: [] })
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const names = new Set<string>()
    for (const n of ctx.notifications) {
      const update = (
        n.params as { update?: { sessionUpdate?: string; availableCommands?: unknown } }
      ).update
      if (update?.sessionUpdate !== "available_commands_update") continue
      for (const cmd of (update.availableCommands ?? []) as { name?: string }[]) {
        if (typeof cmd.name === "string") names.add(cmd.name)
      }
    }
    return names
  }

  it("★ 不给 agentHome 也看不见用户 skill（第二道闸：DISABLE_EXTERNAL_SKILLS）", async () => {
    /**
     * ★ 这条曾经断言"会泄漏"（用来证明门禁在测东西）。
     *
     * 现在 `buildOpencodeSpawn` 无条件注 `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`，
     * 所以**即使不给 agentHome** 也不泄漏 —— 那正是想要的结果，于是原来那条
     * 反证在真进程上不可复现了。语义搬到 spawn-hardening 单测（断言 env 真被
     * 注入、且用户显式 `=0` 覆盖不掉）。
     *
     * 这里改成锁**新的**性质：两道闸各自独立有效 —— 少了 agentHome 这一道，
     * 另一道仍然挡得住。回退（有人删掉那行 env 注入）时这条会红。
     */
    const userHome = plantUserSkill("mycontext-leak-probe")
    const names = await visibleCommands({ userHome })
    expect(names.has("mycontext-leak-probe")).toBe(false)
  }, 120_000)

  it("★ 给了 agentHome 后用户 skill 不可见", async () => {
    const userHome = plantUserSkill("mycontext-leak-probe")
    const agentHome = mkdtempSync(join(tmpdir(), "mycontext-agenthome-"))
    dirs.push(agentHome)
    const names = await visibleCommands({ userHome, agentHome })
    expect(names.has("mycontext-leak-probe")).toBe(false)
  }, 120_000)
})

/**
 * ★ 只配 `MYCONTEXT_LLM_*` 也能出答案（不必为搜索再配一遍 `ANTHROPIC_*`）。
 *
 * 为什么必须打真进程：这条断言的对象是「opencode 拿到我们转名后的内联
 * provider 之后**真的会说话**」。mock 里我们自己扮演对端，证明不了它。
 *
 * 起因是一次真实事故：`.env.example` 里只有 `MYCONTEXT_LLM_*`，同事照着配完
 * 搜索 100% 不可用 —— 解析只认 `ANTHROPIC_*`，拿不到就退回 opencode 默认
 * provider 去查被墙的 models.dev，表现是 `session/prompt` 永不返回、
 * 满 120 秒超时，日志里看不出是缺密钥。修法是在解析里回退到
 * `MYCONTEXT_LLM_*`（同一个网关，见 resolveGatewayModelConfig）。
 *
 * 这条用例把 `ANTHROPIC_*` 从 env 里**全部剔掉**，复刻那台机器的环境。
 */
describe("★ 只配 MYCONTEXT_LLM_* 的网关回退（需真模型）", () => {
  /** 剔掉全部 ANTHROPIC_*，只留 MYCONTEXT_LLM_*。 */
  function llmOnlyEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("ANTHROPIC_")) continue
      env[key] = value
    }
    // 本机若只在 shell 里导出了 ANTHROPIC_*，借它的值填进 MYCONTEXT_LLM_*——
    // 我们要验的是**转名逻辑**，不是本机恰好怎么配的。
    env["MYCONTEXT_LLM_BASE_URL"] ??= process.env["ANTHROPIC_BASE_URL"]
    env["MYCONTEXT_LLM_API_KEY"] ??= process.env["ANTHROPIC_AUTH_TOKEN"]
    return env
  }

  const llmEnv = llmOnlyEnv()
  const llmOnlyReady = hasOpencode && resolveGatewayModelConfig(llmEnv) !== null

  it.skipIf(!llmOnlyReady)(
    "agent 真的出答案（不是 0-token 静默失败）",
    async () => {
      if (opencode === null) throw new Error("unreachable: skipIf 已挡住")
      // 前置：env 里确实没有 ANTHROPIC_*（否则这条测试是假的）
      expect(Object.keys(llmEnv).some((k) => k.startsWith("ANTHROPIC_"))).toBe(false)

      const cwd = mkdtempSync(join(tmpdir(), "mycontext-llmenv-"))
      dirs.push(cwd)
      writeFileSync(join(cwd, AGENT_ENTRY_FILENAME), "# 网关回退验证\n", "utf8")

      const modelConfig = resolveGatewayModelConfig(llmEnv)
      const hardened = buildOpencodeSpawn({
        baseEnv: llmEnv,
        ...(modelConfig !== null ? { modelConfig } : {}),
      })
      const holder: { client?: AcpClient } = {}
      const transport = new ProcessRunner(logger).spawnDuplex({
        executable: opencode.path,
        args: hardened.args,
        env: hardened.env,
        cwd,
        onLine: (line: string) => holder.client?.handleLine(line),
        onStderr: (line: string) => logger.debug("opencode stderr", { line }),
      })
      const notifications: { method: string; params: unknown }[] = []
      const client = new AcpClient({
        transport,
        logger,
        onNotification: (method, params) => notifications.push({ method, params }),
        reverseHandlers: {
          "session/request_permission": () => ({
            outcome: { outcome: "selected", optionId: "allow" },
          }),
          "fs/read_text_file": () => ({ content: "" }),
          "fs/write_text_file": () => null,
        },
        requestTimeoutMs: 90_000,
      })
      holder.client = client
      closers.push(async () => {
        client.close()
        await transport.close()
      })

      await client.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      })
      const session = await client.request<{ sessionId: string }>("session/new", {
        cwd,
        mcpServers: [],
      })
      const result = await client.request<{ stopReason: string; usage?: { totalTokens?: number } }>(
        "session/prompt",
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "只回答一个数字：3+4 等于几？" }],
        },
      )

      // ★ 核心：真的烧了 token（0-token 就是那个静默失效模式）
      expect(result.usage?.totalTokens ?? 0).toBeGreaterThan(0)
      expect(await settleStream(() => joinAgentText(notifications))).toContain("7")
    },
    200_000,
  )
})
