/**
 * 数字人页面里的小映射表（**不含组件**）。
 *
 * ## 为什么不放在 `conversation-rail.tsx` 里
 *
 * 组件文件里 export 一个非组件的东西会让 vite 的 Fast Refresh 失效
 * （dev 日志里那行 `Could not Fast Refresh ("MODE_KEY" export is
 * incompatible)`）—— 表现是改一行样式整页重挂，而正在编辑的草稿
 * 会被清空。这不是洁癖，是开发时真的会丢东西。
 */
import type { PersonaConversationView } from "@mycontext/ipc-contract"

/** 回复模式 → i18n key。三档，与 contract 的 `REPLY_MODES` 一一对应。 */
export const MODE_KEY: Record<PersonaConversationView["replyMode"], string> = {
  draft: "modeDraft",
  auto: "modeAuto",
  yolo: "modeYolo",
}

/**
 * 下拉框里的顺序：**按风险从低到高**。
 *
 * 不用 `Object.keys(MODE_KEY)`：那个顺序是"写代码时凑巧的顺序"，
 * 而这里的顺序有含义 —— 第一项是缺省也是最安全的那个，
 * 最后一项（`yolo`，不过判定闸直接发）是最危险的那个。
 */
export const MODE_ORDER: readonly PersonaConversationView["replyMode"][] = ["draft", "auto", "yolo"]
