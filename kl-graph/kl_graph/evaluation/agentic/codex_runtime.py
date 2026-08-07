"""Thin adapter around the local Codex Python SDK."""

from __future__ import annotations

import asyncio
import importlib
import os
import shutil
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .artifacts import (
    TranscriptWriter,
    create_agent_workspace,
    preserve_tool_log,
    remove_agent_workspace,
)
from .models import (
    FINAL_OUTPUT_SCHEMA,
    AgentCase,
    AgentResult,
    artifact_stem,
    parse_agent_output,
)
from .prompts import DEVELOPER_INSTRUCTIONS, case_prompt


@dataclass(frozen=True, slots=True)
class RuntimeOptions:
    project_root: Path
    skill_path: Path
    output_dir: Path
    codex_bin: Path
    codex_sdk_path: Path | None
    codex_config_path: Path
    codex_auth_path: Path
    model: str | None
    reasoning_effort: str | None
    max_kl_calls: int | None
    timeout_s: float


def load_codex_sdk(sdk_path: Path | None = None) -> dict[str, Any]:
    """Import the Python SDK, optionally from a local Codex checkout."""
    if sdk_path is not None:
        path = sdk_path.expanduser().resolve()
        if not (path / "openai_codex" / "__init__.py").is_file():
            raise RuntimeError(f"invalid Codex Python SDK source path: {path}")
        if str(path) not in sys.path:
            sys.path.insert(0, str(path))

    try:
        module = importlib.import_module("openai_codex")
    except ImportError:
        raise RuntimeError(
            "openai_codex is not installed; pass --codex-sdk-path pointing "
            "to the Codex sdk/python/src directory"
        ) from None

    types = importlib.import_module("openai_codex.types")
    return {
        "AsyncCodex": module.AsyncCodex,
        "ApprovalMode": module.ApprovalMode,
        "CodexConfig": module.CodexConfig,
        "Sandbox": module.Sandbox,
        "SkillInput": module.SkillInput,
        "TextInput": module.TextInput,
        "ReasoningEffort": types.ReasoningEffort,
    }


class CodexRuntimePool:
    """One or more app-server clients multiplexing independent agent threads."""

    def __init__(self, options: RuntimeOptions, workers: int = 1):
        if workers < 1:
            raise ValueError("workers must be positive")
        self.options = options
        self.workers = workers
        self.sdk = load_codex_sdk(options.codex_sdk_path)
        self.clients: list[Any] = []
        self.effective_model: str | None = options.model
        self._temporary_home: tempfile.TemporaryDirectory[str] | None = None

    async def __aenter__(self) -> CodexRuntimePool:  # noqa: PYI034
        config_type = self.sdk["CodexConfig"]
        client_type = self.sdk["AsyncCodex"]
        try:
            self._temporary_home = tempfile.TemporaryDirectory(
                prefix="kl-locomo-codex-"
            )
            codex_home = Path(self._temporary_home.name)
            materialize_isolated_codex_home(
                codex_home,
                self.options.codex_config_path,
                self.options.codex_auth_path,
            )
            runtime_env = os.environ.copy()
            runtime_env.update({
                "CODEX_HOME": str(codex_home),
                "CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG": "1",
            })
            for index in range(self.workers):
                config = config_type(
                    codex_bin=str(self.options.codex_bin),
                    cwd=str(self.options.project_root),
                    client_name="kl_locomo_agentic_eval",
                    client_title="KL LoCoMo Agentic Eval",
                    env=runtime_env,
                )
                client = client_type(config=config)
                await client.__aenter__()
                self.clients.append(client)
                if self.effective_model is None and index == 0:
                    models = await client.models()
                    default_model = next(
                        (model.model for model in models.data if model.is_default), None
                    )
                    if default_model is None and models.data:
                        default_model = models.data[0].model
                    self.effective_model = default_model
        except Exception:
            await self.close()
            raise
        return self

    async def __aexit__(self, _exc_type, _exc, _tb) -> None:
        await self.close()

    async def close(self) -> None:
        while self.clients:
            client = self.clients.pop()
            await client.__aexit__(None, None, None)
        if self._temporary_home is not None:
            self._temporary_home.cleanup()
            self._temporary_home = None

    async def run_case(
        self,
        case: AgentCase,
        result: AgentResult,
        worker_index: int,
    ) -> AgentResult:
        client = self.clients[worker_index % len(self.clients)]
        return await _run_case(
            client, self.sdk, self.options, self.effective_model, case, result
        )


def materialize_isolated_codex_home(
    codex_home: Path,
    config_path: Path,
    auth_path: Path,
) -> None:
    """Create a runtime home without inheriting the user's Codex TOML.

    The evaluation configuration is safe to persist in the repository. The
    authentication file is copied only into a short-lived temporary directory
    with owner-only permissions and is deleted when the runtime pool closes.
    """
    codex_home.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(config_path, codex_home / "config.toml")
    destination = codex_home / "auth.json"
    shutil.copyfile(auth_path, destination)
    destination.chmod(0o600)


