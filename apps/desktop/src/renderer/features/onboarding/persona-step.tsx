/**
 * 数字人这一步：名称 + 形象。
 *
 * ## 形象有三种来源，优先级从高到低
 *
 * 1. **上传的本地图片** —— 用户显式给的，不该被别的覆盖；
 * 2. **DiceBear 风格 + seed + 逐槽位定制**（见 `FigureStudio`），
 *    完全离线生成（见 `PersonaFigure` 的文件头：为什么不用它的 HTTP API）；
 * 3. 名字派生的缺省 seed。
 *
 * ## ★ 为什么把「风格按钮 + 8 宫格 + 换一个」换成 `FigureStudio`
 *
 * 那三个控件合起来只有两个旋钮（`style` / `seed`），换一个形象 = 抽奖，
 * 想"就把头发换了"做不到 —— 而 DiceBear 本来就支持逐槽位钉死
 * （notionists 的组合空间实测约 4×10^11）。旧界面等于在一个 10^11 的
 * 空间上只开了 8 个抽样口。
 *
 * **"换一个"这个能力没有丢**：它变成了 `FigureStudio` 里的「随机」，
 * 底层仍是派生而不是 `Math.random`（后者会让"刚才那个更好看"再也找不回来）。
 *
 * **"改名字换一批脸"这个能力也没有丢**：`figureSeed` 还是名字派生的缺省值
 * （`|0#0` 形态）时，改名字会跟着换脸；用户点过「随机」之后就不再跟 ——
 * 挑过的东西不该被一次改名覆盖。
 * 派生规则本身在 `persona-identity.ts`（**四个消费方共用一份**，
 * 见那个文件头：规则漏在它外面时引导页与草稿署名会是两张脸）。
 *
 * 名字是必填：草稿与日志里都要用它称呼这个数字人，
 * 空名字会让那些界面出现"（未命名）"这种占位，不如在这里挡住。
 */
import {
  Button,
  Field,
  FIGURE_STYLES,
  FigureStudio,
  Input,
  type FigureConfig,
  type FigureStyle,
} from "@mycontext/design"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { resolvePersonaFigureSeed } from "../persona/persona-identity.js"
import { useFigureLabels } from "../persona/use-figure-labels.js"
import { ImagePicker } from "../shared/image-picker.js"
import { StepSection } from "./step-section.js"

export interface PersonaDraft {
  name: string
  figureSeed: string
  /** DiceBear 风格。旧数据里没有这个字段 —— 调用方补缺省 */
  figureStyle?: FigureStyle
  /** 上传的本地图片路径。有值时**优先于**风格 */
  figureImagePath?: string | null
  /**
   * 逐槽位定制。旧数据里没有这个字段 ——
   * 没有它时形象完全由 `figureSeed` 决定，与改动前逐字节一致。
   */
  figureCustom?: FigureConfig
}

export interface PersonaStepProps {
  value: PersonaDraft
  onChange: (next: PersonaDraft) => void
  /** 名字为空时提交过一次 —— 用它决定是否显示必填提示 */
  showNameError: boolean
  /**
   * 有没有一个**能跑数字分身**的已授权渠道。
   *
   * ## ★★ 判据是渠道能力（`sendAs`），不是渠道 id
   *
   * 分身的本质是"以我的身份发消息"，而只读接入的渠道刻意不给这个能力
   * （飞书 `sendAs: []`，见它的 `index.ts` 头注释）。所以只连了那类渠道时
   * 这一步填的东西**暂时不会生效** —— 要说清，否则用户填完名字与形象，
   * 之后发现分身一直不说话而找不到原因。
   *
   * ★ 只显示说明、**不禁用表单**：填了仍然有意义（连上主渠道后立刻生效），
   * 而禁用会让用户以为"这个功能坏了"。
   */
  personaHostConnected: boolean
}

