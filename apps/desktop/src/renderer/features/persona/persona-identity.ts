/**
 * 数字人身份（名字 + 形象）的**唯一**读取与解析入口。
 *
 * ## 为什么要有这个共享模块
 *
 * 这份数据落在 `onboarding_progress` 的 persona 行里
 * （payload 形如 `{"name":"小小周","figureSeed":"小小周|0#0"}`），
 * 有两个消费方：引导页（回填表单）与数字人页（草稿署名）。
 *
 * 抄两份解析的后果不是"重复代码"这种整洁问题，而是**两处显示不一致**：
 * 引导页改了回落规则而数字人页不跟，用户就会在引导里看到形象 A、
 * 在草稿卡上看到形象 B —— 而那两个本该是同一个"人"。
 *
 * 所以解析只有这一份，`onboarding-view` 与 `persona` 模块都 import 它。
 *
 * ## ★★ "解析"包括**名字派生 seed**（这条是被审查抓到的）
 *
 * 上一版把派生写在 `persona-step.tsx` 的渲染里，四个消费方里只有它派生
 * —— 于是同一份数据在引导页与草稿署名上是两张脸。那不是"漏了三处"，
 * 是**规则漏在了这个文件外面**：只要派生不在这里，任何新消费方
 * 都会默认拿到未派生的值，而那不报错。
 *
 * 判断"什么算解析"的判据：**同一份 payload 必须只有一种渲染结果**。
 * 凡是决定这个结果的规则都属于本文件。
 */
import {
  DEFAULT_FIGURE_STYLE,
  FIGURE_STYLES,
  defaultFigureSeed,
  isDefaultFigureSeed,
  sanitizeFigure,
  type FigureConfig,
  type FigureStyle,
} from "@mycontext/design"
import type { OnboardingStepView } from "@mycontext/ipc-contract"

export interface PersonaIdentity {
  name: string
  /**
   * 形象的种子。
   *
   * ★★ 这个值**已经过名字派生**（见 `readPersonaIdentity` 里那一段）——
   * 消费方拿到的就是最终要渲染的那个 seed，不要在自己那边再派生一次。
   */
  figureSeed: string
  /** DiceBear 风格。旧数据里没有这个字段 —— 解析时补缺省 */
  figureStyle?: FigureStyle
  /** 上传的本地图片（`mycontext-file://…`）。有值时**优先于**风格 */
  figureImagePath?: string | null
  /**
   * 逐槽位定制（"QQ 秀"）。
   *
   * ★ 旧数据里**没有**这个字段，而那必须继续正常工作：
   * 没有它时形象仍然完全由 `figureSeed` 决定，行为与加这个字段之前
   * **逐字节一致**。所以这里不需要任何 vault migration ——
   * payload 是 `TEXT` 里的 JSON，加字段不改 schema。
   */
  figureCustom?: FigureConfig
  /**
   * 载入时被 `sanitizeFigure` 裁掉的键数。
   *
   * ## ★ 为什么这个数字必须传出来
   *
   * 裁剪发生在**读取时**，而设置页会把裁剪结果填进 draft、保存时原样写回
   * —— 于是一份不匹配的库数据在**第一次保存时被永久裁掉**，且用户全程无感。
   * 这与本文件下方论证的"静默失效比白屏更难查"是同一件事的另一半：
   * 那边说的是不校验的后果，这里说的是**校验了但不说**的后果。
   *
   * 只是一个计数而不是键名清单：调用方要显示的是"有 N 件没保留"，
   * 而键名（`lips` / `hairAccessoriesColor`）对用户没有意义。
   */
  figureDropped: number
}

/**
 * 缺省身份。
 *
 * `name` 是空串而不是「数字人」：空串表示**用户没设过**，
 * 而展示时的兜底文案是渲染层的事（要走 i18n，这里拿不到 t）。
 * 在这里塞一个中文缺省会让英文界面上冒出一个中文名。
 *
 * `figureSeed` 是 `defaultFigureSeed("")` 的值 —— 空名字派生出的那个 seed，
 * 于是它与下面的派生规则同源，而不是一个碰巧长这样的常量。
 */
export const DEFAULT_PERSONA_IDENTITY: PersonaIdentity = {
  name: "",
  figureSeed: "|0#0",
  figureStyle: DEFAULT_FIGURE_STYLE,
  figureImagePath: null,
  figureCustom: {},
  figureDropped: 0,
}

