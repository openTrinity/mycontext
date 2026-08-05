/**
 * 文档采集的解析与聚合。
 *
 * ## 为什么这些用单测锁，而不是只靠真跑
 *
 * `scripts/check-docs.mjs` 会真跑一轮（那是必需的 —— 缺 `created_at` 那个
 * 迁移问题只有真跑才暴露）。但真跑**锁不住形状**：它依赖账号里恰好有
 * 什么文档，而下面这几条是"这类响应必须被解析成这样"的断言。
 *
 * 三条各对应一种**静默**失效（都不抛异常，见 documents.ts 文件头）：
 * ① 两种时间格式少吃一种 → `updatedAt` 为 null → 下游按时间窗过滤全漏；
 * ② 文件夹被当成文档行 → 文档数虚高且正文永远取不到；
 * ③ 后缀白名单错 → 每轮对表格/脑图白烧 CLI 调用，而结果永远是空。
 */
import { describe, expect, it } from "vitest"
import {
  DingTalkDocuments,
  createDingTalkDocuments,
  isReadableDocExtension,
} from "@mycontext/channels"

/** 一个只回固定 payload 的假 cli（按命令前缀分派）。 */
function fakeCli(responses: Record<string, unknown>, calls: string[][] = []) {
  return {
    json: <T>(args: readonly string[]): Promise<T> => {
      calls.push([...args])
      for (const [prefix, payload] of Object.entries(responses)) {
        if (args.join(" ").startsWith(prefix)) return Promise.resolve(payload as T)
      }
      return Promise.reject(new Error(`未预置的命令：${args.join(" ")}`))
    },
  }
}

describe("文档解析：两种时间格式都要吃", () => {
  /**
   * ★ 实测：`drive recent` 给 **ISO-8601 带偏移**的串，
   * 而 `wiki space list` / `node list` 给 **epoch ms 数字**。
   * 同一个二进制的两个子命令，格式不同 —— 这不是笔误。
   */
  it("drive 的 ISO 带偏移串解析成 unix ms", async () => {
    const docs = new DingTalkDocuments({
      cli: fakeCli({
        "drive recent": {
          hasMore: false,
          recentItems: [
            {
              nodeId: "N1",
              name: "范围",
              nodeType: "file",
              contentType: "ALIDOC",
              extension: "adoc",
              docUrl: "https://x/1",
              createTime: "2026-06-26T14:25:41+08:00",
              updateTime: "2026-07-31T10:18:30+08:00",
            },
          ],
        },
      }),
    })
    const { page } = await docs.listRecent()
    expect(page.items).toHaveLength(1)
    // 2026-07-31T10:18:30+08:00 === 2026-07-31T02:18:30Z
    expect(new Date(page.items[0]!.updatedAt!).toISOString()).toBe("2026-07-31T02:18:30.000Z")
    expect(new Date(page.items[0]!.createdAt!).toISOString()).toBe("2026-06-26T06:25:41.000Z")
  })

  it("wiki 的 epoch ms 数字同样解析成 unix ms", async () => {
    const docs = new DingTalkDocuments({
      cli: fakeCli({
        "wiki node list": {
          hasMore: false,
          nodes: [
            {
              nodeId: "N2",
              name: "产品说明",
              nodeType: "file",
              extension: "adoc",
              docUrl: "https://x/2",
              createTime: 1784389250000,
              updateTime: 1784389257000,
              workspaceId: "WS1",
            },
          ],
        },
      }),
    })
    const { items } = await docs.listWikiNodes("WS1")
    expect(items).toHaveLength(1)
    expect(items[0]!.updatedAt).toBe(1784389257000)
    expect(items[0]!.workspaceId).toBe("WS1")
  })

  /**
   * ★ **不带时区**的 naive 串必须判成 null，而不是按机器 TZ 猜。
   *
   * 这是 `time.ts` 拒绝 `new Date(str)` 的同一条规则：在 +08 的开发机上
   * 猜对了看不出问题，CI 在 UTC 上同一篇文档就偏 8 小时。
   * 宁可让"时间未知"显式为 null。
   */
  it("naive 串（无时区）判成 null，不按机器时区猜", async () => {
    const docs = new DingTalkDocuments({
      cli: fakeCli({
        "drive recent": {
          hasMore: false,
          recentItems: [
            { nodeId: "N3", name: "x", nodeType: "file", updateTime: "2026-07-28 10:53:49" },
          ],
        },
      }),
    })
    const { page } = await docs.listRecent()
    expect(page.items[0]!.updatedAt).toBeNull()
  })
})

