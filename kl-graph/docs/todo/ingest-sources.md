# Ingest Additional Data Sources

**Status:** Loaders implemented (chat, minutes, mail, wiki, doc, aitable,
calendar, report) + unified SQLite `chunks` store + FTS over all sources.
Drive + contacts deferred; end-to-end cross-source retrieval pending re-ingest.
**Depends on:** the `Chunk` abstraction (done — `kl_graph/models/types.py`) and the
unified `chunks` Qdrant collection (done). This is the payoff those enable.

> Annotation tags used below (see AGENTS.md): `[!RED]` = pay extra attention;
> `[REMARK]` = anticipated approach; `[Q agent]`/`[Q human]` = open question,
> answered on the next line with `[A human]`/`[A agent]`. Answered threads stay.

## Goal

Ingest non-chat content into the same knowledge graph as chat, so retrieval
spans all sources. A real export was inspected to ground this plan:
`~/Desktop/projects/rag_research/dws-exports/` (DingTalk, corp ExampleCorp,
user 孙亮, 2026 scope, 882 MB). See its `_manifest.json` for authoritative
counts and documented gaps.

## What the export actually contains

[Q human]: what types are those products? Can you target to these product types (like markdown and json, and refer to the ragflow parsers, or just reuse its parsers)
[A agent]: The 11 products reduce to a small set of *underlying* content types, and
RAGFlow already has a parser for each. Mapping:

- **markdown/prose** → wiki `.md`, docs `.md`, mail `markdownBody`. RAGFlow:
  `deepdoc/parser/markdown_parser.py` (`RAGFlowMarkdownParser`) — splits tables
  out, chunks by `chunk_token_num`. Reusable directly.
- **structured JSON records** → calendar, aitable, work-reports, contacts,
  minutes envelopes. RAGFlow: `deepdoc/parser/json_parser.py`
  (`RAGFlowJsonParser`, size-bounded recursive split, handles JSONL). Reusable
  for splitting, but we still need our own record→text template (item 2 below)
  because embeddings want prose, not raw JSON.
- **binary office/pdf** → `drive/files/`. RAGFlow: `pdf_parser.py`,
  `docx_parser.py`, `excel_parser.py`, `ppt_parser.py`, `html_parser.py`.
  These are heavy (OCR, layout, deep deps). `[REMARK?]` recommend the local
  `firecrawl_parse` tool instead for drive; only pull in RAGFlow's binary
  parsers if firecrawl proves insufficient.
  [Q human]: what do you mean the firecrawl_parse?
          there is no such tool when testing.
  [A agent]: Correct — scratch that. `firecrawl_parse` is an MCP tool backed by a
          *self-hosted* Firecrawl API; it is not a Python library and is not in
          this environment, so the plan must not depend on it. Revised binary
          strategy for `drive/` (only 24 files, Medium priority):
          - **Default: lightweight pure-python libs**, one per format — `pypdf`
            (pdf), `python-docx` (docx), `openpyxl` (xlsx), `python-pptx` (pptx).
            Small deps, no OCR, good enough for text extraction.
          - **Or** Microsoft `markitdown`, a single dep that converts
            pdf/docx/xlsx/pptx → markdown (then reuse the markdown path).
          - **Or** vendor RAGFlow's `deepdoc` binary parsers only if the above
            miss layout/scanned content — heaviest, last resort.
          Decision: start with `markitdown` (one dep, unifies to markdown);
          fall back to per-format libs if it chokes on a file. `drive/` can also
          be deferred entirely (24 files) without blocking the other sources.
- **chat** → already handled by our `message_loader.py`.

So: **reuse RAGFlow's `markdown_parser` and `json_parser`** (small, pure-python,
Apache-2.0 — vendor the two files or depend on the pieces), **map each product
to one of these underlying types**, and keep binary parsing on a lightweight
library (`markitdown` / per-format libs — see the binary answer above, NOT
firecrawl). Each product still needs a thin adapter that unwraps the envelope +
serializes records to text before handing prose to the shared chunker.

The export is **11 products**, not the 3 (chat/docs/calendar) the earlier draft
assumed. Per-product volume, on-disk shape, and value (counts from
`_manifest.json`):

- **`chats/`** — 130 convs, 40,348 msgs. `personal|groups/<name>/history.json`
  → `{…, messages:[{content, createTime, openConversationId, openMessageId,
  sender, senderOpenDingTalkId}]}`. ✅ already ingested; format matches
  `message_loader.py`.
- **`minutes/`** (AI听记) — 72. `details/<id>.json` → `{uuid, title, summary,
  todos, keywords, transcription:{paragraphList:[{paragraph, speakerDisplay,
  nickName, startTime, sentenceList}]}}`. **Highest value** — meeting
  transcripts + action items.
