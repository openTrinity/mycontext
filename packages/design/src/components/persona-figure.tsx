/**
 * PersonaFigure — 数字人的「形象」。三种来源：**DiceBear 风格 / 本地图片 / 生成**。
 *
 * ## 为什么用 DiceBear 而不是继续自己画
 *
 * 上一版是自己生成的几何脸：零依赖、随主题变色，但它只有一种"长相"——
 * 换 seed 只是挪五官位置，看多了都一个样。数字人是要长期看着的东西，
 * 需要真正的**风格差异**（卡通 / 像素 / 机器人 / 表情），而那不是
 * 几十行 SVG 能覆盖的。
 *
 * 选了 6 个风格（每个一个包，合计约 800KB **打包体积**）。
 * 许可**不是**清一色 MIT：代码是 MIT，但**设计**分别是 CC0 / CC-BY-4.0 /
 * "free for commercial use"，其中两个（micah / funEmoji）**有署名义务**。
 * 逐包的原文与署名信息见 `packages/design/LICENSES.md` ——
 * 升级任何 `@dicebear/*` 时必须重读那份文件。
 *
 * ## ★ 为什么六个风格包是**静态** import（而不是按需 `import()`）
 *
 * 实测磁盘体积：notionists 512KB、lorelei 316KB、micah 192KB、
 * bottts 188KB、thumbs 128KB、funEmoji 116KB、core 92KB。
 * 一次全载确实要几十毫秒，而设置页只用其中一个 —— 看起来该按需加载。
 *
 * **但只把 `FigureStudio` 改成 `React.lazy` 是无效的**：`PersonaSignature`
 * （草稿卡上那个 16px 署名头像）用的就是本组件，而它经
 * `app-shell → PersonaModule → draft-inbox` **静态**挂在启动路径上。
 * 也就是说用户从不打开设置页也照样要付这笔开销，把 studio 拆出去
 * 一个字节都省不下来。那种改动的坏处是它**看起来**做了优化。
 *
 * 真要省，唯一有效的做法是把 `STYLES` 换成动态 `import()` 并让本组件
 * 变成异步的 —— 代价是那个 16px 署名头像会先空一帧再出现（它在收件箱里
 * 每张卡都有一个），以及 `figure-pinning` 那批"同 seed 字节相同"的
 * 同步断言全部要改成异步。**在有人真的报告启动慢之前不做这件事**，
 * 而不是因为它不可做。
 *
 * ## 逐槽位定制（`custom`）
 *
 * 除了 `style` + `seed`，还可以传 `custom` 逐个钉住槽位
 * （头发/眼睛/眼镜…），这是 `FigureStudio` 的底座。
 * **不传时行为与加这个 prop 之前逐字节一致** —— 全部由 seed 决定。
 *
 * ## ★ 为什么必须离线生成，而不是用它的 HTTP API
 *
 * `api.dicebear.com/9.x/<style>/svg?seed=x` 用起来更省事，但它意味着
 * 头像在**断网、内网、或那个域名不可达**时全部变成空白 —— 而这是一个
 * 本地优先的桌面应用，"没网就没脸"是不可接受的降级。
 * 而且那会把每个用户的 seed（可能是他的名字）发到第三方。
 *
 * 实测确认：`createAvatar` 纯本地、同 seed 结果稳定、不同 seed 结果不同。
 *
 * ## 本地图片优先
 *
 * 用户上传的图片存 `<userData>/figures/`，这里拿到一个 `file://` 路径。
 * 它**优先于**风格 —— 用户显式选的东西不该被生成的图覆盖。
 */
import { useMemo } from "react"
import { createAvatar } from "@dicebear/core"
import * as notionists from "@dicebear/notionists"
import * as lorelei from "@dicebear/lorelei"
import * as micah from "@dicebear/micah"
import * as funEmoji from "@dicebear/fun-emoji"
import * as bottts from "@dicebear/bottts"
import * as thumbs from "@dicebear/thumbs"
import { cn } from "../lib/cn.js"
import { figureToOptions, type FigureConfig } from "./figure/figure-model.js"

/**
 * 可选的形象风格。
 *
 * 顺序是**给人看的顺序**（从最像人到最抽象），不是字母序 ——
 * 选择器里第一个是缺省，而"像人的"更适合一个代表本人的数字人。
 */
