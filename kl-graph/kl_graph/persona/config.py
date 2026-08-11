"""Configuration boundary for the persona subsystem."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from kl_graph.config import DATA_DIR, cfg


@dataclass(frozen=True)
class PersonaSettings:
    """Resolved settings needed by deterministic persona extraction."""

    enabled: bool
    owner_name: str
    owner_sender_id: str
    min_messages: int
    db_path: Path

    @classmethod
    def from_config(cls) -> "PersonaSettings":
        section = cfg.pipelines.persona
        return cls(
            enabled=bool(section.enabled),
            owner_name=str(section.owner_name).strip(),
            owner_sender_id=str(section.owner_sender_id).strip(),
            min_messages=int(section.min_messages),
            db_path=DATA_DIR / "persona.db",
        )

    def validate_owner(self) -> None:
        if not self.owner_name and not self.owner_sender_id:
            raise ValueError(
                "persona owner is not configured; set KL_PERSONA_OWNER_SENDER_ID "
                "or KL_PERSONA_OWNER_NAME"
            )
