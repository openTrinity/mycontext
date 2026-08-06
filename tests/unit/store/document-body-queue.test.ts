/**
 * 文档正文抓取队列（`listMissingBody` / `countMissingBody`）。
 *
 * ## ★★ 为什么这个队列需要按后缀过滤，而不是让调用方跳过
 *
 * 采集侧有**每轮配额**（`DOCUMENTS_BODY_PER_ROUND`，正文是逐篇一次 CLI
 * 调用，占着采集锁）。而表格（`able`/`axls`）、脑图、图片、快捷链接这些
 * **永远**取不到正文，却与真文档混在同一个 `updated_at` 序里。
 *
 * 实测这台机器的库：1143 篇缺正文，其中 **104 篇是永远取不到的后缀**，
 * 而队首 8 篇里就有 2 篇 `able`。也就是每轮 5 个配额被白占 40%，
 * 而且**每轮都是同样那几篇** —— 取不到 → `content_text` 仍是 null →
 * 下一轮又排在最前面。
 *
 * 调用方按后缀跳过不能解决这个：那样只是不发 CLI 调用，**配额已经花掉了**。
 * 必须在取队列的 SQL 里就排除。
 *
 * ## `countMissingBody` 是分档判据
 *
 * 采集侧用它决定跑"冷启动档"（10min × 20 篇）还是"稳态档"（60min × 5 篇）。
 * 它**必须**同样按后缀过滤 —— 不过滤的话那 104 篇会让判据恒为
 * "还没追平"，于是永远跑冷启动档（每 10 分钟一轮全量列举，一天 144 次）。
 */
import { describe, expect, it } from "vitest"
import { DocumentRepository } from "@mycontext/store"
import { openTestVault } from "../../helpers/vault.js"

const CHANNEL = "dingtalk"
const NOW = new Date(2026, 7, 5, 12, 0, 0).getTime()
/** 与 `createDingTalkDocuments().readableExtensions` 同一个集合。 */
const READABLE = ["adoc", "amd", "md", "adocx"] as const

/** 造一批文档：`[externalId, extension, 有没有正文, updatedAt 偏移]`。 */
function seed(
  repo: DocumentRepository,
  rows: readonly [string, string | null, boolean, number][],
): void {
  repo.upsertMany(
    rows.map(([externalId, extension, hasBody, offset]) => ({
      id: `doc-${externalId}`,
      channelId: CHANNEL as never,
      externalId,
      extension,
      title: `T-${externalId}`,
      contentText: hasBody ? "# 正文" : null,
      updatedAt: NOW - offset,
      fetchedAt: NOW,
    })),
  )
}

