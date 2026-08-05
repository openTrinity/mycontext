/**
 * 草稿裁剪的门禁。
 *
 * ## ★ 这一条来自一次真实的失败
 *
 * 实测运行里模型把 414 个字符的**思考过程**当成正文返回了：
 * 「根据对话历史和用户画像，我需要起草一条回复。让我分析一下：
 * 1. 用户是…2. 说话风格：极其简短…」
 *
 * 那条草稿一旦被发出去，收到的人会看到我们的提示词内容与画像结论 ——
 * 既是隐私问题也是明显的失态。而它**不会报错**：414 字的草稿
 * 在库里与 10 字的草稿长得一样。
 *
 * 提示词里已经写了"只输出回复正文"，但提示词是**请求**不是**保证**。
 * 所以要有一层机器可查的裁剪，而这组门禁锁的是它的判据：
 * 按**结构特征**判断，不按长度 —— 只按长度截断会把一条真的长回复
 * 砍掉半句，而半句话看起来像正常回复但意思是错的。
 */
import { describe, expect, it } from "vitest"
import {
  extractDraft,
  extractDraftEnvelope,
} from "../../../apps/desktop/src/main/services/persona-draft.js"

describe("★ 正常回复一律不动", () => {
  it("短回复原样返回", () => {
    expect(extractDraft("不知道 bro 得问下百炼那边")).toEqual({
      text: "不知道 bro 得问下百炼那边",
      trimmed: false,
    })
  })

  it("★ 长但正常的回复不被截断（半句话比留着自述更糟）", () => {
    const long =
      "这个方案我看过了，主要问题是授权那块还没定 —— " +
      "nango 那边的回调地址要先在控制台配好，不然回调过来会 404。" +
      "我明天上午找他们确认一下，确认完我在群里同步。" +
      "另外前端那个交互优化可以先不动，等授权链路通了再一起测。"
    // 比自述判据的 40 字门槛长得多 —— 证明"长"本身不构成裁剪理由
    expect(long.length).toBeGreaterThan(100)
    const result = extractDraft(long)
    expect(result.trimmed).toBe(false)
    expect(result.text).toBe(long)
  })

  it("带编号但没有规划措辞的回复不算思考过程", () => {
    const numbered =
      "两件事：\n1. 授权回调要先配\n2. 前端那块等授权通了再测\n" +
      "我先看第一个，有进展同步。这两个应该都不难，主要是要等他们那边配好。"
    expect(extractDraft(numbered).trimmed).toBe(false)
  })

  it("空串原样返回（不造一句话出来）", () => {
    expect(extractDraft("   ")).toEqual({ text: "", trimmed: false })
  })
})

describe("★ 思考过程必须被裁掉", () => {
  /** 与实测那条同构（脱敏后）。 */
  const REASONING = [
    "根据对话历史和用户画像，我需要起草一条回复。让我分析一下：",
    "",
    "1. 用户负责连接器相关的研发",
    "2. 说话风格：极其简短、随意、口语化",
    "3. 当前话题：讨论几个模型的使用体验",
    "4. 最后一条消息是问某个模型什么时候上线",
    "",
    "回复应该：简短、口语化、不确定就说不确定、不承诺时间",
    "",
    "不太清楚，我去问下",
  ].join("\n")

  it("以「根据对话…我需要起草」开头 → 判为思考过程", () => {
    const result = extractDraft(REASONING)
    expect(result.trimmed).toBe(true)
    // 取最后一段（模型的自述通常"分析在前、结论在后"）
    expect(result.text).toBe("不太清楚，我去问下")
  })

  it("★ 裁剪后的正文里不能残留提示词痕迹", () => {
    const result = extractDraft(REASONING)
    for (const leak of ["用户画像", "说话风格", "回复应该", "我需要起草"]) {
      expect(result.text).not.toContain(leak)
    }
  })

  it("最后一段仍然像自述 → 给占位而不是发自述", () => {
    const allMeta = [
      "让我分析一下这条消息该怎么回。",
      "",
      "根据对话历史和用户画像，考虑到他的说话风格偏简短，" +
        "回复应该保持口语化。1. 先确认事实 2. 再给结论。综上，我需要起草一条简短的回复。",
    ].join("\n")
    const result = extractDraft(allMeta)
    expect(result.trimmed).toBe(true)
    /**
     * 占位是一句安全的话 —— 用户看到它会自己改；
     * 而看到一段自述只会困惑，然后关掉这个功能。
     */
    expect(result.text).toBe("（这条需要人工确认后回复）")
  })

  it("编号列表 + 规划措辞（没有自述开头）也判为思考过程", () => {
    const planned = [
      "这条消息问的是上线时间。",
      "1. 我不掌握排期",
      "2. 不能承诺时间",
      "所以回复应该表示会去确认。",
      "",
      "我去问一下再回你",
    ].join("\n")
    const result = extractDraft(planned)
    expect(result.trimmed).toBe(true)
    expect(result.text).toBe("我去问一下再回你")
  })
})

