#!/usr/bin/env python3
"""im-persona-forge CLI.

    python3 -m forge <command> [options]

    doctor      check the source, identity, corpus, skills — start here when broken
    init        create the data root and config (derives the slug from identity)
    pull        fetch messages into the local corpus (incremental by default)
    build       corpus → measured features (no network calls)
    publish     install the persona skill into every skill root
    refresh     pull → build → publish (the routine update)
    locales     installed locale packs, and which one fits this corpus
    sources     available message sources and what each one can do
    report      coverage report; --rubric writes the blind fidelity-test protocol
    autonomy    set the send scope and the allowlist
    lock        make installed skills read-only (no agent can edit them)
    export      bundle the skills for an agent on another machine
    inspect     what is in the corpus, and what was measured
    scan        share-safety check (repo / skill / data)
    selftest    offline regression, no network and no personal data

Every command prints JSON. Anything that writes or touches a remote accepts
--dry-run.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sqlite3
import sys
from pathlib import Path

from . import build as build_mod
from . import common as C
from . import ingest, locale as locale_mod, publish as publish_mod
from . import report as report_mod, scan as scan_mod, store
from . import sources as sources_mod
from .runtime import DwsClient, DwsError

REPO = Path(__file__).resolve().parent.parent
SCOPES = ("draft_only", "allowlist", "everyone")

CONFIG_TEMPLATE = {
    "configVersion": 3,
    "profileSlug": "",
    "displayName": "",
    "dataRoot": "",
    "skillRoots": [],
    "ownsOutput": False,
    "_ownsOutputHelp": "Set true when an application drives this forge on a user's "
                       "behalf. It makes `publish` refuse to write into ~/.claude, "
                       "~/.codex and friends: those belong to the person running "
                       "the machine, and a skill installed there survives "
                       "uninstalling the application. Leave false when a person "
                       "runs the forge for themselves — installing into their own "
                       "agents is the whole point.",
    "analysisStart": "",
    "externalSkillFiles": [],
    "_externalSkillFilesHelp": "Files inside the installed skill that the calling "
                               "application writes and owns, relative to the skill "
                               "root (e.g. \"references/work.md\"). `publish` never "
                               "generates them and never prunes them, and `lock` "
                               "leaves them writable. Only honored when ownsOutput "
                               "is true. Empty = use the built-in default list. "
                               "Without this a host-written file is deleted by the "
                               "next refresh as a stale leftover — silently, since "
                               "prune reports it as ordinary cleanup.",
    "measureWindowDays": 0,
    "_measureWindowDaysHelp": "Measure only the last N days of the corpus, counted "
                              "back from its newest message (never from now, which "
                              "would make the same corpus build differently every "
                              "day). 0 = measure everything. This is NOT "
                              "`pull --since`: that one decides what is collected, "
                              "this one only what a build looks at, so narrowing it "
                              "deletes nothing and widening it again is one flag. "
                              "Overridden per run by `build --window-days`.",
    "timezone": "",
    "_timezoneHelp": "IANA name, informational only. Timestamps are stored in this "
                     "machine's local wall-clock time; leave empty to accept that.",
    "source": {
        "_help": "Where messages come from. kind: dws (DingTalk via the dws CLI) "
                 "| jsonl (a normalized export from any platform — see "
                 "forge/sources/jsonl.py for the schema and required identity). "
                 "Run `python3 -m forge sources` to list what is available.",
        "kind": "dws",
        "options": {},
    },
    "locale": {
        "_help": "Which locale pack supplies the language-specific patterns. "
                 "\"auto\" detects it from the owner's own messages on every build "
                 "(recommended); a pack id such as \"zh-CN\" or \"en\" pins it; "
                 "\"none\" forces structural-only measurement. Run "
                 "`python3 -m forge locales` to see what is installed, and check "
                 "the published references/fidelity.md for what the chosen pack "
                 "could not measure.",
        "id": "auto",
    },
    "dws": {"binary": "dws", "pageSize": 100},
    "database": {"path": ""},
    "autonomy": {
        "_help": "scope: draft_only (default — never sends) | allowlist (sends "
                 "low-risk only to the ids in allowlist) | everyone (sends low-risk "
                 "to any resolved recipient). The risk gate in the skill's "
                 "decisions.md applies in every scope; scope only widens WHO may "
                 "receive a reply, never WHAT may be said.",
        "_allowlistHelp": "Platform user ids, NOT names. A display name is a local "
                          "label that several people can share, and a 1:1 chat "
                          "title is usually an editable remark, so name matching "
                          "would let a renamed thread impersonate a trusted "
                          "colleague. Set with `forge autonomy --allow \"<name>\"`, "
                          "which resolves the name to an id once, with a human "
                          "present to disambiguate. allowlistNames is a display "
                          "cache for audit only and never authorizes anything.",
        "scope": "draft_only",
        "allowlist": [],
        "allowlistNames": {},
        "maxCodepoints": 300,
    },
    # Kept as a config group even though the inbox skill is gone: the cutoff it
    # holds is consumed by the persona's own `fresh` check and published into
    # `rules.json → policy.staleAfterMinutes`. The two title filters WERE
    # inbox-only discovery controls and were removed with it — a host that
    # dispatches its own messages decides scope upstream, and leaving dead keys in
    # a config invites someone to set one and wonder why nothing changed.
    "replyWindow": {
        "_staleHelp": "staleAfterMinutes: past this age an unanswered message is "
                      "too old to answer. Not answering for hours is itself a "
                      "decision, and a very late reply reads worse than silence. "
                      "LEAVE THIS NULL to use the value measured from the owner's own "
                      "reply latencies (see derived/features.json → replyWindow); set "
                      "a number to override, or 0 to disable the cutoff entirely.",
        "staleAfterMinutes": None,
    },
}


def emit(obj, code: int = 0) -> int:
    print(json.dumps(obj, ensure_ascii=False, indent=2))
    return code


def load_cfg(explicit: str | None) -> dict:
    """Load the config, adding any options a newer forge version introduced.

    Without this, an existing config keeps working but silently lacks new keys, so
    a tunable like `replyWindow.staleAfterMinutes` exists only as a code default and the
    owner has no way to see or change it.
    """
    cfg = C.load_config(C.find_config(explicit))
    added = C.ensure_config_defaults(cfg, CONFIG_TEMPLATE)
    # Never invent identity or paths for an existing profile.
    added = [k for k in added if k not in ("profileSlug", "displayName", "dataRoot",
                                           "skillRoots", "analysisStart")]
    if added:
        C.save_config(cfg)
        cfg["_upgradedKeys"] = added
    return cfg


def get_client(cfg: dict) -> DwsClient:
    """The raw DWS client — only for commands that are DingTalk-specific by
    nature (doctor's connectivity probes, name→id resolution for the allowlist).
    Anything that reads messages must go through `get_source` instead."""
    return DwsClient(binary=cfg.get("dws", {}).get("binary", "dws"),
                     log=C.expand(cfg["dataRoot"]) / "dws-calls.jsonl")


def get_source(cfg: dict, **overrides):
    """The configured message source. Every read path goes through this."""
    return sources_mod.open_source(cfg, **overrides)


# ---------------------------------------------------------------------------
# init
# ---------------------------------------------------------------------------

def cmd_init(a) -> int:
    """Create the data root and config.

    Identity comes from the chosen source, not from DWS unconditionally: with a
    `jsonl` source there is no server to ask, so the operator supplies it in
    `--source-option identity=<json>` and this validates it rather than inventing
    one. An identity the forge guessed wrong is the single worst failure mode
    available — it attributes someone else's messages to the owner and produces a
    confident, wrong persona.
    """
    kind = a.source or "dws"
    options = _parse_options(a.source_option)
    if kind == "dws" and a.dws_binary:
        options.setdefault("binary", a.dws_binary)
    try:
        probe_cfg = {"source": {"kind": kind, "options": options},
                     "dws": {"binary": a.dws_binary, "pageSize": 100}}
        source = sources_mod.open_source(probe_cfg)
        ident = source.identity()
    except (DwsError, SystemExit) as e:
        return emit({"error": f"could not resolve identity from source {kind!r}: {e}"}, 2)

    slug = a.slug or C.slug_from_self_id(ident["userId"], ident.get("orgId") or "")
    if not C.SLUG_RE.match(slug):
        return emit({"error": f"invalid slug: {slug}"}, 2)
    name = a.display_name or ident["name"] or slug

    data_root = C.expand(a.data_root or f"~/.claude/user-context/{slug}")
    C.assert_safe_data_root(data_root)
    cfg = json.loads(json.dumps(CONFIG_TEMPLATE))
    cfg.update({
        "profileSlug": slug, "displayName": name,
        "dataRoot": C.tildify(data_root),
        "skillRoots": a.skill_root or [f"~/.claude/skills/{slug}-persona",
                                       f"~/.codex/skills/{slug}-persona"],
        "analysisStart": a.since or (dt.date.today() - dt.timedelta(days=180)).isoformat(),
    })
    cfg["database"]["path"] = f"{cfg['dataRoot']}/database/persona.db"
    cfg["dws"]["binary"] = a.dws_binary
    cfg["source"]["kind"] = kind
    cfg["source"]["options"] = options
    if a.locale:
        cfg["locale"]["id"] = a.locale

    caps = source.capabilities()
    plan = {"slug": slug, "displayName": name, "dataRoot": str(data_root),
            "skillRoots": cfg["skillRoots"], "analysisStart": cfg["analysisStart"],
            "source": {"kind": kind, "capabilities": caps},
            "locale": cfg["locale"]["id"],
            "identity": {"userId": ident["userId"], "openIds": len(ident["openIds"]),
                         "excludedAliases": len(ident.get("excludedOpenIds") or []),
                         "aliases": ident["aliases"]}}
    if a.dry_run:
        return emit({"dryRun": True, "plan": plan})

    C.secure_mkdir(data_root)
    for sub in ("database", "derived", "backups"):
        C.secure_mkdir(data_root / sub)
    cfg_path = data_root / "persona-config.json"
    cfg["_path"] = str(cfg_path)
    C.save_config(cfg)
    return emit({"initialized": True, "config": str(cfg_path), "plan": plan,
                 "next": "python3 -m forge pull --since full"})


def _parse_options(pairs) -> dict:
    """`--source-option k=v` into a dict, decoding JSON values where possible.

    JSON decoding matters for the identity block, which is nested — a plain
    string parser would force the operator to hand-edit the config afterwards.
    """
    out: dict = {}
    for item in pairs or []:
        if "=" not in item:
            raise SystemExit(f"--source-option expects key=value, got {item!r}")
        key, _, raw = item.partition("=")
        try:
            out[key.strip()] = json.loads(raw)
        except json.JSONDecodeError:
            out[key.strip()] = raw
    return out


# ---------------------------------------------------------------------------
# doctor
# ---------------------------------------------------------------------------

def cmd_doctor(a) -> int:
    checks: list[dict] = []

    def ck(name: str, ok: bool, detail: str = "") -> None:
        checks.append({"check": name, "ok": bool(ok), "detail": str(detail)[:300]})

    ck("python >= 3.10", sys.version_info >= (3, 10), sys.version.split()[0])

    cfg = None
    try:
        cfg = load_cfg(a.config)
        ck("config found", True, cfg["_path"])
    except SystemExit as e:
        ck("config found", False, str(e))

    # --- source ------------------------------------------------------------
    kind = ((cfg or {}).get("source") or {}).get("kind", "dws")
    caps: dict = {}
    source = None
    if cfg:
        try:
            source = get_source(cfg)
            caps = source.capabilities()
            ck(f"source '{kind}' opens", True,
               "can: " + ", ".join(k for k in ("read", "directory", "mentions",
                                               "tail", "send") if caps.get(k)))
        except (SystemExit, DwsError) as e:
            ck(f"source '{kind}' opens", False, str(e))
        if source:
            try:
                ident = source.identity()
                ck("source identity", bool(ident["openIds"]),
                   f"{ident['name']} · userId {ident['userId']} · "
                   f"{len(ident['openIds'])} id(s), "
                   f"{len(ident.get('excludedOpenIds') or [])} excluded alias(es)")
            except (DwsError, SystemExit) as e:
                ck("source identity", False, str(e))

    # DingTalk-specific connectivity probes. Skipped entirely for other sources,
    # where a missing `dws` binary is not a fault.
    if kind == "dws":
        binary = (cfg or {}).get("dws", {}).get("binary", "dws")
        client = None
        try:
            client = DwsClient(binary=binary)
            ck("dws binary", True, client.binary)
        except DwsError as e:
            ck("dws binary", False, e.detail)
        if client:
            r = client.call(["chat", "list-all-conversations", "--limit", "1"])
            ck("dws conversation read", r.ok, r.error or "ok")
            now = dt.datetime.now()
            r2 = client.call(["chat", "message", "list-all",
                              "--start", (now - dt.timedelta(hours=6)).strftime("%Y-%m-%d %H:%M:%S"),
                              "--end", now.strftime("%Y-%m-%d %H:%M:%S"),
                              "--limit", "1", "--cursor", "0"])
            ck("dws message read", r2.ok, r2.error or "ok")

    if cfg:
        db = C.expand(cfg["database"]["path"])
        if db.exists():
            conn = store.open_db(db, create=False)
            try:
                v = store.verify(conn)
                for c in v["checks"]:
                    ck(f"corpus: {c['name']}", c["passed"], c["detail"])
                st = store.stats(conn)
                ck("corpus freshness", bool(st["pulledThrough"]),
                   f"pulled through {st['pulledThrough']}; latest message {st['latest']}")

                # Locale: the most consequential silent failure mode. A corpus in
                # a language with no pack still builds, and produces a persona
                # whose word-level layers are all empty — which reads as "this
                # person never hedges" rather than "we could not tell".
                requested = (cfg.get("locale") or {}).get("id", "auto")
                pack, verdict = locale_mod.load(
                    requested, C.expand(cfg["dataRoot"]), conn)
                ck("locale pack resolved", not pack.is_null,
                   f"{pack.id} v{pack.version} · {verdict.get('reason', '')}"
                   + (f" · cannot measure: {', '.join(pack.missing())}"
                      if pack.missing() else ""))
                mix = verdict.get("scriptMix") or {}
                # Only a non-incidental script counts as uncovered: Latin mixed
                # into CJK prose is identifiers, not an unmeasured language.
                uncovered = {k: val for k, val in mix.items()
                             if k not in set(pack.scripts) and val >= 5
                             and k in locale_mod.NON_INCIDENTAL_SCRIPTS}
                ck("locale covers the corpus's writing systems", not uncovered,
                   ("uncovered: " + ", ".join(f"{k} {v}%" for k, v in uncovered.items())
                    + " — the pack measures only " + ", ".join(pack.scripts or ["nothing"]))
                   if uncovered else " · ".join(f"{k} {v}%" for k, v in mix.items()))
            finally:
                conn.close()
        else:
            ck("corpus exists", False, f"{db} not found — run `forge pull`")

        features_path = C.expand(cfg["dataRoot"]) / "derived" / "features.json"
        if features_path.exists():
            feats = C.read_json(features_path, {}) or {}
            cov = report_mod.coverage(feats, {**cfg, "_sourceCapabilities": caps})
            ck("measured layers", cov["layersMeasured"] == cov["layersTotal"],
               f"{cov['layersMeasured']}/{cov['layersTotal']} measured"
               + (" · absent: " + ", ".join(
                   k for k, v in cov["layers"].items() if not v["measured"])
                  if cov["layersMeasured"] < cov["layersTotal"] else ""))

        for persona_dir in publish_mod.skill_roots(cfg):
            ck(f"skill installed: {persona_dir.name}",
               (persona_dir / "SKILL.md").exists(), str(persona_dir))
        scope = cfg.get("autonomy", {}).get("scope", "draft_only")
        ck("autonomy scope valid", scope in SCOPES, scope)
        if scope != "draft_only" and caps and not caps.get("send"):
            ck("autonomy scope is reachable", False,
               f"scope is '{scope}' but the '{kind}' source cannot send; every "
               f"reply will be drafted regardless")
        entries = cfg.get("autonomy", {}).get("allowlist", [])
        # A name in the allowlist can never match, because the gate compares ids.
        # Detected structurally (short / spaced / non-id-shaped) rather than
        # against one platform's id format, so the check survives a source change.
        id_rx = None
        src_pattern = (caps or {}).get("idPattern")
        if src_pattern:
            id_rx = re.compile(src_pattern)
        stale = [e for e in entries
                 if (id_rx and not id_rx.search(e)) or (not id_rx and len(e) < 12)]
        ck("allowlist is keyed on ids, not names", not stale,
           f"entries that can never match: {stale} — re-run `forge autonomy "
           f"--allow \"<name>\"` to resolve them" if stale
           else f"{len(entries)} id(s)")

    ok = all(c["ok"] for c in checks)
    failed = [c["check"] for c in checks if not c["ok"]]
    return emit({"ok": ok, "checks": checks, "failed": failed}, 0 if ok else 1)


# ---------------------------------------------------------------------------
# pull / build / publish
# ---------------------------------------------------------------------------

def cmd_pull(a) -> int:
    cfg = load_cfg(a.config)
    source = get_source(cfg)
    since = None if a.since == "full" else (a.since or "auto")
    lines: list[str] = []
    result = ingest.pull(cfg, source, since=since, until=a.until,
                         dry_run=a.dry_run,
                         progress=(lambda s: lines.append(s)) if a.verbose else None)
    if lines:
        result["progress"] = lines
    if hasattr(source, "client"):
        result["dwsCalls"] = {"total": source.client.calls,
                              "failures": source.client.failures}
    code = 1 if result.get("error") else 0
    return emit(result, code)


def cmd_build(a) -> int:
    cfg = load_cfg(a.config)
    if a.locale:
        cfg.setdefault("locale", {})["id"] = a.locale
    features = build_mod.build(cfg, getattr(a, "window_days", None))
    m = features["meta"]
    loc = m.get("locale") or {}
    return emit({
        "built": True, "window": m["window"], "rulesVersion": m["rulesVersion"],
        # Both reported: `window` is what was MEASURED, `corpusWindow` what is
        # STORED. A caller that saw only one could not tell a narrow build from a
        # thin corpus, and those call for opposite fixes.
        "corpusWindow": m.get("corpusWindow"),
        "measureWindow": m.get("measureWindow"),
        "recency": m.get("recency"),
        "locale": {"id": loc.get("id"), "isNull": loc.get("isNull"),
                   "missing": loc.get("missing"),
                   "reason": (loc.get("verdict") or {}).get("reason")},
        "source": m.get("source"),
        "corpus": m["corpus"], "pairs": m["pairs"],
        "styleSummary": {
            "avgCodepoints": features["style"]["overall"]["avgCodepoints"],
            "questionPct": features["style"]["overall"]["questionPct"],
            "hedgeToAssert": features["style"]["overall"]["hedgeToAssertRatio"],
            "toneBands": list(features["style"]["byToneBand"]),
        },
        "decisionSummary": {
            "asksAnalyzed": features["decisions"]["asksAnalyzed"],
            "answerDirectly": features["policy"]["answerDirectly"],
            "handoffPreferred": features["policy"]["handoffPreferred"],
            "oftenNoReply": features["policy"]["oftenNoReply"],
            "neverSettleAlone": features["policy"]["neverSettleAlone"],
            "autoSendCandidates": features["policy"]["autoSendCandidates"],
        },
        "people": len(features["people"]),
        "warnings": _build_warnings(features),
        "next": "python3 -m forge publish",
    })


def _build_warnings(features: dict) -> list[dict]:
    """Degenerate builds that still look successful.

    Every number below is legitimately zero for a corpus that really contains
    nothing of the kind, so none of these is an error. But each is far more often
    an import mistake, and the failure is silent in the worst way: `build`
    succeeds, `publish` installs, and the persona answers with defaults that read
    like measurements. Surfaced at the point where the operator can still fix the
    import rather than only in the fidelity report they may never open.
    """
    out: list[dict] = []
    pairs = features["meta"].get("pairs") or {}
    corpus = features["meta"].get("corpus") or {}
    if not features["decisions"].get("asksAnalyzed"):
        out.append({
            "severity": "high", "code": "no_asks_mined",
            "detail": "0 incoming asks were mined, so the whole decision layer is "
                      "defaults rather than evidence. Most common causes: every "
                      "conversation imported as a group (check `singleChat` in the "
                      "export), or the owner identity does not match the sender ids "
                      "actually in the data.",
        })
    if not pairs.get("turns"):
        out.append({
            "severity": "high", "code": "no_turns_paired",
            "detail": "0 context→reply pairs, so no real reply of theirs can be "
                      "shown as a precedent. Same likely causes as `no_asks_mined`.",
        })
    if not corpus.get("selfMessages"):
        out.append({
            "severity": "high", "code": "no_own_messages",
            "detail": "the corpus contains no messages by the owner — the identity "
                      "(`openIds`) almost certainly does not match this export.",
        })
    if not features["people"]:
        out.append({
            "severity": "medium", "code": "no_people",
            "detail": "nobody met the publication threshold, so per-recipient tone "
                      "is entirely absent.",
        })
    return out


def cmd_publish(a) -> int:
    cfg = load_cfg(a.config)
    features = build_mod.load_features(cfg)
    result = publish_mod.publish(cfg, features, dry_run=a.dry_run)
    if not a.dry_run:
        for persona_dir in publish_mod.skill_roots(cfg):
            s = scan_mod.scan("skill", persona_dir)
            if not s["safe"]:
                result["scanFindings"] = s["findings"][:20]
                result["warning"] = ("published, but the share-safety scan flagged "
                                     "the above — review before handing this skill "
                                     "to anyone else")
    return emit(result)


def cmd_refresh(a) -> int:
    cfg = load_cfg(a.config)
    source = get_source(cfg)
    pulled = ingest.pull(cfg, source, since="auto")
    if pulled.get("error"):
        return emit({"stage": "pull", **pulled}, 1)
    features = build_mod.build(cfg)
    published = publish_mod.publish(cfg, features)
    loc = features["meta"].get("locale") or {}
    return emit({
        "refreshed": True,
        "pull": {k: pulled[k] for k in ("mode", "window", "inserted", "failedSlices")
                 if k in pulled},
        "locale": {"id": loc.get("id"), "isNull": loc.get("isNull")},
        "corpus": features["meta"]["corpus"],
        "publish": {"files": published["files"],
                    "ownerBlocksPreserved": published["ownerBlocksPreserved"]},
    })


# ---------------------------------------------------------------------------
# locales / sources / report
# ---------------------------------------------------------------------------

def cmd_locales(a) -> int:
    """What language packs are installed, and which one fits this corpus."""
    out: dict = {"installed": [], "nullPackAlways": True}
    for pid in locale_mod.available():
        pack, _ = locale_mod.load(pid)
        out["installed"].append(pack.describe())
    try:
        cfg = load_cfg(a.config)
    except SystemExit:
        out["note"] = ("no profile configured; detection needs a corpus. "
                       "Packs above are still installable/authorable.")
        return emit(out)

    out["configured"] = (cfg.get("locale") or {}).get("id", "auto")
    db = C.expand(cfg["database"]["path"])
    if not db.exists():
        out["note"] = "no corpus yet — run `forge pull` before detection can run"
        return emit(out)
    conn = store.open_db(db, create=False)
    try:
        out["detected"] = locale_mod.detect(conn)
    finally:
        conn.close()
    return emit(out)


def cmd_sources(a) -> int:
    """What message sources exist and what each one can do."""
    rows = []
    for kind in sources_mod.available():
        cls = sources_mod.get_source_class(kind)
        rows.append({
            "kind": cls.KIND, "platformLabel": cls.PLATFORM_LABEL,
            "idLabel": cls.ID_LABEL, "idPattern": cls.ID_PATTERN,
            "clientFurniturePatterns": len(getattr(cls, "CLIENT_FURNITURE", ())),
        })
    out: dict = {"sources": rows}
    try:
        cfg = load_cfg(a.config)
    except SystemExit:
        return emit(out)
    out["configured"] = (cfg.get("source") or {}).get("kind", "dws")
    try:
        out["capabilities"] = get_source(cfg).capabilities()
    except (SystemExit, DwsError) as e:
        out["capabilitiesError"] = str(e)
    return emit(out)


def cmd_report(a) -> int:
    """Coverage report, and optionally the blind-test protocol.

    The coverage half is also published into the skill on every `publish`; this
    command is for reading it without a rebuild, and for generating the rubric,
    which is deliberately NOT published because it contains the answer key.
    """
    cfg = load_cfg(a.config)
    features = build_mod.load_features(cfg)
    try:
        cfg["_sourceCapabilities"] = get_source(cfg).capabilities()
    except (SystemExit, DwsError):
        cfg["_sourceCapabilities"] = {}
    cov = report_mod.coverage(features, cfg)

    result: dict = {"coverage": cov}
    if a.rubric:
        held = report_mod.held_out_asks(cfg, limit=a.questions)
        text = report_mod.render_rubric(features, cfg, held)
        out_path = C.expand(cfg["dataRoot"]) / "derived" / "fidelity-rubric.md"
        C.secure_write(out_path, text)
        result["rubric"] = {
            "path": str(out_path), "questions": len(held),
            "warning": "contains the answer key — never copy it into a published "
                       "skill directory",
            "next": "run the two-agent blind test, then paste the score table into "
                    "the fidelity-behavioral owner block in references/fidelity.md",
        }
    if a.markdown:
        print(report_mod.render_fidelity(features, cfg))
        return 0
    return emit(result)


# ---------------------------------------------------------------------------
# autonomy / inspect / scan
# ---------------------------------------------------------------------------

def _resolve_person(cfg: dict, name: str) -> dict:
    """Name → one openDingTalkId, or an explicit refusal.

    Authorization is the moment to resolve identity, because it is the one moment
    a human is present to disambiguate. Doing it at send time would mean matching
    on an editable display name, which is not an identity at all.
    """
    db = C.expand(cfg["database"]["path"])
    if not db.exists():
        return {"error": "no corpus yet — run `forge pull` before authorizing anyone"}
    conn = store.open_db(db, create=False)
    try:
        rows = conn.execute(
            "SELECT person_id, name, nick, msgs_from, msgs_to, tone_band, sensitive "
            "FROM people WHERE name=? OR nick=? ORDER BY msgs_from+msgs_to DESC",
            (name, name)).fetchall()
    finally:
        conn.close()
    if not rows:
        return {"error": f"no one named '{name}' in the corpus; check the exact "
                         "name with `forge inspect`"}
    if len(rows) > 1:
        # Never guess between people. Show the candidates and require an id.
        return {"error": f"'{name}' matches {len(rows)} people — refusing to guess",
                "candidates": [{"personId": r["person_id"], "name": r["name"],
                                "nick": r["nick"], "messages": r["msgs_from"] + r["msgs_to"],
                                "toneBand": r["tone_band"]} for r in rows],
                "hint": "re-run with --allow-id <personId> to pick one"}
    r = rows[0]
    if r["sensitive"]:
        return {"error": f"'{name}' is marked sensitive (band S) — refusing to "
                         "add them to an auto-send allowlist"}
    return {"personId": r["person_id"], "name": r["name"],
            "messages": r["msgs_from"] + r["msgs_to"], "toneBand": r["tone_band"]}


def _migrate_allowlist(cfg: dict) -> dict:
    """Convert a legacy name-keyed allowlist into id-keyed form.

    Earlier versions stored display names. Under the new gate those entries would
    be compared against openDingTalkIds and never match — fail-safe, but silently
    so, which is its own bug. Resolve what can be resolved, and report the rest
    loudly instead of dropping it.
    """
    auto = cfg.setdefault("autonomy", {})
    entries = auto.get("allowlist", [])
    # An openDingTalkId starts with 'D' and is long; a display name is not.
    legacy = [e for e in entries if not (len(e) > 20 and e.startswith("D"))]
    if not legacy:
        return {}
    resolved, unresolved = [], []
    for name in legacy:
        r = _resolve_person(cfg, name)
        if "error" in r:
            unresolved.append({"name": name, "reason": r["error"],
                               "candidates": r.get("candidates", [])})
        else:
            resolved.append(r)
    auto["allowlist"] = [e for e in entries if e not in legacy] + \
                        [r["personId"] for r in resolved]
    names = auto.setdefault("allowlistNames", {})
    for r in resolved:
        names[r["personId"]] = r["name"]
    return {"migratedToIds": resolved, "couldNotMigrate": unresolved}


def cmd_autonomy(a) -> int:
    cfg = load_cfg(a.config)
    auto = cfg.setdefault("autonomy", {})
    auto.setdefault("allowlist", [])          # openDingTalkIds — the real key
    auto.setdefault("allowlistNames", {})     # id → name, for audit and messages
    changed: dict = {}

    migration = _migrate_allowlist(cfg)
    if migration:
        changed["migration"] = migration

    if a.scope:
        if a.scope not in SCOPES:
            return emit({"error": f"scope must be one of {SCOPES}"}, 2)
        auto["scope"] = a.scope
        changed["scope"] = a.scope

    for name in a.allow or []:
        r = _resolve_person(cfg, name)
        if "error" in r:
            return emit(r, 2)
        pid = r["personId"]
        if pid not in auto["allowlist"]:
            auto["allowlist"].append(pid)
        auto["allowlistNames"][pid] = r["name"]
        changed.setdefault("allowed", []).append(
            {"name": r["name"], "personId": pid, "messages": r["messages"],
             "toneBand": r["toneBand"]})

    for pid in a.allow_id or []:
        if pid not in auto["allowlist"]:
            auto["allowlist"].append(pid)
        conn_name = ""
        db = C.expand(cfg["database"]["path"])
        if db.exists():
            conn = store.open_db(db, create=False)
            try:
                row = conn.execute("SELECT name, sensitive FROM people WHERE person_id=?",
                                   (pid,)).fetchone()
            finally:
                conn.close()
            if row and row["sensitive"]:
                return emit({"error": f"{pid} is marked sensitive — refusing"}, 2)
            conn_name = (row["name"] if row else "")
        auto["allowlistNames"][pid] = conn_name
        changed.setdefault("allowed", []).append({"name": conn_name, "personId": pid})

    for name in a.deny or []:
        # Remove by name OR by id, so revoking never requires looking up an id.
        hits = [pid for pid, nm in auto["allowlistNames"].items()
                if nm == name or pid == name]
        for pid in hits or ([name] if name in auto["allowlist"] else []):
            if pid in auto["allowlist"]:
                auto["allowlist"].remove(pid)
            auto["allowlistNames"].pop(pid, None)
            changed.setdefault("removed", []).append({"name": name, "personId": pid})
        if not hits and name not in auto["allowlist"]:
            return emit({"error": f"'{name}' is not on the allowlist"}, 2)

    if a.max_codepoints:
        auto["maxCodepoints"] = a.max_codepoints
        changed["maxCodepoints"] = a.max_codepoints

    current = {"scope": auto.get("scope", "draft_only"),
               "allowlist": [{"personId": pid,
                              "name": auto["allowlistNames"].get(pid, "")}
                             for pid in auto["allowlist"]],
               "maxCodepoints": auto.get("maxCodepoints", 300)}
    if not changed:
        features = C.read_json(C.expand(cfg["dataRoot"]) / "derived" / "features.json", {})
        cands = (features.get("policy") or {}).get("autoSendCandidates", [])
        return emit({"current": current, "measuredCandidates": cands,
                     "note": "candidates are measurements, not authorization; add one "
                             "with --allow <name>. The allowlist is keyed on "
                             "openDingTalkId, so renaming a chat cannot grant access."})
    if a.dry_run:
        return emit({"dryRun": True, "wouldSet": current, "changed": changed})

    C.save_config(cfg)
    features = build_mod.load_features(cfg)
    published = publish_mod.publish(cfg, features)
    return emit({"changed": changed, "current": current,
                 "republished": published["files"],
                 "note": "The risk gate is unchanged — scope only widens who may "
                         "receive a reply, never what may be said."})


def cmd_inspect(a) -> int:
    cfg = load_cfg(a.config)
    db = C.expand(cfg["database"]["path"])
    out: dict = {"slug": cfg["profileSlug"], "config": cfg["_path"],
                 "autonomy": cfg.get("autonomy", {}).get("scope")}
    if db.exists():
        conn = store.open_db(db, create=False)
        try:
            out["corpus"] = store.stats(conn)
            out["topConversations"] = [dict(r) for r in conn.execute(
                "SELECT title, single_chat, msg_count, self_msg_count FROM conversations "
                "ORDER BY msg_count DESC LIMIT 12")]
            out["bandCounts"] = {r["tone_band"] or "unset": r["n"] for r in conn.execute(
                "SELECT tone_band, COUNT(*) n FROM people GROUP BY tone_band")}
        finally:
            conn.close()
    else:
        out["corpus"] = None
    features = C.read_json(C.expand(cfg["dataRoot"]) / "derived" / "features.json", {})
    if features:
        out["builtAt"] = features["meta"]["builtAt"]
        out["rulesVersion"] = features["meta"].get("rulesVersion")
        out["locale"] = features["meta"].get("locale", {})
        out["source"] = features["meta"].get("source")
        out["policy"] = features["policy"]
        out["askKinds"] = features.get("askKinds")
    return emit(out)


def cmd_scan(a) -> int:
    if a.scope == "fixtures":
        # Needs the operator's own database, which is why it is a separate scope:
        # the shareable scopes must never read the corpus.
        cfg = load_cfg(a.config)
        findings = scan_mod.corpus_derived_fixtures(
            scan_mod.REPO, C.expand(cfg["database"]["path"]))
        blocking = [f for f in findings if f["severity"] in ("critical", "high")]
        return emit({"scope": "fixtures", "findings": findings,
                     "safe": not blocking,
                     "note": "a fixture must be invented. A phrase shared with the "
                             "real corpus means it was copied or paraphrased from "
                             "it — rewrite it around the structure under test."},
                    0 if not blocking else 1)

    path = None
    if a.scope != "repo":
        if a.path:
            path = C.expand(a.path)
        else:
            cfg = load_cfg(a.config)
            path = (C.expand(cfg["dataRoot"]) if a.scope == "data"
                    else publish_mod.skill_roots(cfg)[0])
    r = scan_mod.scan(a.scope, path)
    return emit(r, 0 if r["safe"] else 1)


def cmd_lock(a) -> int:
    cfg = load_cfg(a.config)
    lock = not a.unlock
    if a.dry_run:
        return emit({"dryRun": True, "wouldSet": "read-only" if lock else "writable"})
    cfg["lockSkills"] = lock
    C.save_config(cfg)
    r = publish_mod.set_readonly(cfg, lock)
    r["persisted"] = "future publishes re-apply this automatically"
    return emit(r)


def cmd_export(a) -> int:
    """Bundle the published skills for an agent on another machine.

    Markdown-only by design: the corpus stays on this machine. The exported skill
    still carries the full decision layer, style, people and scenes — recall and
    send simply degrade to unavailable, which the scripts now report cleanly.
    """
    import tarfile
    cfg = load_cfg(a.config)
    dest = C.expand(a.out or f"./{cfg['profileSlug']}-skills.tar.gz")
    persona_dir = publish_mod.skill_roots(cfg)[0]

    findings = []
    for d in (persona_dir,):
        s = scan_mod.scan("skill", d)
        findings += s["findings"]
    if findings:
        return emit({"error": "refusing to export: the share scan flagged the "
                              "published skill", "findings": findings[:10]}, 1)

    if a.dry_run:
        return emit({"dryRun": True, "would_write": str(dest),
                     "includes": [persona_dir.name],
                     "excluded": ["corpus", "config", "audit logs", ".config-path"]})

    with tarfile.open(dest, "w:gz") as tar:
        for d in (persona_dir,):
            for path in sorted(d.rglob("*")):
                if not path.is_file() or "__pycache__" in path.parts:
                    continue
                rel = path.relative_to(d.parent).as_posix()
                # The pointer names a local absolute path; it is meaningless (and
                # mildly leaky) elsewhere, so it is left out deliberately.
                if path.name == ".config-path":
                    continue
                tar.add(path, arcname=rel)
    return emit({"exported": str(dest),
                 "sizeBytes": dest.stat().st_size,
                 "includes": [persona_dir.name],
                 "mode": "markdown-only (no corpus, no config, no logs)",
                 "install": "tar -xzf <file> -C ~/.claude/skills/",
                 "note": "recall/send need the data root and stay unavailable there; "
                         "the decision layer, style, people and scenes all work"})


def cmd_selftest(a) -> int:
    from . import selftest
    r = selftest.run(locale=getattr(a, "locale", None))
    return emit(r, 0 if r["ok"] else 1)


# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="forge", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add(name, **kw):
        p = sub.add_parser(name, **kw)
        p.add_argument("--config")
        p.add_argument("--dry-run", action="store_true")
        return p

    p = add("init", help="create the data root and config")
    p.add_argument("--display-name")
    p.add_argument("--slug")
    p.add_argument("--data-root")
    p.add_argument("--skill-root", action="append")
    p.add_argument("--since", help="analysis start date (default: 180 days ago)")
    p.add_argument("--dws-binary", default="dws")
    p.add_argument("--source", choices=sources_mod.available(),
                   help="where messages come from (default: dws)")
    p.add_argument("--source-option", action="append", metavar="KEY=VALUE",
                   help="adapter option, repeatable; values may be JSON. For the "
                        "jsonl source: path=<dir-or-file> and "
                        "identity={\"openIds\":[...],\"name\":\"...\"}")
    p.add_argument("--locale", help="locale pack id, 'auto' (default), or 'none'")

    add("doctor", help="check the source, identity, corpus and installed skills")

    p = add("pull", help="fetch messages into the local corpus")
    p.add_argument("--since", default="auto",
                   help="'auto' (resume from checkpoint), 'full', or YYYY-MM-DD")
    p.add_argument("--until")
    p.add_argument("--verbose", action="store_true", help="report per-slice progress")

    p = add("build", help="corpus → measured features")
    p.add_argument("--locale", help="override the configured locale pack for this "
                                    "build (pack id, 'auto', or 'none')")
    p.add_argument("--window-days", type=int,
                   help="measure only the last N days of the corpus (counted back "
                        "from its newest message, not from now). Non-destructive: "
                        "nothing is deleted and a later build without this flag "
                        "measures everything again. Use it to re-distill a recent "
                        "window without discarding history that cannot be "
                        "re-collected. Defaults to config's measureWindowDays.")
    add("publish", help="install the persona skill")
    add("refresh", help="pull → build → publish")

    add("locales", help="installed locale packs, and which fits this corpus")
    add("sources", help="available message sources and their capabilities")

    p = add("report", help="coverage report; --rubric for the blind fidelity test")
    p.add_argument("--rubric", action="store_true",
                   help="also write the two-agent blind-test protocol (contains the "
                        "answer key — stays in the data root, never published)")
    p.add_argument("--questions", type=int, default=6,
                   help="how many held-out asks to draw for the rubric")
    p.add_argument("--markdown", action="store_true",
                   help="print the published fidelity.md instead of JSON")

    p = add("autonomy", help="set the send scope and allowlist")
    p.add_argument("--scope", choices=SCOPES)
    p.add_argument("--allow", action="append",
                   help="authorize by name; resolved to a platform user id now, and "
                        "refused if the name is ambiguous")
    p.add_argument("--allow-id", action="append",
                   help="authorize by platform user id (use when a name is ambiguous)")
    p.add_argument("--deny", action="append", help="revoke by name or id")
    p.add_argument("--max-codepoints", type=int)

    add("inspect", help="what is in the corpus and what was measured")

    p = add("scan", help="share-safety check")
    p.add_argument("--scope", choices=["repo", "skill", "data", "fixtures"],
                   default="repo",
                   help="fixtures compares the test fixtures against YOUR corpus "
                        "to catch a fixture that was paraphrased from real history "
                        "instead of invented")
    p.add_argument("--path")

    p = add("lock", help="make installed skills read-only so no agent can edit them")
    p.add_argument("--unlock", action="store_true", help="make them writable again")

    p = add("export", help="bundle the skills for an agent on another machine")
    p.add_argument("--out", help="output .tar.gz path")

    p = add("selftest", help="offline regression (no network, no personal data)")
    p.add_argument("--locale", help="run the suite against one locale fixture "
                                    "(zh-CN, en, or none); default runs all")

    a = ap.parse_args(argv)
    handlers = {
        "init": cmd_init, "doctor": cmd_doctor, "pull": cmd_pull, "build": cmd_build,
        "publish": cmd_publish, "refresh": cmd_refresh, "autonomy": cmd_autonomy,
        "inspect": cmd_inspect, "scan": cmd_scan, "lock": cmd_lock,
        "export": cmd_export, "selftest": cmd_selftest,
        "locales": cmd_locales, "sources": cmd_sources, "report": cmd_report,
    }
    try:
        return handlers[a.cmd](a)
    except DwsError as e:
        return emit({"error": str(e), "transient": e.transient,
                     "hint": "run `python3 -m forge doctor` to see which call fails"}, 1)
    except sqlite3.OperationalError as e:
        if "locked" in str(e).lower():
            return emit({"error": "the corpus is locked by another forge command "
                                  "(most likely a pull still running)",
                         "hint": "wait for it to finish, then re-run — the corpus "
                                 "keeps its checkpoint, so nothing is lost"}, 1)
        return emit({"error": f"corpus error: {e}"}, 1)
    except KeyboardInterrupt:
        return emit({"interrupted": True,
                     "note": "the corpus keeps its checkpoint; re-run to resume"}, 130)


if __name__ == "__main__":
    raise SystemExit(main())
