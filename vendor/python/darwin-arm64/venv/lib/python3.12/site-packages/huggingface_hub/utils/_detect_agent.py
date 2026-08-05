# Copyright 2026 The HuggingFace Team. All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Detect whether the process is being invoked by an AI coding agent.

Detection is based on environment variables that AI agents set in their shell
sessions. `AI_AGENT` and `AGENT` are treated as a universal standard (any
tool can set its harness id there); the remaining checks are tool-specific and
ordered by priority (first match wins).

The list of known harnesses is maintained on the Hub and exposed at
`{ENDPOINT}/api/agent-harnesses`. We fetch it at most once a day and cache it
locally so the list can be updated without requiring a new client release.

Detection is entirely best-effort: there is no hardcoded list of harnesses. When
the registry cannot be fetched (and no cached copy is available), detection simply
reports "no agent". Any error while fetching/reading the registry is swallowed —
detection must never make a process fail.

More details: https://huggingface.co/docs/hub/agents-overview#register-your-agent-harness
"""

import json
import os
import time
from pathlib import Path
from typing import Optional, TypedDict

from .. import constants
from . import logging


logger = logging.get_logger(__name__)

# Refresh the cached registry at most once every 24 hours.
_REGISTRY_TTL_SECONDS = 24 * 3600

# Short timeout: fetching the registry is best-effort telemetry, never block the caller for long.
_REGISTRY_FETCH_TIMEOUT = 3


class HarnessInfo(TypedDict, total=False):
    """A single harness entry. `envVars` maps an env var name to a match pattern (see `_env_vars_match`)."""

    envVars: dict[str, str]


class Registry(TypedDict):
    """The agent harness registry, as served by `{ENDPOINT}/api/agent-harnesses`."""

    standardEnvVars: list[str]
    harnesses: dict[str, HarnessInfo]


# Empty registry: detection is disabled (no agent ever detected). Used when the
# Hub is unreachable and no cached copy is available.
_EMPTY_REGISTRY: Registry = {"standardEnvVars": [], "harnesses": {}}

# In-process cache of the resolved registry. Populated lazily on first detection.
_registry: Registry | None = None


def detect_agent() -> Optional[str]:
    """Return the id of the detected AI agent harness or `None`.

    Harnesses are checked in registry order; for each one we match its env var
    pattern(s) and, failing that, the standard `AI_AGENT` / `AGENT` vars
    against the harness id. The first match wins. When a standard var is set to
    an unrecognized value, `"unknown"` is returned.
    """
    registry = _get_registry()
    standard_vars = registry.get("standardEnvVars") or []
    harnesses = registry.get("harnesses") or {}

    for harness_id, info in harnesses.items():
        env_vars = (info or {}).get("envVars")
        if env_vars and _env_vars_match(env_vars):
            return harness_id
        for var in standard_vars:
            if os.environ.get(var, "").strip() == harness_id:
                return harness_id

    # No harness matched but a standard var is set => unrecognized agent.
    lowercased_harnesses = {k.lower() for k in harnesses.keys()}
    for var in standard_vars:
        if value := os.environ.get(var, "").strip().lower():
            if value in lowercased_harnesses:
                return value
            return "unknown"

    return None


def is_agent() -> bool:
    """Return `True` if the process is being invoked by an AI coding agent."""
    return detect_agent() is not None


def _env_vars_match(env_vars: dict[str, str]) -> bool:
    """Return `True` if any `(var, pattern)` from the harness matches the environment.

    Supported patterns:
      - `"*"`: the variable is set to any non-empty value
      - `"<value>"`: the variable equals this exact value
    """
    for var, pattern in env_vars.items():
        value = os.environ.get(var)
        if not value:
            continue
        if pattern == "*":
            return True
        if value == pattern:
            return True
    return False


def _get_registry() -> Registry:
    """Return the harness registry, loading (and caching in-process) on first call.

    Best-effort: any unexpected error degrades to an empty registry so detection
    never raises.
    """
    global _registry
    if _registry is None:
        try:
            _registry = _load_registry()
        except Exception:
            logger.debug("Could not resolve agent harnesses registry.", exc_info=True)
            _registry = _EMPTY_REGISTRY
    return _registry


def _load_registry() -> Registry:
    """Resolve the registry from the local cache or the Hub.

    No hardcoded list: if the Hub is unreachable and no cached copy exists, an
    empty registry is returned (i.e. no agent is detected).
    """
    path = constants.AGENT_HARNESSES_PATH

    # 1. Use the cached file if it was refreshed within the last 24 hours.
    if cached := _read_cached_registry(path, max_age=_REGISTRY_TTL_SECONDS):
        return cached

    # 2. Otherwise refresh it from the Hub and persist it for next time.
    if (fetched := _fetch_registry()) is not None:
        _write_cached_registry(path, fetched)
        return fetched

    # 3. Fetch failed: reuse a stale cache if available, else give up (no detection).
    if stale := _read_cached_registry(path, max_age=None):
        return stale
    return _EMPTY_REGISTRY


def _read_cached_registry(path: str, max_age: int | None) -> Registry | None:
    """Return the cached registry, or `None` if missing/stale/unreadable."""
    try:
        if not os.path.exists(path):
            return None
        if max_age is not None and (time.time() - os.path.getmtime(path)) >= max_age:
            return None
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        logger.debug("Could not read cached agent harnesses registry.", exc_info=True)
        return None


def _write_cached_registry(path: str, registry: Registry) -> None:
    try:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(registry, f)
    except Exception:
        logger.debug("Could not cache agent harnesses registry.", exc_info=True)


def _fetch_registry() -> Registry | None:
    """Fetch the registry from the Hub. Returns `None` when offline or on any error."""
    if constants.HF_HUB_OFFLINE:
        return None
    try:
        from ._http import get_session

        response = get_session().get(
            f"{constants.ENDPOINT}/api/agent-harnesses",
            timeout=_REGISTRY_FETCH_TIMEOUT,
        )
        response.raise_for_status()
        return response.json()
    except Exception:
        logger.debug("Could not fetch agent harnesses registry from the Hub.", exc_info=True)
        return None