/** 从库里那一行的 payload 复原。坏数据按缺省处理，不让页面打不开。 */
export function readPersonaIdentity(row: OnboardingStepView | undefined): PersonaIdentity {
  const payload = row?.payload
  if (typeof payload !== "object" || payload === null) return DEFAULT_PERSONA_IDENTITY
  const record = payload as {
    name?: unknown
    figureSeed?: unknown
    figureStyle?: unknown
    figureImagePath?: unknown
    figureCustom?: unknown
  }
  /**
   * ★ 风格要校验成**已知的那几个**，不能原样信库里的串。
   *
   * 旧数据里没有这个字段（那时形象是自己画的几何脸），而一个不认识的
   * 风格 id 会让 `STYLES[style]` 取到 undefined → DiceBear 抛 →
   * 整个页面白屏。落到缺省风格是唯一安全的处理。
   */
  const style = FIGURE_STYLES.find((item) => item === record.figureStyle)
  const resolvedStyle = style ?? DEFAULT_FIGURE_STYLE
  const name = typeof record.name === "string" ? record.name : DEFAULT_PERSONA_IDENTITY.name
  /**
   * 库里存着的原始 seed（没派生过的那个）。
   */
  const storedSeed =
    typeof record.figureSeed === "string" ? record.figureSeed : DEFAULT_PERSONA_IDENTITY.figureSeed
  const { config, dropped } = sanitizeFigure(resolvedStyle, record.figureCustom)
  return {
    name,
    /**
     * ★★ 名字派生**必须在这里**做，不能留给渲染层。
     *
     * ## 那个 bug 长什么样
     *
     * 派生规则曾经只活在 `persona-step.tsx` 的**渲染**里，而
     * `persona-signature.tsx` / `persona-figure-panel.tsx` 用的是裸
     * `figureSeed` —— 于是同一个 `{name:"小小周", figureSeed:"|0#0"}`
     * 在引导页与草稿署名/设置页渲染出**两张不同的脸**
     * （实测两处产物 19760 vs 15183 字符）。
     * 更糟的是回写只挂在名字输入框的 `onChange` 上：用户不重敲名字
     * 就点下一步，**存进库的是 `"|0#0"` 而界面显示的是派生脸**。
     *
     * 这正是本文件头那段话说的形态（"引导里看到形象 A、草稿卡上看到形象 B"）
     * —— 而文件头同时明令**解析只有这一份**。所以修法不是"让另外三处
     * 也记得派生"（那是同一个 bug 的第 2、3、4 个实例），而是把派生
     * 收进这个函数：四个消费方拿到的是**同一个已派生的 seed**。
     *
     * `isDefaultFigureSeed` 为真才接管，所以：
     * · 点过「随机」（seed 变成 `|rN#0`）之后改名字**不会**换脸
     *   —— 用户挑过的东西不该被一次改名覆盖；
     * · 老用户的 seed 里本来就带着自己的名字（`小小周|0#0`），
     *   重新派生得到**同一个串**，逐字节不变。
     */
    figureSeed: resolvePersonaFigureSeed(name, storedSeed),
    figureStyle: resolvedStyle,
    figureImagePath:
      typeof record.figureImagePath === "string" && record.figureImagePath !== ""
        ? record.figureImagePath
        : null,
    /**
     * ★ 定制必须过 `sanitizeFigure`，理由与上面的风格校验同源但更严重：
     * DiceBear 对不认识的槽位/非法变体**静默忽略，从不抛错**
     * （实测 `hair:["variant99"]` 的产物与 `hair:[]` 逐字节相同）。
     * 也就是说不校验的话，用户会看到自己配的部件**悄悄消失一半**
     * 而界面上什么都不说 —— 那比白屏更难查。
     *
     * `dropped` 从 `figureDropped` **带出去**（见那个字段的注释）：
     * 上一版在这里把它丢掉，于是裁剪结果会在设置页第一次保存时
     * 被永久写回，而用户全程无感。只显示形象的调用方
     * （草稿署名）忽略这个字段即可 —— 那是它们的选择，不是这里的默认。
     */
    figureCustom: config,
    figureDropped: dropped.length,
  }
}

/** 从四步进度里挑出 persona 那一行并解析。 */
export function personaIdentityFromSteps(
  steps: readonly OnboardingStepView[] | undefined,
): PersonaIdentity {
  return readPersonaIdentity(steps?.find((row) => row.step === "persona"))
}

/**
 * 名字 → 该用哪个 seed。**派生规则的唯一实现**。
 *
 * ## 为什么要把这三行单独导出
 *
 * `readPersonaIdentity` 处理的是**库里读出来的**数据，而引导页还有第二种
 * 情形：用户正在输入框里逐字敲名字，那个名字还没进库。那时预览要跟着变
 * （"新名字新气象"是既有设计），所以 `PersonaStep` 必须在渲染时也派生一次。
 *
 * 两处各写一遍 `isDefaultFigureSeed(s) ? defaultFigureSeed(n) : s` 就是
 * 本文件头警告的那件事的又一个实例 —— 判据分叉之后，改一处忘一处会让
 * "输入时看到的脸"与"存进去的脸"不同，而那不报错。所以规则在这里，
 * 两个调用点都进来。
 */
export function resolvePersonaFigureSeed(name: string, storedSeed: string): string {
  return isDefaultFigureSeed(storedSeed) ? defaultFigureSeed(name) : storedSeed
}
