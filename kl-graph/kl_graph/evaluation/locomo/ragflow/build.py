"""Build one RAGFlow Dataset from each native LoCoMo conversation."""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from omegaconf.errors import OmegaConfBaseException

from kl_graph.evaluation.io import atomic_write_json
from kl_graph.evaluation.locomo.experiment import (
    RagflowBuildExperiment,
    experiment_output_dir,
    load_ragflow_build_experiment,
)
from kl_graph.evaluation.ragflow import RagflowEvaluationClient

from ..source import (
    case_root,
    load_samples,
    normalize_sample_id,
    render_transcript,
    select_samples,
    source_fingerprint,
    transcript_fingerprint,
)

_OUTPUT_LOCK = threading.Lock()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--case-id")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def _runtime_options(
    experiment: RagflowBuildExperiment, *, dry_run: bool
) -> argparse.Namespace:
    return argparse.Namespace(
        artifact_root=experiment_output_dir(experiment),
        base_url=experiment.ragflow.base_url,
        case_concurrency=experiment.build.case_concurrency,
        chunk_method=experiment.build.chunk_method,
        chunk_token_num=experiment.build.chunk_token_num,
        dataset_prefix=experiment.build.dataset_prefix,
        delimiter=experiment.build.delimiter,
        dry_run=dry_run,
        embedding_model=experiment.build.embedding_model,
        graph=experiment.build.graph,
        graph_timeout=experiment.build.graph_timeout_seconds,
        keep_going=experiment.run.keep_going,
        parse_timeout=experiment.build.parse_timeout_seconds,
        poll_seconds=experiment.build.poll_seconds,
        resume=experiment.run.mode == "resume",
    )


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _state_path(artifact_root: Path, sample_id: str) -> Path:
    return case_root(artifact_root, sample_id) / "build" / "ragflow.json"


def load_state(artifact_root: Path, sample_id: str) -> dict[str, Any]:
    path = _state_path(artifact_root, sample_id)
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise TypeError(f"RAGFlow state is not an object: {path}")
    return value


def _write_state(artifact_root: Path, sample_id: str, state: dict[str, Any]) -> None:
    state["updated_at"] = _utc_now()
    atomic_write_json(_state_path(artifact_root, sample_id), state)


def _new_state(
    sample: dict[str, Any],
    source: Path,
    source_sha256: str,
    args: argparse.Namespace,
) -> dict[str, Any]:
    sample_id = str(sample["sample_id"])
    transcript_sha256 = transcript_fingerprint(sample)
    return {
        "schema_version": 1,
        "benchmark": "locomo",
        "backend": "ragflow",
        "sample_id": sample_id,
        "conversation_id": sample_id,
        "source": str(source),
        "source_sha256": source_sha256,
        "transcript_sha256": transcript_sha256,
        "status": "starting",
        "created_at": _utc_now(),
        "updated_at": _utc_now(),
        "config": {
            "base_url": args.base_url.rstrip("/"),
            "embedding_model": args.embedding_model,
            "chunk_method": args.chunk_method,
            "chunk_token_num": args.chunk_token_num,
            "delimiter": args.delimiter,
            "graph": bool(args.graph),
            "document_policy": "one_complete_conversation_document",
        },
        "dataset_id": None,
        "dataset_name": (
            f"{args.dataset_prefix.strip()}-{sample_id}-{source_sha256[:8]}"
        ),
        "document_id": None,
        "document_name": f"{sample_id}.txt",
        "parse": None,
        "graph": None,
        "error": None,
    }


def _validate_resume(
    state: dict[str, Any], expected: dict[str, Any], path: Path
) -> None:
    keys = ("sample_id", "source_sha256", "transcript_sha256", "config")
    mismatch = {
        key: {"recorded": state.get(key), "requested": expected.get(key)}
        for key in keys
        if state.get(key) != expected.get(key)
    }
    if mismatch:
        raise ValueError(
            f"cannot resume incompatible RAGFlow state {path}: "
            + json.dumps(mismatch, ensure_ascii=False, sort_keys=True)
        )


