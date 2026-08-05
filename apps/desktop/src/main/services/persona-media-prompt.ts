/**
 * 把消息上挂的媒体渲染进 **agent 的 prompt**，并把能看的图读成 base64。
 *
 * ## ★ 为什么需要这一层（真实故障）
 *
 * 在这个文件出现之前，transcript 只取 `contentText`，于是一条图片消息
 * 进 prompt 的样子就是渠道给的原文 —— 实测库里长这样：
 *
 * ```
 * [图片消息](mediaId=$iwEdAqNqcGcDAQTRAxoF0QHDBrAbYio8bbEnQwo99ZgGFpAAB9ImCA0SCAAJomltCgAL0gAAspI) 注意：如需下载使用dws chat message download-media命令下载
 * ```
 *
 * 三件事同时错：
 *
 * 1. **agent 看不到图**，只拿到一个 mediaId；
 * 2. 那句「如需下载使用 dws … 命令」是**误导性指令** —— agent 的
 *    `OPENCODE_PERMISSION` 是 `{"*":"deny"}`（见 spawn-hardening.ts），
 *    bash 一律拒，那条命令它永远跑不了。模型照着试只会浪费一轮；
 * 3. 那串 id 占 100+ 字符，而 transcript 每条截 300 字 —— 于是**同一条消息里
 *    的真实文字被挤掉**。实测有这种：`[图片消息](mediaId=@lQLPJwgU…)web网页版，
 *    右上角有这个新人弹窗…`，正文在 mediaId **之后**。
 *
 * 所以：**先剥占位、再截断**（顺序反了等于先被 mediaId 吃掉预算），
 * 然后按媒体的真实状态标注。
 *
 * ## ★ 为什么图走 base64 塞进 prompt，而不是「给路径让 agent 自己读」
 *
 * 后者是更直觉的做法，但在这个项目里行不通：opencode 自己的 `read` 工具
 * **在 deny 名单里**（`DENY_ALL_PERMISSION` 的 `"*": "deny"`）。放行 `read`
 * 就等于让 agent 能读 workspace 里全部文件（画像、别的 skill），而
 * `tests/externals/opencode-permission.test.ts` 的文件头写明了那条防线为什么在：
 * 「读画像 → webfetch 到攻击者服务器」是一条纯读路径的外传通道。
 *
 * 图由**我们**主动塞进 prompt，agent 不获得任何新的文件访问能力 ——
 * 所以这条路不需要动权限。
 *
 * opencode 接受这个形状（从二进制里挖出的 ACP prompt 分派代码，不是猜的）：
 *
 * ```js
 * case"image": if(n.data) return [{type:"file", url:`data:${n.mimeType};base64,${n.data}`, …}]
 * ```
 */
import { readFileSync, statSync } from "node:fs"

/**
 * 一条消息上挂的媒体（**prompt 侧**的形状）。
 *
 * ★ 与 IPC 的 `MessageMediaView` 刻意分开：那个的 `path` 已经被转成
 * `mycontext-file://`（渲染层要它，见 persona.service 里那段注释），
 * 而这里要**真磁盘路径**才能读字节。共用一个类型会让某一天有人把
 * `mycontext-file://…` 传进 `readFileSync` —— 那是个静默失败。
 */
export interface PromptMedia {
  kind: string
  /** 真磁盘路径；null = 还没下载 */
  path: string | null
  mime: string | null
  bytes: number | null
  originalName: string | null
}

/** transcript 一条的输入。 */
export interface PromptMessage {
  senderDisplayName: string | null
  contentText: string | null
  isSelf: boolean | null
  media: readonly PromptMedia[]
}

/** 随 prompt 一起送出去的一张图。 */
export interface PromptImage {
  base64: string
  mimeType: string
  name: string
}

