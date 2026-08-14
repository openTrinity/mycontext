"""Upload one native LongMemEval question case as one Khoj Document."""

from __future__ import annotations

import argparse
import hashlib
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

from kl_graph.evaluation.io import artifact_stem, atomic_write_json
from kl_graph.evaluation.khoj import KhojEvaluationClient
from kl_graph.evaluation.longmemeval.experiment import (
    KhojBuildExperiment,
    experiment_output_dir,
    load_khoj_build_experiment,
    select_entries,
)
from kl_graph.evaluation.longmemeval.source import (
    case_root,
    document_fingerprint,
    load_cases,
    render_document,
    source_fingerprint,
)

_OUTPUT_LOCK = threading.Lock()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config", type=Path, required=True, help="LongMemEval Khoj experiment YAML"
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--case-id")
    return parser.parse_args(argv)


def _runtime_options(
    experiment: KhojBuildExperiment, *, dry_run: bool
) -> argparse.Namespace:
    """Adapt typed YAML values to the existing build worker boundary."""
    return argparse.Namespace(
        artifact_root=experiment_output_dir(experiment),
        base_url=experiment.khoj.base_url,
        case_concurrency=experiment.build.case_concurrency,
        document_prefix=experiment.build.document_prefix,
        dry_run=dry_run,
        keep_going=experiment.run.keep_going,
        resume=experiment.run.mode == "resume",
        timeout_seconds=experiment.build.timeout_seconds,
        max_retries=experiment.khoj.max_retries,
    )


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _state_path(artifact_root: Path, question_id: str) -> Path:
    return case_root(artifact_root, question_id) / "build" / "khoj.json"


def load_state(artifact_root: Path, question_id: str) -> dict[str, Any]:
    path = _state_path(artifact_root, question_id)
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise TypeError(f"Khoj state is not an object: {path}")
    return value


def _write_state(artifact_root: Path, question_id: str, state: dict[str, Any]) -> None:
    state["updated_at"] = _utc_now()
    atomic_write_json(_state_path(artifact_root, question_id), state)


def document_name(question_id: str, *, document_prefix: str, source_sha256: str) -> str:
    return (
        f"{artifact_stem(document_prefix)}-{artifact_stem(question_id)}-"
        f"{source_sha256[:8]}.txt"
    )


def _new_state(
    case: dict[str, Any],
    source: Path,
    source_sha256: str,
    server: dict[str, Any],
    args: argparse.Namespace,
) -> dict[str, Any]:
    question_id = str(case["question_id"])
    return {
        "schema_version": 1,
        "benchmark": "longmemeval",
        "backend": "khoj",
        "question_id": question_id,
        "source": str(source),
        "source_sha256": source_sha256,
        "document_sha256": document_fingerprint(case),
        "status": "starting",
        "created_at": _utc_now(),
        "updated_at": _utc_now(),
        "config": {
            "base_url": args.base_url.rstrip("/"),
            "document_prefix": args.document_prefix.strip(),
            "document_policy": "one_user_only_transcript_per_question_case",
            "content_type": "plaintext",
            "chunking_owner": "khoj_server",
            "client_chunking": False,
        },
        "server": server,
        "document_name": document_name(
            question_id,
            document_prefix=args.document_prefix,
            source_sha256=source_sha256,
        ),
        "remote_document_id": None,
        "remote_raw_text_sha256": None,
        "error": None,
    }


def _validate_resume(
    state: dict[str, Any], expected: dict[str, Any], path: Path
) -> None:
    keys = (
        "question_id",
        "source_sha256",
        "document_sha256",
        "config",
        "server",
        "document_name",
    )
    mismatch = {
        key: {"recorded": state.get(key), "requested": expected.get(key)}
        for key in keys
        if state.get(key) != expected.get(key)
    }
    if mismatch:
        raise ValueError(
            f"cannot resume incompatible Khoj state {path}: "
            + json.dumps(mismatch, ensure_ascii=False, sort_keys=True)
        )


def _remote_document(
    client: KhojEvaluationClient, filename: str
) -> dict[str, Any] | None:
    if filename not in client.list_documents():
        return None
    value = client.get_document(filename)
    if value.get("file_name") != filename:
        raise RuntimeError(
            f"Khoj returned the wrong document for {filename}: "
            f"{value.get('file_name')!r}"
        )
    return value


