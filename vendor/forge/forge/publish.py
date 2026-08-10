#!/usr/bin/env python3
"""Publish: assemble and install the persona skill.

Skills are **products**, never sources. Deleting an installed skill and running
`forge publish` reproduces it exactly. Two things are carried across a rebuild:
the owner's `<!-- owner:begin -->` blocks, and their overrides file. Everything
else is regenerated from the corpus.
"""

from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path

from . import analyze
from . import common as C
from . import compose

REPO = Path(__file__).resolve().parent.parent
TEMPLATES = REPO / "templates"
RUNTIME_SRC = Path(__file__).resolve().parent / "runtime.py"

SCOPE_NOTES = {
    "draft_only": " — every reply is drafted for the owner; sending is disabled.",
    "allowlist": " — low-risk replies may be sent only to recipients on the "
                 "autonomy allowlist; everyone else is draft-only.",
    "everyone": " — low-risk replies may be sent to any resolved recipient. "
                "Unresolved and sensitive recipients remain draft-only.",
}


def _subst(text: str, slug: str, name: str, scope: str,
           stale_minutes: int = 240, stale_basis: str = "",
           data_root: Path | None = None, pack=None,
           id_label: str = "user id", platform_label: str = "work chat",
           burst_gap: int = 300, burst_max: int = 12,
           skill_dir: str = "", owner_facts: str = "") -> str:
    """Fill the template placeholders.

    The bot pattern and every language-specific example are injected from the
    active locale pack, so the published skill filters on exactly the rules its
    statistics were built from. A published skill cannot read a locale pack, and
    duplicating these by hand is how the two layers silently drift apart.
    """
    from .locale import NULL_PACK
    pack = pack or NULL_PACK
    never = pack.guide("neverWrite") or []
    return (text.replace("{{SLUG}}", slug)
                .replace("{{NAME}}", name)
                .replace("{{SCOPE}}", scope)
                .replace("{{SCOPE_NOTE}}", SCOPE_NOTES.get(scope, ""))
                # Where this skill actually got installed. Hardcoding
                # `~/.claude/skills` in the template made every command in it
                # wrong for any caller that installs elsewhere — and wrong in the
                # worst way: the agent runs a path that does not exist and reports
                # the skill as broken rather than mis-installed.
                .replace("{{SKILL_DIR}}", skill_dir or f"~/.claude/skills/{slug}-persona")
                .replace("{{OWNER_FACTS}}", owner_facts or "")
                .replace("{{BOT_NAME_PATTERN}}",
                         pack.bot_name.pattern if pack.bot_name else "")
                .replace("{{LOCALE_ID}}", pack.id)
                .replace("{{ID_LABEL}}", id_label)
                .replace("{{PLATFORM_LABEL}}", platform_label)
                .replace("{{NEVER_WRITE}}",
                         "; ".join(never) if never
                         else "(no register list for this locale — write as this "
                              "person writes, never as an assistant)")
                .replace("{{MANUFACTURED_OPENERS}}",
                         pack.guide("manufacturedOpeners")
                         or "filler greetings and stock openers")
                .replace("{{HEDGE_MARKERS}}",
                         pack.guide("hedgeMarkers") or "their own softeners")
                .replace("{{SHORT_REFERENT_EXAMPLES}}",
                         pack.guide("shortReferentExamples")
                         or "a bare acknowledgement")
                .replace("{{DECISION_MARKERS}}",
                         pack.guide("decisionMarkers")
                         or "any phrasing that hands them the decision")
                .replace("{{STALE_AFTER_MINUTES}}", str(stale_minutes))
                .replace("{{BURST_GAP_SECONDS}}", str(burst_gap))
                .replace("{{BURST_MAX_MESSAGES}}", str(burst_max))
                .replace("{{STALE_BASIS}}", stale_basis or "no latency data yet"))


def _owner_facts(cfg: dict) -> str:
    """Who the owner is, from config — rendered as bullets for the skill.

    ## Why this comes from config and not from measurement

    The forge measures HOW someone communicates. Who they are — their name, the
    organization, what they call the people they talk to daily — is not something
    a message corpus states; it is something the host application already knows
    authoritatively (it authenticated them). Inferring it from chat text is how a
    persona ends up confidently wrong about its own job title.

    Absent means absent: no facts, no section. An agent with no identity block
    says "I" and nothing more, which is honest. Inventing a plausible one is not.
    """
    facts = (cfg.get("owner") or {}).get("facts") or []
    lines = [str(f).strip() for f in facts if str(f).strip()]
    if not lines:
        return ""
    return "\n".join(f"- {line}" for line in lines)