describe("判据是结构而不是长度", () => {
  it("短的自述不裁（不可能是思考过程，且裁了会误伤）", () => {
    // 120 字以下一律放过 —— 这么短装不下一段分析
    const short = "根据对话，我觉得可以"
    expect(extractDraft(short).trimmed).toBe(false)
  })
})

describe("★ 宿主审核协议 fail closed", () => {
  it("结构化结果透出 agent 的刹车", () => {
    expect(
      extractDraftEnvelope(
        JSON.stringify({
          reply: "收到",
          holdForReview: false,
          reviewReason: "",
        }),
      ),
    ).toEqual({
      text: "收到",
      holdForReview: false,
      reviewReason: null,
    })
  })

  it("非 JSON 仍保留正文，但必须进入待审", () => {
    expect(extractDraftEnvelope("收到")).toEqual({
      text: "收到",
      holdForReview: true,
      reviewReason: "agent_output_unstructured",
    })
  })

  /**
   * ★ 字段名对不上也算读不懂。
   *
   * 这一条挡的是"改了协议名却忘了改产物的 SKILL.md"（或反过来）：
   * 那时模型仍会返回一个合法 JSON，只是刹车字段叫别的名字。
   * 不判类型的话 `record["holdForReview"]` 是 undefined，
   * 而 `undefined || false` 是 false —— **一次静默的全放行**。
   */
  it("刹车字段缺失/改名 → 当读不懂，进待审", () => {
    const result = extractDraftEnvelope(JSON.stringify({ reply: "收到", requiresReview: false }))
    expect(result.holdForReview).toBe(true)
    expect(result.reviewReason).toBe("agent_output_unstructured")
  })

  it("正文被安全裁剪时，即使模型没踩刹车也强制待审", () => {
    const result = extractDraftEnvelope(
      JSON.stringify({
        reply:
          "根据对话历史，我需要起草一条回复。让我分析一下这里的语气和事实边界，避免替用户承诺。\n\n收到",
        holdForReview: false,
        reviewReason: "",
      }),
    )
    expect(result.holdForReview).toBe(true)
    // 原因要说清是**为什么**被扣下的，而不是留 null 让草稿卡上什么都不写
    expect(result.reviewReason).toBe("draft_looked_like_reasoning")
  })
})

