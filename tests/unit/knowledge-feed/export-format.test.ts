/**
 * 导出格式契约 —— 对齐 kl-graph 的**标准四件套**。
 *
 * ## 为什么这个文件的断言必须"照 loader 的实际读法"写
 *
 * 上游 `message_loader.load_all_messages()` 读的是
 * `<chat_dir>/records.jsonl` 里 `type == "message"` 的行，
 * 再用 `rec["scope_id"]` 去 `scopes.jsonl` 查会话标题。
 *
 * 首版导出的是 `chat/messages/<title>_<cid>.json` —— 那是**旧版**上游的形状。
 * 喂现版 loader 会让 `iter_records` 找不到 `records.jsonl` → 空迭代器
 * → **ingest 跑完但 messages 是 0，且不报错**。
 *
 * 所以这里逐个字段断言 loader 真正读的那些键：
 * `records.jsonl` 的 `{id, scope_id, type, data}`、
 * `data.content` / `data.createTime` / `data.openMessageId` / `data.sender`、
 * 以及 `scopes.jsonl` 的 `data.title`（`scope_title()` 读它）。
 *
 * ★ 另一条核心断言：每条消息**同时**带 `createTime`（原串）与
 * `timestampMs`（权威值）。上游 `to_unix_ms` 对字符串走
 * `datetime.strptime(...)` **不带时区** → 落到运行机器本地时区；
 * 解析失败时 `return 0` → **静默**把消息时间置成 1970。
 * 我们不改他们的 loader，但必须把正确值给到、把坑写清。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ManualClock } from "@mycontext/kernel"
import { formatDwsIsoTime, parseDwsLocalTime } from "@mycontext/channels"
import {
  ConversationRepository,
  MessageRepository,
  MinutesRepository,
  type SqliteDatabase,
} from "@mycontext/store"
import { ExportMaterializer } from "@mycontext/knowledge-feed"
import { openTestVault, type TestVault } from "../../helpers/vault.js"

const START = 1_785_000_000_000
const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mycontext-export-"))
  dirs.push(dir)
  return dir
}

function seed(vault: TestVault, options: { title?: string | null; externalId?: string } = {}) {
  new ConversationRepository(vault.db).upsert({
    id: "conv-1",
    channelId: "dingtalk",
    // externalId 来自**渠道**（不是我们生成的）→ 必须当不可信输入处理
    externalId: options.externalId ?? "cid-group",
    type: "group",
    title: options.title === undefined ? "沙箱项目群" : options.title,
    memberCount: 12,
    createdAt: START,
  })
  new MessageRepository(vault.db).upsertMany([
    {
      id: "m-1",
      channelId: "dingtalk",
      conversationId: "conv-1",
      externalId: "msg-1",
      senderExternalId: "DeMINE",
      senderDisplayName: "小周",
      contentText: "沙箱环境部署完成了",
      sentAt: parseDwsLocalTime("2026-07-28 10:53:49"),
      direction: "outbound",
      isSelf: true,
      createdAt: START,
      media: [
        {
          kind: "image",
          resourceId: "@lQLPKGtest001",
          resourceKind: "mediaId",
          originalName: null,
        },
      ],
    },
    {
      id: "m-2",
      channelId: "dingtalk",
      conversationId: "conv-1",
      externalId: "msg-2",
      senderExternalId: "DeLI",
      senderDisplayName: "小李",
      contentText: "收到",
      quotedExternalId: "msg-1",
      sentAt: parseDwsLocalTime("2026-07-28 10:55:02"),
      direction: "inbound",
      isSelf: false,
      createdAt: START,
    },
  ])
}

function seedMinutes(db: SqliteDatabase) {
  new MinutesRepository(db).upsertMany([
    {
      id: "min-1",
      channelId: "dingtalk",
      externalId: "uuid-abc",
      title: "连接器授权策略讨论",
      startedAt: 1_785_079_649_000,
      durationSec: 1224,
      summaryText: "> **主题**: 连接器授权策略讨论\n\n## 会议背景\n\n短期方案与默认开启逻辑。",
      transcriptJson: JSON.stringify({
        hasNext: true,
        nextToken: "tok",
        paragraphList: [
          { nickName: "小孙", paragraph: "比如说我这是可以加的。" },
          { nickName: "小王", paragraph: "那就先这样。" },
        ],
      }),
      speakersJson: JSON.stringify({
        owner: { name: "小王" },
        keywords: { keywords: ["内部会议", "连接器管理"] },
        shareUrl: "https://example.invalid/t/abc",
      }),
      fetchedAt: START,
    },
  ])
}

function runExport(vault: TestVault, exportDir: string) {
  return new ExportMaterializer({
    db: vault.db,
    clock: new ManualClock(START),
    exportDir,
    formatTime: formatDwsIsoTime,
  }).run()
}

/** 读一个 source 目录的四件套。 */
function readSource(exportDir: string, name: string) {
  const dir = join(exportDir, name)
  const lines = (file: string): Record<string, unknown>[] => {
    const path = join(dir, file)
    if (!existsSync(path)) return []
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }
  return {
    dir,
    scopes: lines("scopes.jsonl"),
    records: lines("records.jsonl"),
    resources: lines("resources.jsonl"),
    manifest: existsSync(join(dir, "manifest.json"))
      ? (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown>)
      : null,
  }
}

