# Electron SQLite Interaction Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate Electron main-thread freezes caused by synchronous Persona SQLite reads on a roughly 3 GB / 220k-message vault while preserving all existing product and safety semantics.

**Architecture:** Repair the exact SQLite lookup plans proven slow by production-scale sampling, cache dynamic conversation exclusions at the vault lifecycle boundary, and reuse expensive read models until the SQLite connection changes. Validate each layer with TDD, sanitized copy-on-write benchmarks, and an isolated fail-closed Electron interaction run before considering a worker-thread fallback.

**Tech Stack:** TypeScript, Electron 43, React Query, better-sqlite3, SQLite migrations, Vitest, electron-vite, macOS APFS copy-on-write snapshots.

**Spec:** `docs/superpowers/specs/2026-08-20-electron-sqlite-interaction-performance-design.md`

## Global Constraints

- Work only in a Superpowers-created isolated Git worktree.
- Use Node `22.17.0`; run `pnpm run native:node` before Node/Vitest checks and restore `pnpm run native:electron` before launching Electron.
- Do not send messages, invoke delivery, call a real channel CLI, mutate the real vault, or modify real application settings during tests.
- Benchmark output may contain durations and aggregate row counts only; never emit message text, names, external identifiers, credentials, or local source-data paths.
- Preserve `persona_conversation_exclusions` as the single classification rule source.
- Preserve attention-task ordering, resolution, cross-channel isolation, and send-guard semantics.
- Do not add UI, state-management, or database dependencies.
- Do not commit, push, merge, or delete branches without explicit user authorization. Steps labelled “Commit checkpoint” are skipped unless authorization is provided.

---

## File Map

**Create**

- `tests/unit/store/persona-message-index.test.ts` — asserts migration-backed query indexes and partial predicates.
- `tests/unit/desktop/persona-read-model-performance.test.ts` — deterministic query-count and cache-invalidation regressions using synthetic data.
- `scripts/benchmark-persona-reads.mjs` — sanitized benchmark runner for an isolated database snapshot.
- `scripts/run-isolated-persona-interaction.mjs` — fail-closed Electron navigation/performance harness.
- `packages/store/src/migrations/vault/v33-persona-message-lookup.ts` — append-only lookup indexes if `main` still ends at vault v32; otherwise use the next available version.

**Modify**

- `packages/store/src/migrations.ts` — register the append-only index migration.
- `packages/store/src/repositories/conversations.ts` — expose full and single-conversation exclusion reads plus cleanup from a precomputed map.
- `packages/store/src/repositories/persona.ts` — accept an optional precomputed exclusion set while preserving default dynamic-view behavior.
- `packages/persona/src/inbox-consumer.ts` — report conversation IDs touched by message/conversation/actor changelog entries.
- `apps/desktop/src/main/services/ingest.service.ts` — forward touched conversation IDs after Persona consumer batches.
- `apps/desktop/src/main/services/data-plane.service.ts` — type and forward the enriched callback.
- `apps/desktop/src/main/bootstrap/startup.ts` — connect the callback to Persona exclusion refresh.
- `apps/desktop/src/main/services/persona.service.ts` — exclusion lifecycle cache, read-model reuse, optimized query shapes, duration-only diagnostics.
- `package.json` — add explicit benchmark and isolated-interaction commands.
- Existing Persona/store/ingest tests — extend behavior coverage without weakening assertions.

---

### Task 1: Establish a sanitized performance regression harness

**Files:**

- Create: `scripts/benchmark-persona-reads.mjs`
- Create: `tests/unit/desktop/persona-read-model-performance.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: `MYCONTEXT_BENCH_DB` containing an isolated vault path.
- Produces: `pnpm run benchmark:persona-reads`, printing a JSON object with `attachMs`, `snapshotMs`, `conversationsMs`, `draftsMs`, optional `attentionMs`, repeated-read timings, and aggregate counts only.

- [ ] **Step 1: Write the failing constant-query-count regression**

Create a Vitest case that opens a test vault, inserts one direct conversation and 200 inbound messages, spies on `db.prepare`, invokes the Persona/UI read path under test, and asserts that the number of prepared statements stays at or below a fixed constant independent of message count. The assertion must target behavior, not source text:

```ts
const prepare = vi.spyOn(vault.db, "prepare")
const rows = service.conversations()
expect(rows).toHaveLength(1)
expect(prepare.mock.calls.length).toBeLessThanOrEqual(12)
```

Add a second call with no writes and assert no additional expensive exclusion-view statement is prepared.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm run native:node
pnpm vitest run tests/unit/desktop/persona-read-model-performance.test.ts
```

