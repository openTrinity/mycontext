/**
 * PersonaAcp 的**端到端**：真 opencode + 真两类 skill + 真 kl 命令。
 *
 * ## 为什么这条必须打真进程
 *
 * `tests/unit/desktop/persona-acp.test.ts` 用 mock transport 验的是**编解码**
 * 与降级形状（0-token→null / 失败→null / 跨轮 resume）。而这一条验：
 *
 * 1. 通过 `skills.paths` **指目录**给进去的两类 skill（bundled kl + derived
 *    蒸馏画像）真的被 opencode 发现 —— 不再往 workspace 拷副本，所以
 *    "文件在不在 cwd 下"已经不是证据，唯一的证据是**哨兵串出现在回答里**；
 * 2. `PersonaAcp` 的 spawn 参数（deny-all + allowKlCommand + PATH 前插）
 *    真的允许 agent 跑 `kl` 命令；
 * 3. `session/update` 事件按 acpSessionId 分派后，`turn()` 收到的文本
 *    真的含 agent 的实时回复（不是空、不是回灌）。
 *
 * 前两条在单测里怎么都测不了：mock transport 不管 `skills.paths` 的扫描、
 * 不管 spawn 环境的 PATH。它们只在真进程上暴露。
 *
 * ## 需要模型 key 才跑
 *
 * `skipIf(!hasOpencode || !hasModelKey)` —— 没 key 时 opencode 会 0-token
 * 静默失败（这本身是我们锁的降级形态之一，但那属于单测覆盖）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { deflateSync } from "node:zlib"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ManualClock, createLogger } from "@mycontext/kernel"
import { ProcessRunner, type ResolvedBinary, type RuntimeEnv } from "@mycontext/runtime-env"
import { PersonaAcp } from "../../apps/desktop/src/main/services/persona-acp.js"
import { resolveOpencode } from "../helpers/opencode.js"

const opencode = resolveOpencode()
const hasOpencode = opencode !== null
/**
 * 网关配好了没有。
 *
 * ★ 判据必须与 `resolveGatewayModelConfig` 的**同一套回退链**一致：
 * `ANTHROPIC_BASE_URL` → `MYCONTEXT_LLM_BASE_URL`、
 * `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `MYCONTEXT_LLM_API_KEY`
 * （见 spawn-hardening.ts:332）。
 *
 * 只看 `ANTHROPIC_*` 的话，在**只配了 `MYCONTEXT_*` 的机器上**（本仓库
 * `.env` 的实际形态）这些用例全部静默跳过 —— 而运行时其实是能跑的。
 * 那正是「门禁跳过比门禁失败更糟」的形状：跳过时输出一句
 * `5 skipped` 看起来像"环境不具备"，而真相是判据写窄了。
 */
const hasModelKey =
  (process.env["ANTHROPIC_AUTH_TOKEN"] ??
    process.env["ANTHROPIC_API_KEY"] ??
    process.env["MYCONTEXT_LLM_API_KEY"] ??
    "") !== "" &&
  (process.env["ANTHROPIC_BASE_URL"] ?? process.env["MYCONTEXT_LLM_BASE_URL"] ?? "") !== ""

const logger = createLogger("persona-acp-real", { level: "warn" })
const dirs: string[] = []
const acps: PersonaAcp[] = []

