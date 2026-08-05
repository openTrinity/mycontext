/**
 * MarkdownBody — assistant 答案的 Markdown 渲染。
 *
 * ## 为什么必须有这一层
 *
 * 真实数据里 assistant 的答案是 Markdown（库里 43 条 item 实测：`**粗体**` 12 处、
 * `- 列表` 5 处、`1. 有序` 2 处、`` `行内码` `` 4 处、`---` 1 处）。
 * 不渲染的话页面上就是一片 `**与小吴讨论晚饭**` 裸着星号 —— 而这是页面的
 * **视觉重心**，最不该出问题的地方。
 *
 * ## 移植边界
 *
 * 参考实现的 `MarkdownBody` 是 829 行，挂着 react-markdown + remark-gfm +
 * remark-math + rehype-katex + rehype-raw + rehype-sanitize + hast-util-sanitize
 * + unified + katex CSS。我们搬的是它的**元素样式表**（每个 h1/p/ul/li/code
 * 的排版参数，逐条映射到 mycontext token）与 react-markdown + remark-gfm 这个
 * 底座；**不搬**这四样：
 *
 * · `remark-math` / `rehype-katex` —— 数学公式。检索答案里没有，
 *   而 katex 的 CSS 有 300KB+；
 * · `rehype-raw` / `rehype-sanitize` —— 允许原始 HTML 再消毒。
 *   ★ 我们**刻意不开** HTML：答案文本里含有从聊天记录检索出来的
 *   **别人写的内容**，那是不可信输入。不开 rehype-raw 就等于这条路径上
 *   不存在 HTML 注入面（react-markdown 默认把 HTML 当纯文本），
 *   比"开了再 sanitize"少一整类风险；
 * · 链接的 HoverCard/Popover 预览 —— 那要 2 个额外组件 + 域名解析，
 *   而检索答案里链接是 0 处（实测）。链接仍可点，只是没有悬浮卡。
 */
import { memo } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@mycontext/design"

/**
 * 元素样式表。参数（间距/字号/行高/字重）照参考实现，颜色全部换成 mycontext token。
 *
 * `text-[1.4em]` 这类相对字号也照搬：标题相对**正文**缩放，
 * 这样同一个组件放进 15px 的答案区与 13px 的详情区都成比例。
 */