describe("文档解析：文件夹只递归，不当文档行", () => {
  /**
   * ★ 实测 wiki 根目录下大量条目是 `nodeType: "folder"`。
   * 把它们当文档行的后果：文档数虚高，而每一个的正文永远取不到
   * （`doc read` 对文件夹给不出 markdown）—— 于是正文队列被永久堵住。
   */
  it("folder 不产出文档行，但会被递归展开", async () => {
    const calls: string[][] = []
    const docs = new DingTalkDocuments({
      cli: {
        json: <T>(args: readonly string[]): Promise<T> => {
          calls.push([...args])
          const isChild = args.includes("--folder")
          return Promise.resolve(
            (isChild
              ? { hasMore: false, nodes: [{ nodeId: "leaf", name: "叶子", nodeType: "file" }] }
              : {
                  hasMore: false,
                  nodes: [
                    { nodeId: "F1", name: "版本冲刺", nodeType: "folder", hasChildren: true },
                  ],
                }) as T,
          )
        },
      },
    })
    const { items } = await docs.listWikiNodes("WS1")
    // 只有叶子那一篇进结果，folder 本身不进
    expect(items.map((i) => i.externalId)).toEqual(["leaf"])
    // 而且真的下钻了一层（第二次调用带 --folder F1）
    expect(calls.some((c) => c.includes("--folder") && c.includes("F1"))).toBe(true)
  })

  /**
   * ★ 单个文件夹列不出来（权限 / 已删）只跳过它，不让整个知识库失败。
   *
   * 实测真机上撞到过跨组织拒绝（`forbidden.accessDenied`：文档属于另一个
   * 组织）。整轮抛的话那次采集一篇都拿不到，而"部分成功"更接近事实。
   */
  it("某个文件夹拒绝访问时，其余节点照常返回", async () => {
    const docs = new DingTalkDocuments({
      cli: {
        json: <T>(args: readonly string[]): Promise<T> => {
          if (args.includes("--folder")) return Promise.reject(new Error("forbidden.accessDenied"))
          return Promise.resolve({
            hasMore: false,
            nodes: [
              { nodeId: "F1", name: "禁区", nodeType: "folder", hasChildren: true },
              { nodeId: "ok", name: "能读的", nodeType: "file", extension: "adoc" },
            ],
          } as T)
        },
      },
    })
    const { items } = await docs.listWikiNodes("WS1")
    expect(items.map((i) => i.externalId)).toEqual(["ok"])
  })
})

describe("文档正文：按后缀过滤，别白烧 CLI 调用", () => {
  /**
   * ★ 表格（axls）/ 脑图（dingfm）`doc read` 给不出 markdown。
   * 不过滤的话每轮对几十个各白跑一次调用（0.3-0.8s），而结果永远是空。
   */
  it("表格与脑图**不调** doc read", async () => {
    const calls: string[][] = []
    const docs = new DingTalkDocuments({ cli: fakeCli({}, calls) })
    for (const extension of ["axls", "dingfm", "pdf"]) {
      const body = await docs.readBody({ externalId: "N", extension })
      expect(body.contentText).toBeNull()
      expect(body.rawPayload).toBeNull()
    }
    // 一次调用都没发生 —— 这才是这条过滤的意义
    expect(calls).toHaveLength(0)
  })

  it("adoc 会调 doc read 并取到 markdown", async () => {
    const calls: string[][] = []
    const docs = new DingTalkDocuments({
      cli: fakeCli({ "doc read": { nodeId: "N", markdown: "# 标题\n正文" } }, calls),
    })
    const body = await docs.readBody({ externalId: "N", extension: "adoc" })
    expect(body.contentText).toBe("# 标题\n正文")
    expect(calls[0]).toEqual(["doc", "read", "--node", "N"])
  })

  /** `doc read` 失败（权限 / 已删）返回 null 而不抛 —— 单篇取不到是常态。 */
  it("doc read 失败时返回 null，不抛", async () => {
    const docs = new DingTalkDocuments({ cli: fakeCli({}) })
    const body = await docs.readBody({ externalId: "N", extension: "adoc" })
    expect(body.contentText).toBeNull()
  })

  /** 后缀判据导出给导出侧共用 —— 两处各写一份必然漂。 */
  it("isReadableDocExtension 与实现同源", () => {
    expect(isReadableDocExtension("adoc")).toBe(true)
    expect(isReadableDocExtension("ADOC")).toBe(true)
    expect(isReadableDocExtension("axls")).toBe(false)
    expect(isReadableDocExtension("dingfm")).toBe(false)
    // 空后缀放行：拿不到后缀时宁可试一次（而不是永久跳过）
    expect(isReadableDocExtension(null)).toBe(true)
  })
})