/** `records.jsonl` 里 type=message 的 data（loader 真正读的那层）。 */
function messageData(exportDir: string) {
  return readSource(exportDir, "chat")
    .records.filter((rec) => rec["type"] === "message")
    .map(
      (rec) =>
        rec["data"] as {
          openMessageId: string
          openConversationId: string
          content: string
          createTime: string
          timestampMs: number
          sender: string
          senderOpenDingTalkId: string | null
          isSelf: boolean | null
          quotedMessage?: { openMessageId: string }
        },
    )
}

describe("★★ 标准四件套的目录结构（loader 零改动即可读）", () => {
  it("chat/ 下有 manifest + 三个 jsonl", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seed(vault)
    runExport(vault, dir)

    for (const file of ["manifest.json", "scopes.jsonl", "records.jsonl", "resources.jsonl"]) {
      expect(existsSync(join(dir, "chat", file)), `缺 chat/${file}`).toBe(true)
    }
    vault.close()
  })

  it("★ 消息在 records.jsonl 里、type 为 message（首版写成了独立 JSON 文件）", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seed(vault)
    runExport(vault, dir)

    const source = readSource(dir, "chat")
    const messages = source.records.filter((rec) => rec["type"] === "message")
    expect(messages).toHaveLength(2)
    // 信封的四个键缺一个 loader 就读不到
    for (const rec of messages) {
      expect(typeof rec["id"]).toBe("string")
      expect(typeof rec["scope_id"]).toBe("string")
      expect(rec["type"]).toBe("message")
      expect(typeof rec["data"]).toBe("object")
    }
    vault.close()
  })

  it("★ record.scope_id 能在 scopes.jsonl 里找到（scope_title 靠它取标题）", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seed(vault)
    runExport(vault, dir)

    const source = readSource(dir, "chat")
    const scopeIds = new Set(source.scopes.map((s) => s["id"]))
    for (const rec of source.records) {
      expect(scopeIds.has(rec["scope_id"]), `孤儿 record：${String(rec["id"])}`).toBe(true)
    }
    // 会话 scope 的 data.title 就是 scope_title() 读的那个键
    const chatScope = source.scopes.find((s) => s["type"] === "chat")
    expect((chatScope?.["data"] as { title?: string } | undefined)?.title).toBe("沙箱项目群")
    vault.close()
  })

  it("会话挂在 workspace scope 下（层级与上游 export_chat.py 一致）", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seed(vault)
    runExport(vault, dir)

    const source = readSource(dir, "chat")
    const workspace = source.scopes.find((s) => s["type"] === "workspace")
    expect(workspace?.["id"]).toBe("workspace:ali-ding")
    expect(workspace?.["parent_id"]).toBeNull()
    const chatScope = source.scopes.find((s) => s["type"] === "chat")
    expect(chatScope?.["parent_id"]).toBe("workspace:ali-ding")
    vault.close()
  })

  it("manifest 记录了实际写出的类型与条数（对方据此判断这份 bundle 有什么）", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seed(vault)
    runExport(vault, dir)

    const manifest = readSource(dir, "chat").manifest
    expect(manifest?.["dataset"]).toBe("chat")
    expect(manifest?.["record_types"]).toEqual(["message"])
    expect(manifest?.["scope_types"]).toEqual(["chat", "workspace"])
    expect((manifest?.["counts"] as { records: number }).records).toBe(2)
    vault.close()
  })

  it("无标题的会话也能导出（不因 null 崩掉）", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seed(vault, { title: null })
    expect(() => runExport(vault, dir)).not.toThrow()
    expect(messageData(dir)).toHaveLength(2)
    vault.close()
  })

  /**
   * ★ conversationId 是不可信输入 —— 它来自渠道，不是我们生成的。
   *
   * 现在它只进 JSON 内容（不再拼文件名），但仍然清洗：对方可能拿 scope id
   * 去拼路径（他们的 media 目录就是这么组织的）。
   */
  it("★ conversationId 里的路径穿越被清洗，且落点仍在导出目录内", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seed(vault, { externalId: "../../../../etc/evil" })

    runExport(vault, dir)

    const source = readSource(dir, "chat")
    expect(resolve(source.dir).startsWith(resolve(dir) + sep)).toBe(true)
    const chatScope = source.scopes.find((s) => s["type"] === "chat")
    // scope id 里不再有分隔符
    expect(String(chatScope?.["id"])).not.toMatch(/[/\\]/)
    vault.close()
  })

  it("导出结果带 headSeq（对方据此知道快照对应哪个水位）", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seed(vault)
    expect(runExport(vault, dir).headSeq).toBe(0) // 本测试没写 changelog
    vault.close()
  })
})

