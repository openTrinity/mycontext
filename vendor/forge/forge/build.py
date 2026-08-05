#!/usr/bin/env python3
"""Build: corpus → measured features → features.json (the publish input).

The whole build is derived from the corpus, so it is repeatable and cheap: any
change to signals.json or to the overrides file is one `forge build` away from
being reflected in the published skill. No DWS calls happen here.
"""

from __future__ import annotations

import datetime as dt

from . import analyze, common as C, decide, locale as locale_mod
from . import relations, sources as sources_mod, store


def build(cfg: dict) -> dict:
    db_path = C.expand(cfg["database"]["path"])
    if not db_path.exists():
        raise SystemExit("no corpus yet — run `forge pull` first")
    conn = store.open_db(db_path, create=False)
    try:
        data_root = C.expand(cfg["dataRoot"])

        # Locale first: it decides how every lexical measurement below behaves.
        # "auto" inspects the owner's own messages, so it must run against an
        # already-populated corpus rather than being guessed from config.
        requested = (cfg.get("locale") or {}).get("id", "auto")
        pack, verdict = locale_mod.load(requested, data_root, conn)
        # Text nobody typed, from the two places it can legitimately come from.
        # Both must be registered BEFORE any analysis reads a message, or the
        # client's rich cards get counted as the owner's prose — which is how a
        # persona learns to answer a colleague with a wall of URLs.
        #
        # The source is resolved by class, not opened: registering furniture must
        # not require the platform to be reachable, since `build` is offline by
        # contract.
        furniture = sources_mod.furniture_for(cfg)
        # The operator's own additions — one company's form templates and
        # bug-report boilerplate, which must never enter a distributed pack.
        overrides = locale_mod.extra_placeholders(data_root, pack.id)
        C.register_placeholders(furniture + tuple(overrides))
        rules = analyze.Rules(analyze.load_signals(data_root), pack)

        aliases = set((store.get_meta(conn, "selfAliases") or "").split(",")) - {""}
        self_ids = set((store.get_meta(conn, "selfOpenIds") or "").split(",")) - {""}

        # Self-heal: a corpus pulled before peer-linking existed, or whose
        # directory pass missed a thread, would band every 1:1 partner as a
        # sparse contact. Cheap to redo, so it runs on every build.
        linked = store.link_direct_peers(conn, self_ids)
        # Same self-heal for pasted machine output: a corpus pulled before the
        # flag existed would count stack traces as the owner's prose.
        pasted = store.backfill_pasted(conn)
        if linked:
            store.refresh_counts(conn)

        # Scene tags depend on the locale pack, so a locale change must re-tag.
        # Rules version is the honest trigger: it already folds in the pack id.
        if store.get_meta(conn, "scenesRulesVersion") != rules.version:
            conn.execute("UPDATE messages SET scene='unknown'")
            conn.commit()
        tagged = analyze.tag_scenes(conn, rules)
        store.set_meta(conn, "scenesRulesVersion", rules.version)

        overrides = C.read_json(data_root / "relationship-overrides.json", {}) or {}
        ledger = relations.compute_bands(conn, rules, overrides.get("people", {}))
        tone_map = relations.apply_bands(conn, ledger)

        pairs = analyze.build_turns_and_asks(conn, rules, tone_map, aliases)
        relations.retag_turns(conn)
        store.rebuild_fts(conn)

        style = analyze.style(conn, rules, tone_map)
        mined = decide.mine(conn, rules)
        policy = decide.derive_policy(mined, style)
        mined["policy"] = policy
        examples = _scene_examples(conn, rules)

        stats = store.stats(conn)
        window = f"{(stats['earliest'] or '')[:10]} → {(stats['latest'] or '')[:10]}"
        # The human label belongs to the adapter, not to the config: reading it
        # from `cfg` silently yielded "" and the published limits.md said only
        # "work chat only" instead of naming the platform.
        source_kind = (cfg.get("source") or {}).get("kind", "dws")
        source_caps = sources_mod.get_source_class(source_kind).static_capabilities()

        features = {
            "meta": {
                "slug": cfg["profileSlug"],
                "displayName": cfg.get("displayName"),
                "window": window,
                "builtAt": dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
                "rulesVersion": rules.version,
                "signalsVersion": rules.signals_version,
                "locale": {**pack.describe(), "verdict": verdict},
                "source": source_kind,
                "platform": source_caps.get("platformLabel", ""),
                "sourceCapabilities": source_caps,
                "corpus": stats,
                "scenesTagged": tagged,
                "directPeersLinked": linked,
                "pastedExcluded": pasted,
                "pairs": pairs,
            },
            "style": style,
            "decisions": mined,
            "policy": policy,
            "people": relations.summary_for_skill(ledger, rules),
            "examples": examples,
            "askKinds": analyze.ask_kind_summary(conn),
        }

        store.set_meta(conn, "lastBuildAt", features["meta"]["builtAt"])
        store.set_meta(conn, "localeId", pack.id)
        conn.commit()

        # Persist the adapter's declared capabilities into the config the
        # published skill reads. Without this the skill cannot tell "the live read
        # failed" from "this platform has no live read" — and a source with no
        # tail would let stale corpus history pass as the current conversation.
        if cfg.get("_sourceCapabilities") != source_caps:
            cfg["_sourceCapabilities"] = source_caps
            C.save_config(cfg)

        derived = data_root / "derived"
        C.secure_mkdir(derived)
        C.write_json(derived / "features.json", features)
        C.write_json(derived / "relationship-ledger.json", ledger)
        if not (data_root / "relationship-overrides.json").exists():
            C.write_json(data_root / "relationship-overrides.json", {
                "_help": "Correct a measured tone band, or mark someone sensitive. "
                         "Overrides win over measurements and survive every rebuild. "
                         "Loosening a band (e.g. S → A) additionally requires "
                         "\"trust\": true, so it can never happen by accident.",
                "people": {},
            })
        if not (data_root / locale_mod.LOCAL_EXTRA_FILE).exists():
            C.write_json(data_root / locale_mod.LOCAL_EXTRA_FILE, {
                "_help": "Your own additions to the active locale pack. These stay "
                         "on this machine: they are single-tenant by nature and "
                         "would be dead weight in a distributed pack. Keys, all "
                         "optional: botNames (service accounts specific to your "
                         "company), stopwords (words flooding your vocabulary "
                         "list), placeholders (regexes for your own form and "
                         "bug-report templates, which are not prose anyone wrote).",
                "_scoping": "Put keys at the top level to apply to whichever pack "
                            "is active, or nest them under a pack id such as "
                            "\"zh-CN\" to scope them.",
                "botNames": [],
                "stopwords": [],
                "placeholders": [],
            })
        return features
    finally:
        conn.close()


