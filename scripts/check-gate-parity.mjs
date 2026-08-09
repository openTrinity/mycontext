/**
 * 门禁：**用真实的 forge 产物输出**验 TS 侧的解析与判定。
 *
 * ## ★ 为什么这条门禁必须存在（它挡的正是这次改动的核心风险）
 *
 * 这次架构调整把「该不该自己回」的判定从 forge 的 `verdict` 换成了
 * host 侧的 `evaluateGate`（见 `docs/persona-architecture.md` 第 5 节）。
 * 那意味着两件事必须成立：
 *
 * ① TS 侧解析 `brief` / `check` / `rules.json` 的**字段名与形状**是对的；
 * ② 搬过来的 12 条降级与 Python 侧给出**相同**的 verdict。
 *
 * 单测锁不住这两条 —— 它用的是我们自己编的 payload，而这类 bug 的成因
 * **恰恰**是"编的形状与真实返回不一样"。已经踩到两次：
 *
 * · `context.degraded` 实际是**字符串**（`"no live read available"`），
 *   写成 `=== true` 会把"这不是当前的上下文"读成"是当前的"；
 * · `brief` 的 payload 里**没有** `policy` / `bands` / `coverage` ——
 *   它们在 `rules.json` 里。从 payload 读会拿到空表，于是一切只出草稿
 *   （方向安全，但测出来的 `byAskKind` 永远用不上，且外观正常）。
 *
 * 两条都不报错，都要靠真跑一次才看得见。
 *
 * ## 怎么跑
 *
 * 用 `vendor/forge` 里的模板脚本 + 一个**全假数据**的临时 corpus
 * （`/tmp` 下，用完删）。不碰本机 vault、不需要蒸馏过、不联网。
 * 缺 Python 时**跳过而非失败**（同事/CI 上可能没有）。
 *
 * ```bash
 * node scripts/check-gate-parity.mjs
 * ```
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")

function python() {
  for (const candidate of ["python3", "/usr/bin/python3"]) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "pipe" })
      return candidate
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

const py = python()
if (py === null) {
  console.log("⚠︎ 没有 python3 —— 跳过（这条门禁需要真跑 forge 产物）")
  process.exit(0)
}

/**
 * 假的规则文件。
 *
 * 形状照 `compose.render_rules` 的输出，**值全部编造**
 * （CLAUDE.md §1.2：结构照抄，值全换）。
 */
const RULES = {
  rulesVersion: "signals-v5",
  localeId: "zh-CN",
  idLabel: "user id",
  patterns: {
    genuineAsk: "(吗|呢|怎么|什么|要不要)",
    chitchatReply: "^(好|收到|谢谢|嗯)",
    askKinds: {
      decision_request: "(你觉得|要不要|你定)",
      status_chase: "(进展|好了吗|什么时候)",
    },
    riskTags: { commitment: "(承诺|保证|一定)", money: "(报价|预算|多少钱)" },
    replyShapes: { settle: "(就这样|定了)", handoff: "(找|问)" },
    botNames: "",
  },
  escapeHatches: { handoff: [], defer: [], decline: [], clarify: ["是哪个"] },
  policy: {
    /**
     * ★ `decision_request` 记 `draft_gated`，**不是** `answer`。
     *
     * 真实的 `forge publish` 永远不会为它发 `answer`：`decide.py:372` 已经把
     * `alwaysDraftKinds` 折进了 `byAskKind`。原来这里 seed 成 `answer` 是在
     * 造一个上游不会出现的形态 —— 那会**掩盖**"host 与产物名单不一致"这类分歧
     * （review 指出的）。照真实形态 seed，parity 才验得到真东西。
     */
    byAskKind: { decision_request: "draft_gated", status_chase: "answer", other_ask: "answer" },
    defaultAction: "draft",
    alwaysDraftKinds: ["decision_request"],
    neverSettleRiskClasses: ["commitment", "money"],
    thinAskKinds: [],
    burst: { gapSeconds: 300, maxMessages: 12 },
    freshness: { maxLagSeconds: 150, unknownLagIsStale: true },
  },
  style: {
    medianCodepoints: 6,
    p90Codepoints: 24,
    maxCodepoints: 300,
    joinedClausePct: 10,
    neverWrite: [],
    manufacturedOpeners: "",
    hedgeMarkers: "",
  },
  bands: { A: { autoAnswer: "low-risk allowed" }, S: { autoAnswer: "manual only" } },
  autonomy: { scope: "draft_only" },
  coverage: { askKinds: true, riskTags: true, replyShapes: true },
}