async def _run_case(
    client: Any,
    sdk: dict[str, Any],
    options: RuntimeOptions,
    effective_model: str | None,
    case: AgentCase,
    result: AgentResult,
) -> AgentResult:
    stem = artifact_stem(case.id)
    transcript_path = options.output_dir / "transcripts" / f"{stem}.jsonl"
    tool_log_path = options.output_dir / "transcripts" / f"{stem}.kl_calls.jsonl"
    workspace = create_agent_workspace(
        options.output_dir / ".work",
        stem,
        options.project_root / "kl",
        options.max_kl_calls,
        options.skill_path,
    )
    result.transcript_path = str(transcript_path.relative_to(options.output_dir))
    result.max_kl_calls = options.max_kl_calls

    writer = TranscriptWriter(transcript_path)
    turn = None
    try:
        thread_kwargs: dict[str, Any] = {
            "approval_mode": sdk["ApprovalMode"].deny_all,
            "config": {"sandbox_workspace_write": {"network_access": True}},
            "cwd": str(workspace),
            "developer_instructions": DEVELOPER_INSTRUCTIONS,
            "ephemeral": True,
            "sandbox": sdk["Sandbox"].workspace_write,
        }
        if effective_model:
            thread_kwargs["model"] = effective_model
            result.model = effective_model
        thread = await client.thread_start(**thread_kwargs)
        result.thread_id = thread.id

        writer.write(
            "case_start",
            id=case.id,
            question=case.question,
            thread_id=thread.id,
            model=effective_model,
            max_kl_calls=options.max_kl_calls,
            skill_path=str(options.skill_path),
        )

        turn_kwargs: dict[str, Any] = {"output_schema": FINAL_OUTPUT_SCHEMA}
        if options.reasoning_effort:
            turn_kwargs["effort"] = sdk["ReasoningEffort"](options.reasoning_effort)
        turn = await thread.turn(
            [
                sdk["SkillInput"](
                    name="kl",
                    path=str(workspace / ".agents" / "skills" / "kl" / "SKILL.md"),
                ),
                sdk["TextInput"](text=case_prompt(case, options.max_kl_calls)),
            ],
            **turn_kwargs,
        )
        result.turn_id = turn.id
        outcome = await asyncio.wait_for(
            _consume_turn(turn, writer), timeout=options.timeout_s
        )
        result.status = outcome["status"]
        result.duration_ms = outcome.get("duration_ms")
        result.usage = outcome.get("usage")
        if outcome.get("error"):
            result.error = outcome["error"]
        if result.status == "completed":
            result.answer, result.citations = parse_agent_output(
                outcome.get("final_response")
            )
    except asyncio.TimeoutError:
        result.status = "timeout"
        result.error = f"Codex turn exceeded {options.timeout_s:g}s"
        if turn is not None:
            try:
                await turn.interrupt()
            except Exception:  # noqa: BLE001, S110
                pass
    except Exception as exc:  # noqa: BLE001
        result.status = "failed"
        result.error = f"{type(exc).__name__}: {exc}"
    finally:
        counters = preserve_tool_log(workspace, tool_log_path)
        result.kl_calls = counters["used"]
        result.denied_kl_calls = counters["denied"]
        writer.write(
            "case_end",
            status=result.status,
            answer=result.answer,
            citations=[{"type": citation.type, "id": citation.id} for citation in result.citations],
            error=result.error,
            kl_calls=result.kl_calls,
            denied_kl_calls=result.denied_kl_calls,
            max_kl_calls=result.max_kl_calls,
        )
        writer.close()
        remove_agent_workspace(workspace)
    return result


async def _consume_turn(turn: Any, writer: TranscriptWriter) -> dict[str, Any]:
    """Persist every event while collecting the terminal structured response."""
    completed_messages: list[tuple[str | None, str]] = []
    usage: dict[str, Any] | None = None
    terminal: dict[str, Any] | None = None

    async for event in turn.stream():
        writer.write_event(event)
        payload = event.payload
        if event.method == "item/completed":
            item = getattr(payload, "item", None)
            root = getattr(item, "root", item)
            if getattr(root, "type", None) == "agentMessage":
                phase = getattr(root, "phase", None)
                phase_value = getattr(phase, "value", phase)
                completed_messages.append((phase_value, getattr(root, "text", "")))
        elif event.method == "thread/tokenUsage/updated":
            token_usage = getattr(payload, "token_usage", None)
            if token_usage is not None:
                usage = token_usage.model_dump(mode="json", by_alias=True)
        elif event.method == "turn/completed":
            turn_value = payload.turn
            error = getattr(turn_value, "error", None)
            terminal = {
                "status": getattr(turn_value.status, "value", str(turn_value.status)),
                "duration_ms": getattr(turn_value, "duration_ms", None),
                "error": error.message if error is not None else None,
            }

    if terminal is None:
        raise RuntimeError("Codex event stream ended without turn/completed")
    final_response = None
    for phase, text in reversed(completed_messages):
        if phase == "final_answer":
            final_response = text
            break
        if final_response is None and phase is None:
            final_response = text
    terminal["final_response"] = final_response
    terminal["usage"] = usage
    return terminal