def build_files(cfg: dict, features: dict) -> dict[str, dict[str, str]]:
    """Render every file of both skills. Returns {skillKind: {relPath: content}}."""
    from . import analyze, locale as locale_mod, report

    slug = cfg["profileSlug"]
    name = cfg.get("displayName") or slug
    scope = cfg.get("autonomy", {}).get("scope", "draft_only")
    if scope not in SCOPE_NOTES:
        scope = "draft_only"

    data_root = C.expand(cfg["dataRoot"])
    window = (features["decisions"].get("replyWindow") or {})
    stale_minutes = window.get("staleAfterMinutes", 240)
    stale_basis = window.get("basis", "")

    style = features["style"]
    mined = features["decisions"]
    policy = features["policy"]
    people = features["people"]
    examples = features["examples"]
    meta = features["meta"]

    # Rebuild the exact pack and rules the features were measured with, so the
    # rendered prose can never disagree with the numbers it is describing.
    locale_id = (meta.get("locale") or {}).get("id") or "none"
    pack, _ = locale_mod.load(locale_id, data_root)
    rules = analyze.Rules(analyze.load_signals(data_root), pack)
    source_cls = _source_class(cfg)
    id_label = source_cls.ID_LABEL
    # The fidelity report has to state which platform capabilities are missing,
    # and it must do so without opening a network connection during publish.
    # Class attributes plus a default-capability probe are enough and stay offline.
    caps = source_cls.static_capabilities()
    fidelity_cfg = {**cfg, "_sourceCapabilities": caps}

    # The burst cutoff has to be the SAME number the persona's `brief` folds with
    # (published into rules.json by compose). Reading both from `rules` here is what
    # keeps the queue's "N messages in a row" and brief's classification unit from
    # disagreeing — a disagreement that would be invisible in both outputs.
    burst_cfg = rules.threshold("burst", "gapSeconds", 300)
    burst_max_cfg = rules.threshold("burst", "maxMessages", 12)

    # Where the persona skill will live, so its own commands point at itself.
    persona_dir = C.expand(cfg["skillRoots"][0]) if cfg.get("skillRoots") else None

    common_subst = dict(stale_minutes=stale_minutes, stale_basis=stale_basis,
                        data_root=data_root, pack=pack, id_label=id_label,
                        platform_label=source_cls.PLATFORM_LABEL,
                        burst_gap=int(burst_cfg), burst_max=int(burst_max_cfg),
                        skill_dir=str(persona_dir) if persona_dir else "",
                        owner_facts=_owner_facts(cfg),
                        )

    persona: dict[str, str] = {}
    for path in (TEMPLATES / "persona").rglob("*"):
        if path.is_file() and "__pycache__" not in path.parts:
            rel = path.relative_to(TEMPLATES / "persona").as_posix()
            persona[rel] = _subst(path.read_text(encoding="utf-8"), slug, name,
                                  scope, **common_subst)

    persona["references/style.md"] = compose.render_style(
        name, style, meta["window"], pack, rules)
    persona["references/decisions.md"] = compose.render_decisions(name, policy, mined)
    persona["references/scenes.md"] = compose.render_scenes(
        name, style, mined, examples, rules)
    persona["references/people.md"] = compose.render_people(
        name, people, policy, id_label)
    persona["references/limits.md"] = compose.render_limits(name, meta, style, mined)
    persona["references/fidelity.md"] = report.render_fidelity(features, fidelity_cfg)
    # The machine-readable twin of decisions.md. `scripts/` and `references/` are
    # sibling directories in the installed skill, so persona.py reads this without
    # importing the forge — the published skill stays self-contained.
    persona["references/rules.json"] = json.dumps(
        compose.render_rules(features, pack, rules, cfg, id_label),
        ensure_ascii=False, indent=2) + "\n"
    persona["scripts/imruntime.py"] = RUNTIME_SRC.read_text(encoding="utf-8")
    persona["references/.config-path"] = cfg["_path"] + "\n"

    return {"persona": persona}


