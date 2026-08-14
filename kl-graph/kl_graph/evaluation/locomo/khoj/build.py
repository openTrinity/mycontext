"""Upload one complete native LoCoMo conversation document to Khoj."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from omegaconf.errors import OmegaConfBaseException

from kl_graph.evaluation.io import atomic_write_json
from kl_graph.evaluation.khoj import KhojEvaluationClient
from kl_graph.evaluation.locomo.experiment import (
    KhojBuildExperiment,
    experiment_output_dir,
    load_khoj_build_experiment,
)

from ..source import (
    case_root,
    document_name,
    load_samples,
    normalize_sample_id,
    render_transcript,
    select_samples,
    source_fingerprint,
    transcript_fingerprint,
)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--case-id")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def _runtime_options(
    experiment: KhojBuildExperiment, *, dry_run: bool
) -> argparse.Namespace:
    return argparse.Namespace(
        artifact_root=experiment_output_dir(experiment),
        base_url=experiment.khoj.base_url,
        dataset_prefix=experiment.build.dataset_prefix,
        dry_run=dry_run,
        keep_going=experiment.run.keep_going,
        resume=experiment.run.mode == "resume",
        timeout_seconds=experiment.build.timeout_seconds,
    )


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _state_path(artifact_root: Path, sample_id: str) -> Path:
    return case_root(artifact_root, sample_id) / "build" / "khoj.json"


def load_state(artifact_root: Path, sample_id: str) -> dict[str, Any]:
    path = _state_path(artifact_root, sample_id)
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise TypeError(f"Khoj state is not an object: {path}")
    return value


def _write_state(artifact_root: Path, sample_id: str, state: dict[str, Any]) -> None:
    state["updated_at"] = _utc_now()
    atomic_write_json(_state_path(artifact_root, sample_id), state)


def _new_state(
    sample: dict[str, Any],
    source: Path,
    source_sha256: str,
    server: dict[str, Any],
    args: argparse.Namespace,
) -> dict[str, Any]:
    sample_id = str(sample["sample_id"])
    name = document_name(
        sample_id,
        dataset_prefix=args.dataset_prefix,
        source_sha256=source_sha256,
    )
    return {
        "schema_version": 1,
        "benchmark": "locomo",
        "backend": "khoj",
        "sample_id": sample_id,
        "conversation_id": sample_id,
        "source": str(source),
        "source_sha256": source_sha256,
        "transcript_sha256": transcript_fingerprint(sample),
        "status": "starting",
        "created_at": _utc_now(),
        "updated_at": _utc_now(),
        "config": {
            "base_url": args.base_url.rstrip("/"),
            "dataset_prefix": args.dataset_prefix.strip(),
            "document_policy": "one_complete_native_conversation_document",
            "content_type": "plaintext",
            "chunking_owner": "khoj_server",
            "client_chunking": False,
        },
        "server": server,
        "document_name": name,
        "remote_document_id": None,
        "remote_raw_text_sha256": None,
        "error": None,
    }


def _validate_resume(
    state: dict[str, Any], expected: dict[str, Any], path: Path
) -> None:
    keys = (
        "sample_id",
        "source_sha256",
        "transcript_sha256",
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
    sample: dict[str, Any],
    server: dict[str, Any],
    args: argparse.Namespace,
    position: int,
    total: int,
) -> None:
    sample_id = str(sample["sample_id"])
    state_path = _state_path(args.artifact_root, sample_id)
    expected = _new_state(sample, source, source_sha256, server, args)
    print(f"[{position}/{total}] START {sample_id}", flush=True)
    if args.dry_run:
        print(
            f"  document={expected['document_name']}\n  chunking_owner=khoj_server",
            flush=True,
        )
        return

    if state_path.exists():
        if not args.resume:
            raise FileExistsError(
                f"Khoj state already exists: {state_path}; pass --resume"
            )
        state = load_state(args.artifact_root, sample_id)
        _validate_resume(state, expected, state_path)
    else:
        state = expected
        _write_state(args.artifact_root, sample_id, state)

    assert client is not None
    started = time.monotonic()
    transcript = render_transcript(sample)
    content = transcript.encode("utf-8")
    content_sha256 = hashlib.sha256(content).hexdigest()
    filename = str(state["document_name"])
    try:
        remote = _remote_document(client, filename)
        if remote is None:
            state["status"] = "uploading"
            _write_state(args.artifact_root, sample_id, state)
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
        _write_state(args.artifact_root, sample_id, state)
        print(
            f"[{position}/{total}] COMPLETE {sample_id}\n  document={filename}",
            flush=True,
        )
    except Exception as exc:
        state["status"] = "failed"
        state["error"] = f"{type(exc).__name__}: {exc}"
        _write_state(args.artifact_root, sample_id, state)
        raise


def main(argv: list[str] | None = None) -> int:
    client: KhojEvaluationClient | None = None
    try:
        cli = parse_args(argv)
        experiment = load_khoj_build_experiment(cli.config)
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
            server: dict[str, Any] = {}
        else:
            client = KhojEvaluationClient(
                os.environ.get("KHOJ_API_TOKEN", ""),
                args.base_url,
                timeout_seconds=args.timeout_seconds,
            )
            health = client.health()
            settings = client.server_info()
            server = {
                "email": health.get("email"),
                "khoj_version": settings.get("khoj_version"),
            }
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

    print(
        f"Native LoCoMo conversations selected: {len(selected)}\n"
        "Document policy: one complete plaintext conversation\n"
        "Chunking owner: Khoj server\n"
        f"Artifacts: {args.artifact_root.expanduser().resolve()}",
        flush=True,
    )
    failures: list[str] = []
    try:
        for position, sample in enumerate(selected, 1):
            try:
                _build_one(
                    client,
                    source,
                    source_sha256,
                    sample,
                    server,
                    args,
                    position,
                    len(selected),
                )
            except Exception as exc:  # noqa: BLE001 - report remote failures
                sample_id = str(sample["sample_id"])
                failures.append(sample_id)
                print(
                    f"FAILED {sample_id}: {type(exc).__name__}: {exc}",
                    file=sys.stderr,
                    flush=True,
                )
                if not args.keep_going:
                    break
    finally:
        if client is not None:
            client.close()
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
