"""Codex-driven LoCoMo evaluation harness.

The package deliberately delegates the retrieval loop to Codex.  It only
selects benchmark cases, starts isolated Codex threads, persists their event
streams, and joins Gold data after every agent has stopped.
"""

from .models import AgentCase, AgentResult, Citation

__all__ = ["AgentCase", "AgentResult", "Citation"]
