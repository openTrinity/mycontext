/**
 * 图片与文件消息进 prompt 的形状。
 *
 * ## 这一组锁的是「agent 说读不了图」这个真实反馈
 *
 * 在这一层出现之前，transcript 只取 `contentText`，于是一条图片消息
 * 进 prompt 的样子就是渠道给的原文（实测库里就是这样）：
 *
 * ```
 * [图片消息](mediaId=$iwEdAqNqcGcDAQTRAxoF0QHDBrAbYio8bbEnQwo99ZgGFpAAB9ImCA0SCAAJomltCgAL0gAAspI) 注意：如需下载使用dws chat message download-media命令下载
 * ```
 *
 * 三件事同时错，而**没有任何一样会报错**：
 *
 * ① agent 看不到图；
 * ② 那句「如需下载使用 dws … 命令」是**误导性指令** —— agent 的
 *    `OPENCODE_PERMISSION` 是 `{"*":"deny"}`，bash 一律拒，它永远跑不了；
 * ③ 那串 id 占 100+ 字符，而每条截 300 字 —— **同一条消息里的真实文字被挤掉**。
 *    实测有这种：`[图片消息](mediaId=@lQLPJwgU…)web网页版，右上角有这个新人弹窗…`，
 *    正文在 mediaId **之后**。
 */
import { describe, expect, it } from "vitest"
import {
  MAX_IMAGE_BYTES,
  MAX_PROMPT_IMAGES,
  collectPromptImages,
  renderTranscript,
  stripMediaPlaceholders,
  type PromptMessage,
} from "../../../apps/desktop/src/main/services/persona-media-prompt.js"

/** 库里那条真实的图片消息正文（原样，不简化）。 */
const REAL_IMAGE_TEXT =
  "[图片消息](mediaId=$iwEdAqNqcGcDAQTRAxoF0QHDBrAbYio8bbEnQwo99ZgGFpAAB9ImCA0SCAAJomltCgAL0gAAspI) 注意：如需下载使用dws chat message download-media命令下载"

/** 库里那条**正文在 mediaId 之后**的（第 ③ 个问题的实证）。 */
const REAL_IMAGE_WITH_TEXT =
  "[图片消息](mediaId=@lQLPJwgUCfgJIEPNBS3NCgCwsFe_lmQbC1MKPepCxTsXAA)web网页版，右上角有这个新人弹窗，除非点我知道了， 否则其他地方我都点不了"

/** 库里那条真实的文件消息正文。 */
const REAL_FILE_TEXT =
  "[文件] kl-graph-portable.zip fileId: 9bN7RYPWdeP2e4G9FKR1jn7PVZd1wyK0 注意：如需下载使用dws drive download命令下载"

function message(overrides: Partial<PromptMessage> = {}): PromptMessage {
  return {
    senderDisplayName: "他人",
    contentText: null,
    isSelf: false,
    media: [],
    ...overrides,
  }
}

describe("★★ 渠道塞进正文的占位与「用 dws 下载」那句不得进 prompt", () => {
  it("★★ mediaId 那串被剥掉", () => {
    const out = stripMediaPlaceholders(REAL_IMAGE_TEXT)
    /**
     * ★ 反证：不剥的话这两个断言必红 —— 而它们正是现在误导 agent 的两样东西。
     * `mediaId=` 是白占预算的那 100+ 字符，后一句是它执行不了的命令。
     */
    expect(out, "mediaId 不该进 prompt").not.toContain("mediaId=")
    expect(out, "那条命令 agent 跑不了（bash 全 deny），给它只会浪费一轮").not.toContain(
      "如需下载使用",
    )
  })

  it("★ 文件消息的 fileId 与下载指令同样被剥", () => {
    const out = stripMediaPlaceholders(REAL_FILE_TEXT)
    expect(out).not.toContain("fileId:")
    expect(out).not.toContain("如需下载使用")
  })

  it("★★ 剥占位在**截断之前** —— 否则真正文会被 mediaId 吃掉", () => {
    /**
     * ★★ 这条是第 ③ 个问题的直接回归锁，用的是库里的真数据：
     * 正文「web网页版，右上角有这个新人弹窗…」在那串 47 字符的 mediaId **之后**。
     *
     * 把 `maxCharsPerMessage` 压到 20：只有先剥、后截才能留下开头那几个字；
     * 顺序反过来时那 20 个字全被 `[图片消息](mediaId=@lQLPJwgUCf` 占满。
     */
    const out = renderTranscript([message({ contentText: REAL_IMAGE_WITH_TEXT })], [[]], 20)
    expect(out, "真正文必须留下来").toContain("web网页版")
    expect(out).not.toContain("mediaId")
  })
})