def _build_one(
    client: KhojEvaluationClient | None,
    source: Path,
    source_sha256: str,
    case: dict[str, Any],
    server: dict[str, Any],
    args: argparse.Namespace,
    position: int,
    total: int,
) -> None:
    question_id = str(case["question_id"])
    state_path = _state_path(args.artifact_root, question_id)
    expected = _new_state(case, source, source_sha256, server, args)
    _print(f"[{position}/{total}] START {question_id}")
    if args.dry_run:
        _print(
            f"  document={expected['document_name']}\n"
            "  document_policy=one_user_only_transcript_per_question_case\n"
            "  chunking_owner=khoj_server"
        )
        return

    if state_path.exists():
        if not args.resume:
            raise FileExistsError(
                f"Khoj state already exists: {state_path}; pass --resume"
            )
        state = load_state(args.artifact_root, question_id)
        _validate_resume(state, expected, state_path)
    else:
        state = expected
        _write_state(args.artifact_root, question_id, state)

    assert client is not None
    started = time.monotonic()
    content = render_document(case).encode("utf-8")
    content_sha256 = hashlib.sha256(content).hexdigest()
    filename = str(state["document_name"])
    try:
        remote = _remote_document(client, filename)
        if remote is None:
            state["status"] = "uploading"
            _write_state(args.artifact_root, question_id, state)
            client.upload_document(filename, content)
            remote = _remote_document(client, filename)
            if remote is None:
                raise RuntimeError(
                    f"Khoj upload completed but document is missing: {filename}"
                )

        remote_text = str(remote.get("raw_text") or "")
        remote_sha256 = hashlib.sha256(remote_text.encode("utf-8")).hexdigest()
        if remote_sha256 != content_sha256:
            raise RuntimeError(
                f"Khoj document content differs for {filename}; refusing to "
                "overwrite an unexpected remote document"
            )
        state.update(
            {
                "status": "complete",
                "remote_document_id": remote.get("id"),
                "remote_raw_text_sha256": remote_sha256,
                "finished_at": _utc_now(),
                "elapsed_seconds": round(time.monotonic() - started, 3),
                "error": None,
            }
        )
        _write_state(args.artifact_root, question_id, state)
        _print(f"[{position}/{total}] COMPLETE {question_id}\n  document={filename}")
    except Exception as exc:
        state["status"] = "failed"
        state["error"] = f"{type(exc).__name__}: {exc}"
        _write_state(args.artifact_root, question_id, state)
        raise


def _run(
    client: KhojEvaluationClient,
    source: Path,
    source_sha256: str,
    cases: list[dict[str, Any]],
    server: dict[str, Any],
    args: argparse.Namespace,
) -> list[str]:
    failures: list[str] = []
    futures: dict[Future[None], str] = {}
    with ThreadPoolExecutor(
        max_workers=min(args.case_concurrency, len(cases)),
        thread_name_prefix="longmemeval-khoj-build",
    ) as executor:
        for position, case in enumerate(cases, 1):
            future = executor.submit(
                _build_one,
                client,
                source,
                source_sha256,
                case,
                server,
                args,
                position,
                len(cases),
            )
            futures[future] = str(case["question_id"])
        stop = False
        for future in as_completed(futures):
            question_id = futures[future]
            if future.cancelled():
                continue
            try:
                future.result()
            except Exception as exc:  # noqa: BLE001 - report remote failures
                failures.append(question_id)
                _print(
                    f"FAILED {question_id}: {type(exc).__name__}: {exc}",
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
        experiment = load_khoj_build_experiment(cli.config)
        args = _runtime_options(experiment, dry_run=cli.dry_run)
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
        if args.dry_run:
            server: dict[str, Any] = {}
        else:
            client = KhojEvaluationClient(
                os.environ.get("KHOJ_API_TOKEN", ""),
                args.base_url,
                timeout_seconds=args.timeout_seconds,
                max_retries=args.max_retries,
            )
            health = client.health()
            settings = client.server_info()
            server = {
                "email": health.get("email"),
                "khoj_version": settings.get("khoj_version"),
            }
    except (OSError, TypeError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        if client is not None:
            client.close()
        print(f"error: {exc}", file=sys.stderr)
        return 2

    _print(
        f"Native LongMemEval cases selected: {len(selected)}\n"
        "Document policy: one user-only plaintext document per case\n"
        "Chunking owner: Khoj server\n"
        f"Build concurrency: {min(args.case_concurrency, len(selected))}\n"
        f"Artifacts: {args.artifact_root.expanduser().resolve()}",
    )
    try:
        if args.dry_run:
            for position, case in enumerate(selected, 1):
                _build_one(
                    client,
                    source,
                    source_sha256,
                    case,
                    server,
                    args,
                    position,
                    len(selected),
                )
            failures: list[str] = []
        else:
            assert client is not None
            failures = _run(client, source, source_sha256, selected, server, args)
    finally:
        if client is not None:
            client.close()
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
