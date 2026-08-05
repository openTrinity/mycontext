/**
 * 把 DWS 的原始 `content` 变成**能给人看**的正文与结构。
 *
 * ## ★ 为什么需要这一层
 *
 * 落库存的是原文（可回溯、可重解析），而原文里混着协议标记与 DWS 自己
 * 塞的 CLI 使用说明。实测这个 vault 的 10203 条消息：
 *
 * | 现象                                                        | 条数 | 占比      |
 * | ----------------------------------------------------------- | ---- | --------- |
 * | `[图片消息](mediaId=@lQLPKG…)`                              | 1002 | **9.8%**  |
 * | 其中还带「注意：如需下载使用dws chat message download-media…」| 633  | 6.2%      |
 * | `[文件] x.png fileId: … 注意：如需下载使用dws drive download…`| 37   | 0.4%      |
 * | `@真名(花名)`，如 `@柳文(小李)`                            | 1472 | **14.4%** |
 *
 * 于是消息栏里显示的是
 * `[图片消息](mediaId=$iwELAqNwbmcDAATRAfQF…) 注意：如需下载使用dws…`
 * —— 把 CLI 的使用说明摆给最终用户看，而那条图片其实已经在
 * `media_assets` 里有索引、界面上另有一个图片气泡在渲染它。
 *
 * ## 为什么在渲染层清洗，而不是入库时
 *
 * · 原文要留着：`resource_id` 的抽取规则可能要改（已经改过一次），
 *   而重解析只能基于原文；
 * · 不用回溯重写 10203 条；
 * · 清洗规则改了立刻对**历史消息**生效，不需要重跑采集。
 *
 * 代价是蒸馏与检索仍然吃原文。那是刻意的：检索要能按 `mediaId` 找回
 * 某张图，而蒸馏那边的噪音由它自己的 prompt 处理。
 *
 * ## 纯函数
 *
 * 没有 DOM、没有 React —— 于是可以穷举测。这一层最容易出的错是
 * 正则贪婪（把标记后面的正文一起吃掉），而那种错在界面上表现为
 * "消息内容凭空少了一半"，很难归因。
 *
 * ## ★ 为什么放在渲染层而不是 `@mycontext/channels`
 *
 * 它是**显示**逻辑，而 channels 是**协议**层。更硬的一条理由：
 * `channels/index.ts` 会导出 `cli.ts`，那个文件 import 了
 * `node:child_process` —— 渲染层 import 它会把子进程模块拖进浏览器 bundle。
 *
 * 所以这个纯函数待在 persona feature 目录里。解析层（`content-extract.ts`）
 * 仍在 channels：那边抽的是**结构**（媒体与 @提及要落库），
 * 这边做的是**显示**。两者的输入相同、目的不同。
 */

/** 一段 @提及。渲染层据此把它做成 chip。 */
export interface MentionSpan {
  /** 原文里的完整形态，如 `@柳文(小李)` */
  raw: string
  /** 显示用的名字。实测格式是 `@真名(花名)` → 取花名 */
  display: string
}

export interface DisplayContent {
  /** 剥掉协议标记与 CLI 提示之后的正文。可能是空串（纯图片消息） */
  text: string
  /** 出现过的 @提及，按原文顺序、去重 */
  mentions: MentionSpan[]
  /**
   * 原文里有没有媒体标记。
   *
   * ★ 渲染层用它决定"正文空了要不要显示占位"：
   * 一条纯图片消息剥完是空串，那时**不该**显示"（无正文）"——
   * 图片气泡本身就是内容。而一条真的空消息（罕见）该显示点什么。
   */
  hadMedia: boolean
}

/**
 * `[图片消息](mediaId=…)` / `[图片](mediaId=…)` / `[视频消息](mediaId=…)` /
 * `[语音消息](mediaId=…)`。
 *
 * `[^)]*` 而不是 `.*`：mediaId 里出现 `@` `$` `-` `_`，实测**不含** `)`，
 * 所以按"到下一个右括号"切是安全的。用 `.*` 会贪婪地吃到行尾的
 * 最后一个 `)`，把中间的正文一起吞掉。
 *
 * ★ 类型标签用 `[^\]]*?消息|图片` 兜住：实测语料里除了图片还有
 * `[视频消息]`（带 `fileName=` 与 `url:` 后缀，见 `MEDIA_TAIL`）。
 * 只写死"图片消息|图片"的话视频那一条会整段留在界面上 ——
 * 这正是靠对着全库跑一遍才发现的（写死时残留 1 条）。
 */
const IMAGE_MARKER = /\[(?:[^\]]*?消息|图片)\]\(mediaId=[^)]*\)/g

