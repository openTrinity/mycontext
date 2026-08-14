"""Tests for loader context rendering (``loader-context-rendering.md`` R0/R1/R2).

Covers the loader-phase invariants introduced by that spec:

  1. R0 — chat messages come back **grouped by conversation** (a concatenation of
     per-conversation runs sorted by time), not one global timeline.
  2. R0 — a literal ``SESSION_BREAK`` marker is emitted on a >= 3h idle gap, and
     NOT on a smaller gap and NOT across a missing (``0``) timestamp.
  3. R1 — chat ``content`` carries a direction header (direct / group), the
     inlined quoted message on replies (verbatim, whitespace included),
     self-quotes, and a complete sender → receiver relationship even for
     self-chats.
  4. R2 — mail ``content`` is prefixed with a ``发件人 → 收件人; 抄送`` header
     including the full cc list.

Pure in-memory fixtures (no real export needed). Run:
    python3 -m pytest tests/test_loader_context_rendering.py
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from kl_graph.ingest.loaders.base import (
    SESSION_BREAK_MARKER,
    SESSION_GAP_MS,
    scope_chat_kind,
)
from kl_graph.ingest.loaders.mail_loader import load_mail
from kl_graph.ingest.loaders.message_loader import _render_content, load_all_messages

HOUR_MS = 60 * 60 * 1000


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


def _msg(mid: str, conv: str, scope: str, sender: str, content: str, ts_ms: int | None, quoted: dict | None = None) -> dict:
    """Build one chat ``records.jsonl`` line with an explicit epoch-ms time.

    ``ts_ms=None`` models a record whose time is missing/unparseable, which
    :func:`to_unix_ms` normalizes to ``0``.
    """
    data = {
        "openMessageId": mid,
        "openConversationId": conv,
        "sender": sender,
        "content": content,
        "createTime": ts_ms,
    }
    if quoted is not None:
        data["quotedMessage"] = quoted
    return {"id": f"msg:{mid}", "scope_id": scope, "type": "message", "data": data}


# ─── R1: the pure render helper ──────────────────────────────────────────────

def test_render_direct_outgoing_message():
    """Current user sending to the scope counterparty renders user → title."""
    out = _render_content(
        "你看一下",
        "小周",
        "direct",
        "孙亮",
        None,
        current_user="小周",
    )
    assert out == "[私聊] 小周 → 孙亮\n你看一下"


def test_render_direct_incoming_message():
    """Counterparty sending to the current user must not render title → title."""
    out = _render_content(
        "你看一下",
        "孙亮",
        "direct",
        "孙亮",
        None,
        current_user="小周",
    )
    assert out == "[私聊] 孙亮 → 小周\n你看一下"


def test_render_group_no_reply():
    """Group chat renders [群聊: title] sender, with no receiver arrow."""
    out = _render_content("开始了", "赵辰", "group", "项目进度讨论", None)
    assert out == "[群聊: 项目进度讨论] 赵辰\n开始了"
    assert "→" not in out


def test_render_direct_with_reply():
    """A reply inlines the quoted sender + body verbatim between header and body."""
    quoted = {"openMessageId": "a", "sender": "孙亮", "content": "我们把早会取消吧"}
    out = _render_content("同意", "小周", "direct", "孙亮", quoted)
    assert out == "[私聊] 小周 → 孙亮\n↳ 回复 孙亮：我们把早会取消吧\n同意"


def test_render_quote_is_verbatim():
    """Quoted body is NOT truncated and media/@ noise is NOT stripped."""
    long_quote = "@李娜 [图片消息] " + ("很长的内容" * 80)
    quoted = {"openMessageId": "x", "sender": "李强", "content": long_quote}
    out = _render_content("收到", "赵辰", "group", "G", quoted)
    assert long_quote in out, "quoted body must be inlined verbatim (no truncation)"
    assert "@李娜" in out and "[图片消息]" in out, "no @/media stripping"


def test_render_quote_keeps_boundary_whitespace():
    """Verbatim means verbatim: the quote's own leading/trailing whitespace stays.

    Regression for the review's fix-now finding that ``.strip()`` on
    ``quotedMessage["content"]`` mutated a body required to be inlined exactly
    as stored.
    """
    q_body = "  前后有空白\n第二行  "
    quoted = {"openMessageId": "x", "sender": "李强", "content": q_body}
    out = _render_content("收到", "赵辰", "group", "G", quoted)
    assert f"↳ 回复 李强：{q_body}" in out, out
    # Spelled out literally so the two-space margins are visible in the diff.
    assert out == "[群聊: G] 赵辰\n↳ 回复 李强：  前后有空白\n第二行  \n收到", out


def test_render_self_quote():
    """A sender quoting their own earlier message needs no special case."""
    quoted = {"openMessageId": "a", "sender": "孙亮", "content": "先放一下"}
    out = _render_content("继续", "孙亮", "direct", "小周", quoted)
    assert "↳ 回复 孙亮：先放一下" in out
    assert out.startswith("[私聊] 孙亮 → 小周")


def test_render_self_chat_keeps_complete_relationship():
    """Self-chat still renders a full sender → receiver pair (human decision)."""
    out = _render_content(
        "备忘",
        "孙亮",
        "direct",
        "孙亮",
        None,
        current_user="孙亮",
    )
    assert out == "[私聊] 孙亮 → 孙亮\n备忘"
    assert "→" in out, "must NOT collapse to sender-only"


def test_render_direct_incoming_without_current_user_omits_arrow():
    """An unknown recipient is left unknown instead of rendering title → title."""
    out = _render_content("你看一下", "孙亮", "direct", "孙亮", None)
    assert out == "[私聊: 孙亮] 孙亮\n你看一下"
    assert "→" not in out


def test_render_media_only_quote_still_names_replied_to():
    """A quote with a sender but no content still records who is replied to."""
    out = _render_content("嗯", "A", "group", "G", {"openMessageId": "z", "sender": "B"})
    assert "↳ 回复 B：" in out
    # Same for an explicitly empty / whitespace-only quoted body.
    empty = _render_content("嗯", "A", "group", "G", {"openMessageId": "z", "sender": "B", "content": ""})
    assert empty == "[群聊: G] A\n↳ 回复 B：\n嗯", empty
    blank = _render_content("嗯", "A", "group", "G", {"openMessageId": "z", "sender": "B", "content": "  "})
    assert blank == "[群聊: G] A\n↳ 回复 B：  \n嗯", blank


def test_render_no_body_noise_when_quote_absent():
    """No reply line when there is no quotedMessage."""
    out = _render_content("hi", "A", "group", "G", None)
    assert "回复" not in out


# ─── R0: grouping + session breaks (through the loader) ──────────────────────

def test_grouping_by_conversation():
    """Interleaved input comes back as per-conversation runs, not a global sort."""
    base_ts = 1_700_000_000_000
    with tempfile.TemporaryDirectory() as td:
        d = _write_source(
            Path(td), "chat",
            records=[
                # Interleaved in time across two conversations.
                _msg("a1", "c1", "s1", "A", "c1 first", base_ts),
                _msg("b1", "c2", "s2", "B", "c2 first", base_ts + 1000),
                _msg("a2", "c1", "s1", "A", "c1 second", base_ts + 2000),
                _msg("b2", "c2", "s2", "B", "c2 second", base_ts + 3000),
            ],
            scopes=[
                {"id": "s1", "type": "chat", "data": {"title": "G1", "chat_kind": "group"}},
                {"id": "s2", "type": "chat", "data": {"title": "G2", "chat_kind": "group"}},
            ],
        )
        msgs = load_all_messages(d)
        assert len(msgs) == 4
        convs = [m.metadata["conversation_id"] for m in msgs]
        # Each conversation's messages must be contiguous (not interleaved).
        assert convs in (["c1", "c1", "c2", "c2"], ["c2", "c2", "c1", "c1"]), convs
        # Within a conversation, sorted by timestamp.
        for conv in ("c1", "c2"):
            ts = [
                m.timestamp for m in msgs if m.metadata["conversation_id"] == conv
            ]
            assert ts == sorted(ts), f"{conv} not time-sorted"


def test_session_break_on_long_gap():
    """A >= SESSION_GAP_MS idle gap prefixes the hard-break marker."""
    base_ts = 1_700_000_000_000
    with tempfile.TemporaryDirectory() as td:
        d = _write_source(
            Path(td), "chat",
            records=[
                _msg("m1", "c1", "s1", "A", "topic one", base_ts),
                _msg("m2", "c1", "s1", "A", "topic two", base_ts + SESSION_GAP_MS),
            ],
            scopes=[{"id": "s1", "type": "chat", "data": {"title": "G", "chat_kind": "group"}}],
        )
        msgs = load_all_messages(d)
        assert len(msgs) == 2
        assert not msgs[0].content.startswith(SESSION_BREAK_MARKER), "first message has no break"
        assert msgs[1].content.startswith(SESSION_BREAK_MARKER), "gap must emit the marker"
        assert msgs[1].metadata.get("session_start") is True
        # The marker sits on its own line, above the rendered header.
        assert msgs[1].content.split("\n")[1].startswith("[群聊"), msgs[1].content


def test_no_session_break_on_short_gap():
    """A gap below the threshold emits no marker."""
    base_ts = 1_700_000_000_000
    with tempfile.TemporaryDirectory() as td:
        d = _write_source(
            Path(td), "chat",
            records=[
                _msg("m1", "c1", "s1", "A", "one", base_ts),
                _msg("m2", "c1", "s1", "A", "two", base_ts + SESSION_GAP_MS - HOUR_MS),
            ],
            scopes=[{"id": "s1", "type": "chat", "data": {"title": "G", "chat_kind": "group"}}],
        )
        msgs = load_all_messages(d)
        assert len(msgs) == 2
        assert all(SESSION_BREAK_MARKER not in m.content for m in msgs)
        assert all("session_start" not in m.metadata for m in msgs)


def test_session_break_is_per_conversation():
    """A gap in one conversation must not mark another conversation's message."""
    base_ts = 1_700_000_000_000
    with tempfile.TemporaryDirectory() as td:
        d = _write_source(
            Path(td), "chat",
            records=[
                _msg("a1", "c1", "s1", "A", "c1 early", base_ts),
                _msg("a2", "c1", "s1", "A", "c1 late", base_ts + SESSION_GAP_MS),
                # c2's two messages are close together despite c1's big gap.
                _msg("b1", "c2", "s1", "B", "c2 one", base_ts + 500),
                _msg("b2", "c2", "s1", "B", "c2 two", base_ts + 1500),
            ],
            scopes=[{"id": "s1", "type": "chat", "data": {"title": "G", "chat_kind": "group"}}],
        )
        msgs = load_all_messages(d)
        marked = {m.id for m in msgs if SESSION_BREAK_MARKER in m.content}
        assert marked == {"a2"}, f"only the post-gap c1 message is marked, got {marked}"


