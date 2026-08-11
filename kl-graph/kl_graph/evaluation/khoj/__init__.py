"""HTTP-only evaluation support for a production Khoj server."""

from .client import KhojEvaluationClient, KhojEvaluationError

__all__ = ["KhojEvaluationClient", "KhojEvaluationError"]