/**
 * 视频/语音消息标记后面跟的那一串。
 *
 * 实测形态：`[视频消息](mediaId=@lQbP…) fileName=video url: @lQbP…`
 * —— `fileName=` 与 `url:` 都是给 CLI 用的，对人没有意义
 * （`url:` 后面那个值就是 mediaId 本身，不是可访问链接）。
 */
const MEDIA_TAIL = /\s*(?:fileName=\S*|url:\s*\S+)/g

/**
 * `[文件] <名字> fileId: <id>`。
 *
 * ★ 文件名要**留下来**（不像图片那样整段删）：它是这条消息唯一的
 * 可读信息（"他发了 15-高鹏.png"），而文件气泡里也显示同一个名字 ——
 * 两处一致比只留一处更好读。所以这里只删 `fileId: <id>` 那一段。
 */
const FILE_ID_MARKER = /\s*fileId:\s*\S+/g

/**
 * DWS 自己塞进正文的 CLI 使用说明。
 *
 * 实测**两种**（按资源类型不同）：
 * · `注意：如需下载使用dws chat message download-media命令下载`（图片）
 * · `注意：如需下载使用dws drive download命令下载`（文件）
 *
 * 判据是「注意：如需下载使用 … 命令下载」这个**句式**而不是具体命令名 ——
 * 只匹配已知那两条的话，新增一种就会在界面上露出来。
 *
 * ★ 中间那段**必须允许空格**：命令名本身带空格
 * （`dws chat message download-media` 有三个）。第一版写的是
 * `[^\s，。]*?`，它在遇到第一个空格时就停 → 整条规则对 633 条消息
 * （占全库 6.2%）完全没生效，而界面上那句 CLI 说明照样显示。
 * 这个错是靠**对着真实语料跑一遍**发现的，不是靠读代码。
 *
 * 用 `[^，。\n]*?` 而不是 `.*?`：不跨句、不跨行 —— 万一后面紧跟正文，
 * `.*?` 配上后面的 `命令下载` 可能吃掉中间的真内容。
 */
const CLI_HINT = /\s*注意：如需下载使用[^，。\n]*?命令下载/g

/**
 * `@真名(花名)` 与 `@真名（花名）`（全角括号）。
 *
 * 两种括号都要判：实测语料里两者都出现，只判半角会漏掉一半。
 * `[^()（）]` 排除嵌套，避免跨越两个 @提及。
 */
const MENTION = /@([^\s()（）]+)[(（]([^()（）]+)[)）]/g

export function toDisplayContent(raw: string | null): DisplayContent {
  if (raw === null || raw === "") return { text: "", mentions: [], hadMedia: false }

  const hadMedia = /\(mediaId=/.test(raw) || /fileId:/.test(raw)

  /**
   * 先收集 @提及，再清洗 —— 顺序不能反。
   *
   * 反过来的话，清洗有可能改变 @提及周围的空白，让 `raw` 对不上原文
   * （渲染层要用 `raw` 在清洗后的文本里定位 chip）。
   */
  const mentions: MentionSpan[] = []
  const seen = new Set<string>()
  for (const match of raw.matchAll(MENTION)) {
    const full = match[0]
    const flower = match[2]
    if (full === undefined || flower === undefined || seen.has(full)) continue
    seen.add(full)
    /**
     * 显示取**花名**而不是真名：那是群里实际用的称呼
     * （实测 `@柳文(小李)` → 大家叫他"小李"）。
     * 两者相同时（`@小胡(小胡)`）自然也就是那一个。
     */
    mentions.push({ raw: full, display: `@${flower}` })
  }

  let text = raw
    .replace(IMAGE_MARKER, "")
    // CLI 提示要在 fileId 之前删：它紧跟在 fileId 后面，先删 fileId
    // 会让提示前面多一个孤立的空格（然后 trim 不掉，因为它在中间）
    .replace(CLI_HINT, "")
    .replace(FILE_ID_MARKER, "")
    // 视频/语音的 fileName= 与 url: 尾巴（url: 后面那个值就是 mediaId）
    .replace(MEDIA_TAIL, "")

  // @提及换成花名形态（更短，且与群里的称呼一致）
  for (const mention of mentions) {
    text = text.split(mention.raw).join(mention.display)
  }

  /**
   * 收尾：压掉连续空白并 trim。
   *
   * 删掉中间的标记会留下 `正文  正文` 这种双空格 —— 单看不明显，
   * 但一屏 20 条里有 10 条带标记时会显得很脏。
   * 只压**空格与制表符**，不动换行：换行是用户自己排的版
   * （reference 明确"换行必须是真实换行符"）。
   */
  text = text.replace(/[ \t]{2,}/g, " ").trim()

  return { text, mentions, hadMedia }
}
