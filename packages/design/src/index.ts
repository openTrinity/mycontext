export { cn } from "./lib/cn.js"
export { useSquircle, attachRefs, superellipsePath } from "./lib/use-squircle.js"
export type { SquircleOptions } from "./lib/use-squircle.js"

export { Button } from "./components/button.js"
export type { ButtonProps, ButtonVariant, ButtonSize } from "./components/button.js"

export { Input } from "./components/input.js"
export type { InputProps, InputSize } from "./components/input.js"

export { Field } from "./components/field.js"
export type { FieldProps } from "./components/field.js"

export { Checkbox } from "./components/checkbox.js"
export type { CheckboxProps } from "./components/checkbox.js"

export { Disclosure } from "./components/disclosure.js"
export type { DisclosureProps } from "./components/disclosure.js"

export { Panel, PanelHeader } from "./components/panel.js"
export type { PanelProps, PanelHeaderProps, PanelTone, PanelPad } from "./components/panel.js"

export { Tooltip } from "./components/tooltip.js"
export type { TooltipProps, TooltipPlacement } from "./components/tooltip.js"

export { IconButton } from "./components/icon-button.js"
export type {
  IconButtonProps,
  IconButtonSize,
  IconButtonVariant,
} from "./components/icon-button.js"

export { BrandMark } from "./components/brand-mark.js"
export type { BrandMarkProps } from "./components/brand-mark.js"

export { BrandWordmark } from "./components/brand-wordmark.js"
export type { BrandWordmarkProps } from "./components/brand-wordmark.js"

export { Tag } from "./components/tag.js"
export type { TagProps, TagSize, TagStatus } from "./components/tag.js"

/**
 * 第三方品牌图标（生成物，见 scripts/sync-brand-icons.mjs）。
 * 保留官方品牌色，不跟随主题——品牌色是识别的一部分。
 */
export { DingTalkIcon } from "./components/brand-icons/index.js"

export { AmbientRings } from "./components/ambient-rings.js"
export type { AmbientRingsProps } from "./components/ambient-rings.js"

// ---------------------------------------------------------------
// 搜索模块（M2）
// ---------------------------------------------------------------

export { GreetingName, FUN_FACES } from "./components/greeting-name.js"
export type { GreetingNameProps } from "./components/greeting-name.js"

export { WelcomeHeader, greetingKeyForHour } from "./components/welcome-header.js"
export type { WelcomeHeaderProps } from "./components/welcome-header.js"

export { Composer } from "./components/composer.js"
export type { ComposerProps, ComposerAttachment } from "./components/composer.js"

// ---------------------------------------------------------------
// 身份与浮层（用户菜单 / 设置弹窗）
// ---------------------------------------------------------------

export { Avatar, avatarInitial, avatarPaletteIndex } from "./components/avatar.js"
export type { AvatarProps, AvatarSize, AvatarShape } from "./components/avatar.js"

export {
  PersonaFigure,
  personaFigureSeeds,
  nextFigureSeed,
  defaultFigureSeed,
  isDefaultFigureSeed,
  FIGURE_STYLES,
  DEFAULT_FIGURE_STYLE,
} from "./components/persona-figure.js"
export type { PersonaFigureProps, FigureStyle } from "./components/persona-figure.js"

/**
 * 形象定制（"QQ 秀"）。
 *
 * `FIGURE_SLOTS` 是**生成物**（scripts/sync-figure-slots.mjs），
 * 导出它是为了让门禁能断言"生成器用的是差集而不是 core 全集"这类判据 ——
 * UI 侧应当用 `figureSlotsFor` / `figureColorSlotsFor` 而不是直接索引它。
 */
export { FigureStudio } from "./components/figure/figure-studio.js"
export type { FigureStudioProps, FigureStudioLabels } from "./components/figure/figure-studio.js"
/**
 * ★ `SlotDrawer` 导出是**给门禁用的**，不是给 apps 用的。
 *
 * apps 侧应当只用 `FigureStudio`（它管着页签、抽屉、颜色、背景的协同）。
 * 单独导出抽屉是为了让"一次只材质化一屏"那条断言能直接量它的
 * `createAvatar` 调用次数 —— 经 `FigureStudio` 量的话，数字里会混进
 * 大预览与 6 张预设图，而那会让阈值变成一个需要解释的魔数。
 */
export { SlotDrawer } from "./components/figure/slot-drawer.js"
export type { SlotDrawerProps } from "./components/figure/slot-drawer.js"
export {
  sanitizeFigure,
  figureToOptions,
  figureIsEmpty,
  figureSlotsFor,
  figureColorSlotsFor,
  figureColorSlotOwner,
  figureSupportsTransparentBackground,
  findSlot,
  withSlot,
  withColor,
  withBackground,
  BACKGROUND_OWNED_KEYS,
  FIGURE_PRESETS,
} from "./components/figure/figure-model.js"
export type { FigureConfig } from "./components/figure/figure-model.js"
export { FIGURE_SLOTS } from "./components/figure/slots.generated.js"
export type { FigureSlot, FigureStyleSlots } from "./components/figure/slots.generated.js"
export {
  ColorSwatches,
  FIGURE_COLOR_OPTIONS,
  FIGURE_BACKGROUND_OPTIONS,
  figureBackgroundOptionsFor,
  TRANSPARENT_COLOR,
} from "./components/figure/color-swatches.js"
export type { ColorSwatchesProps } from "./components/figure/color-swatches.js"

export { Dialog } from "./components/dialog.js"
export type { DialogProps } from "./components/dialog.js"

export { Select } from "./components/select.js"
export type { SelectProps, SelectSize } from "./components/select.js"

export { SegmentedControl } from "./components/segmented-control.js"
export type { SegmentedControlProps, SegmentedOption } from "./components/segmented-control.js"

export { Switch } from "./components/switch.js"
export type { SwitchProps } from "./components/switch.js"

export {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./components/dropdown-menu.js"
export type { DropdownMenuProps, DropdownMenuItemProps } from "./components/dropdown-menu.js"
