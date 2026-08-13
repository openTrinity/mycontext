"""Run Khoj server retrieval for questions in the native LoCoMo dataset."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path, PurePath
from typing import Any

from omegaconf.errors import OmegaConfBaseException

from kl_graph.evaluation.io import (
    artifact_stem,
    atomic_write_json,
    atomic_write_jsonl,
    json_lines,
)
from kl_graph.evaluation.khoj import KhojEvaluationClient
from kl_graph.evaluation.locomo.experiment import (
    KhojAskExperiment,
    load_khoj_ask_experiment,
)

from ..source import (
    case_root,
    extract_dia_ids,
    load_samples,
    question_rows,
    select_samples,
    source_fingerprint,
)
from .build import load_state


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def _runtime_options(
    experiment: KhojAskExperiment, *, dry_run: bool
) -> argparse.Namespace:
    questions = experiment.selection.questions
    return argparse.Namespace(
        artifact_root=experiment.artifact_root,
        base_url=experiment.khoj.base_url,
        categories=questions.categories,
        category=(
            questions.categories[0]
            if questions.categories is not None and len(questions.categories) == 1
            else None
        ),
        checkpoint_every=experiment.ask.checkpoint_every,
        dry_run=dry_run,
        limit=questions.first,
        max_concurrent=experiment.ask.concurrency,
        output_dir=Path(experiment.run.output_dir),
        question_ids=questions.ids,
        question_id=(
            questions.ids[0]
            if questions.ids is not None and len(questions.ids) == 1
            else None
        ),
        resume=experiment.run.mode == "resume",
        timeout_seconds=experiment.ask.timeout_seconds,
        top_k=experiment.ask.top_k,
    )


def _resolve_output_dir(
    args: argparse.Namespace, selected: list[dict[str, Any]]
) -> Path:
    del selected
    candidate = args.output_dir.expanduser().resolve()
    if args.resume and not args.dry_run and not (candidate / "run.json").is_file():
        raise FileNotFoundError(f"Khoj ask run does not exist: {candidate}")
    return candidate


def _validate_states(
    client: KhojEvaluationClient,
    args: argparse.Namespace,
    source_sha256: str,
    samples: list[dict[str, Any]],
    current_server: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    states: dict[str, dict[str, Any]] = {}
    remote_documents = client.list_documents()
    for sample in samples:
        sample_id = str(sample["sample_id"])
        state = load_state(args.artifact_root, sample_id)
        if state.get("source_sha256") != source_sha256:
            raise ValueError(f"Khoj build source changed for {sample_id}")
        if state.get("status") != "complete":
            raise RuntimeError(f"Khoj build is not complete for {sample_id}")
        config = state.get("config") or {}
        if config.get("base_url") != args.base_url.rstrip("/"):
            raise ValueError(f"Khoj base URL differs from build for {sample_id}")
        if config.get("chunking_owner") != "khoj_server" or config.get(
            "client_chunking"
        ) is not False:
            raise ValueError(f"Khoj build did not use server chunking: {sample_id}")
        if state.get("server") != current_server:
            raise ValueError(f"Khoj server identity differs from build for {sample_id}")
        filename = str(state.get("document_name") or "")
        if filename not in remote_documents:
            raise RuntimeError(f"Khoj document is missing for {sample_id}: {filename}")
        remote = client.get_document(filename)
        remote_sha256 = hashlib.sha256(
            str(remote.get("raw_text") or "").encode()
        ).hexdigest()
        if remote_sha256 != state.get("remote_raw_text_sha256"):
            raise RuntimeError(f"Khoj document changed after build for {sample_id}")
        states[sample_id] = state
    return states


def _result_distance(result: dict[str, Any], name: str) -> float | None:
    value = result.get(name)
    if value is None and name == "cross_score":
        value = result.get("cross-score")
    if value is None:
        return None
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise TypeError(f"Khoj result {name} is not numeric")
    return float(value)


def _normalise_items(
    results: list[dict[str, Any]],
    *,
    top_k: int,
    expected_filename: str | None,
    document_owners: dict[str, str],
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for rank, result in enumerate(results, 1):
        additional = result.get("additional")
        if not isinstance(additional, dict):
            raise TypeError(f"Khoj result {rank} has no additional metadata")
        raw_filename = str(additional.get("file") or "")
        filename = PurePath(raw_filename).name
        if not filename:
            raise ValueError(f"Khoj result {rank} has no source filename")
        if expected_filename is not None and filename != expected_filename:
            raise ValueError(
                "Khoj search crossed the requested document boundary: "
                f"expected {expected_filename}, received {filename}"
            )
        content = str(additional.get("compiled") or result.get("entry") or "").strip()
        if not content:
            continue
        digest = hashlib.sha256(
            f"{filename}\0{rank}\0{content}".encode()
        ).hexdigest()
        vector_distance = _result_distance(result, "score")
        rerank_distance = _result_distance(result, "cross_score")
        ranking_distance = (
            rerank_distance if rerank_distance is not None else vector_distance
        )
        items.append(
            {
                "id": f"khoj-{digest}",
                "type": "chunk",
                "content": content,
                "timestamp": 0,
                "score": ranking_distance,
                "score_semantics": "distance_lower_is_better",
                "vector_distance": vector_distance,
                "rerank_distance": rerank_distance,
                "corpus_id": str(result.get("corpus_id") or "") or None,
                "document_name": filename,
                "source_sample_id": document_owners.get(filename),
                "dia_ids": extract_dia_ids(content),
            }
        )
        if len(items) >= top_k:
            break
    return items


def _ask_one(
    client: KhojEvaluationClient,
    row: dict[str, Any],
    state: dict[str, Any],
    document_owners: dict[str, str],
    args: argparse.Namespace,
    output_dir: Path,
) -> dict[str, Any]:
    started = time.monotonic()
    base = {
        "id": row["id"],
        "sample_id": row["sample_id"],
        "conversation_id": row["conversation_id"],
        "question": row["question"],
        "category": row["category"],
        "ask_calls": 1,
        "top_k": args.top_k,
    }
    try:
        filename = str(state["document_name"])
        results = client.search(
            str(row["question"]),
            filename=filename,
            result_count=args.top_k,
            rerank=True,
        )
        items = _normalise_items(
            results,
            top_k=args.top_k,
            expected_filename=filename,
            document_owners=document_owners,
        )
        relative = Path("responses") / f"{artifact_stem(str(row['id']))}.json"
        atomic_write_json(
            output_dir / relative,
            {
                "phase": 1,
                "answer": None,
                "mode": "khoj",
                "items": items,
                "retrieval": {
                    "returned_by_server": len(results),
                    "persisted_top_k": len(items),
                    "rerank": True,
                    "dedupe": False,
                    "content_type": "plaintext",
                    "chunking_owner": "khoj_server",
                },
            },
        )
        return {
            **base,
            "status": "completed",
            "duration_ms": round((time.monotonic() - started) * 1000),
            "response_path": str(relative),
            "error": None,
        }
    except Exception as exc:  # noqa: BLE001 - persist per-question failures
        return {
            **base,
            "status": "failed",
            "duration_ms": round((time.monotonic() - started) * 1000),
            "response_path": None,
            "error": f"{type(exc).__name__}: {exc}"[:2000],
        }


def _load_completed(path: Path) -> dict[str, dict[str, Any]]:
    if not path.is_file():
        return {}
    return {
        str(row["id"]): row
        for row in json_lines(path)
        if row.get("status") == "completed"
    }


def _ordered(
    rows: list[dict[str, Any]], completed: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    return [completed[row["id"]] for row in rows if row["id"] in completed]


def _write_run(
    output_dir: Path,
    *,
    args: argparse.Namespace,
    source: Path,
    source_sha256: str,
    selected: list[dict[str, Any]],
    states: dict[str, dict[str, Any]],
    rows: list[dict[str, Any]],
    result_count: int,
    status: str,
) -> None:
    atomic_write_json(
        output_dir / "run.json",
        {
            "status": status,
            "backend": "khoj",
            "benchmark": "locomo",
            "started_at": datetime.now().astimezone().isoformat(),
            "source": str(source),
            "source_sha256": source_sha256,
            "dataset": str(source),
            "artifact_root": str(args.artifact_root.expanduser().resolve()),
            "conversation": (
                str(selected[0]["sample_id"]) if len(selected) == 1 else None
            ),
            "conversations": [str(sample["sample_id"]) for sample in selected],
            "case_root": (
                str(case_root(args.artifact_root, str(selected[0]["sample_id"])))
                if len(selected) == 1
                else None
            ),
            "documents": {
                sample_id: state["document_name"]
                for sample_id, state in states.items()
            },
            "category": args.category,
            "categories": args.categories,
            "question_id": args.question_id,
            "question_ids": args.question_ids,
            "limit": args.limit,
            "questions": len(rows),
            "results": result_count,
            "top_k": args.top_k,
            "rerank": True,
            "dedupe": False,
            "content_type": "plaintext",
            "chunking_owner": "khoj_server",
            "max_concurrent": args.max_concurrent,
            "base_url": args.base_url.rstrip("/"),
            "protocol": "one_khoj_search_per_question",
        },
    )


def _validate_resume(
    output_dir: Path,
    args: argparse.Namespace,
    source_sha256: str,
    selected: list[dict[str, Any]],
    rows: list[dict[str, Any]],
) -> None:
    if not args.resume:
        return
    run = json.loads((output_dir / "run.json").read_text(encoding="utf-8"))
    expected = {
        "source_sha256": source_sha256,
        "conversations": [str(sample["sample_id"]) for sample in selected],
        "category": args.category,
        "categories": args.categories,
        "question_id": args.question_id,
        "question_ids": args.question_ids,
        "limit": args.limit,
        "questions": len(rows),
        "top_k": args.top_k,
        "dedupe": False,
        "base_url": args.base_url.rstrip("/"),
    }
    mismatch = {
        key: {"recorded": run.get(key), "requested": value}
        for key, value in expected.items()
        if run.get(key) != value
    }
    if mismatch:
        raise ValueError(
            "resume configuration differs: "
            + json.dumps(mismatch, ensure_ascii=False, sort_keys=True)
        )


def main(argv: list[str] | None = None) -> int:
    client: KhojEvaluationClient | None = None
    try:
        cli = parse_args(argv)
        experiment = load_khoj_ask_experiment(cli.config)
        args = _runtime_options(experiment, dry_run=cli.dry_run)
        source, samples = load_samples(experiment.source)
        selected = select_samples(samples, experiment.selection.conversations)
        source_sha256 = source_fingerprint(source)
        rows = question_rows(selected, experiment.selection.questions)
        output_dir = _resolve_output_dir(args, selected)
        if cli.dry_run:
            print(
                f"Khoj questions: {len(rows)}; concurrency={args.max_concurrent}\n"
                f"Output: {output_dir}",
                flush=True,
            )
            return 0
        _validate_resume(output_dir, args, source_sha256, selected, rows)
        client = KhojEvaluationClient(
            os.environ.get("KHOJ_API_TOKEN", ""),
            args.base_url,
            timeout_seconds=args.timeout_seconds,
        )
        health = client.health()
        settings = client.server_info()
        current_server = {
            "email": health.get("email"),
            "khoj_version": settings.get("khoj_version"),
        }
        states = _validate_states(
            client, args, source_sha256, selected, current_server
        )
    except (
        OSError,
        TypeError,
        ValueError,
        RuntimeError,
        json.JSONDecodeError,
        OmegaConfBaseException,
    ) as exc:
        if client is not None:
            client.close()
        print(f"error: {exc}", file=sys.stderr)
        return 2

    output_dir.mkdir(parents=True, exist_ok=True)
    results_path = output_dir / "results.jsonl"
    completed = _load_completed(results_path) if args.resume else {}
    document_owners = {
        str(state["document_name"]): sample_id for sample_id, state in states.items()
    }
    _write_run(
        output_dir,
        args=args,
        source=source,
        source_sha256=source_sha256,
        selected=selected,
        states=states,
        rows=rows,
        result_count=len(completed),
        status="running",
    )
    print(
        f"Khoj questions: {len(rows)}; concurrency={args.max_concurrent}; "
        "document_filter=exact; dedupe=false",
        flush=True,
    )
    futures: dict[Future[dict[str, Any]], str] = {}
    try:
        with ThreadPoolExecutor(
            max_workers=min(args.max_concurrent, len(rows)),
            thread_name_prefix="locomo-khoj-ask",
        ) as executor:
            for row in rows:
                if row["id"] in completed:
                    continue
                futures[
                    executor.submit(
                        _ask_one,
                        client,
                        row,
                        states[str(row["sample_id"])],
                        document_owners,
                        args,
                        output_dir,
                    )
                ] = str(row["id"])
            since_checkpoint = 0
            for future in as_completed(futures):
                result = future.result()
                completed[str(result["id"])] = result
                since_checkpoint += 1
                if result["status"] != "completed":
                    print(
                        f"FAILED {result['id']}: {result['error']}",
                        file=sys.stderr,
                    )
                if since_checkpoint >= args.checkpoint_every:
                    atomic_write_jsonl(results_path, _ordered(rows, completed))
                    print(f"completed {len(completed)}/{len(rows)}", flush=True)
                    since_checkpoint = 0
    finally:
        client.close()

    ordered = _ordered(rows, completed)
    atomic_write_jsonl(results_path, ordered)
    failures = sum(row["status"] != "completed" for row in ordered)
    status = (
        "complete" if len(ordered) == len(rows) and failures == 0 else "incomplete"
    )
    _write_run(
        output_dir,
        args=args,
        source=source,
        source_sha256=source_sha256,
        selected=selected,
        states=states,
        rows=rows,
        result_count=len(ordered),
        status=status,
    )
    print(f"Results: {output_dir}", flush=True)
    return 0 if status == "complete" else 1


if __name__ == "__main__":
    raise SystemExit(main())
