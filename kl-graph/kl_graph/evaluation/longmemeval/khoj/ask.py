"""Run one Khoj search for each native LongMemEval question case."""

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
from kl_graph.evaluation.longmemeval.experiment import (
    KhojAskExperiment,
    case_stage_output_dir,
    experiment_output_dir,
    load_khoj_ask_experiment,
    output_dir,
    select_entries,
)
from kl_graph.evaluation.longmemeval.source import (
    case_root,
    load_cases,
    render_document_turns,
    source_fingerprint,
)

from .build import load_state


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config", type=Path, required=True, help="LongMemEval Khoj experiment YAML"
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--case-id")
    return parser.parse_args(argv)


def _runtime_options(
    experiment: KhojAskExperiment, *, case_id: str | None
) -> argparse.Namespace:
    """Adapt typed YAML values to the existing ask worker boundary."""
    return argparse.Namespace(
        artifact_root=experiment_output_dir(experiment),
        base_url=experiment.khoj.base_url,
        checkpoint_every=experiment.ask.checkpoint_every,
        max_concurrent=experiment.ask.concurrency,
        max_retries=experiment.khoj.max_retries,
        output_dir=(
            case_stage_output_dir(experiment, case_id, "ask")
            if case_id is not None
            else output_dir(experiment)
        ),
        overwrite=experiment.run.mode == "overwrite",
        resume=experiment.run.mode == "resume",
        timeout_seconds=experiment.ask.timeout_seconds,
        top_k=experiment.ask.top_k,
    )


def _resolve_output_dir(
    args: argparse.Namespace, selected: list[dict[str, Any]]
) -> Path:
    del selected  # the YAML output directory is explicit for every selection
    candidate = args.output_dir.expanduser().resolve()
    if args.resume:
        run_path = candidate / "run.json"
        if candidate.exists() and not run_path.is_file():
            unexpected = [
                path.name
                for path in candidate.iterdir()
                if path.name != "experiment.resolved.json"
            ]
            if unexpected:
                raise FileNotFoundError(
                    f"Khoj ask run is incomplete at {candidate}: {unexpected}"
                )
    elif candidate.exists() and not args.overwrite:
        raise FileExistsError(f"output directory exists: {candidate}")
    return candidate


def _validate_states(
    client: KhojEvaluationClient,
    args: argparse.Namespace,
    source_sha256: str,
    cases: list[dict[str, Any]],
    current_server: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    states: dict[str, dict[str, Any]] = {}
    remote_documents = client.list_documents()
    for case in cases:
        question_id = str(case["question_id"])
        state = load_state(args.artifact_root, question_id)
        if state.get("source_sha256") != source_sha256:
            raise ValueError(f"Khoj build source changed for {question_id}")
        if state.get("status") != "complete":
            raise RuntimeError(f"Khoj build is not complete for {question_id}")
        config = state.get("config") or {}
        if config.get("base_url") != args.base_url.rstrip("/"):
            raise ValueError(f"Khoj base URL differs from build for {question_id}")
        if (
            config.get("chunking_owner") != "khoj_server"
            or config.get("client_chunking") is not False
        ):
            raise ValueError(f"Khoj build did not use server chunking: {question_id}")
        if state.get("server") != current_server:
            raise ValueError(
                f"Khoj server identity differs from build for {question_id}"
            )
        filename = str(state.get("document_name") or "")
        if filename not in remote_documents:
            raise RuntimeError(
                f"Khoj document is missing for {question_id}: {filename}"
            )
        remote = client.get_document(filename)
        remote_sha256 = hashlib.sha256(
            str(remote.get("raw_text") or "").encode("utf-8")
        ).hexdigest()
        if remote_sha256 != state.get("remote_raw_text_sha256"):
            raise RuntimeError(f"Khoj document changed after build for {question_id}")
        states[question_id] = state
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
    expected_filename: str,
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for rank, result in enumerate(results, 1):
        additional = result.get("additional")
        if not isinstance(additional, dict):
            raise TypeError(f"Khoj result {rank} has no additional metadata")
        filename = PurePath(str(additional.get("file") or "")).name
        if not filename:
            raise ValueError(f"Khoj result {rank} has no source filename")
        if filename != expected_filename:
            raise ValueError(
                "Khoj search crossed the requested document boundary: "
                f"expected {expected_filename}, received {filename}"
            )
        content = str(additional.get("compiled") or result.get("entry") or "").strip()
        if not content:
            continue
        digest = hashlib.sha256(f"{filename}\0{rank}\0{content}".encode()).hexdigest()
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
            }
        )
        if len(items) >= top_k:
            break
    return items