describe("★ 时间：原串与权威值同时给出", () => {
  it("每条消息都有 createTime 与 timestampMs", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seed(vault)
    runExport(vault, dir)

    for (const message of messageData(dir)) {
      expect(typeof message.createTime).toBe("string")
      expect(typeof message.timestampMs).toBe("number")
    }
    vault.close()
  })

  it("timestampMs 与库里的 sent_at 完全一致（是权威值，不是再算一遍）", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seed(vault)
    runExport(vault, dir)

    const messages = new MessageRepository(vault.db)
    for (const exported of messageData(dir)) {
      const stored = messages.findByExternalId("dingtalk", exported.openMessageId)
      expect(exported.timestampMs).toBe(stored?.sentAt)
    }
    vault.close()
  })

  /**
   * ★ `createTime` 必须**带时区偏移** —— 这条防的是一个实测过的静默 8 小时偏差。
   *
   * 上游 `to_unix_ms` 对 naive 串（`"2026-07-28 10:53:49"`）会补 **UTC**，
   * 而我们的时间是 DWS 的 +08:00 本地时。实测他们算出 1785236029000 而真值是
   * 1785207229000 —— 差 8 小时，**且不报错**：图谱的时间维度整体平移，
   * timeline 与社区演化跟着错，一处都不会红。
   *
   * 所以断言的不是"串长什么样"，而是**这个串没有歧义**：
   * 用不带时区假设的 `Date.parse` 解析它，必须等于权威值。
   * naive 串在 `TZ=UTC` 的机器上过不了这一关 —— 那正是要拦的东西。
   */
  it("★ createTime 带时区偏移：Date.parse 直接解析就等于 timestampMs", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seed(vault)
    runExport(vault, dir)

    const first = messageData(dir)[0]
    expect(first?.createTime).toBe("2026-07-28T10:53:49+08:00")
    // Date.parse 对带偏移的串不看运行环境时区 —— 这就是"无歧义"的可执行定义
    expect(Date.parse(first?.createTime ?? "")).toBe(first?.timestampMs)
    // 同一个串仍然是 +08 的 10:53:49（没有把时间本身改掉）
    expect(parseDwsLocalTime((first?.createTime ?? "").slice(0, 19))).toBe(first?.timestampMs)
    vault.close()
  })

  /**
   * 反面：串里**必须**有偏移。
   *
   * 上一条用 `Date.parse` 相等来表达"无歧义"，但在 +08 的开发机上，
   * naive 串也会碰巧相等 —— 那条断言在这台机器上是过不了关的。
   * 所以再显式钉一次形状：没有偏移就是回归。
   */
  it("createTime 形状里必须含 +08:00（naive 串在 +08 机器上会假绿）", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seed(vault)
    runExport(vault, dir)

    for (const message of messageData(dir)) {
      expect(message.createTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/)
    }
    vault.close()
  })

  it("跨时区导出结果一致（timestampMs 不随运行环境漂移）", () => {
    const original = process.env["TZ"]
    try {
      const stamps: number[] = []
      for (const tz of ["UTC", "Asia/Shanghai", "America/New_York"]) {
        process.env["TZ"] = tz
        const vault = openTestVault()
        const dir = tempDir()
        seed(vault)
        runExport(vault, dir)
        stamps.push(messageData(dir)[0]?.timestampMs ?? 0)
        vault.close()
      }
      expect(new Set(stamps).size).toBe(1)
    } finally {
      if (original === undefined) delete process.env["TZ"]
      else process.env["TZ"] = original
    }
  })
})

