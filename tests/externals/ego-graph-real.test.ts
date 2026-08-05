/**
 * ego 图在**真实图库**上的端到端门禁。
 *
 * ## 为什么要这一条（单测已经覆盖了拼图逻辑）
 *
 * 单测喂的是手造的行。而这一条验的是**接线**：
 * · `entitiesByName` / `factLinksAround` / `factConversations` / `entitiesByIds`
 *   四条真 SQL 在真 schema 上跑得通（列名写错在单测里发现不了）；
 * · kl 的 `conversation_id` 真的能对上 vault 的 `external_id`
 *   （渠道归属完全靠这个假设，而它是跨两个数据库的）；
 * · 身份表里的花名真的能在实体表里认出「我」。
 *
 * 这四条里任何一条错了，产品表现都是"图是空的"而没有任何报错。
 *
 * ## ★ 没有图库时**跳过**而不是失败
 *
 * 图库是本机产物（建图要几分钟且出网），CI 与同事的机器上不会有。
 * 让它失败等于给所有人一个必红的用例；而跳过并打一句话，
 * 有图的人（我们自己）仍然被门禁保护着。
 *
 * 这与仓库里 `tests/externals/` 的思路一致：依赖外部真实产物的检查
 * 单独归置、显式跳过，不混进默认门禁的"必须绿"。
 */
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { systemClock, type Logger } from "@mycontext/kernel"
import { GraphQueryService } from "@main/services/graph-query.service"

/**
 * 开发态 userData 目录名的候选，**含改名前的旧名字**。
 *
 * ★★ 这一条是踩到之后加的。全量 rebrand 把 `resolveAppName` 从
 * `Inklings*` 改成 `MyContext*`，这里跟着改之后，本机的真实图谱产物
 * （在改名**之前**跑出来的 `InklingsDevelop/shared/kl`）就再也找不到 ——
 * 于是 `ready` 为 false，整个 describe 被 `skipIf` 跳过。
 *
 * 而 `describe.skipIf` 的输出是**绿色的**：16 条真数据断言静默消失，
 * 看起来与全部通过一模一样。这正是 `pnpm test:externals` 那句提示
 * 「跳过的测试等于没测」要防的东西。
 *
 * 旧名字必须留着：用户与开发者都不会因为我们改了品牌就把老产物删掉。
 */
const APP_DIRS = ["MyContextDevelop", "InklingsDevelop"]

/**
 * 选定一个 userData 目录：要求它**同时**有图谱产物与 vaults。
 *
 * ★ 必须一起选，不能分两个函数各选一次 —— 那样可能选到**不同**的目录
 * （新目录有 vaults、老目录有图谱），于是断言拿 A 的身份去查 B 的图，
 * 结果是"实体一个都认不出"，而报错会指向业务逻辑。
 */
function resolveAppDir(): string {
  const base = join(homedir(), "Library", "Application Support")
  for (const name of APP_DIRS) {
    const dir = join(base, name)
    if (existsSync(join(dir, "shared", "kl", "knowledge.db")) && existsSync(join(dir, "vaults"))) {
      return dir
    }
  }
  // 都没有：返回第一个候选，让下面的 ready 判定为 false（本机没跑过）
  return join(base, APP_DIRS[0] ?? "MyContextDevelop")
}

const APP_DIR = resolveAppDir()
const DATA_DIR = join(APP_DIR, "shared", "kl")
const GRAPH_DB = join(DATA_DIR, "knowledge.db")
const VAULTS = join(APP_DIR, "vaults")

/**
 * 找一个有身份记录的 vault。找不到就跳过（没登录过的机器）。
 *
 * ## ★ ABI 不匹配必须**抛**，不能吞成"跳过"
 *
 * 这个 catch 原来吞掉一切。而 better-sqlite3 是原生模块 ——
 * 仓库里跑应用要 Electron ABI、跑测试要 Node ABI（`pnpm native:electron`
 * / `native:node`）。切错的时候 `new Database` 抛的是
 * `NODE_MODULE_VERSION` 不匹配，被吞掉之后表现是**5 条用例全部"跳过"**
 * —— 而跳过在输出里是绿的。
 *
 * 实测踩到：这一轮改完 service 跑这个文件，得到 `5 skipped`，
 * 而我以为是"本机没数据"。那正是「门禁跳过比门禁失败更糟」那一类。
 *
 * 所以只吞"这个 vault 不合用"（缺表 / 还没迁移），ABI 这种
 * **环境配错**要原样抛出来。
 */