- **`mail/`** — 703 msgs, 217 attachments. `bodies/<id>.json` →
  `{message:{subject, from, toRecipients, ccRecipients, receivedDateTime,
  markdownBody}, success}`. High — decisions/threads.
- **`wiki/`** — 2 spaces, 2,788 docs. `contents/<nodeId>__<title>.md` (markdown
  - inline HTML metadata comment: `nodeId`/`workspace`/`url`). High — dense
  authored knowledge.
- **`docs/doc/`** — 12 docs. `<id>.md` + `<id>.title`. High.
- **`docs/sheets/`** — 1. worksheets/cells JSON. Medium.
- **`docs/tables/`** — 288 AITABLE bases, ~45,890 records. `<baseId>.json` →
  `{baseId, baseName, tables:[{tableId, tableName, recordCount,
  records:[{recordId, cells}]}]}`. Medium — structured, huge.
- **`drive/`** — 24 files. `files/…` (binary: pdf/docx/xlsx/ppt) +
  `listing.json`. Medium — needs binary parsers.
- **`calendar/`** — 111 events. `details/<id>.json` → `{arguments,
  result:{summary, description, start, end, attendees:[{displayName,
  responseStatus}], organizer, meetingRooms, isAllDay, categories}, success}`.
  Medium — entity↔time links.
- **`contacts/`** — 58 depts + members. `self.json`, `departments.json`,
  `members/…`. Medium — org structure for entity resolution.
- **`work/`** — 1 sent + 56 received 日志. `reports/received.json` = index;
  `reports/entries/<reportId>.json` = body → `{result:{creatorName, deptName,
  createTime, report_content:[{key, value}]}, success}`. Medium — the entry Q&A
  bodies are the content.

## Design (unchanged in principle, expanded in scope)

Each source becomes a **source adapter** (the analog of `message_loader.py`)
that parses its raw format into `Chunk`s, reusing the Phase-B extraction /
embedding / edge pipeline unchanged:
  -[REMARK]: I see the message_loader.py is in ingest folder,
          since now we have multiple adapters, the xxx_loader.py should be
          in their own folder.
  -[A agent]: Agreed. Proposed: `kl_graph/ingest/loaders/` with one module per
          source (`message_loader.py`, `minutes_loader.py`, `mail_loader.py`,
          `wiki_loader.py`, `doc_loader.py`, `aitable_loader.py`,
          `calendar_loader.py`, `drive_loader.py`, `report_loader.py`) plus a
          shared `base.py` (the `SourceAdapter` ABC + `_unwrap()` +
          timestamp helpers). Move the existing `message_loader.py` into it and
          fix imports. This is a self-contained refactor; can land before the
          new loaders.

```
raw source → [adapter] → Chunk(content=extracted_text,
    source_type="minutes"|"mail"|"wiki"|"doc"|"aitable"|"calendar"|"report"|...,
    source_ref=<file/doc/msg id or URL>, timestamp=<unix ms>, metadata={...})
```

- `Chunk.content` is always **extracted text** (what gets embedded/searched).
  [!RED] This should be tested to make sure its 100% workability.
- `Chunk.source_ref` points back to the producer (file name, doc id, URL, sender).
  [REMARK] This is optional. You do not have to have a source_ref.
        Having a source_ref would help the agent better source and find the origin.
- Format-specific fields go in `metadata`.

## Modifications this export forces on the plan

These are the concrete deltas vs. the original draft:

1. **Unwrap CLI envelopes first.** Most non-chat files are wrapped, and the shape
   differs per product — the adapter layer must normalize before parsing:
   [Q human]: How would you intent to do these? shouldn't each type get a chunk child class?
   [A agent]: Two separate concerns, don't conflate them:
   - **Parsing/unwrapping** is per-source *behavior* → belongs in the per-source
     **adapter/loader** (a `SourceAdapter` subclass), not in a Chunk subclass.
     `_unwrap()` is a shared helper the adapters call.
   - **`Chunk`** stays a *data* class. We do NOT need a Chunk child per product —
     `source_type` + the free-form `metadata` dict already distinguish them
     (calendar puts attendees in metadata, aitable puts base/table/recordId,
     etc.). We only subclass Chunk when a source needs extra *typed, queried*
     columns (like `Message` added sender/conversation_id/reply_to). Most
     sources won't; they'll be plain `Chunk` with a populated `metadata`.
     So: many adapters, few Chunk subclasses.
   - calendar → `{arguments, result, success}` (payload in `result`)
   - mail → `{message, success}` (payload in `message`)
   - minutes sub-objects → `{ok, data, raw_envelope}` (`summary`, `todos`,
     `keywords`, `transcription` are each independently wrapped)
   A small `_unwrap(obj)` helper shared across adapters.