def _source_turn_ids(
    case: dict[str, Any], *, filename: str, compiled: str
) -> list[str]:
    """Map one server-owned Khoj chunk back to its contributing user turns."""
    prefix = f"{filename}\n"
    body = compiled.removeprefix(prefix).strip()
    if not body:
        raise ValueError(f"Khoj chunk contains no document text: {filename}")

    rendered_turns = render_document_turns(case)
    document = "".join(text for _, text in rendered_turns)
    starts: list[int] = []
    offset = 0
    for _, text in rendered_turns:
        starts.append(offset)
        offset += len(text)

    matches: list[int] = []
    start = document.find(body)
    while start >= 0:
        matches.append(start)
        start = document.find(body, start + 1)
    if not matches:
        raise ValueError(
            f"Khoj chunk cannot be located in the uploaded source document: {filename}"
        )

    candidates: list[list[str]] = []
    for chunk_start in matches:
        chunk_end = chunk_start + len(body)
        ids = [
            turn_id
            for (turn_id, text), turn_start in zip(rendered_turns, starts, strict=True)
            if turn_start < chunk_end and turn_start + len(text) > chunk_start
        ]
        if ids and ids not in candidates:
            candidates.append(ids)
    if len(candidates) != 1:
        raise ValueError(
            "Khoj chunk has an ambiguous source-turn mapping: "
            f"{filename}; candidates={candidates}"
        )
    return candidates[0]


