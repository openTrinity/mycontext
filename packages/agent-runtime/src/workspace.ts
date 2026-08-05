/**
 * agent workspace 的 skill 铺设 —— **两条链路（搜索 / 数字分身）唯一一份**。
 *
 * ## 为什么必须复制进 workspace，而不是让 agent 去读资源目录
 *
 * harness 的 skill 发现是**按 cwd** 走的（`<cwd>/.opencode/skills/<name>/SKILL.md`，
 * 真进程实测锁定，见 `tests/externals/acp-e2e.test.ts`）。只把 skill 同步到
 * `resources/skills/` 而不铺进 workspace，agent **看不到它** —— 表现是
 * "图谱查不了"，而日志里什么都没有：没有报错，只是那个能力不存在。
 *
 * 每会话一份副本而不是软链：workspace 是 agent **可写的**，软链会让它有机会
 * 写穿到我们的资源目录（那是所有会话共享的）。复制的代价是每会话几十 KB。
 *
 * ## ★ 为什么抽成一个模块
 *
 * 抽出来之前，"往 workspace 里铺 skill"这件事有**两份**实现：
 * `SearchService.installSkills`（铺随包的 kl）与
 * `PersonaService.installForgeSkills`（铺蒸馏产物）。两份都在往
 * `<cwd>/.opencode/skills` 拷，但：
 *
 * · 目标目录名是各自写死的字符串 —— 改一处就漂；
 * · 数字分身**完全没接** `skillsDir`，所以 kl 图谱查询到不了它
 *   （grep 证实：`skillsDir` 只有 search 在用）；
 * · 失败语义不一致（一个 warn 一个 info，而两者都是"能力降级"）。
 *
 * 现在一个 `installSkills` 收两类来源：随包的（kl）与用户派生的（蒸馏产物）。
 *
 * ## ★ 两类来源的生命周期不同，所以分开声明而不是拼一个路径
 *
 * · **bundled** —— 随包发版，全账号共用，只读（`resources/skills`）；
 * · **derived** —— 用户蒸馏的产物，按 vault 隔离，会被重新蒸馏覆盖
 *   （`<vault>/forge/skills`）。
 *
 * 合成"一个 skills 根"看起来更整齐，但那会让重新蒸馏有机会覆盖掉随包的 kl，
 * 而那个错误是静默的（图谱查询突然没了，且没人改过 kl）。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Logger } from "@mycontext/kernel"

/**
 * harness 发现 skill 的目录名。
 *
 * ★ 是 `.opencode/skills` 而不是 `.claude/skills`：两者 opencode 都认，
 * 但只能有一个是我们写的那个 —— 真机上曾同时存在两份（`.claude/skills/kl`
 * 是 7-30 那版 ACP 时代的残留），而"agent 到底读了哪份"无从判断。
 *
 * 常量而不是各处写字符串：改目录名时必须一处改完，否则漂掉的那一处
 * 表现为"某个 skill 没生效"而不报错。
 */
export const SKILLS_RELDIR = join(".opencode", "skills")

/** 一处 skill 来源。`kind` 只进日志 —— 它让"哪一类没铺上"看得出来。 */
export interface SkillSource {
  kind: "bundled" | "derived"
  /** 绝对路径。不存在 = 能力降级，不是错误 */
  dir: string
}

export interface InstallSkillsResult {
  /** 铺进去了几个 skill（子目录数）。0 = agent 没有任何外部能力 */
  installed: number
  /** 哪些来源缺失（`kind` 列表，给日志与 UI 用） */
  missing: readonly SkillSource["kind"][]
}

/**
 * 把若干来源的 skill 铺进一个 workspace。
 *
 * **不抛**：skill 缺失是能力降级（图谱查不了 / 没有测量出的画像），
 * 而建会话本身仍该成功 —— 用户至少还能用兜底路径。调用方据 `installed`
 * 决定要不要在 UI 上明示降级。
 *
 * ★ 逐个子目录拷而不是整目录 `cpSync`：来源目录里可能有 `SHA256SUMS`
 * 之类的非 skill 文件（`vendor/forge` 就有），整拷会把它们也带进 agent 的
 * 视野。而 harness 只认 `<name>/SKILL.md` 这个形状，多出来的文件不会报错，
 * 只是让 workspace 里多几个说不清来历的东西。
 */
export function installSkills(options: {
  cwd: string
  sources: readonly SkillSource[]
  logger?: Logger
}): InstallSkillsResult {
  const target = join(options.cwd, SKILLS_RELDIR)
  const missing: SkillSource["kind"][] = []
  let installed = 0

  for (const source of options.sources) {
    if (source.dir === "" || !existsSync(source.dir)) {
      missing.push(source.kind)
      continue
    }
    try {
      mkdirSync(target, { recursive: true })
      for (const entry of readdirSync(source.dir)) {
        const from = join(source.dir, entry)
        if (!statSync(from).isDirectory()) continue
        cpSync(from, join(target, entry), { recursive: true })
        installed += 1
      }
    } catch (error) {
      /**
       * 拷失败也只记日志。
       *
       * ★ 但要记 `kind` 与路径：一个"agent 没有图谱能力"的现象，
       * 原因可能是没蒸馏过、也可能是磁盘满了 —— 不记的话这两者
       * 在日志里长得一样。
       */
      options.logger?.warn("skill install failed", {
        kind: source.kind,
        dir: source.dir,
        detail: error instanceof Error ? error.message : String(error),
      })
      missing.push(source.kind)
    }
  }

  return { installed, missing }
}