export const FIGURE_STYLES = [
  "notionists",
  "lorelei",
  "micah",
  "funEmoji",
  "bottts",
  "thumbs",
] as const

export type FigureStyle = (typeof FIGURE_STYLES)[number]

/**
 * 风格 id → DiceBear 的 style 模块。
 *
 * `Record` 而不是 switch：漏一个是编译错误。
 */
const STYLES: Record<FigureStyle, Parameters<typeof createAvatar>[0]> = {
  notionists,
  lorelei,
  micah,
  funEmoji,
  bottts,
  thumbs,
}

/** 默认风格。第一个 = 最像人的那个。 */
export const DEFAULT_FIGURE_STYLE: FigureStyle = FIGURE_STYLES[0]

export interface PersonaFigureProps {
  /** 决定形象的种子。同一个 seed 永远同一个形象 */
  seed: string
  /** 风格。不传用缺省（最像人的那个） */
  style?: FigureStyle
  /**
   * 用户上传的本地图片（`file://…`）。
   *
   * 传了就**优先于风格** —— 用户显式选的东西不该被生成的图覆盖。
   */
  imageSrc?: string | null
  /**
   * 逐槽位定制（`FigureStudio` 产出的东西）。
   *
   * **不传 = 与加这个 prop 之前的行为逐字节一致**（全部由 seed 决定）。
   * 传了则覆盖对应槽位，未定制的槽位**仍由 seed 决定** ——
   * 这让"只改了头发，其余保持原样"天然成立。
   */
  custom?: FigureConfig | undefined
  /** 像素边长 */
  size?: number
  /**
   * `<img decoding>`。
   *
   * 抽屉里一屏有几十张缩略图，而 dataUri **不走网络**（所以
   * `loading="lazy"` 没有请求可省），真正的开销是**位图解码** ——
   * 那是同步发生在主线程上的。`"async"` 让浏览器自己排期。
   * 默认不传（单张大预览要它立刻可见，晚一帧会看到闪一下）。
   */
  decoding?: "sync" | "async" | "auto"
  className?: string
}

/**
 * memo 依赖用的**规范化 options 字符串**。
 *
 * ## 为什么不能直接把 `custom` 放进依赖数组
 *
 * 它是个对象，父组件每次重渲染都给一个新引用 → memo 全部失效。
 * 而这里的 memo 不是微优化（见下面 `useMemo` 的注释）：抽屉界面
 * 一屏可能有 64 个缩略图，实测 64 张 dataUri 累计 **851KB** 字符串。
 *
 * ## 为什么裸 `JSON.stringify` 也不行
 *
 * 键顺序**由用户点击顺序决定**（先点头发再点眼睛 vs 反过来），而
 * `JSON.stringify({a:1,b:2}) !== JSON.stringify({b:2,a:1})` ——
 * 于是 memo 会在语义完全没变时失效。那是一个"看起来做了优化其实没生效"
 * 的静默失效：不报错，只是变卡。所以要**先排序键名**再序列化。
 *
 * 实测 options 的键顺序不改变产物字节，所以排序是安全的。
 *
 * ★ 别"顺手清理"成 `[custom]`：那会让 64 张缩略图每次重渲染全部重算。
 * 有一条数 `createAvatar` 调用次数的测试锁着这件事。
 */
function figureOptionsKey(style: FigureStyle, custom: FigureConfig | undefined): string {
  if (custom === undefined) return ""
  const options = figureToOptions(style, custom)
  const keys = Object.keys(options).sort()
  // 空对象也回落成 ""，让"传了个空 custom"与"没传"命中同一个 memo
  if (keys.length === 0) return ""
  return JSON.stringify(Object.fromEntries(keys.map((key) => [key, options[key]])))
}

