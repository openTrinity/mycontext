"""Score LoCoMo retrieval and generated answers for every configured backend.

This stage is evaluation-only. It never starts KL, performs retrieval, or calls
an answer model. Gold data and evidence resolution enter the pipeline here.
"""

from __future__ import annotations

import argparse
import collections
import json
import re
import sqlite3
import string
import sys
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Literal, Protocol

from nltk.stem import PorterStemmer
from omegaconf.errors import OmegaConfBaseException

from kl_graph.evaluation.io import atomic_write_json, atomic_write_jsonl, json_lines
from kl_graph.evaluation.locomo.cases import (
    case_set_fingerprint,
    graph_data_dirs,
    load_case_entries,
    resolve_case_root,
    select_cases,
)
from kl_graph.evaluation.locomo.experiment import (
    ScoreExperiment,
    load_score_experiment,
)
from kl_graph.evaluation.locomo.source import (
    load_samples,
    question_rows,
    select_samples,
    source_fingerprint,
)

CATEGORY_NAMES = {
    1: "Multi Hop",
    2: "Temporal",
    3: "Open Domain",
    4: "Single Hop",
    5: "Adversarial",
}
PORTER = PorterStemmer()
PUNCTUATION = set(string.punctuation)


def normalize_answer(value: Any) -> str:
    """Apply the normalization used by the LoCoMo QA evaluator."""
    text = str(value).replace(",", "").lower()
    text = re.sub(r"\b(a|an|the|and)\b", " ", text)
    text = "".join(character for character in text if character not in PUNCTUATION)
    return " ".join(text.split())


def token_f1(prediction: Any, ground_truth: Any) -> float:
    """Compute normalized, Porter-stemmed token F1."""
    prediction_tokens = [
        PORTER.stem(word) for word in normalize_answer(prediction).split()
    ]
    ground_truth_tokens = [
        PORTER.stem(word) for word in normalize_answer(ground_truth).split()
    ]
    if not prediction_tokens or not ground_truth_tokens:
        return float(prediction_tokens == ground_truth_tokens)
    same = sum(
        (
            collections.Counter(prediction_tokens)
            & collections.Counter(ground_truth_tokens)
        ).values()
    )
    if same == 0:
        return 0.0
    precision = same / len(prediction_tokens)
    recall = same / len(ground_truth_tokens)
    return 2 * precision * recall / (precision + recall)


def official_answer_score(
    category: int,
    prediction: str,
    ground_truth: Any,
) -> float:
    """Apply the category-specific LoCoMo answer metric."""
    if category == 5:
        lowered = prediction.lower()
        return float(
            "no information available" in lowered or "not mentioned" in lowered
        )
    answer = str(ground_truth)
    if category == 3:
        answer = answer.split(";")[0].strip()
    if category == 1:
        predictions = [part.strip() for part in prediction.split(",")]
        answers = [part.strip() for part in answer.split(",")]
        return sum(
            max(token_f1(candidate, gold) for candidate in predictions)
            for gold in answers
        ) / len(answers)
    if category in {2, 3, 4}:
        return token_f1(prediction, answer)
    raise ValueError(f"unknown LoCoMo category: {category}")


def retrieval_scores(
    evidence: list[str],
    retrieved: list[str],
) -> tuple[float, float]:
    """Return evidence recall and complete-evidence recall."""
    if not evidence:
        return 1.0, 1.0
    retrieved_ids = set(retrieved)
    # Match the official evaluator's per-Gold membership check. This matters
    # for the benchmark row whose Gold evidence repeats a dia_id.
    found = sum(value in retrieved_ids for value in evidence)
    return found / len(evidence), float(found == len(evidence))


