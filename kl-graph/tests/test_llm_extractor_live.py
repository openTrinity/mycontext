"""Real-API integration tests for kl_graph/ingest/llm_extractor.py.

These hit a live LLM endpoint (litellm / Anthropic-compatible) and therefore:
  * are OPT-IN — they skip unless BOTH credentials are present AND the explicit
    gate ``KL_RUN_LLM_TESTS=1`` is set, so they never cost tokens by accident;
  * are slow (several seconds) and non-deterministic in exact output, so we
    assert on structural + attribution invariants, never on exact strings.

What they verify against a *real* model:
  1. ``extract_all_flat`` returns per-message results keyed to each ``msg.id``.
  2. The new msg_index alignment actually holds end-to-end: each message's
     extraction mentions ITS OWN distinctive entity and not a neighbour's
     (this is the real-world version of tests/test_batch_alignment.py).
  3. Trivial messages are skipped (no LLM call, empty result).
  4. Disk cache works: a second run is all cache hits, zero new LLM calls.

Setup (endpoints/keys live only in the gitignored .env):

    set -a; source .env; set +a
    export KL_RUN_LLM_TESTS=1
    .venv/bin/python tests/test_llm_extractor_live.py
    # or: KL_RUN_LLM_TESTS=1 pytest tests/test_llm_extractor_live.py -q -s
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

try:
    import pytest
except ModuleNotFoundError:  # allow the __main__ runner to work without pytest
    pytest = None

sys.path.insert(0, str(Path(__file__).parent.parent))

from kl_graph.ingest.llm_extractor import LLMExtractor, needs_extraction
from kl_graph.models.types import Chunk

# ─── Opt-in gate ──────────────────────────────────────────────────────────

_HAS_CREDS = bool(
    (os.environ.get("KL_LLM_FLASH_BASE_URL") or os.environ.get("KL_LLM_BASE_URL"))
    and os.environ.get("ANTHROPIC_AUTH_TOKEN")
)
_ENABLED = os.environ.get("KL_RUN_LLM_TESTS") == "1" and _HAS_CREDS
_SKIP_REASON = (
    "live LLM test disabled; set KL_RUN_LLM_TESTS=1 and source .env "
    "(KL_LLM_FLASH_BASE_URL + ANTHROPIC_AUTH_TOKEN) to enable"
)

pytestmark = (
    pytest.mark.skipif(not _ENABLED, reason=_SKIP_REASON) if pytest is not None else []
)

_failures = []


def check(cond, msg):
    if cond:
        print(f"  ok: {msg}")
    else:
        print(f"  FAIL: {msg}")
        _failures.append(msg)
        raise AssertionError(msg)


# ─── Fixtures: messages with distinctive, non-overlapping entities ─────────
#
# Each meaningful message mentions a unique person + system so we can prove
# the result was attributed to the RIGHT message (not a neighbour's).

_MSGS = [
    # (id, sender, content, own_markers, is_trivial)
    (
        "m_alpha",
        "张三",
        "张三负责 Alphapay 支付系统的上线部署，预计下周三完成。",
        ["Alphapay", "张三"],
        False,
    ),
    (
        "m_beta",
        "李四",
        "李四决定 Betabase 数据库改用分库分表方案来解决性能瓶颈。",
        ["Betabase", "李四"],
        False,
    ),
    ("m_ack", "王五", "好的", [], True),  # trivial → skipped (matches SKIP_PATTERNS)
    (
        "m_gamma",
        "赵六",
        "赵六修复了 Gammaflow 工作流引擎的登录鉴权 bug。",
        ["Gammaflow", "赵六"],
        False,
    ),
]

_ALL_MARKERS = [m for _, _, _, mk, _ in _MSGS for m in mk]


def _build_messages() -> list[Chunk]:
    """Chat chunks: ``source_type="message"``, chat fields in ``metadata``."""
    msgs = []
    for i, (mid, sender, content, _mk, _triv) in enumerate(_MSGS):
        msgs.append(
            Chunk(
                id=mid,
                content=content,
                source_type="message",
                timestamp=1_700_000_000_000 + i * 60_000,
                metadata={
                    "conversation_id": "conv_live_test",
                    "sender": sender,
                },
            )
        )
    return msgs


def _result_text(result: dict) -> str:
    """Flatten a cached extraction result into one searchable string."""
    parts = []
    for e in result.get("entities", []):
        parts.append(str(e.get("name", "")))
    for f in result.get("facts", []):
        parts.append(str(f.get("fact_text", "")))
        parts.append(str(f.get("subject_entity", "")))
        parts.append(str(f.get("object_entity", "")))
    return " ".join(parts)


def _make_extractor(cache_db: Path) -> LLMExtractor:
    # Defaults read KL_LLM_FLASH_* / ANTHROPIC_AUTH_TOKEN.
    return LLMExtractor(cache_db=cache_db, max_concurrent=4)


# ─── Tests ──────────────────────────────────────────────────────────────


def test_extract_all_flat_attribution_live():
    """Real extraction: each message gets its own entities, correctly attributed."""
    with tempfile.TemporaryDirectory() as tmp:
        ext = _make_extractor(Path(tmp))
        messages = _build_messages()

        asyncio.run(ext.extract_all_flat(messages))

        # Every message must have a cached result keyed to its id.
        results = {}
        for msg in messages:
            r = ext._read_cache(msg)
            check(r is not None, f"cached result exists for {msg.id}")
            check(r.get("_msg_id") == msg.id, f"result _msg_id matches for {msg.id}")
            results[msg.id] = r

        # Trivial message skipped, no entities/facts.
        ack = results["m_ack"]
        check(ack.get("_skipped") is True, "trivial message flagged _skipped")
        check(
            not ack.get("entities") and not ack.get("facts"),
            "trivial message has no entities/facts",
        )

        # Meaningful messages: own marker present, foreign markers absent.
        for mid, _s, _c, own_markers, is_trivial in _MSGS:
            if is_trivial:
                continue
            text = _result_text(results[mid])
            # At least one of this message's own markers should surface.
            check(
                any(mk in text for mk in own_markers),
                f"{mid} extraction mentions its own entity ({own_markers})",
            )
            # No OTHER message's distinctive system name should appear here —
            # that would mean the batch result was misattributed.
            foreign = [
                mk
                for (o_id, _os, _oc, o_mk, o_triv) in _MSGS
                if o_id != mid and not o_triv
                for mk in o_mk
                if mk not in own_markers and mk in text
            ]
            check(
                not foreign,
                f"{mid} extraction is NOT contaminated by foreign entities {foreign}",
            )

        check(ext.stats["llm_calls"] >= 1, "at least one real LLM call was made")
        check(ext.stats["skipped_trivial"] >= 1, "trivial message counted as skipped")
        print(f"  stats: {ext.stats}")


def test_cache_hit_on_second_run_live():
    """A second extraction over the same messages hits cache, no new LLM calls."""
    with tempfile.TemporaryDirectory() as tmp:
        messages = _build_messages()

        ext1 = _make_extractor(Path(tmp))
        asyncio.run(ext1.extract_all_flat(messages))
        first_calls = ext1.stats["llm_calls"]
        check(first_calls >= 1, "first run made real LLM calls")

        # Fresh extractor, SAME cache dir → everything should be a cache hit.
        ext2 = _make_extractor(Path(tmp))
        asyncio.run(ext2.extract_all_flat(messages))
        check(ext2.stats["llm_calls"] == 0, "second run made zero LLM calls")
        # Non-trivial messages are the ones that get cache-hit accounting.
        n_meaningful = sum(1 for _i, _s, _c, _mk, triv in _MSGS if not triv)
        check(
            ext2.stats["cache_hits"] == n_meaningful,
            f"second run cache_hits == {n_meaningful} meaningful messages",
        )


def test_extract_one_with_context_live():
    """The single-message path (extract_one) returns a well-formed result."""
    with tempfile.TemporaryDirectory() as tmp:
        ext = _make_extractor(Path(tmp))
        messages = _build_messages()
        target_idx = 0  # the Alphapay message

        result = asyncio.run(
            ext.extract_one(messages[target_idx], messages, target_idx)
        )

        check(
            "entities" in result and "facts" in result, "result has entities+facts keys"
        )
        check(
            result.get("_msg_id") == messages[target_idx].id,
            "extract_one stamps _msg_id",
        )
        text = _result_text(result)
        check(
            "Alphapay" in text or "张三" in text, "extract_one surfaces target entities"
        )
        print(
            f"  extract_one entities={len(result['entities'])} facts={len(result['facts'])}"
        )


def test_needs_extraction_matches_live_skips():
    """Sanity: the trivial fixture is what needs_extraction would skip (no API)."""
    messages = _build_messages()
    for i, (_mid, _s, _c, _mk, is_trivial) in enumerate(_MSGS):
        want = not is_trivial
        check(
            needs_extraction(messages[i]) == want,
            f"needs_extraction({messages[i].id}) == {want}",
        )


if __name__ == "__main__":
    if not _ENABLED:
        print(f"SKIPPED: {_SKIP_REASON}")
        sys.exit(0)

    tests = [
        test_needs_extraction_matches_live_skips,
        test_extract_all_flat_attribution_live,
        test_cache_hit_on_second_run_live,
        test_extract_one_with_context_live,
    ]
    for t in tests:
        print(f"\n=== {t.__name__} ===")
        try:
            t()
        except AssertionError:
            pass  # recorded in _failures; keep running
        except Exception as e:  # noqa: BLE001  # network/model errors shouldn't masquerade as pass
            print(f"  ERROR: {e!r}")
            _failures.append(f"{t.__name__}: {e!r}")

    print()
    if _failures:
        print(f"FAILED ({len(_failures)}):")
        for m in _failures:
            print(f"  - {m}")
        sys.exit(1)
    print("ALL PASSED")
