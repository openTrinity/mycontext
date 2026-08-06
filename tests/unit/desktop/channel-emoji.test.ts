/**
 * 渠道表情标记 → emoji 的白名单映射。
 *
 * ## 这一组锁的核心是**不该转的绝不能转**
 *
 * 转错一个表情看起来是小事，但实测那 610 种 `[xx]` 里有这些：
 *
 * ```
 * [FIRING:1] [RESOLVED] [告警]   —— 监控机器人的状态词
 * [必填] [选填] [问题描述]        —— 表单模板的字段名
 * [点击查看详情] [戳这里]         —— 卡片按钮文案
 * ```
 *
 * 把告警群的 `[FIRING:1]` 变成一个笑脸，值班的人会漏掉它 ——
 * 而界面上**看不出**这是被我们改的。所以下面「不转」的断言比
 * 「转对了」的断言更重要。
 *
 * ## ★ 还锁一条：白名单里不许出现真实姓名
 *
 * 起因是我差点犯的一个错：想按"纯中文 1-4 字、出现≥3 次"从本机库里
 * 自动筛表情名，筛出来 138 条里混着**四个真实同事姓名**（有人把名字
 * 写进方括号）。那份清单一旦入库就是不可撤回的泄漏（CLAUDE.md §1.1）。
 *
 * 最后那条断言把这件事钉住：表里的键必须都在一份**手写的**官方表情名
 * 语义分类里，出现意料之外的键就红。它挡的是"下次有人图省事又去
 * 自动生成一遍"。
 */
import { describe, expect, it } from "vitest"
import {
  CHANNEL_EMOJI,
  UNMAPPED_OFFICIAL,
  replaceChannelEmoji,
} from "@renderer/features/persona/channel-emoji.js"
import { toDisplayContent } from "@renderer/features/persona/content-display.js"

describe("★ 认识的表情转成 emoji", () => {
  /** 实测出现次数最高的那几个（转对了用户才会觉得"和钉钉里一样"）。 */
  it.each([
    ["[天使]", "😇"],
    ["[赞]", "👍"],
    ["[笑哭]", "😂"],
    ["[流泪]", "😢"],
    ["[火箭]", "🚀"],
    ["[抱拳]", "🙏"],
  ])("%s → %s", (marker, emoji) => {
    expect(replaceChannelEmoji(marker)).toBe(emoji)
  })

  it("一条消息里多个表情都转", () => {
    expect(replaceChannelEmoji("好的[赞][笑哭]")).toBe("好的👍😂")
  })

  it("表情夹在正文中间，周围的字不动", () => {
    expect(replaceChannelEmoji("这个方案[赞]我同意")).toBe("这个方案👍我同意")
  })
})

describe("★★ 不认识的一律原样留着（最重要的一组）", () => {
  /**
   * ★★ 监控机器人的状态词绝不能变成表情。
   *
   * 实测 `[FIRING:1]` 418 次、`[RESOLVED]` 393 次、`[告警]` 343 次 ——
   * 都在告警群里。转成笑脸的话值班的人会漏掉，而这**没有任何症状**：
   * 界面看起来就是一条正常消息。
   */
  it.each([["[FIRING:1]"], ["[RESOLVED]"], ["[告警]"], ["[严重]"], ["[一般]"]])(
    "★★ 监控状态词 %s 原样留着",
    (marker) => {
      expect(replaceChannelEmoji(marker)).toBe(marker)
    },
  )

  /** 表单字段名与卡片按钮文案 —— 都是功能性文本，不是表情。 */
  it.each([["[必填]"], ["[选填]"], ["[问题描述]"], ["[点击查看]"], ["[戳这里]"]])(
    "功能性文本 %s 原样留着",
    (marker) => {
      expect(replaceChannelEmoji(marker)).toBe(marker)
    },
  )

  /**
   * ★ 平台自有形象**刻意**不转 —— 它们没有对应的 Unicode emoji。
   *
   * 显示 `[二哈]` 比显示一个语义错的 emoji 好：前者用户知道那是个表情，
   * 后者会让他以为对方真的发了那个意思。
   */
  it.each([["[二哈]"], ["[狗子]"], ["[钉子]"]])("★ 平台自有形象 %s 刻意不转", (marker) => {
    expect(replaceChannelEmoji(marker)).toBe(marker)
  })

  /**
   * ★★ 有人把**真实姓名**写在方括号里（实测存在）。
   *
   * 用的是明显编造的名字（CLAUDE.md §1.2：结构照抄、值全换）。
   * 判据是"表里没有就不动"，与具体是谁无关 —— 所以假名足够锁住它。
   */
  it("★★ 方括号里的人名原样留着（有人真这么写）", () => {
    expect(replaceChannelEmoji("[张三]看下")).toBe("[张三]看下")
    expect(replaceChannelEmoji("[李四]")).toBe("[李四]")
  })

  it("空方括号与超长内容不动", () => {
    expect(replaceChannelEmoji("[]")).toBe("[]")
    expect(replaceChannelEmoji("[这是一段很长的不是表情的文本]")).toBe(
      "[这是一段很长的不是表情的文本]",
    )
  })
})