def _ask_one(
    client: KhojEvaluationClient,
    case: dict[str, Any],
    state: dict[str, Any],
    args: argparse.Namespace,
    output_dir: Path,
) -> dict[str, Any]:
    started = time.monotonic()
    question_id = str(case["question_id"])
    base = {
        "id": question_id,
        "question_id": question_id,
        "question": str(case["question"]),
        "question_type": str(case["question_type"]),
        "ask_calls": 1,
        "top_k": args.top_k,
    }
    try:
        filename = str(state["document_name"])
        results = client.search(
            str(case["question"]),
            filename=filename,
            result_count=args.top_k,
            rerank=True,
        )
        items = _normalise_items(results, top_k=args.top_k, expected_filename=filename)
        if not items:
            raise RuntimeError(f"Khoj returned no usable chunks for {question_id}")
        for item in items:
            item["source_turn_ids"] = _source_turn_ids(
                case,
                filename=filename,
                compiled=str(item["content"]),
            )
        relative = Path("responses") / f"{artifact_stem(question_id)}.json"
        atomic_write_json(
            output_dir / relative,
            {
                "question_id": question_id,
                "answer": None,
                "mode": "khoj",
                "items": items,
                "retrieval": {
                    "returned_by_server": len(results),
                    "persisted_top_k": len(items),
                    "rerank": True,
                    "dedupe": False,
                    "document_filter": filename,
                    "content_type": "plaintext",
                    "chunking_owner": "khoj_server",
                    "source_turn_mapping": "uploaded_document_character_spans_v1",
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
    except Exception as exc:  # noqa: BLE001 - persist per-case failure
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
        str(row["question_id"]): row
        for row in json_lines(path)
        if row.get("status") == "completed"
    }


def _ordered(
    cases: list[dict[str, Any]], completed: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    return [
        completed[str(case["question_id"])]
        for case in cases
        if str(case["question_id"]) in completed
    ]


def _write_run(
    output_dir: Path,
    *,
    args: argparse.Namespace,
    source: Path,
    source_sha256: str,
    selected: list[dict[str, Any]],
    states: dict[str, dict[str, Any]],
    result_count: int,
    status: str,
) -> None:
    atomic_write_json(
        output_dir / "run.json",
        {
            "status": status,
            "backend": "khoj",
            "benchmark": "longmemeval",
            "started_at": datetime.now().astimezone().isoformat(),
            "source": str(source),
            "source_sha256": source_sha256,
            "artifact_root": str(args.artifact_root.expanduser().resolve()),
            "question_id": (
                str(selected[0]["question_id"]) if len(selected) == 1 else None
            ),
            "question_ids": [str(case["question_id"]) for case in selected],
            "case_root": (
                str(case_root(args.artifact_root, str(selected[0]["question_id"])))
                if len(selected) == 1
                else None
            ),
            "documents": {
                question_id: state["document_name"]
                for question_id, state in states.items()
            },
            "questions": len(selected),
            "results": result_count,
            "top_k": args.top_k,
            "rerank": True,
            "dedupe": False,
            "content_type": "plaintext",
            "chunking_owner": "khoj_server",
            "source_turn_mapping": "uploaded_document_character_spans_v1",
            "max_concurrent": args.max_concurrent,
            "base_url": args.base_url.rstrip("/"),
            "protocol": "one_document_filtered_khoj_search_per_question_case",
        },
    )


def _validate_resume(
    output_dir: Path,
    args: argparse.Namespace,
    source_sha256: str,
    selected: list[dict[str, Any]],
) -> None:
    if not args.resume:
        return
    run_path = output_dir / "run.json"
    if not run_path.is_file():
        return
    run = json.loads(run_path.read_text(encoding="utf-8"))
    expected = {
        "source_sha256": source_sha256,
        "question_ids": [str(case["question_id"]) for case in selected],
        "questions": len(selected),
        "top_k": args.top_k,
        "dedupe": False,
        "base_url": args.base_url.rstrip("/"),
        "source_turn_mapping": "uploaded_document_character_spans_v1",
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
    try:
        cli = parse_args(argv)
        experiment = load_khoj_ask_experiment(cli.config)
        args = _runtime_options(experiment, case_id=cli.case_id)
    except (OSError, TypeError, ValueError, OmegaConfBaseException) as exc:
        print(f"error: invalid experiment configuration: {exc}", file=sys.stderr)
        return 2
    client: KhojEvaluationClient | None = None
    try:
        source, cases = load_cases(experiment.source)
        selected = select_entries(cases, experiment.selection)
        if cli.case_id is not None:
            selected = [
                case for case in selected if str(case["question_id"]) == cli.case_id
            ]
            if len(selected) != 1:
                raise ValueError(f"case is not selected: {cli.case_id}")
        source_sha256 = source_fingerprint(source)
        if cli.dry_run:
            print(
                f"Khoj LongMemEval questions: {len(selected)}; "
                f"concurrency={args.max_concurrent}; output={args.output_dir}",
                flush=True,
            )
            return 0
        output_dir = _resolve_output_dir(args, selected)
        _validate_resume(output_dir, args, source_sha256, selected)
        client = KhojEvaluationClient(
            os.environ.get("KHOJ_API_TOKEN", ""),
            args.base_url,
            timeout_seconds=args.timeout_seconds,
            max_retries=args.max_retries,
        )
        health = client.health()
        settings = client.server_info()
        current_server = {
            "email": health.get("email"),
            "khoj_version": settings.get("khoj_version"),
        }
        states = _validate_states(client, args, source_sha256, selected, current_server)
    except (OSError, TypeError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        if client is not None:
            client.close()
        print(f"error: {exc}", file=sys.stderr)
        return 2

    output_dir.mkdir(parents=True, exist_ok=True)
    results_path = output_dir / "results.jsonl"
    if not args.resume:
        atomic_write_jsonl(results_path, [])
    completed = _load_completed(results_path) if args.resume else {}
    _write_run(
        output_dir,
        args=args,
        source=source,
        source_sha256=source_sha256,
        selected=selected,
        states=states,
        result_count=len(completed),
        status="running",
    )
    print(
        f"Khoj LongMemEval questions: {len(selected)}; "
        f"concurrency={args.max_concurrent}; document_filter=exact; dedupe=false",
        flush=True,
    )
    futures: dict[Future[dict[str, Any]], str] = {}
    try:
        with ThreadPoolExecutor(
            max_workers=min(args.max_concurrent, len(selected)),
            thread_name_prefix="longmemeval-khoj-ask",
        ) as executor:
            for case in selected:
                question_id = str(case["question_id"])
                if question_id in completed:
                    continue
                futures[
                    executor.submit(
                        _ask_one,
                        client,
                        case,
                        states[question_id],
                        args,
                        output_dir,
                    )
                ] = question_id
            since_checkpoint = 0
            for future in as_completed(futures):
                result = future.result()
                completed[str(result["question_id"])] = result
                since_checkpoint += 1
                if result["status"] != "completed":
                    print(
                        f"FAILED {result['question_id']}: {result['error']}",
                        file=sys.stderr,
                    )
                if since_checkpoint >= args.checkpoint_every:
                    atomic_write_jsonl(results_path, _ordered(selected, completed))
                    print(f"completed {len(completed)}/{len(selected)}", flush=True)
                    since_checkpoint = 0
    finally:
        client.close()

    ordered = _ordered(selected, completed)
    atomic_write_jsonl(results_path, ordered)
    failures = sum(row["status"] != "completed" for row in ordered)
    status = (
        "complete" if len(ordered) == len(selected) and failures == 0 else "incomplete"
    )
    _write_run(
        output_dir,
        args=args,
        source=source,
        source_sha256=source_sha256,
        selected=selected,
        states=states,
        result_count=len(ordered),
        status=status,
    )
    print(f"Results: {output_dir}", flush=True)
    return 0 if status == "complete" else 1


if __name__ == "__main__":
    raise SystemExit(main())