def _source_class(cfg: dict):
    """The configured source's class — attributes only, never instantiated.

    Publish must stay offline: constructing a source can require a CLI binary or
    a readable export path, neither of which should be able to break a rebuild
    that only needs the platform's vocabulary and declared capabilities.
    """
    from .sources import BaseSource, get_source_class
    kind = (cfg.get("source") or {}).get("kind", "dws")
    try:
        return get_source_class(kind)
    except SystemExit:
        return BaseSource


def skill_roots(cfg: dict) -> list[Path]:
    """The persona directory for each configured skill root.

    Every write in this module funnels through here, which is why the placement
    check lives here rather than in `init`: a host application calls `publish`
    against a config file it wrote itself, so a check that only ran at `init`
    time would never see it.
    """
    out = []
    for root in cfg["skillRoots"]:
        persona_dir = C.expand(root)
        _assert_publishable(persona_dir, cfg)
        out.append(persona_dir)
    return out


#: Agent configuration directories belonging to whoever is running this, as
#: opposed to a directory the caller owns. `init` defaults here on purpose — a
#: person forging their own persona wants their own agents to load it — but a
#: host application publishing on a user's behalf must not write into them.
_HOST_AGENT_DIRS = (".claude", ".codex", ".cursor", ".config/claude")


def _assert_publishable(target: Path, cfg: dict) -> None:
    """Refuse to publish into the operator's own agent config directories.

    Only enforced when the config says an embedding application owns the output
    (`ownsOutput: true`). Left to the caller's discipline it would eventually be
    forgotten, and the failure is invisible in the worst way: the skill installs
    fine, works fine, and quietly appears in an agent nobody meant to change —
    where an uninstall of the host application will not remove it either.

    A person running the forge for themselves is unaffected; that is the default
    and it stays the default.
    """
    if not cfg.get("ownsOutput"):
        return
    home = C.expand("~")
    try:
        relative = target.resolve().relative_to(home.resolve())
    except ValueError:
        return          # outside the home directory entirely: caller's own tree
    for reserved in _HOST_AGENT_DIRS:
        if relative == Path(reserved) or Path(reserved) in relative.parents:
            raise SystemExit(
                f"refusing to publish into {target}: ~/{reserved} belongs to the "
                f"person running this, not to the calling application. Point "
                f"skillRoots at a directory the application owns (its own user "
                f"data), so uninstalling it actually removes the skill.")


def _owner_backup_path(cfg: dict) -> Path:
    return C.expand(cfg["dataRoot"]) / "owner-blocks.json"


def _load_owner_backup(cfg: dict) -> dict:
    return C.read_json(_owner_backup_path(cfg), {}) or {}


def _save_owner_backup(cfg: dict, blocks: dict) -> None:
    """Persist the owner's hand-written blocks into the DATA ROOT.

    Without this, owner edits live only inside the published skill, so deleting
    the skill destroys them and "delete it and republish to get the same bytes
    back" is false. The data root is the source of truth for everything else;
    owner corrections belong there too.
    """
    if blocks:
        C.write_json(_owner_backup_path(cfg), blocks)


def _is_boilerplate(body: str) -> bool:
    """True if a block holds only the generated hint, i.e. the owner wrote nothing.

    Distinguishing this from a real edit is what lets the newest edit win across
    skill roots: an untouched root must never overwrite a root the owner edited.
    """
    stripped = OWNER_HINT_RE.sub("", body or "").strip()
    return not stripped


OWNER_HINT_RE = re.compile(r"<!--.*?-->", re.S)

#: Files inside the installed skill that a HOST APPLICATION owns, keyed by the
#: config flag that declares them. Added by this repository.
#:
#: `work.md` is the work layer: what this person is responsible for, how they
#: work, and the rules they have stated. Those have no structural signal to
#: measure — you cannot count them out of message lengths or timestamps — so they
#: come from an LLM pass the forge deliberately does not run (its whole premise is
#: zero model calls). The app writes it here because the skill is ONE bundle to
#: whoever loads it, while its provenance is genuinely different.
#:
#: ★ Declared as data rather than hardcoded into `_prune` so the exemption is
#: visible at the config boundary: a reader of `persona-config.json` can see that
#: the forge does not own this file, which is the fact that matters when a
#: rebuilt skill turns out not to be byte-identical to a fresh one.
_EXTERNAL_FILES = ("references/work.md",)


