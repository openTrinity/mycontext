/**
 * agent workspace 的 skill 铺设。
 *
 * ## ★ 这一层拦的是一个**能力不存在但不报错**的失效
 *
 * harness 按 cwd 发现 skill（`<cwd>/.opencode/skills/<name>/SKILL.md`）。
 * 铺错目录、漏铺、或者压根没接来源目录时，agent 只是**没有那个能力** ——
 * 没有异常、没有 warn，回答里也看不出来（它会用别的方式糊过去）。
 *
 * 真机上踩到过：`skillsDir` 只有搜索在用，数字分身从来没接 —— 于是
 * 数字人从来没有过图谱查询能力，而这件事在日志与界面上都看不出来。
 *
 * 所以这里逐条锁：目录名、两类来源都要铺、缺失要能区分、非目录不带进去。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { installSkills, SKILLS_RELDIR } from "@mycontext/agent-runtime"

/** 造一个 skill 来源目录：`<root>/<name>/SKILL.md`。 */
function makeSource(names: readonly string[], extraFiles: readonly string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "mycontext-skills-"))
  for (const name of names) {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8")
  }
  for (const file of extraFiles) writeFileSync(join(root, file), "x", "utf8")
  return root
}

function makeCwd(): string {
  return mkdtempSync(join(tmpdir(), "mycontext-ws-"))
}

describe("★ 铺到 harness 真的会去发现的那个目录", () => {
  it("目标是 <cwd>/.opencode/skills/<name>/SKILL.md", () => {
    const cwd = makeCwd()
    const dir = makeSource(["kl"])
    const result = installSkills({ cwd, sources: [{ kind: "bundled", dir }] })
    expect(result.installed).toBe(1)
    /**
     * ★ 断言的是**完整路径**而不是"拷过去了"。
     *
     * 目录名错一个字（`.claude` vs `.opencode`、`skill` vs `skills`）
     * 时 agent 就看不到它，而拷贝本身是成功的 —— 只断言 installed
     * 的话这种错完全测不出来。
     */
    expect(existsSync(join(cwd, ".opencode", "skills", "kl", "SKILL.md"))).toBe(true)
  })

  it("SKILLS_RELDIR 就是那个相对路径（常量与实现必须同源）", () => {
    const cwd = makeCwd()
    const dir = makeSource(["kl"])
    installSkills({ cwd, sources: [{ kind: "bundled", dir }] })
    expect(existsSync(join(cwd, SKILLS_RELDIR, "kl", "SKILL.md"))).toBe(true)
  })
})

describe("★★ 两类来源都要铺（数字分身缺的就是 bundled 这一路）", () => {
  it("bundled + derived 同时铺，互不覆盖", () => {
    const cwd = makeCwd()
    const bundled = makeSource(["kl"])
    const derived = makeSource(["persona-persona"])
    const result = installSkills({
      cwd,
      sources: [
        { kind: "bundled", dir: bundled },
        { kind: "derived", dir: derived },
      ],
    })
    expect(result.installed).toBe(2)
    /**
     * ★ 两个都要在。
     *
     * 这一条锁的是真机上那个 bug 的**反面**：数字人拿到了蒸馏画像
     * （derived）却没有图谱查询（bundled），而两者缺任一都不报错。
     */
    expect(existsSync(join(cwd, SKILLS_RELDIR, "kl", "SKILL.md"))).toBe(true)
    expect(existsSync(join(cwd, SKILLS_RELDIR, "persona-persona", "SKILL.md"))).toBe(true)
    expect(result.missing).toEqual([])
  })

  it("★ 缺哪一类要能区分（两者的下一步完全不同）", () => {
    const cwd = makeCwd()
    const derived = makeSource(["persona-persona"])
    const result = installSkills({
      cwd,
      sources: [
        { kind: "bundled", dir: join(tmpdir(), "mycontext-does-not-exist") },
        { kind: "derived", dir: derived },
      ],
    })
    /**
     * 缺 bundled = 装配问题（没跑 sync:kl-skill / 打包漏了）；
     * 缺 derived = 还没蒸馏过（正常初始状态）。
     * 合成一个布尔的话，"图谱查不了"与"画像还没炼"在日志里长得一样。
     */
    expect(result.missing).toEqual(["bundled"])
    expect(result.installed).toBe(1)
  })

  it("一个来源都没有时不抛，只报 0（能力降级不该让建会话失败）", () => {
    const cwd = makeCwd()
    const result = installSkills({ cwd, sources: [] })
    expect(result.installed).toBe(0)
    expect(result.missing).toEqual([])
  })

  it("空字符串路径当缺失处理（未配置时传的就是它）", () => {
    const cwd = makeCwd()
    const result = installSkills({ cwd, sources: [{ kind: "bundled", dir: "" }] })
    expect(result.missing).toEqual(["bundled"])
  })
})

describe("★ 只带目录进去，不带来源目录里的散文件", () => {
  it("SHA256SUMS 这类非 skill 文件不进 agent 视野", () => {
    const cwd = makeCwd()
    /**
     * `vendor/forge` 里真的有 `SHA256SUMS` / `VERSION` / `README.md`。
     * 整目录 `cpSync` 会把它们一起带进 workspace —— harness 不认，
     * 不报错，只是让 workspace 里多几个说不清来历的文件。
     */
    const dir = makeSource(["kl"], ["SHA256SUMS", "VERSION"])
    const result = installSkills({ cwd, sources: [{ kind: "bundled", dir }] })
    expect(result.installed).toBe(1)
    expect(readdirSync(join(cwd, SKILLS_RELDIR))).toEqual(["kl"])
  })
})

describe("★ 重复铺是幂等的（换代重装靠这一条）", () => {
  it("同一个来源铺两遍，内容仍然正确", () => {
    const cwd = makeCwd()
    const dir = makeSource(["persona-persona"])
    installSkills({ cwd, sources: [{ kind: "derived", dir }] })
    const second = installSkills({ cwd, sources: [{ kind: "derived", dir }] })
    /**
     * 「画像换代后重装 workspace」那条修复完全依赖这个幂等性 ——
     * 它不 dispose agent，只是重跑一次铺设。不幂等的话第二次会抛
     * （目录已存在），而那时在途的 turn 会被打断。
     */
    expect(second.installed).toBe(1)
    expect(existsSync(join(cwd, SKILLS_RELDIR, "persona-persona", "SKILL.md"))).toBe(true)
  })
})