def score_answer_rows(
    rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Pure LoCoMo answer/evidence scoring over normalized rows."""
    retrieval_modes = sorted(
        {str(row.get("retrieval_mode") or "codex_agentic") for row in rows}
    )
    generator_models = sorted(
        {str(row["generator_model"]) for row in rows if row.get("generator_model")}
    )
    generation_top_k = sorted(
        {
            int(row["generation_top_k"])
            for row in rows
            if row.get("generation_top_k") is not None
        }
    )
    buckets = {
        category: {
            "answer": [],
            "global": [],
            "global_nonempty": [],
            "global_complete": [],
        }
        for category in CATEGORY_NAMES
    }
    scored = []
    for row in rows:
        category = int(row["category"])
        global_recall, global_complete = retrieval_scores(
            row["evidence"], row["global_dia_ids"]
        )
        prediction = str(row.get("generated_answer") or "").strip()
        answer_score = official_answer_score(category, prediction, row["ground_truth"])
        bucket = buckets[category]
        bucket["answer"].append(answer_score)
        bucket["global"].append(global_recall)
        if row["evidence"]:
            bucket["global_nonempty"].append(global_recall)
        bucket["global_complete"].append(global_complete)
        scored.append(
            {
                **row,
                "answer_score": answer_score,
                "global_evidence_recall": global_recall,
                "global_complete_evidence_recall": global_complete,
            }
        )

    by_category = {}
    for category in (4, 1, 2, 3, 5):
        bucket = buckets[category]
        by_category[CATEGORY_NAMES[category]] = {
            "category": category,
            "questions": len(bucket["global"]),
            "generated_answers": sum(
                bool(str(row.get("generated_answer") or "").strip())
                for row in scored
                if int(row["category"]) == category
            ),
            "answer_score": _mean(bucket["answer"]),
            "global_evidence_recall": _mean(bucket["global"]),
            "global_evidence_recall_nonempty_gold": _mean(
                bucket["global_nonempty"]
            ),
            "global_complete_evidence_recall": _mean(bucket["global_complete"]),
        }
    all_answer = [score for bucket in buckets.values() for score in bucket["answer"]]
    all_global = [score for bucket in buckets.values() for score in bucket["global"]]
    global_nonempty = [
        score for bucket in buckets.values() for score in bucket["global_nonempty"]
    ]
    report = {
        "benchmark": (
            "LoCoMo QA — Codex agentic KL workflow"
            if retrieval_modes == ["codex_agentic"]
            else "LoCoMo QA — cached KL retrieval answer generation"
        ),
        "retrieval_modes": retrieval_modes,
        "generator_models": generator_models,
        "generation_top_k": generation_top_k,
        "metric": (
            "official normalized token F1 / adversarial accuracy and "
            "retrieved dia_id evidence recall"
        ),
        "questions": len(rows),
        "generated_answers": sum(
            bool(str(row.get("generated_answer") or "").strip()) for row in rows
        ),
        "generation_errors": sum(bool(row.get("generation_error")) for row in rows),
        "overall": {
            "answer_score": _mean(all_answer),
            "global_evidence_recall": _mean(all_global),
            "global_evidence_recall_nonempty_gold": _mean(global_nonempty),
        },
        "by_category": by_category,
    }
    return scored, report


def evaluate_answers(
    answer_path: Path,
    metrics_path: Path,
    scored_path: Path,
) -> dict[str, Any]:
    """Score an answer artifact and persist the standard evaluator outputs."""
    scored, report = score_answer_rows(list(json_lines(answer_path)))
    atomic_write_jsonl(scored_path, scored)
    atomic_write_json(metrics_path, report)
    print(json.dumps(report["overall"], ensure_ascii=False, sort_keys=True))
    return report


class CitationLike(Protocol):
    """Structural citation contract accepted from any evaluation runner."""

    type: str
    id: str


@dataclass(frozen=True, slots=True)
class EvidenceReference:
    type: str
    id: str


def transcript_references(path: Path) -> list[EvidenceReference]:
    """Return message/fact references in first-observation order."""
    references: list[EvidenceReference] = []
    if not path.is_file():
        return references
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if (
            row.get("record_type") != "codex_event"
            or row.get("method") != "item/completed"
        ):
            continue
        payload = row.get("payload") or {}
        item = payload.get("item") or {}
        if isinstance(item, dict) and "root" in item:
            item = item["root"]
        if not isinstance(item, dict) or item.get("type") != "commandExecution":
            continue
        if "./kl" not in str(item.get("command") or ""):
            continue
        value = _parse_json_output(str(item.get("aggregatedOutput") or "").strip())
        if value is not None:
            references.extend(_references_from_value(value))
    return _dedupe_references(references)


def citation_references(
    citations: Iterable[CitationLike],
) -> list[EvidenceReference]:
    return _dedupe_references(
        EvidenceReference(type=citation.type, id=citation.id) for citation in citations
    )


def ask_response_references(
    response: dict[str, Any],
    *,
    include_items: bool = True,
    include_graph: bool = True,
) -> list[EvidenceReference]:
    """Return evidence exposed by one production ``kl ask`` response."""
    sections: list[Any] = []
    if include_items:
        sections.append(response.get("items") or [])
    if include_graph:
        graph = response.get("graph")
        if isinstance(graph, dict):
            components = graph.get("components")
            if isinstance(components, list):
                for component in components:
                    if isinstance(component, dict):
                        sections.append(component.get("nodes") or [])
    return _dedupe_references(_references_from_value(sections))


FactResolution = Literal["source_unit", "chunk_members"]


class EvidenceResolver:
    """Resolve current-ingest Chunk/Fact IDs to original LoCoMo messages."""

    def __init__(self, sqlite_path: Path, dia_id_by_message: dict[str, str]):
        uri = f"{sqlite_path.resolve().as_uri()}?mode=ro"
        self.conn = sqlite3.connect(uri, uri=True)
        self.conn.row_factory = sqlite3.Row
        self.dia_id_by_message = dia_id_by_message
        fact_columns = {
            str(row["name"])
            for row in self.conn.execute("PRAGMA table_info(facts)").fetchall()
        }
        self._facts_have_source_unit_id = "source_unit_id" in fact_columns

    def close(self) -> None:
        self.conn.close()

    def resolve(
        self,
        references: Iterable[EvidenceReference],
        evidence_conversation_id: str,
        *,
        fact_resolution: FactResolution = "source_unit",
    ) -> list[dict[str, Any]]:
        if fact_resolution not in {"source_unit", "chunk_members"}:
            raise ValueError(f"unknown Fact resolution mode: {fact_resolution}")
        records: list[dict[str, Any]] = []
        seen_records: set[tuple[str, str, str]] = set()
        for observation_rank, reference in enumerate(references, start=1):
            fact_id: str | None = None
            source_unit_id: str | None = None
            if reference.type in {"chunk", "message"}:
                chunk_id = _strip_node_prefix(reference.id, "cnk")
            else:
                fact = self._fact_source(reference)
                if fact is None:
                    continue
                fact_id = str(fact["id"])
                chunk_id = str(fact["source_chunk_id"] or "")
                if self._facts_have_source_unit_id and fact["source_unit_id"]:
                    source_unit_id = str(fact["source_unit_id"])
            if not chunk_id:
                continue
            row = self.conn.execute(
                "SELECT metadata, "
                "json_extract(metadata, '$.conversation_id') AS conversation_id "
                "FROM chunks WHERE id = ?",
                (chunk_id,),
            ).fetchone()
            if row is None:
                continue
            conversation_id = str(row["conversation_id"] or "")
            use_exact_fact_source = (
                reference.type == "fact"
                and fact_resolution == "source_unit"
                and source_unit_id is not None
            )
            source_ids = (
                [source_unit_id]
                if use_exact_fact_source
                else _member_message_ids(row["metadata"], chunk_id)
            )
            resolution = (
                "fact_source_unit"
                if use_exact_fact_source
                else (
                    "fact_chunk_members_legacy"
                    if reference.type == "fact"
                    else "chunk_members"
                )
            )
            for source_id in source_ids:
                record_key = (reference.type, reference.id, source_id)
                if record_key in seen_records:
                    continue
                seen_records.add(record_key)
                dia_id = None
                if _conversation_matches(conversation_id, evidence_conversation_id):
                    dia_id = self.dia_id_by_message.get(source_id)
                records.append(
                    {
                        "reference_type": reference.type,
                        "reference_id": reference.id,
                        "cited_fact_id": fact_id,
                        "source_chunk_id": chunk_id,
                        "source_unit_id": source_unit_id,
                        "source_message_id": source_id,
                        "resolution": resolution,
                        "observation_rank": observation_rank,
                        "conversation_id": conversation_id,
                        "dia_id": dia_id,
                    }
                )
        return records

    def _fact_source(self, reference: EvidenceReference) -> sqlite3.Row | None:
        """Resolve an exact Fact ID, allowing only an unambiguous old prefix."""
        value = _strip_node_prefix(reference.id, "fact")
        source_unit_select = (
            "source_unit_id"
            if self._facts_have_source_unit_id
            else "NULL AS source_unit_id"
        )
        select = f"SELECT id, source_chunk_id, {source_unit_select} FROM facts"
        row = self.conn.execute(f"{select} WHERE id = ?", (value,)).fetchone()
        if row is not None:
            return row
        escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        rows = self.conn.execute(
            f"{select} WHERE id LIKE ? ESCAPE '\\' ORDER BY id LIMIT 2",
            (f"{escaped}%",),
        ).fetchall()
        if len(rows) > 1:
            raise ValueError(f"ambiguous Fact ID prefix: {reference.id}")
        return rows[0] if rows else None


class ConversationEvidenceResolver:
    """Open the physical graph selected by each LoCoMo conversation ID."""

    def __init__(
        self,
        graph_data_dirs: dict[str, Path],
        dia_id_by_message: dict[str, str],
    ):
        self.graph_data_dirs = graph_data_dirs
        self.dia_id_by_message = dia_id_by_message
        self._resolvers: dict[str, EvidenceResolver] = {}

    def close(self) -> None:
        for resolver in self._resolvers.values():
            resolver.close()
        self._resolvers.clear()

    def resolve(
        self,
        references: Iterable[EvidenceReference],
        evidence_conversation_id: str,
        *,
        fact_resolution: FactResolution = "source_unit",
    ) -> list[dict[str, Any]]:
        resolver = self._resolvers.get(evidence_conversation_id)
        if resolver is None:
            data_dir = self.graph_data_dirs.get(evidence_conversation_id)
            if data_dir is None:
                raise KeyError(
                    f"no physical graph for conversation {evidence_conversation_id}"
                )
            sqlite_path = data_dir / "knowledge.db"
            if not sqlite_path.is_file():
                raise FileNotFoundError(sqlite_path)
            resolver = EvidenceResolver(sqlite_path, self.dia_id_by_message)
            self._resolvers[evidence_conversation_id] = resolver
        return resolver.resolve(
            references,
            evidence_conversation_id,
            fact_resolution=fact_resolution,
        )


def _conversation_matches(stored: str, expected: str) -> bool:
    """Accept legacy IDs and source-namespaced conversation IDs."""
    return stored == expected or stored == f"locomo-{expected}:{expected}"


def _strip_node_prefix(value: str, prefix: str) -> str:
    return value.removeprefix(f"{prefix}:")


def _parse_json_output(output: str) -> Any | None:
    if not output:
        return None
    try:
        return json.loads(output)
    except json.JSONDecodeError:
        pass
    starts = [position for position in (output.find("{"), output.find("[")) if position >= 0]
    if not starts:
        return None
    start = min(starts)
    for end in range(len(output), start, -1):
        try:
            return json.loads(output[start:end])
        except json.JSONDecodeError:
            continue
    return None


def _references_from_value(
    value: Any, parent_key: str | None = None
) -> list[EvidenceReference]:
    found: list[EvidenceReference] = []
    if isinstance(value, list):
        for item in value:
            found.extend(_references_from_value(item, parent_key))
        return found
    if not isinstance(value, dict):
        return found

    for key in ("source_message_id", "message_id", "msg_id"):
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate:
            found.append(EvidenceReference("message", candidate))
    for key in ("source_chunk_id", "chunk_id"):
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate:
            found.append(EvidenceReference("chunk", candidate))

    candidate_id = value.get("id")
    item_type = str(value.get("type") or "").lower()
    if isinstance(candidate_id, str):
        if (
            candidate_id.startswith("msg:")
            or item_type == "message"
            or parent_key in {"message", "messages", "source_message"}
        ):
            found.append(EvidenceReference("message", candidate_id))
        elif (
            candidate_id.startswith("cnk:")
            or item_type == "chunk"
            or parent_key in {"chunk", "chunks", "source_chunk"}
        ):
            found.append(EvidenceReference("chunk", candidate_id))
        elif (
            candidate_id.startswith("fact:")
            or item_type == "fact"
            or parent_key == "facts"
            or {"text", "confidence"}.issubset(value)
        ):
            found.append(EvidenceReference("fact", candidate_id))

    fact_id = value.get("fact_id")
    if isinstance(fact_id, str) and fact_id:
        found.append(EvidenceReference("fact", fact_id))
    for key, nested in value.items():
        found.extend(_references_from_value(nested, key))
    return found


def _member_message_ids(raw_metadata: Any, chunk_id: str) -> list[str]:
    """Return original message IDs represented by one current-ingest chunk."""
    if isinstance(raw_metadata, str) and raw_metadata:
        try:
            metadata = json.loads(raw_metadata)
        except json.JSONDecodeError:
            metadata = {}
    elif isinstance(raw_metadata, dict):
        metadata = raw_metadata
    else:
        metadata = {}
    members = metadata.get("member_message_ids")
    if not isinstance(members, list):
        return [chunk_id]
    result: list[str] = []
    seen: set[str] = set()
    for member in members:
        value = str(member).strip() if member is not None else ""
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result or [chunk_id]


def _dedupe_references(
    references: Iterable[EvidenceReference],
) -> list[EvidenceReference]:
    result: list[EvidenceReference] = []
    seen: set[tuple[str, str]] = set()
    for reference in references:
        key = (reference.type, reference.id)
        if not reference.id or key in seen:
            continue
        seen.add(key)
        result.append(reference)
    return result


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def _runtime_options(experiment: ScoreExperiment) -> argparse.Namespace:
    return argparse.Namespace(
        answers_dir=experiment.generate_output_dir,
        ask_dir=Path(experiment.run.output_dir),
        output_dir=Path(experiment.score.output_dir),
        # Score has no incremental work to resume. Recompute its deterministic
        # derived artifacts after Ask/Generate have resumed to completion.
        overwrite=True,
        recall_k=experiment.score.recall_k,
    )


def _score_kl(experiment: ScoreExperiment, args: argparse.Namespace) -> int:
    ask_dir = args.ask_dir.expanduser().resolve()
    answers_dir = args.answers_dir.expanduser().resolve() if args.answers_dir else None
    ask_run = _load_json(ask_dir / "run.json")
    if (
        ask_run.get("backend") != "kl_graph"
        or ask_run.get("benchmark") != "locomo"
    ):
        raise ValueError("configured Ask directory is not a kl_graph LoCoMo run")
    if ask_run.get("status") != "complete":
        raise RuntimeError(f"Ask run is not complete: {ask_dir}")
    dataset_dir = Path(str(ask_run["dataset"])).expanduser().resolve()
    if experiment.case_set is None or dataset_dir != experiment.case_set.resolve():
        raise ValueError("Ask run case set differs from the configured case_set")
    _, case_entries = load_case_entries(dataset_dir)
    expected_cases = select_cases(
        case_entries, experiment.selection.conversations
    )
    expected_run_selection = {
        "conversations": [str(case["conversation_id"]) for case in expected_cases],
        "categories": experiment.selection.questions.categories,
        "question_ids": experiment.selection.questions.ids,
        "limit": experiment.selection.questions.first,
    }
    mismatches = {
        key: {"recorded": ask_run.get(key), "configured": value}
        for key, value in expected_run_selection.items()
        if ask_run.get(key) != value
    }
    if mismatches:
        raise ValueError(
            "Ask run selection differs from the configured selection: "
            + json.dumps(mismatches, ensure_ascii=False, sort_keys=True)
        )
    output_dir = _resolve_output_dir(args, dataset_dir, ask_run)
    if output_dir == ask_dir or output_dir == answers_dir:
        raise ValueError("--output-dir must differ from input run directories")
    fingerprint = case_set_fingerprint(dataset_dir)
    if ask_run.get("case_set_fingerprint") != fingerprint:
        raise ValueError("ask run case set has changed on disk")
    if int(ask_run.get("top_k") or 0) < args.recall_k:
        raise ValueError(
            f"ask run Top-{ask_run.get('top_k')} cannot be scored at "
            f"Recall@{args.recall_k}"
        )
    results_path = ask_dir / "results.jsonl"
    if not results_path.is_file():
        raise FileNotFoundError(results_path)
    _prepare_output_dir(output_dir, args.overwrite)

    results = list(json_lines(results_path))
    result_ids = [str(row.get("id") or "") for row in results]
    if (
        len(result_ids) != int(ask_run.get("questions") or 0)
        or len(result_ids) != len(set(result_ids))
        or not all(result_ids)
    ):
        raise RuntimeError("Ask results do not match the completed run manifest")
    retrieval_rows = _resolve_retrieval(
        ask_dir,
        results,
        dataset_dir,
        args.recall_k,
    )
    retrieval_scored = [
        _score_retrieval_row(row, args.recall_k) for row in retrieval_rows
    ]
    retrieval_report = _retrieval_report(
        retrieval_scored,
        ask_run,
        args.recall_k,
    )
    atomic_write_jsonl(output_dir / "retrieval.jsonl", retrieval_rows)

    if answers_dir is None:
        scored_rows = retrieval_scored
        report = retrieval_report
    else:
        answer_rows, answer_run = _load_answers(
            answers_dir,
            ask_dir,
            fingerprint,
            args.recall_k,
        )
        combined = _join_answers(
            retrieval_rows,
            answer_rows,
            args.recall_k,
        )
        scored_rows, report = score_answer_rows(combined)
        report["retrieval"] = retrieval_report
        report["answer_run"] = {
            "directory": str(answers_dir),
            "model": answer_run.get("model"),
        }

    atomic_write_jsonl(output_dir / "scored.jsonl", scored_rows)
    atomic_write_json(output_dir / "metrics.json", report)
    atomic_write_json(
        output_dir / "run.json",
        {
            "status": "complete",
            "completed_at": datetime.now().astimezone().isoformat(),
            "ask_dir": str(ask_dir),
            "answers_dir": str(answers_dir) if answers_dir else None,
            "dataset": str(dataset_dir),
            "case_set_fingerprint": fingerprint,
            "questions": len(retrieval_rows),
            "recall_k": args.recall_k,
            "metrics_path": "metrics.json",
        },
    )
    print(json.dumps(report.get("overall") or {}, ensure_ascii=False, sort_keys=True))
    print(f"Results: {output_dir}")
    return 0


def _resolve_output_dir(
    args: argparse.Namespace,
    dataset_dir: Path,
    ask_run: dict[str, Any],
) -> Path:
    del dataset_dir, ask_run
    return args.output_dir.expanduser().resolve()


def _prepare_output_dir(output_dir: Path, overwrite: bool) -> None:
    if output_dir.exists() and any(output_dir.iterdir()) and not overwrite:
        raise FileExistsError(
            f"output directory is not empty: {output_dir}; pass --overwrite"
        )
    output_dir.mkdir(parents=True, exist_ok=True)


def _resolve_retrieval(
    ask_dir: Path,
    results: list[dict[str, Any]],
    dataset_dir: Path,
    recall_k: int,
) -> list[dict[str, Any]]:
    gold_by_id = {row["id"]: row for row in _load_gold(dataset_dir)}
    resolver = ConversationEvidenceResolver(
        graph_data_dirs=graph_data_dirs(dataset_dir),
        dia_id_by_message=_load_dia_id_map(dataset_dir),
    )
    rows: list[dict[str, Any]] = []
    try:
        for result in results:
            gold = gold_by_id.get(str(result.get("id") or ""))
            if gold is None:
                raise ValueError(
                    f"result ID is not present in LoCoMo Gold: {result.get('id')}"
                )
            response = _load_response(ask_dir, result)
            conversation_id = gold["conversation_id"]
            item_references = ask_response_references(
                response,
                include_items=True,
                include_graph=False,
            )
            item_at_k_references = ask_response_references(
                _item_prefix(response, recall_k),
                include_items=True,
                include_graph=False,
            )
            graph_references = ask_response_references(
                response,
                include_items=False,
                include_graph=True,
            )
            ask_references = ask_response_references(response)
            items = resolver.resolve(
                item_references,
                conversation_id,
            )
            items_at_k = resolver.resolve(
                item_at_k_references,
                conversation_id,
            )
            graph = resolver.resolve(
                graph_references,
                conversation_id,
            )
            ask = resolver.resolve(
                ask_references,
                conversation_id,
            )
            # Keep the former Fact -> source chunk -> every member expansion as
            # an explicitly named comparison metric during the transition to
            # exact source-unit evidence.
            legacy_items = resolver.resolve(
                item_references,
                conversation_id,
                fact_resolution="chunk_members",
            )
            legacy_items_at_k = resolver.resolve(
                item_at_k_references,
                conversation_id,
                fact_resolution="chunk_members",
            )
            legacy_graph = resolver.resolve(
                graph_references,
                conversation_id,
                fact_resolution="chunk_members",
            )
            legacy_ask = resolver.resolve(
                ask_references,
                conversation_id,
                fact_resolution="chunk_members",
            )
            rows.append(
                {
                    **gold,
                    **result,
                    "retrieval_mode": "single_production_kl_ask",
                    "item_evidence": items,
                    "item_dia_ids": _dia_ids(items),
                    f"item_evidence_at_{recall_k}": items_at_k,
                    f"item_dia_ids_at_{recall_k}": _dia_ids(items_at_k),
                    "graph_evidence": graph,
                    "graph_dia_ids": _dia_ids(graph),
                    "ask_evidence": ask,
                    "ask_dia_ids": _dia_ids(ask),
                    "legacy_chunk_expanded_item_evidence": legacy_items,
                    "legacy_chunk_expanded_item_dia_ids": _dia_ids(legacy_items),
                    (
                        f"legacy_chunk_expanded_item_evidence_at_{recall_k}"
                    ): legacy_items_at_k,
                    (f"legacy_chunk_expanded_item_dia_ids_at_{recall_k}"): _dia_ids(
                        legacy_items_at_k
                    ),
                    "legacy_chunk_expanded_graph_evidence": legacy_graph,
                    "legacy_chunk_expanded_graph_dia_ids": _dia_ids(legacy_graph),
                    "legacy_chunk_expanded_ask_evidence": legacy_ask,
                    "legacy_chunk_expanded_ask_dia_ids": _dia_ids(legacy_ask),
                }
            )
    finally:
        resolver.close()
    return rows


def _load_gold(dataset_dir: Path) -> list[dict[str, Any]]:
    root, cases = load_case_entries(dataset_dir)
    rows: list[dict[str, Any]] = []
    for case in cases:
        conversation_id = str(case["conversation_id"])
        for raw in json_lines(resolve_case_root(root, case) / "evaluation.jsonl"):
            data = raw.get("data") or {}
            if not isinstance(data, dict):
                continue
            rows.append(
                {
                    "id": str(raw.get("id") or ""),
                    "sample_id": str(raw.get("sample_id") or ""),
                    "conversation_id": conversation_id,
                    "question": str(data.get("question") or ""),
                    "ground_truth": data.get("answer"),
                    "evidence": [str(value) for value in data.get("evidence") or []],
                    "category": int(data["category"]),
                }
            )
    if len({row["id"] for row in rows}) != len(rows):
        raise ValueError("evaluation rows must have unique ids")
    return rows


def _load_dia_id_map(dataset_dir: Path) -> dict[str, str]:
    root, cases = load_case_entries(dataset_dir)
    mapping: dict[str, str] = {}
    for case in cases:
        evidence_map = resolve_case_root(root, case) / "evidence_map.jsonl"
        for record in json_lines(evidence_map):
            source_id = str(record.get("source_message_id") or "")
            dia_id = str(record.get("dia_id") or "")
            if source_id and dia_id:
                mapping[source_id] = dia_id
    return mapping


def _load_response(ask_dir: Path, result: dict[str, Any]) -> dict[str, Any]:
    relative = result.get("response_path")
    if result.get("status") != "completed":
        return {}
    if not relative:
        raise ValueError(
            f"completed ask result has no response_path: {result.get('id')}"
        )
    value = _load_json(ask_dir / str(relative))
    return value


def _item_prefix(response: dict[str, Any], recall_k: int) -> dict[str, Any]:
    items = response.get("items") or []
    if not isinstance(items, list):
        raise TypeError("ask response items is not a list")
    return {"items": items[:recall_k]}


def _score_retrieval_row(row: dict[str, Any], recall_k: int) -> dict[str, Any]:
    evidence = [str(value) for value in row.get("evidence") or []]
    ask_recall, ask_complete = retrieval_scores(evidence, row["ask_dia_ids"])
    item_recall, item_complete = retrieval_scores(evidence, row["item_dia_ids"])
    graph_recall, graph_complete = retrieval_scores(evidence, row["graph_dia_ids"])
    item_at_k_recall: float | None = None
    item_at_k_complete: float | None = None
    if evidence:
        item_at_k_recall, item_at_k_complete = retrieval_scores(
            evidence,
            row[f"item_dia_ids_at_{recall_k}"],
        )
    legacy_ask_recall, legacy_ask_complete = retrieval_scores(
        evidence, row["legacy_chunk_expanded_ask_dia_ids"]
    )
    legacy_item_recall, legacy_item_complete = retrieval_scores(
        evidence, row["legacy_chunk_expanded_item_dia_ids"]
    )
    legacy_graph_recall, legacy_graph_complete = retrieval_scores(
        evidence, row["legacy_chunk_expanded_graph_dia_ids"]
    )
    legacy_item_at_k_recall: float | None = None
    legacy_item_at_k_complete: float | None = None
    if evidence:
        legacy_item_at_k_recall, legacy_item_at_k_complete = retrieval_scores(
            evidence,
            row[f"legacy_chunk_expanded_item_dia_ids_at_{recall_k}"],
        )
    return {
        **row,
        "global_evidence_recall": ask_recall,
        "global_complete_evidence_recall": ask_complete,
        "ask_evidence_recall": ask_recall,
        "ask_complete_evidence_recall": ask_complete,
        "item_evidence_recall": item_recall,
        "item_complete_evidence_recall": item_complete,
        f"item_evidence_recall_at_{recall_k}": item_at_k_recall,
        f"item_complete_evidence_recall_at_{recall_k}": item_at_k_complete,
        "graph_evidence_recall": graph_recall,
        "graph_complete_evidence_recall": graph_complete,
        "legacy_chunk_expanded_ask_evidence_recall": legacy_ask_recall,
        "legacy_chunk_expanded_ask_complete_evidence_recall": legacy_ask_complete,
        "legacy_chunk_expanded_item_evidence_recall": legacy_item_recall,
        "legacy_chunk_expanded_item_complete_evidence_recall": (legacy_item_complete),
        f"legacy_chunk_expanded_item_evidence_recall_at_{recall_k}": (
            legacy_item_at_k_recall
        ),
        f"legacy_chunk_expanded_item_complete_evidence_recall_at_{recall_k}": (
            legacy_item_at_k_complete
        ),
        "legacy_chunk_expanded_graph_evidence_recall": legacy_graph_recall,
        "legacy_chunk_expanded_graph_complete_evidence_recall": (legacy_graph_complete),
    }


def _retrieval_report(
    rows: list[dict[str, Any]],
    ask_run: dict[str, Any],
    recall_k: int,
) -> dict[str, Any]:
    grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[int(row["category"])].append(row)
    return {
        "benchmark": "LoCoMo QA — one production KL ask per question",
        "retrieval_mode": "single_production_kl_ask",
        "metric": f"Gold dia_id evidence Recall@{recall_k}",
        "questions": len(rows),
        "retrieval_unit": "ranked /ask item (conversation-slice chunk)",
        "evidence_unit": "original LoCoMo message dia_id",
        "fact_evidence_resolution": "facts.source_unit_id",
        "comparison_metric": "legacy Fact whole-chunk expansion",
        "parameters": {
            "top_k": ask_run.get("top_k"),
            "recall_k": recall_k,
            "force_phase2": ask_run.get("force_phase2"),
            "models": ask_run.get("models"),
        },
        "protocol": _protocol_summary(rows),
        "overall": _aggregate(rows, recall_k),
        "by_category": {
            CATEGORY_NAMES[category]: {
                "category": category,
                **_aggregate(grouped.get(category, []), recall_k),
            }
            for category in (4, 1, 2, 3, 5)
        },
    }


def _aggregate(rows: list[dict[str, Any]], recall_k: int) -> dict[str, Any]:
    nonempty = [row for row in rows if row.get("evidence")]
    recall_at_k = f"item_evidence_recall_at_{recall_k}"
    complete_at_k = f"item_complete_evidence_recall_at_{recall_k}"
    legacy_recall_at_k = f"legacy_chunk_expanded_item_evidence_recall_at_{recall_k}"
    legacy_complete_at_k = (
        f"legacy_chunk_expanded_item_complete_evidence_recall_at_{recall_k}"
    )
    return {
        "questions": len(rows),
        "questions_with_gold_evidence": len(nonempty),
        "ask_evidence_recall": _mean(
            [float(row["ask_evidence_recall"]) for row in rows]
        ),
        "ask_evidence_recall_nonempty_gold": _mean(
            [float(row["ask_evidence_recall"]) for row in nonempty]
        ),
        "ask_complete_evidence_recall": _mean(
            [float(row["ask_complete_evidence_recall"]) for row in rows]
        ),
        "item_evidence_recall": _mean(
            [float(row["item_evidence_recall"]) for row in rows]
        ),
        "item_complete_evidence_recall": _mean(
            [float(row["item_complete_evidence_recall"]) for row in rows]
        ),
        recall_at_k: _mean([float(row[recall_at_k]) for row in nonempty]),
        complete_at_k: _mean([float(row[complete_at_k]) for row in nonempty]),
        "graph_evidence_recall": _mean(
            [float(row["graph_evidence_recall"]) for row in rows]
        ),
        "graph_complete_evidence_recall": _mean(
            [float(row["graph_complete_evidence_recall"]) for row in rows]
        ),
        "legacy_chunk_expanded_ask_evidence_recall": _mean(
            [float(row["legacy_chunk_expanded_ask_evidence_recall"]) for row in rows]
        ),
        "legacy_chunk_expanded_ask_complete_evidence_recall": _mean(
            [
                float(row["legacy_chunk_expanded_ask_complete_evidence_recall"])
                for row in rows
            ]
        ),
        "legacy_chunk_expanded_item_evidence_recall": _mean(
            [float(row["legacy_chunk_expanded_item_evidence_recall"]) for row in rows]
        ),
        "legacy_chunk_expanded_item_complete_evidence_recall": _mean(
            [
                float(row["legacy_chunk_expanded_item_complete_evidence_recall"])
                for row in rows
            ]
        ),
        legacy_recall_at_k: _mean([float(row[legacy_recall_at_k]) for row in nonempty]),
        legacy_complete_at_k: _mean(
            [float(row[legacy_complete_at_k]) for row in nonempty]
        ),
        "legacy_chunk_expanded_graph_evidence_recall": _mean(
            [float(row["legacy_chunk_expanded_graph_evidence_recall"]) for row in rows]
        ),
        "legacy_chunk_expanded_graph_complete_evidence_recall": _mean(
            [
                float(row["legacy_chunk_expanded_graph_complete_evidence_recall"])
                for row in rows
            ]
        ),
    }


def _protocol_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    total_calls = sum(int(row.get("ask_calls") or 0) for row in rows)
    completed = sum(row.get("status") == "completed" for row in rows)
    return {
        "required_asks_per_question": 1,
        "recorded_ask_calls": total_calls,
        "successful_asks": completed,
        "failed_asks": len(rows) - completed,
        "exactly_one_ask_per_result": all(
            int(row.get("ask_calls") or 0) == 1 for row in rows
        ),
        "outer_codex_agent": False,
    }


def _load_answers(
    answers_dir: Path,
    ask_dir: Path,
    fingerprint: str,
    recall_k: int,
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    run = _load_json(answers_dir / "run.json")
    source = Path(str(run.get("ask_dir") or run.get("input_dir") or ""))
    if source.expanduser().resolve() != ask_dir:
        raise ValueError(f"answer source {source} does not match ask run {ask_dir}")
    if run.get("case_set_fingerprint") != fingerprint:
        raise ValueError("answer run case set does not match ask run")
    rows = {
        str(row["id"]): row
        for row in json_lines(answers_dir / "answers.jsonl")
        if row.get("id")
    }
    return rows, run


def _join_answers(
    retrieval_rows: list[dict[str, Any]],
    answers: dict[str, dict[str, Any]],
    recall_k: int,
) -> list[dict[str, Any]]:
    retrieval_ids = {str(row["id"]) for row in retrieval_rows}
    unknown = sorted(set(answers) - retrieval_ids)
    if unknown:
        raise ValueError(f"answer ID is not present in ask run: {unknown[0]}")
    joined = []
    for retrieval in retrieval_rows:
        row_id = str(retrieval["id"])
        answer = answers.get(row_id)
        if answer is None:
            continue
        joined.append(
            {
                **retrieval,
                **answer,
                "retrieval_mode": (f"single_production_kl_ask_items_at_{recall_k}"),
                "global_dia_ids": retrieval[f"item_dia_ids_at_{recall_k}"],
            }
        )
    return joined


def _dia_ids(records: list[dict[str, Any]]) -> list[str]:
    return [str(record["dia_id"]) for record in records if record.get("dia_id")]


def _mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise TypeError(f"JSON artifact is not an object: {path}")
    return value


def _remote_response(ask_dir: Path, result: dict[str, Any]) -> dict[str, Any]:
    if result.get("status") != "completed":
        return {"items": []}
    relative = str(result.get("response_path") or "")
    if not relative:
        raise ValueError(f"completed result has no response_path: {result.get('id')}")
    return _load_json(ask_dir / relative)


def _unique_dia_ids(items: list[dict[str, Any]]) -> list[str]:
    values: list[str] = []
    seen: set[str] = set()
    for item in items:
        for raw in item.get("dia_ids") or []:
            value = str(raw)
            if value and value not in seen:
                seen.add(value)
                values.append(value)
    return values


def _khoj_retrieval_row(
    gold: dict[str, Any],
    result: dict[str, Any],
    response: dict[str, Any],
    recall_k: int,
) -> dict[str, Any]:
    raw_items = response.get("items") or []
    if not isinstance(raw_items, list):
        raise TypeError(f"response items is not a list: {gold['id']}")
    sample_id = str(gold["sample_id"])
    items = [item for item in raw_items[:recall_k] if isinstance(item, dict)]
    dia_ids = _unique_dia_ids(
        [
            item
            for item in items
            if str(item.get("source_sample_id") or "") == sample_id
        ]
    )
    recall, complete = retrieval_scores(gold["evidence"], dia_ids)
    return {
        **gold,
        **result,
        "retrieval_mode": "khoj",
        "global_dia_ids": dia_ids,
        "global_evidence_recall": recall,
        "global_complete_evidence_recall": complete,
    }


def _ragflow_retrieval_row(
    gold: dict[str, Any],
    result: dict[str, Any],
    response: dict[str, Any],
    recall_k: int,
) -> dict[str, Any]:
    raw_items = response.get("items") or []
    if not isinstance(raw_items, list):
        raise TypeError(f"response items is not a list: {gold['id']}")
    items = [item for item in raw_items if isinstance(item, dict)]
    graph_items = [item for item in items if item.get("type") == "graph"]
    vector_items = [item for item in items if item.get("type") != "graph"][
        :recall_k
    ]
    combined_ids = _unique_dia_ids([*graph_items, *vector_items])
    graph_ids = _unique_dia_ids(graph_items)
    vector_ids = _unique_dia_ids(vector_items)
    combined_recall, combined_complete = retrieval_scores(
        gold["evidence"], combined_ids
    )
    graph_recall, graph_complete = retrieval_scores(gold["evidence"], graph_ids)
    vector_recall, vector_complete = retrieval_scores(
        gold["evidence"], vector_ids
    )
    return {
        **gold,
        **result,
        "retrieval_mode": (
            "ragflow_graph" if result.get("use_kg") else "ragflow_vector"
        ),
        # Primary Recall@K is vector-only. Graph evidence is diagnostic and a
        # generation input, but it neither occupies K nor contributes to Recall@K.
        "global_dia_ids": vector_ids,
        "combined_dia_ids": combined_ids,
        "graph_dia_ids": graph_ids,
        "vector_dia_ids": vector_ids,
        "global_evidence_recall": vector_recall,
        "global_complete_evidence_recall": vector_complete,
        "combined_evidence_recall": combined_recall,
        "combined_complete_evidence_recall": combined_complete,
        "graph_evidence_recall": graph_recall,
        "graph_complete_evidence_recall": graph_complete,
        "vector_evidence_recall": vector_recall,
        "vector_complete_evidence_recall": vector_complete,
    }


def _metric_breakdown(
    rows: list[dict[str, Any]], metric_names: tuple[str, ...]
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[int(row["category"])].append(row)

    def aggregate(values: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "questions": len(values),
            **{
                name: _mean([float(row[name]) for row in values])
                for name in metric_names
            },
        }

    return aggregate(rows), {
        CATEGORY_NAMES[category]: {
            "category": category,
            **aggregate(grouped.get(category, [])),
        }
        for category in (4, 1, 2, 3, 5)
    }


def _remote_retrieval_report(
    backend: str,
    rows: list[dict[str, Any]],
    run: dict[str, Any],
    recall_k: int,
) -> dict[str, Any]:
    if backend == "khoj":
        metric_names = (
            "global_evidence_recall",
            "global_complete_evidence_recall",
        )
        benchmark = "LoCoMo QA — Khoj server retrieval"
        retrieval_mode = "khoj"
        parameters = {
            name: run.get(name)
            for name in (
                "top_k",
                "rerank",
                "dedupe",
                "content_type",
                "chunking_owner",
            )
        }
    else:
        metric_names = (
            "global_evidence_recall",
            "global_complete_evidence_recall",
            "graph_evidence_recall",
            "vector_evidence_recall",
        )
        benchmark = "LoCoMo QA — RAGFlow SDK retrieval"
        retrieval_mode = "graph" if run.get("use_kg") else "vector"
        parameters = {
            name: run.get(name)
            for name in (
                "top_k",
                "candidate_count",
                "rerank_id",
                "use_kg",
                "top_k_semantics",
            )
        }
    overall, by_category = _metric_breakdown(rows, metric_names)
    return {
        "benchmark": benchmark,
        "backend": backend,
        "retrieval_mode": retrieval_mode,
        "metric": f"Gold dia_id evidence Recall@{recall_k}",
        "questions": len(rows),
        "parameters": parameters,
        "overall": overall,
        "by_category": by_category,
    }


def _remote_answers(
    answers_dir: Path, ask_dir: Path
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    run = _load_json(answers_dir / "run.json")
    recorded = Path(str(run.get("ask_dir") or "")).expanduser().resolve()
    if recorded != ask_dir:
        raise ValueError("answer run does not belong to the configured Ask run")
    answers = {
        str(row["id"]): row
        for row in json_lines(answers_dir / "answers.jsonl")
        if row.get("generation_status") == "completed"
    }
    return answers, run


def _score_remote(
    experiment: ScoreExperiment,
    args: argparse.Namespace,
    ask_run: dict[str, Any],
) -> int:
    ask_dir = args.ask_dir.expanduser().resolve()
    backend = experiment.backend
    if ask_run.get("backend") != backend or ask_run.get("benchmark") != "locomo":
        raise ValueError(f"configured Ask directory is not a {backend} LoCoMo run")
    if ask_run.get("status") != "complete":
        raise RuntimeError(f"Ask run is not complete: {ask_dir}")
    if args.recall_k > int(ask_run.get("top_k") or 0):
        raise ValueError("score recall_k exceeds the persisted Ask Top-K")
    source = Path(str(ask_run["source"])).expanduser().resolve()
    if source != experiment.source.resolve():
        raise ValueError("Ask run source differs from the configured source")
    if source_fingerprint(source) != ask_run.get("source_sha256"):
        raise ValueError("native LoCoMo source changed after the Ask run")

    _, samples = load_samples(source)
    selected = select_samples(samples, experiment.selection.conversations)
    gold = {
        str(row["id"]): row
        for row in question_rows(selected, experiment.selection.questions)
    }
    results = list(json_lines(ask_dir / "results.jsonl"))
    result_ids = [str(result.get("id") or "") for result in results]
    if result_ids != list(gold) or len(result_ids) != len(set(result_ids)):
        raise RuntimeError("Ask result IDs/order differ from the configured selection")
    row_builder = (
        _khoj_retrieval_row if backend == "khoj" else _ragflow_retrieval_row
    )
    retrieval_rows: list[dict[str, Any]] = []
    for result in results:
        row_id = str(result.get("id") or "")
        if row_id not in gold:
            raise ValueError(f"unknown configured LoCoMo question ID: {row_id}")
        retrieval_rows.append(
            row_builder(
                gold[row_id],
                result,
                _remote_response(ask_dir, result),
                args.recall_k,
            )
        )
    output_dir = args.output_dir.expanduser().resolve()
    answers_dir = args.answers_dir.expanduser().resolve()
    if output_dir in {ask_dir, answers_dir}:
        raise ValueError("score output directory must differ from input directories")
    _prepare_output_dir(output_dir, args.overwrite)
    retrieval_report = _remote_retrieval_report(
        backend, retrieval_rows, ask_run, args.recall_k
    )
    atomic_write_jsonl(output_dir / "retrieval.jsonl", retrieval_rows)

    answers, answer_run = _remote_answers(answers_dir, ask_dir)
    unknown = sorted(set(answers).difference(gold))
    if unknown:
        raise ValueError(f"answer ID is not in the configured selection: {unknown[0]}")
    joined = [
        {**row, **answers[str(row["id"])]}
        for row in retrieval_rows
        if str(row["id"]) in answers
    ]
    scored_rows, report = score_answer_rows(joined)
    report["retrieval"] = retrieval_report
    report["backend"] = backend
    report["answer_run"] = {
        "directory": str(answers_dir),
        "model": answer_run.get("model"),
    }
    atomic_write_jsonl(output_dir / "scored.jsonl", scored_rows)
    atomic_write_json(output_dir / "metrics.json", report)
    atomic_write_json(
        output_dir / "run.json",
        {
            "status": "complete",
            "backend": backend,
            "completed_at": datetime.now().astimezone().isoformat(),
            "ask_dir": str(ask_dir),
            "answers_dir": str(answers_dir),
            "source": str(source),
            "source_sha256": ask_run.get("source_sha256"),
            "questions": len(retrieval_rows),
            "scored_answers": len(scored_rows),
            "recall_k": args.recall_k,
            "metrics_path": "metrics.json",
        },
    )
    print(json.dumps(report.get("overall") or {}, ensure_ascii=False, sort_keys=True))
    print(f"Results: {output_dir}")
    return 0


def main(argv: list[str] | None = None) -> int:
    try:
        cli = parse_args(argv)
        experiment = load_score_experiment(cli.config)
        args = _runtime_options(experiment)
        if experiment.score.recall_k > experiment.ask_top_k:
            raise ValueError("score.recall_k exceeds ask.top_k")
        if cli.dry_run:
            print(
                f"Score backend={experiment.backend} input={args.ask_dir} "
                f"output={args.output_dir}"
            )
            return 0
        ask_run = _load_json(args.ask_dir.expanduser().resolve() / "run.json")
        if experiment.backend == "kl_graph":
            return _score_kl(experiment, args)
        return _score_remote(experiment, args, ask_run)
    except (
        OSError,
        TypeError,
        ValueError,
        RuntimeError,
        json.JSONDecodeError,
        OmegaConfBaseException,
    ) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