describe("★★ 前置散文 + 尾部协议 JSON：一次真实误发", () => {
  /**
   * 这一组来自实测：模型把语料摘要写在**前**面，把协议 JSON 写在**后**面。
   *
   * 旧实现 `JSON.parse(raw)` 直接抛 → 落到 catch，整段（散文 + JSON）
   * 被 extractDraft 当作正文。表现是：
   *   · 草稿箱里出现一段带 `{"reply":"卢广仲","holdForReview":false,...}` 的文本，
   *   · 内部字段名（`holdForReview`）在群里发了出去。
   *
   * 正确行为：识别尾部那段合法 JSON，把 `reply` 抽出来单发；散文丢弃。
   */
  it("★ 「散文\\n{...}」 → 用尾部 JSON 的 reply 作为正文", () => {
    const raw =
      "语料里有明确记录：小周喜欢听卢广仲的歌。\n" +
      '{"reply": "卢广仲", "holdForReview": false, "reviewReason": ""}'
    const result = extractDraftEnvelope(raw)
    expect(result.text).toBe("卢广仲")
    // 模型没踩刹车 + 未做安全裁剪 → 保留原判定；这一条是"能自动发"的门槛
    expect(result.holdForReview).toBe(false)
    expect(result.reviewReason).toBeNull()
    // ★ 反证：绝不能把"holdForReview"这类字段名落到用户看见的正文里
    expect(result.text).not.toContain("holdForReview")
    expect(result.text).not.toContain("reply")
  })

  it("尾部 JSON 里 holdForReview:true → 保持待审", () => {
    const raw =
      "我需要先跟他确认一下。\n" +
      '{"reply": "让我先问下再回复", "holdForReview": true, "reviewReason": "unsure"}'
    const result = extractDraftEnvelope(raw)
    expect(result.text).toBe("让我先问下再回复")
    expect(result.holdForReview).toBe(true)
    expect(result.reviewReason).toBe("unsure")
  })

  it("尾部 JSON 里 reply 本身像思考过程 → 走裁剪并强制待审", () => {
    const raw =
      "散文前置\n" +
      JSON.stringify({
        reply:
          "根据对话历史和用户画像，我需要起草一条回复。让我分析一下：\n1. 用户简短\n2. 别承诺时间\n回复应该保持口语化。\n\n再看下",
        holdForReview: false,
        reviewReason: "",
      })
    const result = extractDraftEnvelope(raw)
    expect(result.holdForReview).toBe(true)
    expect(result.reviewReason).toBe("draft_looked_like_reasoning")
    // 不能残留提示词痕迹
    for (const leak of ["用户画像", "holdForReview", "回复应该"]) {
      expect(result.text).not.toContain(leak)
    }
  })

  it("正文里也含 `{}`（例：花括号被作为字面出现）—— 仍能找到最右一段合法 JSON", () => {
    const raw =
      "他说要用 markdown 表格：\n" +
      "| a | b |\n" +
      "| - | - |\n" +
      "| {x} | 1 |\n" +
      '{"reply": "行，我周三前给你", "holdForReview": false, "reviewReason": ""}'
    const result = extractDraftEnvelope(raw)
    expect(result.text).toBe("行，我周三前给你")
    expect(result.holdForReview).toBe(false)
  })

  it("尾部像 JSON 但字段名不对 → 当读不懂，进待审", () => {
    // `requiresReview` 而不是 `holdForReview`。旧代码在 catch 分支里
    // 硬布尔比较 `record["holdForReview"]` = undefined → false，
    // 那是一次静默放行；现在这条要变成 fail closed。
    const raw = '前面一段废话。\n{"reply": "收到", "requiresReview": false}'
    const result = extractDraftEnvelope(raw)
    expect(result.holdForReview).toBe(true)
    expect(result.reviewReason).toBe("agent_output_unstructured")
  })

  /**
   * ★ 实测样本：markdown 围栏包裹的协议 JSON。
   *
   * 触发形态是模型自作主张给 JSON 加了 ```` ```json ```` 围栏，
   * 于是 `endsWith("}")` 一夹夜里那条判断就当场失效，
   * 整段（围栏 + JSON）被 `extractDraft` 落进 draft_text ——
   * 用户在草稿箱看到 「```json {"reply":"卢广仲",...} ```」。
   */
  it("★ markdown 围栏 ```json {...} ``` → 仍要能识别尾部 JSON", () => {
    const raw = '```json\n{"reply": "卢广仲", "holdForReview": false, "reviewReason": ""}\n```'
    const result = extractDraftEnvelope(raw)
    expect(result.text).toBe("卢广仲")
    expect(result.holdForReview).toBe(false)
  })

  /**
   * ★ 实测样本 2：模型踩刹车但草稿框还是显示整段 JSON。
   *
   * `{"reply": "不太了解", "holdForReview": true, "reviewReason": "..."}`
   * 这一条是**协议解析本身**应当把 `reply` 抽出来单独落 draftText，
   * 而不是让整段 JSON 变成用户在草稿箱看到的文本。
   */
  it("★ 模型踩刹车（holdForReview:true）时也只落 reply", () => {
    const raw =
      '{"reply": "不太了解", "holdForReview": true, ' +
      '"reviewReason": "不确定本人对卢广仲的实际看法，不能编造"}'
    const result = extractDraftEnvelope(raw)
    expect(result.text).toBe("不太了解")
    expect(result.holdForReview).toBe(true)
    expect(result.reviewReason).toBe("不确定本人对卢广仲的实际看法，不能编造")
    // 关键反证：不能把内部字段名或 reviewReason 拼进正文
    expect(result.text).not.toContain("holdForReview")
    expect(result.text).not.toContain("reviewReason")
  })
})

