"""Load wiki + doc content from the unified DWS export.

Wiki lives in ``<export>/wiki/`` as the standard quartet. Each ``records.jsonl``
line with ``type == "document_unit"`` carries the document body under
``data.text`` (markdown) plus ``data.docUrl``; the document title/node metadata
lives in the linked ``document`` scope in ``scopes.jsonl``.

Long markdown is split with a heading-aware, token-budgeted splitter so a chunk
is a coherent section rather than a whole document.
"""

from __future__ import annotations

import uuid
from pathlib import Path

from kl_graph.ingest.chunker import chunk_text
from kl_graph.ingest.loaders.base import iter_records, load_scopes, scope_title
from kl_graph.models.types import Chunk

# Rough char budget per chunk (~1 char ≈ 1 token for Chinese; avoids a
# tokenizer dep). Sections longer than this are windowed.
_DOC_CHAR_BUDGET = 1200


def _split_markdown(text: str, budget: int = _DOC_CHAR_BUDGET) -> list[str]:
    """Heading-aware split via the shared chunker (kept as a thin alias)."""
    return chunk_text(text, budget=budget, heading_aware=True)


def _node_id_from_scope(scope: dict | None, scope_id: str) -> str:
    """Extract the wiki node id from the document scope (fallback: scope id)."""
    if isinstance(scope, dict):
        node = (scope.get("data", {}) or {}).get("node", {})
        if isinstance(node, dict) and node.get("nodeId"):
            return node["nodeId"]
    # scope_id looks like ``document:wiki/<nodeId>`` — take the trailing segment.
    return scope_id.rsplit("/", 1)[-1] if scope_id else ""


def load_wiki(wiki_dir: Path) -> list[Chunk]:
    """Load all wiki documents from a DWS ``wiki`` source directory."""
    if not wiki_dir.is_dir():
        return []
    scopes = load_scopes(wiki_dir)
    chunks: list[Chunk] = []
    for rec in iter_records(wiki_dir, "document_unit"):
        data = rec.get("data", {})
        if not isinstance(data, dict):
            continue
        body = (data.get("text") or "").strip()
        if not body:
            continue
        scope = scopes.get(rec.get("scope_id"))
        node_id = _node_id_from_scope(scope, rec.get("scope_id", ""))
        # A wiki node is a container, not necessarily one source unit. In
        # particular, an aitable exports its schema and every row as separate
        # ``document_unit`` records under the same node. Key lineage by the
        # record identity and include it in chunk identity so every record can
        # start its own segment numbering without colliding at ``:0``.
        unit_id = str(rec.get("id") or f"wiki-node:{node_id}")
        unit_key = uuid.uuid5(uuid.NAMESPACE_URL, unit_id).hex
        title = scope_title(scope)
        url = data.get("docUrl")
        parts = _split_markdown(body)
        for i, part in enumerate(parts):
            chunks.append(Chunk(
                id=f"wiki:{node_id}:{unit_key}:{i}",
                content=part,
                source_type="wiki",
                timestamp=0,
                source_ref=url,
                metadata={
                    "unit_id": unit_id,
                    "record_id": unit_id,
                    "node_id": node_id,
                    "title": title,
                    "seg_idx": i,
                    "n_segments": len(parts),
                },
            ))
    return chunks