2. **Structured records need serialize-to-text, not just extraction.** calendar,
   contacts, aitable, and work-reports are *records*, not prose. Each needs a
   deterministic record→text template before embedding, e.g. calendar:
   `"{summary} | {start}–{end} | 参会: {attendee names} | {description}"`.
   aitable rows: flatten `cells` to `"col: val | col: val"`.

3. **AITABLE volume + chunking.** ~45,890 records across 288 bases will dwarf the
   40K chat messages. Decide granularity (one chunk per record vs. per table vs.
   per base) and whether to ingest all bases or a whitelist. Likely 1 chunk/record
   with `metadata={base, table, recordId}`, but gate behind a per-source limit.

4. **Long-document chunking is now real.** Wiki (2,788 docs) and `docs/doc` are
   long markdown; chat's "one message = one chunk" doesn't apply. Add a splitter
   (by heading / token window with overlap). Wiki files carry an inline HTML
   comment (`nodeId`/`workspace`/`url`) — parse it into `source_ref` + metadata,
   then strip it from `content`.

5. **Minutes are two chunk kinds.** Emit (a) a summary/keywords/todos chunk and
   (b) transcript-paragraph chunks (each `paragraphList` item has `speakerDisplay`
   - timestamps — treat like a mini-message with a real speaker entity). The
   `todos.data.actions` are decision-like facts worth their own extraction.

6. **Binary files need parsers.** `drive/files/` holds real pdf/docx/xlsx/ppt.
   Use a lightweight extractor — `markitdown` (pdf/docx/xlsx/pptx → markdown) or
   per-format libs (`pypdf`/`python-docx`/`openpyxl`/`python-pptx`) — then chunk
   as in (4). (NOT `firecrawl_parse`; it needs a self-hosted service not present
   here. See the binary answer under "What the export actually contains".)

7. **Timestamp normalization varies per source.** chat `createTime` string,
   calendar ISO-8601 with tz, mail `receivedDateTime` Z, minutes epoch-ms strings,
   reports `YYYY-MM-DD HH:MM`. Each adapter must produce unix-ms for `Chunk.timestamp`.

8. **Contacts feed entity resolution, not chunks.** `contacts/` (depts + members)
   is better used to seed/disambiguate Person entities (real names, 花名, dept)
   than embedded as retrieval chunks. Consider wiring it into
   `entity_disambiguation` rather than the chunk path.

9. **Media/attachments are references, not content.** Chat media binaries were
   intentionally not downloaded (CDN URLs inline in text); mail has 217
   attachments. Keep these as `source_ref`/metadata links, don't try to embed.

## Implementation checklist

- [x] Generalize the SQLite `messages` table → `chunks` + per-source detail
      tables (companion machine-TODO). **Blocks** persisting non-chat chunks.
      - `[!RED]` This is the hard prerequisite — every non-chat loader below is
        blocked until the SQLite side can store a generic chunk. Do it first.
      - `[Q agent]` Detail-table-per-source (`message_details`, `minutes_details`,
        …) vs a single `metadata` JSON column on `chunks`?
        [A human]: I think there should be a mixed table, but there should be a col
                  to also log each type so that when specific type are needed, we c
                  we can quickly filter the specific type.
        `[DONE]` Mixed `chunks` table (id, content, source_type, timestamp,
                  source_ref, embedding_id, metadata JSON) + `source_type` column
                  + `idx_chunks_source_type`. `insert_messages` dual-writes:
                  chat-specific cols stay in `messages`, generic fields go to
                  `chunks`. Verified: `test_loaders.py::test_sqlite_chunk_roundtrip`.
- [x] Shared `_unwrap()` + per-source timestamp→unix-ms helpers.
      `[DONE]` `loaders/base.py`: `unwrap()` + `to_unix_ms()` (epoch s|ms,
                ISO-8601 Z/offset, space datetime; never raises). Tested.