describe("字段映射", () => {
  it("发送者用外部 ID + 显示名，与我们库里一致", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seed(vault)
    runExport(vault, dir)
    const first = messageData(dir)[0]
    expect(first?.senderOpenDingTalkId).toBe("DeMINE")
    expect(first?.sender).toBe("小周")
    vault.close()
  })

  it("引用关系保留（他们用它建回复链）", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seed(vault)
    runExport(vault, dir)
    const second = messageData(dir)[1]
    expect(second?.quotedMessage).toEqual({ openMessageId: "msg-1" })
    vault.close()
  })

  it("isSelf 透出（便于他们区分「我说的」与「别人说的」）", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seed(vault)
    runExport(vault, dir)
    const data = messageData(dir)
    expect(data[0]?.isSelf).toBe(true)
    expect(data[1]?.isSelf).toBe(false)
    vault.close()
  })

  it("空内容的消息不导出（loader 会丢掉它们，写出去只是噪声）", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seed(vault)
    new MessageRepository(vault.db).upsertMany([
      {
        id: "m-empty",
        channelId: "dingtalk",
        conversationId: "conv-1",
        externalId: "msg-empty",
        contentText: "",
        sentAt: START,
        direction: "inbound",
        createdAt: START,
      },
    ])
    runExport(vault, dir)
    expect(messageData(dir).map((m) => m.openMessageId)).toEqual(["msg-1", "msg-2"])
    vault.close()
  })
})

describe("★ 媒体作为 resource 导出（一期只有引用，没有字节）", () => {
  it("resources.jsonl 里有 media 行，且 refs 指回那条 record", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seed(vault)
    runExport(vault, dir)

    const source = readSource(dir, "chat")
    expect(source.resources).toHaveLength(1)
    const asset = source.resources[0]!
    expect(asset["kind"]).toBe("image")
    // ★ local_path 为 null = 未下载字节。让"有资源但没取到"与"没有资源"可区分
    expect(asset["local_path"]).toBeNull()
    expect((asset["data"] as { downloaded: boolean }).downloaded).toBe(false)
    // refs 指回消息 record，对方据此知道这张图属于哪条消息
    const refs = asset["refs"] as { type: string; id: string }[]
    expect(refs[0]?.type).toBe("record")
    const recordIds = new Set(source.records.map((rec) => rec["id"]))
    expect(recordIds.has(refs[0]?.id)).toBe(true)
    vault.close()
  })
})

