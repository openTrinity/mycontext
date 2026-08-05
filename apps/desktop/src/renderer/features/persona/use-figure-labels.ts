/**
 * `useFigureLabels` —— 把 i18n 拼成 `FigureStudio` 要的 `labels` 对象。
 *
 * ## 为什么这个 hook 必须存在（而不是两个调用方各拼一遍）
 *
 * `FigureStudio` 在 `packages/design` 里，而那个包对 `@mycontext/*`
 * **零依赖**、`tsconfig` 无 `references`，且有明文约定：
 * `welcome-header.tsx` 的注释写着「这个函数在 design 包里（不该知道语言）」，
 * `Composer` 收的是 `attachLabel` / `sendLabel` 这类 props。
 * 所以文案只能由调用方注入 —— 而调用方有**两个**（引导页与设置页）。
 *
 * 两处各拼一遍的后果不是"重复代码"这种整洁问题：`persona-identity.ts`
 * 的文件头记录过同形的教训 —— 两处各自解析导致"引导里看到形象 A、
 * 草稿卡上看到形象 B"。文案同理，两边漏改一个就是同一个界面两种说法。
 *
 * ## ★ 兜底为什么落在这里
 *
 * 槽位清单是**生成物**（`scripts/sync-figure-slots.mjs`），会随 DiceBear 变。
 * i18n 一致性测试只拦得住**已知**的缺失 key，拦不住"生成器长出了一个新槽位"。
 * 没有兜底时那种情况会在界面上显示一串原样的 `personaStep.slots.xxx`。
 * 兜底显示英文槽位名（`freckles`）不好看，但比显示一个 key 好得多。
 * 先例：`identity-panel.tsx` 的 `t(\`identity.avatarMiss.${reason}\`, { defaultValue: … })`。
 */
import { useMemo } from "react"
import type { FigureStudioLabels, FigureStyle } from "@mycontext/design"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

/**
 * 「有 N 件没保留」里 N 的上限。
 *
 * `sanitizeFigure` 的 `dropped` 没有上界（实测 5000 个垃圾键 → 5000），
 * 超过这个数就换一条"超过 N 件"的文案，见下方 `droppedNotice`。
 */
const DROPPED_COUNT_CAP = 99

export function useFigureLabels(): FigureStudioLabels {
  const { t } = useDynamicTranslation("onboarding")

  /**
   * `useMemo` 是必需的，不是习惯：`labels` 是个对象，每次重渲染新建一个
   * 会让 `FigureStudio` 的整棵子树跟着重渲染 —— 而那棵子树里最多有
   * 64 个缩略图（实测累计 851KB 字符串）。
   *
   * `t` 在语言切换时会换引用，所以它进依赖数组是对的（换语言要重算文案）。
   */
  return useMemo(
    () => ({
      slotLabel: (slotKey) => t(`personaStep.slots.${slotKey}`, { defaultValue: slotKey }),
      styleLabel: (style: FigureStyle) => t(`personaStep.styles.${style}`, { defaultValue: style }),
      presetLabel: (presetId) =>
        t(`personaStep.figure.presetNames.${presetId}`, { defaultValue: presetId }),
      noneLabel: t("personaStep.figure.none"),
      /**
       * ★ 数字设上限。
       *
       * `dropped` 的长度**无上界**：实测喂 5000 个垃圾键会得到
       * `dropped.length === 5000`，于是提示变成"有 5000 件没保留"
       * —— 一句荒谬的话。数据来自本地 vault 所以这不是攻击面，
       * 但一个手改过的 payload 就能得到它，而荒谬的提示会让用户
       * 怀疑整个界面（"它到底知不知道自己在干什么"）。
       *
       * 超限走**另一条文案**（"超过 99 件"）而不是把 `count` 换成
       * 字符串 `"99+"`：`count` 是 i18next 的复数触发键，塞字符串进去
       * 会让将来有人加 `dropped_one` / `dropped_other` 时复数选择
       * **静默失准**。也不截断成 `99` —— 那是在谎报数量。
       */
      droppedNotice: (count) =>
        count > DROPPED_COUNT_CAP
          ? t("personaStep.figure.droppedMany", { count: DROPPED_COUNT_CAP })
          : t("personaStep.figure.dropped", { count }),
      styleGroup: t("personaStep.figure.styleGroup"),
      styleSection: t("personaStep.figure.styleSection"),
      detailSection: t("personaStep.figure.detailSection"),
      quickStyles: t("personaStep.figure.quickStyles"),
      presets: t("personaStep.figure.presets"),
      colors: t("personaStep.figure.colors"),
      background: t("personaStep.figure.background"),
      radius: t("personaStep.figure.radius"),
      followDefault: t("personaStep.figure.followDefault"),
      moreColors: (count) => t("personaStep.figure.moreColors", { count }),
      fewerColors: t("personaStep.figure.fewerColors"),
      /**
       * 这三条都带**部件名**（"眼镜" / "耳饰"），而部件名走的是
       * `slotLabel` 那条带兜底的路 —— 所以调用方（`FigureStudio`）
       * 传进来的已经是可见文案，这里直接插值即可。
       *
       * 插值键叫 `part` 而不是 `name`：这个 namespace 里 `name` 已经
       * 用在"数字分身的名字"上了（`personaStep.nameLabel` 一带），
       * 两个含义共用一个键名迟早会有人插错。
       */
      colorNeedsPart: (partLabel) => t("personaStep.figure.colorNeedsPart", { part: partLabel }),
      colorPartMaybeAbsent: (partLabel) =>
        t("personaStep.figure.colorPartMaybeAbsent", { part: partLabel }),
      enablePart: (partLabel) => t("personaStep.figure.enablePart", { part: partLabel }),
      random: t("personaStep.figure.random"),
      reset: t("personaStep.figure.reset"),
    }),
    [t],
  )
}
