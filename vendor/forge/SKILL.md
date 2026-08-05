---
name: im-persona-forge
description: Distill how someone communicates in IM work chat into a ready-to-use persona skill — their expression style, per-recipient tone, and crucially their decision policy (what they answer, hand off, or never settle alone). Use to initialize a persona, pull IM history into a local corpus, rebuild and publish the persona skill, set the autonomy scope, check language or platform coverage, or diagnose why an inbound-message agent has gone quiet.
---

# im-persona-forge

A forge, not a persona. It ships with zero personal data, and it is
language-agnostic and platform-agnostic by construction. On the owner's own
machine, using their own credentials, it distills how *they* handle work chat
into two installed skills:

- **`<slug>-persona`** — decides whether a message is theirs to answer, then
  drafts or sends it in their voice. Discovery is the host's job: whatever
  dispatches messages already knows which one is new.

## The architecture in one rule

**Skills are products. The corpus is the source.**

```
IM platform ──pull──▶ local corpus (SQLite, full fidelity, 700/600)
     │                     │
 source adapter            ├── build ──▶ measured features
 (dws / jsonl)             │      ↑
                           │   locale pack (zh-CN / en / null)
                           └── publish ─▶ <slug>-persona
```

Delete an installed skill and `publish` reproduces it exactly. Every improvement
is made here and re-published — a loading agent never tunes the persona at
runtime. Hand-written corrections live in `<!-- owner:begin -->` blocks inside
the published files and survive every rebuild.

## Three seams that keep it general

| Concern | Lives in | Rule |
|---|---|---|
| Language | `forge/locales/*.json` | **No natural-language text in `forge/*.py`.** Enforced by `forge scan --scope repo`. |
| Platform | `forge/sources/*.py` | Every read goes through `MessageSource`; an adapter declares what it cannot do. |
| Thresholds | `signals.json → thresholds` | One named place per cutoff, versioned into `rulesVersion`. |

`rulesVersion` is `signals-v3+<pack>@<version>`, so changing the locale pack
invalidates derived numbers exactly like changing a threshold does.

**`NULL_PACK` is the important case.** A corpus in a language nobody has written
a pack for still produces a valid skill: the structural layers (length, latency,
silence, reciprocity, opener distribution) are fully measured, every lexical
measurement honestly reports absent, and the published `fidelity.md` says so.
It never guesses, and it never lets "unmeasured" read as "they never do this".

## The published skill must be executable by a weak model

A skill that is only a well-written document makes reply quality a property of
*the model reading it*, not of the forge. A weaker model given five reference
files will skip the live context, forget to scope a lookup to the recipient, read
a measured 92% reply-rate as permission to answer anything, and never think to ask
whether a fact is in the corpus at all.

None of those are language failures — they are orchestration failures, and
orchestration belongs in a script. So every decision that can be made
mechanically is the return value of a command, not a paragraph of advice:

| Decision | Command |
|---|---|
| What is this message answering? | `brief.respondingTo` |
| Which ask kind, which risk classes? | `brief.classification` (locale-pack regexes) |
| Reply, draft, hand off, or stay silent? | `brief.verdict` + `because` |
| Is this fact in the corpus at all? | `facts` → `evidence` / **`none`** |
| Does this draft match their habits? | `check` → `pass` / `warn` / `block` |
| May this be sent? | scope + allowlist + length **+ the draft's own risk classes** |

`references/rules.json` is the machine-readable twin of `decisions.md` — the same
policy, one rendering for a reader (with rates, so a capable model can weigh
them) and one for a script (conclusions only). A self-test invariant asserts the
two agree exactly; two sources of truth for "may an agent answer this" would
drift silently.

The most consequential gate is in `runtime.DwsClient.send`: it now inspects the
**outgoing text**, not only the recipient, and **fails closed** when the patterns
are unavailable — missing *or* empty, since a pack that detects no risk classes
would otherwise let every draft pass a check that never ran. It runs *before* the
scope check, because a draft that states an approval is wrong in every scope —
reporting "sending is disabled" first would teach the caller that widening the
scope is the fix.

## Commands

