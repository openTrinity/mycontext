#!/usr/bin/env python3
"""Offline regression suite — no network, no personal data.

Builds a small fictional corpus in a temp directory and exercises the real code
paths end to end: ingest shapes, scene tagging, turn pairing (including the group
"only when addressed" rule), ask mining with silence, decision policy, composing,
and publishing with owner-block preservation.

Runs the whole corpus suite once per locale fixture — `zh-CN`, `en`, and the null
pack — because a forge that is only exercised in one language is a forge whose
language-independence is a claim rather than a test. The null-pack pass is the
important one: it asserts that a corpus nobody has written a pack for still
produces a valid skill, that the skill says so, and that it fabricates nothing.

    python3 -m forge selftest
    python3 -m forge selftest --locale en
"""

from __future__ import annotations

import datetime as dt
import json
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

from . import analyze, build as build_mod, cli, common as C, compose, decide
from . import ingest, locale as locale_mod
from . import publish as publish_mod, relations, report as report_mod
from . import scan as scan_mod, sources as sources_mod, store
from .sources import jsonl as sources_jsonl
from .sources import vault as sources_vault
from .runtime import Corpus as R_Corpus
from .runtime import DwsClient, DwsError, DwsResult, search_terms

SELF_ID = "SELFOPENID"
PEER_ID = "PEER-A"
BOSS_ID = "PEER-B"
BOT_ID = "BOT-1"
# Same display name as PEER_ID, different account. Directories really do contain
# one display name on several accounts, which is what makes name-keyed
# authorization unsafe.
TWIN_ID = "PEER-A-TWIN"


class Fixture:
    """One language's worth of fictional corpus, plus what to assert about it.

    Every string an assertion needs lives here rather than inline in `run()`, so
    the same ~90 corpus checks execute against any locale. Adding a language to
    the suite means adding a Fixture, not editing the assertions — which is the
    only arrangement under which "the engine is language-independent" is
    something the tests can actually prove.
    """

    def __init__(self, locale_id: str, *, self_name: str, display_name: str,
                 peer: str, boss: str, boss_title: str, bot: str,
                 direct_title: str, group_title: str,
                 messages: list[tuple], expect: dict):
        self.locale_id = locale_id
        self.self_name = self_name
        self.display_name = display_name
        self.peer, self.boss, self.bot = peer, boss, bot
        self.boss_title = boss_title
        self.direct_title, self.group_title = direct_title, group_title
        self._messages = messages
        self.expect = expect
        self.aliases = {self_name, display_name}

    def messages(self) -> list[dict]:
        out = []
        for mid, conv, sender, name, at, text in self._messages:
            out.append({"messageId": mid, "conversationId": conv,
                        "conversationTitle": "",
                        "singleChat": conv == "conv-direct", "senderId": sender,
                        "senderName": name, "createdAt": at, "msgType": "text",
                        "text": text, "quotedText": "", "quotedSenderName": "",
                        "quotedSenderId": "", "threadId": ""})
        return out


#: The stack trace is identical in every fixture on purpose: pasted machine
#: output is machine output in any language, and the engine must exclude it
#: without any lexical help.
_TRACE = ("Traceback (most recent call last):\n  File \"app.py\", line 42\n"
          "    raise ValueError(x)\nValueError: bad input")


ZH = Fixture(
    "zh-CN",
    self_name="我", display_name="测试用户",
    peer="小美", boss="老王", boss_title="技术总监", bot="构建助手",
    direct_title="小美", group_title="项目群",
    messages=[
        # direct chat: a technical question answered, and a money ask deferred
        ("d1", "conv-direct", PEER_ID, "小美", "2026-03-02 10:00:00", "这个分支能直接合main吗"),
        ("d2", "conv-direct", SELF_ID, "我", "2026-03-02 10:01:00", "先别急着合，我这边还没跑完"),
        ("d3", "conv-direct", PEER_ID, "小美", "2026-03-02 11:00:00", "这个预算大概多少钱能批"),
        ("d4", "conv-direct", SELF_ID, "我", "2026-03-02 11:02:00", "这个得问一下老王确切的"),
        # An underspecified ask, answered by narrowing it down rather than
        # guessing — this is what the `clarify` hatch is mined from.
        ("d4b", "conv-direct", PEER_ID, "小美", "2026-03-02 15:00:00", "那个配置是不是还不对"),
        ("d4c", "conv-direct", SELF_ID, "我", "2026-03-02 15:02:00", "哪个页面"),
        ("d5", "conv-direct", PEER_ID, "小美", "2026-03-03 09:00:00", "报错了你看下什么原因"),
        ("d6", "conv-direct", SELF_ID, "我", "2026-03-03 09:05:00", "我用你的文件复现了一下，感觉是缓存没清"),
        # an ask the owner never answered, with later activity proving the silence
        ("d7", "conv-direct", PEER_ID, "小美", "2026-03-04 09:00:00", "周末要不要一起去爬山呀"),
        ("d8", "conv-direct", PEER_ID, "小美", "2026-03-06 09:00:00", "那个接口好了吗"),
        ("d9", "conv-direct", SELF_ID, "我", "2026-03-06 09:10:00", "好了，你可以联调了"),
        # group: crosstalk (must NOT pair) then an @-mention (must pair)
        ("g1", "conv-group", PEER_ID, "小美", "2026-03-02 14:00:00", "大家周末愉快"),
        ("g2", "conv-group", SELF_ID, "我", "2026-03-02 14:05:00", "哈哈哈是啊终于周末了"),
        ("g3", "conv-group", BOSS_ID, "老王", "2026-03-02 15:00:00", "@我 这个需求的排期能定吗"),
        ("g4", "conv-group", SELF_ID, "我", "2026-03-02 15:02:00", "我的顾虑是回归成本比较大，要不我们先拆一下"),
        # a notification bot asking question-shaped things nobody answers
        ("b1", "conv-group", BOT_ID, "构建助手", "2026-03-03 08:00:00", "你有一个待审批的流程，需要处理吗？"),
        ("b2", "conv-group", BOT_ID, "构建助手", "2026-03-05 08:00:00", "你有一个待审批的流程，需要处理吗？"),
        ("p1", "conv-direct", SELF_ID, "我", "2026-03-03 09:20:00", _TRACE),
    ],
    expect={
        "directReply": "先别急着合",
        "crosstalkReply": "终于周末了",
        "mentionReply": "回归成本",
        "handoffMarker": "得问",
        "asciiQuery": "这个分支能直接合main吗",
        "shortWord": "缓存",
        "twoWordQuery": "开会 时间安排",
        "shapes": {"settle": "可以，我下午改一下", "handoff": "这个得问一下老王",
                   "decline": "不行，回归成本太大", "defer": "回头我看一下",
                   "clarify": "哪个页面"},
        "quotable": {"defer": "回头我看一下", "handoff": "我问下老王",
                     "clarify": "哪个页面"},
        # An idle particle question. It ends in a question word but asks the
        # counterpart to narrow down NOTHING — measured on a real corpus these
        # outnumber genuine clarifications, so matching them would fill the layer
        # with lines that clarify nothing.
        "notClarify": "吃啥呢",
        # Both invented, and deliberately about a fictional situation. What each
        # one has to exercise is structural: a forwarded two-line log, and a
        # sentence where a deferral marker refers to someone ELSE's plan rather
        # than to the owner postponing their own work.
        "notQuotableMultiline": "甲:昨天那版跑通了吗\n甲:我这边看不到日志",
        "notQuotableIncidental": "他明天就转岗了",
        "declines": (["不行", "不行", "不行", "先不去了,搞不定"], "搞不定"),
        "serviceAccountSuffix": "审批中心",
        "ordinaryNames": ("张三", "Fern"),
        "orgBots": ["泛例内网通", "泛例小助"],
        "genericBotName": "构建助手",
        "longHumanMessage": ("我的需求是这样的：第一个是要把现在的页面拆开，"
                            "第二个是不要动现有的逻辑，因为回归成本比较大，"
                            "第三个是希望这周内能看到一个可以点的版本"),
        "multiBubble": "好的\n那我先改一下\n改完叫你，大概下午能好",
        # A burst whose LAST bubble is harmless while an earlier one carries the
        # real ask. `burstTail` must be classifiable as chitchat on its own.
        "burstRisky": "合同金额那边要你签字确认",
        "burstMiddle": "今天给个回复",
        "burstTail": "谢谢啦",
        "secondPeer": "小明",
        "shortMessage": "好的我看下",
        "plainText": "普通消息",
        "mentionPrefix": ("@张三(张三) 这个能改吗", "这个能改吗"),
    },
)


EN = Fixture(
    "en",
    self_name="me", display_name="Test Owner",
    peer="Sam", boss="Dana", boss_title="Director of Engineering", bot="build-bot",
    direct_title="Sam", group_title="project room",
    messages=[
        ("d1", "conv-direct", PEER_ID, "Sam", "2026-03-02 10:00:00",
         "can this branch go straight into main?"),
        ("d2", "conv-direct", SELF_ID, "me", "2026-03-02 10:01:00",
         "hold on, my run hasn't finished yet"),
        ("d3", "conv-direct", PEER_ID, "Sam", "2026-03-02 11:00:00",
         "roughly how much budget can you approve for this?"),
        ("d4", "conv-direct", SELF_ID, "me", "2026-03-02 11:02:00",
         "you'd have to ask Dana for the exact number"),
        ("d5", "conv-direct", PEER_ID, "Sam", "2026-03-03 09:00:00",
         "it's throwing an error, can you take a look at why?"),
        ("d6", "conv-direct", SELF_ID, "me", "2026-03-03 09:05:00",
         "i reproduced it with your file, seems like a stale cache"),
        # An underspecified ask, answered by narrowing it down rather than
        # guessing — this is what the `clarify` hatch is mined from.
        ("d7b", "conv-direct", PEER_ID, "Sam", "2026-03-03 15:00:00",
         "is the config still wrong on the deploy?"),
        ("d7c", "conv-direct", SELF_ID, "me", "2026-03-03 15:02:00",
         "which one do you mean"),
        ("d7", "conv-direct", PEER_ID, "Sam", "2026-03-04 09:00:00",
         "do you want to go hiking this weekend?"),
        ("d8", "conv-direct", PEER_ID, "Sam", "2026-03-06 09:00:00",
         "any update on that endpoint?"),
        ("d9", "conv-direct", SELF_ID, "me", "2026-03-06 09:10:00",
         "done, you can integrate against it now"),
        ("g1", "conv-group", PEER_ID, "Sam", "2026-03-02 14:00:00",
         "have a good weekend everyone"),
        ("g2", "conv-group", SELF_ID, "me", "2026-03-02 14:05:00",
         "haha yeah finally the weekend"),
        ("g3", "conv-group", BOSS_ID, "Dana", "2026-03-02 15:00:00",
         "@me can we lock in the timeline for this requirement?"),
        ("g4", "conv-group", SELF_ID, "me", "2026-03-02 15:02:00",
         "my concern is the regression cost is high, let's split it first"),
        ("b1", "conv-group", BOT_ID, "build-bot", "2026-03-03 08:00:00",
         "you have a pending approval, would you like to handle it?"),
        ("b2", "conv-group", BOT_ID, "build-bot", "2026-03-05 08:00:00",
         "you have a pending approval, would you like to handle it?"),
        ("p1", "conv-direct", SELF_ID, "me", "2026-03-03 09:20:00", _TRACE),
    ],
    expect={
        "directReply": "hold on",
        "crosstalkReply": "finally the weekend",
        "mentionReply": "regression cost",
        "handoffMarker": "ask",
        "asciiQuery": "can this branch go straight into main?",
        "shortWord": "cache",
        "twoWordQuery": "standup schedule",
        "shapes": {"settle": "sure, i'll change it this afternoon",
                   "handoff": "you'd have to ask Dana about that",
                   "decline": "no, the regression cost is too high",
                   "defer": "later today i'll take a look",
                   "clarify": "which one do you mean"},
        "quotable": {"defer": "later i'll take a look",
                     "handoff": "ask Dana about it",
                     "clarify": "which one do you mean"},
        "notClarify": "how about that",
        "notQuotableMultiline": "Sam: did you even test it\nSam: unbelievable",
        "notQuotableIncidental": "tomorrow is their last day",
        "declines": (["no", "no", "no", "not this sprint, can't fit it"],
                     "can't fit it"),
        "serviceAccountSuffix": "approval-service",
        "ordinaryNames": ("John Smith", "Fern"),
        "orgBots": ["examplecorp-intranet", "examplecorp-helper"],
        "genericBotName": "build-bot",
        "longHumanMessage": ("what i need is roughly this: first, split the current "
                            "page apart; second, don't touch the existing logic "
                            "because the regression cost is high; third, i'd like a "
                            "clickable version by the end of this week"),
        "multiBubble": "ok\nlet me change it first\ni'll ping you when it's done",
        # A burst whose LAST bubble is harmless while an earlier one carries the
        # real ask. `burstTail` must be classifiable as chitchat on its own.
        "burstRisky": "can you sign off on the budget for this",
        "burstMiddle": "today if you can",
        "burstTail": "thanks!",
        "secondPeer": "Fern",
        "shortMessage": "ok let me look",
        "plainText": "just a normal message",
        "mentionPrefix": ("@John(John) can this be changed?", "can this be changed?"),
    },
)


#: The null-pack fixture reuses the Chinese corpus deliberately. The point is not
#: "an unknown language" but "a corpus the loaded pack cannot read" — which is
#: exactly what happens to a real operator whose language has no pack, and which
#: must still yield a valid, honest skill rather than a crash or a fabrication.
NULL = Fixture(
    "none",
    self_name=ZH.self_name, display_name=ZH.display_name,
    peer=ZH.peer, boss=ZH.boss, boss_title=ZH.boss_title, bot=ZH.bot,
    direct_title=ZH.direct_title, group_title=ZH.group_title,
    messages=ZH._messages, expect=ZH.expect,
)

FIXTURES = {"zh-CN": ZH, "en": EN, "none": NULL}


def _make_corpus(root: Path, fx: Fixture) -> tuple[dict, Path]:
    cfg_path = root / "persona-config.json"
    cfg = {
        "configVersion": 3, "profileSlug": "user-selftest",
        "displayName": fx.display_name, "dataRoot": str(root),
        "skillRoots": [str(root / "skills" / "user-selftest-persona")],
        "analysisStart": "2026-03-01", "dws": {"binary": "dws", "pageSize": 50},
        "source": {"kind": "dws", "options": {}},
        "locale": {"id": fx.locale_id},
        "database": {"path": str(root / "database" / "persona.db")},
        "autonomy": {"scope": "draft_only", "allowlist": [], "maxCodepoints": 300},
        "_path": str(cfg_path),
    }
    C.save_config(cfg)

    db = store.open_db(Path(cfg["database"]["path"]))
    store.set_meta(db, "selfOpenIds", SELF_ID)
    store.set_meta(db, "selfAliases", ",".join(sorted(fx.aliases)))
    # peer_open_id deliberately left blank for the direct chat: link_direct_peers
    # must derive it from the messages, which is the real-world case.
    for conv, title, single in (("conv-direct", fx.direct_title, 1),
                                ("conv-group", fx.group_title, 0)):
        store.upsert_conversation(db, {"conversationId": conv, "title": title,
                                       "singleChat": bool(single), "peerOpenId": "",
                                       "peerName": "",
                                       "lastMsgAt": "2026-03-06 09:10:00"})
    store.upsert_person(db, {"personId": PEER_ID, "name": fx.peer, "nick": fx.peer,
                             "seenAt": "2026-03-06 09:00:00"})
    store.upsert_person(db, {"personId": BOSS_ID, "name": fx.boss, "nick": fx.boss,
                             "title": fx.boss_title, "seenAt": "2026-03-02 15:00:00"})
    store.upsert_person(db, {"personId": BOT_ID, "name": fx.bot, "nick": fx.bot,
                             "seenAt": "2026-03-05 08:00:00"})
    # A second account with the SAME display name. This is the real-world shape
    # that makes name-keyed authorization unsafe.
    store.upsert_person(db, {"personId": TWIN_ID, "name": fx.peer, "nick": fx.peer,
                             "seenAt": "2026-03-02 10:00:00"})
    for msg in fx.messages():
        store.insert_message(db, msg, {SELF_ID}, set(), fx.aliases)
    store.link_direct_peers(db, {SELF_ID})
    store.refresh_counts(db)
    store.rebuild_fts(db)
    db.commit()
    db.close()
    return cfg, Path(cfg["database"]["path"])



