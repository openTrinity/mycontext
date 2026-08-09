/**
 * 听记（minutes）解析与**分页抽干**。
 *
 * fixture 是从真实响应抄下来的（见 tests/fixtures/dingtalk-real-payloads.ts），
 * 覆盖三个实测特征：
 * · 信封是 `{arguments, errorCode, errorMsg, result, success}`（比 chat 多两个字段）；
 * · `durationMicros` 单位是**微秒**（1224340000 ≈ 20.4 分钟）；
 * · `list` 只给元信息，正文要再调 `get summary` / `get transcription`。
 *
 * ## ★★ 下半个文件锁的是「抽干」这件事
 *
 * 首版两条分页**都只取第一页**，而两者的表现完全不同：
 * · 列表只取首页 → 第 51 场之前的会议永远采不到（那一半在采集服务侧测，
 *   见 `tests/unit/desktop/ingest-window-queue.test.ts`）；
 * · 转写只取第一页 → 一场长会只有开头几分钟，而那看起来像"这场会就这么短"。
 *
 * 抽干循环的每一个停止条件都单独锁：少一条就是一类病态
 * （原地打转 / 无界增长 / 截断不可见）。
 */
import { describe, expect, it } from "vitest"
import {
  createDingTalkMinutes,
  parseMinutesList,
  parseMinutesSummary,
  parseMinutesTranscriptionPage,
} from "@mycontext/channels"
import { REAL_MINUTES_LIST, REAL_MINUTES_SUMMARY } from "../../fixtures/dingtalk-real-payloads.js"
import {
  REAL_MINUTES_TRANSCRIPTION_LAST_PAGE,
  REAL_MINUTES_TRANSCRIPTION_MIDDLE_PAGE,
} from "../../fixtures/dingtalk-real-payloads.js"

describe("听记列表解析", () => {
  it("带信封的响应能解析（与 chat 一样的坑）", () => {
    const page = parseMinutesList(REAL_MINUTES_LIST)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.externalId).toBe("6d696e75746573756964305f6578616d706c655f30303031")
    expect(page.items[0]?.title).toBe("连接器授权策略讨论")
  })

  it("已剥信封的输入也能解析（正常路径 —— DwsCli.json 已经剥了）", () => {
    const page = parseMinutesList(REAL_MINUTES_LIST.result)
    expect(page.items).toHaveLength(1)
  })

  it("★ durationMicros 是微秒 → 秒（当毫秒读会把 20 分钟记成 14 天）", () => {
    const page = parseMinutesList(REAL_MINUTES_LIST)
    // 1224340000 微秒 = 1224.34 秒 ≈ 20.4 分钟
    expect(page.items[0]?.durationSec).toBe(1224)
  })

  it("startTime 归一成 unix ms", () => {
    const page = parseMinutesList(REAL_MINUTES_LIST)
    expect(page.items[0]?.startedAt).toBe(1785079649000)
  })

  it("翻页：hasMore 与 nextToken", () => {
    const page = parseMinutesList(REAL_MINUTES_LIST)
    expect(page.hasMore).toBe(true)
    expect(page.nextToken).toBe("315f305f305f31385f31")
  })

  it("发起人、关键词、分享链接进 speakersJson（省一次调用）", () => {
    const page = parseMinutesList(REAL_MINUTES_LIST)
    const speakers = JSON.parse(page.items[0]!.speakersJson!) as {
      owner: { name: string }
      keywords: { keywords: string[] }
      shareUrl: string
    }
    expect(speakers.owner.name).toBe("云舟")
    expect(speakers.keywords.keywords).toContain("连接器管理")
    expect(speakers.shareUrl).toContain("example.invalid")
  })

  it("list 阶段正文为空（要二次调用才有）", () => {
    const page = parseMinutesList(REAL_MINUTES_LIST)
    expect(page.items[0]?.summaryText).toBeNull()
    expect(page.items[0]?.transcriptJson).toBeNull()
  })

  it("缺 uuid 的条目跳过（没它既存不进也取不了正文）", () => {
    const page = parseMinutesList({
      success: true,
      result: { itemList: [{ title: "没有 uuid" }, { uuid: "u1", title: "有" }] },
    })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.externalId).toBe("u1")
  })

  it("空响应 / 非对象不崩", () => {
    expect(parseMinutesList(null).items).toEqual([])
    expect(parseMinutesList({}).items).toEqual([])
    expect(parseMinutesList({ success: true, result: {} }).items).toEqual([])
    expect(parseMinutesList("nonsense").items).toEqual([])
  })
})

