# DWS Export Roadmap

Design notes for improving DingTalk data exported through DWS.

Each entry: what's limited, why, evidence, sketch of the improvement.
These are **deferred design gaps**, not current bugs — the pipeline
produces correct data given its declared scope.

---

## 1. `export_work.py` mixes org-wide platform metadata into the user dataset

**Where**: `export_work.py` calls `report template list` and
`oa approval list-forms`, which DWS returns **org-wide**, not
user-scoped.

**Evidence**: on a personal run — 1053 records, of which
- 1000 are `report_template` (e.g. `某人的日志`, `PC-Daily`,
  `某团队周报`) — other people's private / other teams'
  templates
- 51 are `oa form_template` (organization-wide approval forms)
- **2** records are actually mine (1 todo + 1 approval)

Currently these are parked under a separate
`generic:work/platform_metadata` scope with an explicit
`note: "Org-wide dictionaries..."`, so they're at least segregated
and identifiable — but they still land in `records.jsonl`, so any
downstream that scans records without filtering by scope sees 99.8%
noise.

**Improvement sketch**: split into a dedicated
`export_org_metadata.py` producing its own dataset (not mounted
under the personal workspace), or add `--skip-platform-metadata`
to `export_work.py`. Ideal fix requires DWS to expose a `--scope mine`
flag on `report template list` / `oa approval list-forms`.

---

## 2. Snapshot-tier exports are intentionally shallow

**Where**: `export_calendar.py`, `export_contacts.py`, `export_minutes.py`,
`export_attendance.py`, `export_drive.py`, plus the personal-data
portions of `export_work.py`.

**Current scope** (each script's docstring says "Snapshot only" and
manifest carries `"completeness": "snapshot"`):

| Script | What it currently covers | What's missing |
|---|---|---|
| `export_attendance.py` | vacation type dictionary (9 items) | punch records, leave applications, overtime |
| `export_calendar.py` | today's events + calendar list | full history, recurring event expansion |
| `export_contacts.py` | self card + org role labels | dept tree, dept members, reporting relations |
| `export_drive.py` | last 20 recent + favorites | full file tree, file binaries |
| `export_minutes.py` | meeting list + hot words + tags | transcripts, summaries, action items |
| `export_work.py` (personal side) | first 20 todos (unpaginated) | rest of todo history |

**Reason**: these were built as "quick reconnaissance of what DWS
returns", not production collection. Each script's docstring is
explicit about this.

**Improvement sketch**: pick one at a time and elevate to the
`export_chat.py` / `export_wiki.py` / `export_mail.py` style
(pagination + per-item detail fetch + resume). No shared blocker —
each is independent work.

---

## 3. `docs_doc` / `docs_tables` have no export script

**Reason**:
- `docs_doc`: `export_wiki.py` already picks up every alidoc that
  lives inside a wiki space. "Standalone alidocs outside any wiki
  space" don't appear to exist in the DWS surface — every alidoc
  I've seen is attached to a space.
- `docs_tables` (DingTalk sheets / AITABLE): DWS may or may not
  expose these — not investigated.

**Improvement sketch**: if standalone `docs_doc` truly exists,
write `export_docs.py`. For `docs_tables`, first probe DWS
(`dws sheet --help`, `dws table --help`, `dws aitable --help`)
to see the surface.

---

## 4. Media downloader is stdout-parsing, not structured

**Where**: `export_chat.py` `download_media()` derives the saved file
path from `dws chat message download-media` stdout ("下载完成: <path>")
and confirms via `os.stat`.

**Why it works today**: `$iwE...` mediaIds go to `ddmedia/<stem>.<ext>`,
`@lQ...` go to `<outdir>/<stem>_<W>_<H>.<ext>`, OSS URLs go to
`oss_files/<basename>` — all three patterns are handled.

**Future fragility**: any new mediaId sigil (e.g. `&...`, `#...`) or
filename-scheme change on DWS side breaks the lookup. `lstrip("$@")`
would need extending; the `_lookup_index` heuristics would need new
prefix branches.

**Improvement sketch**: ask DWS to return a structured JSON result
from `download-media` (`{path, media_id, size}`), or produce our own
media manifest during download and skip filename parsing entirely.