describe("★ 听记导出（minutes source）", () => {
  it("会议是 meeting scope，start_time 给数字（绕开 strptime 的时区问题）", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seedMinutes(vault.db)
    runExport(vault, dir)

    const source = readSource(dir, "minutes")
    const scope = source.scopes.find((s) => s["type"] === "meeting")
    const data = scope?.["data"] as { title: string; start_time: number; duration_sec: number }
    expect(data.title).toBe("连接器授权策略讨论")
    // 数字 epoch ms → to_unix_ms 原样返回，不走 strptime
    expect(typeof data.start_time).toBe("number")
    expect(data.start_time).toBe(1_785_079_649_000)
    expect(data.duration_sec).toBe(1224)
    vault.close()
  })

  it("摘要是 document_unit / minutes_summary", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seedMinutes(vault.db)
    runExport(vault, dir)

    const summary = readSource(dir, "minutes").records.find(
      (rec) => (rec["data"] as { kind?: string }).kind === "minutes_summary",
    )
    expect(summary?.["type"]).toBe("document_unit")
    expect((summary?.["data"] as { text: string }).text).toContain("会议背景")
    vault.close()
  })

  /**
   * ★ 转写必须给 `segments`，不能只给 `text`。
   *
   * 上游 minutes_loader 的注释明确写了：flattened `data.text` 对
   * transcription_page **是坏的**（只剩 `[<ms>]` 标记与空发言人行），
   * 所以它从 `data.segments`（`{nickName, paragraph}`）重建。
   * 只给 text 的话对方拿到的是一堆噪声 —— 而那看起来像"转写质量差"。
   */
  it("★ 转写给 segments[{nickName, paragraph}]，且截断状态可见", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seedMinutes(vault.db)
    runExport(vault, dir)

    const page = readSource(dir, "minutes").records.find(
      (rec) => (rec["data"] as { kind?: string }).kind === "minutes_transcription_page",
    )
    const data = page?.["data"] as {
      segments: { nickName: string; paragraph: string }[]
      page_index: number
      has_next: boolean
    }
    expect(data.segments).toHaveLength(2)
    expect(data.segments[0]).toEqual({ nickName: "小孙", paragraph: "比如说我这是可以加的。" })
    expect(data.page_index).toBe(0)
    // 一期只取第一页 → 截断必须在数据里可见
    expect(data.has_next).toBe(true)
    vault.close()
  })

  it("关键词作为 generic_record 导出", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seedMinutes(vault.db)
    runExport(vault, dir)

    const keywords = readSource(dir, "minutes").records.find(
      (rec) => (rec["data"] as { kind?: string }).kind === "minutes_keywords",
    )
    expect(keywords?.["type"]).toBe("generic_record")
    expect((keywords?.["data"] as { keywords: string[] }).keywords).toContain("连接器管理")
    vault.close()
  })

  it("没有听记时 minutes/ 仍写出空的四件套（对方 loader 会 no-op，不报错）", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seed(vault)
    const result = runExport(vault, dir)
    expect(result.totalMinutes).toBe(0)
    expect(existsSync(join(dir, "minutes", "records.jsonl"))).toBe(true)
    expect(readSource(dir, "minutes").records).toHaveLength(0)
    vault.close()
  })

  /**
   * ★★ 抽干后的多页转写合并成**一条** `page_index: 0` 的 record。
   *
   * 渠道层把多页拼成一个 `paragraphList`（见 dingtalk/minutes.ts 的 `body`）。
   * 上游 `minutes_loader.py` 拿到多页本来也是按 page_index 排序再 join 才切
   * chunk —— 所以"一条含全部段落"与"N 条各含一页"在图谱侧等价。
   */
  it("★ 抽干后的多页转写：全部段落都在一条 record 里", () => {
    const vault = openTestVault()
    const dir = tempDir()
    new MinutesRepository(vault.db).upsertMany([
      {
        id: "min-multi",
        channelId: "dingtalk",
        externalId: "uuid-multi",
        title: "长会",
        startedAt: 1_785_079_649_000,
        durationSec: 7200,
        summaryText: "摘要",
        // 三页抽干后的形状：pages=3、hasNext=false、段落是三页拼接
        transcriptJson: JSON.stringify({
          hasNext: false,
          pages: 3,
          paragraphList: [
            { nickName: "小孙", paragraph: "第一页第一句。" },
            { nickName: "小王", paragraph: "第一页第二句。" },
            { nickName: "小孙", paragraph: "第二页。" },
            { nickName: "小李", paragraph: "第三页。" },
          ],
        }),
        transcriptPages: 3,
        transcriptTruncated: false,
        fetchedAt: START,
      },
    ])
    runExport(vault, dir)

    const pages = readSource(dir, "minutes").records.filter(
      (rec) => (rec["data"] as { kind?: string }).kind === "minutes_transcription_page",
    )
    // 一条 record，含全部四段
    expect(pages).toHaveLength(1)
    const data = pages[0]?.["data"] as {
      segments: { nickName: string; paragraph: string }[]
      has_next: boolean
    }
    expect(data.segments).toHaveLength(4)
    expect(data.segments[3]).toEqual({ nickName: "小李", paragraph: "第三页。" })
    // 抽干了 → 不是截断
    expect(data.has_next).toBe(false)
    vault.close()
  })
})

