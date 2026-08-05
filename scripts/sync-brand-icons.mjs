#!/usr/bin/env node
/**
 * 把 packages/design/src/assets/brands/*.svg 生成为 React 组件。
 *
 * 做法参考参考实现的图标同步脚本：SVG 原文件是来源真相，`.tsx` 是产物。
 * 好处是更新官方标识时只需替换 SVG 再跑一次，不用在 JSX 里手工改 path
 * （那种改法几乎必然抄错一两个坐标，而且看不出改了什么）。
 *
 * 与那边的关键差别：**不做 currentColor 化**。
 * 品牌色是识别的一部分，钉钉不该因为切到暗色主题就变个颜色。
 * 我们自己的界面图标才需要跟随文字色，那些手写在各 feature 的 icons.tsx 里。
 *
 * 用法：pnpm sync:brand-icons
 */
import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const assetsDir = join(root, "packages/design/src/assets/brands")
const outDir = join(root, "packages/design/src/components/brand-icons")

/** dingtalk → DingTalkIcon。渠道 id 到组件名的映射要稳定，因此写死特例。 */
const COMPONENT_NAMES = {
  dingtalk: "DingTalkIcon",
}

function componentName(base) {
  if (COMPONENT_NAMES[base] !== undefined) return COMPONENT_NAMES[base]
  return `${base
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")}Icon`
}

/**
 * 清理 SVG 使其能作为 JSX 内联：
 * - 去掉 XML 声明与注释
 * - 去掉固定 width/height（尺寸由 className 控制，否则 size-* 不生效）
 * - 属性名转驼峰（JSX 不认 stroke-width 这类连字符属性）
 */
function toJsxChildren(svg) {
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "")
  return (
    inner
      .replace(/<\?xml[^?]*\?>/g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\s+/g, " ")
      // 标签之间的空白在 JSX 里会变成 {" "} 文本节点：既无意义，
      // 又让 prettier 每次格式化的结果与生成结果不一致。
      .replace(/>\s+</g, "><")
      .replace(/([a-z]+)-([a-z])/g, (match, head, next) =>
        // 只转 SVG 属性名，不动 path 数据里的内容
        ["stroke", "fill", "clip", "stop", "font"].includes(head)
          ? `${head}${next.toUpperCase()}`
          : match,
      )
      .trim()
  )
}

function viewBoxOf(svg, base) {
  const match = /viewBox="([^"]+)"/.exec(svg)
  if (match === null) throw new Error(`${base}.svg 缺少 viewBox，无法生成可缩放组件`)
  return match[1]
}

const files = readdirSync(assetsDir).filter((name) => name.endsWith(".svg"))
if (files.length === 0) {
  console.error(`未找到任何 SVG：${assetsDir}`)
  process.exit(1)
}

const generated = []
for (const file of files) {
  const base = file.replace(/\.svg$/, "")
  const name = componentName(base)
  const svg = readFileSync(join(assetsDir, file), "utf8")

  const source = `/**
 * ${name} — 由 scripts/sync-brand-icons.mjs 从 assets/brands/${file} 生成。
 *
 * 请勿手改：改 SVG 原文件后重跑 pnpm sync:brand-icons。
 * 保留原始品牌色（不做 currentColor 化）——品牌色是识别的一部分。
 */
export function ${name}({ className }: { className?: string }) {
  return (
    <svg
      viewBox="${viewBoxOf(svg, base)}"
      fill="none"
      className={className}
      role="img"
      aria-hidden="true"
    >
      ${toJsxChildren(svg)}
    </svg>
  )
}
`
  writeFileSync(join(outDir, `${base}.tsx`), source)
  generated.push({ base, name })
  console.log(`生成 ${base}.tsx（${name}）`)
}

const index = `/**
 * 第三方品牌图标 —— 由 scripts/sync-brand-icons.mjs 生成，请勿手改。
 */
${generated.map(({ base, name }) => `export { ${name} } from "./${base}.js"`).join("\n")}
`
writeFileSync(join(outDir, "index.ts"), index)

/**
 * 生成后立刻跑一遍 prettier。
 *
 * 否则产物过不了 format:check，而且「跑生成器」与「跑 format」会各自改一遍文件，
 * diff 里就看不出到底是资产变了还是格式变了。
 */
const format = spawnSync("pnpm", ["exec", "prettier", "--write", `${outDir}/`], {
  cwd: root,
  stdio: "ignore",
})
if (format.status !== 0) {
  console.error("prettier 格式化失败，请手动执行：pnpm exec prettier --write " + outDir)
  process.exit(format.status ?? 1)
}

console.log(`已生成 ${generated.length} 个品牌图标组件`)