describe("★ 与协议标记清洗的配合", () => {
  /**
   * ★ 顺序（先剥协议标记、再转表情）**当前是观察不到的** —— 记下来免得误信。
   *
   * 我写了一条"顺序断言"，然后反证：把 `replaceChannelEmoji` 挪到清洗**之前**，
   * 28 条全绿。原因是表里没有任何键与协议标记同名 —— `[图片消息]` 会被
   * emoji 正则匹到形状，但查表查不到、原样返回，于是两种顺序结果相同。
   *
   * 所以这里**不假装**锁住了顺序（那会是一条谎报的断言）。真正能锁的是
   * 下面那个不变式：**表里不许出现协议标记词**。它成立时顺序才无所谓；
   * 它一旦被破坏（有人往表里加"图片"），顺序就立刻要命 —— 而那时红的
   * 是下面那条，不是这条。
   */
  it("图片标记剥掉、同一条里的表情转掉", () => {
    expect(toDisplayContent("[图片消息](mediaId=@a)[赞]").text).toBe("👍")
  })

  it("CLI 提示剥掉之后表情仍然转", () => {
    const raw =
      "[图片消息](mediaId=@a) 注意：如需下载使用dws chat message download-media命令下载[赞]"
    expect(toDisplayContent(raw).text).toBe("👍")
  })

  /**
   * ★★ 表里不许出现协议标记词 —— 这才是让顺序无所谓的那个不变式。
   *
   * 加了"图片"之类的键之后：先转表情的话 `[图片消息](mediaId=…)` 里的
   * `[图片消息]` 会先变成 emoji，剩下一个裸的 `(mediaId=…)` 留在界面上，
   * 而 `IMAGE_MARKER` 再也匹不到它了。
   */
  it.each([["图片"], ["图片消息"], ["视频消息"], ["语音消息"], ["文件"], ["image"]])(
    "★★ 协议标记词 %s 不在表里",
    (word) => {
      expect(Object.keys(CHANNEL_EMOJI)).not.toContain(word)
    },
  )

  it("@提及与表情共存", () => {
    const out = toDisplayContent("@王五(小五)[赞]")
    expect(out.text).toBe("@小五👍")
    expect(out.mentions).toHaveLength(1)
  })
})