/**
 * 最多送几张图。
 *
 * ## ★ 为什么是 3（有实测依据）
 *
 * 库里单个会话最多挂 429 张图，30 条上下文窗里出现十几张是常态；
 * 而已下载图片的**均值是 731KB**（base64 后 ~975KB）。10 张就是 ~9MB 的
 * prompt —— 打爆上下文窗、每轮都慢、且按 token 计费。
 *
 * 3 张的取舍：对话里真正需要看的图几乎总是**最近那几张**（"这个图里的报错"
 * 指的是刚发的那张）。更早的图属于历史，文字标注已经交代了"那里有张图"。
 */
export const MAX_PROMPT_IMAGES = 3

/**
 * 单张上限 2MB。
 *
 * 实测 >2MB 的有 13 张、最大 **19.98MB** —— 一张就能把 prompt 打爆。
 * 超限的**不静默丢弃**，在 transcript 里标「（图片过大，未送入）」：
 * 模型至少知道"这里有张图我没看到"，而不是以为那条消息是空的。
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024

/** 一轮所有图的总上限（base64 后约 5.3MB）。 */
export const MAX_TOTAL_IMAGE_BYTES = 4 * 1024 * 1024

/**
 * 剥掉渠道塞进正文的媒体占位与「请用 xx 命令下载」那句。
 *
 * ## ★ 判据为什么这么宽
 *
 * 这些串是**渠道给的**，形态随渠道版本变（实测同一个库里就有两种
 * mediaId 前缀：`$iwE…` 与 `@lQLP…`）。写死某一种的话换个版本就漏 ——
 * 而漏了的后果是那 100+ 字符继续吃 transcript 预算，且没有任何报错。
 *
 * 所以按**结构**匹配（`[图片消息](mediaId=…)` / `[文件] … fileId: …` /
 * `注意：如需下载使用…命令下载`）而不是按具体内容。
 *
 * 不用 i18n：prompt 不该随界面语言变（否则同一条会话换个语言就是
 * 另一个 prompt，而这些占位串本身是渠道的中文原文）。
 */
export function stripMediaPlaceholders(text: string): string {
  return (
    text
      // [图片消息](mediaId=…) —— 括号里可能有 / 与 + 等 base64 字符
      .replace(/\[图片消息\]\(mediaId=[^)]*\)/g, "")
      // [文件] <名字> fileId: <id> —— 名字里可能有空格，所以锚到 fileId
      .replace(/\[文件\]\s*.*?fileId:\s*\S+/g, "")
      // 「注意：如需下载使用 xxx 命令下载」——那是对 agent 的误导性指令
      .replace(/注意：如需下载使用.*?命令下载/g, "")
      // 剥完可能留下多余空白
      .replace(/\s+/g, " ")
      .trim()
  )
}

/**
 * 一条消息的媒体标注。
 *
 * @param imageSlots 这条消息上的图分到的 `[图片 N]` 编号（空 = 一张都没送进去）
 */
function annotate(media: readonly PromptMedia[], imageSlots: readonly number[]): string {
  const parts: string[] = []
  let slotCursor = 0
  for (const asset of media) {
    if (asset.kind === "image") {
      const slot = imageSlots[slotCursor]
      slotCursor += 1
      if (slot !== undefined) {
        parts.push(`[图片 ${String(slot)}]`)
      } else if (asset.path === null) {
        // 未下载 ≠ 没有图。不标的话模型会以为那条消息是空的。
        parts.push("（图片，未下载）")
      } else if (asset.bytes !== null && asset.bytes > MAX_IMAGE_BYTES) {
        parts.push("（图片过大，未送入）")
      } else {
        parts.push("（图片，未送入）")
      }
      continue
    }
    if (asset.kind === "file") {
      /**
       * 文件类只给名字。
       *
       * 钉盘下载（`resource_kind = fileId`）还没接 —— `MediaService.download`
       * 明确拒了它。但**名字本身有信息**：`kl-graph-portable.zip` 与
       * `.env` 对"该怎么回"的影响完全不同。
       */
      parts.push(`（文件：${asset.originalName ?? "未命名"}）`)
      continue
    }
    parts.push(`（${asset.kind}）`)
  }
  return parts.join(" ")
}