describe("听记摘要解析", () => {
  it("取 fullSummary（markdown 正文）", () => {
    const summary = parseMinutesSummary(REAL_MINUTES_SUMMARY)
    expect(summary).toContain("连接器授权策略讨论")
    expect(summary).toContain("参与人")
  })

  it("已剥信封的输入也能解析", () => {
    expect(parseMinutesSummary(REAL_MINUTES_SUMMARY.result)).toContain("会议背景")
  })

  it("缺正文时返回 null（不是空串 —— 让「没抓到」与「真的空」可区分）", () => {
    expect(parseMinutesSummary({ success: true, result: {} })).toBeNull()
    expect(parseMinutesSummary(null)).toBeNull()
  })
})

describe("转写单页解析", () => {
  it("带信封与已剥信封两种输入都能解析", () => {
    const inner = {
      hasNext: true,
      nextToken: "tok-2",
      paragraphList: [{ nickName: "小孙", paragraph: "先这样。" }],
    }
    for (const payload of [inner, { success: true, result: inner }]) {
      const page = parseMinutesTranscriptionPage(payload)
      expect(page.paragraphs).toHaveLength(1)
      expect(page.hasNext).toBe(true)
      expect(page.nextToken).toBe("tok-2")
    }
  })

  /**
   * ★★ 结束信号的字段名是 `hasNext`，**不是** list 那条的 `hasMore`。
   *
   * 同一个二进制的两个子命令用了两个名字（实测）。认错的表现是恒为 false
   * → 抽干循环第一页就停 → 与首版的行为一模一样，而且不报错。
   */
  it("★ 认 hasNext 而不是 hasMore（两个子命令字段名不同）", () => {
    expect(parseMinutesTranscriptionPage({ hasNext: true, paragraphList: [] }).hasNext).toBe(true)
    // 只给 hasMore 时**不该**被当成"还有下一页"
    expect(parseMinutesTranscriptionPage({ hasMore: true, paragraphList: [] }).hasNext).toBe(false)
  })

  it("空响应 / 非对象不崩，且给出「没有下一页」", () => {
    for (const payload of [null, {}, "nonsense", 42]) {
      const page = parseMinutesTranscriptionPage(payload)
      expect(page.paragraphs).toEqual([])
      expect(page.hasNext).toBe(false)
      expect(page.nextToken).toBeNull()
    }
  })

  /**
   * ★★ 拿**真实响应** fixture 验中间页与收尾页的区别。
   *
   * 上面那些用例造的是简化形状；这两条锁的是真实形态里那个关键差异：
   * 收尾页**没有** `hasNext` 与 `nextToken` 两个键（不是 `false` / 空串）。
   */
  it("★ 真实中间页：hasNext=true + 非空游标", () => {
    const page = parseMinutesTranscriptionPage(REAL_MINUTES_TRANSCRIPTION_MIDDLE_PAGE)
    expect(page.paragraphs).toHaveLength(2)
    expect(page.hasNext).toBe(true)
    expect(page.nextToken).toBe("315f325f305f35305f32")
  })

  it("★★ 真实收尾页：两个键都不存在 → 判成抽干（不是「还有」）", () => {
    const page = parseMinutesTranscriptionPage(REAL_MINUTES_TRANSCRIPTION_LAST_PAGE)
    expect(page.paragraphs).toHaveLength(1)
    // 这一条就是 `=== true` 与 `!== false` 的分水岭
    expect(page.hasNext).toBe(false)
    expect(page.nextToken).toBeNull()
  })
})

/**
 * ★★ 转写抽干。
 *
 * 假 cli 按**调用序号**返回不同响应 —— 与 `documents.test.ts` 那个
 * 按命令前缀分派的 fakeCli 不同：这里要测的正是"同一条命令被调多次"。
 */
