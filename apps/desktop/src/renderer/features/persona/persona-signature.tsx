/**
 * PersonaSignature —— 草稿的**署名**：这条是谁起草的。
 *
 * ## 为什么草稿必须有署名
 *
 * 这一页最主要的动作是审草稿（实测 127 次 run 全是 `drafted`），
 * 而用户审的是"**以我的身份**要发出去的一句话"。那时最需要确认的一件事是
 * 归属：这句话不是我写的，是数字人替我写的。
 *
 * 没有署名时草稿卡就是一段光秃秃的正文，与"我自己写的草稿"在视觉上
 * 无从区分 —— 而这两者的信任级别完全不同（一个要逐字核对，一个不用）。
 *
 * ## ★ 摆在草稿卡里，不是页面顶部
 *
 * 草稿是它的**产出物**，归属信息贴着产出物才有意义。
 * 摆在页面顶部只是一句装饰 —— 用户在看第 7 张草稿卡时，
 * 顶部那个头像已经滚出视野了。
 *
 * ## 形象与名字同源于引导页
 *
 * 数据来自 `onboarding_progress` 的 persona 行，解析走
 * `persona-identity.ts`（与引导页同一份，见那个文件的文件头）。
 * 名字为空（用户跳过了引导 —— 库里那一步真的是 `skipped`）时
 * 回落到 i18n 的「数字人」，而不是留白：留白会让这张卡看起来缺了点东西。
 */
import { PersonaFigure } from "@mycontext/design"
import { useOnboardingSteps } from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { personaIdentityFromSteps } from "./persona-identity.js"

export interface PersonaSignatureProps {
  className?: string
}

export function PersonaSignature({ className }: PersonaSignatureProps) {
  const { t } = useDynamicTranslation("persona")
  const steps = useOnboardingSteps()
  const identity = personaIdentityFromSteps(steps.data)
  const name = identity.name === "" ? t("personaFallbackName") : identity.name

  return (
    <span
      className={`typography-caption-400 flex min-w-0 items-center gap-1 text-[var(--text-base-tertiary)] ${className ?? ""}`}
    >
      <PersonaFigure
        seed={identity.figureSeed}
        {...(identity.figureStyle === undefined ? {} : { style: identity.figureStyle })}
        imageSrc={identity.figureImagePath ?? null}
        /**
         * ★ 定制必须透传，否则草稿署名上的形象与设置里看到的**不是同一个人**
         * —— 而这个文件头刚说过"那两个本该是同一个人"。
         * 少传这一个 prop 的表现很隐蔽：形象仍然显示（seed 还在），
         * 只是丢掉了用户挑的头发眼镜，看起来像"设置没保存成功"。
         */
        custom={identity.figureCustom}
        size={16}
      />
      {/* 名字可截：用户能取任意长的名字，而它不该把这一行撑开 */}
      <span className="min-w-0 truncate">{t("draftBy", { name })}</span>
    </span>
  )
}