const work = mkdtempSync(join(tmpdir(), "mycontext-gate-parity-"))
let failures = 0
const note = (ok, label, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail === "" ? "" : ` — ${detail}`}`)
  if (!ok) failures += 1
}

try {
  // ── 布置一个最小的已发布 skill ────────────────────────────────────
  const skillDir = join(work, "persona-persona")
  mkdirSync(join(skillDir, "scripts"), { recursive: true })
  mkdirSync(join(skillDir, "references"), { recursive: true })
  const templates = join(root, "vendor/forge/templates/persona/scripts/persona.py")
  writeFileSync(join(skillDir, "scripts", "persona.py"), readFileSync(templates))
  writeFileSync(
    join(skillDir, "scripts", "imruntime.py"),
    readFileSync(join(root, "vendor/forge/forge/runtime.py")),
  )
  writeFileSync(join(skillDir, "references", "rules.json"), `${JSON.stringify(RULES, null, 2)}\n`)

  const dataRoot = join(work, "data")
  mkdirSync(join(dataRoot, "database"), { recursive: true })
  const config = {
    profileSlug: "parity",
    displayName: "张三",
    dataRoot,
    autonomy: { scope: "draft_only", allowlist: [], maxCodepoints: 300 },
    source: {
      kind: "vault",
      options: { path: join(dataRoot, "core.sqlite"), channel_id: "dingtalk" },
    },
    database: { path: join(dataRoot, "database", "parity.db") },
    timezoneOffset: "+08:00",
  }
  writeFileSync(join(dataRoot, "config.json"), JSON.stringify(config))
  writeFileSync(join(skillDir, "references", ".config-path"), join(dataRoot, "config.json"))

  /**
   * 建两个库：host store（vault 形状）与 corpus（forge 形状）。
   * 全部是编造的 id 与人名 —— `cidFAKE…` / `DFAKE…` / `A同学`。
   */
  const seed = `
import sqlite3, sys, time
sys.path.insert(0, ${JSON.stringify(join(root, "vendor/forge"))})
from forge import store as S

now = int(time.time() * 1000)
h = sqlite3.connect(${JSON.stringify(join(dataRoot, "core.sqlite"))})
h.executescript("""
CREATE TABLE messages(id TEXT PRIMARY KEY, channel_id TEXT, conversation_id TEXT,
 sender_external_id TEXT, sender_display_name TEXT, content_text TEXT, sent_at INTEGER,
 is_self INTEGER, origin TEXT, external_id TEXT, quoted_external_id TEXT);
CREATE TABLE conversations(id TEXT PRIMARY KEY, channel_id TEXT, external_id TEXT, type TEXT, title TEXT);
CREATE TABLE sync_cursors(scope TEXT PRIMARY KEY, watermark INTEGER);
""")
h.execute("INSERT INTO conversations VALUES('c1','dingtalk','cidFAKE0001==','direct','A同学')")
h.executemany("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?)", [
 ("m1","dingtalk","c1","DFAKE0001","A同学","这个要不要今天定下来",now-60000,0,"human","msgFAKE0001",None),
 ("m2","dingtalk","c1",None,"张三","我看下",now-30000,1,"human","msgFAKE0002",None),
 ("m3","dingtalk","c1","DFAKE0001","A同学","进展怎么样了",now-5000,0,"human","msgFAKE0003",None),
])
h.execute("INSERT INTO sync_cursors VALUES('dingtalk:chat:l2',?)", (now-2000,))
h.commit()

c = sqlite3.connect(${JSON.stringify(join(dataRoot, "database", "parity.db"))})
for block in [v for v in vars(S).values() if isinstance(v, str) and "CREATE TABLE" in v]:
    c.executescript(block)
