/**
 * 我们的导出 → 他们的 adapter → 他们的图库：跑出一个真的 knowledge graph。
 *
 * ## 这条测试证明的是什么
 *
 * `kl-adapter-roundtrip.test.ts` 只证明「adapter 能读懂我们的文件」。
 * 这条再往前走一步：把 adapt 出来的 `Message` 塞进他们的 `SQLiteStore`，
 * 建 `SENT_BY` / `IN_CONV` / `REPLY_TO` / `TEMPORAL` 边，然后查出来。
 * 也就是用户那句「看能不能跑出 knowledge graph」的可执行版本。
 *
 * ## 为什么不跑他们的 `scripts/ingest.py`
 *
 * 那条链路要 jieba + qdrant + LLM 网关 + embedding key。
 * 在**门禁外的测试**里依赖一个真模型意味着这条测试会因为额度、
 * 限流、模型更新而随机变红 —— 而它要验的东西（数据接得通、图能建起来）
 * 与模型无关。所以这里只用他们的**存储层与类型**（纯 stdlib），
 * 实体/事实抽取用一个显式的规则替身。
 *
 * 结论上的差别要说清：**这条测试证明数据管道通，不证明抽取质量**。
 * 后者要人看，且要真模型 —— 那是联调时的事，不是门禁能替代的事。
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ManualClock } from "@mycontext/kernel"
import { formatDwsIsoTime, parseDwsLocalTime } from "@mycontext/channels"
import { ConversationRepository, MessageRepository } from "@mycontext/store"
import { ExportMaterializer } from "@mycontext/knowledge-feed"
import { openTestVault } from "../helpers/vault.js"

const root = resolve(import.meta.dirname, "../..")
const klRoot = join(root, "kl-graph")
const hasKl = existsSync(join(klRoot, "kl_graph/storage/sqlite_store.py"))

const START = 1_785_000_000_000
const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

interface GraphStats {
  messages: number
  entities: number
  edges: Record<string, number>
  /** 某条消息的一跳邻居（用于验证 REPLY_TO 真的连上了） */
  neighborsOfLast: string[]
  /** 全部消息时间戳（用于跨语言比对） */
  timestamps: number[]
}

/**
 * 起一批消息并导出成标准四件套，返回导出目录。
 *
 * 与 `buildGraph` 分开：pipeline 那一组只需要"我们的导出物"，
 * 不需要再建一遍图（那一步要 3 秒且与它要验的事无关）。
 */
function exportSample(): { dir: string; expected: number[] } {
  const vault = openTestVault()
  const dir = mkdtempSync(join(tmpdir(), "mycontext-kl-e2e-"))
  dirs.push(dir)

  new ConversationRepository(vault.db).upsert({
    id: "conv-1",
    channelId: "dingtalk",
    externalId: "cid-group",
    type: "group",
    title: "沙箱项目群",
    memberCount: 12,
    createdAt: START,
  })

  const times = [
    "2026-07-28 10:53:49",
    "2026-07-28 10:55:02",
    "2026-07-28 11:02:17",
    "2026-07-28 11:30:00",
  ]
  const expected = times.map((time) => parseDwsLocalTime(time))

  new MessageRepository(vault.db).upsertMany([
    {
      id: "m-1",
      channelId: "dingtalk",
      conversationId: "conv-1",
      externalId: "msg-1",
      senderExternalId: "DeMINE",
      senderDisplayName: "小周",
      contentText: "沙箱环境部署完成了",
      sentAt: expected[0]!,
      direction: "outbound",
      isSelf: true,
      createdAt: START,
    },
    {
      id: "m-2",
      channelId: "dingtalk",
      conversationId: "conv-1",
      externalId: "msg-2",
      senderExternalId: "DeLI",
      senderDisplayName: "小李",
      contentText: "收到，我去验一下接口",
      sentAt: expected[1]!,
      direction: "inbound",
      isSelf: false,
      // ★ 引用关系：REPLY_TO 边的来源
      quotedExternalId: "msg-1",
      createdAt: START,
    },
    {
      id: "m-3",
      channelId: "dingtalk",
      conversationId: "conv-1",
      externalId: "msg-3",
      senderExternalId: "DeLI",
      senderDisplayName: "小李",
      contentText: "接口通了",
      sentAt: expected[2]!,
      direction: "inbound",
      isSelf: false,
      createdAt: START,
    },
    {
      // 同一个人换了显示名（花名改了）——实体去重必须按 ID 而不是名字
      id: "m-4",
      channelId: "dingtalk",
      conversationId: "conv-1",
      externalId: "msg-4",
      senderExternalId: "DeMINE",
      senderDisplayName: "高鹏",
      contentText: "好，那就发布",
      sentAt: expected[3]!,
      direction: "outbound",
      isSelf: true,
      createdAt: START,
    },
  ])

  new ExportMaterializer({
    db: vault.db,
    clock: new ManualClock(START),
    exportDir: dir,
    formatTime: formatDwsIsoTime,
  }).run()
  vault.close()

  return { dir, expected }
}

