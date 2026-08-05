/**
 * Avatar — 头像。图片优先，取不到时退到**首字母色块**。
 *
 * ## ★ 兜底底色由显示名 hash 决定，不随机
 *
 * 随机底色会让同一个人每次进来颜色不同 —— 表现是"头像在闪"，
 * 而用户会以为是加载错误。hash 让「同名 ⇒ 同色」成为不变式，
 * 于是颜色本身也变成一个弱识别信号（在会话列表里扫一眼就能分辨谁是谁）。
 *
 * ## ★ 图片加载失败要能退回兜底
 *
 * 头像 URL 可能失效（渠道换了 CDN、离线、URL 过期）。只写 `<img src>`
 * 的话失败时浏览器显示一个碎图标 —— 那比首字母难看得多，也不传达信息。
 * 所以用 `onError` 切到兜底，并且**记住这次失败**（同一次挂载内不重试，
 * 否则 React 重渲染会反复触发请求）。
 *
 * 不引第三方 UI 库：整个 design 包目前零运行时依赖（除 React），
 * 而这个组件的全部需求就是"图片 + 兜底 + 失败回退"。
 */
import { useEffect, useState } from "react"
import { cn } from "../lib/cn.js"

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl"

/**
 * 头像轮廓。
 *
 * `squircle`（默认）是**方形 + 连续曲率圆角** —— 圆角半径按尺寸缩放，
 * 小尺寸用小圆角，否则 20px 的头像配 12px 圆角看起来就是个圆。
 *
 * 留一个 `circle` 是因为纯圆在某些位置仍然更对（比如叠在图上的小状态点
 * 那种装饰），而不是为了让调用方随便挑 —— 身份类头像应当统一。
 */
export type AvatarShape = "squircle" | "circle"

export interface AvatarProps {
  /** 显示名。决定首字母与兜底底色 */
  name: string
  /** 头像地址；为空或加载失败时用兜底 */
  src?: string | null
  size?: AvatarSize
  shape?: AvatarShape
  className?: string
  /**
   * 强制显示兜底（忽略 src）。
   * 设置页做"清空头像后长什么样"的实时预览时用。
   */
  forceFallback?: boolean
}

/**
 * 尺寸与**兜底首字**的字号。
 *
 * ★ 字号偏大是刻意的（约边长的 46-52%，而不是常见的 40%）：
 * 兜底时首字**就是**这块色块的全部内容，它不是配角。小字号会让
 * 一屏没有头像的人看起来像一片空色块，而首字正是那时唯一的识别信号。
 *
 * 中文首字比拉丁字母视觉重量大，但两者共用一档 —— 分开给会让
 * 「沈」与「S」在同一列里高度不齐，那比略大一点更显眼。
 */
const SIZE: Record<AvatarSize, string> = {
  xs: "size-5 text-[11px]",
  sm: "size-6 text-[13px]",
  md: "size-7 text-[15px]",
  lg: "size-9 text-[18px]",
  xl: "size-16 text-[30px]",
}

/**
 * 圆角半径**按尺寸给**，不是一个固定值。
 *
 * ★ 同一个 `--radius-md`(8px) 放在 20px 的头像上占了 40% 边长
 * （看起来接近圆），放在 64px 上只占 12%（看起来几乎是方的）——
 * 也就是说固定半径会让"同一个形状"在不同尺寸下**看着不是一个形状**。
 *
 * 这组值让圆角占边长的比例大致恒定在 ~30%，那是 iOS/macOS 图标那种
 * "方中带圆"的观感 —— 比例再往上走就开始读作圆形，那就失去了
 * "方形四圆角"的意义。配合 `corner-shape: squircle`（Chromium 139+）
 * 得到连续曲率；旧内核自动退化成标准圆角，仍然是方形四圆角。
 */
const SHAPE: Record<AvatarSize, string> = {
  xs: "rounded-[6px]",
  sm: "rounded-[7px]",
  md: "rounded-[9px]",
  lg: "rounded-[11px]",
  xl: "rounded-[19px]",
}