def test_no_session_break_across_missing_timestamp():
    """A missing timestamp must not fake a >= 3h idle gap.

    Regression for the review's fix-now finding: ``to_unix_ms`` normalizes an
    absent time to ``0``, which sorts first, so ``valid_ts - 0`` used to exceed
    three hours and wrongly marked the following (valid) message as a new
    session. Ordering is unchanged — the 0-timestamp message still sorts first.
    """
    base_ts = 1_700_000_000_000
    with tempfile.TemporaryDirectory() as td:
        d = _write_source(
            Path(td), "chat",
            records=[
                _msg("m1", "c1", "s1", "A", "no time", None),
                _msg("m2", "c1", "s1", "A", "has time", base_ts),
            ],
            scopes=[{"id": "s1", "type": "chat", "data": {"title": "G", "chat_kind": "group"}}],
        )
        msgs = load_all_messages(d)
        assert [m.id for m in msgs] == ["m1", "m2"], "0-timestamp message still sorts first"
        assert msgs[0].timestamp == 0
        assert all(SESSION_BREAK_MARKER not in m.content for m in msgs), msgs[1].content
        assert all("session_start" not in m.metadata for m in msgs)


def test_no_session_break_when_later_timestamp_is_missing():
    """The reverse boundary: a 0-timestamp message is never itself a break.

    A 0 timestamp sorts first, so this only bites when a whole conversation is
    untimed; assert neither direction of the missing-timestamp boundary emits a
    marker (and that a real gap between the *valid* pair still does).
    """
    base_ts = 1_700_000_000_000
    with tempfile.TemporaryDirectory() as td:
        d = _write_source(
            Path(td), "chat",
            records=[
                _msg("m1", "c1", "s1", "A", "untimed one", None),
                _msg("m2", "c1", "s1", "A", "untimed two", None),
                _msg("m3", "c1", "s1", "A", "timed", base_ts),
                _msg("m4", "c1", "s1", "A", "much later", base_ts + SESSION_GAP_MS),
            ],
            scopes=[{"id": "s1", "type": "chat", "data": {"title": "G", "chat_kind": "group"}}],
        )
        msgs = load_all_messages(d)
        marked = {m.id for m in msgs if SESSION_BREAK_MARKER in m.content}
        assert marked == {"m4"}, f"only the real valid-to-valid gap breaks, got {marked}"


