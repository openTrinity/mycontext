/**
 * 工具的**语义**：这一步在做什么、该配什么图标。
 *
 * ## 为什么需要这一层
 *
 * ACP 给的工具标识是**通道名**：`bash` / `read` / `skill`。一列 `bash / bash /
 * bash` 等于什么都没说，而"它去查了什么"正是检索模块可信度的一半。
 *
 * 移植参考实现 `toolDisplayTitle` 的思路：**先精确、再模式、最后按 ACP kind
 * 兜底**。顺序即优先级，这样 `read_mail` 不会和 `read_file` 一起退化成同一个
 * 「读取文件」。
 *
 * ## 与参考实现的两处刻意不同
 *
 * ① **文案走 i18n**，不硬编码中文。参考实现整个产品只有中文，
 *    直接 `return '执行命令'`；我们双语（i18n.test.ts 有双语 key 门禁），
 *    所以这里只回**动作键**（`tool.action.execute`），文案由调用方翻。
 * ② `description` 优先级最高。opencode 的 bash 工具带一个模型填的
 *    `description`（「5-10 词说明这条命令干什么」，真进程实测确认），
 *    它比任何我们能猜的映射都准 —— 参考实现没有这个信号（它的 runtime 不给），
 *    所以这是我们比它多的一档。
 */
import type { ReactNode } from "react"
import {
  CircleXIcon,
  FileTextIcon,
  GlobeIcon,
  GraphIcon,
  LightbulbIcon,
  PencilIcon,
  SearchIcon,
  SkillIcon,
  TerminalIcon,
  WrenchIcon,
} from "./tool-icons.js"

/** 动作类型。值即 i18n key 的后缀（`stream.tool.action.<kind>`）。 */
export type ToolAction =
  | "graph"
  | "execute"
  | "read"
  | "edit"
  | "search"
  | "fetch"
  | "think"
  | "skill"
  | "generic"

/** CJK 判定：标题里有中日韩字就说明它已经是人话，不必再翻。 */
const CJK = /[㐀-䶿一-鿿豈-﫿]/

/**
 * 超过这个长度的英文标题不直接显示。
 *
 * 参考实现取 32。理由是一行工具行要跟状态字共处，长标题会把状态挤出可视区；
 * 而**过长的原始标题**通常是模型把整条命令塞进了标题，那种内容属于详情不属于标题。
 */
const MAX_TITLE_LENGTH = 32

/** 精确匹配（全小写比对）。命中即返回，优先级最高。 */
const EXACT: Record<string, ToolAction> = {
  skill: "skill",
  bash: "execute",
  shell: "execute",
  terminal: "execute",
  execute: "execute",
  exec: "execute",
  run: "execute",
  read: "read",
  cat: "read",
  write: "edit",
  edit: "edit",
  apply_patch: "edit",
  search: "search",
  grep: "search",
  glob: "search",
  find: "search",
  fetch: "fetch",
  download: "fetch",
  think: "think",
  reason: "think",
  plan: "think",
}

/** 模式匹配。顺序即优先级 —— 业务工具在前，通用动作在后。 */
const PATTERNS: readonly { pattern: RegExp; action: ToolAction }[] = [
  // 我们自己的图谱工具最先判：它的名字里可能同时含 search/query，
  // 落到通用 search 上就丢了"这条查的是图谱"这个最有价值的信息。
  { pattern: /\bkl\b|kl_|graph|图谱/i, action: "graph" },
  { pattern: /skill/i, action: "skill" },
  { pattern: /apply[_ -]?patch|edit|write|modify/i, action: "edit" },
  { pattern: /search|grep|glob|find|recall|lookup/i, action: "search" },
  { pattern: /read|cat\b|open[_ -]?file/i, action: "read" },
  { pattern: /bash|shell|terminal|execute|\bexec\b|\brun\b|command/i, action: "execute" },
  { pattern: /fetch|download|scrape|crawl|http|url/i, action: "fetch" },
  { pattern: /think|reason|plan|analy/i, action: "think" },
]

/** ACP `kind` 兜底（我们的 mapper 会把它塞进 toolName 当最后手段）。 */
const KIND_FALLBACK: Record<string, ToolAction> = {
  read: "read",
  edit: "edit",
  delete: "edit",
  move: "edit",
  search: "search",
  execute: "execute",
  think: "think",
  fetch: "fetch",
  browser: "fetch",
  other: "generic",
}

const ACTION_ICON: Record<ToolAction, (props: { className?: string }) => ReactNode> = {
  graph: GraphIcon,
  execute: TerminalIcon,
  read: FileTextIcon,
  edit: PencilIcon,
  search: SearchIcon,
  fetch: GlobeIcon,
  think: LightbulbIcon,
  skill: SkillIcon,
  generic: WrenchIcon,
}

/** 终态图标（覆盖动作图标）：失败/取消/跳过本身就是要传达的信息。 */
export const OUTCOME_ICON = {
  error: CircleXIcon,
  skipped: WrenchIcon,
} as const

/** 这个工具属于哪类动作。 */
export function toolActionOf(rawName: string): ToolAction {
  const name = rawName.replace(/^mycontext_/, "").trim()
  if (name === "") return "generic"

  const lower = name.toLowerCase()
  const exact = EXACT[lower]
  if (exact !== undefined) return exact

  for (const { pattern, action } of PATTERNS) {
    if (pattern.test(name)) return action
  }

  const kind = KIND_FALLBACK[lower]
  return kind ?? "generic"
}

export function toolIconOf(action: ToolAction): (props: { className?: string }) => ReactNode {
  return ACTION_ICON[action]
}

/**
 * 这一行标题显示什么。
 *
 * 回 `{ kind: "literal" }` 表示"直接显示这段文字"（模型给的 description
 * 或本来就是中文的标题）；回 `{ kind: "action" }` 表示"显示这个动作的译名"，
 * 由调用方查 i18n。
 *
 * 把「翻不翻」的判断放在这里而不是组件里：它是一串纯规则，可以单测；
 * 塞进组件就只能靠渲染断言间接测。
 */
export function toolTitleOf(
  rawName: string,
): { kind: "literal"; text: string } | { kind: "action"; action: ToolAction } {
  const name = rawName.replace(/^mycontext_/, "").trim()
  const action = toolActionOf(name)

  if (name === "" || /^unknown tool$/i.test(name)) return { kind: "action", action: "generic" }

  // 已经是中文（模型给的 description 或我们自己的文案）→ 原样显示。
  if (CJK.test(name)) return { kind: "literal", text: name }

  // 像标识符的（`kl_query` / `bash` / `mcp__foo`）→ 显示动作译名，
  // 因为标识符对用户没有意义。
  if (isIdentifierLike(name)) return { kind: "action", action }

  // 到这里是"一句英文人话"（bash 的 description）。
  // 短的直接显示（它比我们的映射准）；过长的退回动作译名（会挤掉状态字）。
  if (name.length <= MAX_TITLE_LENGTH) return { kind: "literal", text: name }
  return { kind: "action", action }
}

/**
 * 像不像标识符：全是字母数字下划线点横线、没有空格。
 *
 * 用形状判据而不是白名单：白名单要随 opencode 的工具集变，形状判据不用。
 * 这个函数也决定字体（标识符走 mono）—— 见 ToolCallRow。
 */
export function isIdentifierLike(name: string): boolean {
  return /^[a-z0-9_.:-]+$/i.test(name)
}