function findVault(): string | null {
  if (!existsSync(VAULTS)) return null
  for (const dir of readdirSync(VAULTS)) {
    const path = join(VAULTS, dir, "core.sqlite")
    if (!existsSync(path)) continue
    try {
      const db = new Database(path, { readonly: true })
      const row = db
        .prepare("SELECT display_names_json AS j FROM channel_self_identity WHERE channel_id = ?")
        .get("dingtalk") as { j: string } | undefined
      db.close()
      if (row !== undefined) return path
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes("NODE_MODULE_VERSION") || message.includes("ERR_DLOPEN_FAILED")) {
        throw new Error(
          "better-sqlite3 的 ABI 与当前 Node 不匹配 —— 跑测试前执行 `pnpm native:node`。" +
            "（这一条刻意抛出而不是跳过：吞掉它会让 5 条用例显示为绿色的 skipped）",
          // 原始错误要挂上：ABI 数字（比如 137 vs 127）在排查时是唯一有用的信息
          { cause: error },
        )
      }
      // 这个 vault 还没跑迁移 / 缺表 —— 换下一个
    }
  }
  return null
}

const vaultPath = findVault()
const ready = existsSync(GRAPH_DB) && vaultPath !== null

const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
}

function makeService(): GraphQueryService {
  const vault = new Database(vaultPath ?? "", { readonly: true })
  const names = JSON.parse(
    (
      vault
        .prepare("SELECT display_names_json AS j FROM channel_self_identity WHERE channel_id = ?")
        .get("dingtalk") as { j: string }
    ).j,
  ) as string[]
  const conversations = vault
    .prepare("SELECT external_id, channel_id FROM conversations")
    .all() as Array<{ external_id: string; channel_id: string }>
  vault.close()

  return new GraphQueryService({
    logger: noopLogger,
    dataDir: DATA_DIR,
    now: () => systemClock.now(),
    getSelfNames: () => names,
    getChannelByConversation: () =>
      new Map(conversations.map((row) => [row.external_id, row.channel_id])),
  })
}

describe.skipIf(!ready)("★ ego 图在真实图库上（本机产物，没有就跳过）", () => {
  it("认出「我」并给出邻居与边", () => {
    const ego = makeService().ego()
    expect(ego.available).toBe(true)
    expect(ego.reason).toBeNull()
    expect(ego.self).not.toBeNull()
    /**
     * 至少要有几个邻居 —— 只有中心节点意味着共现推导没跑通
     * （而那在界面上表现为一个孤零零的圆点）。
     */
    expect(ego.nodes.length).toBeGreaterThan(3)
    expect(ego.edges.length).toBeGreaterThan(0)
  })

  it("★ 渠道真的归到了钉钉（跨两个库的 join，错了表现是「没有描边」）", () => {
    const ego = makeService().ego()
    const channels = new Set(ego.nodes.flatMap((n) => n.channels))
    /**
     * kl 的 `messages.conversation_id` 就是 vault 的
     * `conversations.external_id` —— 整个渠道维度都建立在这个假设上。
     * 对不上的话 `channels` 全是空数组，而图仍然画得出来（只是没描边）。
     */
    expect(channels.has("dingtalk")).toBe(true)
  })

  it("邻居数不超过上限（全图两千多个实体，不截就是毛线团）", () => {
    const ego = makeService().ego()
    // 中心 + 最多 TOP_PEERS 个邻居
    expect(ego.nodes.length).toBeLessThanOrEqual(25)
  })

  it("★ 边的两端都在节点集合里（悬空的边会让 G6 直接报错）", () => {
    const ego = makeService().ego()
    const ids = new Set(ego.nodes.map((n) => n.id))
    for (const edge of ego.edges) {
      expect(ids.has(edge.source)).toBe(true)
      expect(ids.has(edge.target)).toBe(true)
    }
  })

  it("★ 不返回名字之外的原文（fact 正文不进 ego 图 —— 那是大段聊天内容）", () => {
    const ego = makeService().ego()
    for (const node of ego.nodes) {
      // 实体名是短词；一旦这里出现长文本说明取错了列
      expect(node.name.length).toBeLessThan(80)
    }
  })
})