def _corpus_suite(fx: Fixture, ck) -> None:
    """Every corpus-level check, run once per locale fixture.

    Assertions read their expected strings from `fx.expect` rather than embedding
    them, so this one body proves the same behaviors in every language the suite
    covers. A check that cannot be expressed that way belongs in
    `_locale_specific_suite` instead, clearly marked as such.
    """
    E = fx.expect
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "data"
        C.secure_mkdir(root)
        cfg, db_path = _make_corpus(root, fx)

        conn = store.open_db(db_path, create=False)
        pack, verdict = locale_mod.load(fx.locale_id, root, conn)
        C.register_placeholders(locale_mod.extra_placeholders(root, pack.id))
        rules = analyze.Rules(analyze.load_signals(), pack)
        ck("locale pack loaded as requested",
           pack.id == ("null" if fx.locale_id == "none" else fx.locale_id),
           f"{pack.id} v{pack.version}")
        ck("rules version carries the pack identity",
           pack.stamp() in rules.version, rules.version)

        v = store.verify(conn)
        ck("corpus verifies", v["ok"], json.dumps(
            [c["name"] for c in v["checks"] if not c["passed"]]))

        peer = conn.execute("SELECT peer_open_id, peer_name FROM conversations "
                            "WHERE conversation_id='conv-direct'").fetchone()
        ck("direct peer linked from messages", peer["peer_open_id"] == PEER_ID,
           peer["peer_open_id"])
        ck("direct peer name linked", peer["peer_name"] == fx.peer, peer["peer_name"])
        to_them = conn.execute("SELECT msgs_to FROM people WHERE person_id=?",
                               (PEER_ID,)).fetchone()["msgs_to"]
        ck("reciprocity counted after linking", to_them > 0, f"msgs_to={to_them}")

        # A placeholder id claiming to be the peer of many 1:1 threads is the
        # real-world DingTalk behavior that inverted every tone band; it must be
        # rejected rather than trusted.
        conn.executemany(
            "INSERT OR REPLACE INTO conversations(conversation_id,title,single_chat,"
            "peer_open_id,peer_name) VALUES(?,?,1,'PLACEHOLDER-ID','x')",
            [(f"fake-{i}", f"chat{i}") for i in range(4)])
        conn.execute("INSERT OR REPLACE INTO people(person_id,name) "
                     "VALUES('PLACEHOLDER-ID','ghost')")
        conn.commit()
        store.link_direct_peers(conn, {SELF_ID})
        left = conn.execute("SELECT COUNT(*) c FROM conversations "
                            "WHERE peer_open_id='PLACEHOLDER-ID'").fetchone()["c"]
        ck("shared placeholder peer id rejected", left == 0, f"{left} remain")
        ghost = conn.execute("SELECT COUNT(*) c FROM people "
                             "WHERE person_id='PLACEHOLDER-ID'").fetchone()["c"]
        ck("fabricated person removed", ghost == 0)
        conn.executemany("DELETE FROM conversations WHERE conversation_id=?",
                         [(f"fake-{i}",) for i in range(4)])
        conn.commit()

        pasted = conn.execute("SELECT COUNT(*) c FROM messages WHERE is_pasted=1").fetchone()["c"]
        ck("pasted output flagged", pasted == 1, f"{pasted} flagged")

        # Noise is judged by WHO sent it, not by how the message is worded.
        # Wording rules were tried and removed: 91% of what they caught was
        # already excluded as un-@-mentioned group chatter, the rest all came from
        # service accounts, and they misfired on real colleagues.
        ck("bot recognized by sender",
           rules.is_bot(E["genericBotName"]) or pack.is_null,
           f"pack={pack.id}")
        ck("suffix-style service account recognized",
           rules.is_bot(E["serviceAccountSuffix"]) or pack.is_null)
        ck("person not treated as bot", not rules.is_bot(fx.peer))
        # Only the SENDER is tested, never the message body — so a colleague
        # writing about a system or an approval is never mistaken for one.
        ck("a person with an ordinary name is never a bot",
           not any(rules.is_bot(n) for n in E["ordinaryNames"]))
        # Structural placeholders — no language and no platform required to
        # recognize them, which is why they stay in common.py.
        ck("bare markdown link is a placeholder",
           C.is_placeholder("[https://yuque.example/a/b](https://yuque.example/a/b)"))
        ck("bare url is a placeholder", C.is_placeholder("https://x.example/mr/1"))
        ck("attachment stub is a placeholder", C.is_placeholder("mediaId=$hwEKAq"))

        n_tagged = analyze.tag_scenes(conn, rules)
        total_msgs = conn.execute("SELECT COUNT(*) c FROM messages").fetchone()["c"]
        ck("scenes tagged", n_tagged == total_msgs, f"{n_tagged}/{total_msgs} tagged")
        ck("re-tagging is a no-op", analyze.tag_scenes(conn, rules) == 0)

        ledger = relations.compute_bands(conn, rules, {})
        # Key by personId, not by name: the fixture deliberately contains two
        # accounts with the same display name, so a name-keyed lookup would read
        # whichever one came last — the exact confusion this suite exists to catch.
        by_id = {p["personId"]: p for p in ledger["people"]}
        by_name = {p["name"]: p for p in ledger["people"]}
        ck("sensitive title forces band S",
           by_name.get(fx.boss, {}).get("toneBand") == ("S" if pack.has("sensitiveTitle")
                                                        else by_name.get(fx.boss, {}).get("toneBand")),
           f'{by_name.get(fx.boss, {}).get("toneBand", "missing")} pack={pack.id}')
        ck("ordinary peer not S", by_id[PEER_ID]["toneBand"] != "S",
           by_id[PEER_ID]["toneBand"])
        ck("direct thread detected for 1:1 peer",
           by_id[PEER_ID]["hasDirectThread"] is True)
        ck("group-only contact has no direct thread",
           by_id[BOSS_ID]["hasDirectThread"] is False)
        ck("same-name twin without a thread is separate",
           by_id[TWIN_ID]["hasDirectThread"] is False
           and by_id[TWIN_ID]["personId"] != by_id[PEER_ID]["personId"])

        # an override may tighten without special permission
        tightened = relations.compute_bands(conn, rules, {fx.peer: {"band": "S"}})
        ck("override can tighten",
           {p["personId"]: p["toneBand"] for p in tightened["people"]}[PEER_ID] == "S")
        # but loosening a sensitive role needs explicit trust
        loosened = relations.compute_bands(conn, rules, {fx.boss: {"band": "A"}})
        got = {p["name"]: p["toneBand"] for p in loosened["people"]}.get(fx.boss)
        # The boss is band S either because their title matched, or — with no
        # lexicon to read it — because an unreadable title is treated as
        # sensitive. Both routes must refuse an untrusted loosening.
        ck("override cannot loosen without trust", got == "S", str(got))
        trusted = relations.compute_bands(conn, rules,
                                          {fx.boss: {"band": "A", "trust": True}})
        ck("explicit trust can loosen",
           {p["name"]: p["toneBand"] for p in trusted["people"]}.get(fx.boss) == "A")

        tone_map = relations.apply_bands(conn, ledger)
        pairs = analyze.build_turns_and_asks(conn, rules, tone_map, fx.aliases)
        relations.retag_turns(conn)
        store.rebuild_fts(conn)

        turn_replies = [r["my_reply"] for r in conn.execute("SELECT my_reply FROM turns")]
        ck("direct reply paired",
           any(E["directReply"] in t for t in turn_replies),
           str(turn_replies[:3]))
        ck("group crosstalk NOT paired",
           not any(E["crosstalkReply"] in t for t in turn_replies),
           f"{len(turn_replies)} turns")
        ck("group @-mention IS paired",
           any(E["mentionReply"] in t for t in turn_replies),
           str(turn_replies[:4]))

        asks = [dict(r) for r in conn.execute("SELECT * FROM asks")]
        ck("asks captured", len(asks) >= 4, f"{len(asks)} asks")
        unanswered = [a for a in asks if not a["answered"]]
        ck("silence captured as evidence", len(unanswered) >= 1,
           f"{len(unanswered)} unanswered")
        money = [a for a in asks if "money" in (a["risk_tags"] or "")]
        if pack.has("riskTags"):
            ck("risk tag detected on money ask", len(money) >= 1)
        else:
            # No lexicon means no ask can be tagged — and the policy layer must
            # compensate by treating every class as never-settle, which is what
            # the risk-behavior check below asserts.
            ck("null pack tags no risk but still never settles", not money)
        ck("bot asks excluded from stats",
           not any(a["asker_name"] == fx.bot for a in asks) or pack.is_null,
           str([a["asker_name"] for a in asks]))
        # Context is published verbatim as "their real replies" examples, so
        # client furniture must be excluded from it too — not just from the reply.
        # A media id or a rich card shown as the situation being answered teaches
        # nothing and leaks a payload into the skill.
        ctxs = [r["context_text"] for r in conn.execute(
            "SELECT context_text FROM turns")]
        ck("no placeholder text in published turn context",
           not any(C.is_placeholder(line[line.find("] ") + 2:])
                   for c in ctxs for line in c.split("\n") if "] " in line),
           str([line for c in ctxs for line in c.split("\n")
                if "] " in line and C.is_placeholder(line[line.find("] ") + 2:])][:2]))

        ck("pasted reply excluded from turns",
           not any("Traceback" in r["my_reply"]
                   for r in conn.execute("SELECT my_reply FROM turns")))

        bot_banded = [p for p in ledger["people"] if p["name"] == fx.bot]
        ck("bot gets no tone band", not bot_banded or pack.is_null,
           f"pack={pack.id}")
        ck("1:1 peer can reach a close band",
           by_id[PEER_ID]["toneBand"] in ("A", "B", "C", "D"),
           by_id[PEER_ID]["toneBand"])

        st = analyze.style(conn, rules)
        ck("style measured", st["overall"]["messages"] > 0,
           f"{st['overall']['messages']} self msgs")
        # Clause joining: measurable in any language (punctuation, not vocabulary)
        # and the habit an imitator most often breaks while satisfying every other
        # number — hitting the median length but writing "A, B" where the person
        # would have sent "A" then "B".
        ck("clause joining measured without a locale pack",
           isinstance(st["overall"].get("joinedClausePct"), (int, float)),
           str(st["overall"].get("joinedClausePct")))
        ck("clause joining reported per tone band",
           all("joinedClausePct" in s for s in st.get("byToneBand", {}).values()),
           str(list(st.get("byToneBand", {}))))

        ck("median length reported", st["overall"]["medianCodepoints"] > 0,
           str(st["overall"]["medianCodepoints"]))
        ck("tone bands present in style", bool(st["byToneBand"]),
           str(list(st["byToneBand"])))
        ck("vocabulary ranked by day", "phrases" in st["vocabulary"])
        terms = [p["term"] for p in st["vocabulary"]["phrases"]]
        if not pack.word_boundaries:
            ck("no substring ngram fragments",
               not any(a != b and a in b for a in terms for b in terms),
               str(terms[:8]))
        # Two same-length grams sharing all but one character are windows over
        # one phrase, so only one should survive. Meaningless for a segmented
        # script, where two short words sharing letters are genuinely different
        # words — applying this test there would be a bug, not a stricter check.
        if not pack.word_boundaries:
            ck("no sliding-window ngram fragments",
               not any(a != b and len(a) == len(b) >= 3
                       and len(set(a) & set(b)) >= len(a) - 1
                       for a in terms for b in terms),
               str(terms[:8]))
        else:
            ck("segmented vocabulary keeps distinct words",
               not any(a != b and " " not in a and a in b.split()
                       for a in terms for b in terms),
               str(terms[:8]))
        ck("base64 payload rejected as jargon",
           not analyze._plausible_term(
               "hwesaqnqcgcdaatnaswfzqesbtoai4qbpcec50qcqgdjnvbcldx"))
        ck("real tool name kept as jargon", analyze._plausible_term("gitlab"))

        mined = decide.mine(conn, rules)
        ck("decisions mined", mined["asksAnalyzed"] == len(asks))
        policy = decide.derive_policy(mined, st)
        ck("money is never-settle by default", "money" in policy["neverSettleAlone"],
           str(policy["neverSettleAlone"]))
        hatches = mined["escapeHatches"]["handoff"]
        ck("handoff phrasing captured",
           any(E["handoffMarker"] in h["line"] for h in hatches) or pack.is_null,
           str([h["line"] for h in hatches][:3]))

        # reply shape classification, from the pack's replyShapes
        if pack.has("replyShapes"):
            for shape, line in E["shapes"].items():
                ck(f"{shape} detected", decide._shape(line, rules) == shape,
                   f"{line!r} → {decide._shape(line, rules)}")
        else:
            # Without a lexicon every answered ask is plainly `answer`. Guessing
            # a shape here would let a never-settle risk class look settled.
            ck("null pack labels every answered reply as plain answer",
               decide._shape(E["shapes"]["settle"], rules) == "answer")
            ck("null pack still distinguishes silence",
               decide._shape("", rules) == "silent")

        # escape-hatch quotability: a forwarded chat log or an incidental keyword
        # match must never become a published example
        if pack.has("replyShapes"):
            ck("multi-line paste not quotable",
               not decide._quotable(E["notQuotableMultiline"], "defer", rules))
            ck("incidental keyword not quotable",
               not decide._quotable(E["notQuotableIncidental"], "defer", rules),
               E["notQuotableIncidental"])
            ck("clean deferral is quotable",
               decide._quotable(E["quotable"]["defer"], "defer", rules),
               E["quotable"]["defer"])
            ck("clean handoff is quotable",
               decide._quotable(E["quotable"]["handoff"], "handoff", rules),
               E["quotable"]["handoff"])

            # --- clarify: asking WHICH thing is meant --------------------------
            #
            # The fifth hatch, added because `facts` can detect "the subject is
            # mentioned but the asked-about part is not" and that state has an
            # honest answer beyond refusing: ask which one. It has to be MINED, not
            # composed, or the agent asks back in words the person never used.
            #
            # The false-positive guard matters as much as the match: on a real
            # corpus most question-shaped replies are idle particles ("吃啥呢"),
            # which outnumber genuine clarifications ~18:1. Matching those would
            # fill the layer with lines that clarify nothing.
            ck("clarify shape detected",
               decide._shape(E["shapes"]["clarify"], rules) == "clarify",
               f"{E['shapes']['clarify']!r} → {decide._shape(E['shapes']['clarify'], rules)}")
            ck("an idle question is NOT a clarification",
               decide._shape(E["notClarify"], rules) != "clarify",
               f"{E['notClarify']!r} → {decide._shape(E['notClarify'], rules)}")
            ck("clean clarification is quotable",
               decide._quotable(E["quotable"]["clarify"], "clarify", rules),
               E["quotable"]["clarify"])
            # Precedence: settling outranks narrowing down. A reply that agrees to
            # something while also asking which one is an agreement first, and
            # agreement is what needs a gate.
            ck("a reply that settles AND narrows counts as a settle",
               decide._shape(E["shapes"]["settle"], rules) == "settle",
               decide._shape(E["shapes"]["settle"], rules))
            lines_in, expected = E["declines"]
            reasons = decide._top_lines(lines_in, rules, prefer_longer=True)
            ck("declines prefer the one with a reason",
               bool(reasons) and expected in reasons[0]["line"],
               str([r["line"] for r in reasons]))
        else:
            ck("null pack quotes nothing as an escape hatch",
               not decide._quotable(E["quotable"]["defer"], "defer", rules))

        gated = (mined["replyPropensity"].get("decision_request", {})
                 .get("defaultAction"))
        if pack.has("askKinds"):
            ck("decision_request is always draft-gated",
               gated in (None, "draft_gated"), str(gated))
        else:
            ck("null pack drafts everything",
               all(d.get("defaultAction") == "draft"
                   for k, d in mined["replyPropensity"].items()
                   if not k.startswith("_")),
               str({k: v.get("defaultAction")
                    for k, v in mined["replyPropensity"].items()
                    if not k.startswith("_")}))
        conn.close()

        # --- full build + publish -------------------------------------
        features = build_mod.build(cfg)
        ck("build produced features", features["style"]["overall"]["messages"] > 0)
        ck("features has policy", bool(features["policy"]))

        # --- reply cadence: how many MESSAGES one reply is --------------------
        #
        # This layer exists because the forge briefly SHIPPED a guess: a note
        # telling the caller to "reply once, to all of it". On the author's own
        # corpus 42% of replies are more than one message, so the guess was simply
        # wrong — and it would be wrong in the opposite direction for someone who
        # never splits. The habit is personal, so it has to be measured per person
        # and per band, exactly like tone.
        #
        # It is also purely STRUCTURAL (speaker + timestamps, no lexicon), which is
        # why it must stay measured under the null pack. That property is asserted
        # here rather than only in the zh/en runs.
        bub = features["style"]["overall"].get("bubbles") or {}
        ck("reply cadence is measured", bub.get("samples", 0) > 0, str(bub))
        ck("cadence reports a median message count",
           isinstance(bub.get("medianBubbles"), int) and bub["medianBubbles"] >= 1,
           str(bub.get("medianBubbles")))
        ck("cadence reports how often a reply is multi-message",
           isinstance(bub.get("multiBubblePct"), (int, float))
           and 0 <= bub["multiBubblePct"] <= 100,
           str(bub.get("multiBubblePct")))
        # The null pack is the point: a build with no lexicon still knows cadence.
        ck("cadence survives a null locale pack",
           bub.get("samples", 0) > 0 or not pack.is_null,
           f"null={pack.is_null} samples={bub.get('samples')}")
        # A cadence figure that ignored the gap would merge a whole day of the
        # owner's messages into one enormous "reply".
        ck("cadence bounds a run by the configured gap",
           bub.get("maxBubbles", 0) <= features["style"]["overall"]["messages"],
           f"max={bub.get('maxBubbles')} of {features['style']['overall']['messages']}")
        rb = features["style"].get("replyBubbles") or {}
        ck("cadence records the gap it used",
           isinstance(rb.get("gapSeconds"), int) and rb["gapSeconds"] > 0,
           str(rb.get("gapSeconds")))
        # Per band, so `people.md`'s axis and this one agree.
        ck("cadence is broken down by tone band",
           isinstance(rb.get("byToneBand"), dict), str(type(rb.get("byToneBand"))))
        for _b, _s in (rb.get("byToneBand") or {}).items():
            ck(f"band {_b} cadence has a sample count",
               _s.get("samples", 0) > 0, str(_s))

        # The platform's rich cards must be filtered during a build. They are
        # registered from the source ADAPTER, not from common.py, so a build that
        # forgot to register them would silently count a document-permission card
        # as the owner's prose — this asserts build.py does it.
        card = ("\u57cb\u70b9\u6574\u5408\n\u6211\u7533\u8bf7\u5f00\u901a"
                "\u6587\u6863 \u53ef\u67e5\u770b/\u4e0b\u8f7d \u6743\u9650\n"
                "\u9489\u9489\u6587\u6863\nDingTalk Docs")
        ck("platform client furniture is filtered after a build",
           C.is_placeholder(card), "dws rich card was not registered")
        ck("an ordinary message mentioning the same words survives",
           not C.is_placeholder(
               "\u8fd9\u4e2a\u6587\u6863\u4f60\u6709\u6743\u9650\u5417"))


        pub = publish_mod.publish(cfg, features)
        persona_dir = C.expand(cfg["skillRoots"][0])
        ck("persona SKILL.md written", (persona_dir / "SKILL.md").exists())
        for ref in ("style.md", "decisions.md", "scenes.md", "people.md",
                    "limits.md", "fidelity.md"):
            ck(f"reference rendered: {ref}", (persona_dir / "references" / ref).exists())

        # --- the published skill must be honest about what it could not measure ---
        # This is the block that makes a null-pack build safe to hand to someone.
        # Everything asserted here is about the ABSENCE of fabrication, which is
        # exactly what no amount of testing in the forge's own language can show.
        style_md = (persona_dir / "references" / "style.md").read_text(encoding="utf-8")
        decisions_md = (persona_dir / "references" / "decisions.md").read_text(encoding="utf-8")
        fidelity_md = (persona_dir / "references" / "fidelity.md").read_text(encoding="utf-8")

        ck("fidelity report names the locale pack",
           (pack.id if not pack.is_null else "No locale pack") in fidelity_md)
        ck("fidelity report always lists what it cannot know",
           "cannot know" in fidelity_md.lower())
        ck("fidelity report grades coverage, not quality",
           "coverage" in fidelity_md.lower() and "grade" in fidelity_md.lower())
        ck("fidelity report refuses to self-score behavior",
           "not** self-assessed" in fidelity_md or "not self-assessed" in fidelity_md)
        ck("fidelity report scaffolds the behavioral block for the owner",
           "owner:begin fidelity-behavioral" in fidelity_md)
        ck("fidelity report never publishes the answer key",
           "answer key" not in fidelity_md.lower())

        # Cross-locale leakage: a build in one language must not carry another's
        # register advice. This is the check that would have caught the original
        # state, where an English corpus was told not to write Chinese jargon.
        # Compared on entries UNIQUE to the other pack. Some advice is genuinely
        # language-independent ("never explain that you are an assistant") and
        # every pack states it, so a naive comparison would flag the shared
        # guidance rather than a leak.
        mine = {i.split("\u00b7")[0].strip()
                for i in (pack.guide("neverWrite") or [])}
        other_never = []
        for other_id in locale_mod.available():
            if other_id == pack.id:
                continue
            other_pack, _ = locale_mod.load(other_id)
            for item in (other_pack.guide("neverWrite") or []):
                head = item.split("\u00b7")[0].strip()
                if len(head) >= 4 and head not in mine and head in style_md:
                    other_never.append((other_id, head[:24]))
        ck("no other locale's register advice leaked into style.md",
           not other_never, str(other_never))

        # With no locale pack nothing can be classified, so the machine policy
        # must collapse to draft-only. This is the configuration a weak model is
        # most likely to be handed by someone whose language has no pack, and the
        # one where "the rate says 92%" would be most dangerous.
        rules_json = json.loads(
            (persona_dir / "references" / "rules.json").read_text(encoding="utf-8"))
        if pack.is_null:
            ck("null build publishes no ask-kind patterns",
               not (rules_json.get("patterns") or {}).get("askKinds"))
            ck("null build makes every measured action draft",
               all(v == "draft" for v in
                   (rules_json.get("policy") or {}).get("byAskKind", {}).values()),
               str((rules_json.get("policy") or {}).get("byAskKind")))
            ck("null build reports its coverage as unusable",
               not (rules_json.get("coverage") or {}).get("askKinds", False))
        else:
            ck("measured build publishes usable patterns",
               bool((rules_json.get("patterns") or {}).get("askKinds"))
               and bool((rules_json.get("patterns") or {}).get("riskTags")))
            ck("measured build gates decision requests regardless of the rate",
               (rules_json.get("policy") or {}).get("byAskKind", {})
               .get("decision_request") in (None, "draft_gated"),
               str((rules_json.get("policy") or {}).get("byAskKind", {})
                   .get("decision_request")))

        # The published SKILL.md must be an executable procedure, not an essay: a
        # weak model needs the steps numbered and each one to name its command.
        skill_md = (persona_dir / "SKILL.md").read_text(encoding="utf-8")
        for needed in ("Step 1", "Step 2", "Step 3", "Step 4", "Step 5", "Step 6"):
            ck(f"SKILL.md has {needed}", needed in skill_md)
        ck("SKILL.md starts the procedure with brief",
           "persona.py brief" in skill_md)
        ck("SKILL.md tells the model a rate is not permission",
           "not permission" in skill_md)
        ck("SKILL.md forbids upgrading a verdict",
           "Never upgrade" in skill_md)
        ck("SKILL.md routes unknown facts to facts, not to invention",
           "persona.py facts" in skill_md and "not in the corpus" in skill_md.lower())

        # An embedding host runs the mechanical steps itself and gives the model
        # no shell, so the procedure has to state that mode explicitly. Left
        # implicit, the model runs `persona.py`, gets nothing, and then answers
        # without a verdict behind it — the exact failure the six steps exist to
        # prevent. The output contract is asserted here rather than in the host
        # because the host parses whatever this file promises.
        ck("SKILL.md documents the embedded host mode",
           "Embedded host mode" in skill_md)
        ck("SKILL.md names the embedded output contract",
           "holdForReview" in skill_md and '"reply"' in skill_md)
        # ★ The load-bearing sentence. `holdForReview: false` must not read as
        # permission to send — that is `Never upgrade` restated for a host that
        # asks the model one question instead of handing it a command line. A
        # build that loses this line still works and still looks correct, while
        # the model has quietly acquired a send switch it was never given.
        ck("SKILL.md denies that holdForReview=false grants anything",
           "grants nothing" in skill_md)
        ck("SKILL.md tells the embedded model not to run the scripts",
           "Do not try to run" in skill_md)

        ck("SKILL.md has no unfilled placeholder", "{{" not in skill_md,
           skill_md[skill_md.find("{{"):skill_md.find("{{") + 40]
           if "{{" in skill_md else "")

        if pack.is_null:
            ck("null build declares the missing locale in style.md",
               "No locale pack matched" in style_md)
            ck("null build declares it cannot classify asks",
               "could not classify" in decisions_md)
            ck("null build states auto-send is unavailable",
               "not available in this build" in decisions_md
               or "Auto-send is not available" in decisions_md)
            ck("null build publishes an empty never-write section, not a foreign one",
               "empty by design" in style_md)
            ck("null build still publishes every risk class as never-settle",
               all(f in decisions_md for f in ("never settle",)) and
               all(compose.RISK_LABEL[t] in decisions_md
                   for t in decide._ALL_RISK_TAGS),
               str([t for t in decide._ALL_RISK_TAGS
                    if compose.RISK_LABEL[t] not in decisions_md]))
            ck("null build labels undetectable classes as undetectable",
               "cannot detect" in decisions_md)
            ck("null build invents no escape hatches",
               "Do not invent one" in decisions_md)
            ck("null build grades its own coverage down",
               re.search(r"grade [CD]", fidelity_md) is not None,
               (re.search(r"grade .", fidelity_md) or [""])[0])
        else:
            ck("measured build publishes this locale's register advice",
               any(item.split("·")[0].strip()[:12] in style_md
                   for item in (pack.guide("neverWrite") or [])),
               pack.id)
            ck("measured build fills the opener guidance",
               "{{" not in style_md)
        ck("runtime copied into persona",
           (persona_dir / "scripts" / "imruntime.py").exists())


        skill_text = (persona_dir / "SKILL.md").read_text(encoding="utf-8")
        ck("no unsubstituted placeholders in SKILL.md",
           "{{" not in skill_text, skill_text[:80])
        all_refs = "".join((persona_dir / "references" / f).read_text(encoding="utf-8")
                           for f in ("style.md", "decisions.md", "scenes.md",
                                     "people.md", "limits.md"))
        ck("no placeholders in references", "{{" not in all_refs and "<n>" not in all_refs)
        ck("no template angle placeholders",
           "<display-name>" not in all_refs and "<profile-slug>" not in all_refs)
        ck("decisions names the hard stop", "never settle" in all_refs.lower())

        # people.md must carry identity, not just names: the send gate is keyed on
        # openDingTalkId, so a table of names alone would let an agent resolve a
        # band for one person and message another who shares the name.
        people_md = (persona_dir / "references" / "people.md").read_text(encoding="utf-8")
        ck("people.md publishes the openDingTalkId", PEER_ID in people_md)
        ck("people.md tells the agent to match on id",
           "not the name, is who they are" in people_md)
        ck("people.md shows the id-based who command",
           "--person-id" in people_md)
        summary = features["people"]
        ck("summary carries personId", all("personId" in p for p in summary))
        ck("summary flags a name shared inside the table",
           all("ambiguousName" in p for p in summary))

        # owner blocks survive a republish
        style_path = persona_dir / "references" / "style.md"
        original = style_path.read_text(encoding="utf-8")
        marked = original.replace(
            "<!-- owner:begin style-extra -->",
            "<!-- owner:begin style-extra -->\nMY HAND WRITTEN NOTE")
        C.secure_write(style_path, marked)
        publish_mod.publish(cfg, features)
        after = style_path.read_text(encoding="utf-8")
        ck("owner block preserved across publish", "MY HAND WRITTEN NOTE" in after)
        ck("generated part still refreshed",
           f"How {fx.display_name} writes" in after)

        # a stale file from an older version is pruned
        stale = persona_dir / "references" / "obsolete.md"
        C.secure_write(stale, "old")
        publish_mod.publish(cfg, features)
        ck("stale file pruned", not stale.exists())

        # ...and so is the empty directory it leaves behind. v1 shipped an
        # `agents/` dir; pruning only its file left a shell, which broke
        # byte-identical rebuilds.
        stale_dir = persona_dir / "agents"
        C.secure_write(stale_dir / "openai.yaml", "name: old")
        publish_mod.publish(cfg, features)
        ck("stale directory pruned", not stale_dir.exists(),
           "agents/ still present" if stale_dir.exists() else "")

        # The guarantee that makes "skills are products" true: delete the whole
        # skill, republish, and get the same bytes back — INCLUDING the owner's
        # hand-written blocks, which is why they are backed up to the data root.
        import shutil as _sh
        snapshot = {p.relative_to(persona_dir).as_posix(): p.read_bytes()
                    for p in persona_dir.rglob("*")
                    if p.is_file() and "__pycache__" not in p.parts}
        _sh.rmtree(persona_dir)
        result = publish_mod.publish(cfg, features)
        rebuilt = {p.relative_to(persona_dir).as_posix(): p.read_bytes()
                   for p in persona_dir.rglob("*")
                   if p.is_file() and "__pycache__" not in p.parts}
        ck("deleted skill rebuilds byte-identically", snapshot == rebuilt,
           f"before={len(snapshot)} after={len(rebuilt)} differing="
           + str([k for k in snapshot if snapshot.get(k) != rebuilt.get(k)])[:120])
        ck("owner block survives skill deletion",
           "MY HAND WRITTEN NOTE" in
           (persona_dir / "references" / "style.md").read_text(encoding="utf-8"),
           str(result.get("ownerBlocksRestored"))[:100])
        ck("owner blocks backed up to the data root",
           (C.expand(cfg["dataRoot"]) / "owner-blocks.json").exists())
        backed = C.read_json(C.expand(cfg["dataRoot"]) / "owner-blocks.json", {})
        ck("backup holds the owner's actual words, not the hint",
           "MY HAND WRITTEN NOTE" in
           (backed.get("references/style.md", {}).get("style-extra", "")),
           str(backed.get("references/style.md", {}))[:120])
        ck("untouched block not recorded as an edit",
           "references/limits.md" not in backed, str(sorted(backed))[:120])

        s = scan_mod.scan("skill", persona_dir)
        ck("published skill passes share scan", s["safe"],
           json.dumps(s["findings"][:5], ensure_ascii=False))

        # The person-id exception is bounded: allowed in people.md (the gate needs
        # it), flagged anywhere else. Truncating is not an alternative — real
        # openDingTalkIds share long prefixes, so a stub recreates the collisions.
        leaked = persona_dir / "references" / "scenes.md"
        original_scenes = leaked.read_text(encoding="utf-8")
        # A realistic openDingTalkId shape, since the fixture ids are synthetic.
        C.secure_write(leaked, original_scenes + "\n- peer DaaQWzKpLnR7ETX4mBu9vkcyFH2SJ5w8XZ\n")
        s2 = scan_mod.scan("skill", persona_dir)
        ck("person id outside people.md is flagged",
           any(f["kind"] == "person_id_outside_people_md" for f in s2["findings"]),
           json.dumps(s2["findings"][:3], ensure_ascii=False))
        C.secure_write(leaked, original_scenes)
        ck("conversation ids are still forbidden everywhere",
           "raw_conversation_id" in scan_mod.SKILL_FORBIDDEN)

        # --- lock: another agent must not be able to edit the skill --------
        import os as _os
        publish_mod.set_readonly(cfg, True)
        skill_md = persona_dir / "SKILL.md"
        ck("locked file is read-only mode 444",
           (_os.stat(skill_md).st_mode & 0o777) == 0o444,
           oct(_os.stat(skill_md).st_mode & 0o777))
        try:
            skill_md.write_text("agent tampering", encoding="utf-8")
            ck("locked file rejects a direct write", False, "write succeeded")
        except PermissionError:
            ck("locked file rejects a direct write", True)
        # ...but the forge must still be able to rebuild it, or the lock would
        # make the product un-updatable, which defeats "all tuning via the forge".
        cfg["lockSkills"] = True
        pub2 = publish_mod.publish(cfg, features)
        ck("forge can still publish over a locked skill",
           f"How {fx.display_name} writes" in
           (persona_dir / "references" / "style.md").read_text(encoding="utf-8"))
        ck("publish re-applies the lock",
           (_os.stat(skill_md).st_mode & 0o777) == 0o444 and pub2["readOnly"],
           oct(_os.stat(skill_md).st_mode & 0o777))
        publish_mod.set_readonly(cfg, False)
        cfg["lockSkills"] = False
        ck("unlock restores writability",
           (_os.stat(skill_md).st_mode & 0o777) == 0o600,
           oct(_os.stat(skill_md).st_mode & 0o777))

        # --- degraded mode: skill without a corpus -------------------------
        import subprocess as _sp
        pointer = persona_dir / "references" / ".config-path"
        saved_pointer = pointer.read_text(encoding="utf-8")
        C.secure_write(pointer, "/nonexistent/persona-config.json\n")
        proc = _sp.run([sys.executable, str(persona_dir / "scripts" / "persona.py"),
                        "recall", "--context", E["shortWord"]],
                       capture_output=True, text=True, timeout=60)
        ck("no-corpus run exits non-zero", proc.returncode != 0, f"rc={proc.returncode}")
        ck("no-corpus run emits JSON, not a traceback",
           proc.stdout.strip().startswith("{") and "Traceback" not in proc.stderr,
           (proc.stderr or proc.stdout)[:120])
        try:
            payload = json.loads(proc.stdout)
        except json.JSONDecodeError:
            payload = {}
        ck("no-corpus run explains the degraded mode",
           payload.get("degraded") == "markdown-only", str(payload)[:120])
        C.secure_write(pointer, saved_pointer)

        # scope enforcement is a config fact the skill reads
        ck("default scope is draft_only",
           cfg["autonomy"]["scope"] == "draft_only")
        ck("scope note rendered into SKILL.md",
           "draft_only" in skill_text)

        # --- identity, not names, gates auto-send --------------------------
        # Two people share a name in the fixture, mirroring the real corpus
        # (one display name can map to several accounts). Name-keyed matching lets a
        # renamed conversation impersonate an allowlisted colleague.
        with R_Corpus(cfg["database"]["path"]) as corp:
            amb = corp.person(fx.peer)
            ck("ambiguous name reports ambiguity", bool(amb.get("ambiguous")),
               f"candidates={amb.get('candidateCount')}")
            ck("ambiguous lookup returns the highest-volume account",
               amb["person_id"] == PEER_ID, amb["person_id"])
            exact = corp.person_by_id(TWIN_ID)
            ck("person_by_id resolves the other account exactly",
               exact and exact["person_id"] == TWIN_ID)
            uniq = corp.person(fx.boss)
            ck("unique name is not flagged ambiguous", not uniq.get("ambiguous"))

            # A person-scoped lookup must NEVER return another person's lines.
            # The fallback branch used to drop the filter, so a query whose
            # keywords missed silently returned everyone's messages while looking
            # like an answer about one person — which is how a term of address
            # leaks between recipients and the reply reads as not-them.
            scoped = corp.my_lines(query="nosuchtermzzz", person=fx.peer, k=8)
            ck("person-scoped lines never leak another person's words",
               all(E["mentionReply"] not in l["text"] for l in scoped),
               str([l["text"][:20] for l in scoped])[:120])
            group_only = corp.my_lines(query="nosuchtermzzz", person=fx.boss, k=8)
            ck("scoping to a group-only contact returns nothing, not everything",
               group_only == [], str(len(group_only)))
            direct = corp.my_lines(query=E["shortWord"], person=fx.peer, k=5)
            ck("scoped keyword lookup still finds real lines",
               any(E["shortWord"] in l["text"] for l in direct),
               str([l["text"][:24] for l in direct])[:120])
            ck("a real match is labelled as matched",
               all(l["matchedQuery"] for l in direct))
            miss = corp.my_lines(query="neversaidthiszzz", person=fx.peer, k=5)
            ck("a miss is labelled, not passed off as a match",
               miss and not any(l["matchedQuery"] for l in miss),
               f"{len(miss)} rows, matched={[l['matchedQuery'] for l in miss][:3]}")

        import subprocess as _sp2
        script = str(persona_dir / "scripts" / "persona.py")

        def run_send(**kw):
            argv = [sys.executable, script, "send",
                    "--conversation-id", "conv-direct", "--single", "true",
                    "--text", E["shortMessage"], "--dry-run"]
            for k, v in kw.items():
                argv += [f"--{k}", v]
            p = _sp2.run(argv, capture_output=True, text=True, timeout=60)
            try:
                return json.loads(p.stdout or "{}")
            except json.JSONDecodeError:
                return {"_raw": p.stdout[:200], "_err": p.stderr[-200:]}

        cfg["autonomy"] = {"scope": "allowlist", "allowlist": [PEER_ID],
                           "allowlistNames": {PEER_ID: fx.peer}, "maxCodepoints": 300}
        C.save_config(cfg)

        r = run_send(**{"peer-open-id": PEER_ID})
        ck("allowlisted id passes the gate", r.get("wouldSend") is True, str(r)[:130])

        # THE attack: the twin account has the same display name but is not
        # authorized. Passing its id (what a renamed chat would really resolve to)
        # must be refused.
        r = run_send(**{"peer-open-id": TWIN_ID, "recipient": fx.peer})
        ck("same-name different-id is refused", r.get("blocked") is True, str(r)[:130])

        # A name alone can never authorize: without an id there is nothing to check.
        r = run_send(**{"recipient": fx.peer})
        ck("name without id is refused", r.get("blocked") is True, str(r)[:130])

        # Name/id disagreement means the agent is reasoning about someone else.
        r = run_send(**{"peer-open-id": PEER_ID, "recipient": fx.boss})
        ck("name/id mismatch is refused", r.get("blocked") is True, str(r)[:130])

        # A group has no single identity to check.
        p = _sp2.run([sys.executable, script, "send", "--conversation-id", "conv-group",
                      "--single", "false", "--text", E["shortMessage"], "--dry-run"],
                     capture_output=True, text=True, timeout=60)
        rg = json.loads(p.stdout or "{}")
        ck("group send refused under allowlist scope", rg.get("blocked") is True,
           str(rg)[:130])

        cfg["autonomy"] = {"scope": "draft_only", "allowlist": [],
                           "allowlistNames": {}, "maxCodepoints": 300}
        C.save_config(cfg)

        # --- `everyone` is the widest scope, not an absent one ---------------
        # It promises "any resolved recipient; unresolved and sensitive stay
        # manual". Measured on the real config, that promise was documented but
        # not implemented: a stranger, an HR contact and a group all sailed
        # through. These assertions pin the floor.
        cfg["autonomy"] = {"scope": "everyone", "allowlist": [],
                           "allowlistNames": {}, "maxCodepoints": 300}
        C.save_config(cfg)

        r = run_send(**{"peer-open-id": PEER_ID})
        ck("everyone: known 1:1 peer passes", r.get("wouldSend") is True, str(r)[:130])

        r = run_send(**{"peer-open-id": "DstrangerNotInCorpus000000"})
        ck("everyone: unknown recipient refused", r.get("blocked") is True, str(r)[:130])

        r = run_send(**{"peer-open-id": BOSS_ID})
        ck("everyone: sensitive/band-S recipient refused",
           r.get("blocked") is True, str(r)[:130])

        p = _sp2.run([sys.executable, script, "send", "--conversation-id", "conv-group",
                      "--single", "false", "--text", E["shortMessage"], "--dry-run"],
                     capture_output=True, text=True, timeout=60)
        rg = json.loads(p.stdout or "{}")
        ck("everyone: group still refused", rg.get("blocked") is True, str(rg)[:130])

        cfg["autonomy"] = {"scope": "draft_only", "allowlist": [],
                           "allowlistNames": {}, "maxCodepoints": 300}
        C.save_config(cfg)

