/**
 * @vitest-environment jsdom
 *
 * MarkdownBody 与 stripNoise 的行为断言。
 *
 * 为什么值得单独测：assistant 答案是页面的**视觉重心**，而这里的失败模式是
 * "静默降级成裸文本"—— `**粗体**` 原样显示出来不会报错、测试也不会红，
 * 只是界面变丑。所以要断言"真的渲染成了 <strong>"，而不只是"没抛异常"。
 *
 * 真实构造分布（库里 43 条 item 实测）：**粗体** 12、- 列表 5、1. 有序 2、
 * `行内码` 4、--- 1。这些每一种都在下面有对应用例。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"
import { MarkdownBody, stripNoise } from "@renderer/features/agent-stream/markdown-body.js"

afterEach(cleanup)

describe("MarkdownBody · 真实数据里出现的构造", () => {
  it("**粗体** → <strong>（真数据里 12 处，最常见）", () => {
    const { container } = render(<MarkdownBody text="**与小吴讨论晚饭**（2026-07-30）" />)
    const strong = container.querySelector("strong")
    expect(strong?.textContent).toBe("与小吴讨论晚饭")
    // 星号不该漏到页面上
    expect(container.textContent ?? "").not.toContain("**")
  })

  it("- 列表 → <ul><li>", () => {
    const { container } = render(<MarkdownBody text={"- 第一条\n- 第二条"} />)
    expect(container.querySelectorAll("ul li")).toHaveLength(2)
  })

  it("1. 有序列表 → <ol><li>", () => {
    const { container } = render(<MarkdownBody text={"1. 先查图谱\n2. 再核对"} />)
    expect(container.querySelectorAll("ol li")).toHaveLength(2)
  })

  it("`行内码` → <code>（不带 language- 的走行内样式）", () => {
    const { container } = render(<MarkdownBody text="执行 `kl ask 晚饭` 查一下" />)
    const code = container.querySelector("code")
    expect(code?.textContent).toBe("kl ask 晚饭")
    expect(container.textContent ?? "").not.toContain("`")
  })

  it("--- → <hr>", () => {
    const { container } = render(<MarkdownBody text={"上面\n\n---\n\n下面"} />)
    expect(container.querySelector("hr")).not.toBeNull()
  })

  it("## 标题 → <h2>", () => {
    const { container } = render(<MarkdownBody text="## 检索结果" />)
    expect(container.querySelector("h2")?.textContent).toBe("检索结果")
  })

  it("GFM 表格 → <table>（remark-gfm 生效）", () => {
    const { container } = render(
      <MarkdownBody text={"| 人 | 时间 |\n| --- | --- |\n| 小吴 | 12:14 |"} />,
    )
    expect(container.querySelector("table")).not.toBeNull()
    expect(container.querySelectorAll("th")).toHaveLength(2)
  })
})

describe("MarkdownBody · 安全", () => {
  /**
   * ★ 刻意**不开** rehype-raw：答案里含有从聊天记录检索出来的**别人写的内容**，
   * 那是不可信输入。不开 HTML 就等于这条路径上不存在注入面。
   * 这条测试守的是"以后别人顺手把 rehype-raw 加回来"。
   */
  it("原始 HTML 当纯文本处理，不进 DOM", () => {
    const { container } = render(<MarkdownBody text={'<img src=x onerror="alert(1)">'} />)
    expect(container.querySelector("img")).toBeNull()
    // 原文可见（降级成文本），但没有被解析成元素
    expect(container.textContent ?? "").toContain("img")
  })

  it("script 标签不执行也不进 DOM", () => {
    const { container } = render(<MarkdownBody text={"<script>alert(1)</script>"} />)
    expect(container.querySelector("script")).toBeNull()
  })

  it("链接带 rel=noreferrer noopener（防 tabnabbing）", () => {
    const { container } = render(<MarkdownBody text="[看这里](https://example.com)" />)
    const a = container.querySelector("a")
    expect(a?.getAttribute("rel")).toContain("noopener")
    expect(a?.getAttribute("target")).toBe("_blank")
  })
})

describe("stripNoise · 清掉模型的填充符", () => {
  /**
   * 真数据里 assistant 答案会以 `.........` 开头（43 条 item 里 4 次）——
   * 直接糊在页面视觉重心上。
   */
  it("清掉开头的省略号行", () => {
    expect(stripNoise(".........\n\n根据知识图谱的检索结果")).toBe("根据知识图谱的检索结果")
  })

  it("清掉结尾的省略号与分割线", () => {
    expect(stripNoise("答案在此\n\n.......\n---")).toBe("答案在此")
  })

  it("★ 不动正文中间的省略号（那可能是真内容）", () => {
    const text = "他说了一句……\n\n然后就走了"
    expect(stripNoise(text)).toBe(text)
  })

  it("正文中间的分割线保留（markdown 的 hr 是有意义的）", () => {
    const text = "上半段\n\n---\n\n下半段"
    expect(stripNoise(text)).toBe(text)
  })

  it("全是噪音时返回空串（调用方据此不渲染）", () => {
    expect(stripNoise("...\n\n---\n\n....")).toBe("")
  })

  it("普通文本原样返回", () => {
    expect(stripNoise("就是一句普通的答案")).toBe("就是一句普通的答案")
  })
})
