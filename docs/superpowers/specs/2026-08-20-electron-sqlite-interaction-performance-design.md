# Electron SQLite Interaction Performance Design

**Date:** 2026-08-20

## Problem

On the current upstream `main` branch, the desktop window becomes unresponsive shortly after launch or when navigating Persona-related views. macOS shows the spinning wait cursor as soon as pointer events reach the window.

Fresh process sampling shows the Electron main thread blocked inside `better-sqlite3` `Statement.all()` / SQLite B-tree page reads while the renderer remains mostly idle. The affected local vault is approximately 3 GB with roughly 220,000 messages and more than 200,000 Persona inbox rows. Packaging does not change these synchronous SQL paths, so producing a package is not a fix.

## Scope

This change improves the existing Electron architecture. It does not rewrite the application as a web service and does not change product behavior.

The hot paths in scope are:

- `PersonaService.attach()` and `snapshot()`;
- `PersonaService.conversations()` and `drafts()`;
- the dynamic `persona_conversation_exclusions` classification;
- message lookup used by legacy Persona drafts;
- per-conversation peer lookup in `PersonaConfigRepository.listWithConversations()`;
- repeated Persona read-model queries in a single renderer refresh cycle.

## Performance Requirements

On an isolated copy-on-write snapshot of a vault comparable to the observed 3 GB / 220k-message dataset:

- Persona attach may perform one bounded classification pass and must complete within 15 seconds.
- `snapshot()` must complete within 1 second.
- `conversations()` must complete within 1 second.
- the first attention-task aggregate must complete within 2 seconds if that aggregate exists on the target branch.
- repeated reads with no database changes must complete within 300 ms.
- no user interaction may synchronously block the Electron main thread for 5 seconds or longer.

Performance tests must print only durations and row counts. They must not print message text, names, identifiers, paths, or credentials.

## Architecture

### 1. Query-plan repair

Add append-only vault migrations for the exact lookup shapes observed in query plans:

- `(conversation_id, external_id)` for legacy draft-to-message lookup;
- a partial peer lookup index on `(conversation_id, sender_external_id)` where `is_self = 0` and `sender_external_id IS NOT NULL`;
- any additional index only after an `EXPLAIN QUERY PLAN` and before/after benchmark proves it is required.

Use `INDEXED BY` only where SQLite demonstrably ignores the correct index. Every hint must have a migration-backed index test.

### 2. Dynamic-exclusion lifecycle

The dynamic bot/self-conversation view remains the single classification source. It must not be expanded on every UI read.

- Build the exclusion map once when a vault is attached.
- Refresh only conversations touched by message, conversation, or actor changes.
- Keep store repository defaults unchanged for callers that do not provide a precomputed exclusion set.
- Use the cached set in Persona UI read paths.

### 3. Read-model reuse

Cache expensive read-model results only while the SQLite connection has no intervening writes. Use SQLite connection change counters or explicit invalidation at all Persona state transitions. Cache invalidation must cover direct repository writes through the same connection.

Daily/summary views that consume the same attention aggregate must share one result instead of recomputing it synchronously.

### 4. Main-thread protection

Instrument Persona IPC reads with bounded duration logs that include operation name and elapsed milliseconds only. Do not log returned data. If query-plan and reuse work do not satisfy the performance targets, move the remaining read-only aggregate to a dedicated worker in a later task; do not preemptively introduce worker complexity.

## Behavioral Invariants

- Dynamic bot and self-chat exclusions remain identical to `persona_conversation_exclusions`.
- A newer inbox failure is not hidden by an older Agent run.
- A new pending draft supersedes an older disposed draft for the same trigger.
- Legacy drafts are matched within their own conversation, never by a bare external ID across channels.
- A later human reply closes earlier attention items.
- No test may send messages, invoke delivery, modify the real vault, or call a real channel CLI.
- Development happens in an isolated worktree. No commit, push, merge, or branch deletion occurs without explicit authorization.

## Verification

- Unit tests prove query-count complexity stays constant as message count grows.
- Migration tests assert index columns and partial predicates.
- Store and Persona behavior tests cover every invariant above.
- A benchmark harness runs against an APFS copy-on-write snapshot and reports only timings/counts.
- Electron is launched against an isolated snapshot with channel and send operations fail-closed.
- Automated navigation cycles through the affected views at least three times while checking responsiveness, CPU recovery, and absence of send attempts.
