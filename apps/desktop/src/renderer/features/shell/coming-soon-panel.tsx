/**
 * ComingSoonPanel — 未开放模块的占位内容。
 *
 * 侧栏项虽然禁用，但用户仍可能通过键盘聚焦后回车触达；此外这里也是
 * 模块落地前的说明位。写清「为什么还没有」与「何时会有」，
 * 而不是一个空白页或「敬请期待」。
 */
import { BrandMark } from "@mycontext/design"
import type { ModuleManifest } from "./modules.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

export function ComingSoonPanel({ module }: { module: ModuleManifest }) {
  const { t } = useDynamicTranslation()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-[var(--gap-section-lg)] px-8 text-center">
      <BrandMark size={44} className="text-[var(--text-base-tertiary)]" />
      <div className="flex max-w-[420px] flex-col gap-[var(--gap-component-md)]">
        <h2 className="typography-title-base-600 text-[var(--text-base-primary)]">
          {t("modules.comingSoonTitle", { module: t(module.labelKey) })}
        </h2>
        <p className="typography-body-base-400 text-[var(--text-base-secondary)]">
          {t(module.descriptionKey)}
        </p>
      </div>
    </div>
  )
}