Expected: FAIL because current `main` repeatedly expands `persona_conversation_exclusions` and/or prepares per-read heavy statements.

- [ ] **Step 3: Implement the benchmark script without production changes**

The script must:

1. require `MYCONTEXT_BENCH_DB`;
2. reject paths under the real configured user-data directory;
3. open the isolated database;
4. construct the production service/read repositories;
5. time each method with `performance.now()`;
6. print only timing/count fields;
7. close the database in `finally`.

Use this output schema:

```js
{
  attachMs: number,
  snapshotMs: number,
  conversationsMs: number,
  draftsMs: number,
  attentionMs: number | null,
  repeatedSnapshotMs: number,
  repeatedConversationsMs: number,
  repeatedAttentionMs: number | null,
  conversationCount: number,
  draftCount: number,
  attentionCount: number | null
}
```

- [ ] **Step 4: Add package commands and validate fail-closed behavior**

Add:

```json
"benchmark:persona-reads": "node scripts/benchmark-persona-reads.mjs"
```

Run without `MYCONTEXT_BENCH_DB`; expected: non-zero exit with “isolated benchmark database required”. Run against a temporary test vault; expected: JSON containing only allowed keys.

- [ ] **Step 5: Commit checkpoint (skip without user authorization)**

```bash
git add scripts/benchmark-persona-reads.mjs tests/unit/desktop/persona-read-model-performance.test.ts package.json
git commit -m "test: add persona read performance harness"
```

---

### Task 2: Add migration-backed indexes for proven lookup shapes

**Files:**

- Create: `packages/store/src/migrations/vault/vNN-persona-message-lookup.ts`
- Create: `tests/unit/store/persona-message-index.test.ts`
- Modify: `packages/store/src/migrations.ts`

**Interfaces:**

- Produces: `idx_msg_conv_external` on `(conversation_id, external_id)` and `idx_msg_peer_lookup` on `(conversation_id, sender_external_id)` with predicate `is_self = 0 AND sender_external_id IS NOT NULL`.
- `NN` is `max(VAULT_MIGRATIONS.version) + 1`, determined immediately before writing the migration.

- [ ] **Step 1: Write failing migration tests**

Open a fresh test vault and assert:

```ts
expect(indexColumns(db, "idx_msg_conv_external")).toEqual(["conversation_id", "external_id"])
expect(indexColumns(db, "idx_msg_peer_lookup")).toEqual(["conversation_id", "sender_external_id"])
expect(indexSql(db, "idx_msg_peer_lookup")).toContain(
  "WHERE is_self = 0 AND sender_external_id IS NOT NULL",
)
```

Also assert `VAULT_MIGRATIONS` versions remain continuous and the new migration is last.

- [ ] **Step 2: Run the migration test and verify RED**

```bash
pnpm vitest run tests/unit/store/persona-message-index.test.ts
```

Expected: FAIL because both indexes are absent.

- [ ] **Step 3: Add the append-only migration**

Use exact SQL:

```ts
export const VAULT_00NN_PERSONA_MESSAGE_LOOKUP = `
CREATE INDEX idx_msg_conv_external
  ON messages(conversation_id, external_id);

CREATE INDEX idx_msg_peer_lookup
  ON messages(conversation_id, sender_external_id)
  WHERE is_self = 0 AND sender_external_id IS NOT NULL;
`
```

Register it after the current final vault migration. Do not edit any released migration.

- [ ] **Step 4: Make lookup SQL use the intended indexes**

For legacy drafts, keep the correctness condition:

```sql
message.conversation_id = draft.conversation_id
AND message.external_id = draft.reply_to_external_id
```

Use `INDEXED BY idx_msg_conv_external` only if `EXPLAIN QUERY PLAN` on the isolated large snapshot shows SQLite choosing another index and the before/after benchmark proves the hint is required.

- [ ] **Step 5: Verify migration and query plans**

```bash
pnpm vitest run tests/unit/store/persona-message-index.test.ts tests/integration/store/migration-chain.test.ts
pnpm run check:migration-checksums
```

Expected: all pass; historical checksums unchanged.

- [ ] **Step 6: Commit checkpoint (skip without user authorization)**

```bash
git add packages/store/src/migrations.ts packages/store/src/migrations/vault/vNN-persona-message-lookup.ts tests/unit/store/persona-message-index.test.ts
git commit -m "perf(store): index persona message lookups"
```

---

### Task 3: Cache dynamic exclusions at the vault lifecycle boundary

**Files:**