def _scene_examples(conn, rules=None, per_scene: int = 5) -> dict:
    """Real turns per scene, for the skill's 'their real replies' sections.

    Picks median-length replies: the longest are outliers and the shortest are
    bare acknowledgements, neither of which shows how they handle a situation.
    """
    out: dict[str, list[dict]] = {}
    for scene in [r["scene"] for r in conn.execute(
            "SELECT DISTINCT scene FROM turns").fetchall()]:
        rows = conn.execute("""
            SELECT context_text, my_reply, peer_name, occurred_at, ask_kind
            FROM turns
            WHERE scene=? AND LENGTH(my_reply) BETWEEN 8 AND 120
              AND ask_kind != 'ack_or_fyi'
            ORDER BY LENGTH(my_reply)""", (scene,)).fetchall()
        if not rows:
            continue
        mid = len(rows) // 2
        lo = max(0, mid - per_scene * 2)
        window = rows[lo:mid + per_scene * 2]
        step = max(1, len(window) // per_scene)
        picked = window[::step][:per_scene]
        out[scene] = [{
            "context": r["context_text"], "reply": r["my_reply"],
            "askKind": r["ask_kind"],
        } for r in picked]
    return out


def load_features(cfg: dict) -> dict:
    path = C.expand(cfg["dataRoot"]) / "derived" / "features.json"
    features = C.read_json(path)
    if not features:
        raise SystemExit("no features.json — run `forge build` first")
    return features