describe("★★ 正文队列按可读后缀过滤（否则配额被永远取不到的占掉）", () => {
  it("★ 不可读后缀不进队列，哪怕它们更新得更晚（排在最前）", () => {
    const vault = openTestVault()
    try {
      const repo = new DocumentRepository(vault.db)
      /**
       * 刻意让两个表格**最新**（offset 最小 → `updated_at DESC` 的队首）。
       * 这正是实测那个库的形态：队首 8 篇里 2 篇 `able`。
       */
      seed(repo, [
        ["t1", "able", false, 0],
        ["t2", "axls", false, 1],
        ["d1", "adoc", false, 10],
        ["d2", "adoc", false, 20],
        ["d3", "md", false, 30],
      ])

      const queue = repo.listMissingBody(CHANNEL, 3, READABLE)
      /**
       * ★ 三个位置全给真文档。
       *
       * 不过滤的话前两个会是 `able`/`axls` —— 那两次 CLI 调用必然返回空，
       * 而下一轮它们仍然排在最前面（`content_text` 还是 null）。
       */
      expect(queue.map((r) => r.externalId)).toEqual(["d1", "d2", "d3"])
    } finally {
      vault.close()
    }
  })

  it("已有正文的不在队列里（那是完成态）", () => {
    const vault = openTestVault()
    try {
      const repo = new DocumentRepository(vault.db)
      seed(repo, [
        ["done", "adoc", true, 0],
        ["todo", "adoc", false, 10],
      ])
      expect(repo.listMissingBody(CHANNEL, 5, READABLE).map((r) => r.externalId)).toEqual(["todo"])
    } finally {
      vault.close()
    }
  })

  it("★ 后缀大小写不敏感（渠道给的 extension 实测大小写混用）", () => {
    const vault = openTestVault()
    try {
      const repo = new DocumentRepository(vault.db)
      seed(repo, [["mixed", "ADOC", false, 0]])
      /**
       * 这一条真会断：SQL 两侧都得 lower()。只 lower 一侧的话
       * 大写后缀的文档**永远不进队列** —— 表现是"有些文档就是没正文"，
       * 而没有任何东西报错。
       */
      expect(repo.listMissingBody(CHANNEL, 5, READABLE).map((r) => r.externalId)).toEqual(["mixed"])
    } finally {
      vault.close()
    }
  })

  it("不传白名单 = 不过滤（老行为保留）", () => {
    const vault = openTestVault()
    try {
      const repo = new DocumentRepository(vault.db)
      seed(repo, [
        ["t1", "able", false, 0],
        ["d1", "adoc", false, 10],
      ])
      expect(repo.listMissingBody(CHANNEL, 5).map((r) => r.externalId)).toEqual(["t1", "d1"])
    } finally {
      vault.close()
    }
  })

  it("★ 另一个渠道的文档不串进来", () => {
    const vault = openTestVault()
    try {
      const repo = new DocumentRepository(vault.db)
      seed(repo, [["mine", "adoc", false, 10]])
      repo.upsertMany([
        {
          id: "doc-other",
          channelId: "feishu" as never,
          externalId: "other",
          extension: "adoc",
          contentText: null,
          updatedAt: NOW,
          fetchedAt: NOW,
        },
      ])
      expect(repo.listMissingBody(CHANNEL, 5, READABLE).map((r) => r.externalId)).toEqual(["mine"])
      expect(repo.countMissingBody(CHANNEL, READABLE)).toBe(1)
    } finally {
      vault.close()
    }
  })
})

describe("★★ countMissingBody：分档判据（算错会永远跑冷启动档）", () => {
  it("★ 只数可读后缀 —— 不可读的会让判据恒为「还没追平」", () => {
    const vault = openTestVault()
    try {
      const repo = new DocumentRepository(vault.db)
      seed(repo, [
        ["d1", "adoc", false, 0],
        ["d2", "adoc", false, 1],
        // 下面这些永远取不到正文，不该让"还缺多少"虚高
        ["t1", "able", false, 2],
        ["t2", "axls", false, 3],
        ["i1", "png", false, 4],
        ["l1", "hlink", false, 5],
      ])
      /**
       * ★ 2 而不是 6。
       *
       * 算成 6 的后果不是"数字难看"：采集侧据此判定还没追平，
       * 于是**永远**跑 10 分钟一轮 × 20 篇的冷启动档 ——
       * 而那 4 篇永远补不上，判据永远为真。
       */
      expect(repo.countMissingBody(CHANNEL, READABLE)).toBe(2)
    } finally {
      vault.close()
    }
  })

  it("全部补齐后归零（这是降回稳态档的信号）", () => {
    const vault = openTestVault()
    try {
      const repo = new DocumentRepository(vault.db)
      seed(repo, [
        ["d1", "adoc", true, 0],
        ["t1", "able", false, 1],
      ])
      expect(repo.countMissingBody(CHANNEL, READABLE)).toBe(0)
    } finally {
      vault.close()
    }
  })

  it("空白名单 → 0（判据不可靠时按已追平走保守档）", () => {
    const vault = openTestVault()
    try {
      const repo = new DocumentRepository(vault.db)
      seed(repo, [["d1", "adoc", false, 0]])
      expect(repo.countMissingBody(CHANNEL, [])).toBe(0)
    } finally {
      vault.close()
    }
  })
})