/** 导出 → 用他们的加载器与存储层建图，返回图的统计。 */
function buildGraph(): { stats: GraphStats; expected: number[] } {
  const { dir, expected } = exportSample()
  const script = join(root, "tests/externals/fixtures/kl_build_graph.py")
  const dbPath = join(dir, "graph.sqlite")
  const out = execFileSync("python3", [script, klRoot, dir, dbPath], { encoding: "utf8" })
  return { stats: JSON.parse(out) as GraphStats, expected }
}

describe.skipIf(!hasKl)("★ kl-graph 端到端：跑出一个真的 knowledge graph", () => {
  it("四条消息全部进图库", () => {
    expect(buildGraph().stats.messages).toBe(4)
  })

  /**
   * ★ 实体按 **sender_id** 去重，不是按显示名。
   *
   * 数据里 `DeMINE` 出现过两个显示名（「小周」与「高鹏」）——
   * 按名字去重会得到 3 个人，而真相是 2 个。
   * 这正是对接说明 §4「陷阱二」的可执行形式。
   */
  it("两个人（不是三个）—— 同一 ID 的两个花名不算两个人", () => {
    expect(buildGraph().stats.entities).toBe(2)
  })

  it("结构边按类型建齐", () => {
    const { edges } = buildGraph().stats
    expect(edges["SENT_BY"]).toBe(4) // 每条消息一条
    expect(edges["IN_CONV"]).toBe(4)
    expect(edges["REPLY_TO"]).toBe(1) // 只有 msg-2 引用了别人
    expect(edges["TEMPORAL"]).toBe(3) // n 条消息 n-1 条时序边
  })

  /** 图能**查**得动，不只是能写进去：最后一条消息应当有时序邻居。 */
  it("最后一条消息查得到邻居（图是连通的）", () => {
    const { neighborsOfLast } = buildGraph().stats
    expect(neighborsOfLast).toContain("TEMPORAL")
    expect(neighborsOfLast).toContain("SENT_BY")
  })

  /**
   * ★ 跨语言时间一致 —— 整条链路上最贵的一个坑。
   *
   * 他们原来的 `_parse_timestamp` 在 `TZ=UTC` 下会偏 8 小时
   * （见 `kl-graph改动说明.md` §3）。我们的导出带 `timestampMs`、
   * adapter 优先读它，所以这里必须逐条相等而不是"差不多"。
   */
  it("时间戳与我们库里逐条相等（不是差 8 小时）", () => {
    const { stats, expected } = buildGraph()
    expect(stats.timestamps).toEqual(expected)
  })

  it.each(["UTC", "Asia/Shanghai"])("TZ=%s 下图里的时间不变", (tz) => {
    const original = process.env["TZ"]
    try {
      process.env["TZ"] = tz
      const { stats, expected } = buildGraph()
      expect(stats.timestamps).toEqual(expected)
    } finally {
      if (original === undefined) delete process.env["TZ"]
      else process.env["TZ"] = original
    }
  })
})

