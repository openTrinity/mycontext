/**
 * 设置页的「形象」块 —— 不重走引导就能改数字分身的长相。
 *
 * ## 为什么需要它
 *
 * 改动前想换形象**只能重走引导**（设置页的 persona 栏只有运行参数）。
 * 而形象是一个会反复调的东西（"今天想换个发型"），把它藏在一次性的
 * 引导流程后面等于实际上不可改。
 *
 * ## ★ 组件与引导页共用（`FigureStudio`）
 *
 * 不是为了少写代码：`persona-identity.ts` 的文件头记录过教训 ——
 * 两处各自实现会导致"引导里看到形象 A、草稿卡上看到形象 B"。
 * 共用一个受控组件，两个调用方只决定**什么时候落盘**。
 *
 * ## ★★ 保存必须带**全量** payload（这是本文件最危险的一处）
 *
 * `stepDone(step, payload)` 是**整体覆盖写**，不是 patch。
 * 只发 `{ figureCustom }` 会把 `name` / `figureSeed` / `figureStyle` /
 * `figureImagePath` **全部抹掉** —— 而那个 bug 的表现是延迟的：
 * 保存的一瞬间界面上形象是对的，要等下次读草稿署名时才发现名字没了。
 * 所以先 `personaIdentityFromSteps` 读现值、展开、再覆盖改动的字段。
 * 有一条单测与一条 CDP 断言专门锁这件事。
 *
 * ## ★★ 名字为空时不许保存（同一类问题的第二个实例）
 *
 * 全量 payload 只保证"不丢已有的 name"，**不保证 name 本身有效**。
 * 一个从没走过引导的用户在这里点保存会写进 `name: ""` 并把 persona 步
 * 标成 done —— 引导页的"名字必填"守卫从此永远不再触发。
 * 所以按钮在名字为空时禁用，见下方 `nameMissing`。
 *
 * ## ★ 副作用：会把 persona 步标成 done
 *
 * `stepDone("persona", …)` 的语义就是"这一步完成了"。对一个在设置里
 * 认真配形象的用户来说这是**对的**（他确实配好了）；但如果他原本是
 * `skipped`，状态会从"已跳过"变成"已完成"。
 * 这是**有意**的，不是 bug —— 同一个设置页里的 `OnboardingPanel`
 * 会显示这个状态变化，所以用户看得见，不算静默。
 * 界面上也用一行小字说明了（`persona.figure.sideEffect`）。
 *
 * ## 显式保存，不逐次自动存
 *
 * 与 `identity-panel.tsx` 同一个理由：形象虽然是点选的，但它和 `name`
 * 在**同一个 payload** 里，而名字是逐字输入的。一起显式保存最简单，
 * 也让"我还在挑"与"我挑好了"可区分。
 */
import { useEffect, useState } from "react"
import {
  Button,
  Disclosure,
  FigureStudio,
  PersonaFigure,
  type FigureConfig,
  type FigureStyle,
} from "@mycontext/design"
import { DEFAULT_FIGURE_STYLE } from "@mycontext/design"
import { useCompleteStep, useOnboardingSteps } from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { useErrorText } from "../../lib/use-error-text.js"
import { personaIdentityFromSteps } from "../persona/persona-identity.js"
import { useFigureLabels } from "../persona/use-figure-labels.js"
import { ImagePicker } from "../shared/image-picker.js"

/** 表单里可改的部分。`name` 不在这里 —— 它由 `IdentityPanel` 那一栏管。 */
interface FigureDraft {
  style: FigureStyle
  seed: string
  custom: FigureConfig
  imagePath: string | null
}