def _lexical_probe() -> bool:
    """Does the share scan flag a lexical pattern planted in an engine file?

    Verified against the real `_lexical_findings`, not a reimplementation of it —
    the guard is only worth anything if the shipped scanner is what gets tested.
    The planted text is built from codepoints so this file's own source stays free
    of the pattern it is planting.
    """
    marker = chr(0x4e0d) + chr(0x884c)          # readable text, must be flagged
    escaped = "\\u4e0d\\u884c"                    # the documented escape form
    if not scan_mod._lexical_findings("forge/decide.py", f'RX = "{marker}"'):
        return False
    # The escape form is how the engine is allowed to name a codepoint.
    if scan_mod._lexical_findings("forge/decide.py", f'RX = "{escaped}"'):
        return False
    # Locale packs and platform adapters are exactly where lexicon belongs.
    if scan_mod._lexical_findings("forge/locales/zh-CN.json", marker):
        return False
    if scan_mod._lexical_findings("forge/sources/dws.py", marker):
        return False
    return True


def _raises(exc, fn, *a, **kw) -> bool:
    """True if calling fn raises exc. An optional capability that returns an empty
    result instead of raising is the failure this checks for: empty is
    indistinguishable from 'nothing there'."""
    try:
        fn(*a, **kw)
    except exc:
        return True
    except Exception:
        return False
    return False