def test_loader_renders_direct_and_group_from_scope():
    """The loader reads chat_kind from the scope and renders accordingly."""
    base_ts = 1_700_000_000_000
    with tempfile.TemporaryDirectory() as td:
        d = _write_source(
            Path(td), "chat",
            records=[
                _msg("d1", "cd", "sd", "孙亮", "你看一下", base_ts),
                _msg("g1", "cg", "sg", "赵辰", "开始了", base_ts),
            ],
            scopes=[
                {"id": "sd", "type": "chat", "data": {"title": "孙亮", "chat_kind": "direct"}},
                {"id": "sg", "type": "chat", "data": {"title": "项目讨论", "chat_kind": "group"}},
            ],
        )
        by_id = {m.id: m for m in load_all_messages(d, current_user="小周")}
        assert by_id["d1"].content == "[私聊] 孙亮 → 小周 · 2023-11-15 06:13\n你看一下"
        assert by_id["g1"].content == "[群聊: 项目讨论] 赵辰 · 2023-11-15 06:13\n开始了"
        assert by_id["d1"].metadata.get("chat_kind") == "direct"
        assert by_id["d1"].metadata["extraction_target_content"].startswith(
            "[私聊] 孙亮 → 小周"
        )


def test_loader_renders_reply_and_keeps_reply_to():
    """Rendering a reply does not disturb reply_to (drives REPLY_TO edges)."""
    base_ts = 1_700_000_000_000
    quoted = {"openMessageId": "a", "sender": "孙亮", "content": "我们把早会取消吧"}
    with tempfile.TemporaryDirectory() as td:
        d = _write_source(
            Path(td), "chat",
            records=[_msg("b", "c1", "s1", "小周", "同意", base_ts, quoted=quoted)],
            scopes=[{"id": "s1", "type": "chat", "data": {"title": "孙亮", "chat_kind": "direct"}}],
        )
        (m,) = load_all_messages(d)
        assert m.metadata["reply_to"] == "a", "reply_to still set for REPLY_TO edges"
        assert "↳ 回复 孙亮：我们把早会取消吧" in m.content