export function PersonaFigure({
  seed,
  style = DEFAULT_FIGURE_STYLE,
  imageSrc = null,
  custom,
  size = 96,
  decoding,
  className,
}: PersonaFigureProps) {
  /**
   * ★ 这一行**刻意不包 `useMemo`**。
   *
   * 它本身就是下面两层 memo 的 key —— 包起来需要一个依赖数组，而
   * 那个数组只能是 `[style, custom]`，也就是又回到了"对象引用做依赖"
   * （`custom` 每次都是新引用），memo 必然失效。换句话说包了不省，
   * 只是多一层看起来像优化的东西。
   *
   * 实测代价：64 格时 0.099ms/次重渲染，可忽略。
   */
  const optionsKey = figureOptionsKey(style, custom)
  /**
   * 规范化字符串 → options 对象。
   *
   * ## 为什么中间要过一个字符串
   *
   * 直接把 `custom` 放进依赖数组会让 memo 全失效（新引用），而
   * `optionsKey` 是**稳定的**：语义没变就是同一个串。于是这一层
   * `useMemo` 的依赖数组是**完整**的（不需要 `eslint-disable`，
   * 将来给 design 包打开 `exhaustive-deps` 也不会红）。
   *
   * ★ 上一版把 `JSON.parse` 写在下面那个 `useMemo` 里面 ——
   * 效果相同但读起来绕（"序列化再反序列化"作为传值通道）。
   * 拆成两层之后，下面那层只依赖一个对象，意图直接可读，
   * 而 `parse` 只在 key 真的变了时跑一次（那时本来就要跑
   * 几万字符的 `createAvatar`，开销可以忽略）。
   */
  const options = useMemo(
    () => (optionsKey === "" ? {} : (JSON.parse(optionsKey) as Record<string, unknown>)),
    [optionsKey],
  )
  /**
   * 生成 data URI。
   *
   * `useMemo` 不是微优化：`createAvatar` 每次要拼一个 10-15KB 的 SVG 串
   * （实测 notionists 200 个 seed 的均值 14031 字符，最坏 27508），
   * 而选择器里一屏有 8 个候选、抽屉里最多 64 个缩略图 ×
   * 每次父组件重渲染 = 上百万字符的字符串拼接。
   */
  const uri = useMemo(() => {
    if (imageSrc !== null && imageSrc !== "") return null
    const chosen = STYLES[style] ?? STYLES[DEFAULT_FIGURE_STYLE]
    // DiceBear 的 size 只写进 svg 的 width/height；实际显示尺寸由下面的 CSS 定
    return createAvatar(chosen, { seed, size, ...options }).toDataUri()
  }, [seed, style, imageSrc, size, options])

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden corner-squircle",
        // 底色让透明背景的风格（thumbs / bottts）也有一个稳定的轮廓
        "bg-[var(--bg-card-z0)]",
        className,
      )}
      /**
       * ★ 圆角**按尺寸算**而不是一个固定类名。
       *
       * 与 `Avatar` 不同，这个组件的 `size` 是任意像素值（调用方从 24 传到
       * 160 都有），所以没法用一组预设类。30% 是同一个比例常数 ——
       * 两个组件常常并排出现（消息流里数字人与真人交替），
       * 圆角比例不一致会很显眼。
       */
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.3) }}
      // 形象是装饰：名字总在旁边，读屏器再念一次是噪声
      aria-hidden="true"
    >
      <img
        src={imageSrc ?? uri ?? ""}
        alt=""
        /**
         * 本地图片用 `cover`（裁掉多余部分，保证填满整个方块），
         * 生成的图用 `contain`（它们本来就是方的，cover 会裁掉边缘的头发）。
         */
        className={cn("size-full", imageSrc === null ? "object-contain" : "object-cover")}
        {...(decoding === undefined ? {} : { decoding })}
        draggable={false}
      />
    </span>
  )
}

/**
 * 生成一批候选 seed（形象选择器用）。
 *
 * 不用 `Math.random`：那样每次打开引导页看到的候选都不同，
 * 用户"刚才那个更好看"就再也找不回来了。用 index 派生 ——
 * 同一个 base 永远给出同一组候选。
 */
export function personaFigureSeeds(base: string, count = 8): string[] {
  return Array.from({ length: count }, (_, index) => `${base}#${String(index)}`)
}

/**
 * 「随机」派生出的 seed 后缀：`|r<轮次>#<序号>`。
 *
 * 只匹配**结尾** —— 它是用来把一个已经随机过的 seed 剥回底座的。
 */
const RANDOM_ROUND_RE = /\|r(\d+)#\d+$/