- Modify: `packages/store/src/repositories/conversations.ts`
- Modify: `packages/store/src/repositories/persona.ts`
- Modify: `packages/persona/src/inbox-consumer.ts`
- Modify: `apps/desktop/src/main/services/ingest.service.ts`
- Modify: `apps/desktop/src/main/services/data-plane.service.ts`
- Modify: `apps/desktop/src/main/bootstrap/startup.ts`
- Modify: `apps/desktop/src/main/services/persona.service.ts`
- Test: `tests/unit/store/persona-conversation-exclusions.test.ts`
- Test: `tests/unit/distill/consumers.test.ts`
- Test: `tests/unit/desktop/persona-read-model-performance.test.ts`

**Interfaces:**

- Produces: `ConversationRepository.listPersonaExclusions(): { conversationId: string; reason: PersonaConversationExclusionReason }[]`.
- Produces: `ConversationRepository.cleanupPersonaExclusions(at, known?)`, where `known` is an optional `ReadonlyMap<string, PersonaConversationExclusionReason>`.
- Produces: Persona consumer batch result `{ processed, skipped, conversationIds }`.
- Produces: `PersonaService.onDelivered(conversationIds: readonly string[]): void`.

- [ ] **Step 1: Write failing cache and invalidation tests**

Test that, after `service.attach(db)`, calling all hot reads does not prepare another full-view exclusion query:

```ts
service.snapshot()
service.conversations()
service.drafts()
service.attentionTasks?.()
expect(exclusionQueryCount(prepare.mock.calls)).toBe(0)
```

Then mutate a conversation title to a known bot pattern, call `service.onDelivered([conversationId])`, and assert the conversation disappears from Persona reads while exactly one single-conversation view query is issued.

Add consumer tests proving message, conversation, and actor changelog entries report affected conversation IDs even when admission rejects the message.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm vitest run tests/unit/desktop/persona-read-model-performance.test.ts tests/unit/distill/consumers.test.ts
```

Expected: FAIL because UI reads currently expand the view and consumer results do not carry touched conversation IDs.

- [ ] **Step 3: Add repository APIs with backward-compatible defaults**

Implement `listPersonaExclusions()` using the existing view. Extend `cleanupPersonaExclusions()` with an optional map; when absent, execute current SQL unchanged. When present, update only listed conversation IDs in one transaction.

Extend `PersonaConfigRepository.listWithConversations(excludedIds?)` and `PersonaRunRepository.pendingDrafts(limit, excludedIds?)` so:

- `undefined` keeps current view-based behavior;
- a provided set removes matching rows in memory and avoids the view in SQL.

- [ ] **Step 4: Enrich the Persona consumer result**

Return conversation IDs touched by:

- message upserts through the resolved message conversation;
- conversation changelog entries directly;
- actor changelog entries through `SELECT DISTINCT conversation_id FROM messages WHERE sender_actor_id = ?`.

Do not enqueue conversation/actor entries and keep `processed/skipped` semantics unchanged.

- [ ] **Step 5: Add Persona exclusion cache lifecycle**

On `attach`:

1. call `listPersonaExclusions()` once;
2. populate `Map<conversationId, reason>`;
3. call map-based cleanup once;
4. pass the set to hot repositories.

On `onDelivered(conversationIds)`, recompute only unique listed IDs with `personaExclusionReason(id)`, update/delete map entries, clean newly excluded conversations, invalidate read models, then wake and emit the throttled snapshot.

On `detach`, clear the map.

- [ ] **Step 6: Verify behavior invariants**

Run:

```bash
pnpm vitest run \
  tests/unit/store/persona-conversation-exclusions.test.ts \
  tests/unit/distill/consumers.test.ts \
  tests/unit/desktop/persona-service.test.ts \
  tests/unit/desktop/persona-read-model-performance.test.ts