def external_files(cfg: dict) -> frozenset[str]:
    """Skill files the embedding application owns, never generated or pruned here.

    Empty unless `ownsOutput` is set — a person running the forge for themselves
    has no host application writing into their skill, and an exemption that
    applied by default would let a genuinely stale file survive forever.
    """
    if not cfg.get("ownsOutput"):
        return frozenset()
    declared = cfg.get("externalSkillFiles")
    if isinstance(declared, list) and declared:
        return frozenset(str(item) for item in declared if item)
    return frozenset(_EXTERNAL_FILES)


def publish(cfg: dict, features: dict, dry_run: bool = False,
            prune: bool = True) -> dict:
    bundles = build_files(cfg, features)
    written: list[str] = []
    preserved: list[str] = []
    restored: list[str] = []
    pruned: list[str] = []
    # Files the embedding application owns in this same directory — kept, never
    # generated. See `_prune`'s docstring on why the exemption is necessary.
    external = external_files(cfg)

    backup = _load_owner_backup(cfg)
    roots = skill_roots(cfg)

    # Gather owner blocks from EVERY root first. Merging per-root while writing
    # let an unedited root overwrite an edited one, silently discarding the
    # owner's correction — the edit must win regardless of root order.
    # Boilerplate-only entries are dropped so the backup holds real edits only.
    collected: dict[str, dict[str, str]] = {}
    for rel, blocks in backup.items():
        real = {n: b for n, b in blocks.items() if not _is_boilerplate(b)}
        if real:
            collected[rel] = real
    for persona_dir in roots:
        for target, files in ((persona_dir, bundles["persona"]),):
            for rel in files:
                if not rel.endswith(".md"):
                    continue
                dest = target / rel
                if not dest.exists():
                    continue
                for name, body in compose.extract_owner_blocks(
                        dest.read_text(encoding="utf-8")).items():
                    if _is_boilerplate(body):
                        continue          # untouched block carries no intent
                    collected.setdefault(rel, {})[name] = body

    for persona_dir in roots:
        for target, files in ((persona_dir, bundles["persona"]),):
            expected = set(files)
            for rel, content in sorted(files.items()):
                dest = target / rel
                blocks = collected.get(rel) or {}
                if rel.endswith(".md") and blocks:
                    live = compose.extract_owner_blocks(
                        dest.read_text(encoding="utf-8") if dest.exists() else "")
                    content = compose.apply_owner_blocks(content, blocks)
                    for name in blocks:
                        label = f"{target.name}/{rel}#{name}"
                        (preserved if name in live and not _is_boilerplate(live[name])
                         else restored).append(label)
                if not dry_run:
                    C.secure_write(dest, content)
                written.append(f"{target.name}/{rel}")
            if prune and target.exists():
                pruned += _prune(target, expected, dry_run, external)

    if not dry_run:
        _save_owner_backup(cfg, collected)

    # A publish must not silently unlock a locked install: secure_write resets
    # each file to 600, so re-apply the lock the owner asked for.
    locked = bool(cfg.get("lockSkills"))
    if locked and not dry_run:
        set_readonly(cfg, True)

    return {"dryRun": dry_run, "files": len(written),
            "roots": [str(p) for p in roots],
            "ownerBlocksPreserved": sorted(set(preserved)),
            "ownerBlocksRestored": sorted(set(restored)),
            "removedStaleFiles": pruned,
            # Reported so "the forge did not touch this" is observable rather than
            # assumed. A caller comparing `files` against what is on disk would
            # otherwise conclude the extra file is stale forge output.
            "externalFilesKept": sorted(external),
            "readOnly": locked,
            "autonomyScope": cfg.get("autonomy", {}).get("scope", "draft_only")}


