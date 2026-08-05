/**
 * 听记（minutes）解析。
 *
 * fixture 是从真实响应抄下来的（见 tests/fixtures/dingtalk-real-payloads.ts），
 * 覆盖三个实测特征：
 * · 信封是 `{arguments, errorCode, errorMsg, result, success}`（比 chat 多两个字段）；
 * · `durationMicros` 单位是**微秒**（1224340000 ≈ 20.4 分钟）；
 * · `list` 只给元信息，正文要再调 `get summary` / `get transcription`。
 */
import { describe, expect, it } from "vitest"
import { parseMinutesList, parseMinutesSummary } from "@mycontext/channels"
import { REAL_MINUTES_LIST, REAL_MINUTES_SUMMARY } from "../../fixtures/dingtalk-real-payloads.js"

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