def test_scope_chat_kind_falls_back_to_group_type():
    """chat_kind is inferred from groupType when absent."""
    assert scope_chat_kind({"data": {"chat_kind": "direct"}}) == "direct"
    assert scope_chat_kind({"data": {"groupType": "SINGLE_CHAT"}}) == "direct"
    assert scope_chat_kind({"data": {"groupType": "INTERNAL_GROUP"}}) == "group"
    assert scope_chat_kind({"data": {}}) == ""
    assert scope_chat_kind(None) == ""


# ─── R2: mail direction header ───────────────────────────────────────────────

def test_mail_direction_header_with_cc():
    """Mail content is prefixed with 发件人 → 收件人; 抄送 (full cc list)."""
    with tempfile.TemporaryDirectory() as td:
        d = _write_source(
            Path(td), "mail",
            records=[{
                "id": "mail:1", "scope_id": "thread:1", "type": "email",
                "data": {
                    "messageId": "m1",
                    "body": {
                        "subject": "周报",
                        "markdownBody": "本周进展如下。",
                        "from": {"name": "孙亮", "email": "sl@example.com"},
                        "toRecipients": [{"name": "周强", "email": "zq@example.com"}],
                        "ccRecipients": [
                            {"name": "李强", "email": "lm@example.com"},
                            {"name": "李娜", "email": "wf@example.com"},
                        ],
                        "conversationId": "thread:1",
                        "receivedDateTime": "2026-05-11T15:07:03Z",
                    },
                },
            }],
        )
        (c,) = load_mail(d)
        first = c.content.split("\n")[0]
        assert first.startswith("[邮件] 发件人 孙亮 <sl@example.com>"), first
        assert "→ 收件人 周强 <zq@example.com>" in first
        # Full cc list included (human decision: no cap).
        assert "李强 <lm@example.com>" in first and "李娜 <wf@example.com>" in first
        # Subject + body still present beneath the header.
        assert "主题：周报" in c.content
        assert c.content.rstrip().endswith("本周进展如下。")
        # Metadata unchanged.
        assert c.metadata["cc"] == ["李强 <lm@example.com>", "李娜 <wf@example.com>"]
        assert c.metadata["conversation_id"] == "thread:1"


