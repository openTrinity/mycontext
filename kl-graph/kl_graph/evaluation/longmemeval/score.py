"""Score LongMemEval QA answers and optional KL ``turn_recall@5``.

Adapted from LongMemEval ``src/evaluation/evaluate_qa.py`` at commit
``9e0b455f4ef0e2ab8f2e582289761153549043fc``. Local changes provide KL
experiment inputs, compact progress, a JSON metric summary, and deterministic
KL source-turn recall. LongMemEval is MIT licensed; see
``THIRD_PARTY_LICENSE_LONGMEMEVAL`` in this directory.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path
from statistics import fmean
from typing import Any

from openai import AsyncOpenAI
from tqdm import tqdm

from kl_graph.evaluation.io import atomic_write_json, atomic_write_jsonl, json_lines
from kl_graph.evaluation.longmemeval.build import (
    CASE_DATA_DIRNAME,
    _load_case_entries,
    _resolve_manifest_path,
)
from kl_graph.evaluation.longmemeval.convert import message_id
from kl_graph.evaluation.longmemeval.experiment import (
    ScoreConfig,
    load_score_experiment,
    score_metrics_output,
    score_output,
    select_entries,
)
from kl_graph.evaluation.longmemeval.generate import _read_item_source_units
from kl_graph.evaluation.longmemeval.source import resolve_source

QUESTION_TYPES = (
    "single-session-user",
    "single-session-preference",
    "single-session-assistant",
    "multi-session",
    "temporal-reasoning",
    "knowledge-update",
)
def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Score LongMemEval hypotheses with the official judge prompts."
    )
    parser.add_argument(
        "--config",
        type=Path,
        required=True,
        help="LongMemEval experiment YAML",
    )
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def get_anscheck_prompt(
    task: str,
    question: str,
    answer: Any,
    response: str,
    *,
    abstention: bool = False,
) -> str:
    """Return the official LongMemEval answer-check prompt."""
    if abstention:
        template = """I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.

Question: {}

Explanation: {}

Model Response: {}

Does the model correctly identify the question as unanswerable? Answer yes or no only."""
    elif task in {
        "single-session-user",
        "single-session-assistant",
        "multi-session",
    }:
        template = """I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.

Question: {}

Correct Answer: {}

Model Response: {}

Is the model response correct? Answer yes or no only."""
    elif task == "temporal-reasoning":
        template = """I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct.

Question: {}

Correct Answer: {}

Model Response: {}

Is the model response correct? Answer yes or no only."""
    elif task == "knowledge-update":
        template = """I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.

Question: {}

Correct Answer: {}

Model Response: {}

Is the model response correct? Answer yes or no only."""
    elif task == "single-session-preference":
        template = """I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.

Question: {}

Rubric: {}

Model Response: {}

