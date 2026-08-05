/**
 * kl 的 opencode skill 物化。
 *
 * ## 为什么要重写而不是原样搬 kl-graph 的 SKILL.md
 *
 * kl-graph 自带的 `.claude/skills/kl/SKILL.md` 是给**开发者**用的：
 * 它包含 `kl start` / `kl stop` / `kl start embedding` 这类**生命周期命令**
 * 以及建图/摄取的运维内容。搜索里的 agent **不该**碰这些 ——
 * 进程生命周期由 `KlServerService` 管（见 kl-server.service.ts），
 * agent 只负责**查询**。所以物化时只保留查询命令，去掉生命周期段。
 *
 * ## 命令口径：裸 `kl`，靠 PATH 解析
 *
 * skill 正文让 agent 跑 `kl ask "…"` 这类命令。权限白名单精确放行的也是
 * `kl` / `kl *`（见 `KL_SKILL_PERMISSION`）——两者必须用**同一个命令前缀**。
 * 所以这里坚持裸 `kl`（不是绝对路径），由 SearchService 在 spawn 时把
 * kl 的 wrapper 目录**前插进 PATH**，让裸 `kl` 命中我们的 wrapper
 * （wrapper 注入 `KL_SERVER_PORT` 后转调真的 kl_cli）。
 *
 * 若改成绝对路径，权限 glob 就得跟着变成那个绝对路径，且路径里的空格/特殊字符
 * 会让 glob 匹配变脆 —— 裸命令 + PATH 前插是最稳的一处。
 *
 * ## 纯函数
 *
 * 这里只产出**文本**（SKILL.md 内容）。落盘由 SearchService 做（它有 fs 与
 * 每会话 cwd）。分开是为了让内容可单测、且不把 electron/fs 依赖带进 packages。
 */

/** 物化到工作区的 kl skill 的相对路径（opencode 从 `<cwd>/.opencode/skills/<name>/` 发现）。 */
export const KL_SKILL_RELPATH = ".opencode/skills/kl/SKILL.md"

/**
 * 生成搜索会话用的 kl SKILL.md 内容。
 *
 * 只含**查询**命令；生命周期（start/stop/build/ingest）与 GPU/embedding 运维
 * 段一律不含 —— 那些由宿主管，放进来只会诱导 agent 去执行它无权也不该做的事。
 */
export function buildKlSkillMarkdown(): string {
  return `---
name: kl
description: Query the DingTalk spatio-temporal knowledge graph (workplace chat history — messages, entities, facts, communities). Use when answering questions about workplace conversations, team structures, project decisions, people, or system relationships. Triggered by questions about who said what, project timelines, team composition, or technical decisions.
---

# Knowledge Graph Query (kl)

Query a knowledge graph built from DingTalk workplace messages. Entities (people,
systems, projects), facts (decisions, statuses, relations), and multi-resolution
communities.

Run the \`kl\` CLI via the bash tool. \`kl\` is a thin HTTP client to a local
retrieval server that is **already running** — you only query it, never start or
stop it. All commands output JSON by default.

## Query commands

\`\`\`bash
kl ask "<question>" [-k 10] [--phase2]   # hybrid retrieval (messages+facts) + optional synthesis
kl search "<query>" [-c messages|facts|entities|communities] [-k 10]  # vector ANN, one collection
kl entity "<name>"                       # entity lookup (substring match)
kl expand <entity_id>                    # SIMILAR_TO neighbors (alias resolution)
kl context <fact_id>                     # source message + context for a fact
kl timeline "<entity>" [--from YYYY-MM-DD] [--to YYYY-MM-DD]
kl community [-l L0|L1|L2|L3] [-t entity|fact] [--id N]
kl members <id> [-l L1] [-t entity|fact]
kl graph "<query>" [--seed-k 6] [--max-nodes 50] [-f json|mermaid|pretty]  # relationship/multi-hop
kl hop "<node_id>" --cursor '<cursor-json>'   # expand one node (pure in-memory walk)
kl stats                                 # graph statistics
\`\`\`

## Retrieval patterns

- **Factual question** → \`kl ask "<q>"\` then \`kl context <fact_id>\` to ground it in the source message.
- **Person/project deep-dive** → \`kl entity "<name>"\` → \`kl timeline "<name>"\` → \`kl context <fact_id>\`.
- **Relationship / "how do X and Y connect"** → \`kl graph "<q>"\`, then \`kl hop\` on an id from its \`expandable\` list.
- **Broad survey** → \`kl search "<q>" -c communities\` → \`kl members <id>\` → \`kl context <fact_id>\`.

## Grounding & confidence

- Always ground an answer in at least one \`kl context <fact_id>\` (source message).
- A fact confirmed by multiple messages is reliable; a single-source fact should be flagged as such.
- Entity names may be Chinese or English (e.g. "张三", "LlmGateway", "Claude Code").
- Fact ids accept a prefix (e.g. \`kl context 49d8370a\`).

## Stop criteria

Stop and synthesize once you have ~3 grounded facts that answer the question, or
after ~10 \`kl\` commands, or when two consecutive queries return nothing new.

## If kl is unavailable

If \`kl\` commands fail (server not ready / not built), say so plainly and fall
back to answering from whatever local recall you already have — do **not** try to
start or build anything.
`
}