const COMPONENTS: Components = {
  p: ({ children }) => <p className="mb-[var(--spacing-lg)] leading-7 last:mb-0">{children}</p>,

  h1: ({ children }) => (
    <h1 className="mt-[var(--spacing-xxxxl)] mb-[var(--spacing-l)] text-[1.4em] font-semibold leading-8 tracking-[-0.018em] first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-[var(--spacing-xxxl)] mb-[var(--spacing-l)] text-[1.2em] font-semibold leading-7 tracking-[-0.012em] first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-[var(--spacing-xxl)] mb-[var(--spacing-md)] text-[1.067em] font-semibold leading-7 tracking-[-0.008em] first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-[var(--spacing-xl)] mb-[var(--spacing-xs)] font-semibold leading-6 first:mt-0">
      {children}
    </h4>
  ),

  // 列表用 list-outside：标记悬在文字块外面，多行条目的第二行才会与第一行
  // 对齐（inside 会让它缩回标记下面，中文长条目下特别明显）。
  ul: ({ children }) => (
    <ul className="my-[var(--spacing-l)] ml-[var(--spacing-xxl)] list-outside list-disc space-y-px leading-7 marker:text-[var(--text-base-tertiary)]">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-[var(--spacing-l)] ml-[var(--spacing-xxl)] list-outside list-decimal space-y-px leading-7 marker:text-[var(--text-base-tertiary)]">
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li className="pl-0.5 leading-7 [&>ol]:my-1 [&>p]:mb-0 [&>ul]:my-1">{children}</li>
  ),

  strong: ({ children }) => (
    <strong className="font-semibold text-[var(--text-base-primary)]">{children}</strong>
  ),
  em: ({ children }) => <em className="italic text-[var(--text-base-secondary)]">{children}</em>,
  del: ({ children }) => (
    <del className="text-[var(--text-base-tertiary)] decoration-[var(--text-base-tertiary)]">
      {children}
    </del>
  ),

  blockquote: ({ children }) => (
    <blockquote className="my-[var(--spacing-lg)] border-l-2 border-[var(--border-light)] py-0.5 pl-[var(--spacing-lg)] leading-7 text-[var(--text-base-secondary)] [&>p:last-child]:mb-0">
      {children}
    </blockquote>
  ),

  hr: () => (
    <hr className="my-[var(--spacing-xl)] border-0 border-t border-[var(--border-divider-light)]" />
  ),

  /**
   * 行内码与代码块共用 `code`（react-markdown 用 `className` 里的
   * `language-*` 区分：有语言的是块、没有的是行内）。
   */
  code: ({ className, children }) => {
    const isBlock = /language-/.test(className ?? "")
    if (isBlock) {
      return (
        <code className="typography-body-small-400 font-mono-token block overflow-x-auto leading-relaxed">
          {children}
        </code>
      )
    }
    return (
      <code className="font-mono-token rounded-[var(--radius-sm)] bg-[var(--bg-card-z0)] px-1 py-px text-[0.9em]">
        {children}
      </code>
    )
  },
  pre: ({ children }) => (
    <pre className="my-[var(--spacing-lg)] overflow-x-auto rounded-[var(--radius-md)] bg-[var(--bg-card-z0)] p-[var(--spacing-lg)]">
      {children}
    </pre>
  ),

  // GFM 表格。外层套一个可横向滚动的容器 —— 宽表格不该把整条事件流撑宽。
  table: ({ children }) => (
    <div className="my-[var(--spacing-lg)] w-full overflow-x-auto rounded-[var(--radius-md)] border border-[var(--border-divider-light)]">
      <table className="min-w-full border-collapse text-[0.933em] leading-6">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-[var(--border-divider-light)] bg-[var(--bg-card-z0)] px-[var(--spacing-lg)] py-[var(--spacing-md)] text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-[var(--border-divider-light)] px-[var(--spacing-lg)] py-[var(--spacing-md)] align-top last:border-b-0">
      {children}
    </td>
  ),

  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-[var(--status-link)] underline decoration-[var(--status-link)]/30 underline-offset-2 hover:decoration-[var(--status-link)]"
    >
      {children}
    </a>
  ),
}

export interface MarkdownBodyProps {
  text: string
  className?: string | undefined
}

/**
 * `memo`：流式回答期间父组件每来一个 token 就重渲染，
 * 而已经定稿的那些 message 的 text 没变 —— 不 memo 的话每个 token
 * 都要把整条事件流的 markdown 全部重新 parse 一遍。
 */
export const MarkdownBody = memo(function MarkdownBody({ text, className }: MarkdownBodyProps) {
  return (
    <div className={cn("min-w-0 break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

/**
 * 清掉模型在答案首尾留下的填充噪音。
 *
 * 真数据里 assistant 答案会以 `.........` / `.......` 开头（模型的思考填充符，
 * 43 条 item 里 4 次）—— 它直接糊在页面的视觉重心上。
 *
 * **只清首尾**：正文中间的省略号可能是真内容（"等等……"），一律清掉会改写答案。
 */
export function stripNoise(text: string): string {
  const lines = text.split("\n")
  const isNoise = (line: string): boolean =>
    /^\s*$/.test(line) || /^\s*(?:\.{3,}|-{3,}|_{3,}|。{3,})\s*$/.test(line)
  let start = 0
  let end = lines.length
  while (start < end && isNoise(lines[start] ?? "")) start += 1
  while (end > start && isNoise(lines[end - 1] ?? "")) end -= 1
  return lines.slice(start, end).join("\n")
}
