"""Build contracts shared by evaluation runners that use production KL Graph.

The benchmark runners deliberately delegate ingestion and retrieval to the
production entry points.  This module only records enough immutable metadata
to prove that a built graph is complete and that a later query process is
using a compatible storage/embedding configuration.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from kl_graph.config import cfg

BUILD_STATUS_SCHEMA_VERSION = 2
BUILD_CONFIGURATION_SCHEMA_VERSION = 1


def _sha256(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def retrieval_configuration(config: Any = None) -> dict[str, Any]:
    """Return the build-time settings that must also hold at query time."""
    if config is None:
        config = cfg
    vector_backend = str(config.storage.vector.backend)
    vector: dict[str, Any] = {"backend": vector_backend}
    if vector_backend == "qdrant":
        vector.update(
            {
                "host": str(config.storage.vector.qdrant.host or ""),
                "port": int(config.storage.vector.qdrant.port),
            }
        )
    elif vector_backend == "zvec":
        vector.update(
            {
                "index_type": str(config.storage.vector.zvec.index_type),
                "metric": str(config.storage.vector.zvec.metric),
            }
        )

    graph_backend = str(config.storage.graph.backend)
    graph: dict[str, Any] = {"backend": graph_backend}
    if graph_backend == "falkordb":
        graph.update(
            {
                "host": str(config.storage.graph.falkordb.host),
                "port": int(config.storage.graph.falkordb.port),
            }
        )

    return {
        "embedding": {
            "model": str(config.services.embedding.model),
            "dimensions": int(config.services.embedding.dim),
            "send_dimensions": bool(config.services.embedding.send_dimensions),
        },
        "storage": {"graph": graph, "vector": vector},
        "communities_enabled": bool(config.pipelines.experimental.communities.enabled),
    }


def production_build_configuration(
    *, source_id: str, improve_mode: str, config: Any = None
) -> dict[str, Any]:
    """Describe one production build without persisting credentials."""
    if config is None:
        config = cfg
    strategies = {
        str(key): str(value)
        for key, value in config.pipelines.ingestion.extraction.strategies.items()
    }
    return {
        "schema_version": BUILD_CONFIGURATION_SCHEMA_VERSION,
        "source_id": source_id,
        "retrieval": retrieval_configuration(config),
        "ingestion": {
            "improve_mode": improve_mode,
            "extraction": {
                "provider": str(config.services.llm_flash.provider),
                "model": str(config.services.llm_flash.model),
                "prompt_language": str(
                    config.pipelines.ingestion.extraction.prompt_language
                ),
                "strategies": dict(sorted(strategies.items())),
            },
            "entity_cleanup_enabled": bool(config.pipelines.ingestion.cleanup.enabled),
            "entity_description_summarize": bool(
                config.pipelines.ingestion.entity_description.summarize
            ),
        },
    }


def configuration_fingerprint(configuration: dict[str, Any]) -> str:
    """Return a stable digest for a persisted production build snapshot."""
    return _sha256(configuration)


def ingest_checkpoint_path(data_dir: Path, source_id: str) -> Path:
    """Mirror the production checkpoint filename for a caller-owned source."""
    safe_source = "".join(
        character if character.isalnum() or character in "-_" else "_"
        for character in source_id
    )
    return data_dir / f"ingest_checkpoint.{safe_source}.json"


def load_ingest_result(data_dir: Path, source_id: str) -> dict[str, Any]:
    """Read the authoritative result saved by ``run_ingestion``."""
    checkpoint_path = ingest_checkpoint_path(data_dir, source_id)
    try:
        checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RuntimeError(f"ingest checkpoint is missing: {checkpoint_path}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"invalid ingest checkpoint: {checkpoint_path}") from exc

    complete = (checkpoint.get("steps") or {}).get("ingest.complete")
    if not isinstance(complete, dict) or complete.get("status") != "done":
        raise RuntimeError(
            f"ingest checkpoint has no completed result: {checkpoint_path}"
        )
    raw = complete.get("result")
    if not isinstance(raw, dict):
        raise TypeError(
            f"ingest checkpoint predates result metadata; rebuild the case: "
            f"{checkpoint_path}"
        )

    integer_fields = (
        "units_discovered",
        "units_skipped",
        "units_processed",
        "chunks_created",
        "extraction_total",
        "extraction_succeeded",
        "extraction_failed",
    )
    result: dict[str, Any] = {}
    for field in integer_fields:
        try:
            value = int(raw.get(field, 0))
        except (TypeError, ValueError) as exc:
            raise RuntimeError(
                f"invalid {field!r} in ingest checkpoint: {checkpoint_path}"
            ) from exc
        if value < 0:
            raise RuntimeError(
                f"negative {field!r} in ingest checkpoint: {checkpoint_path}"
            )
        result[field] = value

    failures = raw.get("failures", [])
    if not isinstance(failures, list):
        raise TypeError(f"invalid failures in ingest checkpoint: {checkpoint_path}")
    result["failures"] = failures
    result["outcome"] = "partial" if result["extraction_failed"] else "success"
    result["checkpoint"] = str(checkpoint_path)
    return result


def require_successful_ingest(result: dict[str, Any]) -> None:
    """Reject partial extraction: benchmark graphs must be reproducibly whole."""
    failed = int(result.get("extraction_failed", 0))
    if failed:
        raise RuntimeError(
            f"production ingestion completed partially: {failed}/"
            f"{result.get('extraction_total', 0)} extraction items failed"
        )
    if result.get("outcome") != "success":
        raise RuntimeError(f"production ingestion outcome is {result.get('outcome')!r}")


def validate_production_build_status(
    status_path: Path,
    *,
    dataset: str,
    source_id: str,
    config: Any = None,
) -> dict[str, Any]:
    """Validate completeness and build/query configuration compatibility."""
    try:
        status = json.loads(status_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RuntimeError(
            f"production build status is missing; rebuild the case: {status_path}"
        ) from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"invalid production build status: {status_path}") from exc
    if not isinstance(status, dict):
        raise TypeError(f"production build status is not an object: {status_path}")
    if status.get("schema_version") != BUILD_STATUS_SCHEMA_VERSION:
        raise RuntimeError(
            f"production build status is incompatible; rebuild the case: {status_path}"
        )
    if status.get("dataset") != dataset or status.get("source_id") != source_id:
        raise RuntimeError(f"production build identity mismatch: {status_path}")
    if status.get("state") != "complete":
        raise RuntimeError(
            f"production build is not complete ({status.get('state')}): {status_path}"
        )

    ingest = status.get("ingest")
    if not isinstance(ingest, dict):
        raise TypeError(f"production build has no ingest result: {status_path}")
    require_successful_ingest(ingest)

    configuration = status.get("configuration")
    if not isinstance(configuration, dict):
        raise TypeError(f"production build has no configuration: {status_path}")
    recorded_fingerprint = status.get("configuration_sha256")
    if recorded_fingerprint != configuration_fingerprint(configuration):
        raise RuntimeError(f"production build configuration is corrupt: {status_path}")
    if configuration.get("source_id") != source_id:
        raise RuntimeError(
            f"production build source configuration mismatch: {status_path}"
        )

    recorded_retrieval = configuration.get("retrieval")
    current_retrieval = retrieval_configuration(config)
    if recorded_retrieval != current_retrieval:
        raise RuntimeError(
            "current KL storage/embedding configuration differs from the build; "
            f"rebuild the case or restore its configuration: {status_path}"
        )
    return status