/**
 * ★★ 听记导出**也要**按时间窗过滤。
 *
 * 从前 `materializeMinutes` 的 SQL 没有 WHERE，而 `readMessages` 那侧一直有
 * `sent_at >= since` —— 两个口径不一致的后果：用户把范围改小之后聊天不再
 * 进图谱，而**听记照旧全量进**。那与"选了没用"是同一类问题。
 */
describe("★★ 听记导出遵守时间窗", () => {
  /** 两场会：一场在窗内、一场更早。 */
  function seedTwoMinutes(vault: TestVault) {
    const inWindow = parseDwsLocalTime("2026-07-20 10:00:00")
    const before = parseDwsLocalTime("2026-05-01 10:00:00")
    new MinutesRepository(vault.db).upsertMany([
      {
        id: "min-in",
        channelId: "dingtalk",
        externalId: "uuid-in",
        title: "窗内的会",
        startedAt: inWindow,
        durationSec: 600,
        summaryText: "窗内摘要",
        fetchedAt: START,
      },
      {
        id: "min-before",
        channelId: "dingtalk",
        externalId: "uuid-before",
        title: "更早的会",
        startedAt: before,
        durationSec: 600,
        summaryText: "更早的摘要",
        fetchedAt: START,
      },
    ])
    return { inWindow, before }
  }

  /** 导出的会议标题。 */
  function meetingTitles(exportDir: string): string[] {
    return readSource(exportDir, "minutes")
      .scopes.filter((s) => s["type"] === "meeting")
      .map((s) => (s["data"] as { title: string | null }).title ?? "")
  }

  it("★★ 范围之前的会议不导出（与聊天那侧同一个口径）", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seedTwoMinutes(vault)
    new ExportMaterializer({
      db: vault.db,
      clock: new ManualClock(START),
      exportDir: dir,
      formatTime: formatDwsIsoTime,
      scope: { since: parseDwsLocalTime("2026-07-01 00:00:00") },
    }).run()

    const titles = meetingTitles(dir)
    expect(titles).toContain("窗内的会")
    expect(titles).not.toContain("更早的会")
    vault.close()
  })

  it("★ 上界也卡（选了历史区间的用户不该收到今天的会）", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seedTwoMinutes(vault)
    new ExportMaterializer({
      db: vault.db,
      clock: new ManualClock(START),
      exportDir: dir,
      formatTime: formatDwsIsoTime,
      // 只要 5 月那场
      scope: { until: parseDwsLocalTime("2026-06-01 00:00:00") },
    }).run()

    const titles = meetingTitles(dir)
    expect(titles).toContain("更早的会")
    expect(titles).not.toContain("窗内的会")
    vault.close()
  })

  it("没配时间窗 → 两场都导出（兼容没配范围的老库）", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seedTwoMinutes(vault)
    runExport(vault, dir)
    expect(meetingTitles(dir)).toHaveLength(2)
    vault.close()
  })

  /**
   * ★ 会话白名单**不该**影响听记。
   *
   * 会议不属于任何会话（`minutes` 表没有会话外键），拿会话 external_id
   * 去过滤它在语义上不成立。误用的表现是"勾了几个群之后听记全没了"。
   */
  it("★ 会话白名单不影响听记（会议不属于任何会话）", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seedTwoMinutes(vault)
    new ExportMaterializer({
      db: vault.db,
      clock: new ManualClock(START),
      exportDir: dir,
      formatTime: formatDwsIsoTime,
      // 一个都不勾（空白名单 = 零个会话）—— 听记仍该照常导出
      scope: { conversationExternalIds: [] },
    }).run()

    expect(meetingTitles(dir)).toHaveLength(2)
    vault.close()
  })

  /**
   * ★ `started_at IS NULL` 的会议在**有时间窗**时被排除。
   *
   * 时间未知的会议无法判断在不在窗内，而"猜它在窗内"会把用户排除掉的
   * 数据放进图谱。没配窗时它照常导出。
   */
  it("★ 时间未知的会议：有窗时排除，无窗时导出", () => {
    const vault = openTestVault()
    const dir = tempDir()
    new MinutesRepository(vault.db).upsertMany([
      {
        id: "min-notime",
        channelId: "dingtalk",
        externalId: "uuid-notime",
        title: "时间未知的会",
        startedAt: null,
        summaryText: "摘要",
        fetchedAt: START,
      },
    ])

    // 无窗 → 导出
    runExport(vault, dir)
    expect(meetingTitles(dir)).toContain("时间未知的会")

    // 有窗 → 排除
    const dir2 = tempDir()
    new ExportMaterializer({
      db: vault.db,
      clock: new ManualClock(START),
      exportDir: dir2,
      formatTime: formatDwsIsoTime,
      scope: { since: parseDwsLocalTime("2026-07-01 00:00:00") },
    }).run()
    expect(meetingTitles(dir2)).not.toContain("时间未知的会")
    vault.close()
  })
})

