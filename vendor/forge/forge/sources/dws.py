#!/usr/bin/env python3
"""DingTalk via the `dws` CLI — the forge's original and reference adapter.

This is a thin wrapper, deliberately. The actual client (`forge/runtime.py`
`DwsClient`) is copied verbatim into every published skill as
`scripts/imruntime.py` and must keep working with no imports from the forge
package, so it cannot itself become an adapter. What lives here instead is
everything that is *about DingTalk* rather than about calling `dws`:

  - the id vocabulary the published skill should use (`openDingTalkId`)
  - the id shape the share scanner checks against
  - the rich cards this client renders as message text, which no person typed
  - the timezone offset its mention endpoint requires

Before this split, each of those was hardcoded somewhere it did not belong: the
id label in the composer's published prose, the id regex in the scanner, the
cards in the shared text filter, and the offset inline in the ingest loop.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterator

from ..runtime import DwsClient
from . import BaseSource


class DwsSource(BaseSource):
    KIND = "dws"
    PLATFORM_LABEL = "DingTalk work chat"
    ID_LABEL = "openDingTalkId"

    # Truncating this is not an option: these ids share long prefixes, so a short
    # stub reintroduces the collisions the id exists to prevent.
    ID_PATTERN = r"\bD[A-Za-z0-9]{24,}\b"

    CAPS = {"read": True, "mentions": True, "tail": True, "send": True,
            "directory": True}

    #: Text this client renders that nobody typed. Anchored on card *furniture*
    #: — the localized product footer, a creator line followed by an embedded
    #: image, form field labels — rather than on topic words, so that an ordinary
    #: message which merely mentions documents or permissions is untouched.
    #: Left unfiltered, a long document-permission card is recalled as "how they
    #: reply", which is how a persona learns to answer a colleague with a wall of
    #: URLs.
    CLIENT_FURNITURE = (
        r"该群为保密群|无法获取消息记录",
        r"\[(文件|图片|视频|音频|链接|表情|位置|名片|分享|语音通话|视频通话)(消息)?\]",
        # An attachment stub plus a download hint: tooling output, and because it
        # repeats verbatim it would otherwise dominate the vocabulary ranking.
        r"如需下载使用\s*dws|download-media",
        r"钉钉文档\s*\n\s*DingTalk\s*Docs|我申请开通文档|申请开通.{0,24}权限",
        r"创建者\s*[:：]\s*\S+\s*\n\s*!\[",
        r"是否向好友发送你的名片",
    )

    #: The mention endpoint wants an offset-qualified timestamp. Configurable
    #: because the forge should not assume its operator's timezone; the default
    #: matches DingTalk's primary market.
    DEFAULT_UTC_OFFSET = "+08:00"

    def __init__(self, cfg: dict | None = None, binary: str = "", **_ignored):
        cfg = cfg or {}
        dws_cfg = cfg.get("dws") or {}
        log = None
        if cfg.get("dataRoot"):
            from .. import common as C
            log = C.expand(cfg["dataRoot"]) / "dws-calls.jsonl"
        self.client = DwsClient(binary=binary or dws_cfg.get("binary", "dws"), log=log)
        self.page_size = dws_cfg.get("pageSize", 100)
        self.utc_offset = (cfg.get("timezoneOffset")
                           or dws_cfg.get("utcOffset")
                           or self.DEFAULT_UTC_OFFSET)

    def capabilities(self) -> dict:
        return {**self.static_capabilities(), "timezone": self.utc_offset}

    # -- reads ---------------------------------------------------------------

    def identity(self) -> dict:
        return self.client.self_identity()

    def conversations(self) -> list[dict]:
        """The conversation directory, normalized.

        The peer of a single chat is deliberately NOT taken from the directory's
        owner id field: DingTalk returns the same placeholder there for every 1:1
        thread, so trusting it collapses every direct conversation onto one
        fabricated person. The peer is derived from who actually sent messages
        (`store.link_direct_peers`), which is unambiguous in a two-party chat.
        """
        out = []
        for c in self.client.conversations():
            cid = c.get("openConversationId") or ""
            if not cid:
                continue
            single = bool(c.get("singleChat"))
            title = c.get("title") or ""
            out.append({
                "conversationId": cid,
                "title": title,
                "singleChat": single,
                "peerOpenId": "",          # resolved from messages, see above
                "peerName": title if single else "",
                "memberCount": c.get("memberCount") or 0,
                "muted": bool(c.get("notificationOff")),
                "lastMsgAt": (c.get("lastMsgCreateAt") or "").replace("T", " ")[:19],
            })
        return out

    def messages(self, start: str, end: str, page_size: int = 0) -> Iterator[dict]:
        return self.client.list_all_messages(start, end,
                                             page_size=page_size or self.page_size)

    def mentions(self, start: str, end: str) -> list[str]:
        """Message ids that @-mention the owner, from the dedicated endpoint.

        Takes and returns plain local timestamps like every other method here;
        the offset this platform's API requires is applied internally so no caller
        has to know about it.
        """
        hits = self.client.mentions(self._iso(start), self._iso(end))
        return [m["messageId"] for m in hits if m.get("messageId")]

    def _iso(self, local_ts: str) -> str:
        return f"{local_ts.replace(' ', 'T')}{self.utc_offset}"

    def conversation_tail(self, conv_id: str, single: bool, since: str,
                          limit: int = 40, peer_open_id: str = "") -> list[dict]:
        return self.client.conversation_tail(conv_id, single, since,
                                             peer_open_id=peer_open_id, limit=limit)

    # -- write ---------------------------------------------------------------

    def send(self, target: dict, text: str, cfg: dict | None = None,
             recipient: str = "", audit_path: Path | None = None) -> dict:
        """Send as the owner. The autonomy gate lives in the client itself, at the
        lowest layer that can actually reach DingTalk, so it cannot be bypassed by
        importing around this adapter."""
        result = self.client.send(target, text, cfg=cfg, recipient=recipient,
                                  audit_path=audit_path)
        return {"ok": result.ok, "error": result.error,
                "result": result.result if result.ok else None}
