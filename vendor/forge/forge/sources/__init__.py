#!/usr/bin/env python3
"""Message sources — the seam between the forge and any one IM platform.

The forge's measurement engine works on normalized messages and knows nothing
about which product they came from. Everything platform-specific — how to
authenticate, how to page through history, what an id looks like, which rich
cards that client renders as message text — lives in one adapter under this
package.

Why this is a package and not an if-statement: platform coupling does not stay
in the ingest layer. Left unabstracted it leaks into published output (a skill
telling an agent to match on `openDingTalkId`), into the safety scanner (an id
regex that only recognizes one vendor's format, and therefore silently passes
every other vendor's ids), and into hardcoded timezone offsets. Each of those is
invisible until someone runs the forge on a different platform and gets a skill
that is subtly wrong rather than obviously broken.

    MessageSource            the interface every adapter implements
    DwsSource                DingTalk via the `dws` CLI (the original path)
    JsonlSource              a normalized export from any platform, offline

`capabilities()` is what keeps an adapter honest about what it cannot do. A
source with no `send` must cause the persona's send path to refuse with a clear
reason, rather than failing at a subprocess boundary with a confusing error. A
source with no `mentions` endpoint must say so, because "@-me detection is
text-only here" changes how much the group-chat numbers can be trusted.

## The normalized message

Every adapter yields this shape. Only `messageId`, `conversationId`, `senderId`
and `createdAt` are required; the rest default sensibly.

    {
      "messageId":        str,   # stable, unique per message
      "conversationId":   str,   # stable per thread
      "conversationTitle":str,
      "singleChat":       bool,  # 1:1 vs group. Defaults to False = group, which
                                 # is the safe default but the costliest thing to
                                 # get wrong: in a group, only messages that
                                 # @-mention the owner count as asks aimed at
                                 # them, so a DM history imported without this
                                 # flag mines ZERO asks and the whole decision
                                 # layer becomes defaults. `forge build` warns
                                 # (`no_asks_mined`) and the fidelity report
                                 # grades it D rather than letting it pass.
      "senderId":         str,   # stable per person; matched against the owner's ids
      "senderName":       str,
      "createdAt":        str,   # "YYYY-MM-DD HH:MM:SS" local, or ISO 8601
      "msgType":          str,   # "text" for anything analyzable
      "text":             str,
      "quotedText":       str,
      "quotedSenderName": str,
      "quotedSenderId":   str,
      "threadId":         str,
      "mentionsSelf":     bool,  # optional; the engine also infers this from text
    }
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterator, Protocol, runtime_checkable


@runtime_checkable
class MessageSource(Protocol):
    """What the forge needs from a platform. Optional methods may raise
    `Unsupported`; declare them in `capabilities()` so callers check first."""

    #: Short stable id used in config as `source.kind`.
    KIND: str
    #: Human label for the platform, published in the skill's limits section.
    PLATFORM_LABEL: str
    #: What this platform calls a stable per-person identifier. Published in
    #: people.md, so the skill speaks the platform's own vocabulary.
    ID_LABEL: str
    #: Regex matching this platform's person-id format, consumed by the share
    #: scanner. A source that cannot describe its ids must say so with `None`,
    #: which the scanner reports as reduced coverage rather than silently
    #: passing anything it does not recognize.
    ID_PATTERN: str | None

    def capabilities(self) -> dict: ...
    def identity(self) -> dict: ...
    def conversations(self) -> list[dict]: ...
    def messages(self, start: str, end: str, page_size: int = 100) -> Iterator[dict]: ...


class Unsupported(RuntimeError):
    """This source cannot do that. Raised instead of returning something empty,
    because an empty result is indistinguishable from 'nothing there'."""

    def __init__(self, kind: str, what: str):
        self.kind, self.what = kind, what
        super().__init__(
            f"the {kind} message source does not support {what}. "
            f"Check capabilities() before calling it.")


class BaseSource:
    """Shared defaults. An adapter overrides only what it actually supports."""

    KIND = "base"
    PLATFORM_LABEL = "work chat"
    ID_LABEL = "user id"
    ID_PATTERN = None

    #: What this adapter can do, declared as data so it can be read without
    #: constructing the adapter. That matters because `publish` must stay offline:
    #: the fidelity report has to state which capabilities are missing, and a
    #: rebuild should never require the platform to be reachable or a CLI binary
    #: to be installed. `capabilities()` layers instance detail on top of this.
    CAPS: dict = {"read": True, "mentions": False, "tail": False, "send": False,
                  "directory": False,
                  #: Can this source read a conversation's recent messages from a
                  #: store that is kept close to current by something else (an
                  #: embedding application's own collector), rather than by asking
                  #: the platform right now?
                  #:
                  #: Deliberately separate from `tail`: that one promises what you
                  #: read IS current, and a near-realtime store cannot promise it.
                  #: A source setting this must implement `recent_messages()` and
                  #: report how far behind it is, so the caller can decide whether
                  #: the lag is acceptable for what it is about to do.
                  "recentReads": False}

    #: How far back a mention lookup is worth running, in days. The default
    #: reflects a paged network endpoint: over a six-month backfill, querying it
    #: for every window costs more than the older mentions are worth, and those
    #: are still detectable from the message text.
    #:
    #: An adapter whose lookup is a local query should set this to None, meaning
    #: "no limit". Leaving the network default in place there would silently drop
    #: every structured mention older than the window — and a group message the
    #: owner was @-mentioned in is precisely the evidence the decision layer needs,
    #: so losing it quietly understates how much they were actually asked.
    MENTION_LOOKBACK_DAYS: int | None = 30

    #: Patterns for text this platform's client renders that no person typed —
    #: rich cards, attachment stubs, download hints. Registered into the
    #: placeholder filter when the source is constructed, so they never have to
    #: live in the shared `common.py` where they would be carried by every
    #: deployment regardless of platform.
    CLIENT_FURNITURE: tuple[str, ...] = ()

    @classmethod
    def static_capabilities(cls) -> dict:
        """Everything knowable about this adapter without instantiating it."""
        return {
            "kind": cls.KIND,
            "platformLabel": cls.PLATFORM_LABEL,
            "idLabel": cls.ID_LABEL,
            "idPattern": cls.ID_PATTERN,
            **cls.CAPS,
        }

    def capabilities(self) -> dict:
        return {**self.static_capabilities(), "timezone": None}

    def register_furniture(self) -> int:
        from .. import common as C
        return C.register_placeholders(self.CLIENT_FURNITURE)

    # -- optional capabilities, all refusing loudly by default --------------

    def mentions(self, start: str, end: str) -> list[str]:
        raise Unsupported(self.KIND, "@-mention lookup")

    def conversation_tail(self, conv_id: str, single: bool, since: str,
                          limit: int = 40) -> list[dict]:
        raise Unsupported(self.KIND, "reading a live conversation tail")

    def recent_messages(self, conv_id: str, single: bool, peer_open_id: str = "",
                        limit: int = 30) -> dict:
        """A conversation's newest messages from a near-realtime store.

        Returns `{"messages": [...], "lagSeconds": int|None, "through": str}` —
        the lag is not optional decoration. A caller deciding whether to send a
        reply has to know whether "this is the newest message" means "as of now"
        or "as of four minutes ago", and a source that returns messages without
        saying how stale they might be forces the caller to assume the best.
        """
        raise Unsupported(self.KIND, "reading recent messages from a local store")

    def send(self, target: dict, text: str, cfg: dict | None = None) -> dict:
        raise Unsupported(self.KIND, "sending messages")


#: Registry. Kept as a lazy import map so that adding an adapter with heavy or
#: optional dependencies never slows down or breaks an unrelated command.
_REGISTRY = {
    "dws": ("forge.sources.dws", "DwsSource"),
    "jsonl": ("forge.sources.jsonl", "JsonlSource"),
    "vault": ("forge.sources.vault", "VaultSource"),
}


def available() -> list[str]:
    return sorted(_REGISTRY)


def get_source_class(kind: str):
    """Resolve a source class by config `source.kind`."""
    import importlib
    if kind not in _REGISTRY:
        raise SystemExit(
            f"unknown message source {kind!r}; available: {', '.join(available())}")
    module, attr = _REGISTRY[kind]
    return getattr(importlib.import_module(module), attr)


def furniture_for(cfg: dict) -> tuple[str, ...]:
    """The configured platform's client furniture, without opening the source.

    `build` is offline by contract, so it cannot construct an adapter just to
    learn which rich cards this client renders — that would make a rebuild depend
    on a CLI binary being installed or an export path being readable. Reading the
    class attribute keeps the filter correct and the build hermetic.
    """
    kind = (cfg.get("source") or {}).get("kind", "dws")
    try:
        return tuple(getattr(get_source_class(kind), "CLIENT_FURNITURE", ()))
    except SystemExit:
        return ()


def open_source(cfg: dict, **overrides):
    """Build the source configured for this profile.

    Also registers the platform's client furniture into the placeholder filter,
    which is why every path that analyzes text should obtain its source through
    here rather than instantiating an adapter directly.
    """
    src_cfg = dict(cfg.get("source") or {})
    kind = overrides.pop("kind", None) or src_cfg.get("kind") or "dws"
    options = {**(src_cfg.get("options") or {}), **overrides}
    source = get_source_class(kind)(cfg=cfg, **options)
    source.register_furniture()
    return source
