"""Tests for per-source loaders + the unified SQLite chunk store.

Covers the invariants that matter after the DWS-unified-format migration:
  1. Chunk.content is always valid non-empty text (every loader).
  2. The DWS quartet readers (read_jsonl / iter_records / load_scopes) parse the
     ``manifest/scopes/records/resources`` shape and dispatch by record type.
  3. The SQLite ``chunks`` table round-trips a generic Chunk with a queryable
     ``source_type`` column.

Pure-logic tests run anywhere. Tests that need the real export are skipped when
it is absent. Run: python3 tests/test_loaders.py
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from kl_graph.ingest.loaders import base
from kl_graph.ingest.loaders.generic_loader import load_generic
from kl_graph.ingest.loaders.mail_loader import load_mail
from kl_graph.ingest.loaders.message_loader import load_all_messages
from kl_graph.ingest.loaders.minutes_loader import (
    _todos_text,
    _transcript_lines,
    load_minutes,
)
from kl_graph.ingest.loaders.wiki_loader import _split_markdown, load_wiki
from kl_graph.models.types import Chunk
from kl_graph.storage.sqlite_store import SQLiteStore

# Canonical new-format DWS export used for the export-backed tests.
EXPORT = Path.home() / "Desktop/projects/rag_research/dws_data_format"

_failures = []


def check(cond, msg):
    if cond:
        print(f"  ok: {msg}")
    else:
        print(f"  FAIL: {msg}")
        _failures.append(msg)


def _assert_valid_chunks(chunks, source_type):
    """Every emitted chunk has non-empty str content + right type + id."""
    check(all(isinstance(c, Chunk) for c in chunks), f"{source_type}: all Chunk")
    check(
        all(isinstance(c.content, str) and c.content.strip() for c in chunks),
        f"{source_type}: content is non-empty str",
    )
    check(
        all(c.source_type == source_type for c in chunks),
        f"{source_type}: source_type set correctly",
    )
    check(all(c.id for c in chunks), f"{source_type}: ids present")


def _write_source(root: Path, name: str, records: list[dict], scopes: list[dict] | None = None) -> Path:
    """Write a minimal DWS source dir (records + scopes + manifest)."""
    d = root / name
    d.mkdir(parents=True)
    (d / "records.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in records), encoding="utf-8"
    )
    (d / "scopes.jsonl").write_text(
        "\n".join(json.dumps(s, ensure_ascii=False) for s in (scopes or [])), encoding="utf-8"
    )
    (d / "manifest.json").write_text("{}", encoding="utf-8")
    (d / "resources.jsonl").write_text("", encoding="utf-8")
    return d


# ─── Pure-logic tests (no export needed) ────────────────────────────────

def test_unwrap():
    print("test_unwrap")
    check(base.unwrap({"result": {"x": 1}, "success": True}) == {"x": 1}, "calendar envelope")
    check(base.unwrap({"message": {"x": 1}, "success": True}) == {"x": 1}, "mail envelope")
    check(base.unwrap({"ok": True, "data": {"x": 1}, "raw_envelope": {}}) == {"x": 1}, "minutes envelope")
    check(base.unwrap({"x": 1}) == {"x": 1}, "bare payload unchanged")


def test_to_unix_ms():
    print("test_to_unix_ms")
    check(base.to_unix_ms(1717578984000) == 1717578984000, "epoch ms passthrough")
    check(base.to_unix_ms(1717578984) == 1717578984000, "epoch seconds -> ms")
    check(base.to_unix_ms("2026-07-20T02:02:48Z") > 0, "ISO-8601 Z parses")
    check(base.to_unix_ms("2026-03-16T11:15:00+08:00") > 0, "ISO-8601 offset parses")
    check(base.to_unix_ms("2026-03-11 11:09:05") > 0, "space datetime parses")
    check(base.to_unix_ms("") == 0, "empty -> 0")
    check(base.to_unix_ms(None) == 0, "None -> 0")
    check(base.to_unix_ms("garbage") == 0, "garbage -> 0 (never raises)")


def test_quartet_readers():
    """read_jsonl / iter_records / load_scopes parse the DWS quartet shape."""
    print("test_quartet_readers")
    with tempfile.TemporaryDirectory() as td:
        d = _write_source(
            Path(td), "chat",
            records=[
                {"id": "msg:1", "scope_id": "chat:g", "type": "message",
                 "data": {"content": "hi", "sender": "S", "openMessageId": "1"}},
                {"id": "x:2", "scope_id": "chat:g", "type": "other",
                 "data": {"content": "skip"}},
            ],
            scopes=[{"id": "chat:g", "type": "chat", "parent_id": None,
                     "data": {"title": "Group G"}}],
        )
        recs = list(base.iter_records(d))
        check(len(recs) == 2, "iter_records yields all records")
        msgs = list(base.iter_records(d, "message"))
        check(len(msgs) == 1, "iter_records filters by type")
        scopes = base.load_scopes(d)
        check(base.scope_title(scopes.get("chat:g")) == "Group G", "scope_title from data.title")


def test_flatten_text():
    print("test_flatten_text")
    txt = base.flatten_text({"subject": "S", "nested": {"value": "a long value here"}, "n": 3})
    check("S" in txt and "a long value here" in txt, "flatten collects text-ish + long strings")
    check(base.find_timestamp({"a": {"createTime": "2026-03-11 11:09:05"}}) > 0, "find_timestamp walks nested")


def test_message_loader_new_format():
    """Chat loader reads records.jsonl, links scope titles, drops empty content.

    Also covers the rendering/grouping contract from
    ``loader-context-rendering.md`` (R0/R1): ``content`` carries a direction
    header, replies inline the quoted message, messages come back grouped per
    conversation, and a long idle gap emits the session-break marker. Detailed
    cases live in ``tests/test_loader_context_rendering.py``.
    """
    print("test_message_loader_new_format")
    with tempfile.TemporaryDirectory() as td:
        d = _write_source(
            Path(td), "chat",
            records=[
                {"id": "msg:a", "scope_id": "chat:g", "type": "message",
                 "data": {"openMessageId": "a", "openConversationId": "c1", "sender": "S",
                          "content": "hello", "createTime": "2026-05-11 15:07:03"}},
                {"id": "msg:b", "scope_id": "chat:g", "type": "message",
                 "data": {"openMessageId": "b", "openConversationId": "c1", "sender": "S",
                          "content": "world", "createTime": "2026-05-11 15:08:03",
                          "quotedMessage": {"openMessageId": "a", "sender": "S",
                                            "content": "hello"}}},
                {"id": "msg:c", "scope_id": "chat:g", "type": "message",
                 "data": {"openMessageId": "c", "content": "   "}},  # dropped (empty)
            ],
            scopes=[{"id": "chat:g", "type": "chat",
                     "data": {"title": "Group G", "chat_kind": "group"}}],
        )
        msgs = load_all_messages(d)
        check(len(msgs) == 2, f"2 non-empty messages (got {len(msgs)}); empty dropped")
        check(all(m.timestamp > 0 for m in msgs), "timestamps parsed")
        check(msgs[0].metadata.get("conversation_title") == "Group G", "scope title linked")
        check(
            any(m.metadata.get("reply_to") == "a" for m in msgs),
            "quotedMessage -> reply_to",
        )
        # R1: rendered direction header + inlined quote.
        by_id = {m.id: m for m in msgs}
        check(
            by_id["a"].content == f"[群聊: Group G] S · {base.format_ts(by_id['a'].timestamp)}\nhello",
            "group header rendered into content",
        )
        check(
            "↳ 回复 S：hello" in by_id["b"].content,
            "quoted message inlined into content",
        )
        # R0: same conversation stays contiguous, time-ordered, no false break.
        check(
            [m.metadata["conversation_id"] for m in msgs] == ["c1", "c1"],
            "grouped per conversation",
        )
        check(
            [m.timestamp for m in msgs] == sorted(m.timestamp for m in msgs),
            "time-sorted within conversation",
        )
        check(
            all("session_start" not in m.metadata for m in msgs),
            "1-minute gap emits no session break",
        )
        _assert_valid_chunks(msgs, "message")


def test_message_loader_session_break_and_grouping():
    """R0: >=3h idle gap marks a session break; conversations stay contiguous."""
    print("test_message_loader_session_break_and_grouping")
    ts = 1_700_000_000_000
    with tempfile.TemporaryDirectory() as td:
        d = _write_source(
            Path(td), "chat",
            records=[
                {"id": "m:1", "scope_id": "chat:g", "type": "message",
                 "data": {"openMessageId": "1", "openConversationId": "c1", "sender": "A",
                          "content": "topic one", "createTime": ts}},
                {"id": "m:2", "scope_id": "chat:g", "type": "message",
                 "data": {"openMessageId": "2", "openConversationId": "c1", "sender": "A",
                          "content": "topic two", "createTime": ts + base.SESSION_GAP_MS}},
                {"id": "m:3", "scope_id": "chat:g", "type": "message",
                 "data": {"openMessageId": "3", "openConversationId": "c2", "sender": "B",
                          "content": "other conv", "createTime": ts + 1000}},
            ],
            scopes=[{"id": "chat:g", "type": "chat",
                     "data": {"title": "Group G", "chat_kind": "group"}}],
        )
        msgs = load_all_messages(d)
        by_id = {m.id: m for m in msgs}
        check(
            by_id["2"].content.startswith(base.SESSION_BREAK_MARKER),
            "session-break marker emitted after a >=3h gap",
        )
        check(by_id["2"].metadata.get("session_start") is True, "session_start flag set")
        check(
            base.SESSION_BREAK_MARKER not in by_id["3"].content,
            "other conversation unaffected by the gap",
        )
        convs = [m.metadata["conversation_id"] for m in msgs]
        check(
            convs in (["c1", "c1", "c2"], ["c2", "c1", "c1"]),
            f"conversations contiguous (got {convs})",
        )


def test_mail_loader_direction_header():
    """R2: mail content is prefixed with a 发件人 → 收件人; 抄送 header."""
    print("test_mail_loader_direction_header")
    with tempfile.TemporaryDirectory() as td:
        d = _write_source(
            Path(td), "mail",
            records=[{
                "id": "mail:1", "scope_id": "t1", "type": "email",
                "data": {"messageId": "m1", "body": {
                    "subject": "周报", "markdownBody": "进展如下",
                    "from": {"name": "A", "email": "a@example.com"},
                    "toRecipients": [{"name": "B", "email": "b@example.com"}],
                    "ccRecipients": [{"name": "C", "email": "c@example.com"}],
                }},
            }],
        )
        (c,) = load_mail(d)
        head = c.content.split("\n")[0]
        check(head.startswith("[邮件] 发件人 A <a@example.com>"), f"mail sender header (got {head!r})")
        check("→ 收件人 B <b@example.com>" in head, "mail recipient rendered")
        check("抄送 C <c@example.com>" in head, "mail cc rendered")
        check("主题：周报" in c.content, "subject retained under header")
        _assert_valid_chunks([c], "mail")


def test_minutes_loader_new_format():
    """Minutes loader groups by meeting: summary (+keywords/todos) + transcript.

    Also asserts the transcript is rebuilt from structured ``segments`` (with
    speaker prefixes) rather than the broken flattened ``text`` field.
    """
    print("test_minutes_loader_new_format")
    mid = "meeting:m1"
    with tempfile.TemporaryDirectory() as td:
        d = _write_source(
            Path(td), "minutes",
            records=[
                {"id": "du:sum", "scope_id": mid, "type": "document_unit",
                 "data": {"unit_kind": "minutes_summary", "format": "markdown",
                          "text": "## 背景\n决定取消早会。"}},
                {"id": "du:t0", "scope_id": mid, "type": "document_unit",
                 "data": {"unit_kind": "minutes_transcription_page", "page_index": 1,
                          "text": "[17480] \n[28130] ",  # broken flattened text
                          "segments": [
                              {"nickName": "陈丹", "paragraph": "我们取消早会。"},
                              {"nickName": "李强", "paragraph": "好的。"},
                          ]}},
                {"id": "gr:kw", "scope_id": mid, "type": "generic_record",
                 "data": {"kind": "minutes_keywords", "keywords": ["早会", "取消"]}},
                {"id": "gr:td", "scope_id": mid, "type": "generic_record",
                 "data": {"kind": "minutes_todos", "raw": {
                     "dingtalkTodoList": [{"title": "跟进ASR问题"}]}}},
            ],
            scopes=[{"id": mid, "type": "meeting",
                     "data": {"title": "早会", "start_time": "2026-06-24T09:58:48+08:00",
                              "share_url": "https://s/x"}}],
        )
        chunks = load_minutes(d)
        summary = [c for c in chunks if c.metadata.get("part") == "summary"]
        transcript = [c for c in chunks if c.metadata.get("part") == "transcript"]
        check(len(summary) == 1, f"one summary chunk (got {len(summary)})")
        check(len(transcript) == 1, f"one transcript chunk (got {len(transcript)})")
        s = summary[0]
        check("取消早会" in s.content, "summary body present")
        check("早会" in s.content and "取消" in s.content, "keywords folded into summary")
        check("跟进ASR问题" in s.content, "action items folded into summary")
        check(s.timestamp > 0, "meeting start_time parsed")
        check(s.source_ref == "https://s/x", "share_url kept as source_ref")
        t = transcript[0]
        check("陈丹: 我们取消早会。" in t.content, "transcript rebuilt from segments w/ speaker")
        check("[17480]" not in t.content, "broken flattened text not used")
        _assert_valid_chunks(chunks, "minutes")


def test_minutes_helpers():
    print("test_minutes_helpers")
    lines = _transcript_lines([
        {"nickName": "A", "paragraph": "hi"},
        {"nickName": "", "paragraph": "anon"},
        {"nickName": "B", "paragraph": "   "},  # dropped: empty text
    ])
    check(lines == ["A: hi", "anon"], f"transcript lines rendered (got {lines})")
    # todos: dingtalkTodoList preferred, else parse JSON-string actions.
    t1 = _todos_text({"raw": {"dingtalkTodoList": [{"title": "x"}, {"title": "x"}]}})
    check(t1 == ["x"], f"todo titles deduped (got {t1})")
    t2 = _todos_text({"raw": {"actions": ['{"value": "do y"}', "plain z"]}})
    check(t2 == ["do y", "plain z"], f"actions parsed (got {t2})")


def test_wiki_split():
    print("test_wiki_split")
    long = "\n\n".join(f"para {i} " + "x" * 400 for i in range(10))
    parts = _split_markdown(long, budget=500)
    check(len(parts) > 1, "long text splits into multiple chunks")
    check(all(p.strip() for p in parts), "no empty split parts")
    parts2 = _split_markdown("x" * 50000, budget=1000)
    check(all(len(p) <= 1000 for p in parts2), "hard-cut bounds chunks with no breaks")


def test_wiki_records_in_one_node_have_distinct_chunk_and_unit_ids(tmp_path):
    wiki_dir = _write_source(
        tmp_path,
        "wiki",
        records=[
            {
                "id": "doc_unit:wiki/node-1/row-a",
                "scope_id": "document:wiki/node-1",
                "type": "document_unit",
                "data": {"text": "first row"},
            },
            {
                "id": "doc_unit:wiki/node-1/row-b",
                "scope_id": "document:wiki/node-1",
                "type": "document_unit",
                "data": {"text": "second row"},
            },
        ],
        scopes=[
            {
                "id": "document:wiki/node-1",
                "type": "document",
                "data": {"node": {"nodeId": "node-1", "name": "Table"}},
            }
        ],
    )

    chunks = load_wiki(wiki_dir)

    assert len(chunks) == 2
    assert len({chunk.id for chunk in chunks}) == 2
    assert {chunk.metadata["unit_id"] for chunk in chunks} == {
        "doc_unit:wiki/node-1/row-a",
        "doc_unit:wiki/node-1/row-b",
    }
    assert {chunk.metadata["node_id"] for chunk in chunks} == {"node-1"}


def test_sqlite_chunk_roundtrip():
    """Generic chunks table round-trips + type filter."""
    print("test_sqlite_chunk_roundtrip")
    with tempfile.TemporaryDirectory() as d:
        store = SQLiteStore(Path(d) / "k.db")
        chunks = [
            Chunk(id="a:1", content="hello", source_type="mail", timestamp=5,
                  source_ref="x@y", metadata={"subject": "hi"}),
            Chunk(id="b:1", content="world", source_type="wiki", timestamp=9,
                  metadata={"node_id": "N1"}),
        ]
        store.insert_chunks(chunks)
        check(store.count_chunks() == 2, "count_chunks == 2")
        by_src = store.count_chunks_by_source()
        check(by_src.get("mail") == 1 and by_src.get("wiki") == 1,
              "count_chunks_by_source groups by source_type")
        got = store.get_chunk("a:1")
        check(got is not None and got.content == "hello", "get_chunk content")
        check(got.metadata.get("subject") == "hi", "metadata round-trips (JSON)")
        n_mail = store.conn.execute(
            "SELECT COUNT(*) FROM chunks WHERE source_type = 'mail'"
        ).fetchone()[0]
        check(n_mail == 1, "source_type column is queryable")
        store.close()


# ─── Export-backed tests (skipped if the export is absent) ───────────────

def test_loaders_on_real_export():
    print("test_loaders_on_real_export")
    if not EXPORT.is_dir():
        print(f"  skip: export not found at {EXPORT}")
        return

    msgs = load_all_messages(EXPORT / "chat")
    if msgs:
        _assert_valid_chunks(msgs, "message")

    wiki = load_wiki(EXPORT / "wiki")
    if wiki:
        _assert_valid_chunks(wiki, "wiki")

    mail = load_mail(EXPORT / "mail")
    if mail:
        _assert_valid_chunks(mail, "mail")

    minutes = load_minutes(EXPORT / "minutes")
    if minutes:
        _assert_valid_chunks(minutes, "minutes")

    for name in ("work", "contacts", "attendance"):
        g = load_generic(EXPORT / name, name)
        if g:
            _assert_valid_chunks(g, name)


if __name__ == "__main__":
    test_unwrap()
    test_to_unix_ms()
    test_quartet_readers()
    test_flatten_text()
    test_message_loader_new_format()
    test_message_loader_session_break_and_grouping()
    test_mail_loader_direction_header()
    test_minutes_loader_new_format()
    test_minutes_helpers()
    test_wiki_split()
    test_sqlite_chunk_roundtrip()
    test_loaders_on_real_export()
    print()
    if _failures:
        print(f"FAILED ({len(_failures)}):")
        for m in _failures:
            print(f"  - {m}")
        sys.exit(1)
    print("ALL PASSED")