def set_readonly(cfg: dict, lock: bool) -> dict:
    """Make every installed skill file read-only (or writable again).

    This is the enforcement half of "skills are products". A loading agent that
    is merely *told* not to tune the skill can still be talked into it; a file it
    cannot open for writing simply fails. The forge is unaffected —
    `common.secure_write` writes a temp file and renames, which needs permission
    on the directory, not the target file — so `publish` keeps working.

    Not a security boundary: whoever owns the files can chmod them back. It stops
    accidental and agent-initiated edits, which is the actual failure mode.

    ## ★ Host-owned files are left writable

    `external_files(cfg)` is skipped. The lock exists to stop a LOADING AGENT from
    tuning the skill at runtime; the embedding application is not that agent — it
    is the other publisher of this bundle. Locking its file to 444 would make the
    app's own rewrite fail with `PermissionError` on the next work-layer refresh,
    and since that path runs on a timer the failure would surface as "the work
    layer silently stopped updating" rather than as a permissions problem.
    """
    external = external_files(cfg)
    changed = []
    skipped = []
    for persona_dir in skill_roots(cfg):
        for target in (persona_dir,):
            if not target.exists():
                continue
            for path in target.rglob("*"):
                if path.is_file() and "__pycache__" not in path.parts:
                    if path.relative_to(target).as_posix() in external:
                        skipped.append(str(path))
                        continue
                    os.chmod(path, 0o444 if lock else 0o600)
                    changed.append(str(path))
    return {"locked": lock, "files": len(changed),
            "hostOwnedFilesLeftWritable": len(skipped),
            "note": ("installed skills are read-only; `forge publish` still "
                     "rebuilds them and re-applies the lock"
                     if lock else "installed skills are writable again")}


def _prune(target: Path, expected: set[str], dry_run: bool,
           external: frozenset[str] = frozenset()) -> list[str]:
    """Remove files a previous version installed that this one no longer emits,
    so a rebuilt skill has no leftovers contradicting the current one.

    Empty directories are removed too. Deleting only the files left v1's
    `agents/` behind as an empty shell — harmless to an agent reading the skill,
    but it broke the guarantee that matters: a freshly published skill must be
    byte-identical to a rebuilt one, and a stray directory is a visible diff.

    ## ★ `external` — files a HOST APPLICATION owns in this same directory

    Added by this repository. The embedding app publishes its own reference into
    the installed skill (`references/work.md`, distilled by a separate LLM pass
    the forge deliberately does not do — see the repo's README on the work layer).
    That file lives in the forge's output directory because the skill is one
    bundle to whoever loads it, but the forge does not generate it.

    Without this exemption the interaction is silent and destructive: the app
    writes `work.md`, the next `forge refresh` prunes it as "a leftover from an
    older version", and the app's own tokens-costing output disappears with no
    error anywhere. The app would then rewrite it on its own schedule, so the file
    would flicker in and out of existence depending on which ran last.

    Exempting is strictly better than the alternatives: making the forge generate
    it would require the LLM layer the forge exists to avoid, and turning prune off
    would let genuinely stale forge output accumulate.
    """
    removed = []
    for path in list(target.rglob("*")):
        if "__pycache__" in path.parts:
            if path.is_dir() and not dry_run:
                shutil.rmtree(path, ignore_errors=True)
            continue
        if not path.is_file():
            continue
        rel = path.relative_to(target).as_posix()
        if rel in external:
            continue          # owned by the host application, not by this forge
        if rel not in expected:
            removed.append(f"{target.name}/{rel}")
            if not dry_run:
                path.unlink(missing_ok=True)

    # Sweep now-empty directories, deepest first so nested shells collapse.
    # External files count toward "this directory is still in use", or the sweep
    # would remove the directory holding a file it just decided to keep.
    expected_dirs = {str(Path(rel).parent) for rel in expected}
    expected_dirs |= {str(Path(rel).parent) for rel in external}
    for path in sorted(target.rglob("*"), key=lambda p: -len(p.parts)):
        if not path.is_dir() or "__pycache__" in path.parts:
            continue
        rel = path.relative_to(target).as_posix()
        if rel in expected_dirs:
            continue
        if not any(path.iterdir()):
            removed.append(f"{target.name}/{rel}/")
            if not dry_run:
                path.rmdir()

    # ...and the skill's own root, when this publish emits nothing for it at all.
    # `rglob` never yields the directory it is called on, so the loop above cannot
    # reach it. Leaving the shell would break the guarantee this function exists
    # for: a rebuilt install must be byte-identical to a fresh one. It also makes
    # an empty directory look like an installed skill to anything counting them.
    if not expected and target.exists() and not any(target.iterdir()):
        removed.append(f"{target.name}/")
        if not dry_run:
            target.rmdir()
    return removed