describe("★ 媒体标注：状态必须**可见**，不能静默消失", () => {
  it("★ 未下载的图标成「未下载」，不是什么都不显示", () => {
    /**
     * 什么都不显示的话，那条消息在 prompt 里是空的 —— 模型会以为
     * 对方发了个空消息，而不是"发了张图但我看不到"。
     */
    const out = renderTranscript(
      [
        message({
          contentText: REAL_IMAGE_TEXT,
          media: [{ kind: "image", path: null, mime: null, bytes: null, originalName: null }],
        }),
      ],
      [[]],
    )
    expect(out).toContain("（图片，未下载）")
  })

  it("★ 文件类给**名字**（钉盘下载还没接，但名字本身有信息）", () => {
    const out = renderTranscript(
      [
        message({
          contentText: REAL_FILE_TEXT,
          media: [
            {
              kind: "file",
              path: null,
              mime: null,
              bytes: null,
              originalName: "kl-graph-portable.zip",
            },
          ],
        }),
      ],
      [[]],
    )
    // `.env` 与 `kl-graph-portable.zip` 对"该怎么回"的影响完全不同
    expect(out).toContain("（文件：kl-graph-portable.zip）")
  })

  it("★ 送进去的图标成 [图片 N]，编号与 image block 顺序一致", () => {
    const out = renderTranscript(
      [
        message({
          contentText: "看这个",
          media: [
            {
              kind: "image",
              path: "/tmp/a.png",
              mime: "image/png",
              bytes: 100,
              originalName: null,
            },
          ],
        }),
      ],
      [[1]],
    )
    expect(out).toContain("[图片 1]")
  })

  it("★ 没有媒体的会话**不多出**任何标注（避免每轮塞一句空话）", () => {
    const out = renderTranscript([message({ contentText: "在吗" })], [[]])
    expect(out).toBe("他人: 在吗")
  })

  it("★ 正文与标注都空时给「（空消息）」而不是一个空的冒号", () => {
    const out = renderTranscript([message({ contentText: "" })], [[]])
    expect(out).toBe("他人: （空消息）")
  })
})

describe("★★ 送图的三个上限（不限量会打爆上下文窗）", () => {
  const readFile = (): Buffer => Buffer.from("fake-image-bytes")
  const sized = (size: number) => (): { size: number } => ({ size })

  function withImages(count: number): PromptMessage[] {
    return Array.from({ length: count }, (_unused, index) =>
      message({
        contentText: `第 ${String(index)} 条`,
        media: [
          {
            kind: "image",
            path: `/tmp/img-${String(index)}.png`,
            mime: "image/png",
            bytes: 1000,
            originalName: null,
          },
        ],
      }),
    )
  }

  it(`★★ 超过 ${String(MAX_PROMPT_IMAGES)} 张时只送最近的那几张`, () => {
    const { images, slotsByMessage } = collectPromptImages(withImages(10), readFile, sized(1000))
    expect(images.length, "上限必须生效 —— 10 张 700KB 的图是 ~9MB 的 prompt").toBe(
      MAX_PROMPT_IMAGES,
    )
    /**
     * ★ 取的是**最近**的（索引 7/8/9），不是最早的。
     * 反证：改成正序遍历时这里必红 —— 而正序会送 3 张最老的图，
     * 那几乎必然不是这一轮在说的那张。
     */
    const withSlots = slotsByMessage.flatMap((slots, index) => (slots.length > 0 ? [index] : []))
    expect(withSlots).toEqual([7, 8, 9])
  })

  it("★★ 单张超 2MB 的跳过，且 transcript 里标出来", () => {
    const messages = withImages(1)
    messages[0]!.media = [
      {
        kind: "image",
        path: "/tmp/huge.png",
        mime: "image/png",
        // 库里最大那张是 19.98MB —— 一张就能打爆 prompt
        bytes: MAX_IMAGE_BYTES + 1,
        originalName: null,
      },
    ]
    const { images, slotsByMessage } = collectPromptImages(
      messages,
      readFile,
      sized(MAX_IMAGE_BYTES + 1),
    )
    expect(images.length, "超限的不该被送出去").toBe(0)
    // ★ 且**不静默**：模型要知道"这里有张图我没看到"
    expect(renderTranscript(messages, slotsByMessage)).toContain("（图片过大，未送入）")
  })

  it("★ 总量超限时停下（不是把每张都塞进去）", () => {
    // 每张 1.5MB × 3 = 4.5MB > 4MB 总上限 → 只能进 2 张
    const { images } = collectPromptImages(withImages(3), readFile, sized(1_500_000))
    expect(images.length).toBe(2)
  })

  it("★ 文件读不出来（被外部删了）时降级，不抛", () => {
    const throwing = (): Buffer => {
      throw new Error("ENOENT")
    }
    /**
     * 为一张图让整轮生成失败是错的取舍 —— 那会让"对方发了张图"变成
     * "数字分身这一轮彻底没反应"，而后者用户完全无从判断原因。
     */
    const { images } = collectPromptImages(withImages(1), throwing, sized(1000))
    expect(images.length).toBe(0)
  })

  it("★ 用 stat 复核大小，不信库里的 bytes（文件可能被换过）", () => {
    const messages = withImages(1)
    // 库里记着 1000 字节，而磁盘上其实是 3MB —— 信 bytes 就会把它送出去
    const { images } = collectPromptImages(messages, readFile, sized(3 * 1024 * 1024))
    expect(images.length, "应按 stat 的真实大小拒掉").toBe(0)
  })
})
