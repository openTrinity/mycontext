"""CLI for the Codex-driven LoCoMo evaluation."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from kl_graph.config import DATA_DIR, PROJECT_ROOT

from .artifacts import atomic_write_json
from .codex_runtime import RuntimeOptions
from .harness import HarnessOptions, run_agents
from .locomo_scoring import CATEGORY_NAMES
from .scoring import evaluate_agentic_results


AGENTIC_DIR = Path(__file__).resolve().parent
METRICS_PATH = DATA_DIR / "run_metrics.jsonl"


def record_event(component: str, event: str, **values: Any) -> None:
    """Append one evaluator lifecycle event without a package-level dependency."""
    METRICS_PATH.parent.mkdir(parents=True, exist_ok=True)
    row = {
        "timestamp": datetime.now().astimezone().isoformat(),
        "component": component,
        "event": event,
        **values,
    }
    with METRICS_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run blind LoCoMo questions through independent Codex KL agents."
    )
    parser.add_argument(
        "--dataset", type=Path, default=None,
        help="LoCoMo artifact directory; normally detected automatically",
    )
    parser.add_argument(
        "--graph-data-dir", type=Path, default=None,
        help="KL graph directory containing knowledge.db; normally detected automatically",
    )
    parser.add_argument("--output-dir", type=Path, default=None)
    parser.add_argument(
        "--run-id", default=None,
        help="name under category-N; default is local time YYYYMMDD-HHMMSS",
    )
    parser.add_argument("--category", type=int, choices=sorted(CATEGORY_NAMES))
    parser.add_argument("--question-id", default=None)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--max-concurrent", type=int, default=4)
    parser.add_argument(
        "--runtime-workers", type=int, default=1,
        help="number of Codex app-server processes (threads are agents)",
    )
    parser.add_argument(
        "--max-kl-calls", type=int, default=None,
        help="hard per-Agent cap across all KL CLI invocations",
    )
    parser.add_argument("--checkpoint-every", type=int, default=10)
    parser.add_argument("--timeout-seconds", type=float, default=600.0)
    parser.add_argument("--model", default=None, help="Codex model; default uses Codex configuration")
    parser.add_argument("--reasoning-effort", default=None)
    parser.add_argument(
        "--retrieval-k", type=int, default=5,
        help=(
            "first-observation cutoff for transcript Recall/MRR diagnostics; "
            "does not affect primary Citation Recall"
        ),
    )
    parser.add_argument("--eval", action="store_true", help="score only after every Agent stops")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument(
        "--skill-path", type=Path,
        default=PROJECT_ROOT / ".claude" / "skills" / "kl" / "SKILL.md",
    )
    parser.add_argument("--codex-sdk-path", type=Path, default=_default_sdk_path())
    parser.add_argument("--codex-bin", type=Path, default=_default_codex_bin())
    parser.add_argument(
        "--codex-config", type=Path,
        default=AGENTIC_DIR / "codex_config.toml",
        help="dedicated evaluator config; never defaults to ~/.codex/config.toml",
    )
    parser.add_argument(
        "--codex-auth", type=Path, default=_default_auth_path(),
        help="authentication file copied only into the temporary isolated runtime",
    )
    args = parser.parse_args(argv)

    for name in ("max_concurrent", "runtime_workers", "checkpoint_every", "retrieval_k"):
        if getattr(args, name) < 1:
            parser.error(f"--{name.replace('_', '-')} must be positive")
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive")
    if args.max_kl_calls is not None and args.max_kl_calls < 1:
        parser.error("--max-kl-calls must be positive")
    if args.timeout_seconds <= 0:
        parser.error("--timeout-seconds must be positive")
    if args.run_id is not None and not re.fullmatch(r"[A-Za-z0-9._-]+", args.run_id):
        parser.error("--run-id may contain only letters, digits, dot, underscore, and hyphen")
    if args.output_dir is not None and args.run_id is not None:
        parser.error("--output-dir and --run-id are mutually exclusive")
    return args


async def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    args.dataset = resolve_dataset_dir(args.dataset, PROJECT_ROOT)
    args.graph_data_dir = resolve_graph_data_dir(args.graph_data_dir, PROJECT_ROOT)
    # Child Codex runtimes inherit this. Keeping it explicit also makes the
    # run reproducible when the evaluator was launched without shell exports.
    os.environ["KL_DATA_DIR"] = str(args.graph_data_dir)
    _validate_paths(args)
    _check_kl_server()
    args.output_dir = resolve_output_dir(
        output_dir=args.output_dir,
        category=args.category,
        run_id=args.run_id,
        resume=args.resume,
        data_dir=args.graph_data_dir,
    )
    args.output_dir.mkdir(parents=True, exist_ok=True)
    config_snapshot = args.output_dir / "codex_config.toml"
    if not (args.resume and config_snapshot.is_file()):
        shutil.copyfile(args.codex_config, config_snapshot)
    args.codex_config = config_snapshot.resolve()
    _print_run_plan(args)

    runtime_options = RuntimeOptions(
        project_root=PROJECT_ROOT,
        skill_path=args.skill_path.resolve(),
        output_dir=args.output_dir.resolve(),
        codex_bin=args.codex_bin.resolve(),
        codex_sdk_path=args.codex_sdk_path.resolve() if args.codex_sdk_path else None,
        codex_config_path=args.codex_config,
        codex_auth_path=args.codex_auth.resolve(),
        model=args.model,
        reasoning_effort=args.reasoning_effort,
        max_kl_calls=args.max_kl_calls,
        timeout_s=args.timeout_seconds,
    )
    harness_options = HarnessOptions(
        dataset_dir=args.dataset.resolve(),
        output_dir=args.output_dir.resolve(),
        category=args.category,
        question_id=args.question_id,
        limit=args.limit,
        max_concurrent=args.max_concurrent,
        runtime_workers=args.runtime_workers,
        checkpoint_every=args.checkpoint_every,
        resume=args.resume,
    )
    record_event(
        "locomo_agentic_evaluation", "start",
        category=args.category, question_id=args.question_id, limit=args.limit,
        max_concurrent=args.max_concurrent, runtime_workers=args.runtime_workers,
        max_kl_calls=args.max_kl_calls, model=args.model,
        run_id=args.output_dir.name, output_dir=str(args.output_dir),
    )
    results = await run_agents(harness_options, runtime_options)

    # This is the synchronization barrier: the runtime context has closed and
    # no Agent task remains before Gold is loaded by the scorer.
    report = None
    if args.eval:
        report = evaluate_agentic_results(
            args.dataset.resolve(), args.output_dir.resolve(), results,
            retrieval_k=args.retrieval_k,
            sqlite_path=args.graph_data_dir / "knowledge.db",
        )
    run_path = args.output_dir / "run.json"
    run_metadata = json.loads(run_path.read_text(encoding="utf-8"))
    run_metadata.update({
        "status": "complete",
        "evaluated": args.eval,
        "evaluation_completed_at": (
            datetime.now().astimezone().isoformat() if args.eval else None
        ),
        "metrics_path": "metrics.json" if report is not None else None,
        "graph_data_dir": str(args.graph_data_dir),
    })
    atomic_write_json(run_path, run_metadata)
    record_event(
        "locomo_agentic_evaluation", "complete",
        category=args.category, questions=len(results), evaluated=args.eval,
    )
    _print_completion(args.output_dir, results, report)
    return 0


def _default_sdk_path() -> Path | None:
    configured = os.environ.get("KL_CODEX_SDK_PATH")
    if configured:
        return Path(configured)
    try:
        candidate = PROJECT_ROOT.parents[2] / "codex" / "sdk" / "python" / "src"
    except IndexError:
        return None
    return candidate if candidate.is_dir() else None


def _default_codex_bin() -> Path:
    configured = os.environ.get("KL_CODEX_BIN")
    if configured:
        return Path(configured)
    found = shutil.which("codex")
    return Path(found) if found else Path("codex")


def _default_auth_path() -> Path:
    configured = os.environ.get("KL_CODEX_AUTH_PATH")
    if configured:
        return Path(configured).expanduser()
    configured_home = os.environ.get("CODEX_HOME")
    codex_home = Path(configured_home).expanduser() if configured_home else Path.home() / ".codex"
    return codex_home / "auth.json"


def resolve_output_dir(
    *,
    output_dir: Path | None,
    category: int | None,
    run_id: str | None,
    resume: bool,
    now: datetime | None = None,
    data_dir: Path | None = None,
) -> Path:
    """Resolve a stable run directory without silently overwriting history."""
    if output_dir is not None:
        return output_dir
    category_name = f"category-{category}" if category else "all"
    category_root = (data_dir or DATA_DIR) / "benchmark" / "locomo-agentic" / category_name
    if run_id is not None:
        candidate = category_root / run_id
        if resume and not (candidate / "run.json").is_file():
            raise FileNotFoundError(f"run does not exist or has no run.json: {candidate}")
        if candidate.exists() and not resume:
            raise FileExistsError(
                f"run directory already exists: {candidate}; use --resume or another --run-id"
            )
        return candidate
    if resume:
        candidates = sorted(
            path for path in category_root.iterdir()
            if (
                path.is_dir()
                and re.fullmatch(r"\d{8}-\d{6}(?:-\d{2})?", path.name)
                and (path / "run.json").is_file()
            )
        ) if category_root.is_dir() else []
        if not candidates:
            raise FileNotFoundError(
                f"no timestamped run found to resume under {category_root}; "
                "pass --output-dir for a legacy run"
            )
        return candidates[-1]
    current = now or datetime.now().astimezone()
    stamp = current.strftime("%Y%m%d-%H%M%S")
    candidate = category_root / stamp
    suffix = 1
    while candidate.exists():
        candidate = category_root / f"{stamp}-{suffix:02d}"
        suffix += 1
    return candidate


def resolve_dataset_dir(dataset: Path | None, project_root: Path) -> Path:
    """Find the prepared LoCoMo artifacts used by the repository checkout."""
    if dataset is not None:
        return dataset.expanduser().resolve()
    configured = os.environ.get("KL_DATASET_DIR")
    if configured:
        return Path(configured).expanduser().resolve()

    candidates = [
        project_root / "dataset" / "locomo",
        project_root / "data" / "locomo",
    ]
    # In the dingtalk-rag-export checkout kl-graph is nested under vendor/.
    if len(project_root.parents) >= 2:
        candidates.append(
            project_root.parents[1]
            / "benchmark" / "benchmark_ir" / "artifacts" / "locomo"
        )
    for candidate in candidates:
        if (candidate / "evaluation.jsonl").is_file():
            return candidate.resolve()
    raise FileNotFoundError(
        "Could not find LoCoMo evaluation.jsonl automatically. "
        "Pass --dataset /path/to/locomo or set KL_DATASET_DIR."
    )


def resolve_graph_data_dir(graph_data_dir: Path | None, project_root: Path) -> Path:
    """Find one unambiguous KL graph directory containing knowledge.db."""
    if graph_data_dir is not None:
        return graph_data_dir.expanduser().resolve()
    configured = os.environ.get("KL_DATA_DIR")
    if configured:
        return Path(configured).expanduser().resolve()

    direct = project_root / "data"
    if (direct / "knowledge.db").is_file():
        return direct.resolve()
    matches = sorted(
        path.parent.resolve() for path in direct.glob("*/knowledge.db") if path.is_file()
    )
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        choices = ", ".join(str(path) for path in matches)
        raise RuntimeError(
            f"Multiple KL graph directories found ({choices}). Pass --graph-data-dir."
        )
    raise FileNotFoundError(
        "Could not find a KL knowledge.db automatically. "
        "Pass --graph-data-dir /path/to/graph or set KL_DATA_DIR."
    )


def _validate_paths(args: argparse.Namespace) -> None:
    if not (args.dataset / "evaluation.jsonl").is_file():
        raise FileNotFoundError(f"LoCoMo evaluation file not found under {args.dataset}")
    if not args.skill_path.is_file():
        raise FileNotFoundError(f"KL skill not found: {args.skill_path}")
    if not (args.graph_data_dir / "knowledge.db").is_file():
        raise FileNotFoundError(
            f"KL knowledge.db not found under {args.graph_data_dir}"
        )
    if not args.codex_bin.is_file():
        raise FileNotFoundError(f"Codex executable not found: {args.codex_bin}")
    if args.codex_sdk_path is not None and not args.codex_sdk_path.is_dir():
        raise FileNotFoundError(f"Codex SDK source not found: {args.codex_sdk_path}")
    if not args.codex_config.is_file():
        raise FileNotFoundError(f"Codex evaluator config not found: {args.codex_config}")
    if not args.codex_auth.is_file():
        raise FileNotFoundError(
            f"Codex auth file not found: {args.codex_auth}; "
            "pass --codex-auth or set KL_CODEX_AUTH_PATH"
        )


def _check_kl_server() -> None:
    port = int(os.environ.get("KL_SERVER_PORT", "8200"))
    try:
        response = httpx.get(f"http://127.0.0.1:{port}/health", timeout=3)
        response.raise_for_status()
    except Exception as exc:
        raise RuntimeError("KL server is not ready; start it with ./kl start") from exc


def _print_run_plan(args: argparse.Namespace) -> None:
    category = args.category if args.category is not None else "all"
    limit = args.limit if args.limit is not None else "all"
    call_limit = args.max_kl_calls if args.max_kl_calls is not None else "unlimited"
    print("LoCoMo agentic evaluation", flush=True)
    print(f"  dataset:       {args.dataset}", flush=True)
    print(f"  graph data:    {args.graph_data_dir}", flush=True)
    print(f"  output:        {args.output_dir}", flush=True)
    print(f"  Codex config:  {args.codex_config} (isolated)", flush=True)
    print(f"  selection:     category={category}, limit={limit}", flush=True)
    print(
        f"  agents:        concurrent={args.max_concurrent}, "
        f"KL calls/agent={call_limit}",
        flush=True,
    )
    print(f"  evaluate:      {'yes' if args.eval else 'no'}", flush=True)


def _print_completion(
    output_dir: Path,
    results: list,
    report: dict | None,
) -> None:
    completed = sum(result.status == "completed" for result in results)
    print(f"Completed: {completed}/{len(results)} agents", flush=True)
    if report is not None:
        overall = report.get("overall") or {}
        agentic = report.get("agentic") or {}
        print(
            "Scores: "
            f"QA={overall.get('answer_score')}, "
            f"Citation Recall={overall.get('global_evidence_recall')}, "
            f"MRR@5={agentic.get('first_observation_mrr@5')}",
            flush=True,
        )
    print(f"Results: {output_dir}", flush=True)
