"""Self-contained LoCoMo answer and evidence scoring for agentic runs."""

from __future__ import annotations

import collections
import json
import re
import string
from pathlib import Path
from typing import Any

from nltk.stem import PorterStemmer

from kl_graph.data.locomo import json_lines

from .artifacts import atomic_write_json, atomic_write_jsonl


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
    found = len(set(evidence) & set(retrieved))
    return found / len(evidence), float(found == len(evidence))


def evaluate_answers(
    answer_path: Path,
    metrics_path: Path,
    scored_path: Path,
) -> dict[str, Any]:
    """Score agent answers and their final cited evidence against LoCoMo Gold."""
    rows = list(json_lines(answer_path))
    retrieval_modes = sorted({
        str(row.get("retrieval_mode") or "codex_agentic") for row in rows
    })
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
        answer_score = (
            official_answer_score(category, prediction, row["ground_truth"])
            if prediction
            else None
        )
        bucket = buckets[category]
        if answer_score is not None:
            bucket["answer"].append(answer_score)
        bucket["global"].append(global_recall)
        if row["evidence"]:
            bucket["global_nonempty"].append(global_recall)
        bucket["global_complete"].append(global_complete)
        scored.append({
            **row,
            "answer_score": answer_score,
            "global_evidence_recall": global_recall,
            "global_complete_evidence_recall": global_complete,
        })

    by_category = {}
    for category in (4, 1, 2, 3, 5):
        bucket = buckets[category]
        by_category[CATEGORY_NAMES[category]] = {
            "category": category,
            "questions": len(bucket["global"]),
            "generated_answers": len(bucket["answer"]),
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
        "benchmark": "LoCoMo QA — Codex agentic KL workflow",
        "retrieval_modes": retrieval_modes,
        "metric": (
            "official normalized token F1 / adversarial accuracy and "
            "citation dia_id evidence recall"
        ),
        "questions": len(rows),
        "generated_answers": len(all_answer),
        "overall": {
            "answer_score": _mean(all_answer),
            "global_evidence_recall": _mean(all_global),
            "global_evidence_recall_nonempty_gold": _mean(global_nonempty),
        },
        "by_category": by_category,
    }
    atomic_write_jsonl(scored_path, scored)
    atomic_write_json(metrics_path, report)
    print(json.dumps(report["overall"], ensure_ascii=False, sort_keys=True))
    return report


def _mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None
