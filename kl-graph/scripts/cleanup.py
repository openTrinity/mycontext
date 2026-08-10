"""Dry-run or apply budgeted LLM entity cleanup to an existing index."""

from __future__ import annotations

import argparse
import asyncio
import json

from kl_graph.config import DATA_DIR
from kl_graph.ingest.entity_cleanup import (
    apply_cleanup_decisions,
    rank_cleanup_candidates,
    review_cleanup_candidates,
)
from kl_graph.storage.sqlite_store import SQLiteStore


async def main() -> None:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    parser.add_argument("--budget", type=int, default=500)
    parser.add_argument("--min-score", type=float, default=5.0)
    args = parser.parse_args()

    store = SQLiteStore(DATA_DIR / "knowledge.db")
    try:
        entities = {entity.id: entity for entity in store.iter_all_entities()}
        facts = list(store.iter_all_facts())
        candidates = rank_cleanup_candidates(
            list(entities.values()), facts, min_score=args.min_score
        )
        decisions = await review_cleanup_candidates(
            candidates, budget=args.budget, dry_run=not args.apply
        )
        for decision in decisions:
            edge_count = store.conn.execute(
                "SELECT COUNT(*) FROM edges WHERE target_type='entity' AND target_id=?",
                (decision["entity_id"],),
            ).fetchone()[0]
            fact_count = store.conn.execute(
                """SELECT COUNT(DISTINCT source_id) FROM edges
                   WHERE source_type='fact' AND target_type='entity'
                     AND target_id=? AND edge_type='ABOUT'""",
                (decision["entity_id"],),
            ).fetchone()[0]
            decision["affected_edges"] = edge_count
            decision["affected_facts"] = fact_count
        apply_cleanup_decisions(entities, decisions, dry_run=not args.apply)
        if args.apply:
            changed = [
                entities[decision["entity_id"]]
                for decision in decisions
                if decision["action"] != "KEEP"
                and decision["entity_id"] in entities
            ]
            if changed:
                store.apply_entity_cleanup(changed)
        changed = sum(d["action"] != "KEEP" for d in decisions)
        report = {
            "summary": {
                "candidates": len(candidates),
                "llm_budget": args.budget,
                "llm_calls": len(decisions),
                "changed": changed,
                "projections_need_rebuild": bool(args.apply and changed),
                "stale_projections": (
                    ["entity_vector_payload", "graph_backend_copy"]
                    if args.apply and changed
                    else []
                ),
                "rebuild_note": (
                    "RETYPE and QUARANTINE change metadata outside SQLite; rebuild "
                    "entity vectors and the configured graph projection before serving."
                    if args.apply and changed
                    else ""
                ),
            },
            "decisions": decisions,
        }
        print(json.dumps(report, ensure_ascii=False, indent=2))
    finally:
        store.close()


if __name__ == "__main__":
    asyncio.run(main())