/**
 * 两个草稿是否等价 —— 用它判断「已保存」还该不该显示。
 *
 * ## ★ 为什么需要它
 *
 * 上一版的判据是 `complete.isSuccess`，而那个标志**一旦为真就不再变回去**：
 * 实测保存成功后再点一个变体，「已保存」仍然挂着 —— 于是用户看到的是
 * 一句在说谎的提示（当前这个样子并没有保存）。
 * `advanced-ai.tsx` 也这么写，但那一栏是几个输入框；这个面板**每点一格
 * 就是一次改动**，所以同一个写法在这里误导性高得多。
 *
 * 比对走 `JSON.stringify` 而不是逐字段：`custom` 是嵌套对象，
 * 而这里要的正是"深比较"。键顺序在这里**不会**造成假阳性 ——
 * 两边都来自同一条修改链（保存时拿的就是当前 draft 的引用），
 * 顺序天然一致；即便偶发不一致，后果也只是提示早消失一次，
 * 而不是"点了没反应"那一类。
 */
function sameDraft(left: FigureDraft, right: FigureDraft): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function PersonaFigurePanel() {
  const { t } = useDynamicTranslation("settings")
  const { t: tc } = useDynamicTranslation("common")
  const errorText = useErrorText()
  const labels = useFigureLabels()
  const steps = useOnboardingSteps()
  const complete = useCompleteStep()

  /**
   * 库里的现值。**保存时也要用它**（见文件头：payload 是覆盖写），
   * 所以这里不只是回填表单的来源。
   */
  const identity = personaIdentityFromSteps(steps.data)

  const [draft, setDraft] = useState<FigureDraft | null>(null)
  /**
   * 上一次**成功保存**的那份草稿。
   *
   * 有它才能判出 dirty（见 `sameDraft`）——「已保存」必须在下一次改动时
   * 消失，否则它会变成一句恒亮的话，而恒亮的提示等于没有提示
   * （`FigureStudio` 的 `droppedCount` 也为同一件事写过一段）。
   */
  const [savedDraft, setSavedDraft] = useState<FigureDraft | null>(null)
  /**
   * 载入时被裁掉的键数，**只在首次回填时记一次**。
   *
   * ## ★ 为什么这个提示必须存在
   *
   * `readPersonaIdentity` 会把库里不匹配当前风格的键裁掉（DiceBear 对
   * 它们静默忽略，不裁的话用户会看到部件悄悄消失一半）。但裁剪结果会
   * 被填进 draft，**保存时原样写回** —— 于是一份不匹配的库数据在
   * 第一次保存时被**永久**裁掉，而用户全程无感。
   *
   * 所以裁了就说一次。不跟着 refetch 重算：那会让这句话在用户
   * 保存之后又冒出来一次（那时已经没有东西被裁了）。
   */
  const [droppedOnLoad, setDroppedOnLoad] = useState(0)

  /**
   * 回填一次。
   *
   * 之后不跟着 refetch 覆盖 —— 用户正在挑发型时被服务端数据盖回去，
   * 表现是"点了没反应"（与引导页 `hydrated` 那一段同一个理由）。
   * 保存成功后 `steps` 会 invalidate，但那时 `draft` 已经等于新值，
   * 所以不重置也不会显示旧数据。
   */
  useEffect(() => {
    if (draft !== null || steps.data === undefined) return
    setDraft({
      style: identity.figureStyle ?? DEFAULT_FIGURE_STYLE,
      seed: identity.figureSeed,
      custom: identity.figureCustom ?? {},
      imagePath: identity.figureImagePath ?? null,
    })
    // 载入时裁掉了东西就说一次（见 droppedOnLoad 的注释）
    setDroppedOnLoad(identity.figureDropped)
  }, [draft, steps.data, identity])

  /**
   * ★★ 查询失败必须是它**自己的分支**，不能与 pending 合成一个。
   *
   * 上一版写的是 `if (steps.isPending || draft === null)` → 显示「读取中…」。
   * 而全局 `retry: false`（`main.tsx`），所以失败是**终态**：实测
   * `pending=false error=true data=undefined` —— 面板永久停在「读取中…」，
   * 既不说发生了什么，也没有重试的路。用户看到的是"设置页坏了"，
   * 而"一直在转"与"坏了"在用户侧不可区分。
   *
   * 三种状态各自一个分支：
   * · `isPending` —— 真的在读；
   * · `isError` —— 读失败了，用 `errorText` 说清（对齐 `OnboardingPanel`
   *   对 `restart.error` 的既有做法），重试走 refetch；
   * · `draft === null` —— 读到了但还没回填（上面那个 effect 差一帧）。
   */
  if (steps.isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="typography-body-small-400 text-[var(--status-error)]">
          {errorText(steps.error)}
        </p>
        <Button
          size="sm"
          variant="secondary"
          disabled={steps.isFetching}
          onClick={() => void steps.refetch()}
        >
          {tc("app.retry")}
        </Button>
      </div>
    )
  }

  if (steps.isPending || draft === null) {
    return (
      <p className="typography-body-small-400 text-[var(--text-base-secondary)]">
        {t("persona.loading")}
      </p>
    )
  }

  /**
   * ★★ 名字为空时**不许保存** —— 这是本文件第二处会真的丢数据的地方。
   *
   * 一个从没走过引导的用户（persona 行 `state: "pending"`、`payload: null`）
   * 在这里点保存，实测发出的是
   * `{"name":"","figureSeed":"|0#0",…}` 并把 persona 步标成 **done**。
   * 于是引导页 `onboarding-view.tsx` 的"名字必填"守卫**从此再也不会触发**
   * （那一步已经 done 了），草稿署名永久回落到兜底文案「数字分身」。
   *
   * 表现同样是**延迟的**：保存那一刻界面上形象是对的，要等下次看草稿
   * 署名才发现数字人没名字了 —— 与文件头记的 payload 覆盖写同一类。
   *
   * 用 `trim()` 而不是 `=== ""`：一串空格作为名字与空名字等价
   * （引导页的守卫用的也是 `trim()`，两处判据必须同源，否则会出现
   * "引导里过不去、设置里存得下"这种更难查的不一致）。
   *
   * 文案 `persona.figure.needsName` i18n 里本来就有（zh/en 都有），
   * 只是之前没有任何地方用它 —— 这个判断当时写了一半。
   */
  const nameMissing = identity.name.trim() === ""

  /**
   * 当前草稿与上次保存的那份是否不同。
   *
   * `savedDraft === null`（这一轮还没保存过）时不算 dirty ——
   * 那时「已保存」本来就不显示，没有要收起的东西。
   */
  const dirty = savedDraft !== null && !sameDraft(draft, savedDraft)

  const save = () => {
    // 保存成功后拿它做 dirty 的基准（见 sameDraft）
    const snapshot = draft
    complete.mutate(
      {
        step: "persona",
        payload: {
          /**
           * ★ 全量：先铺现有身份，再覆盖这个面板管的四个字段。
           * 少铺一次 `name` 就是一次真实的数据丢失（见文件头）。
           * 空名字走不到这里 —— 上面的 `nameMissing` 已经禁用了按钮。
           */
          name: identity.name,
          figureSeed: snapshot.seed,
          figureStyle: snapshot.style,
          figureImagePath: snapshot.imagePath,
          figureCustom: snapshot.custom,
        },
      },
      {
        onSuccess: () => {
          setSavedDraft(snapshot)
          /**
           * 裁剪提示在保存后**必须**消失：那一刻裁剪结果已经落库了，
           * 而"有 N 件没保留"说的是一件已经发生完的事。留着它会让
           * 用户以为还有东西待处理。
           */
          setDroppedOnLoad(0)
        },
      },
    )
  }

  return (
    <Disclosure
      title={t("persona.figure.title")}
      hint={t("persona.figure.description")}
      /**
       * ★ 默认**收起**。
       *
       * 形象定制是一大块（8 风格 + 11 部位 + 一屏缩略图 + 颜色 + 背景圆角 +
       * 6 预设），而它是"配一次就不再动"的东西 —— 与「自动发送」那种要
       * 反复来改的不同。收起时把它压成一行（标题 + 当前形象缩略图），
       * 整个设置页打开就是几张干净的卡片，而不是一屏平铺的控件。
       *
       * 收起态右侧放一个**当前形象**的小预览：不展开也能确认"现在长这样"。
       */
      summary={
        draft.imagePath === null ? (
          <PersonaFigure
            seed={draft.seed}
            style={draft.style}
            custom={draft.custom}
            size={28}
            className="rounded-[var(--radius-sm)]"
          />
        ) : (
          <PersonaFigure
            seed={draft.seed}
            style={draft.style}
            imageSrc={draft.imagePath}
            size={28}
            className="rounded-[var(--radius-sm)]"
          />
        )
      }
    >
      <div className="flex flex-col gap-[var(--gap-section-md)]">
        <div className="flex items-center gap-1">
          {/*
            上传图片那条路与引导页完全一致（`mycontext-file://`，
            主进程按魔术字节校验后落 userData）。**不要顺手"优化"成 `file://`**
            —— CSP 里没有那一条，渲染层加载本地图片只有这一条合法路径。
          */}
          <ImagePicker
            purpose="figure"
            label={draft.imagePath === null ? tc("imagePicker.pick") : tc("imagePicker.replace")}
            disabled={complete.isPending}
            onPicked={(path) => setDraft({ ...draft, imagePath: path })}
          />
          {/*
            有上传图片时给一个"用生成的形象"—— 否则用户上传之后就再也回不到
            定制界面了（那些控件点了也没反应，因为图片优先级更高）。
            与引导页同一个判断，见 persona-step.tsx。
          */}
          {draft.imagePath === null ? null : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDraft({ ...draft, imagePath: null })}
            >
              {t("persona.figure.useGenerated")}
            </Button>
          )}
        </div>

        <FigureStudio
          style={draft.style}
          seed={draft.seed}
          value={draft.custom}
          imageSrc={draft.imagePath}
          labels={labels}
          onChange={(next) =>
            setDraft({ ...draft, style: next.style, seed: next.seed, custom: next.custom })
          }
        />

        <span className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={complete.isPending || nameMissing} onClick={save}>
            {t("persona.figure.save")}
          </Button>
          {/*
          禁用要**说明理由**：一个点不动的按钮而不说为什么，
          与"坏了"在用户侧不可区分（这一条是本仓库反复出现的形态）。
          指路到引导页，因为名字那一栏在那里。
        */}
          {nameMissing ? (
            <span className="typography-caption-400 text-[var(--status-warning)]" role="status">
              {t("persona.figure.needsName")}
            </span>
          ) : null}
          {/*
          「已保存」在**下一次改动时收起**（`dirty`）。
          上一版只看 `complete.isSuccess`，而那个标志一旦为真就不再变回去
          —— 实测保存后再点一个变体，提示仍然挂着，也就是它在说谎。
        */}
          {complete.isSuccess && !complete.isPending && !dirty ? (
            <span className="typography-caption-400 text-[var(--status-success)]" role="status">
              {t("persona.figure.saved")}
            </span>
          ) : null}
          {complete.error === null ? null : (
            <span className="typography-caption-400 text-[var(--status-error)]">
              {errorText(complete.error)}
            </span>
          )}
        </span>

        {/*
        ★ 载入时被裁掉的东西要说一次（见 droppedOnLoad 的注释）：
        不说的话那份不匹配的库数据会在第一次保存时被**永久**裁掉，
        而用户全程无感 —— 那正是本仓库反复记录的静默失效形态。
        文案与 `FigureStudio` 里"换风格后有 N 件没保留"共用一条
        （用户要知道的是同一件事：有 N 件没能保留）。
      */}
        {droppedOnLoad > 0 ? (
          <span className="typography-caption-400 text-[var(--status-warning)]" role="status">
            {labels.droppedNotice(droppedOnLoad)}
          </span>
        ) : null}

        {/* 副作用要说出来，见文件头 */}
        <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {t("persona.figure.sideEffect")}
        </span>
      </div>
    </Disclosure>
  )
}