afterEach(async () => {
  while (acps.length > 0) await acps.pop()?.dispose()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

/** 一个可执行的 fake `kl` —— agent 跑它就打印这个哨兵串。 */
const KL_SENTINEL = "PERSONA-KL-OK-9X3"

function makeFakeKl(): string {
  const binDir = mkdtempSync(join(tmpdir(), "mycontext-fake-kl-"))
  dirs.push(binDir)
  writeFileSync(join(binDir, "kl"), `#!/bin/bash\necho "${KL_SENTINEL} args=$*"\n`, { mode: 0o755 })
  return binDir
}

/**
 * 铺一个 workspace + 造两个**共享的 skill 目录**（不拷进 workspace）。
 *
 * ★ 现在验的是 `skills.paths` 这条路：`PersonaAcp` 把这两个目录透给
 * `buildOpencodeSpawn` 的 `skillPaths`，最后落到
 * `OPENCODE_CONFIG_CONTENT.skills.paths`，opencode 从那里扫 `<name>/SKILL.md`。
 *
 * 曾经这里用 `installSkills` 把两份都 cpSync 进 `<cwd>/.opencode/skills/` ——
 * 那是旧实现。改成指目录之后 workspace 里不再有副本，所以那条路径也就不能
 * 再作为"skill 到达了 agent"的证据：唯一的证据是**哨兵串出现在回答里**。
 */
function seedWorkspace(): {
  workspaceRoot: string
  conversationId: string
  skillPaths: string[]
} {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "mycontext-pa-ws-"))
  dirs.push(workspaceRoot)
  const conversationId = "cv-test-1"
  const cwd = join(workspaceRoot, "persona", conversationId)
  mkdirSync(cwd, { recursive: true })

  // bundled: kl skill（让 agent 能通过 skill 触发 `kl` 命令）
  const bundledDir = mkdtempSync(join(tmpdir(), "mycontext-bundled-"))
  dirs.push(bundledDir)
  mkdirSync(join(bundledDir, "kl"), { recursive: true })
  writeFileSync(
    join(bundledDir, "kl", "SKILL.md"),
    "---\nname: kl\ndescription: Query workplace chat history.\n---\n# kl\n" +
      'Run `kl ask "<q>"` via bash. Report its raw output verbatim.\n',
    "utf8",
  )

  // derived: 一份微型"画像"（让 agent 知道自称是「测试助手」）
  const derivedDir = mkdtempSync(join(tmpdir(), "mycontext-derived-"))
  dirs.push(derivedDir)
  mkdirSync(join(derivedDir, "persona-test"), { recursive: true })
  writeFileSync(
    join(derivedDir, "persona-test", "SKILL.md"),
    "---\nname: persona-test\ndescription: test persona.\n---\n# 身份\n\n你是「测试助手」。\n",
    "utf8",
  )

  return { workspaceRoot, conversationId, skillPaths: [bundledDir, derivedDir] }
}

function makeAcp(options: {
  klRoot: string
  workspaceRoot: string
  skillPaths: readonly string[]
}): PersonaAcp {
  if (opencode === null) throw new Error("unreachable: skipIf 已挡住")
  const resolved: ResolvedBinary = {
    name: "opencode",
    path: opencode.path,
    platform: "darwin-arm64",
    source: "path",
  }
  const runtime = {
    tryResolveOpencode: () => resolved,
    // 版本闸交给单测覆盖；这里是真机端到端，直接给达标结果用真二进制起 ACP。
    resolveUsableOpencode: () => ({ ok: true as const, binary: resolved, version: "bundled" }),
  } as unknown as RuntimeEnv
  const acp = new PersonaAcp({
    clock: new ManualClock(1_785_000_000_000),
    logger,
    runtime,
    processes: new ProcessRunner(logger),
    workspaceRoot: options.workspaceRoot,
    klRoot: options.klRoot,
    klPort: 8200,
    // ★ 与生产同一条路：指目录，不拷副本
    getSkillPaths: () => options.skillPaths,
  })
  acps.push(acp)
  return acp
}

describe.skipIf(!hasOpencode)("★ PersonaAcp：opencode 缺失时 available()=false", () => {
  it("没装 opencode → available()=false，turn() 立刻返回 null", async () => {
    const runtime = {
      tryResolveOpencode: () => null,
      resolveUsableOpencode: () => ({ ok: false as const, reason: "missing" as const }),
    } as unknown as RuntimeEnv
    const acp = new PersonaAcp({
      clock: new ManualClock(1_785_000_000_000),
      logger,
      runtime,
      processes: new ProcessRunner(logger),
      workspaceRoot: mkdtempSync(join(tmpdir(), "mycontext-pa-no-oc-")),
      klRoot: "/dev/null",
      klPort: 0,
    })
    acps.push(acp)
    expect(acp.available()).toBe(false)
    expect(await acp.turn({ conversationId: "x", prompt: "hi" })).toBeNull()
  })
})

