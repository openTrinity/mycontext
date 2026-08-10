/**
 * ★★ `work.md` 必须被**两条**回复路径读到。
 *
 * ## 这个文件锁的是一次真实发生过的疏漏
 *
 * work 层（LLM 抽的职责/任务/流程/规矩）的管道曾经全部接通 —— 攒批判据、
 * 落盘回调、forge 的 `externalSkillFiles` 豁免、设置页开关 —— 而**没有任何人
 * 读那个文件**：
 *
 * · 直连降级路的参考件白名单里没有它；
 * · ACP 路只发 `SKILL.md` 让 agent 自取，而 forge 的 `SKILL.md` 里那张文件
 *   索引表没有它 → agent 不知道有这个文件。
 *
 * 后果不是报错，而是**整层白做**：文件照写、每轮蒸馏照付费抽取（实测一轮
 * 约 80 万 token），而回复时它不存在。这正是 LLM 那半当年被整个关掉的形态
 * （`distill.service.ts` 文件头：产出没人读、成本照付、且不报错）。
 *
 * ## 为什么用两条独立断言而不是一条
 *
 * 两条路的**机制不同**：直连路靠 TS 里的白名单数组，ACP 路靠 vendor 里的
 * markdown 表格。修一处不会让另一处变绿，所以必须分别断言 —— 而这也是
 * 这个疏漏能同时出现在两处的原因。
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { WORK_LAYER_SKILL_PATH } from "@main/services/persona-gate.js"

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..")

describe("★★ work.md 必须有读者（两条路各自）", () => {
  /**
   * 直连降级路：`readGuidance` 把参考件正文全部拼进 system prompt
   * （那条路没有 skill 机制，agent 无法自取）。
   *
   * ★ 用源码断言而不是跑 `readGuidance`：那个方法是 private，且要
   * 构造完整的 PersonaService + 一个真实的 forge 产物目录。而这里要守的
   * 性质很窄 —— "那个白名单里有它" —— 源码断言直接对上它，且读起来
   * 就是它要防的那件事。
   */
  it("★★ 直连路的参考件白名单里有 work.md", () => {
    const source = readFileSync(
      join(REPO_ROOT, "apps/desktop/src/main/services/persona.service.ts"),
      "utf8",
    )
    // 取 `agentReadsSkills ? [...] : [...]` 那个三元里的直连分支
    const match = /agentReadsSkills\s*\n?\s*\?\s*\[[^\]]*\]\s*\n?\s*:\s*(\[[^\]]*\])/.exec(source)
    expect(match, "找不到参考件白名单 —— readGuidance 的结构变了，这条断言要跟着改").not.toBeNull()
    const directBranch = match?.[1] ?? ""
    expect(
      directBranch.includes("WORK_LAYER_SKILL_PATH") || directBranch.includes("work.md"),
      "直连路读不到 work.md → work 层白做（照抽、照付费、没人读）",
    ).toBe(true)
  })

  /**
   * ACP 路：agent 通过 `skills.paths` 自取，而它**怎么知道有哪些文件**
   * 来自 `SKILL.md` 的索引表。表里没有 = agent 不会去读。
   *
   * ★ 断言的是 vendor 里的**模板**（发布出的那份由它渲染而来）：
   * `rsync --delete` 式的上游升级会把模板盖回去，而那种丢失是静默的。
   * 已在 `vendor/forge/README.md` 的升级表里登记。
   */
  it("★★ forge 的 SKILL.md 索引表里有 work.md（ACP 路靠它发现文件）", () => {
    const skill = readFileSync(join(REPO_ROOT, "vendor/forge/templates/persona/SKILL.md"), "utf8")
    expect(
      skill.includes(`\`${WORK_LAYER_SKILL_PATH}\``),
      "ACP 路的 agent 不知道有这个文件 → 不会去读 → work 层白做",
    ).toBe(true)
  })

  /**
   * ★ 索引表里那一行必须说清**它不是授权**。
   *
   * 一份写着「他负责 X、他会做 Y」的清单读起来非常像"X 的问题你可以答"。
   * 而能不能答只由 `decisions.md` 决定。这两件事混起来不报错 —— agent 会
   * 拿着一份很有底气的能力清单去答一个本该草稿的问题，而每一层看起来都正常。
   */
  it("★ 索引表那一行写明了「不是授权」", () => {
    const skill = readFileSync(join(REPO_ROOT, "vendor/forge/templates/persona/SKILL.md"), "utf8")
    const row = skill.split("\n").find((line) => line.includes(WORK_LAYER_SKILL_PATH)) ?? ""
    expect(row.toLowerCase()).toContain("decisions.md")
    expect(row.toLowerCase()).toContain("permission")
  })

  /**
   * ★ 常量只能有一份。
   *
   * 三个消费者（forge 配置的豁免、startup 的落盘路径、persona 的白名单）
   * 各写一份字面量必然漂，而漂的表现是静默的：写在 A 路径、读 B 路径，
   * 文件在磁盘上却没人读。
   */
  it("★ WORK_LAYER_SKILL_PATH 只在一处定义", () => {
    const files = [
      "apps/desktop/src/main/services/persona-gate.ts",
      "apps/desktop/src/main/services/forge.service.ts",
      "apps/desktop/src/main/services/persona.service.ts",
      "apps/desktop/src/main/bootstrap/startup.ts",
    ]
    const definitions = files.filter((rel) =>
      /export const WORK_LAYER_SKILL_PATH\s*=/.test(readFileSync(join(REPO_ROOT, rel), "utf8")),
    )
    expect(definitions, "定义超过一处 = 两份字面量会漂").toEqual([
      "apps/desktop/src/main/services/persona-gate.ts",
    ])
  })
})
