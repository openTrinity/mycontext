/**
 * content 文本抽取（媒体 / @提及）。
 *
 * 这些判据的**依据全部来自实测的 1688 条真实消息**，不是猜的形态：
 * · 200 条 `[图片消息]`，其中带 mediaId 的 164 条 —— 且**没有一条**图片消息缺 mediaId；
 * · 方括号标记里绝大多数是**表情**（`[狗子]` 22 次、`[忍者]` 19、`[地球]` 14…），
 *   所以"有方括号就是媒体"这个判据会让噪声压倒信号；
 * · 524 条含 `@`，形态是 `@真名(花名)`，82 个不同形态；
 * · 消息字段里**没有** msgType / atUsers / mediaId —— 全靠文本。
 */
import { describe, expect, it } from "vitest"
import { extractMedia, extractMentionTexts, mentionsSelf } from "@mycontext/channels"

describe("媒体抽取", () => {
  it("图片：mediaId 以 @ 开头", () => {
    const media = extractMedia(
      "[图片消息](mediaId=@lQLPKG-foZGeBQPNAhDNBnSwy5WPOdO12_8KPMFctT2OAA)这个报错",
    )
    expect(media).toHaveLength(1)
    expect(media[0]).toEqual({
      kind: "image",
      resourceId: "@lQLPKG-foZGeBQPNAhDNBnSwy5WPOdO12_8KPMFctT2OAA",
      resourceKind: "mediaId",
      originalName: null,
    })
  })

  it("图片：mediaId 以 $ 开头（另一种前缀）", () => {
    const media = extractMedia(
      "[图片消息](mediaId=$iwELAqNwbmcDAATRAfQF0QG_BrDRUYuYlWDPdAopn4eV0mwABwAIAAmgCgALAA) 注意：如需下载使用dws chat message download-media命令下载",
    )
    expect(media).toHaveLength(1)
    expect(media[0]?.resourceId.startsWith("$")).toBe(true)
    expect(media[0]?.resourceKind).toBe("mediaId")
  })

  it("文件：抽出 fileId 与文件名", () => {
    const media = extractMedia(
      "[文件] deploy.env fileId: 4lgGw3P8vzw9zZerhgnYx0n585daZ90D 注意：如需下载使用dws drive download命令下载",
    )
    expect(media).toHaveLength(1)
    expect(media[0]).toEqual({
      kind: "file",
      resourceId: "4lgGw3P8vzw9zZerhgnYx0n585daZ90D",
      resourceKind: "fileId",
      originalName: "deploy.env",
    })
  })

  it("★ 表情标记不是媒体（这是判据用 ID 而不用标签的原因）", () => {
    for (const text of [
      "好像只能这样[狗子][忍者]",
      "我也是[一脸苦笑]，那个二验废了",
      "[地球][暗中观察][流鼻血]",
      "点这里[点击查看详情]",
    ]) {
      expect(extractMedia(text)).toEqual([])
    }
  })

  it("一条消息里多个资源都抽出来", () => {
    const media = extractMedia(
      "看这两张[图片消息](mediaId=@aaaAAA111)和[图片消息](mediaId=$bbbBBB222)",
    )
    expect(media.map((m) => m.resourceId)).toEqual(["@aaaAAA111", "$bbbBBB222"])
  })

  it("空内容与 null 不崩", () => {
    expect(extractMedia(null)).toEqual([])
    expect(extractMedia("")).toEqual([])
    expect(extractMedia("纯文本没有任何资源")).toEqual([])
  })
})

describe("@提及抽取", () => {
  it("`@真名(花名)` → 两个名字都收", () => {
    expect(extractMentionTexts("@李明(小李) 这个权重还没开出来么")).toEqual(["李明", "小李"])
  })

  it("真名与花名相同时去重", () => {
    expect(extractMentionTexts("@吴敏(吴敏) 好好好")).toEqual(["吴敏"])
  })

  it("★ 花名里嵌全角括号（实测 `@小郭(林序（青禾）)`）", () => {
    const texts = extractMentionTexts("@小郭(林序（青禾）) 那个模型要开源")
    expect(texts).toContain("小郭")
    // 不能因为内层全角括号就把整条丢掉
    expect(texts.length).toBeGreaterThanOrEqual(1)
  })

  it("没有括号的 @ 也能抽", () => {
    expect(extractMentionTexts("@柏岩 看一下")).toEqual(["柏岩"])
  })

  it("一条消息里多个 @", () => {
    const texts = extractMentionTexts("@陈静(小陈) @赵磊(小赵) 你们看下")
    expect(texts).toContain("陈静")
    expect(texts).toContain("赵磊")
  })

  it("邮箱之类的 @ 不产生噪声干扰判定（抽到了也不会命中本人名字）", () => {
    // 判定用的是"是否命中本人名字集合"，所以抽到 example 无害
    const texts = extractMentionTexts("发到 foo@example.com 就行")
    expect(mentionsSelf(texts, new Set(["王强", "小王", "澄一"]))).toBe(false)
  })

  it("空内容不崩", () => {
    expect(extractMentionTexts(null)).toEqual([])
    expect(extractMentionTexts("")).toEqual([])
  })
})

describe("★ 本人被 @ 的判定", () => {
  const selfNames = new Set(["王强", "小王", "澄一"])

  it("真名命中", () => {
    expect(mentionsSelf(extractMentionTexts("@王强(澄一) 看下"), selfNames)).toBe(true)
  })

  it("花名命中（实测群里显示花名，@ 却用 `@真名(花名)`，两种都要能中）", () => {
    expect(mentionsSelf(extractMentionTexts("@澄一 看下"), selfNames)).toBe(true)
  })

  it("别人被 @ 时不命中", () => {
    expect(mentionsSelf(extractMentionTexts("@吴敏(吴敏) 看下"), selfNames)).toBe(false)
  })

  it("★ 名字集合为空（身份未确认）时一律不命中，而不是匹配一切", () => {
    expect(mentionsSelf(extractMentionTexts("@王强(澄一) 看下"), new Set())).toBe(false)
  })

  it("同名前缀不误命中（`小王杰` ≠ `小王`）", () => {
    // 抽出来的是完整 token「小王杰」，与集合里的「小王」不相等
    expect(mentionsSelf(extractMentionTexts("@小王杰 看下"), selfNames)).toBe(false)
  })
})