```

Expected: all pass, including dynamic title/actor classification and default repository behavior.

- [ ] **Step 7: Commit checkpoint (skip without user authorization)**

```bash
git add packages/store/src/repositories/conversations.ts packages/store/src/repositories/persona.ts packages/persona/src/inbox-consumer.ts apps/desktop/src/main/services/ingest.service.ts apps/desktop/src/main/services/data-plane.service.ts apps/desktop/src/main/bootstrap/startup.ts apps/desktop/src/main/services/persona.service.ts tests/unit/store/persona-conversation-exclusions.test.ts tests/unit/distill/consumers.test.ts tests/unit/desktop/persona-read-model-performance.test.ts
git commit -m "perf(persona): cache dynamic conversation exclusions"
```

---

### Task 4: Reuse Persona read models and eliminate random-page lookup

**Files:**

- Modify: `apps/desktop/src/main/services/persona.service.ts`
- Test: `tests/unit/desktop/persona-read-model-performance.test.ts`
- Test: existing Persona service/read-model tests applicable on current `main`

**Interfaces:**

- Produces: internal `invalidateReadModels(): void`.
- Produces: internal cache version based on SQLite `total_changes()` plus explicit invalidation.
- Reuses: migration indexes from Task 2 and exclusion set from Task 3.

- [ ] **Step 1: Write failing behavior and cache tests**

Cover:

- a later human reply closes an earlier task;
- newer inbox failure is not hidden by an older run;
- newer pending draft wins over older disposed draft;
- legacy draft match is conversation-scoped across channels;
- two reads without writes reuse the result;
- a direct repository write through the same connection changes `total_changes()` and forces recomputation.

- [ ] **Step 2: Verify RED**

```bash
pnpm vitest run tests/unit/desktop/persona-read-model-performance.test.ts
```

Expected: semantic tests may pass on current code, but cache/query-count assertions fail.

- [ ] **Step 3: Replace heavy snapshot count with direct aggregate**

Calculate automatic-reply count only from configuration:

```sql
SELECT count(*) AS c
FROM dh_conversation_configs
WHERE reply_mode IN ('auto', 'yolo')
```

Do not call the full conversation-list read from `snapshot()`.

- [ ] **Step 4: Split candidate reads by access locality**

Use:

- direct messages via `conversations CROSS JOIN messages INDEXED BY idx_msg_conv_time`, bounded by the latest human reply timestamp;
- mentioned group messages via `idx_mentions_self`;
- Agent/draft/inbox special pairs from small tables carrying both `message_id` and `conversation_id`;
- sequential per-conversation message reads via `idx_msg_conv_time`, followed by in-memory ID filtering;
- map-based deduplication by message ID.

Avoid generating discrete IDs and then randomly joining the 3 GB messages table by primary key.

- [ ] **Step 5: Add versioned read-model cache**

Store `{ totalChanges, value }`. Return the cached value only when current `SELECT total_changes()` equals the cached version. Clear it in every Persona state transition that emits a snapshot and on attach/detach.

Ensure a daily/summary method calls the shared aggregate rather than rebuilding it.

- [ ] **Step 6: Add duration-only diagnostics**

Log only operation and elapsed time when a read exceeds 500 ms:

```ts
logger.warn("persona read slow", { operation: "conversations", elapsedMs })
```

Never log query inputs or returned data.

- [ ] **Step 7: Run complete Persona regressions**

```bash
pnpm vitest run \
  tests/unit/desktop/persona-service.test.ts \
  tests/unit/desktop/persona-read-model-performance.test.ts \
  tests/unit/store/persona-config.test.ts \
  tests/unit/store/persona-conversation-exclusions.test.ts \
  tests/unit/distill/consumers.test.ts