def _ensure_document(
    client: RagflowEvaluationClient,
    dataset: Any,
    sample: dict[str, Any],
    state: dict[str, Any],
    args: argparse.Namespace,
) -> dict[str, Any]:
    sample_id = str(sample["sample_id"])
    document_id = str(state.get("document_id") or "")
    if not document_id:
        document = client.upload_document(
            dataset,
            name=str(state["document_name"]),
            content=render_transcript(sample).encode("utf-8"),
        )
        document_id = str(document.id)
        state["document_id"] = document_id
        state["status"] = "uploaded"
        _write_state(args.artifact_root, sample_id, state)

    parse_state = client.document_state(dataset, document_id)
    if parse_state["state"] != "complete":
        if parse_state["state"] != "running":
            client.start_parse(dataset, [document_id])
        state["status"] = "parsing"
        state["parse"] = parse_state
        _write_state(args.artifact_root, sample_id, state)
        parse_state = client.wait_for_document(
            dataset,
            document_id,
            timeout_seconds=args.parse_timeout,
            poll_seconds=args.poll_seconds,
        )
    state["parse"] = parse_state
    state["status"] = "parsed"
    _write_state(args.artifact_root, sample_id, state)
    return state


def _ensure_graph(
    client: RagflowEvaluationClient,
    state: dict[str, Any],
    args: argparse.Namespace,
) -> dict[str, Any]:
    sample_id = str(state["sample_id"])
    dataset_id = str(state["dataset_id"])
    graph_state = client.graph_state(dataset_id)
    if graph_state["state"] == "complete":
        state["graph"] = graph_state
        return state
    if graph_state["state"] != "running":
        task_id = client.start_graph(dataset_id)
        graph_state = {
            "state": "running",
            "progress": 0.0,
            "task_id": task_id,
        }
    state["status"] = "building_graph"
    state["graph"] = graph_state
    _write_state(args.artifact_root, sample_id, state)
    state["graph"] = client.wait_for_graph(
        dataset_id,
        timeout_seconds=args.graph_timeout,
        poll_seconds=args.poll_seconds,
    )
    return state


def _refresh_failed_remote_state(
    client: RagflowEvaluationClient,
    dataset: Any | None,
    state: dict[str, Any],
    args: argparse.Namespace,
) -> None:
    """Best-effort snapshot of the remote terminal state after a failure."""
    sample_id = str(state["sample_id"])
    document_id = str(state.get("document_id") or "")
    if dataset is not None and document_id:
        try:
            state["parse"] = client.document_state(dataset, document_id)
        except Exception as exc:  # noqa: BLE001 - preserve original build error
            state.setdefault("remote_refresh_errors", {})["parse"] = (
                f"{type(exc).__name__}: {exc}"
            )
    dataset_id = str(state.get("dataset_id") or "")
    if args.graph and dataset_id:
        try:
            state["graph"] = client.graph_state(dataset_id)
        except Exception as exc:  # noqa: BLE001 - preserve original build error
            state.setdefault("remote_refresh_errors", {})["graph"] = (
                f"{type(exc).__name__}: {exc}"
            )
    _write_state(args.artifact_root, sample_id, state)


