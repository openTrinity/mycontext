"""End-to-end (offline) ingestion test over a small real-shaped DWS fixture.

Exercises the whole chat chunk-unit path — loader render (R1/R2) → session
slicing (C1–C11) → Scope/PART_OF projection (divergence C) → chat edges
(TEMPORAL C4 / REPLY_TO C3) → AUTHORED_BY participants (C2) — on a *small* slice
of the real ``new_format_data`` export, sampled into
``test_data/mini_format_data`` by ``scripts/build_mini_dataset.py``.

No LLM / embedding endpoint is required: this validates the deterministic,
offline stages (everything up to the LLM extraction + Qdrant embed). The whole
test is skipped when the fixture is absent, so the suite still runs on a machine
without the sampled data.

Run: ``.venv/bin/python -m pytest tests/test_e2e_mini_ingest.py -q``
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import pytest

from kl_graph.ingest.loaders import load_mail, load_wiki
from kl_graph.ingest.loaders.message_loader import load_all_messages
from kl_graph.ingest.pipeline import (
    _is_chat,
    _participants_of,
    build_chat_edges,
    build_scopes_and_part_of,
)
from kl_graph.ingest.session_chunker import slice_chat_sessions
from kl_graph.models.types import EdgeType

# Fixture lives beside the repo, under cyber-life/test_data/mini_format_data.
_REPO_ROOT = Path(__file__).resolve().parent.parent
_FIXTURE = _REPO_ROOT.parent / "test_data" / "mini_format_data"

pytestmark = pytest.mark.skipif(
    not (_FIXTURE / "chat" / "records.jsonl").is_file(),
    reason=(
        "mini fixture absent — run scripts/build_mini_dataset.py "
        "(needs test_data/new_format_data)"
    ),
)


@pytest.fixture(scope="module")
def slices():
    """The chat session slices produced from the fixture (loader → slicer)."""
    return slice_chat_sessions(load_all_messages(_FIXTURE / "chat"))


def test_loader_renders_headers_and_marks_sessions() -> None:
    msgs = load_all_messages(_FIXTURE / "chat")
    assert msgs, "fixture chat should load some messages"
    # Every rendered message carries a direction header. On a post-gap message
    # the loader prepends a literal ``SESSION_BREAK`` marker line (which the
    # slicer later strips), so the header is the first line *after* any marker.
    for m in msgs:
        lines = m.content.lstrip().splitlines()
        first = lines[1] if lines and lines[0] == "SESSION_BREAK" else lines[0]
        assert first.startswith(("[群聊", "[私聊")), m.content[:40]
    # The fixture was chosen for its multi-hour gaps → at least one session break.
    assert any(m.metadata.get("session_start") for m in msgs), "expected a session break"


def test_slices_are_fewer_than_messages_and_traceable(slices) -> None:
    msgs = load_all_messages(_FIXTURE / "chat")
    assert 0 < len(slices) <= len(msgs), (len(slices), len(msgs))
    # Every original message id is reachable from some slice (C1 traceback), and
    # no member id is invented.
    member_ids = {mid for s in slices for mid in s.metadata["member_message_ids"]}
    assert member_ids == {m.id for m in msgs}


def test_every_slice_starts_with_a_header_red_invariant(slices) -> None:
    # [!RED]: even a sliced session keeps a self-describing header on each slice.
    for s in slices:
        assert s.content.lstrip().startswith(("[群聊", "[私聊")), s.content[:40]


def test_slice_ids_are_deterministic(slices) -> None:
    again = slice_chat_sessions(load_all_messages(_FIXTURE / "chat"))
    assert [s.id for s in slices] == [s.id for s in again]
    # ids are unique per slice
    assert len({s.id for s in slices}) == len(slices)


def test_session_marker_stripped_from_content(slices) -> None:
    for s in slices:
        assert "SESSION_BREAK" not in s.content


def test_authored_by_participants_are_distinct_senders(slices) -> None:
    # C2: a slice's participants == its distinct senders (mechanical AUTHORED_BY).
    for s in slices:
        parts = _participants_of(s)
        assert parts == s.metadata["senders"], (parts, s.metadata["senders"])
        assert len(parts) == len(set(parts)), "participants must be distinct"
        assert _is_chat(s)


def test_temporal_edges_stay_within_sessions(slices) -> None:
    edges = build_chat_edges(slices)
    temporal = [e for e in edges if e.edge_type is EdgeType.TEMPORAL]
    id_to_slice = {s.id: s for s in slices}
    for e in temporal:
        src, tgt = id_to_slice[e.source_id], id_to_slice[e.target_id]
        assert e.source_type == "chunk" and e.target_type == "chunk"
        # never bridges a session boundary
        assert src.metadata["session_index"] == tgt.metadata["session_index"]
        assert not tgt.metadata.get("session_start")


def test_reply_to_edges_are_cross_slice_or_dropped(slices) -> None:
    # C3: REPLY_TO only ever connects two *different* slices; same-slice quotes
    # (the common case in a real session) and un-ingested quotes are dropped.
    edges = build_chat_edges(slices)
    for e in edges:
        if e.edge_type is EdgeType.REPLY_TO:
            assert e.source_id != e.target_id
            assert e.source_type == "chunk" and e.target_type == "chunk"


def test_scopes_and_part_of_across_all_sources(slices) -> None:
    wiki = load_wiki(_FIXTURE / "wiki")
    mail = load_mail(_FIXTURE / "mail")
    all_chunks = [*slices, *wiki, *mail]
    scopes, part_of = build_scopes_and_part_of(all_chunks)

    # Exactly one PART_OF per chunk, each targeting a returned scope.
    assert len(part_of) == len(all_chunks)
    scope_ids = {s.id for s in scopes}
    for e in part_of:
        assert e.edge_type is EdgeType.PART_OF
        assert e.source_type == "chunk" and e.target_type == "scope"
        assert e.target_id in scope_ids

    # The three sources map onto their design scope vocabulary.
    kinds = Counter(s.scope_type for s in scopes)
    assert kinds["conversation"] >= 1
    if wiki:
        assert kinds["document"] >= 1
    if mail:
        assert kinds["mail_thread"] >= 1


def test_non_chat_chunks_are_not_chat(slices) -> None:
    wiki = load_wiki(_FIXTURE / "wiki")
    mail = load_mail(_FIXTURE / "mail")
    for c in [*wiki, *mail]:
        assert not _is_chat(c)
        # non-chat chunks contribute participants from their own metadata, never
        # a chat sender list.
        assert "senders" not in c.metadata