/**
 * 挑出能送进 prompt 的图，并读成 base64。
 *
 * **从新到旧**取：最近的图最可能是这一轮在说的那张。
 * 返回的 `slots` 把「第几条消息的第几张图」映射到 `[图片 N]` 的 N，
 * 好让 transcript 与 image block 的顺序对得上 —— 错位比不给更糟
 * （模型会把 A 的图当成 B 发的）。
 *
 * @param readFile 注入点，只给测试用（真实现走 `readFileSync`）。
 *   测试造 2MB 的真文件太慢，而这一层的逻辑（限量、顺序、降级）
 *   与"字节从哪来"无关。
 */
export function collectPromptImages(
  messages: readonly PromptMessage[],
  readFile: (path: string) => Buffer = readFileSync,
  statFile: (path: string) => { size: number } = statSync,
): { images: PromptImage[]; slotsByMessage: number[][] } {
  const slotsByMessage: number[][] = messages.map(() => [])
  const images: PromptImage[] = []
  let totalBytes = 0

  /**
   * 倒序遍历消息（最新的先），但**正序写回** slot 编号 —— 于是
   * `[图片 1]` 永远是 transcript 里出现得最早的那张，读起来自然。
   */
  const picked: { messageIndex: number; image: PromptImage }[] = []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined) continue
    for (const asset of message.media) {
      if (picked.length >= MAX_PROMPT_IMAGES) break
      if (asset.kind !== "image" || asset.path === null) continue
      /**
       * ★ 用 `statFile` 复核大小而不是信库里的 `bytes`。
       *
       * `bytes` 是下载时写的，而文件可能被外部删掉/替换 —— 那时
       * 库里那个数还在。信它的后果是 `readFile` 读出一个巨大的
       * buffer 然后打爆 prompt，而限量检查已经"通过"了。
       */
      let size: number
      try {
        size = statFile(asset.path).size
      } catch {
        // 文件不在了：跳过，transcript 会标「未送入」
        continue
      }
      if (size > MAX_IMAGE_BYTES) continue
      if (totalBytes + size > MAX_TOTAL_IMAGE_BYTES) continue

      let base64: string
      try {
        base64 = readFile(asset.path).toString("base64")
      } catch {
        continue
      }
      totalBytes += size
      picked.push({
        messageIndex: index,
        image: {
          base64,
          // mime 缺失时按 png 猜：`sniffMime` 只认三种图片 + PDF，
          // 而能走到这里的都通过了 `previewable`（即 mime 是图片）。
          mimeType: asset.mime ?? "image/png",
          name: asset.originalName ?? "image",
        },
      })
    }
    if (picked.length >= MAX_PROMPT_IMAGES) break
  }

  // 倒序挑出来的 → 正序编号（transcript 里靠前的图编号小）
  picked.reverse()
  for (const [slotIndex, entry] of picked.entries()) {
    const slot = slotIndex + 1
    images.push(entry.image)
    slotsByMessage[entry.messageIndex]?.push(slot)
  }
  return { images, slotsByMessage }
}

/**
 * 渲染 transcript。
 *
 * ★ 每条的**顺序**是：剥占位 → 中性化围栏 → 截断 → 拼媒体标注。
 * 前两步都会改变长度，所以截断必须在它们之后；而标注在截断之后拼，
 * 否则一条长文本会把 `[图片 1]` 挤掉 —— 那正是要修的那个 bug 的镜像。
 */
export function renderTranscript(
  messages: readonly PromptMessage[],
  slotsByMessage: readonly number[][],
  maxCharsPerMessage = 300,
): string {
  return messages
    .map((item, index) => {
      const who = item.isSelf === true ? "我" : (item.senderDisplayName ?? "他人")
      // 与 map 阶段同一套中性化理由：语料是不可信输入
      const stripped = stripMediaPlaceholders(item.contentText ?? "").replace(/```/g, "｀｀｀")
      const text = stripped.slice(0, maxCharsPerMessage)
      const tag = annotate(item.media, slotsByMessage[index] ?? [])
      if (text === "" && tag === "") return `${who}: （空消息）`
      return `${who}: ${[text, tag].filter((part) => part !== "").join(" ")}`
    })
    .join("\n")
}