export function PersonaStep({
  value,
  onChange,
  showNameError,
  personaHostConnected,
}: PersonaStepProps) {
  const { t } = useDynamicTranslation("onboarding")
  const { t: tc } = useDynamicTranslation("common")
  /** 文案由调用方注入 —— design 包不该知道语言（见 use-figure-labels.ts） */
  const figureLabels = useFigureLabels()

  /** 名字为空且提交过 → 显示必填提示。抽成局部量让下面两处判断同源。 */
  const nameMissing = showNameError && value.name.trim() === ""
  const style = value.figureStyle ?? FIGURE_STYLES[0]
  const imagePath = value.figureImagePath ?? null

  /**
   * 用户没自己挑过形象时，seed **跟着名字走**。
   *
   * ## ★★ 派生规则**不在这个文件里** —— 它在 `persona-identity.ts`
   *
   * 上一版把规则写在这里（渲染时算一次、`onChange` 里再算一次），而
   * `persona-signature.tsx` / `persona-figure-panel.tsx` 用的是裸
   * `figureSeed` —— 于是同一份数据在引导页与草稿署名上是**两张不同的脸**
   * （实测产物 19760 vs 15183 字符）。那不是"另外两处漏了"，
   * 是规则漏在了唯一解析入口的外面。
   *
   * 现在 `readPersonaIdentity` 已经派生过了，所以回填进来的 `value.figureSeed`
   * 本身就是最终要用的那个。这里仍要再调一次，只为一种情形：
   * **用户正在输入框里逐字敲名字**，那个名字还没进库也还没回填。
   * 两处调的是**同一个函数**，所以不会再分叉。
   */
  const seed = resolvePersonaFigureSeed(value.name, value.figureSeed)

  return (
    <div className="flex flex-col gap-[var(--gap-section-md)]">
      {/*
        ★★ 没有能跑分身的渠道 → 说清"填了暂时不生效"（见 props 注释）。

        放在最前面：它是读下面这些表单的**前提**，放在末尾等于让用户填完才知道。
      */}
      {personaHostConnected ? null : (
        <p className="typography-body-small-400 rounded-[var(--radius-md)] bg-[var(--status-fill-warning-container)] px-3 py-2 text-[var(--status-warning)]">
          {t("personaStep.noPersonaHost")}
        </p>
      )}

      <StepSection title={t("personaStep.nameSection")}>
        <Field
          label={t("personaStep.nameLabel")}
          {...(nameMissing ? { error: t("personaStep.nameRequired") } : {})}
          required
        >
          {(attributes) => (
            <Input
              {...attributes}
              size="lg"
              value={value.name}
              placeholder={t("personaStep.namePlaceholder")}
              error={nameMissing}
              /**
               * ★ 改名字时把派生的 seed **一起写回草稿**。
               *
               * 派生现在也发生在读取侧（`readPersonaIdentity`），所以少了这一步
               * 也不会再出现"两张脸"——下次读回来时会重新派生。但仍然要写：
               * 库里存的值应当**等于屏幕上的那个**，否则任何不经
               * `readPersonaIdentity` 的读取方（CDP 探针直接读 payload、
               * 将来的导出/诊断）看到的是 `"|0#0"` 而界面是另一张脸，
               * 而那种不一致查起来要先怀疑三个地方。
               *
               * 用共享的 `resolvePersonaFigureSeed` 而不是自己判一次：
               * 判据分叉过一次了（见上方 `seed` 的注释）。
               */
              onChange={(event) => {
                const name = event.target.value
                onChange({
                  ...value,
                  name,
                  figureSeed: resolvePersonaFigureSeed(name, value.figureSeed),
                })
              }}
            />
          )}
        </Field>
      </StepSection>

      {/*
        形象独占一个分区，右上角放"上传本地图片"。

        ★ 上传是**另一条路**（图片优先级高于一切生成参数），所以它该在
        分区的动作位而不是混在那些生成控件里 —— 混在里面会让用户以为
        它是又一个"风格"。
      */}
      <StepSection
        title={t("personaStep.avatarLabel")}
        hint={imagePath === null ? t("personaStep.avatarHint") : t("personaStep.uploadedHint")}
        action={
          <span className="flex items-center gap-1">
            <ImagePicker
              purpose="figure"
              label={imagePath === null ? tc("imagePicker.pick") : tc("imagePicker.replace")}
              onPicked={(path) => onChange({ ...value, figureImagePath: path })}
            />
            {/*
              有上传图片时给一个"用生成的形象"—— 否则用户上传之后
              就再也回不到定制界面了（那些控件点了也没反应，
              因为图片优先级更高）。
            */}
            {imagePath === null ? null : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onChange({ ...value, figureImagePath: null })}
              >
                {t("personaStep.useGenerated")}
              </Button>
            )}
          </span>
        }
      >
        <FigureStudio
          style={style}
          /**
           * seed 仍然由名字派生（见上方 `seed` 的注释：没自己挑过时
           * 跟着名字走），未定制的槽位靠它决定 ——
           * 这让"只改了头发，其余保持原样"成立。
           */
          seed={seed}
          value={value.figureCustom ?? {}}
          imageSrc={imagePath}
          labels={figureLabels}
          /**
           * 三个字段一起回传：换风格会连带 sanitize 后的 custom，
           * 「随机」会连带新 seed。分三个 callback 的话调用方要自己
           * 保证这三者一致，而那正是"两处不一致"的成因。
           */
          onChange={(next) =>
            onChange({
              ...value,
              figureStyle: next.style,
              figureSeed: next.seed,
              figureCustom: next.custom,
            })
          }
        />
      </StepSection>
    </div>
  )
}