/**
 * ★★ 半截信封：机器文本绝不能作为"回复正文"交给用户。
 *
 * ## 这是一条真实落库过的草稿
 *
 * `dh_drafts` 里有 40 个字符的一条：
 * `{"reply": "哈哈好", "holdForReview": false,` —— 在 `false,` 之后硬断。
 * 根因在 `PersonaAcp.turn`（响应回来时流还没结束，已修 + 有回归锁），
 * 但**根因修好之后这一层仍然必须挡**：
 *
 * · 网络/进程在任何一处断掉都能再产出半截 JSON；
 * · 而这一层是 draft_text 落库前**最后**一道门。
 *
 * ## 为什么不能沿用"解析失败就留原文"
 *
 * 那条兜底对**散文**是对的（模型没按协议但说了句人话，留着让人改）。
 * 对半截 JSON 是错的：用户在草稿框里看到 `{"reply": "哈哈好", …` 时
 * 唯一能做的就是全选删掉重写 —— 那比给一句"生成不完整"更糟，因为它
 * 看起来像我们的功能坏了，而不是像一次可重试的失败。
 *
 * ## 判据是**结构**：像信封但读不出来
 *
 * 不用长度、不用"包含 `{`"：一条正常回复完全可能提到大括号。
 * 判据是「以 `{` 开头 + 含 `"reply"` 键 + 解析失败」这个组合 ——
 * 一条人话回复不会同时满足这三条。
 */
describe("★★ 半截协议 JSON 不得作为正文进草稿", () => {
  it("★ 库里那条 40 字符的截断草稿 → 不落原文", () => {
    const raw = '{"reply": "哈哈好", "holdForReview": false,'
    const result = extractDraftEnvelope(raw)
    // 最重要的一条：用户看不到机器文本
    expect(result.text).not.toContain('"reply"')
    expect(result.text).not.toContain("holdForReview")
    expect(result.text).not.toBe(raw)
    // 必须进待审，且原因要能区分于"模型返回了散文"
    expect(result.holdForReview).toBe(true)
    expect(result.reviewReason).toBe("agent_output_truncated")
  })

  it("★ 断在 reply 中间（连值都没收完）同样挡住", () => {
    const result = extractDraftEnvelope('{"reply": "哈哈哈 姐')
    expect(result.text).not.toContain('"reply"')
    expect(result.reviewReason).toBe("agent_output_truncated")
    expect(result.holdForReview).toBe(true)
  })

  it("★ 正文里出现大括号的**正常散文**不受影响（反证）", () => {
    /**
     * 反证：如果判据写成"含 `{` 就当截断"，这条会被误伤 ——
     * 而误伤的表现是一条本来能发的回复变成了占位文案。
     */
    const result = extractDraftEnvelope("那个配置写成 {a: 1} 就行")
    expect(result.text).toBe("那个配置写成 {a: 1} 就行")
    expect(result.reviewReason).toBe("agent_output_unstructured")
  })

  it("★ 占位文案要让人看懂发生了什么（而不是空草稿）", () => {
    const result = extractDraftEnvelope('{"reply": "哈哈好", "holdForReview": false,')
    // 空正文在界面上与"模型认为无需回复"无法区分 —— 必须有可读内容
    expect(result.text.length).toBeGreaterThan(0)
    expect(result.text).toContain("生成")
  })
})