def test_mail_long_body_splits_without_truncation():
    """A body over the char budget splits into budgeted parts, never truncated.

    Regression: the embed path used to slice non-chat chunks at ``content[:2000]``
    and drop the tail. Long mails must instead become multiple ``mail:{id}:{i}``
    chunks, each carrying the direction header, together covering the whole body.
    """
    from kl_graph.ingest.loaders.mail_loader import _MAIL_CHAR_BUDGET

    # A body several times the budget, with unique markers at start and end so we
    # can prove nothing is lost.
    para = "这是一段用于测试的邮件正文内容，包含足够多的字符以超过分块预算。" * 200
    body = f"起始标记_HEAD\n{para}\n结束标记_TAIL"
    with tempfile.TemporaryDirectory() as td:
        d = _write_source(
            Path(td), "mail",
            records=[{
                "id": "mail:long", "scope_id": "t", "type": "email",
                "data": {"messageId": "mlong", "body": {
                    "subject": "长邮件",
                    "markdownBody": body,
                    "from": {"name": "发件人甲", "email": "a@example.com"},
                    "toRecipients": [{"name": "收件人乙", "email": "b@example.com"}],
                }},
            }],
        )
        chunks = load_mail(d)
        assert len(chunks) > 1, "a long body must split into multiple chunks"
        # Sequential, self-describing ids and segment metadata.
        assert [c.id for c in chunks] == [f"mail:mlong:{i}" for i in range(len(chunks))]
        assert all(c.metadata["n_segments"] == len(chunks) for c in chunks)
        # Every part re-emits the direction header.
        for c in chunks:
            assert c.content.split("\n")[0].startswith("[邮件] 发件人 发件人甲")
        # No part is pathologically oversized (budget + header slack).
        assert all(len(c.content) <= _MAIL_CHAR_BUDGET + 300 for c in chunks)
        # Nothing discarded: both the head and tail markers survive somewhere.
        joined = "\n".join(c.content for c in chunks)
        assert "起始标记_HEAD" in joined
        assert "结束标记_TAIL" in joined


def test_generic_loader_long_record_splits_without_truncation():
    """A generic record over budget splits into title-prefixed parts, not sliced.

    Same regression class as mail: work/contacts/attendance records used to be
    one unbounded chunk that the embed path truncated at 2000 chars.
    """
    from kl_graph.ingest.loaders.generic_loader import (
        _GENERIC_CHAR_BUDGET,
        load_generic,
    )

    big = "任务描述_HEAD " + ("工作内容明细，" * 400) + " 任务描述_TAIL"
    with tempfile.TemporaryDirectory() as td:
        d = _write_source(
            Path(td), "work",
            records=[{
                "id": "work:1", "scope_id": "w:1", "type": "work_item",
                "data": {"kind": "task", "description": big},
            }],
            scopes=[{"id": "w:1", "type": "work", "data": {"title": "季度目标"}}],
        )
        chunks = load_generic(d, "work")
        assert len(chunks) > 1, "a long record must split"
        assert [c.id for c in chunks] == [f"work:1:{i}" for i in range(len(chunks))]
        # Title re-emitted on every part.
        assert all(c.content.startswith("季度目标\n") for c in chunks)
        assert all(len(c.content) <= _GENERIC_CHAR_BUDGET + 300 for c in chunks)
        joined = "\n".join(c.content for c in chunks)
        assert "任务描述_HEAD" in joined and "任务描述_TAIL" in joined


def test_mail_header_omits_absent_parts():
    """A mail with no recipients still renders its sender; no dangling arrow."""
    with tempfile.TemporaryDirectory() as td:
        d = _write_source(
            Path(td), "mail",
            records=[{
                "id": "mail:2", "scope_id": "t", "type": "email",
                "data": {"messageId": "m2", "body": {
                    "subject": "S", "markdownBody": "B",
                    "from": {"name": "A", "email": "a@example.com"},
                }},
            }],
        )
        (c,) = load_mail(d)
        first = c.content.split("\n")[0]
        assert first == "[邮件] 发件人 A <a@example.com>", first
        assert "→" not in first


def test_mail_without_any_address_still_loads():
    """No from/to/cc at all → no header line, body preserved (no crash)."""
    with tempfile.TemporaryDirectory() as td:
        d = _write_source(
            Path(td), "mail",
            records=[{
                "id": "mail:3", "scope_id": "t", "type": "email",
                "data": {"messageId": "m3", "body": {"subject": "S", "markdownBody": "B"}},
            }],
        )
        (c,) = load_mail(d)
        assert "[邮件]" not in c.content
        assert c.content == "主题：S\n\nB"