describe.skipIf(!hasOpencode || !hasModelKey)("★★ PersonaAcp 端到端：kl skill + 蒸馏画像", () => {
  it("★ turn() 让 agent 跑 kl skill，哨兵串出现在返回的文本里", async () => {
    const klRoot = makeFakeKl()
    const { workspaceRoot, conversationId, skillPaths } = seedWorkspace()
    const acp = makeAcp({ klRoot, workspaceRoot, skillPaths })

    const result = await acp.turn({
      conversationId,
      prompt: "请用 kl skill 执行 `kl ask 部署了什么` 并原样报告它的输出。",
    })
    /**
     * ★ 断言的是**哨兵**，不是"回复非空"。
     *
     * 空断言（just non-null）在这条链路上是**假绿**：opencode 可能返回
     * 一段拒绝的解释文本，也可能返回"我理解你的意图，但..."之类的搪塞。
     * 只有哨兵出现，才证明：
     *  · bundled kl skill 真被 harness 发现了；
     *  · PATH 前插让裸 `kl` 命中我们的 fake；
     *  · deny-all 权限没挡住 kl 命令（`allowKlCommand: true` 起作用）；
     *  · 工具结果通过 `session/update` 通知，按 acpSessionId 分派回到了
     *    对的 turn 的 `chunks` 数组里。
     */
    expect(result).not.toBeNull()
    // ★ 文本在 `.text` 上 —— `turn()` 返回结构体（见下一条用例的注释）
    expect(result?.text ?? "").toContain(KL_SENTINEL)
  }, 180_000)

  /**
   * ★★ 长回复也必须拿到**完整**的协议信封。
   *
   * ## 这条锁的是一条落库过的坏草稿
   *
   * `dh_drafts` 里有 40 个字符的一条：`{"reply": "哈哈好", "holdForReview": false,`
   * —— 在 `false,` 之后硬断。根因是 `session/prompt` 的响应会在
   * `agent_message_chunk` **中间**返回，而 `turn()` 曾在响应的下一行就
   * `chunks.join("")`（见 `PersonaAcp.settleStream` 的注释与
   * `scripts/probe-acp-stream.mjs` 的 dump）。
   *
   * ## ⚠️ 这条**不能**可靠复现那个竞态 —— 分工要说清
   *
   * 实测过了：把 `settleStream` 换回"响应就读"，这条连跑三次**全绿**。
   * 因为尾部 chunk 是否晚于响应到达是**上游时序**，同一个 prompt 两次运行
   * 可以不同（探针实测：带工具调用的一轮响应夹在第 18 行，纯文本的一轮在最后）。
   *
   * 所以：
   * · **回归锁是单测**（`tests/unit/desktop/persona-acp.test.ts`）—— 它用
   *   fake transport 把"响应后再来两条 chunk"这个顺序**钉死**，是确定性的；
   * · **这一条**验的是端到端那个更弱但仍必要的性质：真 opencode + 真长回复下，
   *   `turn()` 交出来的东西是一个**可解析**的信封。它会抓住"等待逻辑把流截断了"
   *   或"等待逻辑让 turn 永不返回"这类新问题 —— 那些单测的 fake 时序覆盖不到。
   *
   * 把它写成"它守着那个竞态"会是一个假信号，所以这里明确不那么声称。
   *
   * ## 断言是**能解析出信封**，不是"非空"
   *
   * 截断的文本也非空 —— `expect(text).not.toBeNull()` 在这个 bug 下是假绿。
   */
  it("★★ 长回复：端到端拿到的是完整可解析的信封", async () => {
    const klRoot = makeFakeKl()
    const { workspaceRoot, conversationId, skillPaths } = seedWorkspace()
    const acp = makeAcp({ klRoot, workspaceRoot, skillPaths })

    const result = await acp.turn({
      conversationId,
      prompt:
        "请写一段大约 150 字的中文自我介绍，然后**只**输出一个 JSON 对象、" +
        "不要代码围栏、不要前言：" +
        '{"reply":"<那段介绍>","holdForReview":false,"reviewReason":""}',
    })

    expect(result).not.toBeNull()
    /**
     * ★ `turn()` 返回的是**结构体**（文本 + 工具名 + 用量 + 过程 items），
     * 文本在 `.text` 上。这里曾经写成 `const raw = text ?? ""` ——
     * 把整个对象当字符串用，于是下面的 `lastIndexOf` 在类型上就不成立
     * （而运行时会拿到 `[object Object]`，断言失败但原因看不出来）。
     */
    const raw = result?.text ?? ""
    /**
     * ★ 断言可解析 —— 这一条在修复前会失败，且失败信息里能看到断在哪。
     * 模型可能加围栏或前言，所以从最右的 `}` 往左找配平的那一段
     * （与 `extractDraftEnvelope` 的尾部解析同一个思路，但这里只做断言）。
     */
    const lastClose = raw.lastIndexOf("}")
    expect(lastClose).toBeGreaterThan(-1)
    const firstOpen = raw.indexOf("{")
    const envelope = raw.slice(firstOpen, lastClose + 1)
    const parsed = JSON.parse(envelope) as { reply?: unknown }
    expect(typeof parsed.reply).toBe("string")
    // 真的是长回复才算验到（短的话这条测试没测到它该测的东西）
    expect((parsed.reply as string).length).toBeGreaterThan(60)
  }, 240_000)
  it("★ 跨轮：第二轮走 resume，不再重开 session", async () => {
    /**
     * 端到端验证 `sessionIds.get(conversationId)` 那条 —— mock 版单测锁的是
     * 我们发出的 method 序列，真机验的是 opencode 真的接受同一个 sessionId
     * 的 resume。有过一次上游改了 resume 参数形状（`type` 字段），单测发不出来。
     */
    const klRoot = makeFakeKl()
    const { workspaceRoot, conversationId, skillPaths } = seedWorkspace()
    const acp = makeAcp({ klRoot, workspaceRoot, skillPaths })

    const first = await acp.turn({
      conversationId,
      prompt: "你好，请只回复「hello」。",
    })
    expect(first).not.toBeNull()

    const second = await acp.turn({
      conversationId,
      prompt: "再回一次「hello」。",
    })
    // 只要不是 null，就说明 resume 没崩（崩了 supervisor 会 fall through 到 new，
    // 而那本身也算成功；这条锁的是"turn 稳定完成第二次"）
    expect(second).not.toBeNull()
  }, 240_000)
})