describe("ChannelDocuments：wiki 与 drive 合成一条流", () => {
  /**
   * ★ 首轮才跑 wiki（它没有跨库游标，一次递归就是全量），
   * 之后的 cursor 只翻 drive。否则每翻一页 drive 都要把整棵 wiki 树重列一遍。
   */
  it("首轮同时列 wiki 与 drive；后续轮只翻 drive", async () => {
    const calls: string[][] = []
    const documents = createDingTalkDocuments(
      fakeCli(
        {
          "wiki space list": { hasMore: false, wikiSpaces: [{ workspaceId: "WS1", name: "库" }] },
          "wiki node list": {
            hasMore: false,
            nodes: [{ nodeId: "w1", name: "wiki 文档", nodeType: "file", extension: "adoc" }],
          },
          "drive recent": {
            hasMore: true,
            nextCursor: "C2",
            recentItems: [{ nodeId: "d1", name: "drive 文档", nodeType: "file" }],
          },
        },
        calls,
      ),
    )

    const first = await documents.list({})
    expect(first.items.map((i) => i.externalId).sort()).toEqual(["d1", "w1"])
    expect(first.items.find((i) => i.externalId === "w1")!.origin).toBe("wiki")
    expect(first.items.find((i) => i.externalId === "d1")!.origin).toBe("drive")
    // 游标带前缀，标明它属于 drive
    expect(first.nextToken).toBe("drive:C2")

    calls.length = 0
    const second = await documents.list({ cursor: first.nextToken })
    // ★ 第二轮一次 wiki 调用都没有
    expect(calls.some((c) => c[0] === "wiki")).toBe(false)
    expect(second.items.map((i) => i.externalId)).toEqual(["d1"])
    // 前缀被剥掉后原样透给 --cursor
    expect(calls.some((c) => c.includes("--cursor") && c.includes("C2"))).toBe(true)
  })

  /**
   * ★ 知识库整段失败时 **truncated 必须为 true**。
   *
   * 不报的话"这个账号没有知识库"与"知识库列举失败了"在结果里同形 ——
   * 而后者是要能看见的（否则用户以为文档就这么少）。
   */
  it("wiki 整段失败时 truncated=true，但 drive 那半边照常返回", async () => {
    const documents = createDingTalkDocuments(
      fakeCli({
        "drive recent": {
          hasMore: false,
          recentItems: [{ nodeId: "d1", name: "x", nodeType: "file" }],
        },
      }),
    )
    const result = await documents.list({})
    expect(result.items.map((i) => i.externalId)).toEqual(["d1"])
    expect(result.truncated).toBe(true)
  })

  /** 还有更多知识库没列到（`hasMore`）同样算截断。 */
  it("知识库分页没翻完时 truncated=true", async () => {
    const documents = createDingTalkDocuments(
      fakeCli({
        "wiki space list": {
          hasMore: true,
          nextPageToken: "20_0",
          wikiSpaces: [{ workspaceId: "WS1", name: "库" }],
        },
        "wiki node list": { hasMore: false, nodes: [] },
        "drive recent": { hasMore: false, recentItems: [] },
      }),
    )
    const result = await documents.list({})
    expect(result.truncated).toBe(true)
  })
})
