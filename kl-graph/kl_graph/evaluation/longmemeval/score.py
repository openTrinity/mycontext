#!/usr/bin/env python3
"""Score KL hypotheses with LongMemEval's official answer-check prompts.

Adapted from LongMemEval ``src/evaluation/evaluate_qa.py`` at commit
``9e0b455f4ef0e2ab8f2e582289761153549043fc``. Local changes provide KL
case-set defaults, compact progress, and a JSON metric summary. LongMemEval is
MIT licensed; see ``THIRD_PARTY_LICENSE_LONGMEMEVAL`` in this directory.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from collections import defaultdict
from pathlib import Path
from statistics import fmean
from typing import Any

from openai import AsyncOpenAI
from tqdm import tqdm

from kl_graph.config import cfg
from kl_graph.evaluation.io import atomic_write_json, atomic_write_jsonl
from kl_graph.evaluation.longmemeval.build import (
    DEFAULT_CASE_SET,
    _load_case_entries,
)

QUESTION_TYPES = (
    "single-session-user",
    "single-session-preference",
    "single-session-assistant",
    "multi-session",
    "temporal-reasoning",
    "knowledge-update",
)
DEFAULT_CONCURRENCY = 10
LLM_API_KEY = os.environ.get("KL_LLM_API_KEY") or os.environ.get(
    "ANTHROPIC_AUTH_TOKEN", ""
)
LLM_BASE_URL = str(cfg.services.llm_flash.base_url or "")


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Score LongMemEval hypotheses with the official judge prompts."
    )
    parser.add_argument("case_set", nargs="?", type=Path, default=DEFAULT_CASE_SET)
    parser.add_argument(
        "--hypotheses",
        type=Path,
        default=None,
        help=(
            "hypothesis JSONL; when supplied together with --reference, score "
            "exactly this file's question-ID subset"
        ),
    )
    parser.add_argument(
        "--reference",
        type=Path,
        default=None,
        help="native LongMemEval JSON array",
    )
    parser.add_argument(
        "--metric-model",
        default=os.environ.get("LONGMEM_EVAL_MODEL", ""),
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("OPENAI_BASE_URL")
        or (f"{LLM_BASE_URL.rstrip('/')}/v1" if LLM_BASE_URL else ""),
    )
    parser.add_argument(
        "--concurrency",
        type=_positive_int,
        default=DEFAULT_CONCURRENCY,
    )
    parser.add_argument("--overwrite", action="store_true")
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
            raise ValueError(f"invalid hypothesis text: {path}:{line_number}")
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


async def _score_one(
    hypothesis: dict[str, Any],
    reference: dict[str, Any],
    client: AsyncOpenAI,
    model: str,
    semaphore: asyncio.Semaphore,
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
            temperature=0,
            max_tokens=10,
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
    args = parse_args(argv)
    try:
        explicit_subset = args.hypotheses is not None and args.reference is not None
        if explicit_subset:
            hypotheses_path = args.hypotheses.expanduser().resolve()
            reference_path = args.reference.expanduser().resolve()
            expected_ids: list[str] | None = None
        else:
            case_set, entries = _load_case_entries(args.case_set)
            hypotheses_path = (
                args.hypotheses.expanduser().resolve()
                if args.hypotheses
                else case_set / "hypotheses.jsonl"
            )
            if args.reference:
                reference_path = args.reference.expanduser().resolve()
            else:
                manifest = json.loads(
                    (case_set / "manifest.json").read_text(encoding="utf-8")
                )
                reference_path = Path(manifest["source"]).expanduser().resolve()
            expected_ids = [entry["question_id"] for entry in entries]
        for path in (hypotheses_path, reference_path):
            if not path.is_file():
                raise FileNotFoundError(path)

        hypotheses = _load_hypotheses(hypotheses_path)
        reference_by_id = _load_references(reference_path)
        hypothesis_ids = [row["question_id"] for row in hypotheses]
        if expected_ids is not None and hypothesis_ids != expected_ids:
            raise ValueError("hypothesis IDs/order do not match the case-set manifest")
        if expected_ids is None:
            expected_ids = hypothesis_ids
        missing = [value for value in expected_ids if value not in reference_by_id]
        if missing:
            raise ValueError(f"reference is missing question IDs: {missing[:5]}")

        if not args.metric_model:
            raise ValueError("LONGMEM_EVAL_MODEL or --metric-model is required")
        model_stem = args.metric_model.replace("/", "_")
        output = Path(f"{hypotheses_path}.eval-results-{model_stem}")
        metrics_path = Path(f"{output}.metrics.json")
        if (output.exists() or metrics_path.exists()) and not args.overwrite:
            raise FileExistsError(f"score output exists; pass --overwrite: {output}")
        print(
            f"questions={len(hypotheses)} model={args.metric_model} output={output}",
            flush=True,
        )
        if args.dry_run:
            return 0

        api_key = os.environ.get("OPENAI_API_KEY", "").strip() or LLM_API_KEY
        if not api_key:
            raise ValueError("KL_LLM_API_KEY or OPENAI_API_KEY is required")
        if not args.base_url:
            raise ValueError("KL_LLM_BASE_URL or OPENAI_BASE_URL is required")
        client = AsyncOpenAI(
            api_key=api_key,
            base_url=args.base_url,
            organization=os.environ.get("OPENAI_ORGANIZATION"),
            max_retries=5,
        )

        by_type: dict[str, list[int]] = defaultdict(list)
        abstention_scores: list[int] = []
        semaphore = asyncio.Semaphore(args.concurrency)
        tasks = [
            asyncio.create_task(
                _score_one(
                    hypothesis,
                    reference_by_id[hypothesis["question_id"]],
                    client,
                    args.metric_model,
                    semaphore,
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
            "metric_model": args.metric_model,
            "base_url": args.base_url,
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