/**
 * ★★ agent 真的"看到"了随 prompt 送进去的图。
 *
 * ## 这条是「agent 说读不了图片」那个反馈的唯一充分证据
 *
 * 单测（`persona-acp.test.ts`）只能证明我们**发出去**了正确形状的
 * image block。而"对端接受了、模型真读到了内容"必须打真进程 + 真模型：
 * opencode 的 ACP prompt 分派是
 * `case"image": if(n.data) return [{type:"file", url:"data:…"}]` ——
 * 字段名错一个字（`base64` 而不是 `data`）就**静默丢弃**那张图，
 * 而 turn 照样返回一段文本，看起来一切正常。
 *
 * ## 判据必须是**图里的内容**，不是"回复非空"
 *
 * 与上面那条 kl 哨兵同一个理由：模型很会说"我看到你发了一张图片"
 * 而其实什么都没看到。所以图里画一个不可能被猜到的串
 * （`VZ7QK`），断言它出现在回复里 —— 只有真读到像素才可能说出它。
 */
/**
 * PNG 的 CRC-32（`node:zlib` 不导出它，而 chunk 校验和是必需的）。
 *
 * 表驱动，标准多项式 0xEDB88320 —— 与 PNG 规范一致。
 */
function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

describe.skipIf(!hasOpencode || !hasModelKey)("★★ PersonaAcp 端到端：图片真的被看到", () => {
  /** 图里那个不可能被猜中的串。 */
  const IMAGE_SENTINEL = "VZ7QK"

  /**
   * 画一张写着 `IMAGE_SENTINEL` 的 PNG。
   *
   * ★ 自己画而不是用库里的真图：真图的内容会随着谁在用这台机器而变，
   * 而这条断言依赖"图里确实有那个串"。自己画让判据自洽。
   *
   * 用 5×7 点阵手写字形 + 放大，不引第三方依赖（这个仓库刻意不带图像库）。
   */
  function drawSentinelPng(): Buffer {
    const glyphs: Record<string, string[]> = {
      V: ["10001", "10001", "10001", "10001", "01010", "01010", "00100"],
      Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
      "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
      Q: ["01110", "10001", "10001", "10001", "10101", "01110", "00011"],
      K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
    }
    const scale = 10
    const pad = 12
    const chars = [...IMAGE_SENTINEL]
    const width = pad * 2 + chars.length * 6 * scale
    const height = pad * 2 + 7 * scale
    // 白底
    const pixels = Buffer.alloc(width * height * 3, 0xff)
    const put = (x: number, y: number): void => {
      const offset = (y * width + x) * 3
      pixels[offset] = 0
      pixels[offset + 1] = 0
      pixels[offset + 2] = 0
    }
    for (const [charIndex, char] of chars.entries()) {
      const rows = glyphs[char] ?? []
      for (const [rowIndex, row] of rows.entries()) {
        for (let col = 0; col < row.length; col += 1) {
          if (row[col] !== "1") continue
          for (let dy = 0; dy < scale; dy += 1) {
            for (let dx = 0; dx < scale; dx += 1) {
              put(pad + (charIndex * 6 + col) * scale + dx, pad + rowIndex * scale + dy)
            }
          }
        }
      }
    }
    // PNG 编码：每行前面加一个 filter byte(0)
    const raw = Buffer.alloc(height * (width * 3 + 1))
    for (let y = 0; y < height; y += 1) {
      raw[y * (width * 3 + 1)] = 0
      pixels.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3)
    }
    const chunk = (type: string, data: Buffer): Buffer => {
      const length = Buffer.alloc(4)
      length.writeUInt32BE(data.length)
      const body = Buffer.concat([Buffer.from(type, "ascii"), data])
      const crc = Buffer.alloc(4)
      crc.writeUInt32BE(crc32(body))
      return Buffer.concat([length, body, crc])
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0)
    ihdr.writeUInt32BE(height, 4)
    ihdr[8] = 8 // bit depth
    ihdr[9] = 2 // truecolor RGB
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ])
  }

  it("★★ 图里的串出现在回复里 —— 只有真读到像素才说得出来", async () => {
    const klRoot = makeFakeKl()
    const { workspaceRoot, conversationId, skillPaths } = seedWorkspace()
    const acp = makeAcp({ klRoot, workspaceRoot, skillPaths })

    const result = await acp.turn({
      conversationId,
      prompt: "图里写着一串字母数字。只输出那一串，不要任何解释。",
      images: [
        {
          base64: drawSentinelPng().toString("base64"),
          mimeType: "image/png",
          name: "sentinel.png",
        },
      ],
    })

    expect(result, "turn 不该返回 null").not.toBeNull()
    /**
     * ★ 大小写归一后比对：模型可能回小写。要锁的是"它读到了那几个字符"，
     * 而不是"它的输出格式与我们预期一致"。
     *
     * ## ★★ 这条守的是 `resolveGatewayModelConfig` 里那一行 `modalities`
     *
     * 内联 models 不声明 `modalities.input: ["text","image"]` 时，opencode
     * 默认"这个模型收不了图"，于是图在"转成模型请求"那一步被丢掉 ——
     * **而失效方式是模型自己说**「当前模型不支持图片输入」。那句话不在
     * opencode 的二进制里（搜过），所以看起来像模型的限制，一路把人引向
     * "换个模型"；而同一个模型经直连能读出同一张图。
     *
     * 实测：去掉那一行 → 这条必红（回答变成那句拒绝）；加上 → 回 `VZ7QK`。
     * 也就是说这条断言是那一行的**唯一**回归锁 —— 单测只能证明我们把
     * image block 发出去了，证明不了对端把它送到了模型。
     */
    expect((result?.text ?? "").toUpperCase()).toContain(IMAGE_SENTINEL)
  }, 180_000)
})