describe("★★ 转写抽干分页", () => {
  /** 造一个按调用序号返回预置响应的假 cli；记下每次的 args。 */
  function pagedCli(pages: readonly unknown[], calls: string[][] = []) {
    let transcriptionCalls = 0
    return {
      calls,
      json: <T>(args: readonly string[]): Promise<T> => {
        calls.push([...args])
        if (args.includes("summary")) {
          return Promise.resolve({ fullSummary: "摘要正文" } as T)
        }
        const index = transcriptionCalls
        transcriptionCalls += 1
        // 超出预置页数时继续返回最后一页（模拟"服务端一直说还有"）
        return Promise.resolve((pages[Math.min(index, pages.length - 1)] ?? {}) as T)
      },
    }
  }

  /** 造一页转写。`n` 段、每段的正文长度可控（用于撞字符预算）。 */
  function page(n: number, hasNext: boolean, token: string | null, fill = "话"): unknown {
    return {
      hasNext,
      ...(token === null ? {} : { nextToken: token }),
      paragraphList: Array.from({ length: n }, (_, i) => ({
        nickName: `发言人${String(i)}`,
        paragraph: fill,
      })),
    }
  }

  it("★ 三页抽干：段落是三页拼接，hasNext 落回 false", async () => {
    const cli = pagedCli([page(2, true, "t1"), page(3, true, "t2"), page(1, false, null)])
    const body = await createDingTalkMinutes(cli).body("uuid-1")

    const transcript = JSON.parse(body.transcriptJson as string) as {
      hasNext: boolean
      pages: number
      paragraphList: unknown[]
    }
    expect(transcript.paragraphList).toHaveLength(6)
    expect(transcript.pages).toBe(3)
    // 抽干了 → 不是截断
    expect(transcript.hasNext).toBe(false)
    expect(body.transcriptPages).toBe(3)
    expect(body.transcriptTruncated).toBe(false)
  })

  it("★ 首页起不传 --cursor，之后每页传上一页的 nextToken", async () => {
    const calls: string[][] = []
    const cli = pagedCli([page(1, true, "t1"), page(1, false, null)], calls)
    await createDingTalkMinutes(cli).body("uuid-1")

    const transcription = calls.filter((args) => args.includes("transcription"))
    expect(transcription).toHaveLength(2)
    expect(transcription[0]).not.toContain("--cursor")
    expect(transcription[1]).toContain("--cursor")
    expect(transcription[1]?.[transcription[1].indexOf("--cursor") + 1]).toBe("t1")
  })

  /**
   * ★★ 撞页数上限时 `hasNext` **必须留 true** —— 那是截断唯一的出口。
   *
   * 落成 false 的话下游会把一段被砍掉的转写当完整的用
   * （"这场会没提过 X" 那类结论就是错的），而且不报错。
   */
  it("★★ 一直 hasNext=true → 停在页数上限，且截断可见", async () => {
    // 永远说"还有"，且每页给一个**新**游标（所以不会被"游标没前进"提前挡住）
    let token = 0
    const cli = {
      json: <T>(args: readonly string[]): Promise<T> => {
        if (args.includes("summary")) return Promise.resolve({ fullSummary: "s" } as T)
        token += 1
        return Promise.resolve(page(1, true, `t${String(token)}`) as T)
      },
    }
    const body = await createDingTalkMinutes(cli).body("uuid-1")

    // MAX_TRANSCRIPT_PAGES = 40（渠道层常量，不导出 —— 这里锁的是行为）
    expect(body.transcriptPages).toBe(40)
    expect(body.transcriptTruncated).toBe(true)
    const transcript = JSON.parse(body.transcriptJson as string) as { hasNext: boolean }
    expect(transcript.hasNext, "截断必须在数据里可见").toBe(true)
  })

  /**
   * ★★ 页数与字符两条上限必须**协调** —— 上一版它们互相矛盾。
   *
   * 实测每页恒 50 段 ≈ 26000 字符。上一版的 200k 预算只够 7-8 页，
   * 而页数上限写着 20 —— 字符那条永远先触发，页数上限根本用不上，
   * 且实测的三场会（18/21/25+ 页）全部会被砍掉一半以上。
   *
   * 现在 40 页 × 30k = 1.2M：**正常规模下页数先到**，字符那条只在
   * "单页异常大"时兜底。这条用例锁的正是"正常页大小下走不到字符预算"。
   */
  it("★★ 实测页大小（约 26k/页）下，40 页都不该撞字符预算", async () => {
    let token = 0
    const cli = {
      json: <T>(args: readonly string[]): Promise<T> => {
        if (args.includes("summary")) return Promise.resolve({ fullSummary: "s" } as T)
        token += 1
        // 50 段 × 约 520 字 ≈ 26k 字符/页（实测均值）
        return Promise.resolve(page(50, true, `t${String(token)}`, "话".repeat(520)) as T)
      },
    }
    const body = await createDingTalkMinutes(cli).body("uuid-1")

    // 走到页数上限而不是被字符预算提前砍掉
    expect(body.transcriptPages).toBe(40)
    // 40 页 × 50 段 = 2000 段（远超实测最长会的 1250 段）
    const transcript = JSON.parse(body.transcriptJson as string) as { paragraphList: unknown[] }
    expect(transcript.paragraphList).toHaveLength(2000)
  })

  /**
   * ★ 实测规模的会议（18-21 页）**能完整抽干**，不被任何上限砍。
   *
   * 这一条是上一版真实的回归：200k 预算下这场会会停在第 8 页。
   */
  it("★★ 实测规模的长会（21 页 × 26k）能完整抽干", async () => {
    let token = 0
    const cli = {
      json: <T>(args: readonly string[]): Promise<T> => {
        if (args.includes("summary")) return Promise.resolve({ fullSummary: "s" } as T)
        token += 1
        // 第 21 页收尾：★ 实测最后一页的 hasNext 是 **undefined**（键不出现）
        const last = token >= 21
        const p = page(50, !last, last ? null : `t${String(token)}`, "话".repeat(520)) as Record<
          string,
          unknown
        >
        if (last) delete p["hasNext"]
        return Promise.resolve(p as T)
      },
    }
    const body = await createDingTalkMinutes(cli).body("uuid-1")

    expect(body.transcriptPages).toBe(21)
    // ★ 抽干了 —— 不是截断（这是上一版会失败的那条）
    expect(body.transcriptTruncated).toBe(false)
    const transcript = JSON.parse(body.transcriptJson as string) as { paragraphList: unknown[] }
    expect(transcript.paragraphList).toHaveLength(1050)
  })

  it("★★ 撞字符预算也停，并且同样标成截断", async () => {
    // 每页 200k 字符（异常大的单页）→ 6 页就超过 1.2M 的预算
    let token = 0
    const cli = {
      json: <T>(args: readonly string[]): Promise<T> => {
        if (args.includes("summary")) return Promise.resolve({ fullSummary: "s" } as T)
        token += 1
        return Promise.resolve(page(1, true, `t${String(token)}`, "字".repeat(200_000)) as T)
      },
    }
    const body = await createDingTalkMinutes(cli).body("uuid-1")

    // 页数没到 40 就停了 —— 是字符预算挡住的（它兜的正是"单页异常大"）
    expect(body.transcriptPages).toBeGreaterThan(0)
    expect(body.transcriptPages).toBeLessThan(40)
    expect(body.transcriptTruncated).toBe(true)
  })

  /**
   * ★ 游标没前进 → 停。
   *
   * 不停的话下一轮参数完全相同，必然死循环（把预算烧光换回同一页数据）。
   * `conversations.ts` 的群列表循环踩过同一个坑。
   */
  it("★ nextToken 没前进 → 停（否则原地打转烧光预算）", async () => {
    let calls = 0
    const cli = {
      json: <T>(args: readonly string[]): Promise<T> => {
        if (args.includes("summary")) return Promise.resolve({ fullSummary: "s" } as T)
        calls += 1
        // 永远回同一个游标
        return Promise.resolve(page(1, true, "same-token") as T)
      },
    }
    const body = await createDingTalkMinutes(cli).body("uuid-1")

    // 第一页拿到 same-token → 第二页也回 same-token → 停
    expect(calls).toBe(2)
    expect(body.transcriptTruncated).toBe(true)
  })

  it("★ 说还有但没给游标 → 停，且仍标成截断（翻不动 ≠ 抽干了）", async () => {
    const cli = pagedCli([page(1, true, null)])
    const body = await createDingTalkMinutes(cli).body("uuid-1")
    expect(body.transcriptPages).toBe(1)
    expect(body.transcriptTruncated).toBe(true)
  })

  /**
   * ★ 调用成功但没有段落 → 存**空壳**，不是 null。
   *
   * `listMissingBody` 靠 `transcript_json IS NULL` 挑工作队列 ——
   * 存 null 会让这场会议每轮都被重新取一遍而结果永远是空。
   * 空壳是一个终态，语义是「这场会没有转写」。
   *
   * ⚠️ 代价（渠道层注释里也记了）：这与"上游响应形状变了"长得一样。
   * 靠 `pages` 与段落数落库来让后者可被发现（一批会议突然全空 = 形状变了）。
   */
  it("★ 没有段落 → 存空壳而不是 null（否则每轮白重取）", async () => {
    const cli = {
      json: <T>(args: readonly string[]): Promise<T> =>
        Promise.resolve((args.includes("summary") ? { fullSummary: "s" } : null) as T),
    }
    const body = await createDingTalkMinutes(cli).body("uuid-1")
    // 命令成功了（跑了一轮），只是没有任何段落
    expect(body.transcriptPages).toBe(1)
    expect(body.transcriptTruncated).toBe(false)
    expect(body.transcriptJson).not.toBeNull()
    const transcript = JSON.parse(body.transcriptJson as string) as { paragraphList: unknown[] }
    expect(transcript.paragraphList).toEqual([])
  })

  /**
   * ★★ 最后一页的 `hasNext` 是 **`undefined`**（键不出现），不是 `false`。
   *
   * 实测（2026-08-09，开源版 v1.0.57）三场长会的收尾页都是
   * `hasNext=undefined nextToken=∅`。判据写成 `!== false` 的话最后一页会被
   * 判成"还有下一页"，于是要靠"没给游标"那条兜底才停 —— 而依赖兜底意味着
   * 每场会都多跑一次注定失败的判断，且哪天上游给了非空尾游标就是死循环。
   */
  it("★★ 收尾页 hasNext 是 undefined（不是 false）也要判成抽干", async () => {
    const cli = {
      json: <T>(args: readonly string[]): Promise<T> => {
        if (args.includes("summary")) return Promise.resolve({ fullSummary: "s" } as T)
        // 实测的收尾形态：既没有 hasNext 键，也没有 nextToken
        return Promise.resolve({
          paragraphList: [{ nickName: "小孙", paragraph: "最后一句。" }],
        } as T)
      },
    }
    const body = await createDingTalkMinutes(cli).body("uuid-1")
    expect(body.transcriptPages).toBe(1)
    // ★ 抽干,不是截断
    expect(body.transcriptTruncated).toBe(false)
  })

  /**
   * ★ `rawPayload` 不再重复存每一页转写的原文。
   *
   * 实测一场会的转写有 18-21 页 / 约 50 万字符。让 `raw_records.payload`
   * 再存一份等于为"可重放"付两倍存储，而那份内容已经在 `transcript_json` 里。
   */
  it("rawPayload 只留摘要原文 + 转写的抽干统计", async () => {
    const cli = pagedCli([page(2, false, null)])
    const body = await createDingTalkMinutes(cli).body("uuid-1")
    const raw = JSON.parse(body.rawPayload) as {
      transcription: { pages: number; hasNext: boolean; paragraphs: number }
    }
    expect(raw.transcription).toEqual({ pages: 1, hasNext: false, paragraphs: 2 })
  })
})

