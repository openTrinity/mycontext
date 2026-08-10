/**
 * ★★ playbook 全链路：**真图库 → 归纳 → 渲染进 work.md**。
 *
 * 与 `playbook-probe.test.ts`（那个只验"归纳这一步做不做得出来"）的区别：
 * 这个走**产品里真正的那条路** —— `readPlaybookChunks` → `inducePlaybooks`
 * → `renderWorkLayer`，用的是同一批导出的函数。
 *
 * 也就是说它同时验：
 * · 读图库那一层能不能真的取到候选（`selfSpoke` 的判定对不对）；
 * · 归纳出来的东西能不能过结构校验（`validatePlaybook`）；
 * · 渲染出来的 `work.md` 里覆盖率那一行在不在。
 *
 * ★ 没有本机图库时**跳过而不是失败**（同事/CI 上没有）——
 * 所以它绿了不等于验过，只有在有真图的机器上跑过才算。
 *
 * ★ 产物含真实工作内容：只统计结构与打印**长度**，正文写到 /tmp 供人工看，
 * 一个字都不进日志（同 `check:no-local-data` 那道门禁的口径）。
 */
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
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
import type { SqliteDatabase } from "@mycontext/store"
import { findRichestVaultDir } from "./lib/find-vault.js"

/**
 * ★ 运行时**发现** vault，不写死 id —— vault id 是真实标识（CLAUDE.md §1.1），
 * 一个字符都不该进仓库。没有本机 vault 时为 null，用例 skipIf 跳过。
 */
const VAULT = findRichestVaultDir()
const KL_DB = VAULT === null ? "" : join(VAULT, "kl", "knowledge.db")
const CORE_DB = VAULT === null ? "" : join(VAULT, "core.sqlite")

describe("★★ playbook 全链路（真图库；没有图时跳过）", () => {
  const ready = existsSync(KL_DB) && existsSync(CORE_DB)

  it.skipIf(!ready)(
    "读图库 → 归纳 → 渲染，且覆盖率进产物",
    async () => {
      const kl = new Database(KL_DB, { readonly: true }) as unknown as SqliteDatabase
      const core = new Database(CORE_DB, { readonly: true })

      const identity = core
        .prepare("select display_names_json from channel_self_identity limit 1")
        .get() as { display_names_json: string } | undefined
      const selfNames = JSON.parse(identity?.display_names_json ?? "[]") as string[]
      expect(selfNames.length, "身份未确认，这个验证无意义").toBeGreaterThan(0)

      // ① 读候选（产品里就是这一个函数）
      const candidates = readPlaybookChunks(kl, { selfNames, limit: 3000 })
      const eligible = selectSources(candidates, Number.MAX_SAFE_INTEGER)

      const client = new LlmClient({
        baseUrl: (process.env["MYCONTEXT_LLM_BASE_URL"] ?? "").trim(),
        apiKey: (process.env["MYCONTEXT_LLM_API_KEY"] ?? "").trim(),
        model: (process.env["MYCONTEXT_MODEL_MAIN"] ?? "glm-5.2").trim(),
        logger: createLogger("Playbook", { level: "error" }),
        // ★ 归纳慢（实测 4 个 chunk 用 230s），必须放宽 —— 见那个常量的注释
        timeoutMs: PLAYBOOK_SUGGESTED_TIMEOUT_MS,
        // 网关对并发敏感（建图时 12 并发就让这条路 524），这里串行
        concurrency: 1,
      })

      // ② 归纳。★ 只跑 1 批：这个用例的目的是验通路，不是把全量抽完
      const result = await inducePlaybooks(candidates, {
        client,
        selfNames,
        maxBatches: 1,
      })

      // ③ 渲染进 work.md（产品里的同一个函数）
      const rendered = renderWorkLayer([], {
        displayName: "本人",
        nowMs: 1_786_000_000_000,
        playbookSection: { playbooks: result.playbooks, coverage: result.coverage },
      })

      const report = [
        "",
        `候选 chunk（本人有发言）：${String(candidates.filter((c) => c.selfSpoke).length)} / ${String(candidates.length)}`,
        `带流程痕迹（进得了归纳）：${String(eligible.length)}`,
        `本轮送进模型：            ${String(result.coverage.sampled)}`,
        "",
        `归纳出 playbook：${String(result.playbooks.length)} 条`,
        `  结构不合格被丢：${String(result.droppedInvalid)}`,
        `  调用次数/用量：  ${String(result.calls)} 次 / ${String(result.costTokens)} token`,
        "",
        ...result.playbooks.map(
          (b, i) =>
            `  ${String(i + 1)}. <名称 ${String(b.name.length)} 字> ${String(b.stages.length)} 步 ` +
            `evidence ${String(b.evidence.length)} 条 ` +
            `带常问 ${String(b.stages.filter((s) => s.asks !== "").length)} 步`,
        ),
        "",
        `渲染产物：${String((rendered.content ?? "").length)} 字符`,
      ].join("\n")
      console.error(report)

      writeFileSync(
        "/tmp/wlreplay/playbook-e2e.json",
        JSON.stringify(
          { report: report.split("\n"), coverage: result.coverage, playbooks: result.playbooks },
          null,
          2,
        ),
        "utf8",
      )
      if (rendered.content !== null) {
        writeFileSync("/tmp/wlreplay/playbook-work.md", rendered.content, "utf8")
      }

      /**
       * ★ 断言锁**通路与不变式**，不锁条数或质量。
       *
       * 归纳出 0 条是**允许**的（语料里可能真的没有流程），所以不断言
       * `playbooks.length > 0` —— 那会让这个用例在正常状态下红。
       * 但只要归纳出了东西，覆盖率与结构就必须成立。
       */
      expect(candidates.length, "读图库一条候选都没取到 —— 接线断了").toBeGreaterThan(0)
      /**
       * ★ `coverage.candidates` 数的是**本人参与**的，不是候选池总数。
       *
       * 这个区别踩过：产物文案写「从 N 段本人参与的对话里」，而早先这里放的是
       * 全部 chunk（2149），实测本人参与的只有 1700 —— 那句话因此在说假话，
       * 而覆盖率这一栏存在的全部意义就是让人能信它。
       */
      expect(result.coverage.candidates).toBe(candidates.filter((c) => c.selfSpoke).length)

      if (result.playbooks.length > 0) {
        // 每条都必须多步有序 + 每步有产出 + 证据能回验
        const ids = new Set(candidates.map((c) => c.id))
        for (const book of result.playbooks) {
          expect(book.stages.length).toBeGreaterThanOrEqual(2)
          for (const stage of book.stages) {
            expect(stage.action).not.toBe("")
            expect(stage.output).not.toBe("")
          }
          expect(book.evidence.length).toBeGreaterThan(0)
          for (const id of book.evidence) expect(ids.has(id)).toBe(true)
        }
        // ★★ 覆盖率必须进产物
        const body = rendered.content ?? ""
        expect(body).toContain("## 他的工作套路")
        expect(body).toContain(String(result.coverage.eligible))
        expect(body).toContain("不代表他没有做法")
      }

      core.close()
      ;(kl as unknown as Database.Database).close()
    },
    600_000,
  )
})
