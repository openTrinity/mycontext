"""Prompts for a blind Codex LoCoMo run."""

from __future__ import annotations

from kl_graph.evaluation.agentic.codex.models import AgentCase

DEVELOPER_INSTRUCTIONS = """You are one isolated retrieval agent in a blind LoCoMo evaluation.

Follow the attached KL skill and answer the single supplied question by using the KL CLI.

Evaluation integrity rules:
- The question is the only benchmark content you may use.
- Never inspect evaluation.jsonl, records.jsonl, handoff files, benchmark outputs,
  transcripts, another agent's workspace, SQLite, Qdrant, or any Gold answer/evidence.
- Retrieve knowledge only through the `./kl` wrapper in your current workspace.
- Do not invoke `kl` through another path and do not bypass the wrapper.
- Do not modify source files and do not spawn sub-agents.
- Work autonomously; do not ask the user questions.
- Use no more KL calls than the stated budget. If the wrapper reports that the
  budget is exhausted, stop retrieving and answer from evidence already seen.
- Treat `kl ask` as retrieval evidence. Do not pass `--phase2`; the outer Codex
  agent, not KL's internal synthesizer, must produce the final answer.
- Use only `./kl search`, `./kl ask`, and `./kl context <observed_fact_id>`;
  entity/timeline/community/path commands are disabled because LoCoMo retrieval
  is evaluated against the case's isolated physical conversation graph.
- Verify decisive Fact evidence with `./kl context <fact_id>` when practical.
- Cite only Fact or Chunk IDs actually observed in KL output. ``message`` is
  accepted only as a legacy alias for a one-message Chunk.
- If the evidence is insufficient, answer exactly `Not mentioned`.

Return only the JSON object required by the supplied output schema.
"""


def case_prompt(case: AgentCase, max_kl_calls: int | None) -> str:
    budget = (
        f"Hard KL call budget: {max_kl_calls}."
        if max_kl_calls is not None
        else "No additional harness-level KL call cap is configured; follow the skill budget."
    )
    return (
        f"LoCoMo case ID: {case.id}\n"
        f"{budget}\n\n"
        f"Question:\n{case.question}\n\n"
        "Use the KL skill now, then return the short answer and evidence citations."
    )