def _systemexit_message(fn, *a, **kw) -> str:
    """The text of a SystemExit, so a test can assert the message is actionable.

    A refusal that does not say what to do instead gets worked around rather than
    heeded, so the wording is part of the contract.
    """
    try:
        fn(*a, **kw)
    except SystemExit as e:
        return str(e)
    return ""


def _corpus_query(cfg: dict, sql: str, *params):
    """One value from a corpus the suite just built."""
    conn = sqlite3.connect(C.expand(cfg["database"]["path"]))
    try:
        row = conn.execute(sql, params).fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def _corpus_has(cfg: dict, message_id: str) -> bool:
    return bool(_corpus_query(
        cfg, "SELECT COUNT(*) FROM messages WHERE message_id=?", message_id))


def _corpus_epoch_max(cfg: dict):
    return _corpus_query(cfg, "SELECT MAX(epoch) FROM messages")


def _corpus_epoch_is_seconds(cfg: dict) -> bool:
    """`epoch` must be unix SECONDS.

    Checked as a magnitude rather than by comparing against a source value,
    because that is what catches the mistake in either direction: milliseconds
    land around 1.7e12, which is the year 55000-something in seconds, and every
    latency in the corpus would be a thousand times too large — a persona that
    looks like it never replies.
    """
    peak = _corpus_epoch_max(cfg) or 0
    return 1e9 < peak < 1e11


