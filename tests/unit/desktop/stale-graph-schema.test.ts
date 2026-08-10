/**
 * 旧版图库（上游改名前建的）→ 建图前就说清楚，别让 kl 抛一句 SQL 错误。
 *
 * ## 实测的坏形态（本机 2026-08-10）
 *
 * 界面上「建图」按钮一直失败，红字是：
 *
 *     建图失败：table facts has no column named source_chunk_id
 *
 * 而**该做的事**（点旁边那个「重建」）完全没出现在信息里。更糟的是它每次
 * 都失败 —— 于是「知识图谱」这块功能对老用户彻底不可用，而看不出为什么。
 *
 * 成因：上游把 `facts.source_message_id` 改名成 `source_chunk_id`（外键也从
 * `messages` 改指 `chunks`），**没有配数据迁移**。新库建出来是新 schema，
 * 而任何在那之前建过图的库都是旧的。
 *
 * 同一份代码、同一个按钮，两栏表现相反：
 * · 钉钉那栏能建 —— 查问题时手动清过库（新 schema）；
 * · 飞书那栏必失败 —— 从没清过（旧 schema）。
 * 差别只在库是哪个版本建的。
 *
 * ## 这一组锁的四件事
 *
 * ① 旧库 → `ok:false` 且 reason **提到「重建」**（用户要能照做）；
 * ② 新库 → 放行（别把修复做成"永远不给建图"）；
 * ③ 空库 / 没有库 → 放行（那是"还没建过图"，不是"旧"）；
 * ④ `fresh=true` **不做这个检查**（它自己就是修法：先清后建）。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createLogger } from "@mycontext/kernel"
import type { ProcessRunner } from "@mycontext/runtime-env"
import { KlServerService, type GraphDbHandle } from "@main/services/kl-server.service"

const logger = createLogger("test-stale-schema", { level: "error" })

/**
 * 旧 schema 提示里的锚点词。
 *
 * ★ 只锚这一小段而不是整句：文案会被润色，而判据要盯的是"是不是这一类
 * 提示"。也不能锚"重建"两个字 —— `rebuildGraph` 里另一道保护的文案是
 * 「清空**重建**会让现有图谱直接消失」，会误命中（第一版就踩了）。
 */
const STALE_HINT = "旧版本建的"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stale-graph-"))
  // 探测的前置条件是文件存在（不存在 = 还没建过图，直接放行）
  writeFileSync(join(dir, "knowledge.db"), "")
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 只实现探测会碰到的 `columns`；其余方法调到就说明实现走错了路。 */
function fakeDb(columns: string[]): GraphDbHandle {
  return {
    columns: () => columns,
    count: () => {
      throw new Error("探测不该 count")
    },
    groupBy: () => {
      throw new Error("探测不该 groupBy")
    },
    topEntities: () => {
      throw new Error("探测不该 topEntities")
    },
    recentFacts: () => {
      throw new Error("探测不该 recentFacts")
    },
    close: () => undefined,
  }
}

function service(options: {
  columns?: string[]
  openThrows?: boolean
  postIngest?: (port: number, dir: string, sourceId: string) => Promise<number>
}) {
  return new KlServerService({
    clock: { now: () => 1_000 },
    logger,
    processes: {} as unknown as ProcessRunner,
    channelId: "dingtalk",
    klRoot: "/tmp/kl-root",
    dataDir: dir,
    exportDir: "/tmp/exports",
    port: 8299,
    getWindow: () => null,
    openGraphDb: () => {
      if (options.openThrows === true) throw new Error("库损坏 / 文件锁 / ABI 不匹配")
      return fakeDb(options.columns ?? [])
    },
    /**
     * ★ Python 环境给 null → `start()` 会 fail。
     *
     * 这一组只验**探测这一步**：探测拦下时应当在碰到 Python 之前就返回，
     * 而放行时会往下走到"环境不可用"。两者的 reason 截然不同，
     * 所以这个 fake 反而让判据更锐利（放行时能看到它走过去了）。
     */
    preparePython: () => Promise.resolve(null),
    ...(options.postIngest === undefined ? {} : { postIngest: options.postIngest }),
  })
}

describe("旧版图库在建图前就被识别出来", () => {
  it("★★ 旧 schema → ok:false，且话里要有「重建」", async () => {
    const out = await service({ columns: ["id", "text", "source_message_id"] }).rebuildGraph(false)

    expect(out.ok).toBe(false)
    // ★ 核心判据：用户要能照做。只说"schema 不对"等于没说
    expect(out.reason).toContain("重建")
    // ★ 不许把 kl 那句 SQL 错误原样抛给用户
    expect(out.reason).not.toContain("no column named")
    expect(out).toMatchObject({ entities: 0, facts: 0, edges: 0 })
  })

  it("★★ 新 schema → 放行（别修成「永远不给建图」）", async () => {
    const out = await service({ columns: ["id", "text", "source_chunk_id"] }).rebuildGraph(false)

    // 放行之后才会撞上 fake 的"Python 不可用" —— 也就是它真的走过去了
    expect(out.reason).not.toContain(STALE_HINT)
  })

  it("★ 空库（表还没建）→ 放行，那是「还没建过图」不是「旧」", async () => {
    const out = await service({ columns: [] }).rebuildGraph(false)
    expect(out.reason).not.toContain(STALE_HINT)
  })

  it("★ 两列都在（上游真去做了迁移）→ 放行", async () => {
    const out = await service({
      columns: ["source_message_id", "source_chunk_id"],
    }).rebuildGraph(false)
    expect(out.reason).not.toContain(STALE_HINT)
  })

  /**
   * ★★ 探测本身出错时**不拦**建图。
   *
   * 文件锁、库损坏、原生模块 ABI 不匹配（本仓库反复踩过）都会让 `open` 抛。
   * 那时拦住等于把一个诊断能力变成一道新的故障源 —— 而放行的最坏结果只是
   * 回到改动前：kl 抛那句 SQL 错误，与现在同样可见。
   */
  it("★★ 探测抛错 → 放行，不把诊断变成新的故障源", async () => {
    const out = await service({ openThrows: true }).rebuildGraph(false)
    expect(out.reason).not.toContain(STALE_HINT)
  })

  /**
   * ★★ `fresh=true` 跳过这个检查 —— 它自己就是修法。
   *
   * 不跳的话「重建」按钮会被自己的检查拦住，于是旧库**永远修不了**：
   * 建图说"去点重建"、重建说"库是旧的" —— 一个闭环死锁。
   *
   * ★ 这条断言的**不是**「fresh 一定成功」：它还会被另一道既有保护拦下
   * （导出目录不存在时不许清库 —— "清空重建会让现有图谱直接消失，已取消"，
   * 那是对的，见 `rebuildGraph` 里 fresh 的前置校验）。这里只验
   * **不是被 schema 检查拦的** —— 第一版判据写成"不含『重建』"，
   * 结果撞上了那条保护文案里的"清空重建"，测试红了而实现是对的。
   */
  it("★★ fresh=true 不做这个检查（否则旧库永远修不了）", async () => {
    const postIngest = vi.fn(() => Promise.resolve(200))
    const out = await service({
      columns: ["id", "text", "source_message_id"],
      postIngest,
    }).rebuildGraph(true)

    // ★ 判据：没被那条 schema 提示拦住（它就是那条提示指向的动作）
    expect(out.reason).not.toContain(STALE_HINT)
  })
})