/**
 * ★ 事实检索走**真的** `facts_fts`。
 *
 * ## 为什么单测不够
 *
 * `graph-query.test.ts` 那 13 条用的是注入的假 handle —— 它们验的是
 * "过滤条件有没有原样传下去""筛空了与图里没有说不同的话"这些**决策**。
 * 但 SQL 本身（`openGraphReadDb` 里那段）对假 handle 是不可见的，
 * 而它恰好是最容易错的部分：
 *
 * · `facts_fts` 的正文列是 `text_seg` 而不是 `text` ——
 *   直接 `SELECT text FROM facts_fts` 报 `no such column`（踩过）；
 * · MATCH 吃的是**查询语法**，所以恶意/普通的引号与 `*` 都会让它抛；
 * · 实体过滤必须走 `EXISTS` 而不是 `JOIN` —— 一条 fact 关联多个实体时
 *   JOIN 会把 `total` 放大（表现是"共 47 条"却只有 20 条能翻）。
 *
 * 这三条都只在真库上暴露。
 */
describe.skipIf(!ready)("★ 事实检索在真实图库上", () => {
  it("不带任何过滤 → 有结果，且 total ≥ 返回条数", () => {
    const out = makeService().facts({
      days: null,
      types: [],
      entityName: null,
      keyword: "",
      limit: 20,
      offset: 0,
    })
    expect(out.available).toBe(true)
    expect(out.facts.length).toBeGreaterThan(0)
    expect(out.total).toBeGreaterThanOrEqual(out.facts.length)
    // 正常状态下不该摆一句提示
    expect(out.reason).toBe(null)
  })

  it("★ 关键词走 FTS 且命中的每一条正文里真的有它（中文已预分词）", () => {
    const out = makeService().facts({
      days: null,
      types: [],
      entityName: null,
      keyword: "沙箱",
      limit: 20,
      offset: 0,
    })
    expect(out.available).toBe(true)
    // 本机图库里这个词有命中（实测 62 条）。0 条的话说明 FTS 没接上
    expect(out.total).toBeGreaterThan(0)
    for (const fact of out.facts) {
      expect(fact.text).toContain("沙箱")
    }
  })

  /**
   * ★ 四个会让裸 MATCH 抛的输入。
   *
   * 不转义时实测：`a"b` → `unterminated string`；`NEAR(` → `fts5: syntax error`；
   * `*` → `unknown special query`。而抛出来的表现是整块面板降级 ——
   * 用户只是想搜一个带引号的名字。
   */
  it("★ 敌意关键词不抛、不降级（转义生效）", () => {
    const service = makeService()
    for (const keyword of ['a"b', "NEAR(", "*", "沙箱 OR 1=1"]) {
      const out = service.facts({
        days: null,
        types: [],
        entityName: null,
        keyword,
        limit: 5,
        offset: 0,
      })
      // 关键：available 仍为 true —— 一次异常都不该穿出来
      expect(out.available).toBe(true)
      expect(Array.isArray(out.facts)).toBe(true)
    }
  })

  it("★ 实体过滤不放大 total（一条 fact 可以关联多个实体）", () => {
    const service = makeService()
    // 先拿一个真实存在的实体名（ego 图里的邻居）
    const peer = service.ego().nodes.find((n) => n.hop !== 0)
    expect(peer).toBeDefined()
    const out = service.facts({
      days: null,
      types: [],
      entityName: peer?.name ?? "",
      keyword: "",
      limit: 20,
      offset: 0,
    })
    expect(out.available).toBe(true)
    /**
     * `EXISTS` 而不是 `JOIN`：JOIN 时 total 会数成"fact × 实体"的行数，
     * 于是它可能大于**去重后**能翻到的条数。这里断言 total 与实际
     * 可翻的页数一致 —— 翻到最后一页必须真的有东西。
     */
    if (out.total > 20) {
      const lastOffset = (Math.ceil(out.total / 20) - 1) * 20
      const last = service.facts({
        days: null,
        types: [],
        entityName: peer?.name ?? "",
        keyword: "",
        limit: 20,
        offset: lastOffset,
      })
      expect(last.facts.length).toBeGreaterThan(0)
    }
  })

  it("★ 时间范围真的收窄结果（近 7 天 ≤ 全部）", () => {
    const service = makeService()
    const all = service.facts({
      days: null,
      types: [],
      entityName: null,
      keyword: "",
      limit: 1,
      offset: 0,
    })
    const week = service.facts({
      days: 7,
      types: [],
      entityName: null,
      keyword: "",
      limit: 1,
      offset: 0,
    })
    expect(week.total).toBeLessThanOrEqual(all.total)
  })
})
