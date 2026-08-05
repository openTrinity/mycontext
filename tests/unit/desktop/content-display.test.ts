/**
 * 正文清洗的门禁。
 *
 * ## ★ 这一层最容易出的两种错，都在界面上很难归因
 *
 * 1. **规则压根没生效**：标记原样显示。这个已经真的发生过 ——
 *    `CLI_HINT` 第一版写的是 `[^\s，。]*?`，而命令名
 *    `dws chat message download-media` **带空格**，于是那条规则对
 *    633 条消息（全库 6.2%）完全没匹配上。写代码时看不出来，
 *    对着真实语料跑一遍才暴露。
 * 2. **正则贪婪吃掉正文**：用 `.*` 而不是 `[^)]*` 会一路吃到行尾的
 *    最后一个 `)`。表现是"消息内容凭空少了一半"，而没有任何报错。
 *
 * 所以这一组既测"标记被剥掉"，也测"正文一个字都没少"。
 */
import { describe, expect, it } from "vitest"
import { toDisplayContent } from "../../../apps/desktop/src/renderer/features/persona/content-display.js"

describe("★ 图片标记：剥掉标记，保留正文", () => {
  it("纯图片消息 → 空正文 + hadMedia", () => {
    const out = toDisplayContent(
      "[图片消息](mediaId=@lQLPKG-foZGeBQPNAhDNBnSwy5WPOdO12_8KPMFctT2OAA)",
    )
    expect(out.text).toBe("")
    /**
     * `hadMedia` 让渲染层能区分"纯图片消息"与"真的空消息"：
     * 前者不该显示「（无正文）」占位 —— 图片气泡本身就是内容。
     */
    expect(out.hadMedia).toBe(true)
  })

  it("图片 + 后面跟正文 → 正文完整保留（贪婪正则会吃掉它）", () => {
    const out = toDisplayContent(
      "[图片消息](mediaId=@lQLPKdft2vicnmNCzNqwyVd3hAt6YvkKPL9Mm7-7AA)很赞[向上]",
    )
    expect(out.text).toBe("很赞[向上]")
  })

  it("mediaId 里的 $ @ - _ 都不影响切分（实测这些字符都出现）", () => {
    const out = toDisplayContent("[图片消息](mediaId=$iwELAqNwbmcDAATRAfQF0QG_BrDR-x_y)后面的话")
    expect(out.text).toBe("后面的话")
  })

  it("一条消息里两张图 → 两个标记都剥掉", () => {
    const out = toDisplayContent("[图片消息](mediaId=@a)中间[图片消息](mediaId=@b)结尾")
    expect(out.text).toBe("中间结尾")
  })
})

describe("★ DWS 塞进正文的 CLI 使用说明", () => {
  /**
   * ★ 这两条锁的正是那个真实的漏洞。
   *
   * 命令名带空格（`dws chat message download-media` 有三个），
   * 而第一版的字符类排除了空格 → 对 633 条消息完全没生效。
   */
  it("图片的下载提示（命令名带 3 个空格）被剥掉", () => {
    const out = toDisplayContent(
      "[图片消息](mediaId=$iwEL) 注意：如需下载使用dws chat message download-media命令下载",
    )
    expect(out.text).toBe("")
  })

  it("文件的下载提示（另一个命令）也被剥掉", () => {
    const out = toDisplayContent(
      "[文件] .env fileId: 4lgGw3P8vzw9zZ 注意：如需下载使用dws drive download命令下载",
    )
    // 文件名要留着 —— 它是这条消息唯一的可读信息
    expect(out.text).toBe("[文件] .env")
  })

  it("提示后面若跟真正文，正文要留住（不跨句吃）", () => {
    const out = toDisplayContent("注意：如需下载使用dws drive download命令下载。这句是人说的")
    expect(out.text).toContain("这句是人说的")
  })
})

