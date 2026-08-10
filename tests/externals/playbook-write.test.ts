/**
 * ★★ 手动跑一次 playbook 并**写进应用真实的 `work.md`**。
 *
 * ## 为什么需要这个（而不是等应用自己跑）
 *
 * work 层的循环现在遇到建图会主动让路（`work layer refresh yielded`），
 * 而 playbook 排在 facet 之后 —— 于是建图持续跑时它永远等不到。
 * 那是一个真实的调度冲突（记在待办里），但用户要先看到产物长什么样。
 *
 * ★ 这个脚本走的是**产品里同一批函数**（`readPlaybookChunks` →
 * `inducePlaybooks` → `renderWorkLayer`），只是由外部触发。所以它证明的是
 * "这条链路能产出什么"，不是"应用会自己产出" —— 后者要等调度修好。
 *
 * ★ 产物含真实工作内容：控制台只打**结构与长度**，正文写进那个 md
 * （那是它本来的落点，权限 0600）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import { createLogger } from "@mycontext/kernel"
import { LlmClient } from "@mycontext/llm"
import {
  inducePlaybooks,
  readPlaybookChunks,
  renderWorkLayer,
  selectSources,
  PLAYBOOK_SUGGESTED_TIMEOUT_MS,
} from "@mycontext/distill"
import { ProfileFacetRepository, SelfIdentityRepository } from "@mycontext/store"
import type { SqliteDatabase } from "@mycontext/store"
import { findRichestVaultDir } from "./lib/find-vault.js"

/**
 * ★ 运行时**发现** vault，不写死 id —— vault id 是真实标识（CLAUDE.md §1.1），
 * 一个字符都不该进仓库。没有本机 vault 时为 null，用例 skipIf 跳过。
 */
const VAULT = findRichestVaultDir()
const KL_DB = VAULT === null ? "" : join(VAULT, "kl", "knowledge.db")
const CORE_DB = VAULT === null ? "" : join(VAULT, "core.sqlite")
/** 应用真实的落点（`WORK_LAYER_SKILL_PATH`）。 */
const WORK_MD = join(VAULT, "forge", "skills", "persona-persona", "references", "work.md")

describe("★★ 手动跑 playbook 并写进真实 work.md", () => {
  const ready = existsSync(KL_DB) && existsSync(CORE_DB)

  it.skipIf(!ready)(
    "读图 → 归纳 → 渲染 → 落盘",
    async () => {
      const kl = new Database(KL_DB, { readonly: true }) as unknown as SqliteDatabase
      const core = new Database(CORE_DB, { readonly: true }) as unknown as SqliteDatabase

      const identity = new SelfIdentityRepository(core).get("dingtalk")
      const selfNames = identity?.displayNames ?? []
      expect(selfNames.length, "身份未确认").toBeGreaterThan(0)

      // ① 读候选（产品同一个函数）
      const candidates = readPlaybookChunks(kl, { selfNames, limit: 3000 })
      const eligible = selectSources(candidates, Number.MAX_SAFE_INTEGER)

      const client = new LlmClient({
        baseUrl: (process.env["MYCONTEXT_LLM_BASE_URL"] ?? "").trim(),
        apiKey: (process.env["MYCONTEXT_LLM_API_KEY"] ?? "").trim(),
        model: (process.env["MYCONTEXT_MODEL_MAIN"] ?? "glm-5.2").trim(),
        logger: createLogger("Playbook", { level: "error" }),
        timeoutMs: PLAYBOOK_SUGGESTED_TIMEOUT_MS,
        // 建图可能同时在跑 —— 串行发，别加剧网关拥塞
        concurrency: 1,
      })

      // ② 归纳（跑 2 批 = 8 个 chunk，比 e2e 那次多一点）
      const result = await inducePlaybooks(candidates, { client, selfNames, maxBatches: 2 })

      // ③ 渲染：facet + playbook 一起（这才是真实产物的样子）
      const facets = new ProfileFacetRepository(core).listByScope("global", "")
      const rendered = renderWorkLayer(facets, {
        displayName: identity?.displayNames[0] ?? "本人",
        nowMs: Date.now(),
        ...(result.playbooks.length === 0
          ? {}
          : { playbookSection: { playbooks: result.playbooks, coverage: result.coverage } }),
      })

      console.error(
        [
          "",
          `候选（本人有发言）：${String(result.coverage.candidates)} / ${String(candidates.length)}`,
          `带流程痕迹：        ${String(eligible.length)}`,
          `本轮送进模型：      ${String(result.coverage.sampled)}`,
          "",
          `归纳出 playbook：${String(result.playbooks.length)} 条（结构不合格丢 ${String(result.droppedInvalid)}）`,
          `用量：${String(result.calls)} 次调用 / ${String(result.costTokens)} token`,
          "",
          ...result.playbooks.map(
            (b, i) =>
              `  ${String(i + 1)}. <名称 ${String(b.name.length)} 字> ${String(b.stages.length)} 步 ` +
              `带常问 ${String(b.stages.filter((s) => s.asks !== "").length)} 步`,
          ),
          "",
          `facet 进产物：${String(rendered.included)} 条`,
          `产物大小：    ${String((rendered.content ?? "").length)} 字符（旧的 ${String(existsSync(WORK_MD) ? readFileSync(WORK_MD, "utf8").length : 0)}）`,
        ].join("\n"),
      )

      // ④ 落盘到应用真实的位置（0600 —— 含蒸馏出的工作内容）
      if (rendered.content !== null) {
        mkdirSync(dirname(WORK_MD), { recursive: true, mode: 0o700 })
        writeFileSync(WORK_MD, rendered.content, { encoding: "utf8", mode: 0o600 })
      }

      expect(rendered.content, "渲染出空产物").not.toBeNull()
      ;(kl as unknown as Database.Database).close()
      ;(core as unknown as Database.Database).close()
    },
    900_000,
  )
})