c.execute("INSERT OR REPLACE INTO meta VALUES('selfOpenIds','DSELF0001')")
c.execute("INSERT OR REPLACE INTO people(person_id,name,nick) VALUES('DFAKE0001','A同学','')")
c.commit()
print("seeded")
`
  /**
   * ★ `PYTHONDONTWRITEBYTECODE` —— 不留 `__pycache__`。
   *
   * 这个脚本 `sys.path.insert` 了 `vendor/forge` 去拿 corpus 的 DDL，
   * 而 CPython 默认会在**被 import 的包旁边**写 `.pyc`。于是
   * `vendor/forge/forge/__pycache__` 出现在工作区里 ——
   * `check:vendor-clean` 会拦它（那条门禁的意义是"vendor 必须逐文件白名单"）。
   *
   * 实测踩到过：第一次跑完这个门禁，`check:vendor-clean` 就红了。
   */
  execFileSync(py, ["-c", seed], {
    stdio: "pipe",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  })

  const run = (args) => {
    const out = execFileSync(py, [join(skillDir, "scripts", "persona.py"), ...args], {
      stdio: "pipe",
      encoding: "utf8",
      // 同上：产物脚本会 import 它旁边的 imruntime，别留 .pyc
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    })
    return JSON.parse(out)
  }

  // ── ① 形状：TS 侧读的每个字段都真的在那里 ──────────────────────────
  const brief = run([
    "brief",
    "--conversation-id",
    "c1",
    "--single",
    "true",
    "--peer-open-id",
    "DFAKE0001",
    "--message-id",
    "m3",
  ])

  note("classification" in brief, "brief 带 classification（TS 侧的 askKind / riskTags 来源）")
  note("recipient" in brief, "brief 带 recipient（toneBand / sensitive / resolved）")
  note("clarifyOption" in brief, "brief 带 clarifyOption（本人问澄清的原话）")
  note("context" in brief, "brief 带 context（这一轮上下文有多新）")

  /**
   * ★ 这两条是**反向**断言：证明 `policy` / `coverage` **不在** brief 里。
   *
   * 我最初就是从 payload 读它们的，拿到空表 → 一切只出草稿。
   * 断言"它不在"能让上游哪天真的把它加进 payload 时这条门禁变红 ——
   * 那时我们应当**改回**从 payload 读（更同源），而不是继续读文件。
   */
  note(!("policy" in brief), "★ policy 不在 brief 里（所以 advice 必须读 rules.json）")
  note(!("coverage" in brief), "★ coverage 不在 brief 里（所以也必须读 rules.json）")

  const cls = brief.classification ?? {}
  note(
    typeof cls.riskDetectable === "boolean" && typeof cls.askKindDetectable === "boolean",
    "★ 能力元数据是布尔（缺失时 TS 侧必须 fail closed 成 false）",
  )

  /**
   * ★★ `degraded` 的类型。这是踩到过的那条。
   */
  const degraded = brief.context?.degraded
  note(
    degraded === undefined || typeof degraded === "string" || typeof degraded === "boolean",
    `context.degraded 的实际类型是 ${typeof degraded}`,
    typeof degraded === "string"
      ? "字符串 —— TS 侧不能写 === true（会把「不是当前的」读成「是当前的」）"
      : "",
  )

  // ── ② check 的字段名（曾经读错成 verdict/issues，导致每条都进待审）──
  const check = run(["check", "--text", "我保证明天一定好"])
  note(
    check.result === "block",
    "check 用 `result` 而不是 `verdict`",
    `实际 result=${check.result}`,
  )
  note(
    Array.isArray(check.problems) && typeof check.problems[0]?.kind === "string",
    "check 的 problems 是 {severity,kind,detail} 对象数组",
  )
  note(
    check.problems.some((p) => p.kind === "risk_in_draft"),
    "★ 命中风险类时 kind=risk_in_draft（guard 按这个字段判，不匹配英文句子）",
  )
  note(typeof check.codepoints === "number", "check 报 codepoints（guard 拿它比硬上限）")

  // ── ③ 判定 parity：同一批输入，Python 与 TS 的 verdict 必须一致 ────
  /**
   * ★ 只比 `verdict`，不比 `because` 的措辞。
   *
   * 措辞我们刻意保留了 Python 的原文（那是给用户看的话），但**不断言逐字
   * 相同** —— 上游改一句文案不该让门禁变红。真正要锁的是"拦不拦"。
   *
   * ★★ 一处**已知且刻意**的不一致：`autonomy.scope = draft_only` 那条降级
   * TS 侧不存在（授权由 host 的 replyMode 唯一表达，见架构文档 5.1）。
   * 所以比对时把 Python 的那一条排除掉 —— 排除方式是**只在 Python 判 draft
   * 且它的降级理由只有 scope 那一条**时，接受 TS 判 reply。
   */
  const SCOPE_LINE = "autonomy scope is draft_only"
  const pythonVerdict = brief.verdict
  const pyBecause = (brief.because ?? []).filter(
    (line) =>
      !line.trim().startsWith("measured default") &&
      !line.trim().startsWith("ask kind not in the measured table"),
  )
  const scopeOnly =
    pythonVerdict === "draft" &&
    pyBecause.length > 0 &&
    pyBecause.every((line) => line.includes(SCOPE_LINE))

  console.log(`\n  python verdict = ${pythonVerdict}`)
  console.log(`  python because = ${JSON.stringify(brief.because)}`)
  console.log(`  （scope-only 降级？${scopeOnly ? "是" : "否"}）`)

  /**
   * TS 侧的 `evaluateGate` 用 esbuild 现打包一份来跑 —— 与应用共享同一份
   * 包源码（照 `check-persona.mjs` 那套做法），而不是重写一遍判定。
   * 重写的话"门禁通了"不代表应用里那条路通。
   *
   * ★ 直接指 `guard.ts` 而不是包的 `index.ts`：后者会把 `intake.ts` 一起
   * 拉进来，而那个文件 import `@mycontext/store` → `better-sqlite3`（原生
   * 模块，打不进 ESM bundle）。判定层本身**不碰库** —— 那正是它可以被
   * 100% 单测覆盖的原因，这里也因此能独立打包。
   */
  const { build } = await import("esbuild")
  const entry = join(work, "gate-entry.mjs")
  writeFileSync(
    entry,
    `import { evaluateGate, defaultGuardPolicy } from ${JSON.stringify(
      join(root, "packages/persona/src/guard.ts"),
    )}