describe("★ 视频/语音：还有 fileName= 与 url: 两条尾巴", () => {
  /**
   * 这一条是对着全库跑出来的：改完前三种之后仍残留 1 条，
   * 那条是 `[视频消息]` —— 类型标签写死成"图片消息|图片"漏掉了它，
   * 而它后面还跟着 `fileName=video url: @lQbP…`（都是给 CLI 用的，
   * `url:` 后面那个值就是 mediaId 本身，不是可访问链接）。
   */
  it("视频消息整段剥干净（标签 + fileName + url + 提示）", () => {
    const out = toDisplayContent(
      "[视频消息](mediaId=@lQbPJwhl5MVrMwsAALDsEGMn3VqLLQo5OJaCgxcA) fileName=video url: @lQbPJwhl5MVrMwsAALDsEGMn3VqLLQo5OJaCgxcA 注意：如需下载使用dws chat message download-media命令下载",
    )
    expect(out.text).toBe("")
    expect(out.hadMedia).toBe(true)
  })
})

describe("★ @真名(花名) → @花名", () => {
  it("取花名（群里实际用的称呼）", () => {
    const out = toDisplayContent("@柳文(小李) 好好好")
    expect(out.text).toBe("@小李 好好好")
    expect(out.mentions).toEqual([{ raw: "@柳文(小李)", display: "@小李" }])
  })

  /**
   * ★ 全角括号单独测：实测语料里两种括号都出现，
   * 只判半角会让一半的 @提及原样显示（`@张三（小三）`）。
   */
  it("全角括号也认（只判半角会漏掉一半）", () => {
    const out = toDisplayContent("@周敏（敏敏） 收到")
    expect(out.text).toBe("@敏敏 收到")
  })

  it("真名与花名相同时不出问题", () => {
    expect(toDisplayContent("@小胡(小胡) 稳").text).toBe("@小胡 稳")
  })

  it("多个 @提及都换掉，且去重", () => {
    const out = toDisplayContent("@柳文(小李) @周敏(敏敏) @柳文(小李) 你们看")
    expect(out.text).toBe("@小李 @敏敏 @小李 你们看")
    // mentions 去重（渲染 chip 时不需要重复项）
    expect(out.mentions).toHaveLength(2)
  })

  it("普通的 @ 不受影响（没有括号就不是这个格式）", () => {
    expect(toDisplayContent("邮箱是 a@b.com").text).toBe("邮箱是 a@b.com")
  })
})

describe("★ 表情标签保留（那是钉钉的表情，用户本来就这么看到）", () => {
  it.each(["[二哈]", "[捂脸哭]", "[向上]", "[一脸苦笑]"])("%s 不动", (emoji) => {
    expect(toDisplayContent(`好的${emoji}`).text).toBe(`好的${emoji}`)
  })

  /**
   * 表情标签与媒体标记形态很像（都是方括号），所以这一条锁的是
   * "不要顺手把表情也剥掉"—— 实测语料里 20.6% 的消息含方括号，
   * 而其中绝大多数是表情（`[狗子]` 22 次、`[忍者]` 19 次…）。
   */
  it("表情与图片标记同时出现时只剥图片", () => {
    expect(toDisplayContent("[图片消息](mediaId=@a)[二哈]").text).toBe("[二哈]")
  })
})

describe("★ 收尾：空白处理", () => {
  it("剥完留下的连续空格压成一个", () => {
    expect(toDisplayContent("前面 [图片消息](mediaId=@a) 后面").text).toBe("前面 后面")
  })

  it("换行不动（reference 明确「换行必须是真实换行符」）", () => {
    expect(toDisplayContent("第一行\n第二行").text).toBe("第一行\n第二行")
  })

  it("null 与空串安全", () => {
    expect(toDisplayContent(null)).toEqual({ text: "", mentions: [], hadMedia: false })
    expect(toDisplayContent("")).toEqual({ text: "", mentions: [], hadMedia: false })
  })

  it("没有任何标记的普通消息原样返回（最常见的那类不该被动）", () => {
    const plain = "某工具2万积分，用大模型 高强度开发，最多用10天"
    expect(toDisplayContent(plain).text).toBe(plain)
    expect(toDisplayContent(plain).hadMedia).toBe(false)
  })
})