Is the model response correct? Answer yes or no only."""
    else:
        raise ValueError(f"unsupported LongMemEval question type: {task}")
    return template.format(question, answer, response)


def _accuracy(values: list[int]) -> float | None:
    return round(fmean(values), 4) if values else None


def _read_retrieval_targets(
    case_root: Path,
    question_id: str,
) -> tuple[str, bool, list[str], dict[str, str]]:
    """Read Gold user turns and the role of every addressable source turn."""
    path = case_root / "evaluation.jsonl"
    with path.open("r", encoding="utf-8") as stream:
        rows = [json.loads(line) for line in stream if line.strip()]
    if len(rows) != 1:
        raise ValueError(f"expected one evaluation row: {path}")
    data = rows[0].get("data")
    if not isinstance(data, dict) or data.get("question_id") != question_id:
        raise ValueError(f"evaluation question ID mismatch: {question_id}")

    question_type = data.get("question_type")
    if not isinstance(question_type, str) or not question_type:
        raise ValueError(f"case {question_id}: invalid question_type")
    is_abstention = data.get("is_abstention")
    if not isinstance(is_abstention, bool):
        raise TypeError(f"case {question_id}: invalid is_abstention flag")
    sessions = data.get("haystack_sessions")
    if not isinstance(sessions, list):
        raise TypeError(f"case {question_id}: haystack_sessions must be a list")

    gold_turn_ids: list[str] = []
    source_roles: dict[str, str] = {}
    for session_index, session in enumerate(sessions):
        if not isinstance(session, list):
            raise TypeError(
                f"case {question_id} session {session_index}: invalid source session"
            )
        for turn_index, turn in enumerate(session):
            if not isinstance(turn, dict):
                raise TypeError(
                    f"case {question_id} session {session_index} "
                    f"turn {turn_index}: invalid source turn"
                )
            role = turn.get("role")
            if role not in {"user", "assistant"}:
                raise ValueError(
                    f"case {question_id} session {session_index} "
                    f"turn {turn_index}: invalid role"
                )
            turn_id = message_id(question_id, session_index, turn_index)
            source_roles[turn_id] = role
            if role == "user" and turn.get("has_answer") is True:
                gold_turn_ids.append(turn_id)
    return question_type, is_abstention, gold_turn_ids, source_roles


def _turn_recall_metric(k: int) -> str:
    return f"turn_recall@{k}"


def _read_top_k_items(
    case_root: Path,
    question_id: str,
    k: int,
    artifact_top_k: int,
) -> list[dict[str, Any]]:
    path = case_root / "results" / f"ask_top{artifact_top_k}.json"
    artifact = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(artifact, dict) or artifact.get("question_id") != question_id:
        raise ValueError(f"ask result question ID mismatch: {question_id}")
    if artifact.get("force_phase2") is not False:
        raise ValueError(f"case {question_id}: ask result must have Phase 2 off")
    if artifact.get("top_k") != artifact_top_k:
        raise ValueError(f"case {question_id}: ask result Top-K mismatch")
    response = artifact.get("response")
    if not isinstance(response, dict):
        raise TypeError(f"case {question_id}: malformed ask response")
    items = response.get("items")
    if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
        raise ValueError(f"case {question_id}: malformed ask items")
    return items[:k]


def _retrieved_user_turn_ids(
    case_root: Path,
    question_id: str,
    source_roles: dict[str, str],
    k: int,
    artifact_top_k: int,
) -> list[str]:
    database = (case_root / CASE_DATA_DIRNAME / "knowledge.db").resolve()
    if not database.is_file():
        raise FileNotFoundError(f"case {question_id} has not been built: {database}")

    retrieved: list[str] = []
    seen: set[str] = set()
    with sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True) as connection:
        for item in _read_top_k_items(
            case_root, question_id, k, artifact_top_k
        ):
            for turn_id in _read_item_source_units(connection, item, question_id):
                role = source_roles.get(turn_id)
                if role is None:
                    raise ValueError(
                        f"case {question_id}: retrieved source turn is absent from "
                        f"evaluation chats: {turn_id}"
                    )
                if role != "user":
                    raise ValueError(
                        f"case {question_id}: retrieved source turn is not a user "
                        f"turn: {turn_id}"
                    )
                if turn_id not in seen:
                    seen.add(turn_id)
                    retrieved.append(turn_id)
    return retrieved


def _score_retrieval_case(
    case_root: Path,
    question_id: str,
    k: int,
    *,
    artifact_top_k: int,
) -> dict[str, Any]:
    metric = _turn_recall_metric(k)
    question_type, is_abstention, gold_turn_ids, source_roles = _read_retrieval_targets(
        case_root, question_id
    )
    base: dict[str, Any] = {
        "question_id": question_id,
        "question_type": question_type,
        "eligible": True,
        "exclusion_reason": None,
        "gold_turn_ids": gold_turn_ids,
        f"retrieved_turn_ids_at_{k}": [],
        f"matched_gold_turn_ids_at_{k}": [],
        metric: None,
    }
    if is_abstention:
        return {**base, "eligible": False, "exclusion_reason": "abstention"}
    if not gold_turn_ids:
        return {
            **base,
            "eligible": False,
            "exclusion_reason": "no_gold_user_turns",
        }

    retrieved_turn_ids = _retrieved_user_turn_ids(
        case_root, question_id, source_roles, k, artifact_top_k
    )
    retrieved_set = set(retrieved_turn_ids)
    matched_gold = [turn_id for turn_id in gold_turn_ids if turn_id in retrieved_set]
    return {
        **base,
        f"retrieved_turn_ids_at_{k}": retrieved_turn_ids,
        f"matched_gold_turn_ids_at_{k}": matched_gold,
        metric: len(matched_gold) / len(gold_turn_ids),
    }


def _retrieval_mean(values: list[float]) -> float | None:
    return round(fmean(values), 4) if values else None


def _aggregate_retrieval_rows(
    rows: list[dict[str, Any]],
    k: int,
) -> dict[str, Any]:
    metric = _turn_recall_metric(k)
    eligible_scores: list[float] = []
    by_type: dict[str, list[float]] = defaultdict(list)
    exclusions: Counter[str] = Counter()
    for row in rows:
        if not row["eligible"]:
            exclusions[str(row["exclusion_reason"])] += 1
            continue
        value = row[metric]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise TypeError(
                f"eligible row has no {metric}: {row['question_id']}"
            )
        score = float(value)
        eligible_scores.append(score)
        by_type[str(row["question_type"])].append(score)

    return {
        "metric": metric,
        "k": k,
        "definition": (
            f"unique Gold user turns covered by the first {k} KL Items divided "
            "by all unique Gold user turns; Facts map through source_unit_id and "
            "Chunks map through member_message_ids"
        ),
        "counts": {
            "total_cases": len(rows),
            "eligible_cases": len(eligible_scores),
            "excluded_cases": len(rows) - len(eligible_scores),
            "excluded_by_reason": dict(sorted(exclusions.items())),
        },
        metric: _retrieval_mean(eligible_scores),
        "by_question_type": {
            question_type: {
                "eligible_cases": len(values),
                metric: _retrieval_mean(values),
            }
            for question_type, values in sorted(by_type.items())
        },
    }


def _score_retrieval_rows(
    case_set: Path,
    entries: list[dict[str, Any]],
    question_ids: list[str],
    k: int,
    artifact_top_k: int,
) -> list[dict[str, Any]]:
    by_id = {str(entry["question_id"]): entry for entry in entries}
    missing = [question_id for question_id in question_ids if question_id not in by_id]
    if missing:
        raise ValueError(
            f"KL case set is missing retrieval question IDs: {missing[:5]}"
        )
    return [
        _score_retrieval_case(
            _resolve_manifest_path(case_set, by_id[question_id]["path"], "path"),
            question_id,
            k,
            artifact_top_k=artifact_top_k,
        )
        for question_id in question_ids
    ]


def _load_hypotheses(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for line_number, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), 1
    ):
        if not line.strip():
            continue
        row = json.loads(line)
        if not isinstance(row, dict):
            raise TypeError(f"hypothesis row is not an object: {path}:{line_number}")
        question_id = row.get("question_id")
        hypothesis = row.get("hypothesis")
        if not isinstance(question_id, str) or not question_id:
            raise ValueError(f"invalid hypothesis question_id: {path}:{line_number}")
        if not isinstance(hypothesis, str):
            raise TypeError(f"invalid hypothesis text: {path}:{line_number}")
        if question_id in seen:
            raise ValueError(f"duplicate hypothesis ID: {question_id}")
        seen.add(question_id)
        rows.append(row)
    if not rows:
        raise ValueError(f"hypothesis file is empty: {path}")
    return rows


def _load_references(path: Path) -> dict[str, dict[str, Any]]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, list) or not value:
        raise ValueError(f"reference must be a non-empty JSON array: {path}")
    by_id: dict[str, dict[str, Any]] = {}
    for index, row in enumerate(value):
        if not isinstance(row, dict):
            raise TypeError(f"reference row {index} is not an object")
        question_id = row.get("question_id")
        if not isinstance(question_id, str) or not question_id:
            raise ValueError(f"reference row {index} has no question_id")
        if question_id in by_id:
            raise ValueError(f"duplicate reference ID: {question_id}")
        by_id[question_id] = row
    return by_id


def score_is_complete(
    hypotheses: Path,
    *,
    output: Path,
    metrics_output: Path,
    selected_ids: set[str],
    config: ScoreConfig,
) -> bool:
    """Return whether persisted Score artifacts exactly match this config."""
    judge = config.judge
    turn_recall = config.retrieval.turn_recall
    if (
        not hypotheses.is_file()
        or not output.is_file()
        or not metrics_output.is_file()
    ):
        return False
    try:
        hypothesis_rows = list(json_lines(hypotheses))
        scored_rows = list(json_lines(output))
        metrics = json.loads(metrics_output.read_text(encoding="utf-8"))
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return False
    hypothesis_ids = [row.get("question_id") for row in hypothesis_rows]
    if len(hypothesis_ids) != len(selected_ids) or set(hypothesis_ids) != selected_ids:
        return False
    if [row.get("question_id") for row in scored_rows] != hypothesis_ids:
        return False
    hypothesis_by_id = {
        row["question_id"]: row.get("hypothesis") for row in hypothesis_rows
    }
    retrieval_metric = _turn_recall_metric(turn_recall.k)
    for row in scored_rows:
        label = row.get("autoeval_label")
        retrieval = row.get("retrieval")
        if (
            row.get("hypothesis") != hypothesis_by_id.get(row.get("question_id"))
            or not isinstance(label, dict)
            or label.get("model") != judge.model
            or not isinstance(label.get("label"), bool)
            or not isinstance(label.get("raw_response"), str)
        ):
            return False
        if turn_recall.enabled and (
            not isinstance(retrieval, dict) or retrieval_metric not in retrieval
        ):
            return False
        if not turn_recall.enabled and retrieval is not None:
            return False
    expected_judge = {
        **judge.model_dump(),
        "label_parser": "official_substring_yes",
    }
    base_matches = (
        isinstance(metrics, dict)
        and metrics.get("metric_model") == judge.model
        and metrics.get("base_url") == judge.base_url
        and metrics.get("concurrency") == config.concurrency
        and metrics.get("judge") == expected_judge
        and metrics.get("questions") == len(selected_ids)
    )
    if not base_matches:
        return False
    retrieval_metrics = metrics.get("retrieval")
    if not turn_recall.enabled:
        return retrieval_metrics is None
    return (
        isinstance(retrieval_metrics, dict)
        and retrieval_metrics.get("metric") == retrieval_metric
        and retrieval_metrics.get("k") == turn_recall.k
    )


async def _score_one(
    hypothesis: dict[str, Any],
    reference: dict[str, Any],
    client: AsyncOpenAI,
    model: str,
    semaphore: asyncio.Semaphore,
    *,
    temperature: float,
    max_tokens: int,
) -> tuple[str, str, int, dict[str, Any]]:
    question_id = hypothesis["question_id"]
    question_type = reference["question_type"]
    prompt = get_anscheck_prompt(
        question_type,
        reference["question"],
        reference["answer"],
        hypothesis["hypothesis"],
        abstention=question_id.endswith("_abs"),
    )
    async with semaphore:
        completion = await client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=temperature,
            max_tokens=max_tokens,
        )
    raw_response = completion.choices[0].message.content or ""
    response = raw_response.strip()
    score = int("yes" in response.lower())
    scored = {
        **hypothesis,
        "autoeval_label": {
            "model": model,
            "label": bool(score),
            "raw_response": raw_response,
        },
    }
    return question_id, question_type, score, scored


async def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        experiment = load_score_experiment(args.config)
        score_config = experiment.score
        judge = score_config.judge
        turn_recall = score_config.retrieval.turn_recall

        hypotheses_path = experiment.hypotheses
        reference_path = resolve_source(experiment.source)
        for path in (hypotheses_path, reference_path):
            if not path.is_file():
                raise FileNotFoundError(path)

        hypotheses = _load_hypotheses(hypotheses_path)
        reference_by_id = _load_references(reference_path)
        selected_references = select_entries(
            [
                {"question_id": question_id}
                for question_id in reference_by_id
            ],
            experiment.selection,
        )
        expected_ids = [str(row["question_id"]) for row in selected_references]
        hypothesis_ids = [row["question_id"] for row in hypotheses]
        if hypothesis_ids != expected_ids:
            raise ValueError("hypothesis IDs/order do not match experiment selection")

        output = score_output(experiment)
        metrics_path = score_metrics_output(experiment)
        if experiment.run.mode == "resume" and score_is_complete(
            hypotheses_path,
            output=output,
            metrics_output=metrics_path,
            selected_ids=set(expected_ids),
            config=score_config,
        ):
            print(f"score complete and compatible; skipped: {output}", flush=True)
            return 0

        retrieval_metric = _turn_recall_metric(turn_recall.k)
        retrieval_rows: list[dict[str, Any]] = []
        retrieval_by_id: dict[str, dict[str, Any]] = {}
        retrieval_metrics: dict[str, Any] | None = None
        if turn_recall.enabled:
            if experiment.ask_top_k is None:  # pragma: no cover - schema invariant
                raise RuntimeError("Ask Top-K is required for KL retrieval scoring")
            case_set, entries = _load_case_entries(experiment.case_set)
            retrieval_rows = _score_retrieval_rows(
                case_set,
                entries,
                hypothesis_ids,
                turn_recall.k,
                experiment.ask_top_k,
            )
            retrieval_by_id = {str(row["question_id"]): row for row in retrieval_rows}
            retrieval_metrics = _aggregate_retrieval_rows(
                retrieval_rows, turn_recall.k
            )
        print(
            f"questions={len(hypotheses)} model={judge.model} "
            f"{retrieval_metric}="
            f"{retrieval_metrics.get(retrieval_metric) if retrieval_metrics else 'off'} "
            f"output={output}",
            flush=True,
        )
        if args.dry_run:
            return 0

        api_key = (
            os.environ.get("OPENAI_API_KEY", "").strip()
            or os.environ.get("KL_LLM_API_KEY", "").strip()
            or os.environ.get("ANTHROPIC_AUTH_TOKEN", "").strip()
        )
        if not api_key:
            raise ValueError("KL_LLM_API_KEY or OPENAI_API_KEY is required")
        client = AsyncOpenAI(
            api_key=api_key,
            base_url=judge.base_url,
            organization=os.environ.get("OPENAI_ORGANIZATION"),
            timeout=judge.timeout_seconds,
            max_retries=judge.max_retries,
        )

        by_type: dict[str, list[int]] = defaultdict(list)
        abstention_scores: list[int] = []
        semaphore = asyncio.Semaphore(score_config.concurrency)
        tasks = [
            asyncio.create_task(
                _score_one(
                    hypothesis,
                    reference_by_id[hypothesis["question_id"]],
                    client,
                    judge.model,
                    semaphore,
                    temperature=judge.temperature,
                    max_tokens=judge.max_tokens,
                )
            )
            for hypothesis in hypotheses
        ]
        scored_by_id: dict[str, dict[str, Any]] = {}
        atomic_write_jsonl(output, [])
        try:
            completions = asyncio.as_completed(tasks)
            for future in tqdm(
                completions,
                total=len(tasks),
                desc="LongMemEval scoring",
            ):
                question_id, question_type, score, scored = await future
                if retrieval_by_id:
                    scored["retrieval"] = retrieval_by_id[question_id]
                scored_by_id[question_id] = scored
                by_type[question_type].append(score)
                if question_id.endswith("_abs"):
                    abstention_scores.append(score)
                atomic_write_jsonl(
                    output,
                    (
                        scored_by_id[value]
                        for value in expected_ids
                        if value in scored_by_id
                    ),
                )
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            await client.close()

        all_scores = [score for values in by_type.values() for score in values]
        task_scores = [fmean(by_type[name]) for name in QUESTION_TYPES if by_type[name]]
        metrics = {
            "metric_model": judge.model,
            "base_url": judge.base_url,
            "concurrency": score_config.concurrency,
            "judge": {
                **judge.model_dump(),
                "label_parser": "official_substring_yes",
            },
            "questions": len(all_scores),
            "task_averaged_accuracy": round(fmean(task_scores), 4),
            "overall_accuracy": _accuracy(all_scores),
            "abstention_accuracy": _accuracy(abstention_scores),
            "abstention_questions": len(abstention_scores),
            "by_question_type": {
                name: {
                    "accuracy": _accuracy(by_type[name]),
                    "count": len(by_type[name]),
                }
                for name in QUESTION_TYPES
            },
        }
        if retrieval_metrics is not None:
            metrics["retrieval"] = retrieval_metrics
        atomic_write_json(metrics_path, metrics)
        print(json.dumps(metrics, ensure_ascii=False, indent=2), flush=True)
        print(f"scored hypotheses: {output}", flush=True)
        print(f"metrics: {metrics_path}", flush=True)
        return 0
    except Exception as exc:  # noqa: BLE001 - report batch scoring failures
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