describe("★★ 白名单本身的卫生", () => {
  /**
   * ★★ 这条挡的是"下次有人图省事从本机库自动生成一遍白名单"。
   *
   * 自动生成必然会把「有人写在方括号里的真实姓名」一起收进来，
   * 而那是一次不可撤回的泄漏（CLAUDE.md §1.1：入了 git 就有 fork、
   * 镜像、CI 日志）。
   *
   * ## 权威从哪来
   *
   * 第一版这条断言拿的是**我手写**的一份分类清单当权威 —— 那是循环论证：
   * 我猜错的键会同时出现在实现与断言里，于是断言永远绿。
   * 用户当场指出"和 App 里显示的不一样"，核对后我那 90 条里
   * **28 条官方默认包根本没有**、还漏了 53 条。
   *
   * 现在权威是**渠道 App 自己的资源**（`OFFICIAL_EMOJI_NAMES`，
   * 从 App 包的前端资源里抄下来的 115 条 `{name, englishName}`）。
   * 它与实现是两个独立来源，所以能真的互相校验。
   *
   * ★ 企业自定义表情不在官方包里（`[一脸苦笑]` 188 次、`[鞠躬]` 169 次
   * 都是真在用的），所以另立一份 `ENTERPRISE_EMOJI_NAMES`。
   * 两份的并集就是允许的键集 —— 想加新键必须先归类，
   * 而那点摩擦正是这条断言的目的。
   */

  /**
   * 官方默认表情包的全部名字（115 条）。
   *
   * 来源：渠道 App 包内前端资源里的结构化表
   * `{name:"天使", englishName:"Angel", …, id:"default:58"}`。
   * 那是**产品资源**，不含任何人的数据 —— 与"从本机库筛"是两件事。
   */
  const OFFICIAL_EMOJI_NAMES = new Set([
    "微笑", // Smile
    "憨笑", // Wow
    "色", // Yum
    "发呆", // Dazed
    "老板", // Boss
    "流泪", // Sob
    "害羞", // Shy
    "闭嘴", // Silence
    "睡", // Sleepy
    "大哭", // Cry
    "尴尬", // Awkward
    "发怒", // Steamed
    "调皮", // Tongueout
    "大笑", // Laugh
    "惊讶", // Scowl
    "流汗", // Sweat
    "广播", // Shout
    "自信", // Self-confident
    "你强", // Awesome
    "怒吼", // Pumped
    "惊愕", // What?!
    "疑问", // Question
    "OK", // OK
    "鼓掌", // Clap
    "握手", // Shake
    "偷笑", // Chuckle
    "无聊", // Bored
    "加油", // YouCanDoIt
    "快哭了", // TearingUp
    "吐", // Puke
    "晕", // Dizzy
    "摸摸", // Comfort
    "胜利", // Peace
    "飞吻", // Blowkiss
    "跳舞", // Yay
    "傻笑", // Oops
    "鄙视", // Dislike
    "嘘", // Shhh
    "衰", // Grr
    "思考", // Hmm…
    "亲亲", // Kiss
    "无奈", // Disappointed
    "感冒", // Pollution
    "对不起", // Sorry
    "再见", // Wave
    "投降", // GiveUp
    "哼", // Grumpy
    "欠扁", // FaceSlap
    "拜托", // Please
    "可怜", // Aww…
    "舒服", // Relax
    "爱意", // Romantic
    "单挑", // HeyYou!
    "财迷", // MoneyMoney
    "迷惑", // Puzzled
    "委屈", // Worried
    "灵感", // Idea
    "天使", // Angel
    "鬼脸", // SillyFace
    "凄凉", // Phew
    "郁闷", // Tired
    "坏笑", // Trick
    "忍者", // Sneaky
    "算账", // SoMuch
    "炸弹", // Uh-Oh
    "邮件", // Mail
    "电话", // Phone
    "礼物", // Present
    "爱心", // Love
    "心碎", // BrokenHeart
    "嘴唇", // Lips
    "鲜花", // Rose
    "残花", // Wilted
    "出差", // BusinessTrip
    "干杯", // Cheers
    "赞", // Like
    "抱拳", // Salute
    "感谢", // Thanks
    "笑哭", // LaughAndCry
    "嘿嘿", // Smirk
    "捂脸哭", // Facepalm
    "抠鼻", // NosePick
    "流鼻血", // BloodyNose
    "敲打", // Hammer
    "跪了", // YouWin
    "抱抱", // Hug
    "摊手", // Smugshrug
    "呲牙", // Grin
    "吃瓜", // EatingMelon
    "彩虹", // Rainbow
    "专注", // Concentrate
    "二哈", // Doggy
    "猫咪", // Kitty
    "红包", // RedPacket
    "狗子", // Puppy
    "耶", // Yeah
    "可爱", // Lovely
    "捂眼睛", // CannotLook
    "推眼镜", // PushGlasses
    "暗中观察", // Peep
    "脑暴", // Brainstorming
    "100分", // 100
    "对勾", // Check
    "打招呼", // Hi
    "生日快乐", // Birthday
    "钉钉", // DingTalk
    "白眼", // RollEyes
    "回头", // LookBack
    "冷笑", // Distressed
    "开心", // Happy
    "三多", // SanDuo
    "送花花", // Flower
    "惊喜", // Surprised
    "一团乱麻", // Overwhelmed
    "KPI", // KPI
  ])

  /**
   * 企业/自定义表情：不在官方默认包里，但语料里真在用。
   *
   * 实测出现次数（本机 vault）附在后面 —— 它是"这条不是我凭空加的"的证据。
   */
  const ENTERPRISE_EMOJI_NAMES = new Set([
    "一脸苦笑", // 188
    "鞠躬", // 169
    "魔法棒", // 77
    "火", // 98
    "火箭", // 69
    "裂开", // 42
    "加一", // 35
    "烟花", // 34
    "比心", // 29
    "抱大腿", // 23
    "元气满满", // 22
    "撒花", // 21
    "加油干", // 19
    "黑眼圈", // 13
    "点赞", // 13
    "让人头大", // 11
    "收到", // 11
    "在吗", // 10
    "地球", // 10
    "幼苗", // 6
    "手机", // 6
    "奶茶", // 4
    "虎虎生威", // 4
    "马上来财", // 4
    "送花花", // 64
    "茶", // 3
    "热", // 3
    "兔飞猛进", // 3
  ])

  it("★★ 表里每个键都是官方表情名或已登记的企业表情（挡自动生成）", () => {
    const unknown = Object.keys(CHANNEL_EMOJI).filter(
      (k) => !OFFICIAL_EMOJI_NAMES.has(k) && !ENTERPRISE_EMOJI_NAMES.has(k),
    )
    expect(unknown).toEqual([])
  })

  /**
   * ★★ 反过来的一条：官方包里的名字，要么映射了、要么**明确登记为不映射**。
   *
   * 这条锁的是"漏"而不是"错"。第一版我漏了 53 条官方表情
   * （`[对勾]` 190 次、`[广播]` 38 次都在语料里），而漏掉的表现是
   * 界面上照旧显示方括号 —— 看起来像"这个表情不支持"，
   * 而不像"我们忘了"。有了这条，漏一个就红。
   */
  it("★★ 官方表情要么映射、要么明确登记为不映射（挡「漏」）", () => {
    const unhandled = [...OFFICIAL_EMOJI_NAMES].filter(
      (n) => CHANNEL_EMOJI[n] === undefined && !UNMAPPED_OFFICIAL.includes(n),
    )
    expect(unhandled).toEqual([])
  })

  /**
   * ★ 刻意不映射的那些**必须真的不在表里** —— 否则 `UNMAPPED_OFFICIAL`
   * 就成了一句谎话（说着"不转"而实际转了）。
   */
  it("★ UNMAPPED_OFFICIAL 里的确实都没映射", () => {
    for (const name of UNMAPPED_OFFICIAL) {
      expect(CHANNEL_EMOJI[name], name).toBeUndefined()
      expect(replaceChannelEmoji(`[${name}]`)).toBe(`[${name}]`)
    }
  })

  /**
   * ★ 值必须是 emoji 而不是又一个方括号标记 —— 否则等于没转，
   * 而界面上看起来"这个表情就是不生效"，很难归因到表里。
   */
  it("★ 每个值都不含方括号（防止表里填了另一个标记）", () => {
    for (const [name, emoji] of Object.entries(CHANNEL_EMOJI)) {
      expect(emoji, name).not.toMatch(/[[\]]/)
      expect(emoji.length, name).toBeGreaterThan(0)
    }
  })
})