/**
 * 名字派生的缺省 seed。
 *
 * ## ★★ 为什么这个函数必须存在
 *
 * 改动前候选 seed 由 `personaFigureSeeds(\`${name}|${round}\`)` 派生
 * —— **改名字就换一批脸**，而那是个有意的设计（新名字新气象）。
 * 改成 `FigureStudio` 之后名字不再进 seed，而新用户的缺省 seed 是
 * **常量** `"|0#0"`：实测空名字 / "小小周" / "另一个名字" 三者的预览
 * **逐字节相同** —— 也就是**每个新用户看到的都是同一张默认脸**。
 * 那是一次功能回退，而且形态很隐蔽：形象照常显示，只是不再是"你的"。
 *
 * 注意 `"|0#0"` 本身就是 `defaultFigureSeed("")` —— 所以这不是换了
 * 一套规则，而是把那个常量还原成它本来的含义（名字为空时的取值）。
 */
export function defaultFigureSeed(name: string): string {
  return personaFigureSeeds(`${name}|0`, 1)[0] ?? `${name}|0#0`
}

/**
 * 这个 seed 是否还是「名字派生的缺省值」（用户没自己挑过）。
 *
 * 判据是形如 `<任意>|0#0` —— 轮次 0、序号 0。任何用户动作都会离开这个形态：
 * 点「随机」得到 `|rN#0`（见 `nextFigureSeed`）。
 *
 * ★ 对**老用户**它同样安全：旧界面的候选是 `${name}|${round}#${index}`，
 * 所以 `小小周|0#0` 既可能是缺省值、也可能是他手点的第 0 个候选 ——
 * 但两者的 seed 里带的就是他自己的名字，重新派生得到**同一个串**。
 * 只有他改名字时才会变，而那正是旧行为（改名换一批）。
 */
export function isDefaultFigureSeed(seed: string): boolean {
  return /\|0#0$/.test(seed)
}

/**
 * 下一个「随机」seed。
 *
 * ## ★★ 为什么不能直接 `${seed}|r${round}`
 *
 * 上一版就是那么写的，而 `seed` 本身**已经是拼过的结果**，于是每点一次
 * 随机就往后**再接**一段。实测连点四次：
 *
 * ```
 * 小小周|0#0 → …|r1#0 → …|r1#0|r2#0 → …|r1#0|r2#0|r3#0 → …|r1#0|r2#0|r3#0|r4#0
 * ```
 *
 * 每次长 5 个字符、**无上界**，而这个串是要落进 vault 的用户数据。
 * 更糟的是轮次存在组件 state 里：卸载重挂后它归零，于是实测会产出
 * `…|r1#0|r1#0` —— **连点随机回到同一张脸**，正是
 * `personaFigureSeeds` 的注释要避免的那件事（"刚才那个更好看"找不回来
 * 的反面：想换一张却换不动）。
 *
 * 所以轮次从 **seed 自己**解析，不存 state：
 * ① 长度有界（底座 + 一段后缀，重复随机只改那段里的数字）；
 * ② 重挂后接着往下走，不会撞回旧值。
 *
 * 仍然是**派生**而不是 `Math.random` —— 同一个 seed 点随机永远得到
 * 同一个下一张，"刚才那个更好看"可以靠回退找回来。
 */
export function nextFigureSeed(seed: string): string {
  const match = RANDOM_ROUND_RE.exec(seed)
  // 剥掉上一轮的后缀，拿到不变的底座（没随机过时底座就是 seed 本身）
  const base = match === null ? seed : seed.slice(0, match.index)
  /**
   * ★ 轮次超出安全整数时**回落到 0**，不要原样 `+1`。
   *
   * `Number("9007199254740991") + 1` 在浮点上饱和：实测
   * `x|r9007199254740991#0` → `…992#0`，再点一次**仍然是** `…992#0`
   * —— 表现是"点随机没反应"，正是这个文件反复要避免的那一类。
   *
   * 靠点击到达要 9×10^15 次（不可达），但 `Number(match[1])` 读的是
   * **库里的字符串**，而手改过的 vault 数据一行就能到那里。
   * 这个仓库对手改过的库数据一贯做纵深防御
   * （`figureToOptions` 里 `usable.includes` 那段注释就是），这条同源。
   *
   * 回落到 0 而不是保持原值：0 会让下一次得到 `|r1#0`，也就是**动了**
   * —— 用户点随机总该换一张脸。代价是那个荒谬的轮次号被重置，
   * 而它本来就不是用户能看见的东西。
   */
  const parsed = match === null ? 0 : Number(match[1])
  const round = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
  return personaFigureSeeds(`${base}|r${String(round + 1)}`, 1)[0] ?? seed
}