/**
 * ★★ 导出范围 = 用户在引导里选的范围。
 *
 * 这一组锁的是那个"选了没用"的真 bug：kl-graph 曾是全库全时段导出，
 * 白名单与时间窗一处都没读。三条各锁一个维度 —— 会话白名单、时间窗、
 * 排除 `origin='agent'`（数字人自己发的话不能再进图谱蒸一遍）。
 */
describe("★★ 导出遵守 scope（白名单 / 时间窗 / 排除 agent）", () => {
  /** 造两个会话，各一条对方消息；再给会话 1 加一条**数字人自己发的**。 */
  function seedTwo(vault: TestVault) {
    const convs = new ConversationRepository(vault.db)
    convs.upsert({
      id: "conv-1",
      channelId: "dingtalk",
      externalId: "cid-keep",
      type: "group",
      title: "要保留的群",
      memberCount: 5,
      createdAt: START,
    })
    convs.upsert({
      id: "conv-2",
      channelId: "dingtalk",
      externalId: "cid-drop",
      type: "group",
      title: "没勾的群",
      memberCount: 5,
      createdAt: START,
    })
    new MessageRepository(vault.db).upsertMany([
      {
        id: "k-old",
        channelId: "dingtalk",
        conversationId: "conv-1",
        externalId: "msg-k-old",
        senderExternalId: "DeLI",
        senderDisplayName: "小李",
        contentText: "这条在范围之前",
        sentAt: parseDwsLocalTime("2026-06-01 09:00:00"),
        direction: "inbound",
        isSelf: false,
        createdAt: START,
      },
      {
        id: "k-in",
        channelId: "dingtalk",
        conversationId: "conv-1",
        externalId: "msg-k-in",
        senderExternalId: "DeLI",
        senderDisplayName: "小李",
        contentText: "这条在范围内",
        sentAt: parseDwsLocalTime("2026-07-28 10:00:00"),
        direction: "inbound",
        isSelf: false,
        createdAt: START,
      },
      {
        id: "k-agent",
        channelId: "dingtalk",
        conversationId: "conv-1",
        externalId: "msg-k-agent",
        senderExternalId: "DeMINE",
        senderDisplayName: "小周",
        contentText: "这条是数字人替我发的",
        sentAt: parseDwsLocalTime("2026-07-28 10:05:00"),
        direction: "outbound",
        isSelf: true,
        origin: "agent",
        createdAt: START,
      },
      {
        id: "d-in",
        channelId: "dingtalk",
        conversationId: "conv-2",
        externalId: "msg-d-in",
        senderExternalId: "DeWANG",
        senderDisplayName: "小王",
        contentText: "没勾的群里的消息",
        sentAt: parseDwsLocalTime("2026-07-28 10:00:00"),
        direction: "inbound",
        isSelf: false,
        createdAt: START,
      },
    ])
  }

  function contents(dir: string): string[] {
    return readSource(dir, "chat")
      .records.filter((r) => r["type"] === "message")
      .map((r) => (r["data"] as { content: string }).content)
  }

  it("★ 会话白名单（external_id）：没勾的群一条都不导出", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seedTwo(vault)
    new ExportMaterializer({
      db: vault.db,
      clock: new ManualClock(START),
      exportDir: dir,
      formatTime: formatDwsIsoTime,
      scope: { conversationExternalIds: ["cid-keep"] },
    }).run()
    const c = contents(dir)
    expect(c).toContain("这条在范围内")
    expect(c).not.toContain("没勾的群里的消息")
    vault.close()
  })

  it("★ 时间窗：范围之前的消息不导出", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seedTwo(vault)
    new ExportMaterializer({
      db: vault.db,
      clock: new ManualClock(START),
      exportDir: dir,
      formatTime: formatDwsIsoTime,
      scope: { since: parseDwsLocalTime("2026-07-01 00:00:00") },
    }).run()
    const c = contents(dir)
    expect(c).toContain("这条在范围内")
    expect(c).not.toContain("这条在范围之前")
    vault.close()
  })

  it("★ 排除数字人自己发的（origin='agent'）—— 否则会被当本人语料再蒸一遍", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seedTwo(vault)
    // 不给 scope 也要排 agent（这是无条件的）
    runExport(vault, dir)
    const c = contents(dir)
    expect(c).not.toContain("这条是数字人替我发的")
    expect(c).toContain("这条在范围内")
    vault.close()
  })

  it("★ 不给 scope 时导全库（兼容没配范围的老库）", () => {
    const vault = openTestVault()
    const dir = tempDir()
    seedTwo(vault)
    runExport(vault, dir)
    const c = contents(dir)
    expect(c).toContain("这条在范围内")
    expect(c).toContain("没勾的群里的消息")
    expect(c).toContain("这条在范围之前")
    vault.close()
  })
})