def _global_suite(ck) -> None:
    """Checks independent of any corpus or locale: pure helpers, the
    generalization guards, repo shareability, and the client's error and send
    gates."""

    # --- pure helpers ----------------------------------------------------

    # Reply-cadence merging, on a synthetic table so the boundaries are exact.
    # Built here rather than in the corpus suite because the cases that matter are
    # ones a natural fixture will not contain: an agent-sent message in the middle
    # of a human run, and two runs separated by exactly more than the gap.
    _cad = sqlite3.connect(":memory:")
    _cad.row_factory = sqlite3.Row
    _cad.executescript(store.SCHEMA)
    _cad.execute("INSERT INTO conversations(conversation_id,title,single_chat,"
                 "peer_name,peer_open_id) VALUES('c1','peer',1,'peer','PID')")
    _rows = [
        # one reply sent as three bubbles (10s apart)
        ("m1", 1, 0, 1000.0), ("m2", 1, 0, 1010.0), ("m3", 1, 0, 1020.0),
        # the peer speaks: closes the run
        ("m4", 0, 0, 1100.0),
        # two bubbles, then a long silence, then one more → 2 separate replies
        ("m5", 1, 0, 1200.0), ("m6", 1, 0, 1210.0),
        ("m7", 1, 0, 9000.0),
        # an agent-sent message must not be counted at all
        ("m8", 1, 1, 9010.0),
    ]
    for mid, is_self, agent, epoch in _rows:
        _cad.execute(
            "INSERT INTO messages(message_id,conversation_id,sender_id,sender_name,"
            "occurred_at,epoch,msg_type,text,clean_text,is_self,is_agent_sent,"
            "is_pasted,scene) VALUES(?,?,?,?,?,?,'text',?,?,?,?,0,'unknown')",
            (mid, "c1", "SELF" if is_self else "PID", "n", "2026-03-01 00:00:00",
             epoch, "a real line", "a real line", is_self, agent))
    _cad.commit()
    _cad_rules = analyze.Rules(analyze.load_signals(None), locale_mod.NULL_PACK)
    _cad_out = analyze.reply_bubbles(_cad, _cad_rules, {"PID": "A"})
    _runs_seen = _cad_out["overall"]
    ck("cadence merges consecutive messages into one reply",
       _runs_seen["maxBubbles"] == 3, str(_runs_seen))
    ck("cadence splits a run when the gap is exceeded",
       _runs_seen["samples"] == 3, f"expected 3 replies, got {_runs_seen['samples']}")
    # 3 + 2 + 1 bubbles over 3 replies; the agent-sent row must be absent.
    ck("cadence excludes agent-sent messages",
       _runs_seen["meanBubbles"] == 2.0, str(_runs_seen["meanBubbles"]))
    ck("cadence attributes a 1:1 run to the peer's band",
       (_cad_out["byToneBand"].get("A") or {}).get("samples") == 3,
       str(_cad_out["byToneBand"]))
    ck("cadence works with no locale pack at all",
       _runs_seen["samples"] > 0 and _cad_rules.pack.is_null)
    _cad.close()

    terms = search_terms("这个分支能直接合main吗")
    ck("search terms include ascii identifier", "main" in terms, str(terms[:5]))
    ck("search terms include cjk ngrams",
       any(len(t) >= 3 and t.isalpha() and not t.isascii() for t in terms))
    # A 2-character CJK word is the most common shape in Chinese and produced no
    # terms at all, so those queries silently returned "recent lines" instead.
    ck("two-character cjk word is searchable", search_terms("缓存") == ["缓存"],
       str(search_terms("缓存")))
    ck("two-character word survives alongside longer ones",
       bool(search_terms("开会 时间安排")), str(search_terms("开会 时间安排")[:4]))

    # A credential literal is assembled at runtime so this file itself does not
    # trip the repo share-scan it is testing.
    fake_secret = "glpat-" + "abcdefghij1234"
    ck("secret scrubbed", C.SECRET_MASK in C.scrub_secrets(f"token {fake_secret}"))
    ck("plain text untouched", C.scrub_secrets("普通消息") == "普通消息")
    ck("mention prefix stripped",
       C.strip_mentions("@张三(张三) 这个能改吗") == "这个能改吗")

    # A config written by an older version must pick up new options rather than
    # leaving them as invisible code defaults.
    old_cfg = {"autonomy": {"scope": "allowlist"}, "replyWindow": {}}
    added = C.ensure_config_defaults(
        old_cfg, {"autonomy": {"scope": "draft_only", "maxCodepoints": 300},
                  "replyWindow": {"staleAfterMinutes": 240}, "newTop": 1})
    ck("config upgrade adds missing nested keys",
       old_cfg["replyWindow"]["staleAfterMinutes"] == 240
       and old_cfg["autonomy"]["maxCodepoints"] == 300, str(added))
    ck("config upgrade never overwrites a set value",
       old_cfg["autonomy"]["scope"] == "allowlist")
    ck("config upgrade reports what it added",
       "replyWindow.staleAfterMinutes" in added and "newTop" in added, str(added))

    ck("stack trace is pasted output",
       C.is_pasted_output("Traceback (most recent call last):\n  File x.py, line 3"))
    ck("json blob is pasted output",
       C.is_pasted_output('{"sessionId": "abc", "contentType": "text", "x": 1}'))
    ck("console log is pasted output",
       C.is_pasted_output("index-CmIihb0V.js:111 [useChat] ping sent {id: null}"))
    # Arrow diagrams are machine output in any language, so the fixture needs no
    # words at all — only the structure the detector keys on. Written with
    # identifiers rather than prose so this case cannot be traced to anyone's
    # actual message, which an earlier version of it could be.
    ck("arrow diagram is pasted output",
       C.is_pasted_output("pipeline overview\n  server (session/x)\n"
                          "  → sdk (manager.ts)\n    → EventBus: data\n    → ui"))
    ck("uuid dump is pasted output",
       C.is_pasted_output("结果 10955372-ea0c-4e54-9150-6e4c2836edd2 已经生成好了看下"))
    ck("long human message is NOT pasted output",
       not C.is_pasted_output("我的需求是这样的：第一个是要把现在的页面拆开，"
                              "第二个是不要动现有的逻辑，因为回归成本比较大，"
                              "第三个是希望这周内能看到一个可以点的版本"))
    ck("multi-bubble human text is NOT pasted output",
       not C.is_pasted_output("好的\n那我先改一下\n改完叫你，大概下午能好"))
    ck("short message is NOT pasted output", not C.is_pasted_output("好的我看下"))
    # --- the engine must be language- and platform-independent -------------
    # This is the guard that keeps the whole refactor from eroding. Every rule
    # shipped in forge/*.py runs against every future user's corpus, so a lexical
    # pattern there is not a rule — it is one language's detail, silently wrong
    # for everyone else. The same goes for one company's internal tool names.
    # scan.py is excluded for the same reason it skips itself: it holds the
    # codepoint ranges used to ENFORCE this rule, so its pattern table would
    # always be its own first finding.
    ENGINE_FILES = ("common.py", "analyze.py", "decide.py", "relations.py",
                    "compose.py", "runtime.py", "store.py", "ingest.py",
                    "publish.py", "build.py", "cli.py", "locale.py",
                    "report.py")
    forge_dir = Path(analyze.__file__).parent
    repo_dir = forge_dir.parent

    # 1. No CJK anywhere in the engine. Mechanical, unambiguous, and it is exactly
    #    the check that would have caught the pre-refactor state. `locales/` and
    #    `sources/` are excluded by design: that is where such patterns belong.
    cjk = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]")
    offenders = {}
    for name in ENGINE_FILES:
        src = (forge_dir / name).read_text(encoding="utf-8")
        hits = sorted(set(cjk.findall(src)))
        if hits:
            offenders[name] = "".join(hits[:12])
    ck("no language-specific characters in the engine", not offenders,
       str(offenders))

    # Dropping scan.py from the list above must not lose coverage, so assert the
    # scanner actually fires on a planted violation.
    planted = _lexical_probe()
    ck("the share scan detects a lexical pattern planted in the engine",
       planted, "scan.py::_lexical_findings did not flag it")

    sig_text = analyze.SIGNALS_PATH.read_text(encoding="utf-8")
    ck("signals.json is language-independent", not cjk.search(sig_text),
       "".join(sorted(set(cjk.findall(sig_text)))[:12]))

    # 2. signals.json must carry no lexical sections at all — they moved to packs,
    #    and a stray one would be applied to every language.
    sig = analyze.load_signals()
    lexical_keys = [k for k in ("askKinds", "riskTags", "openerShapes", "scene",
                                "bots") if k in sig]
    ck("signals.json holds no lexical sections", not lexical_keys, str(lexical_keys))
    ck("signals.json holds the shared thresholds",
       bool(sig.get("thresholds", {}).get("propensity")),
       str(list(sig.get("thresholds", {}))))

    # 3. The published templates must not hardcode one language's examples either.
    tmpl_offenders = {}
    for tmpl in ("persona/SKILL.md", "persona/scripts/persona.py"):
        src = (repo_dir / "templates" / tmpl).read_text(encoding="utf-8")
        hits = sorted(set(cjk.findall(src)))
        if hits:
            tmpl_offenders[tmpl] = "".join(hits[:12])
    ck("no language-specific characters in the templates", not tmpl_offenders,
       str(tmpl_offenders))

    # 4. No single tenant's vocabulary anywhere, including in the packs. Terms are
    #    assembled from fragments so this list is not itself a match when the
    #    repo scan reads selftest.py.
    blob = "\n".join(
        [sig_text]
        + [(forge_dir / n).read_text(encoding="utf-8") for n in ENGINE_FILES]
        + [pth.read_text(encoding="utf-8")
           for pth in (forge_dir / "locales").glob("*.json")]
        + [(forge_dir / "sources" / n).read_text(encoding="utf-8")
           for n in ("__init__.py", "dws.py", "jsonl.py")]
        + [(repo_dir / "templates" / tm).read_text(encoding="utf-8")
           for tm in ("persona/SKILL.md", "persona/scripts/persona.py")])
    tenant_terms = ["\u5c0f" + "\u871c", "\u4e91" + "\u77e5\u9053", "ao" + "ne",
                    "\u5c0f" + "\u609f\u7a7a", "\u5185" + "\u5916",
                    "\u5206\u949f" + "\u770b\u61c2", "\u7559\u75d5" + "\u4e86\u5417",
                    "\u60f3" + "\u4e0a\u5206", "mule" + "run", "jj" + "dd",
                    "\u5343" + "\u95ee"]
    leaked = [t for t in tenant_terms if t.lower() in blob.lower()]
    ck("no tenant-specific vocabulary anywhere in the distribution",
       not leaked, f"found {leaked}")

    # A stopword list must cover the same gram lengths the miner emits. In a script
    # without word separators the miner slides 2/3/4-character windows, so a list
    # of only single characters filters nothing it produces and the published
    # phrase list fills with grammatical glue. This was wrong in every earlier
    # version — the original built its set with `.split()` on a string containing
    # no spaces, which yielded one 70-character "word" and therefore zero
    # filtering — so it is asserted rather than assumed.
    for pid in locale_mod.available():
        pk, _ = locale_mod.load(pid)
        if pk.word_boundaries or not pk.stopwords:
            continue
        lengths = {len(w) for w in pk.stopwords}
        ck(f"pack '{pid}' stopwords cover the mined gram lengths",
           bool(lengths & {2, 3, 4}),
           f"only lengths {sorted(lengths)} — the miner emits 2/3/4-grams")
        # Spot-check the function words that dominate an unfiltered ranking.
        glue = [chr(0x8fd9) + chr(0x4e2a),      # "this"
                chr(0x5c31) + chr(0x662f),      # "is exactly"
                chr(0x7136) + chr(0x540e),      # "and then"
                chr(0x6211) + chr(0x4eec)]      # "we"
        missed = [g for g in glue if g not in pk.stopwords]
        ck(f"pack '{pid}' filters common function words", not missed,
           f"{len(missed)} of {len(glue)} not filtered")
        # An entry longer than the widest mined gram can never match anything, so
        # it is almost always two words that lost the space between them.
        overlong = [w for w in pk.stopwords if len(w) > 4]
        ck(f"pack '{pid}' has no unmatchable stopword", not overlong,
           str(overlong[:5]))

    ck("locale packs document the generic-only rule",
       "GENERIC ONLY" in (forge_dir / "locales" / "zh-CN.json").read_text(encoding="utf-8"))

    # 5. Every shipped pack must define the full section set. A pack missing one
    #    silently disables that measurement, which is acceptable for a
    #    third-party pack but not for one the forge distributes.
    for pid in locale_mod.available():
        pk, _ = locale_mod.load(pid)
        ck(f"shipped pack '{pid}' is complete", not pk.missing(),
           str(pk.missing()))
        ck(f"shipped pack '{pid}' declares its scripts", bool(pk.scripts),
           str(pk.scripts))

    # 6. Every pack must agree on the KEYS, since the engine and the composer's
    #    label maps are keyed on them. Differing patterns are the point; differing
    #    keys mean one language silently loses a whole ask kind or risk class.
    key_sets = {}
    for pid in locale_mod.available():
        pk, _ = locale_mod.load(pid)
        key_sets[pid] = (tuple(k for k, _ in pk.ask_kinds),
                         tuple(k for k, _ in pk.risk_tags),
                         tuple(k for k, _ in pk.openers))
    distinct = set(key_sets.values())
    ck("all shipped packs use the same taxonomy keys", len(distinct) <= 1,
       str({k: v[0] for k, v in key_sets.items()}) if len(distinct) > 1 else
       f"{len(key_sets)} packs agree")
    for pid, (kinds, risks, _) in key_sets.items():
        ck(f"pack '{pid}' covers every risk class",
           set(risks) == set(decide._ALL_RISK_TAGS),
           str(set(decide._ALL_RISK_TAGS) - set(risks)))
        ck(f"pack '{pid}' covers every labelled ask kind",
           set(kinds) <= set(compose.ASK_KIND_LABEL),
           str(set(kinds) - set(compose.ASK_KIND_LABEL)))

    # 7. The null pack is a real, usable object — not an error state.
    ck("null pack answers every capability question",
       all(locale_mod.NULL_PACK.has(s) is False
           for s in locale_mod.LocalePack.SECTIONS))
    ck("null pack is detected as null", locale_mod.NULL_PACK.is_null)
    ck("null pack reports everything as missing",
       set(locale_mod.NULL_PACK.missing()) == set(locale_mod.LocalePack.SECTIONS))
    ck("unknown locale id degrades to the null pack rather than raising",
       locale_mod.load("kl-KL")[0].is_null,
       locale_mod.load("kl-KL")[1].get("reason", ""))

    # 8. Script detection must be right about the obvious cases, since a wrong
    #    verdict silently selects a pack that measures almost nothing.
    ck("script mix detects Han",
       locale_mod.script_mix(["\u8fd9\u4e2a\u5206\u652f"]).get("Han") == 100.0)
    ck("script mix detects Latin",
       locale_mod.script_mix(["can this branch"]).get("Latin") == 100.0)
    ck("script mix ignores punctuation and digits",
       locale_mod.script_mix(["ok!! 123 ..."]).get("Latin") == 100.0)
    ck("script mix is empty for unscripted text",
       locale_mod.script_mix(["123 !!! ???"]) == {})

    # A sliding window emits every PREFIX of a phrase, and a prefix always occurs
    # on at least as many days as the whole phrase — so ranking by day count alone
    # keeps the truncation and then discards the real word as redundant. The
    # published list then reports fragments rather than vocabulary.
    def _days(n):
        return set(range(n))

    fam = {
        chr(0x662f) + chr(0x4e0d): _days(112),               # prefix of the below
        chr(0x662f) + chr(0x4e0d) + chr(0x662f): _days(99),  # the actual phrase
        chr(0x6211) + chr(0x611f): _days(89),                # prefix, identical days
        chr(0x6211) + chr(0x611f) + chr(0x89c9): _days(89),  # the actual phrase
        chr(0x4eca) + chr(0x5929): _days(123),               # a word in its own right
    }
    kept = analyze._prefer_longest(fam)
    ck("a truncated prefix is replaced by the whole phrase",
       chr(0x662f) + chr(0x4e0d) not in kept
       and chr(0x662f) + chr(0x4e0d) + chr(0x662f) in kept, str(sorted(kept)))
    ck("a prefix occurring on identical days is always a fragment",
       chr(0x6211) + chr(0x611f) not in kept, str(sorted(kept)))
    ck("a standalone word is not collapsed into a longer one",
       chr(0x4eca) + chr(0x5929) in kept, str(sorted(kept)))

    # This collapse runs over EVERY mined gram, and the obvious implementation
    # (compare each candidate with every other) is quadratic: a six-figure corpus
    # yields ~200k candidates, which stalls the build rather than failing it —
    # the worst shape of bug, since it looks like a slow machine. The guard is a
    # synthetic vocabulary far larger than any real one, with a wall-clock bound.
    import time as _t
    # Distinct grams, sized like a real six-figure corpus (~200k candidates).
    big = {}
    span = 0x4e00
    for i in range(60000):
        a = chr(span + i % 2000)
        b = chr(span + (i // 2000) % 2000)
        big[a + b] = _days(5 + i % 40)
        big[a + b + chr(span + (i * 31) % 2000)] = _days(4 + i % 30)
    t0 = _t.time()
    analyze._prefer_longest(big)
    elapsed = _t.time() - t0
    ck("prefix collapse stays linear on a large vocabulary",
       elapsed < 5.0, f"{len(big)} grams in {elapsed:.2f}s")

    # The asymmetry that makes detection honest. CJK work chat is full of Latin
    # identifiers, so a raw codepoint majority of Latin does NOT mean the corpus is
    # English — while English prose never contains runs of Han. Getting this
    # backwards silently selects a pack that measures almost nothing, and reports
    # high confidence while doing it.
    def _detect_texts(texts):
        """detect() against an in-memory sample, so the asymmetry can be tested
        without building a whole corpus per case."""
        rows = [{"clean_text": x} for x in texts]

        class _Cursor:
            def fetchall(self):
                return rows

        class _FakeConn:
            def execute(self, *_a):
                return _Cursor()

        return locale_mod.detect(_FakeConn())

    # Proportioned like real bilingual technical chat: Chinese sentences carrying
    # the meaning, with English identifiers and tool names embedded throughout.
    # Latin still wins on raw codepoints, which is exactly the trap.
    han_prose = [
        "\u8fd9\u4e2a\u5206\u652f\u80fd\u76f4\u63a5\u5408 main \u5417"
        " gitlab pipeline \u8dd1\u5b8c\u4e86\u6ca1",
        "\u62a5\u9519\u4e86\u4f60\u770b\u4e0b\u4ec0\u4e48\u539f\u56e0"
        " staging \u73af\u5883 rollback \u4e86\u4e00\u4e0b",
        "\u6211\u7684\u987e\u8651\u662f\u56de\u5f52\u6210\u672c\u6bd4\u8f83\u5927"
        " deploy \u524d\u5148 review \u4e00\u4e0b",
    ] * 200
    v = _detect_texts(han_prose)
    ck("a CJK corpus full of Latin identifiers still selects the CJK pack",
       v["localeId"] == "zh-CN", f"{v['localeId']} · {v['scriptMix']}")
    ck("the weighted verdict explains itself",
       v.get("selection") == "weighted" and "identifiers" in v["reason"],
       v["reason"][:100])

    v2 = _detect_texts(["can this branch go straight into main, i think so"] * 400)
    ck("a purely Latin corpus selects the Latin pack", v2["localeId"] == "en",
       f"{v2['localeId']} · {v2['scriptMix']}")

    # A tiny sample must not produce a confident verdict, however one-sided.
    v3 = _detect_texts(["ok sounds good"])
    ck("a thin sample is reported as low confidence, not certainty",
       v3["localeId"] is None or v3["confidence"] < locale_mod._MIN_CONFIDENCE,
       f"{v3['localeId']} conf={v3['confidence']}")

    # No pack for the script → decline and say why, never fall back to a pack that
    # cannot read the corpus.
    v4 = _detect_texts(["\u0623\u0631\u064a\u062f \u0645\u0631\u0627\u062c\u0639\u0629 \u0647\u0630\u0627"] * 400)
    ck("an unsupported script declines rather than guessing",
       v4["localeId"] is None and "no locale pack" in v4["reason"],
       v4["reason"][:90])

    # 9. Locale overrides: an operator extends a pack without touching the forge.
    with tempfile.TemporaryDirectory() as tmp_loc:
        root = Path(tmp_loc)
        base, _ = locale_mod.load("zh-CN")
        org_bot = "\u6cdb\u4f8b" + "\u5185\u7f51\u901a"
        org_bot2 = "\u6cdb\u4f8b" + "\u5c0f\u52a9"
        ck("generic pattern does not match an org-specific bot",
           not base.bot_name.search(org_bot))
        C.write_json(root / locale_mod.LOCAL_EXTRA_FILE,
                     {"botNames": [org_bot, org_bot2],
                      "placeholders": [r"\[our-form\]"]})
        ext, _ = locale_mod.load("zh-CN", root)
        ck("local additions extend the bot pattern",
           bool(ext.bot_name.search(org_bot)))
        ck("local additions are reported",
           ext.local_additions.get("botNames") and len(ext.local_additions["botNames"]) == 2,
           str(ext.local_additions))
        ck("local additions change the pack stamp",
           ext.stamp() != base.stamp(), f"{base.stamp()} vs {ext.stamp()}")
        ck("generic patterns still work after extension",
           bool(ext.bot_name.search("build-bot")) or bool(
               ext.bot_name.search(ZH.expect["genericBotName"])))
        ck("operator placeholders are honored",
           locale_mod.extra_placeholders(root, "zh-CN") == [r"\[our-form\]"])
        # Absent file must not break anything.
        ck("missing local override file is fine",
           locale_mod.load("zh-CN", root / "nope")[0].stamp() == base.stamp())

    # A fixture must be invented, not remembered. Writing one while looking at
    # real output carries a phrase across without anyone deciding to do it, and
    # afterwards the two are indistinguishable by reading. `forge scan --scope
    # fixtures` compares them against the operator's own corpus; this asserts the
    # check itself works, since it cannot run here (no corpus in the suite).
    probe = scan_mod.corpus_derived_fixtures(
        Path(analyze.__file__).parent.parent, Path("/nonexistent/none.db"))
    ck("the fixture-provenance scan reports honestly with no corpus",
       any(f["kind"] == "no_corpus" for f in probe), str(probe[:1]))
    ck("a distinctive phrase is treated as derived, a common one is not",
       scan_mod._FIXTURE_PHRASE_DISTINCTIVE > scan_mod._FIXTURE_PHRASE_MIN
       and scan_mod._FIXTURE_COMMON_ENOUGH > 1,
       f"min={scan_mod._FIXTURE_PHRASE_MIN} "
       f"distinctive={scan_mod._FIXTURE_PHRASE_DISTINCTIVE} "
       f"common={scan_mod._FIXTURE_COMMON_ENOUGH}")

    # --- the platform seam ------------------------------------------------
    ck("every source is registered and resolvable",
       all(sources_mod.get_source_class(k).KIND == k
           for k in sources_mod.available()), str(sources_mod.available()))
    ck("unknown source kind is refused, not defaulted",
       _raises(SystemExit, sources_mod.get_source_class, "nosuchplatform"))
    for kind in sources_mod.available():
        cls = sources_mod.get_source_class(kind)
        caps = cls.static_capabilities()
        ck(f"source '{kind}' declares capabilities without connecting",
           caps.get("kind") == kind and "send" in caps, str(caps))
        ck(f"source '{kind}' names its own id label", bool(cls.ID_LABEL),
           cls.ID_LABEL)
    dws_caps = sources_mod.get_source_class("dws").static_capabilities()
    ck("dws declares it can send", dws_caps["send"] is True)
    ck("dws declares an id pattern for the share scanner",
       bool(dws_caps["idPattern"]), str(dws_caps["idPattern"]))
    jsonl_caps = sources_mod.get_source_class("jsonl").static_capabilities()
    ck("an offline export declares it cannot send",
       jsonl_caps["send"] is False and jsonl_caps["read"] is True)
    ck("optional capabilities refuse loudly rather than returning empty",
       _raises(sources_mod.Unsupported,
               sources_mod.BaseSource().send, {"user": "x"}, "hi"))

    # --- the jsonl source, through the REAL ingest path --------------------
    # This is what proves the platform seam is a seam and not a description. It
    # runs ingest.pull end to end with no network, no credentials and no DWS
    # binary, which also means every future platform assumption that creeps back
    # into the engine fails here rather than on a stranger's machine.
    with tempfile.TemporaryDirectory() as tmp_js:
        root = Path(tmp_js) / "data"
        C.secure_mkdir(root)
        export = Path(tmp_js) / "export"
        export.mkdir()
        recs = []
        for mid, conv, sender, name, at, text in EN._messages:
            recs.append(json.dumps({
                "messageId": mid, "conversationId": conv,
                "conversationTitle": (EN.direct_title if conv == "conv-direct"
                                      else EN.group_title),
                "singleChat": conv == "conv-direct", "senderId": sender,
                "senderName": name, "createdAt": at.replace(" ", "T"),
                "msgType": "text", "text": text}, ensure_ascii=False))
        # A malformed line and a blank one: a large export with a few bad rows
        # must still import, and the count must be reported rather than silent.
        recs.insert(3, "{not json at all")
        recs.insert(6, "")
        (export / "part1.jsonl").write_text("\n".join(recs) + "\n", encoding="utf-8")

        cfg_path = root / "persona-config.json"
        js_cfg = {
            "configVersion": 3, "profileSlug": "user-jsonl",
            "displayName": EN.display_name, "dataRoot": str(root),
            "skillRoots": [str(root / "skills" / "user-jsonl-persona")],
            "analysisStart": "2026-03-01",
            "source": {"kind": "jsonl", "options": {
                "path": str(export),
                "identity": {"userId": SELF_ID, "name": EN.self_name,
                             "openIds": [SELF_ID],
                             "aliases": sorted(EN.aliases)}}},
            "locale": {"id": "en"},
            "database": {"path": str(root / "database" / "persona.db")},
            "autonomy": {"scope": "draft_only", "allowlist": [],
                         "maxCodepoints": 300},
                "_path": str(cfg_path),
        }
        C.save_config(js_cfg)

        src = sources_mod.open_source(js_cfg)
        ck("jsonl source reports its identity from config",
           src.identity()["openIds"] == [SELF_ID], str(src.identity()))
        ck("jsonl source rebuilds a directory from the messages",
           {c["conversationId"] for c in src.conversations()}
           == {"conv-direct", "conv-group"},
           str([c["conversationId"] for c in src.conversations()]))
        ck("jsonl source normalizes an ISO timestamp",
           all(" " in m["createdAt"] and "T" not in m["createdAt"]
               for m in src.messages("2026-03-01 00:00:00", "2026-04-01 00:00:00")))

        pulled = ingest.pull(js_cfg, sources_mod.open_source(js_cfg), since=None)
        ck("jsonl pull inserted messages", pulled["inserted"] == len(EN._messages),
           f"{pulled['inserted']} of {len(EN._messages)}")
        ck("jsonl pull reports malformed lines rather than hiding them",
           pulled.get("sourceStats", {}).get("malformedLines") == 1,
           str(pulled.get("sourceStats")))
        ck("jsonl pull reports the absent mention endpoint",
           pulled["mentionEndpoint"] is False and pulled["mentionsMarked"] == 0)
        ck("jsonl pull completed without a network call", pulled["complete"] is True)
        ck("a clean jsonl pull reports no undated rows",
           pulled.get("sourceStats", {}).get("undatedLines") == 0,
           str(pulled.get("sourceStats")))

        # --- an export whose timestamps are unreadable ------------------------
        #
        # The most likely first mistake a new operator makes: the wrong key
        # (`timestamp`), or the right key holding a unix epoch. Both were silently
        # skipped, so a 900-line export imported as ZERO messages while reporting
        # malformedLines 0 and complete true. That is precisely the shape this forge
        # refuses elsewhere (the unread-conversations poller) and it has to be
        # refused on our own on-ramp too — this is where most people start.
        bad_dir = root / "export-undated"
        bad_dir.mkdir(parents=True, exist_ok=True)
        (bad_dir / "bad.jsonl").write_text("\n".join(json.dumps(r) for r in [
            {"messageId": "u1", "conversationId": "c", "senderId": SELF_ID,
             "senderName": EN.self_name, "text": "epoch millis",
             "createdAt": 1774000000000},
            {"messageId": "u2", "conversationId": "c", "senderId": SELF_ID,
             "senderName": EN.self_name, "text": "wrong key",
             "timestamp": "2026-03-05 10:00:00"},
            {"messageId": "u3", "conversationId": "c", "senderId": SELF_ID,
             "senderName": EN.self_name, "text": "no date at all"},
        ]) + "\n", encoding="utf-8")
        bad_cfg = {**js_cfg, "source": {"kind": "jsonl", "options": {
            **js_cfg["source"]["options"], "path": str(bad_dir)}}}
        bad_src = sources_mod.open_source(bad_cfg)
        list(bad_src.messages("2026-01-01 00:00:00", "2027-01-01 00:00:00"))
        bad_stats = bad_src.stats()
        ck("an epoch-number timestamp is rejected, not stringified",
           sources_jsonl._norm_ts(1774000000000) == "",
           repr(sources_jsonl._norm_ts(1774000000000)))
        ck("undated rows are counted, not silently skipped",
           bad_stats["undatedLines"] == 3, str(bad_stats))
        ck("undated rows name the line to fix",
           all(":" in w for w in bad_stats["undatedAt"]) and bad_stats["undatedAt"],
           str(bad_stats["undatedAt"]))
        ck("undated rows carry a hint naming the field and the unit problem",
           "createdAt" in bad_stats.get("undatedHint", ""),
           bad_stats.get("undatedHint", "")[:60])
        bad_pull = ingest.pull(bad_cfg, sources_mod.open_source(bad_cfg), since=None)
        # The verdict, not just the diagnostics: an import that used nothing it read
        # must never come back `complete`, or nobody goes looking at the stats above.
        ck("a pull that could not use its input is NOT complete",
           bad_pull["complete"] is False and bad_pull["inserted"] == 0,
           f"complete={bad_pull['complete']} inserted={bad_pull['inserted']}")
        ck("an unusable pull says so in its note",
           "timestamp" in bad_pull["note"], bad_pull["note"][:80])
        ck("a valid wall-clock timestamp still parses",
           sources_jsonl._norm_ts("2026-03-05T10:00:00+08:00") == "2026-03-05 10:00:00",
           sources_jsonl._norm_ts("2026-03-05T10:00:00+08:00"))

        # Incremental: re-pulling the same export must add nothing.
        again = ingest.pull(js_cfg, sources_mod.open_source(js_cfg), since="auto")
        ck("jsonl re-pull is idempotent", again["inserted"] == 0,
           str(again["inserted"]))

        js_features = build_mod.build(js_cfg)
        ck("jsonl corpus builds", js_features["style"]["overall"]["messages"] > 0,
           str(js_features["style"]["overall"]["messages"]))
        ck("jsonl build records its source",
           js_features["meta"]["source"] == "jsonl")
        ck("jsonl build detects the english pack",
           (js_features["meta"]["locale"] or {}).get("id") == "en",
           str((js_features["meta"]["locale"] or {}).get("id")))
        # @-mentions must still be found from the text, since this source has no
        # endpoint for them — otherwise every group message aimed at the owner
        # would be dropped from the corpus's decision evidence.
        ck("jsonl @-mention detected from text alone",
           js_features["meta"]["pairs"]["turns"] > 0
           and any(EN.expect["mentionReply"] in e["reply"]
                   for exs in js_features["examples"].values() for e in exs),
           str(js_features["meta"]["pairs"]))

        publish_mod.publish(js_cfg, js_features)
        js_persona = C.expand(js_cfg["skillRoots"][0])
        js_people = (js_persona / "references" / "people.md").read_text(encoding="utf-8")
        ck("published people.md uses the source's own id label",
           "user id" in js_people and "openDingTalkId" not in js_people)
        js_fid = (js_persona / "references" / "fidelity.md").read_text(encoding="utf-8")
        ck("fidelity report names the jsonl source", "jsonl" in js_fid)
        ck("fidelity report warns that this source cannot send",
           "Sending is not possible" in js_fid, js_fid[:0])
        js_limits = (js_persona / "references" / "limits.md").read_text(encoding="utf-8")
        # A build that mined ZERO asks must never grade as covered. The decision
        # coverage flags say "this locale HAS an ask lexicon", which is a
        # capability, not evidence — read as evidence they graded an empty
        # decision layer an A ("Every layer has evidence behind it") on a corpus
        # whose import had silently collapsed every 1:1 into a group.
        empty_cov = report_mod.coverage(
            {**js_features,
             "decisions": {**js_features["decisions"], "asksAnalyzed": 0,
                           "replyPropensity": {}, "riskBehavior": {},
                           "escapeHatches": {}},
             "meta": {**js_features["meta"], "pairs": {"turns": 0, "asks": 0}}},
            js_cfg)
        empty_grade, empty_note = report_mod._grade(empty_cov)
        ck("a build with zero mined asks grades D, not A",
           empty_grade == "D", empty_grade)
        ck("the zero-ask grade note names the import as the likely cause",
           "singleChat" in empty_note or "identity" in empty_note, empty_note[:80])
        for layer in ("ask_kinds", "risk_classes", "reply_shapes"):
            ck(f"zero mined asks marks {layer} unmeasured",
               not empty_cov["layers"][layer]["measured"],
               json.dumps(empty_cov["layers"][layer], ensure_ascii=False))
        ck("a real build still measures the decision layers",
           all(report_mod.coverage(js_features, js_cfg)["layers"][l]["measured"]
               for l in ("ask_kinds", "risk_classes", "reply_shapes")))
        # ...and the operator must see it at `build` time, not only in a report
        # they may never open.
        warned = {w["code"] for w in cli._build_warnings(
            {**js_features,
             "decisions": {**js_features["decisions"], "asksAnalyzed": 0},
             "meta": {**js_features["meta"], "pairs": {"turns": 0}}})}
        ck("build warns about a degenerate no-asks/no-turns import",
           {"no_asks_mined", "no_turns_paired"} <= warned, str(sorted(warned)))
        ck("build does not warn on a healthy corpus",
           not cli._build_warnings(js_features),
           json.dumps(cli._build_warnings(js_features), ensure_ascii=False)[:200])
        ck("limits.md names the platform generically, not DingTalk",
           "DingTalk" not in js_limits, js_limits[:0])
        # The human label comes from the adapter class, not from config. Reading it
        # from config silently yielded "" and limits.md said only "work chat only".
        ck("limits.md names the actual platform",
           sources_mod.get_source_class("jsonl").PLATFORM_LABEL in js_limits,
           sources_mod.get_source_class("jsonl").PLATFORM_LABEL)
        ck("features record the platform label",
           js_features["meta"]["platform"] ==
           sources_mod.get_source_class("jsonl").PLATFORM_LABEL,
           repr(js_features["meta"]["platform"]))

        # The rubric is generated into the data root and must never be published:
        # it carries the expected replies, so an answering agent that can read it
        # is not being tested.
        held = report_mod.held_out_asks(js_cfg, limit=4)
        ck("held-out asks drawn for the blind test", len(held) >= 1, str(len(held)))
        rubric = report_mod.render_rubric(js_features, js_cfg, held)
        ck("rubric demands two independent agents",
           "must be different" in rubric or "two agents" in rubric.lower())
        ck("rubric weights decision fidelity highest",
           "Decision fidelity** | 40" in rubric)
        ck("rubric carries the answer key and says so",
           "answer key" in rubric.lower() and "Do not copy" in rubric)
        ck("rubric was not published into the skill",
           not (js_persona / "references" / "fidelity-rubric.md").exists())
        ck("published skill contains no answer key",
           not any("answer key" in fp.read_text(encoding="utf-8").lower()
                   for fp in (js_persona / "references").glob("*.md")))

        # `context` must degrade VISIBLY on a source with no live tail. The whole
        # point of the command is telling "this is current" from "this is all I
        # have"; a silent corpus fallback is the bug it exists to prevent.
        js_script = js_persona / "scripts" / "persona.py"
        ctx = subprocess.run(
            [sys.executable, str(js_script), "context",
             "--conversation-id", "conv-direct", "--single", "true",
             "--peer-open-id", PEER_ID, "--limit", "8"],
            capture_output=True, text=True, timeout=60)
        cj = json.loads(ctx.stdout or "{}")
        ck("context degrades to the corpus when the source has no live tail",
           cj.get("source") == "corpus" and bool(cj.get("degraded")),
           f"source={cj.get('source')} degraded={cj.get('degraded')}")
        ck("degraded context names the reason",
           "cannot read a live" in (cj.get("reason") or ""), cj.get("reason", "")[:90])
        ck("degraded context states its cutoff and warns it is not current",
           "corpusThrough" in cj and "NOT current" in (cj.get("warning") or ""),
           (cj.get("warning") or "")[:90])

        # `thread` is the corpus reader and must always disclose its cutoff —
        # returning stale history silently is how an agent reasons confidently
        # about yesterday's version of a conversation.
        th = subprocess.run([sys.executable, str(js_script), "thread",
                       "--conversation-id", "conv-direct", "--limit", "5"],
                      capture_output=True, text=True, timeout=60)
        tj = json.loads(th.stdout or "{}")
        ck("thread labels itself as corpus and reports its cutoff",
           tj.get("source") == "corpus" and "corpusThrough" in tj,
           str(list(tj)))
        ck("thread points at context for what was just said",
           "context" in (tj.get("warning") or ""), (tj.get("warning") or "")[:80])

        # --- the weak-model contract -------------------------------------
        # Everything below is one claim: a model that only follows SKILL.md, and
        # exercises no judgment beyond writing a sentence, must still be unable to
        # send something it should not. Each check is a decision that used to
        # depend on the reader being careful and now depends on a command.
        rules_path = js_persona / "references" / "rules.json"
        ck("rules.json is published", rules_path.exists())
        rj = json.loads(rules_path.read_text(encoding="utf-8")) if rules_path.exists() else {}

        # The invariant that keeps the two policy renderings honest: rules.json and
        # features.json must agree exactly. Two sources of truth for "may an agent
        # answer this" would drift, and the drift would be silent.
        want = {k: v.get("defaultAction")
                for k, v in (js_features["decisions"]["replyPropensity"]).items()
                if not k.startswith("_")}
        ck("rules.json policy matches features.json exactly",
           (rj.get("policy") or {}).get("byAskKind") == want,
           f"{(rj.get('policy') or {}).get('byAskKind')} != {want}")
        ck("rules.json defaults to draft for unknown ask kinds",
           (rj.get("policy") or {}).get("defaultAction") == "draft")
        ck("rules.json carries the patterns a script needs to classify",
           bool((rj.get("patterns") or {}).get("riskTags")) and
           bool((rj.get("patterns") or {}).get("askKinds")))
        ck("rules.json carries the numeric style targets",
           all((rj.get("style") or {}).get(k) is not None
               for k in ("medianCodepoints", "maxCodepoints", "joinedClausePct")),
           str(rj.get("style", {}).get("medianCodepoints")))

        def run_persona(*argv):
            r = subprocess.run([sys.executable, str(js_script), *argv],
                               capture_output=True, text=True, timeout=90)
            try:
                return json.loads(r.stdout or "{}")
            except json.JSONDecodeError:
                return {"_stdout": r.stdout[:200], "_stderr": r.stderr[:300]}

        # `brief` — one call that decides. The point is that a weak model does not
        # have to sequence anything or read a percentage table.
        br = run_persona("brief", "--conversation-id", "conv-direct",
                         "--single", "true", "--peer-open-id", PEER_ID)
        ck("brief returns a verdict", br.get("verdict") in
           ("reply", "draft", "handoff", "silent"), str(br.get("verdict")))
        ck("brief explains the verdict", bool(br.get("because")),
           str(br.get("because"))[:120])
        ck("brief classifies without the model", "askKind" in (br.get("classification") or {}),
           str(br.get("classification")))
        ck("brief resolves the recipient by id",
           (br.get("recipient") or {}).get("resolved") is True,
           str(br.get("recipient"))[:100])
        ck("brief scopes precedents to that person",
           EN.peer in (br.get("_precedentsNote") or ""), br.get("_precedentsNote", ""))
        ck("brief hands over the exact next commands", bool(br.get("nextSteps")),
           str(br.get("nextSteps"))[:100])
        # Fact leads must be topics, not window-shifts of one topic. A list of
        # overlapping fragments reports several unknowns where there is one, and a
        # weak model reads each `hits: 0` as "this is not in the corpus".
        lead_terms = [l["term"] for l in (br.get("factLeads") or [])]
        ck("fact leads contain no fragment of another lead",
           not any(a != b and a in b for a in lead_terms for b in lead_terms),
           str(lead_terms))
        # ...and none that are the same span seen through a shifted window, which
        # containment cannot detect.
        ck("fact leads are distinct topics, not shifted windows",
           not any(a != b and not a.isascii() and not b.isascii()
                   and len(set(a) & set(b)) >= max(2, min(len(a), len(b)) - 1)
                   for a in lead_terms for b in lead_terms),
           str(lead_terms))

        # An interjection is not a fact lead. It appears everywhere, supports
        # nothing, and its `hits > 0` invites a lookup that returns noise —
        # spending the one signal that means "this is checkable".
        ck("fact leads exclude interjections and repeated syllables",
           not any(len(set(term)) == 1 or len(set(term)) * 2 <= len(term)
                   for term in lead_terms),
           str(lead_terms))

        ck("brief publishes the numeric style targets",
           (br.get("styleTargets") or {}).get("medianCodepoints") is not None)

        # ★ An id that was asked for and not found must be REPORTED, not absorbed.
        #
        # `brief` still falls back to the newest incoming message — that is the
        # right default when no id was given at all. The failure this guards is the
        # other case: an id WAS given, it missed, and the payload looked exactly
        # like a successful brief about a different message. Measured on a real
        # corpus it happens whenever a caller passes an id from another namespace
        # (a platform's external id where the corpus keys on the host's own), and
        # the result is a confident verdict about the wrong thing with nothing
        # anywhere saying so.
        miss = run_persona("brief", "--conversation-id", "conv-direct",
                           "--single", "true", "--peer-open-id", PEER_ID,
                           "--message-id", "no-such-message-id")
        ck("brief flags a --message-id it could not find",
           (miss.get("answering") or {}).get("requestedMessageFound") is False,
           str(miss.get("answering"))[:160])
        ck("the miss is explained in words, not only as a flag",
           "no-such-message-id" in (miss.get("_targetWarning") or ""),
           str(miss.get("_targetWarning"))[:160])
        # A brief with no id given is a legitimate call and must stay silent about it,
        # or every normal brief would carry a warning nobody can act on.
        ck("a brief with no --message-id carries no target warning",
           "_targetWarning" not in br
           and "requestedMessageFound" not in (br.get("answering") or {}),
           str(br.get("answering"))[:120])
        # Degradation must be visible here too, since brief is now the entry point.
        ck("brief reports a degraded context on a source with no live tail",
           (br.get("context") or {}).get("source") == "corpus"
           and bool((br.get("context") or {}).get("degraded")),
           str(br.get("context"))[:120])

        # A decision request must be draft-only even for the closest recipient in
        # the widest scope — the rate says "they engage", not "an agent may answer".
        decide_msg = [m for m in EN._messages
                      if "budget" in m[5] or "approve" in m[5]]
        if decide_msg:
            br2 = run_persona("brief", "--conversation-id", "conv-direct",
                              "--single", "true", "--peer-open-id", PEER_ID,
                              "--message-id", decide_msg[0][0])
            ck("brief refuses to auto-answer a money/approval ask",
               br2.get("verdict") == "draft" and br2.get("mayAutoSend") is False,
               f"{br2.get('verdict')} · {str(br2.get('because'))[:110]}")

        # --- a burst is ONE thing to answer ----------------------------------        #
        # Chat splits a single thought across bubbles. `brief` used to classify only
        # the last one, so a run ending in a pleasantry was judged on the
        # pleasantry: the risk words sat in a bubble the gate never read, and a
        # signature request came back `reply` / `mayAutoSend: true`. Measured on a
        # real corpus, 3.0% of bursts hide a risk class this way, and the error
        # always points toward sending. These assert the fold and, just as
        # importantly, that it does not fire when the messages are unrelated.
        import importlib.util as _ilu2
        _pspec = _ilu2.spec_from_file_location("persona_pub", js_script)
        _pm = _ilu2.module_from_spec(_pspec)
        sys.modules["persona_pub"] = _pm
        _saved_argv = sys.argv
        sys.argv = ["persona.py"]
        try:
            _pspec.loader.exec_module(_pm)
        finally:
            sys.argv = _saved_argv

        def _ctx(*rows):
            """rows: (sender, isOwner, text, hh, mm) → the shape brief works on."""
            return [{"messageId": f"b{i}", "sender": s, "isOwner": o, "text": t,
                     "at": f"2026-03-05 {hh:02d}:{mm:02d}:00"}
                    for i, (s, o, t, hh, mm) in enumerate(rows)]

        b_rules = dict(rj)
        b_rules.setdefault("policy", {})
        ck("rules.json publishes the burst cutoff",
           isinstance((b_rules["policy"].get("burst") or {}).get("gapSeconds"), int),
           str(b_rules["policy"].get("burst")))

        RISKY, MIDDLE, TAIL = EN.expect["burstRisky"], EN.expect["burstMiddle"], EN.expect["burstTail"]
        run = _ctx((EN.self_name, True, EN.expect["directReply"], 9, 50),
                   (EN.peer, False, RISKY, 10, 0),
                   (EN.peer, False, MIDDLE, 10, 1),
                   (EN.peer, False, TAIL, 10, 2))
        folded = _pm._incoming_burst(run, run[-1], b_rules)
        ck("consecutive messages from one person fold into one unit",
           len(folded) == 3, str([x["text"] for x in folded]))
        ck("the fold stops at the owner's own message",
           all(not x["isOwner"] for x in folded))

        person_a = {"name": EN.peer, "personId": PEER_ID, "resolved": True,
                    "toneBand": "A", "sensitive": False,
                    "autoAnswer": "low-risk allowed"}
        c_fold = _pm._fold_classification(folded, b_rules)
        g_fold = _pm.decide_action(c_fold, person_a, b_rules)
        c_last = _pm.classify(TAIL, b_rules)
        g_last = _pm.decide_action(c_last, person_a, b_rules)
        # The regression itself: judging the tail alone was permissive, judging the
        # run is not. Asserted as a COMPARISON so it fails if either side drifts.
        ck("a risk in an earlier bubble is not lost",
           bool(set(c_fold["riskTags"]) - set(c_last["riskTags"])),
           f"fold={c_fold['riskTags']} lastOnly={c_last['riskTags']}")
        ck("folding a burst never loosens the verdict",
           not (g_fold["mayAutoSend"] and not g_last["mayAutoSend"]),
           f"fold={g_fold['verdict']}/{g_fold['mayAutoSend']} "
           f"last={g_last['verdict']}/{g_last['mayAutoSend']}")
        ck("a burst hiding an approval ask is draft-only",
           g_fold["verdict"] == "draft" and g_fold["mayAutoSend"] is False,
           f"{g_fold['verdict']} · {str(g_fold['because'])[:100]}")

        # respondingTo must look back from the START of the run. Looking back from
        # the last bubble just finds another bubble of the same run, which answers
        # "what was said just before" instead of "what is this replying to".
        first_of_run = folded[0]
        ck("the run's first message is the peer's, not the owner's",
           first_of_run["text"] == RISKY, first_of_run["text"][:40])
        ck("what precedes the run is the owner's own line",
           run[run.index(first_of_run) - 1]["isOwner"] is True)

        # Non-bursts must NOT fold, or two unrelated topics become one classification
        # and every reply drifts draft-only for reasons nobody can trace.
        far = _ctx((EN.peer, False, RISKY, 10, 0), (EN.peer, False, TAIL, 12, 0))
        ck("a long gap does not fold two separate topics",
           len(_pm._incoming_burst(far, far[-1], b_rules)) == 1,
           str([x["text"] for x in _pm._incoming_burst(far, far[-1], b_rules)]))
        other = _ctx((EN.peer, False, RISKY, 10, 0),
                     (EN.expect["secondPeer"], False, TAIL, 10, 1))
        ck("two different senders do not fold",
           len(_pm._incoming_burst(other, other[-1], b_rules)) == 1)
        lone = _ctx((EN.peer, False, TAIL, 10, 0))
        ck("a single message is unchanged by folding",
           _pm._fold_classification(_pm._incoming_burst(lone, lone[0], b_rules),
                                    b_rules)["askKind"]
           == _pm.classify(TAIL, b_rules)["askKind"])
        # The cap bounds how much text one verdict may rest on.
        capped = dict(b_rules)
        capped["policy"] = {**b_rules["policy"], "burst": {"gapSeconds": 300,
                                                           "maxMessages": 2}}
        many = _ctx(*[(EN.peer, False, f"line {i}", 10, i) for i in range(6)])
        ck("the burst cap is honored",
           len(_pm._incoming_burst(many, many[-1], capped)) == 2)

        # And through the real CLI, so the payload a weak model reads is checked too.
        br_burst = run_persona("brief", "--conversation-id", "conv-direct",
                               "--single", "true", "--peer-open-id", PEER_ID)
        ck("brief reports how many messages it is answering",
           isinstance((br_burst.get("answering") or {}).get("messageCount"), int),
           str((br_burst.get("answering") or {}).get("messageCount")))
        ck("brief keeps the last message separately addressable",
           "lastText" in (br_burst.get("answering") or {}),
           str(list((br_burst.get("answering") or {}).keys())))

        # --- cadence reaches the caller, and the old guess is gone -------------
        #
        # The forge briefly shipped "Reply once, to all of it" in this payload. It
        # was never measured, it was wrong for this corpus (42% of replies are
        # multi-message), and it would be wrong the other way for a non-splitter.
        # This asserts the number replaced it — and that the string never returns.
        st_targets = br_burst.get("styleTargets") or {}
        ck("brief publishes the measured message count per reply",
           isinstance(st_targets.get("medianBubbles"), int),
           str(st_targets.get("medianBubbles")))
        ck("brief publishes how often a reply is multi-message",
           isinstance(st_targets.get("multiBubblePct"), (int, float)),
           str(st_targets.get("multiBubblePct")))
        # The note has to INVERT on the number — a splitter and a non-splitter need
        # opposite instructions, so one fixed sentence would be wrong for one of
        # them. Assert the text tracks the measurement rather than just existing.
        note = (st_targets.get("_bubblesNote") or "").lower()
        pct = st_targets.get("multiBubblePct") or 0
        ck("the cadence note matches the measured direction",
           ("own short message" in note or "each in its own" in note) if pct >= 30
           else ("one" in note),
           f"{pct}% → {note[:80]}")
        # The fixture corpus is single-message throughout, so the SPLITTER branch
        # would never run here — and that is the branch the forge previously got
        # wrong, telling every caller to reply once whatever their real habit was.
        # Drive the helper directly with both shapes.
        _splitter = _pm._bubbles_note({"multiBubblePct": 45.0, "medianBubbles": 2})
        _single = _pm._bubbles_note({"multiBubblePct": 4.0, "medianBubbles": 1})
        _unknown = _pm._bubbles_note({})
        ck("a splitter is told to answer each point in its own message",
           "own short message" in _splitter, _splitter[:90])
        ck("a non-splitter is told to answer in one message",
           "normally answer in one" in _single, _single[:90])
        ck("the cadence instruction inverts on the measurement",
           _splitter != _single)
        ck("unmeasured cadence says so instead of guessing",
           "not measured" in _unknown, _unknown[:90])
        for _t in ("persona/scripts/persona.py", "persona/SKILL.md"):
            _src = (repo_dir / "templates" / _t).read_text(encoding="utf-8")
            ck(f"no unmeasured reply-once instruction in {_t}",
               "Reply once" not in _src and "Answer all of it once" not in _src,
               _t)
        ck("rules.json carries the cadence numbers scripts act on",
           isinstance((rj.get("style") or {}).get("medianBubbles"), int)
           and (rj.get("style") or {}).get("multiBubblePct") is not None,
           str({k: (rj.get("style") or {}).get(k)
                for k in ("medianBubbles", "multiBubblePct")}))
        # And the published prose has to state it, or a model reading only the
        # markdown (no brief) would still be guessing.
        _style_md = (js_persona / "references" / "style.md").read_text(encoding="utf-8")
        ck("style.md states the messages-per-reply habit",
           "Messages per reply" in _style_md, "not published")
        _people_md = (js_persona / "references" / "people.md").read_text(encoding="utf-8")
        ck("people.md points at the per-band cadence instead of assuming one",
           "Msgs/reply" in _people_md,
           "people.md does not reference the cadence column")

        # `facts` — the difference between "not in the corpus" and "I did not look".
        f_hit = run_persona("facts", "--query", "endpoint", "--k", "5")
        ck("facts finds real corpus evidence", f_hit.get("verdict") == "evidence",
           f"{f_hit.get('verdict')} hits={f_hit.get('totalHits')}")
        f_miss = run_persona("facts", "--query", "zzqqxx-not-in-corpus", "--k", "5")
        ck("facts reports an explicit miss rather than a plausible answer",
           f_miss.get("verdict") == "none" and f_miss.get("totalHits") == 0,
           str(f_miss.get("verdict")))
        # Partial support must not read as full support. A query is expanded into
        # several terms, and a hit on one is not evidence for the question: an
        # acronym appearing somewhere establishes nothing about a phrase built
        # around it, and a model told "grounded" will treat it as if it did.
        f_part = run_persona("facts", "--query", "endpoint quarterly zzqqxx", "--k", "5")
        if f_part.get("verdict") == "evidence":
            ck("facts flags partial corroboration instead of implying full support",
               f_part.get("partial") is True
               and "PARTIAL" in (f_part.get("guidance") or ""),
               f"corroborated={f_part.get('corroborated')} "
               f"notFound={f_part.get('notFound')}")
            ck("facts names which part of the query was NOT found",
               bool(f_part.get("notFound")), str(f_part.get("notFound")))

        ck("a facts miss tells the model not to invent",
           "invent" in (f_miss.get("guidance") or "").lower(),
           (f_miss.get("guidance") or "")[:90])
        ck("facts searches everyone's messages, not only the owner's",
           any(not h.get("bySelf") for h in (f_hit.get("hits") or [])),
           str([h.get("sender") for h in (f_hit.get("hits") or [])][:4]))

        # --- the third exit: ask WHICH thing is meant --------------------------
        #
        # `facts` used to offer two outcomes — use the fact, or say you don't know.
        # A real corpus has a third state it can already detect: the subject is
        # mentioned but the asked-about part is not. The honest move there is to
        # narrow the question down, in the owner's own mined words. Without this the
        # agent either hedges or goes quiet, and both read less like the person than
        # simply asking which one.
        mined_clarify = ((js_features["decisions"].get("escapeHatches") or {})
                         .get("clarify") or [])
        pub_clarify = (rj.get("escapeHatches") or {}).get("clarify")
        ck("rules.json publishes the mined clarify phrasings",
           isinstance(pub_clarify, list)
           and len(pub_clarify) == len(mined_clarify),
           f"published={pub_clarify} mined={[h['line'] for h in mined_clarify]}")
        ck("published clarify lines come from the corpus, not from a template",
           all(any(ln == h["line"] for h in mined_clarify) for ln in (pub_clarify or [])),
           str(pub_clarify))
        # brief must carry it, so the caller does not have to run `facts` first to
        # discover the option exists.
        ck("brief surfaces the clarify option",
           "clarifyOption" in br, str(list(br.keys()))[:120])
        ck("brief's clarify option matches what was published",
           (br.get("clarifyOption") or []) == (pub_clarify or []),
           f"{br.get('clarifyOption')} vs {pub_clarify}")
        # The note must state what was MEASURED, not cover both cases in one
        # sentence. A person with no such habit whose note opens "asking which one
        # is a move this person really makes" gets asked back in words they never
        # used, because a weaker model reads the first clause and stops.
        _cn = (br.get("_clarifyNote") or "")
        if pub_clarify:
            ck("with mined phrasings, the note offers the move",
               "really makes" in _cn, _cn[:90])
        else:
            ck("with no mined phrasing, the note denies the habit outright",
               "no evidence" in _cn and "really makes" not in _cn, _cn[:90])
        ck("the clarify note inverts on the measurement",
           _pm._clarify_note({"escapeHatches": {"clarify": ["which one"]}})
           != _pm._clarify_note({"escapeHatches": {"clarify": []}}))
        ck("an empty clarify list never reads as an available move",
           "no evidence" in _pm._clarify_note({"escapeHatches": {"clarify": []}}),
           _pm._clarify_note({"escapeHatches": {"clarify": []}})[:90])
        # And a partial lookup must point at it rather than only forbidding.
        if f_part.get("partial"):
            g = (f_part.get("guidance") or "")
            if pub_clarify:
                ck("a partial fact-check offers the clarify exit",
                   "clarifyOption" in g or f_part.get("clarifyOption"),
                   g[-110:])
                ck("the offered phrasings are the owner's own",
                   all(ln in (pub_clarify or [])
                       for ln in (f_part.get("clarifyOption") or [])),
                   str(f_part.get("clarifyOption")))
            else:
                # Nothing mined → nothing offered. The absence has to be stated, or
                # the caller fills it with a generic "could you clarify?" and the
                # agent becomes visibly chattier than the person.
                ck("with no mined phrasing, no clarify wording is invented",
                   not f_part.get("clarifyOption")
                   and "invent" in (f_part.get("_clarifyNote") or "").lower(),
                   str(f_part.get("_clarifyNote"))[:110])
        # The skill has to tell the reader the branch exists at all.
        js_skill_md = (js_persona / "SKILL.md").read_text(encoding="utf-8")
        ck("SKILL.md documents the partial/clarify branch",
           "partial: true" in js_skill_md and "clarifyOption" in js_skill_md,
           "third branch not documented")
        ck("SKILL.md forbids improvising a clarification when none was mined",
           "do not improvise a clarifying question" in js_skill_md.lower(),
           "missing the empty-list instruction")

        # `check` — the mechanical draft review.
        chk_ok = run_persona("check", "--text", "done, you can integrate now")
        ck("check passes an ordinary short draft",
           chk_ok.get("result") in ("pass", "warn"), str(chk_ok.get("result")))
        chk_risk = run_persona(
            "check", "--text", "approved, i promise we ship friday and the budget is fine")
        ck("check BLOCKS a draft that states a decision on a risk class",
           chk_risk.get("result") == "block",
           str([p.get("kind") for p in chk_risk.get("problems", [])]))
        chk_long = run_persona("check", "--text", "x" * 400)
        ck("check blocks an over-limit draft", chk_long.get("result") == "block",
           str([p.get("kind") for p in chk_long.get("problems", [])]))

        # ...and `send` must refuse the same text, so forgetting to run `check` is
        # not a way through. This is the gate that matters most for a weak model.
        snd = run_persona("send", "--conversation-id", "conv-direct", "--single", "true",
                          "--peer-open-id", PEER_ID, "--recipient", EN.peer,
                          "--text", "approved, i promise we ship friday", "--dry-run")
        ck("send refuses a risky draft even with --dry-run",
           snd.get("blocked") is True and "content review" in (snd.get("reason") or ""),
           str(snd.get("reason"))[:110])

        js_scan = scan_mod.scan("skill", js_persona)
        ck("jsonl-sourced skill passes the share scan", js_scan["safe"],
           json.dumps(js_scan["findings"][:4], ensure_ascii=False))

    # --- the vault source, through the REAL ingest path --------------------
    # Reads a corpus another application already collected (the MyContext desktop
    # app's SQLite vault) instead of pulling from a platform. Offline like the
    # jsonl path, so it belongs in the suite for the same reason: it proves the
    # projection is exercised by the same ingest code every other source uses.
    #
    # The vault here is synthesized from the fictional EN fixture against the
    # app's real column shape. Pointing the test at a real vault would put
    # somebody's messages in the repo, which `scan --scope repo` forbids.
    with tempfile.TemporaryDirectory() as tmp_v:
        root = Path(tmp_v) / "data"
        C.secure_mkdir(root)
        vault_path = Path(tmp_v) / "core.sqlite"
        vc = sqlite3.connect(vault_path)
        vc.executescript("""
            CREATE TABLE channel_self_identity(
              channel_id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
              open_ids_json TEXT NOT NULL, display_names_json TEXT NOT NULL,
              corp_id TEXT, corp_name TEXT, confirmed_at INTEGER);
            CREATE TABLE conversations(
              id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, external_id TEXT,
              type TEXT NOT NULL, title TEXT, member_count INTEGER,
              is_bot_channel INTEGER NOT NULL DEFAULT 0, last_message_at INTEGER);
            CREATE TABLE messages(
              id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, conversation_id TEXT,
              external_id TEXT, sender_external_id TEXT, sender_display_name TEXT,
              content_text TEXT, quoted_external_id TEXT, thread_id TEXT,
              sent_at INTEGER NOT NULL, is_self INTEGER, origin TEXT DEFAULT 'human');
            CREATE TABLE message_mentions(
              message_id TEXT NOT NULL, actor_external_id TEXT NOT NULL,
              is_self INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY(message_id, actor_external_id));
        """)
        vc.execute(
            "INSERT INTO channel_self_identity VALUES(?,?,?,?,?,?,?)",
            ("dingtalk", "staff-1",
             json.dumps([{"kind": "openDingTalkId", "value": SELF_ID}]),
             json.dumps(sorted(EN.aliases)), "corp-1", "Example Corp",
             1_700_000_000_000))
        vc.executemany("INSERT INTO conversations VALUES(?,?,?,?,?,?,?,?)", [
            ("conv-direct", "dingtalk", "ext-direct", "direct", EN.direct_title,
             2, 0, 0),
            ("conv-group", "dingtalk", "ext-group", "group", EN.group_title,
             5, 0, 0),
            # An alert room: the app flags these, and they must not reach the
            # corpus at all — an alert bot flattens active hours and fills
            # expertise with ops jargon.
            ("conv-bot", "dingtalk", "ext-bot", "group", EN.bot, 3, 1, 0),
        ])
        # `sent_at` is unix MILLISECONDS in the vault, rendered at a fixed offset.
        # The fixture's wall-clock strings are treated as +08:00 here so the
        # round-trip through the adapter is checked against a known answer.
        def _ms(at: str) -> int:
            naive = dt.datetime.strptime(at, "%Y-%m-%d %H:%M:%S")
            return int((naive - dt.datetime(1970, 1, 1)
                        - dt.timedelta(minutes=480)).total_seconds() * 1000)

        vault_rows = [
            (mid, "dingtalk", conv, f"ext-{mid}", sender, name, text, None, "",
             _ms(at), 1 if sender == SELF_ID else 0, "human")
            for mid, conv, sender, name, at, text in EN._messages]
        vc.executemany(
            "INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", vault_rows)
        # One row the app has NOT judged yet, and one the agent itself sent.
        vc.execute("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                   ("m-unjudged", "dingtalk", "conv-direct", "ext-unjudged",
                    SELF_ID, EN.self_name, "collected before identity was confirmed",
                    None, "", _ms("2026-03-06 09:00:00"), None, "human"))
        vc.execute("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                   ("m-agent", "dingtalk", "conv-direct", "ext-agent",
                    SELF_ID, EN.self_name, "sent by the agent, not the owner",
                    None, "", _ms("2026-03-06 09:05:00"), 1, "agent"))
        # A message in the alert room: dropped with its conversation, not orphaned.
        vc.execute("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                   ("m-bot", "dingtalk", "conv-bot", "ext-bot-1", "Dbot",
                    EN.bot, "CPU at 99 percent on host 12", None, "",
                    _ms("2026-03-06 09:10:00"), 0, "human"))
        # A structured @-mention: the app resolved it from the platform payload,
        # which is stronger evidence than matching a display name in text.
        mention_id = next(m[0] for m in EN._messages if m[1] == "conv-group"
                          and m[2] != SELF_ID)
        vc.execute("INSERT INTO message_mentions VALUES(?,?,?)",
                   (mention_id, SELF_ID, 1))
        vc.commit()
        vc.close()

        v_cfg_path = root / "persona-config.json"
        v_cfg = {
            "configVersion": 3, "profileSlug": "user-vault",
            "displayName": EN.display_name, "dataRoot": str(root),
            "skillRoots": [str(root / "skills" / "user-vault-persona")],
            "analysisStart": "2026-03-01", "timezoneOffset": "+08:00",
            "source": {"kind": "vault", "options": {"path": str(vault_path),
                                                    "channel_id": "dingtalk"}},
            "locale": {"id": "en"},
            "database": {"path": str(root / "database" / "persona.db")},
            "autonomy": {"scope": "draft_only", "allowlist": [],
                         "maxCodepoints": 300},
                "_path": str(v_cfg_path),
        }
        C.save_config(v_cfg)

        v_caps = sources_mod.get_source_class("vault").static_capabilities()
        # The app owns the channel session and its own send authorization. If this
        # adapter claimed `send`, the persona would reach for a `dws` on PATH that
        # is authenticated as somebody else.
        ck("vault declares it cannot send or tail",
           v_caps["send"] is False and v_caps["tail"] is False, str(v_caps))
        ck("vault declares a real mention endpoint", v_caps["mentions"] is True)
        # A local lookup must not inherit the paged-API clamp: a six-month vault
        # would otherwise lose every structured mention older than 30 days, which
        # understates how often the owner was actually asked in a group.
        ck("a local mention lookup declares no lookback limit",
           sources_mod.get_source_class("vault").MENTION_LOOKBACK_DAYS is None)
        ck("a paged mention endpoint keeps a lookback limit",
           sources_mod.get_source_class("dws").MENTION_LOOKBACK_DAYS == 30,
           str(sources_mod.get_source_class("dws").MENTION_LOOKBACK_DAYS))

        v_src = sources_mod.open_source(v_cfg)
        ck("vault source reads identity from the app's own table",
           v_src.identity()["openIds"] == [SELF_ID], str(v_src.identity()))
        ck("vault source takes every display name as a mention alias",
           set(v_src.identity()["aliases"]) == EN.aliases,
           str(v_src.identity()["aliases"]))
        # ms → wall clock at the configured offset, checked against the fixture's
        # own strings. A wrong offset shifts every active-hour bucket; reading the
        # process's zone would make the same corpus measure differently per machine.
        first_at = EN._messages[0][4]
        ck("vault renders millisecond timestamps at the configured offset",
           any(m["createdAt"] == first_at for m in
               v_src.messages("2026-03-01 00:00:00", "2026-04-01 00:00:00")),
           first_at)
        ck("vault excludes flagged alert rooms from the directory",
           {c["conversationId"] for c in v_src.conversations()}
           == {"conv-direct", "conv-group"},
           str([c["conversationId"] for c in v_src.conversations()]))
        # single_chat is the costliest field to get wrong: in a group only
        # @-mentions count as asks aimed at the owner, so collapsing 1:1s into
        # groups mines ZERO asks while the style layer still reports numbers.
        ck("vault maps the app's conversation type to single_chat",
           {c["conversationId"]: c["singleChat"] for c in v_src.conversations()}
           == {"conv-direct": True, "conv-group": False},
           str([(c["conversationId"], c["singleChat"])
                for c in v_src.conversations()]))
        ck("vault reports agent-sent ids from row provenance",
           v_src.agent_sent_ids() == {"m-agent"}, str(v_src.agent_sent_ids()))

        v_pulled = ingest.pull(v_cfg, sources_mod.open_source(v_cfg), since=None)
        ck("vault pull inserted the judged messages",
           v_pulled["inserted"] == len(EN._messages) + 1,
           f"{v_pulled['inserted']} of {len(EN._messages) + 1}")
        # ★ is_self IS NULL means "not judged yet", never "somebody else".
        # Coercing it to 0 would attribute the owner's own messages to another
        # person, and nothing downstream could tell them apart again.
        ck("vault excludes unjudged rows rather than attributing them",
           v_pulled["sourceStats"]["unjudgedRows"] == 1,
           str(v_pulled["sourceStats"]))
        ck("an unjudged row never lands in the corpus",
           not _corpus_has(v_cfg, "m-unjudged"))
        # And the verdict, not just the diagnostic: an unconfirmed corpus must not
        # look like a quiet person.
        ck("a pull with unjudged rows is NOT complete",
           v_pulled["complete"] is False, str(v_pulled["complete"]))
        ck("the note names the identity as the cause, not the timestamps",
           "is_self" in v_pulled["note"] and "timestamp" not in v_pulled["note"],
           v_pulled["note"][:100])
        ck("vault pull drops messages of a flagged alert room",
           not _corpus_has(v_cfg, "m-bot"))
        ck("vault pull marks mentions from the app's table",
           v_pulled["mentionsMarked"] >= 1 and v_pulled["mentionEndpoint"] is True,
           str(v_pulled["mentionsMarked"]))
        # `epoch` feeds every latency measurement; storing millis there is a silent
        # factor-of-1000 error that makes a person look like they never reply.
        ck("corpus epoch is seconds, not milliseconds",
           _corpus_epoch_is_seconds(v_cfg),
           str(_corpus_epoch_max(v_cfg)))

        v_again = ingest.pull(v_cfg, sources_mod.open_source(v_cfg), since="auto")
        ck("vault re-pull is idempotent", v_again["inserted"] == 0,
           str(v_again["inserted"]))

        # --- the picked distillation scope ---------------------------------
        # The app lets the user choose WHICH conversations to distill. Before
        # this option existed the choice was written to the app's config and
        # read by nobody: the corpus quietly contained every conversation, and
        # the only symptom was a profile built on threads the user had excluded.
        # An unrecognized option is the same failure with an extra step, because
        # `open_source(**options)` drops unknown keys into `**_ignored`.
        # ★ The scope is the PLATFORM's id (`external_id`), not the app's
        # internal primary key. Asserting with the internal key is what let the
        # first version pass while filtering the wrong column: on the real vault
        # it matched 0 of 39 conversations, and an empty match is not an error —
        # the pull just returned everything.
        v_scoped = dict(v_cfg)
        v_scoped["source"] = {"kind": "vault", "options": {
            "path": str(vault_path), "channel_id": "dingtalk",
            "conversationIds": ["ext-direct"]}}
        s_src = sources_mod.open_source(v_scoped)
        ck("the picked scope is honored, not swallowed by **_ignored",
           s_src.conversation_ids == ["ext-direct"],
           str(s_src.conversation_ids))
        # The internal key must NOT work: if it did, the column being filtered
        # is the wrong one and the real app's scope silently does nothing.
        v_internal = dict(v_cfg)
        v_internal["source"] = {"kind": "vault", "options": {
            "path": str(vault_path), "channel_id": "dingtalk",
            "conversationIds": ["conv-direct"]}}
        ck("★ the app's internal conversation key matches nothing (scope is external)",
           not list(sources_mod.open_source(v_internal)
                    .messages("2026-03-01 00:00:00", "2026-04-01 00:00:00")))
        ck("a scoped read yields only the picked conversations",
           {m["conversationId"] for m in
            s_src.messages("2026-03-01 00:00:00", "2026-04-01 00:00:00")}
           == {"conv-direct"},
           str({m["conversationId"] for m in
                s_src.messages("2026-03-01 00:00:00", "2026-04-01 00:00:00")}))
        # An out-of-scope thread must not appear in the directory either: it
        # would contribute no messages, and `people`/relations are built from
        # the directory.
        ck("a scoped directory omits the excluded conversations",
           {c["conversationId"] for c in s_src.conversations()} == {"conv-direct"},
           str([c["conversationId"] for c in s_src.conversations()]))
        # Mentions must agree with messages(). An id here whose message was
        # never yielded is an ask that cannot be shown as precedent.
        s_mentions = set(s_src.mentions("2026-03-01 00:00:00", "2026-04-01 00:00:00"))
        s_msg_ids = {m["messageId"] for m in
                     s_src.messages("2026-03-01 00:00:00", "2026-04-01 00:00:00")}
        ck("scoped mentions never name a message outside the scope",
           s_mentions <= s_msg_ids, str(s_mentions - s_msg_ids))
        # Thin-by-design must be distinguishable from thin-by-bug.
        ck("a scoped read reports the scope in its stats",
           s_src.stats().get("scopedConversations") == 1, str(s_src.stats()))
        # The exclusion set stays broad on purpose: a superset can only prevent
        # an agent reply from being read as the owner's own voice.
        ck("the agent-sent exclusion set is NOT narrowed by the scope",
           s_src.agent_sent_ids() == {"m-agent"}, str(s_src.agent_sent_ids()))
        # snake_case must work too: the option travels as a literal JSON key, and
        # accepting one spelling while ignoring the other is the original bug.
        v_snake = dict(v_cfg)
        v_snake["source"] = {"kind": "vault", "options": {
            "path": str(vault_path), "channel_id": "dingtalk",
            "conversation_ids": ["ext-group"]}}
        ck("both spellings of the scope option are accepted",
           sources_mod.open_source(v_snake).conversation_ids == ["ext-group"])
        # No scope must be byte-identical to the historical behavior.
        ck("an empty scope reads every non-bot conversation",
           {c["conversationId"] for c in
            sources_mod.open_source(v_cfg).conversations()}
           == {"conv-direct", "conv-group"})

        v_features = build_mod.build(v_cfg)
        ck("vault corpus builds",
           v_features["style"]["overall"]["messages"] > 0,
           str(v_features["style"]["overall"]["messages"]))
        ck("vault build records its source",
           v_features["meta"]["source"] == "vault")
        # The whole point of the decision layer: if single_chat or identity were
        # wrong this is 0 while style still reports numbers, so it is asserted
        # rather than eyeballed.
        ck("vault build mines asks and pairs turns",
           v_features["meta"]["pairs"]["asks"] > 0
           and v_features["meta"]["pairs"]["turns"] > 0,
           str(v_features["meta"]["pairs"]))
        ck("vault build does not warn about a degenerate import",
           not cli._build_warnings(v_features),
           json.dumps(cli._build_warnings(v_features), ensure_ascii=False)[:200])

        publish_mod.publish(v_cfg, v_features)
        v_persona = C.expand(v_cfg["skillRoots"][0])
        v_fid = (v_persona / "references" / "fidelity.md").read_text(encoding="utf-8")
        ck("fidelity report warns that the vault source cannot send",
           "Sending is not possible" in v_fid, v_fid[:0])

        # The persona skill is published in full regardless of the source's
        # capabilities: it is the one that does the deciding, and every gate it
        # applies works off the local corpus.
        ck("the persona skill is still published in full",
           (v_persona / "references" / "decisions.md").exists()
           and (v_persona / "references" / "rules.json").exists())

        # --- near-realtime reads, and the lag that must ship with them ---------
        #
        # A vault-backed profile has no live tail, but its store is refreshed by
        # the host on a short cycle, so it CAN answer "what was just said" — the
        # whole question is whether the reader knows how stale that answer is.
        v_src2 = sources_mod.open_source(v_cfg)
        ck("vault declares near-realtime reads, still not a live tail",
           v_src2.capabilities()["recentReads"] is True
           and v_src2.capabilities()["tail"] is False)
        recent = v_src2.recent_messages("conv-group", False, limit=5)
        ck("recent_messages returns the newest messages oldest→newest",
           len(recent["messages"]) > 0
           and recent["messages"] == sorted(recent["messages"],
                                            key=lambda m: m["createdAt"]),
           str(len(recent["messages"])))
        # ★ These two flags must stay distinct: a reply this tooling sent also
        # carries the owner's id, and conflating them makes a freshness check read
        # the agent's own message as "the owner already answered" — which
        # suppresses every follow-up after the first automated reply.
        ck("an agent-sent reply is flagged apart from the owner's own",
           all("isOwner" in m and "isAgentSent" in m for m in recent["messages"]),
           json.dumps(recent["messages"][:1], ensure_ascii=False)[:120])
        # ★ Unknown lag must be None, never 0. The synthetic vault has no cursor
        # row, which is exactly the "cannot say how far behind" case.
        ck("a store with no collection marker reports unknown lag, not zero",
           recent["lagSeconds"] is None, repr(recent["lagSeconds"]))

        # The threshold has to reach the installed skill, which cannot import the
        # forge — so it travels in rules.json like every other executable rule.
        v_rules = json.loads(
            (v_persona / "references" / "rules.json").read_text(encoding="utf-8"))
        ck("the freshness threshold is published for the skill to read",
           v_rules["policy"]["freshness"]["maxLagSeconds"] > 0,
           json.dumps(v_rules["policy"]["freshness"], ensure_ascii=False))
        ck("unknown lag is published as unsafe",
           v_rules["policy"]["freshness"]["unknownLagIsStale"] is True)
        # Changing a threshold has to invalidate derived numbers, or a rebuilt
        # skill would quietly disagree with the version stamped on it.
        ck("the signals version reflects the new threshold group",
           v_rules["rulesVersion"].startswith("signals-v5"),
           v_rules["rulesVersion"])

        v_scan = scan_mod.scan("skill", v_persona)
        ck("vault-sourced skill passes the share scan", v_scan["safe"],
           json.dumps(v_scan["findings"][:4], ensure_ascii=False))

        # --- where publish is allowed to write ---------------------------------
        #
        # An embedding application must not install into the operator's own agent
        # directories. That failure is invisible in the worst way: the skill works,
        # and quietly appears in an agent nobody meant to change — where
        # uninstalling the application will not remove it either.
        owned = {**v_cfg, "ownsOutput": True}
        for reserved in ("~/.claude/skills/x-persona", "~/.codex/skills/x-persona"):
            ck(f"an application may not publish into {reserved.split('/')[1]}",
               _raises(SystemExit, publish_mod.skill_roots,
                       {**owned, "skillRoots": [reserved]}),
               reserved)
        ck("the refusal names a directory the application owns instead",
           "user data" in _systemexit_message(
               publish_mod.skill_roots,
               {**owned, "skillRoots": ["~/.claude/skills/x-persona"]}))
        # A directory the caller owns is fine, including one inside the home dir.
        ck("an application may publish into its own data directory",
           len(publish_mod.skill_roots(
               {**owned, "skillRoots": [str(root / "skills" / "x-persona")]})) == 1)
        # And a person forging their own persona is unaffected — that is the
        # default, and installing into their own agents is the entire point.
        ck("a person publishing for themselves may still use ~/.claude",
           len(publish_mod.skill_roots(
               {**v_cfg, "skillRoots": ["~/.claude/skills/x-persona"]})) == 1)
        ck("the default config does not claim application ownership",
           cli.CONFIG_TEMPLATE["ownsOutput"] is False)

        # An unconfirmed vault must refuse at the identity boundary rather than
        # produce a persona built from nobody's messages.
        unconfirmed = Path(tmp_v) / "unconfirmed.sqlite"
        shutil.copyfile(vault_path, unconfirmed)
        uc = sqlite3.connect(unconfirmed)
        uc.execute("UPDATE channel_self_identity SET confirmed_at=NULL")
        uc.commit()
        uc.close()
        u_cfg = {**v_cfg, "source": {"kind": "vault", "options": {
            "path": str(unconfirmed), "channel_id": "dingtalk"}}}
        ck("an unconfirmed vault identity is refused, not guessed",
           _raises(SystemExit, lambda: sources_mod.open_source(u_cfg).identity()))
        ck("a vault with no identity row for the channel is refused",
           _raises(SystemExit, lambda: sources_mod.open_source(
               {**v_cfg, "source": {"kind": "vault", "options": {
                   "path": str(vault_path), "channel_id": "nosuchchannel"}}}
           ).identity()))
        # A bad offset must fail rather than default to UTC, which would shift
        # every timestamp by the operator's real offset and look like it worked.
        ck("an unreadable timezone offset is refused, not defaulted to UTC",
           _raises(SystemExit, sources_vault._offset_minutes, "eight hours"))
        ck("timezone offsets parse in both notations",
           sources_vault._offset_minutes("+08:00") == 480
           and sources_vault._offset_minutes("-0530") == -330,
           str([sources_vault._offset_minutes("+08:00"),
                sources_vault._offset_minutes("-0530")]))

    # --- the repo itself must stay shareable ------------------------------
    repo_scan = scan_mod.scan("repo")
    ck("repo has no personal data", repo_scan["safe"],
       json.dumps(repo_scan["findings"][:5], ensure_ascii=False))

    # --- DWS error handling is honest, not silently empty -----------------
    class FailingClient(DwsClient):
        """A client whose binary does not exist — bypasses _resolve on purpose."""

        def __init__(self):
            self.binary = "/nonexistent/dws"
            self.timeout, self.retries, self.backoff = 1, 1, 1.0
            self.log = None
            self.min_interval = self._pace = 0.0
            self._last_call = 0.0
            self.calls = self.failures = self.throttled = 0

    r = FailingClient().call(["chat", "list-all-conversations"])
    ck("failed dws call reports ok=False", r.ok is False)
    ck("failed dws call carries the error", bool(r.error), r.error[:80])
    ck("DwsResult.result is None when failed", r.result is None)

    # The send gate must live in the runtime, not only in persona.py. Anything
    # that imports the runtime directly would otherwise message the owner's
    # colleagues with no scope check and no ledger entry — which also poisons the
    # next distillation, since the agent's own words come back as the owner's.
    fc = FailingClient()
    # Supplied to every recipient/scope case below, because the CONTENT gate runs
    # first and would otherwise be the thing refusing — masking whether the check
    # under test works at all.
    RP = {"approval": r"approv|sign[- ]?off", "money": r"\$\d",
          "commitment": r"promise|guarantee"}
    r = fc.send({"open-dingtalk-id": "Dsomeone"}, "hi")
    ck("runtime send refuses without a config", not r.ok and "autonomy config" in r.error,
       r.error[:90])
    r = fc.send({"open-dingtalk-id": "Dsomeone"}, "hi",
                cfg={"autonomy": {"scope": "draft_only"}, "riskPatterns": RP})
    ck("runtime send enforces draft_only", not r.ok and "draft_only" in r.error,
       r.error[:80])
    r = fc.send({"group": "cidX"}, "hi",
                cfg={"autonomy": {"scope": "everyone"}, "riskPatterns": RP})
    ck("runtime send refuses groups", not r.ok and "group" in r.error.lower(),
       r.error[:80])
    r = fc.send({"open-dingtalk-id": "Dstranger"}, "hi",
                cfg={"autonomy": {"scope": "allowlist", "allowlist": ["Dother"]},
                     "riskPatterns": RP})
    ck("runtime send enforces the allowlist", not r.ok and "allowlist" in r.error,
       r.error[:80])
    r = fc.send({"open-dingtalk-id": "Dok"}, "x" * 500,
                cfg={"autonomy": {"scope": "everyone", "maxCodepoints": 300},
                     "riskPatterns": RP})
    ck("runtime send enforces the length cap", not r.ok and "over the" in r.error,
       r.error[:80])

    # --- the content gate: fails closed, and runs BEFORE the scope check --------
    #
    # An EMPTY pattern mapping is as unverifiable as a missing one. A locale pack
    # that detects no risk classes publishes `{}`, and a truthiness bug there would
    # let every draft pass a check that never ran — while the report still claimed
    # the content was verified.
    danger = "Approved. I promise we ship Friday, budget signed off at $40k."
    for label, pats in (("missing", None), ("empty", {})):
        r = fc.send({"open-dingtalk-id": "Dok"}, danger,
                    cfg={"autonomy": {"scope": "everyone"}, "riskPatterns": pats})
        ck(f"content gate fails closed when riskPatterns is {label}",
           not r.ok and "cannot verify" in r.error, r.error[:80])
    r = fc.send({"open-dingtalk-id": "Dok"}, danger,
                cfg={"autonomy": {"scope": "everyone"}, "riskPatterns": RP})
    ck("content gate blocks a draft that states a decision",
       not r.ok and "the reply itself touches" in r.error, r.error[:80])
    # Ordering, asserted on the REASON rather than on the outcome: both orders
    # refuse, so only the message reveals which check fired. A draft stating an
    # approval is wrong in every scope, so leading with "sending is disabled" would
    # point at the scope as the obstacle and imply widening it is the fix.
    r = fc.send({"open-dingtalk-id": "Dok"}, danger,
                cfg={"autonomy": {"scope": "draft_only"}, "riskPatterns": RP})
    ck("content gate precedes the scope check",
       not r.ok and "touches" in r.error and "draft_only" not in r.error, r.error[:80])
    # ...but a harmless draft under draft_only must still cite the scope, or the
    # ordering above would just be hiding the scope check entirely.
    r = fc.send({"open-dingtalk-id": "Dok"}, "yeah that works",
                cfg={"autonomy": {"scope": "draft_only"}, "riskPatterns": RP})
    ck("a clean draft under draft_only still cites the scope",
       not r.ok and "draft_only" in r.error, r.error[:80])

    # A configured-but-missing binary must fail loudly. Silently falling back to
    # whatever `dws` is on PATH would report a healthy poller while reading the
    # wrong CLI — the exact class of failure this rebuild exists to remove.
    try:
        DwsClient(binary="/nonexistent/dws-broken")
        ck("explicit missing binary raises", False, "no error raised")
    except DwsError as e:
        ck("explicit missing binary raises", True, e.detail[:80])