```bash
python3 -m forge doctor      # start here when anything is wrong
python3 -m forge init  --display-name "<real name>" --since 2026-01-28
python3 -m forge pull  --since full        # first backfill; then --since auto
python3 -m forge build                     # corpus → measured features
python3 -m forge publish                   # install both skills
python3 -m forge refresh                   # pull → build → publish (routine)
python3 -m forge locales                   # installed packs; which fits this corpus
python3 -m forge sources                   # data sources and their capabilities
python3 -m forge report                    # coverage; --rubric for the blind test
python3 -m forge autonomy --scope allowlist --allow "<name>"
python3 -m forge lock                      # installed skills → read-only
python3 -m forge export --out <file>.tar.gz # hand to an agent elsewhere
python3 -m forge inspect                   # what is stored and what was measured
python3 -m forge scan --scope repo          # is this repo safe to share?
python3 -m forge selftest                   # offline, no network, no personal data
```

Everything prints JSON. Anything touching a remote or writing accepts `--dry-run`.

Non-DingTalk platforms come in through the `jsonl` source — export your history,
convert it to the schema in `forge/sources/jsonl.py`, and the whole engine works
unchanged:

```bash
python3 -m forge init --source jsonl \
  --source-option path=~/exports/slack \
  --source-option 'identity={"openIds":["U0123456"],"name":"Real Name"}'
```

`identity` must be explicit. Every id in an export looks alike, and guessing the
owner wrong is the worst failure available — it attributes someone else's
messages to them and produces a confident, wrong persona.

## Giving the skill to another agent

The point of `lock` is that "do not tune this at runtime" stops being a request
and becomes a property of the filesystem:

```bash
python3 -m forge lock     # every installed file → 444
```

A loading agent gets `PermissionError` if it tries to edit `SKILL.md` or any
reference. Reads are unaffected, and `forge publish` still rebuilds them (it
writes a temp file and renames, then re-applies the lock), so updates keep
flowing from the forge only. `--unlock` reverses it.

Same machine, another agent → nothing else to do; the skill is already in
`~/.claude/skills/` and `~/.codex/skills/`.

Another machine → `forge export`. The bundle is Markdown + scripts only: no
corpus, no config, no logs, no absolute paths. `recall` / `who` / `send` report
`degraded: markdown-only` there, while the decision layer, style, people and
scenes work fully.

## What gets distilled

| Layer | Published as | Source of truth |
|---|---|---|
| **Decision policy** | `decisions.md` | every incoming ask, answered *and* ignored |
| Expression style | `style.md` | their own messages, measured |
| Per-recipient tone | `people.md` | interaction volume + overrides |
| Situations | `scenes.md` | scene-tagged messages + real turns |
| Honest limits | `limits.md` | window, counts, what chat cannot show |
| **Coverage** | `fidelity.md` | which layers had evidence, and which did not |

The decision layer is what makes the persona usable unattended. Mining silence
alongside replies is what makes it possible: a question they consistently left
unanswered is evidence about what is not theirs to answer, and it exists nowhere
else.

`fidelity.md` is what makes it safe to hand on. It reports *coverage*, never
quality — and behavioral fidelity is deliberately not self-assessed: a persona
grading its own likeness produces a number that looks like evidence and is not
one. `forge report --rubric` emits a blind two-agent protocol instead, whose
result the owner pastes into an owner block. The rubric contains the answer key
and stays in the data root, never in a published skill.

## Boundaries

- **The corpus keeps everything locally** — every message, real names, real ids —
  because an agent cannot judge "is this mine to answer" from hashes. It lives at
  600 inside a 700 data root, is never shared, and is `.gitignore`d. Credentials
  are the one thing scrubbed on write.
- **Published skills carry no raw ids, no paths, no credentials.** `forge scan
  --scope skill` enforces this and runs automatically on publish, checking every
  known platform's id shape rather than one vendor's.
- **Default autonomy is `draft_only`.** Scope only widens *who* may receive a
  reply, never *what* may be said. The risk gate (commitments, approvals, money,
  scheduling, personnel, external positions, org decisions, destructive actions)
  holds in every scope — and a risk class the active locale cannot even detect is
  treated as never-settle, not as absent.
- **Never commit a corpus, config, ledger, rubric, or published persona.**

## Reading order for an operating agent

1. `README.md` — the full pipeline, the failure modes it was built against.
2. `forge/locale.py` — how a language pack is chosen, and what `NULL_PACK`
   guarantees when none fits.
3. `forge/sources/__init__.py` — the platform contract and the normalized
   message schema.
4. `forge/signals.json` — every language-independent threshold; changing one
   changes `rulesVersion` and therefore every derived number.
5. `forge/decide.py` — how the decision policy is mined.
6. `forge/compose.py` — how measurements become skill text, and how owner blocks
   are preserved.
