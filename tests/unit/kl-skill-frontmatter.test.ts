/**
 * kl skill 产物的**头部结构**门禁。
 *
 * ## ★★★ 为什么需要它（一次"skill 完全不存在"的静默失效）
 *
 * `withHostPreamble` 原来是 `HOST_PREAMBLE + text` —— 无条件拼在文件最前面。
 * 而 SKILL.md 的开头**不是正文**，是 `---` 包起来的 YAML frontmatter
 * （`name` / `description` 在里面）。拼在前面会把 frontmatter 挤到文件中间，
 * 于是 opencode 解析这个 skill **直接失败并丢掉它**。
 *
 * 实测（打包态真机 + 真 opencode 1.18.11）：
 * · agent 自报「目前没有任何可用的 skill」/ 只有内置的 customize-opencode；
 * · opencode 日志 `message=init count=1`（只有内置那一个）；
 * · 修好之后 `count=2`，且 agent 列出 `kl` ——
 *   两个方向都验过（见那次修复的 commit）。
 * · 全程**没有任何报错**：目录对、文件扫到了，只是解析阶段被丢。
 *
 * 后果是搜索**从来没查过知识图谱** —— 而界面上它照样回答，只是答得像个
 * 什么都不知道的通用模型。本仓库第 4 节说的静默降级，最贵的那一类。
 *
 * ## 判据为什么盯"第一行是 ---"而不是"含有 name:"
 *
 * 后者在 frontmatter 被挤到中间时**仍然成立** —— 那正是坏掉的那一版的形状。
 * 位置才是关键：skill 的 frontmatter 必须在**文件最开头**。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { transformFor, withHostPreamble } from "../../scripts/lib/kl-skill-sanitize.mjs"

const ARTIFACT = join(import.meta.dirname, "../../apps/desktop/resources/skills/kl/SKILL.md")

describe("kl skill 产物的头部结构", () => {
  it("★★★ 产物第一行必须是 frontmatter 的 `---`（不能被前言挤走）", () => {
    const text = readFileSync(ARTIFACT, "utf8")
    const lines = text.split("\n")
    expect(lines[0]).toBe("---")
    // frontmatter 里必须有 name/description —— opencode 靠它们认这个 skill
    const closing = lines.indexOf("---", 1)
    expect(closing).toBeGreaterThan(0)
    const frontmatter = lines.slice(1, closing).join("\n")
    expect(frontmatter).toMatch(/^name:\s*kl$/m)
    expect(frontmatter).toMatch(/^description:\s*\S/m)
  })

  it("宿主前言仍然被注入（只是位置在 frontmatter 之后）", () => {
    const text = readFileSync(ARTIFACT, "utf8")
    expect(text).toContain("由 sync:kl-skill 注入")
    // 前言必须排在 frontmatter 之后、上游正文之前
    const closing = text.indexOf("\n---", 3)
    expect(text.indexOf("由 sync:kl-skill 注入")).toBeGreaterThan(closing)
  })

  it("★ withHostPreamble 不打乱 frontmatter（把它改回 PREAMBLE+text 这条必红）", () => {
    const input = ["---", "name: kl", "description: d", "---", "", "# Body", "text"].join("\n")
    const out = withHostPreamble(input)
    expect(out.split("\n")[0]).toBe("---")
    expect(out).toContain("由 sync:kl-skill 注入")
    // 正文仍在最后
    expect(out.indexOf("# Body")).toBeGreaterThan(out.indexOf("由 sync:kl-skill 注入"))
  })

  it("幂等：已注入过的文本再跑一次不变（不叠第二段前言）", () => {
    const input = ["---", "name: kl", "description: d", "---", "", "# Body"].join("\n")
    const once = withHostPreamble(input)
    expect(withHostPreamble(once)).toBe(once)
  })

  it("没有 frontmatter 时退回原行为（拼最前面，不静默丢前言）", () => {
    const out = withHostPreamble("# Just a body\n")
    expect(out).toContain("由 sync:kl-skill 注入")
    expect(out.startsWith("<!--")).toBe(true)
  })

  it("只有顶层 SKILL.md 加前言，参考资料不加", () => {
    const body = ["---", "name: kl", "description: d", "---", "", "# B"].join("\n")
    expect(transformFor("SKILL.md", body)).toContain("由 sync:kl-skill 注入")
    expect(transformFor("reference/query.md", body)).not.toContain("由 sync:kl-skill 注入")
  })
})