export function judge(input) {
  return evaluateGate({ ...input, policy: defaultGuardPolicy("auto") })
}
`,
  )
  const bundled = join(work, "gate.mjs")
  await build({
    entryPoints: [entry],
    outfile: bundled,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["better-sqlite3"],
    logLevel: "silent",
  })
  const { judge } = await import(`file://${bundled}`)

  const tsVerdict = judge({
    classification: {
      genuineAsk: cls.genuineAsk ?? null,
      chitchat: cls.chitchat ?? null,
      askKind: cls.askKind ?? null,
      riskTags: cls.riskTags ?? [],
      riskDetectable: cls.riskDetectable === true,
      askKindDetectable: cls.askKindDetectable === true,
    },
    recipient: {
      resolved: brief.recipient?.resolved === true,
      toneBand: brief.recipient?.toneBand ?? null,
      sensitive: brief.recipient?.sensitive === true,
    },
    coverage: {
      askKinds: RULES.coverage.askKinds,
      riskTags: RULES.coverage.riskTags,
      replyShapes: RULES.coverage.replyShapes,
      unavailable: null,
    },
    advice: {
      byAskKind: RULES.policy.byAskKind,
      defaultAction: RULES.policy.defaultAction,
      thinAskKinds: RULES.policy.thinAskKinds,
      alwaysDraftKinds: RULES.policy.alwaysDraftKinds,
      bands: RULES.bands,
    },
  })
  console.log(`  ts     verdict = ${tsVerdict.action}`)
  console.log(`  ts     because = ${JSON.stringify(tsVerdict.because)}\n`)

  const agrees = scopeOnly
    ? tsVerdict.action === "reply" || tsVerdict.action === "draft"
    : tsVerdict.action === pythonVerdict
  note(
    agrees,
    `★★ 判定一致（python=${pythonVerdict} / ts=${tsVerdict.action}）`,
    scopeOnly ? "python 那条是 scope-only 降级，TS 侧刻意没有它" : "",
  )

  /**
   * ★ 反向断言：band S 必须两边都拦。
   *
   * 这是搬迁清单里的第 11 条，也是最容易搬错的一条
   * （Python 只判 `"manual only"`，**不判** `"draft only"`）。
   */
  const bandS = judge({
    classification: {
      genuineAsk: true,
      chitchat: false,
      askKind: "status_chase",
      riskTags: [],
      riskDetectable: true,
      askKindDetectable: true,
    },
    recipient: { resolved: true, toneBand: "S", sensitive: false },
    coverage: { askKinds: true, riskTags: true, replyShapes: true, unavailable: null },
    advice: {
      byAskKind: { status_chase: "answer" },
      defaultAction: "draft",
      thinAskKinds: [],
      alwaysDraftKinds: [],
      bands: RULES.bands,
    },
  })
  note(bandS.action === "draft", "★ band S 仍然只出草稿（搬迁清单第 11 条）")

  /**
   * ★★ `coverage.replyShapes: null` —— Python 与 TS 必须**都**降级。
   *
   * Python 是 `if not coverage.get("replyShapes", True)`（truthiness），
   * 所以 null / 0 / "" 都降级。TS 曾经写成 `!== false`，于是 null 时不降级
   * —— 一处实测出来的、方向危险的分歧（review 抓到的）。
   *
   * 这里只验 TS 那一半：Python 侧的行为是它自己那行代码的定义，
   * 而这条断言锁住"TS 跟得上它"。
   */
  const nullCoverage = judge({
    classification: {
      genuineAsk: true,
      chitchat: false,
      askKind: "status_chase",
      riskTags: [],
      riskDetectable: true,
      askKindDetectable: true,
    },
    recipient: { resolved: true, toneBand: "A", sensitive: false },
    // ★ null 而不是 false —— 与 Python 的 truthiness 判据对齐
    coverage: { askKinds: true, riskTags: true, replyShapes: null, unavailable: null },
    advice: {
      byAskKind: { status_chase: "answer" },
      defaultAction: "draft",
      thinAskKinds: [],
      alwaysDraftKinds: [],
      bands: RULES.bands,
    },
  })
  note(
    nullCoverage.action === "draft",
    "★★ coverage.replyShapes 为 null → 只出草稿（与 Python 的 truthiness 一致）",
  )

  const risky = judge({
    classification: {
      genuineAsk: true,
      chitchat: false,
      askKind: "status_chase",
      riskTags: ["commitment"],
      riskDetectable: true,
      askKindDetectable: true,
    },
    recipient: { resolved: true, toneBand: "A", sensitive: false },
    coverage: { askKinds: true, riskTags: true, replyShapes: true, unavailable: null },
    advice: {
      byAskKind: { status_chase: "answer" },
      defaultAction: "draft",
      thinAskKinds: [],
      alwaysDraftKinds: [],
      bands: RULES.bands,
    },
  })
  note(risky.action === "draft", "★ 命中风险类仍然只出草稿（第 6 条）")

  const blind = judge({
    classification: {
      genuineAsk: true,
      chitchat: false,
      askKind: "status_chase",
      riskTags: [],
      // ★ 没有风险词表 —— 必须更保守，而不是"没检测到风险所以放行"
      riskDetectable: false,
      askKindDetectable: true,
    },
    recipient: { resolved: true, toneBand: "A", sensitive: false },
    coverage: { askKinds: true, riskTags: true, replyShapes: true, unavailable: null },
    advice: {
      byAskKind: { status_chase: "answer" },
      defaultAction: "draft",
      thinAskKinds: [],
      alwaysDraftKinds: [],
      bands: RULES.bands,
    },
  })
  note(blind.action === "draft", "★★ 没有风险词表 → 只出草稿（第 7 条，最危险的反向 bug）")
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} 条断言未通过。`)
  process.exit(1)
}
console.log("\n判定 parity 全部通过。")