/**
 * 兜底配色。
 *
 * 六组「浅底 + 深字」的搭配，都在浅色与深色主题下各自可读 ——
 * 用固定的 HSL 而不是主题 token：token 会随主题翻转明暗，
 * 而这里需要的是"这个人的颜色"在两种主题下都稳定可辨。
 * 文字色统一压到很深，保证对比度（WCAG AA）不依赖主题。
 */
const PALETTE: readonly { bg: string; fg: string }[] = [
  { bg: "hsl(210 90% 92%)", fg: "hsl(210 90% 30%)" },
  { bg: "hsl(150 60% 90%)", fg: "hsl(150 70% 26%)" },
  { bg: "hsl(280 70% 93%)", fg: "hsl(280 60% 34%)" },
  { bg: "hsl(30 90% 90%)", fg: "hsl(25 80% 30%)" },
  { bg: "hsl(340 80% 93%)", fg: "hsl(340 65% 34%)" },
  { bg: "hsl(190 70% 90%)", fg: "hsl(195 75% 26%)" },
]

/**
 * 显示名 → 调色板下标。
 *
 * FNV-1a：短字符串上分布够均匀，且**跨平台/跨版本结果一致**
 * （不像 `String.prototype.hashCode` 那样各引擎实现不同）。
 * 这一点是必须的 —— 同一个人在不同机器上应当是同一个颜色。
 */
export function avatarPaletteIndex(name: string): number {
  let hash = 0x81_1c_9d_c5
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index)
    // >>> 0 保持无符号：位运算在 JS 里是 32 位有符号的
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0
  }
  return hash % PALETTE.length
}

/**
 * 取首字母。
 *
 * 中文取**第一个字**（"王强" → "王"）而不是拼音首字母：
 * 转拼音要一张映射表（几 KB）且多音字会出错，而中文用户看到"王"
 * 比看到"W"更容易认出是自己。
 *
 * emoji / 组合字符用 `Intl.Segmenter` 按**字素簇**切，避免把一个
 * emoji 截成半个代理对（那会渲染成 `�`）。
 */
export function avatarInitial(name: string): string {
  const trimmed = name.trim()
  if (trimmed === "") return "?"
  // Segmenter 在 Node 18+ / 所有现代浏览器都有；仍然兜一层以防运行环境阉割。
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
    const first = segmenter.segment(trimmed)[Symbol.iterator]().next()
    if (first.done !== true) return first.value.segment.toUpperCase()
  }
  return (trimmed[0] ?? "?").toUpperCase()
}

export function Avatar({
  name,
  src,
  size = "md",
  shape = "squircle",
  className,
  forceFallback = false,
}: AvatarProps) {
  const [failed, setFailed] = useState(false)
  // src 变了要重新给一次机会：否则换了头像仍显示兜底。
  useEffect(() => setFailed(false), [src])

  const usable = src !== null && src !== undefined && src !== ""
  const showImage = !forceFallback && usable && !failed
  const palette = PALETTE[avatarPaletteIndex(name)] as { bg: string; fg: string }

  return (
    <span
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center overflow-hidden",
        // 方形四圆角（默认）：半径按尺寸缩放，见 SHAPE 的注释
        shape === "circle" ? "rounded-full" : cn(SHAPE[size], "corner-squircle"),
        /**
         * ★ 不给边框。
         *
         * 原来有一道 `--border-divider-light`。它的用意是"照片贴在浅底上
         * 时给个轮廓"，但代价更大：兜底色块本身就是一块实色，
         * 再套一圈描边等于给每个没有头像的人加一道杂线 ——
         * 一屏几十个人时那是几十道 1px 灰边，比它要解决的问题更吵。
         *
         * 照片的轮廓交给圆角本身：squircle 的边界已经足够清楚。
         */
        "font-medium",
        SIZE[size],
        className,
      )}
      style={showImage ? undefined : { backgroundColor: palette.bg, color: palette.fg }}
      // 头像是**装饰性**的：名字总在旁边显示，读屏器再念一遍是噪声。
      aria-hidden="true"
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          className="size-full object-cover"
          onError={() => setFailed(true)}
          // 头像不需要参与布局计算，异步解码避免大图阻塞首帧
          decoding="async"
          draggable={false}
        />
      ) : (
        avatarInitial(name)
      )}
    </span>
  )
}