- [x] `minutes_loader.py` — summary/todo chunk + per-paragraph transcript chunks;
      speakers → Person entities; `todos.actions` → decision facts.
      - `[REMARK]` Anticipated: ingest minutes first (highest signal). Emit the
        summary/keywords/todos chunk before the per-paragraph transcript chunks.
      - `[Q agent]` Group transcript into one chunk per speaker-turn, or a fixed
        token window? Turns preserve attribution but vary wildly in length.
        `[A human]` I do not think one chunk per spealer-turn is a good idea, but I
                  also do not have a good idea, can you propose?
        `[A agent]` Proposal: **token-budgeted merge of consecutive paragraphs**
                  (RAGFlow's `naive_merge` pattern), with the speaker label kept
                  **inline** so attribution survives:
                  - Walk `paragraphList` in order; greedily merge paragraphs into
                    a chunk until ~256–512 tokens, then start a new chunk (small
                    overlap, e.g. carry the last paragraph, for context).
                  - Prefix each paragraph inside the chunk with its speaker:
                    `"赵明: …\n张伟: …"`. Attribution is preserved as text even
                    across speaker changes within a chunk.
                  - Chunk metadata: `{speakers:[distinct names], start_ms, end_ms,
                    minutes_uuid}`; `timestamp` = first paragraph's `startTime`.
                  This gives size-stable chunks (good for embedding), never
                  splits mid-sentence, and keeps who-said-what. Speaker turns
                  become entities via the normal extraction pass.
        `[DONE]` Token-budgeted merge (char-budget proxy, no tokenizer dep);
                  summary chunk emitted first; keywords + todo `actions` folded
                  into the summary. Ordering + both-kinds verified on the export.

- [x] `mail_loader.py` — subject+markdownBody → chunk; from/to → entities.
      - `[Q agent]` `bodyHasMore`/`bodyTotalLength` exist — some bodies are
        truncated in the export. Ingest the truncated body as-is, or skip/flag?
        `[A human]` Ingest the truncated body as-is.
        `[DONE]` Ingested as-is; `metadata.truncated` + `body_total_length` flag it.
- [x] `wiki_loader.py` + `doc_loader.py` — markdown splitter; parse inline
      nodeId/workspace/url metadata into `source_ref`.
      `[DONE]` Heading-aware char-budgeted `_split_markdown`; wiki inline HTML
                comment → `source_ref`(url)+metadata, stripped from content;
                `doc` reuses splitter + sibling `.title`. (Both in `wiki_loader.py`.)
- [x] `aitable_loader.py` — record→text flattening; per-source volume cap.
      - `[!RED]` ~45,890 records will dominate the graph (>1× the 40K chat msgs).
        A volume cap / whitelist must be decided before ingest or it swamps
        retrieval and community detection.
      - `[Q agent]` Ingest all 288 bases or a whitelist? And 1 chunk per record,
        per table, or per base?
        `[A human]` Let's do 1 chunk per table for now.
        `[DONE]` One chunk per non-empty table (not per record). Each table
                  serialized under an 8000-char cap (`_TABLE_CHAR_CAP`); overflow
                  records dropped with a note. Optional `AITABLE_BASE_LIMIT` env
                  caps # bases. Verified: `test_aitable_one_chunk_per_table`.
- [x] `calendar_loader.py` — event→text; attendees → entity↔time links.
      `[DONE]` Event→text (summary/time/organizer/participants/description);
                attendees kept in metadata.
- [ ] `drive_loader.py` — binary parse via a lightweight lib (`markitdown` /
      per-format libs), then chunk. **Deferred** (24 files, needs a new dep; see
      the binary answer above — NOT firecrawl). Not blocking other sources.
- [x] `report_loader.py` — read `reports/entries/<id>.json` bodies (`report_content`
      key/value pairs), not just `received.json`; creator/dept → entities.
      `[DONE]` Reads entry bodies; key/value pairs serialized; creator/dept in metadata.
- [ ] `contacts` → entity seed/disambiguation path (not a chunk adapter).
      - `[REMARK]` Anticipated: feed contacts into `entity_disambiguation`
        (real names / 花名 / dept) rather than embedding them as chunks.
      **Deferred** — belongs in the entity-disambiguation path, not chunk loaders.
- [x] Chunking strategy config (heading/token-window + overlap) shared by long-doc sources.
      `[DONE]` Shared `_split_markdown` (heading split → paragraph windowing) for
                wiki + doc; minutes/aitable use their own budgeted mergers.
- [x] Source attribution end-to-end: `source_type` flows into retrieval `type`.
      `[DONE]` `source_type` is a SQLite column + Qdrant `chunks` payload index;
                FTS mirror now built from `chunks` (all sources).
- [ ] Verify cross-source retrieval: one `search -c chunks` returns the globally
      most-similar content regardless of source; `source_types` filter narrows.
      **Pending a full re-ingest on the GPU box** (embeddings/Qdrant not reachable
      here). Loaders + storage + FTS are unit-tested; end-to-end check runs after re-ingest.

## Open questions from the human

- `[Q human]`
  `[A agent]`
