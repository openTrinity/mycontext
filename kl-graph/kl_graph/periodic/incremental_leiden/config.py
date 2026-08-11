"""Tunables for incremental Leiden maintenance.

Values come from ``pipelines.ingestion.incremental.leiden`` in the app config, so
this package has no module-local environment variables of its own.
"""

from __future__ import annotations

from dataclasses import dataclass

from kl_graph.config import cfg


@dataclass(frozen=True)
class IncrementalLeidenConfig:
    """Immutable tunables for incremental Leiden maintenance.

    Attributes:
        gamma: Resolution parameter γ (higher → smaller communities).
        max_levels: Maximum number of hierarchy levels P.
        seed: PRNG seed for reproducible clustering/refinement.
        min_gain: Minimum modularity gain to accept a move (guards float noise).
    """

    gamma: float = 1.0
    max_levels: int = 16
    seed: int = 0xC0FFEE
    min_gain: float = 1e-12

    @classmethod
    def from_app_config(cls) -> IncrementalLeidenConfig:
        """Build from ``pipelines.ingestion.incremental.leiden``.

        Falls back to this class's defaults when the section is absent, so an
        older config file keeps working.
        """
        section = getattr(cfg.pipelines.ingestion.incremental, "leiden", None)
        if section is None:
            return cls()
        return cls(
            gamma=float(section.gamma),
            max_levels=int(section.max_levels),
            seed=int(section.seed),
            min_gain=float(section.min_gain),
        )


def default_config() -> IncrementalLeidenConfig:
    """Return the config resolved from the app config at call time.

    Resolved per call rather than cached at import so tests and callers that
    override config see the change.
    """
    return IncrementalLeidenConfig.from_app_config()