def run(locale: str | None = None) -> dict:
    """Run the suite. `locale` limits it to one fixture; default runs all.

    The per-locale passes matter more than their count suggests. Running only the
    language the forge was written in cannot detect a lexical pattern that has
    crept back into the engine, nor a composer that renders a fabricated claim
    when a pack is absent — both of which are silent failures on someone else's
    machine and loud failures here.
    """
    results: list[dict] = []
    scope: list[str] = []

    def ck(name: str, ok: bool, detail: str = "") -> None:
        label = f"[{scope[-1]}] {name}" if scope else name
        results.append({"check": label, "ok": bool(ok), "detail": str(detail)[:200]})

    _global_suite(ck)

    wanted = [locale] if locale else list(FIXTURES)
    for locale_id in wanted:
        fx = FIXTURES.get(locale_id)
        if not fx:
            ck(f"unknown locale fixture {locale_id!r}", False,
               f"available: {', '.join(FIXTURES)}")
            continue
        scope.append(locale_id)
        try:
            _corpus_suite(fx, ck)
        finally:
            # Client furniture and operator placeholders are process-global; a
            # locale pass that left them registered would change what the next
            # pass considers analyzable, and the suite would stop being
            # order-independent.
            C.clear_placeholders()
            scope.pop()

    ok = all(x["ok"] for x in results)
    return {"suite": "forge-selftest",
            "locales": wanted,
            "checks": results,
            "passed": sum(1 for x in results if x["ok"]),
            "failed": [x["check"] for x in results if not x["ok"]],
            "ok": ok}