/**
 * ★ 跑**他们自己的** `scripts.ingest`，不只是我们拼的图。
 *
 * 上面那一组用他们的存储层 + 我们的规则替身，证明的是"管道通"。
 * 这一组直接调他们的 pipeline —— 真 LLM 抽取，证明的是"我们的导出物
 * 能被他们的**生产**代码消费"。这两件事不是一回事。
 *
 * ## 实测记录（2026-07，opencode 网关 + claude-sonnet-4-6）
 *
 * 用他们自带的 `tests/smoke_dws`（13 条消息）跑到：
 * · B.3 存消息 → 13
 * · B.4 建实体 → **15**（`InternalTeam`=Project、`gVisor`/`Docker`=System、人名=Person）
 * · B.5 建事实 → **23**
 * · B.6 算 embedding → **停在这里**（缺 `KL_EMBED_API_KEY`）
 *
 * 停在 B.6 正是对接说明 §5 声明的边界：**我们不转发 embedding key**。
 * 所以这条测试的门槛也设在那里 —— 有 LLM key 就能验到 B.5，
 * 有 embedding key 才继续。
 *
 * ## 两个踩到的坑（都写进了对接说明）
 *
 * 1. `KL_LLM_MODEL` 传**裸模型名**，不带 `anthropic/` 前缀 ——
 *    `llm_extractor.py:200` 自己拼 `f"anthropic/{model}"`。
 *    传全名会得到 `anthropic/anthropic/xxx` → `model_not_found`。
 * 2. 抽取失败是**静默的**：`extract_one` 把异常吞成
 *    `{"entities":[],"facts":[],"_error":…}` 并**写进缓存**。
 *    表现是「跑完了，只是什么都没抽出来」，且下次跑会命中那份空缓存。
 *    所以联调时必须看 `LLM errors:` 那一行，不能只看退出码。
 */
const hasLlmKey =
  (process.env["ANTHROPIC_AUTH_TOKEN"] ?? process.env["ANTHROPIC_API_KEY"] ?? "") !== ""
const venvPython = join(klRoot, ".venv/bin/python")
const hasVenv = existsSync(venvPython)

describe.skipIf(!hasKl || !hasVenv || !hasLlmKey)("★ 他们的 pipeline 吃我们的数据", () => {
  it("抽取阶段 0 错误（静默吞异常的话这里会露出来）", () => {
    /**
     * ★ 喂**我们自己导出的**四件套，不是他们的 `tests/smoke_dws`。
     *
     * 首版指向了后者，于是这条测试的名字（"吃我们的数据"）与它实际做的事
     * 不符 —— 而且更糟：他们那份 fixture 还是**旧版** per-conversation JSON，
     * 现版 loader 读不了，实测 `Loaded 0 messages`。断言只看
     * `LLM errors: 0` 的话，0 条输入也是 0 错误 —— 全绿而什么都没验。
     * （现在加的 `LLM calls made: [1-9]` 就是为了让"0 输入"红出来。）
     */
    const { dir: exportDir } = exportSample()
    const dir = mkdtempSync(join(tmpdir(), "mycontext-kl-pipe-"))
    dirs.push(dir)

    const out = execFileSync(
      venvPython,
      ["-m", "scripts.ingest", "--extract-only", "--concurrency", "3"],
      {
        cwd: klRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          KL_DWS_EXPORT_DIR: exportDir,
          KL_DATA_DIR: dir,
          // ★ 裸模型名。带 anthropic/ 前缀会被它二次拼接成 model_not_found
          KL_LLM_MODEL: "claude-sonnet-4-6",
          ...(process.env["ANTHROPIC_BASE_URL"] === undefined
            ? {}
            : { KL_LLM_BASE_URL: process.env["ANTHROPIC_BASE_URL"] }),
        },
        timeout: 300_000,
      },
    )

    // 「跑完了但什么都没抽出来」看起来与成功一样 —— 所以断言这一行
    expect(out).toMatch(/LLM errors: 0/)
    expect(out).toMatch(/LLM calls made: [1-9]/)
  }, 420_000)
})