/**
 * ★★ 列表的时间窗 —— **范围合规**的落点。
 *
 * 听记采集从前完全不看用户选的范围。只取首页时这件事被"覆盖面太小"掩盖，
 * 一旦抽干历史就会把用户明确排除掉的时间段整段采回来
 * （CLAUDE.md 第 5 节：那是隐私问题，不是"多采点没坏处"）。
 */
describe("★★ 列表时间窗（--start / --end）", () => {
  function recordingCli(calls: string[][]) {
    return {
      json: <T>(args: readonly string[]): Promise<T> => {
        calls.push([...args])
        return Promise.resolve({ hasMore: false, itemList: [] } as T)
      },
    }
  }

  it("没配范围 → 不传 --start/--end（全量）", async () => {
    const calls: string[][] = []
    await createDingTalkMinutes(recordingCli(calls)).list({})
    expect(calls[0]).not.toContain("--start")
    expect(calls[0]).not.toContain("--end")
  })

  /**
   * ★★ 格式必须是 **ISO-8601 带偏移**。
   *
   * `--help` 示例是 `--start "2026-03-01T00:00:00+08:00"`。喂
   * `formatDwsLocalTime` 那种不带时区的 naive 串（`chat message list-all`
   * 要的格式）会有歧义 —— 表现是时间窗偏 8 小时，而且不报错。
   */
  it("★★ 配了范围 → 传带时区偏移的 ISO 串（不是 naive 串）", async () => {
    const calls: string[][] = []
    // 1785079649000 = 2026-07-25T09:27:29+08:00
    await createDingTalkMinutes(recordingCli(calls)).list({
      since: 1_785_079_649_000,
      until: 1_785_200_000_000,
    })
    const args = calls[0] as string[]
    const start = args[args.indexOf("--start") + 1] as string
    const end = args[args.indexOf("--end") + 1] as string
    // 带偏移：结尾是 +08:00，而 naive 串没有
    expect(start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/)
    expect(end).toMatch(/\+08:00$/)
    // 而且**不是**空格分隔的 naive 形态
    expect(start).not.toContain(" ")
  })

  it("null 与 undefined 同等对待（都是「不限」）", async () => {
    const calls: string[][] = []
    await createDingTalkMinutes(recordingCli(calls)).list({ since: null, until: null })
    expect(calls[0]).not.toContain("--start")
    expect(calls[0]).not.toContain("--end")
  })

  it("首页不传 --cursor，翻页时传", async () => {
    const calls: string[][] = []
    const minutes = createDingTalkMinutes(recordingCli(calls))
    await minutes.list({ cursor: null })
    await minutes.list({ cursor: "tok-1" })
    expect(calls[0]).not.toContain("--cursor")
    expect(calls[1]).toContain("--cursor")
  })
})