pnpm run typecheck
pnpm run lint
```

Expected: all pass with zero warnings.

- [ ] **Step 8: Commit checkpoint (skip without user authorization)**

```bash
git add apps/desktop/src/main/services/persona.service.ts tests/unit/desktop/persona-read-model-performance.test.ts
git commit -m "perf(persona): reuse interaction read models"
```

---

### Task 5: Benchmark a clean isolated copy of the real-scale vault

**Files:**

- Modify: `scripts/benchmark-persona-reads.mjs` if benchmark findings require harness-only fixes.
- Do not modify production code in this task until a failing automated test is added to Task 2–4.

**Interfaces:**

- Consumes: APFS copy-on-write clone under `/tmp/mycontext-performance-*`.
- Produces: sanitized benchmark JSON and query-plan evidence.

- [ ] **Step 1: Create a copy-on-write snapshot**

Clone control DB, vault DB, WAL, and SHM files with `cp -c`. Validate `PRAGMA quick_check`. Never open or mutate the source vault.

- [ ] **Step 2: Sanitize the snapshot before application use**

In the clone only:

- enable Persona kill switch;
- delete send grants and send attempts;
- remove model secrets/runtime overrides;
- configure a fail-closed DWS stub that permits `--version` and rejects every other command.

- [ ] **Step 3: Apply current migrations to the clone**

Open with `VAULT_MIGRATIONS`, assert latest version, `quick_check=ok`, and both Task 2 indexes present.

- [ ] **Step 4: Run the benchmark three cold-start rounds**

Before each round, close all DB handles and start a fresh Node process. Capture only allowed JSON fields. Required p95 thresholds:

```text
attachMs <= 15000
snapshotMs <= 1000
conversationsMs <= 1000
attentionMs <= 2000 (when method exists)
repeated reads <= 300
```

- [ ] **Step 5: Gate query plans**

Record sanitized `EXPLAIN QUERY PLAN` output for the legacy draft lookup and peer lookup. Assert plan text references `idx_msg_conv_external` and `idx_msg_peer_lookup` respectively.

- [ ] **Step 6: Decide worker fallback**

Only if a required read remains above 2 seconds after proven query fixes, create a new failing plan task for a worker-based read service. Otherwise explicitly record “worker fallback not required” and do not add it.

---

### Task 6: Run isolated Electron navigation stress test

**Files:**

- Create: `scripts/run-isolated-persona-interaction.mjs`
- Modify: `package.json`
- Test: add a unit/static safety test for the runner under `tests/unit/desktop/`.

**Interfaces:**

- Produces: `pnpm run check:persona-performance-ui`.
- Uses: isolated renderer/CDP identity, fail-closed channel and send methods, temporary user-data/data/workspace paths.

- [ ] **Step 1: Write the failing safety test**

Assert the runner:

- requires a temporary data root;
- uses a random debugging port;
- denies compose send, draft resolve-send, and message draft generation unless explicitly running against the sanitized snapshot;
- kills child processes and removes temporary directories in normal, error, and timeout paths;
- never uses fixed port 5273 or a real user-data directory.

- [ ] **Step 2: Implement the isolated runner**

Launch the production Electron build against the sanitized clone. Never connect to an already running Electron instance. Verify the window identity through the unique data root and debugging port.

- [ ] **Step 3: Automate navigation stress**

Perform three rounds across every Persona-related navigation entry present on the current branch. For each transition:

1. click only navigation/view controls;
2. wait for the expected heading;
3. record transition latency;
4. assert the renderer remains CDP-responsive;
5. assert the main process CPU returns below 10% within 3 seconds;
6. assert the DWS/send-denial log contains zero send-like commands.

Do not click compose, approve, send, delete, wipe, rebuild, or configuration-save controls.

- [ ] **Step 4: Verify the UI performance gate**

```bash
pnpm run build
pnpm run check:persona-performance-ui
```

Expected: all transitions under 2 seconds, no main-thread hang, no external calls, no residual processes/directories.

- [ ] **Step 5: Commit checkpoint (skip without user authorization)**

```bash
git add scripts/run-isolated-persona-interaction.mjs tests/unit/desktop/persona-performance-ui.test.ts package.json
git commit -m "test: gate persona interaction performance"
```

---

### Task 7: Final verification and independent review

**Files:**

- No planned production changes; fixes discovered here require returning to the owning TDD task.

**Interfaces:**

- Produces: final verification evidence and reviewer `Ready: Yes`.

- [ ] **Step 1: Run the full targeted gate**

```bash
pnpm run native:node
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm vitest run \
  tests/unit/store/persona-message-index.test.ts \
  tests/unit/store/persona-conversation-exclusions.test.ts \
  tests/unit/store/persona-config.test.ts \
  tests/unit/distill/consumers.test.ts \
  tests/unit/desktop/persona-service.test.ts \
  tests/unit/desktop/persona-read-model-performance.test.ts \
  tests/unit/desktop/data-plane-events.test.ts
pnpm run check:migration-checksums
pnpm run check:typography
pnpm run check:trademarks
git diff --check
```

- [ ] **Step 2: Restore Electron ABI and build**

```bash
pnpm run native:electron
pnpm run build
```

Expected: production main/preload/renderer build succeeds.

- [ ] **Step 3: Re-run real-scale and interaction gates**

```bash
MYCONTEXT_BENCH_DB=<sanitized-clone> pnpm run benchmark:persona-reads
pnpm run check:persona-performance-ui
```

Expected: every threshold in the spec passes, zero send attempts, no real-data mutation.

- [ ] **Step 4: Request independent read-only review**

Reviewer scope:

- query correctness and index use;
- exclusion cache completeness for message/conversation/actor changes;
- cache invalidation through direct repository writes;
- cross-channel legacy draft isolation;
- migration continuity/checksum safety;
- test harness fail-closed guarantees;
- Critical/Important findings only; require `Ready: Yes`.

- [ ] **Step 5: Audit repository and runtime state**

Confirm:

- only the isolated worktree changed;
- original worktree remains clean;
- no staged files unless explicitly authorized;
- no test Electron/Chrome/KL processes remain;
- no temporary snapshot remains unless retained for manual testing;
- no real configuration or vault was modified.

- [ ] **Step 6: Commit/merge/push decision**

Do not commit, merge, or push. Report the verified worktree and branch to the user. Perform integration only after explicit authorization.