def _build_one(
    client: RagflowEvaluationClient,
    source: Path,
    source_sha256: str,
    sample: dict[str, Any],
    args: argparse.Namespace,
    position: int,
    total: int,
) -> None:
    sample_id = str(sample["sample_id"])
    state_path = _state_path(args.artifact_root, sample_id)
    expected = _new_state(sample, source, source_sha256, args)
    dataset: Any | None = None
    _print(f"[{position}/{total}] START {sample_id}")
    if args.dry_run:
        _print(
            f"  dataset={expected['dataset_name']}",
            f"  document={expected['document_name']}",
            f"  graph={args.graph}",
        )
        return

    if state_path.exists():
        if not args.resume:
            raise FileExistsError(
                f"RAGFlow state already exists: {state_path}; pass --resume"
            )
        state = load_state(args.artifact_root, sample_id)
        _validate_resume(state, expected, state_path)
    else:
        state = expected
        _write_state(args.artifact_root, sample_id, state)

    started = time.monotonic()
    try:
        dataset_id = str(state.get("dataset_id") or "")
        if dataset_id:
            dataset = client.get_dataset(dataset_id)
        else:
            dataset = client.create_dataset(
                name=str(state["dataset_name"]),
                description=(
                    f"Native LoCoMo evaluation conversation {sample_id}; "
                    "one complete transcript document"
                ),
                embedding_model=args.embedding_model,
                chunk_method=args.chunk_method,
                parser_config={
                    "chunk_token_num": args.chunk_token_num,
                    "delimiter": args.delimiter,
                },
            )
            state["dataset_id"] = str(dataset.id)
            state["status"] = "dataset_created"
            _write_state(args.artifact_root, sample_id, state)

        _ensure_document(client, dataset, sample, state, args)
        if args.graph:
            _ensure_graph(client, state, args)
        state["status"] = "complete"
        state["finished_at"] = _utc_now()
        state["elapsed_seconds"] = round(time.monotonic() - started, 3)
        state["error"] = None
        _write_state(args.artifact_root, sample_id, state)
        _print(
            f"[{position}/{total}] COMPLETE {sample_id}",
            f"  dataset_id={state['dataset_id']}",
            f"  chunks={(state.get('parse') or {}).get('chunk_count')}",
            f"  graph={(state.get('graph') or {}).get('state', 'disabled')}",
        )
    except Exception as exc:
        state["status"] = "failed"
        state["error"] = f"{type(exc).__name__}: {exc}"
        _refresh_failed_remote_state(client, dataset, state, args)
        raise


def _run(
    client: RagflowEvaluationClient,
    source: Path,
    source_sha256: str,
    samples: list[dict[str, Any]],
    args: argparse.Namespace,
) -> list[str]:
    workers = min(args.case_concurrency, len(samples))
    failures: list[str] = []
    futures: dict[Future[None], str] = {}
    with ThreadPoolExecutor(
        max_workers=workers, thread_name_prefix="locomo-ragflow-build"
    ) as executor:
        for position, sample in enumerate(samples, 1):
            future = executor.submit(
                _build_one,
                client,
                source,
                source_sha256,
                sample,
                args,
                position,
                len(samples),
            )
            futures[future] = str(sample["sample_id"])
        stop = False
        for future in as_completed(futures):
            sample_id = futures[future]
            if future.cancelled():
                continue
            try:
                future.result()
            except Exception as exc:  # noqa: BLE001 - report remote SDK failures
                failures.append(sample_id)
                _print(
                    f"FAILED {sample_id}: {type(exc).__name__}: {exc}",
                    file=sys.stderr,
                )
                if not args.keep_going and not stop:
                    stop = True
                    for pending in futures:
                        pending.cancel()
    return failures


def _print(*lines: str, file=None) -> None:
    with _OUTPUT_LOCK:
        for line in lines:
            print(line, file=file, flush=True)


def main(argv: list[str] | None = None) -> int:
    try:
        cli = parse_args(argv)
        experiment = load_ragflow_build_experiment(cli.config)
        args = _runtime_options(experiment, dry_run=cli.dry_run)
        source, samples = load_samples(experiment.source)
        selected = select_samples(samples, experiment.selection.conversations)
        if cli.case_id is not None:
            requested = normalize_sample_id(cli.case_id)
            selected = [
                sample
                for sample in selected
                if normalize_sample_id(str(sample["sample_id"])) == requested
            ]
            if len(selected) != 1:
                raise ValueError(f"case is not selected: {cli.case_id}")
        source_sha256 = source_fingerprint(source)
        if args.dry_run:
            client = None
        else:
            client = RagflowEvaluationClient(
                os.environ.get("RAGFLOW_API_KEY", ""), args.base_url
            )
    except (
        OSError,
        TypeError,
        ValueError,
        json.JSONDecodeError,
        OmegaConfBaseException,
    ) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    _print(
        f"Native LoCoMo conversations selected: {len(selected)}",
        f"RAGFlow build concurrency: {min(args.case_concurrency, len(selected))}",
        f"GraphRAG: {'enabled' if args.graph else 'disabled'}",
        f"Artifacts: {args.artifact_root.expanduser().resolve()}",
    )
    if args.dry_run:
        for position, sample in enumerate(selected, 1):
            _build_one(
                None, source, source_sha256, sample, args, position, len(selected)
            )
        return 0
    failures = _run(client, source, source_sha256, selected, args)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
