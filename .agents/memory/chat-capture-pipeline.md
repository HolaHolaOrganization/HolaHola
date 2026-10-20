---
name: Chat capture pipeline — architecture and pitfalls
description: How .local/.chat_capture works, why its DB cursor and episode-mirror cursor advance independently, why HTTP readiness doesn't prove capture is draining, and why attribution bugs must be fixed in three places.
---

## 1. Replacement architecture (Replit stopped writing JSONL, Jul 27 2026)

Replit definitively stopped writing JSONL transcript files after Jul 27 2026. The replacement is a per-turn append-only log:

- **File:** `.local/.chat_capture` (append-only, never cleared except by explicit `--reset`)
- **Cursor:** `.local/.chat_capture_cursor.json` — byte offset of last saved turn, advances AFTER successful DB insert (crash-safe)
- **Primary tool:** `npx tsx server/scripts/append-turn.ts <David|Luca> "exact text"`
- `fs.watch` on `.local/` fires within milliseconds of each append → autosave saves to DB; a 20-second poll is the backup.
- On server restart: cursor persists, startup checks for unsaved bytes and saves immediately.

Turn format:
```
---TURN-START---
SPEAKER: David
TIME: 2026-08-10T18:45:23.456Z
---
exact verbatim text (multi-line preserved)
---TURN-END---
```

**Why reconstruction always fails:** batch writes from memory produce narrative, not transcript — sentence openers drop, entire turns collapse. The only verbatim record is a copy made at the moment the turn exists, not a recollection written afterward.

Commands:
```bash
npx tsx server/scripts/append-turn.ts David "exact text"   # write David turn now
npx tsx server/scripts/append-turn.ts Luca  "exact text"   # write Luca turn now
npx tsx server/scripts/append-turn.ts --status              # cursor/file state
npx tsx server/scripts/save-transcript-now.ts --direct      # flush to DB (server down)
npx tsx server/scripts/append-turn.ts --reset               # clear file + cursor at session end
npx tsx server/scripts/capture-conversation.ts              # interactive multi-turn entry
```

## 2. Two independent cursor boundaries

Canonical chat persistence (the DB cursor above) and complete rolling-episode acknowledgement use separate monotonic boundaries. A recoverable episode-projection failure may delay acknowledgement, but must never pin the canonical DB cursor or block later exchanges.

**Why:** the episode helper can fail after the canonical conversation row has already committed. Retrying from one shared cursor repeatedly finds the existing row and wedges all later capture bytes. Advancing that cursor without a durable mirror retry would instead lose the episode projection.

**How to apply:** persist an idempotent episode-mirror outbox item before advancing canonical progress. Advance acknowledgement only after ordered mirror success. The only exception is an explicitly audited permanently invalid destination: every source capture must be linked to its canonical row or named as deliberately unresolved, with the original item, receipts, hashes, reason, and operator remaining independently verifiable. Never infer this state from a retry failure or retarget the item. Malformed, unaudited, or tampered boundaries fail closed.

## 3. Readiness vs. draining, and the two evidence planes

HTTP application readiness is not proof that canonical conversation capture is armed. A recovery or backfill must prove cursor acknowledgement by the actual capture worker, then verify the expected canonical identity tags and attribution in the database.

**Why:** a backfill once ran while the HTTP server reported ready but the delayed autosave worker had not started; a fallback watchdog advanced the byte cursor while dropping source and capture identity, so cursor completion alone falsely appeared successful.

**How to apply:** before replaying canonical exchanges, verify the intended drain worker is active. After replay, require all expected capture IDs to exist exactly once with correct authorship, then verify projections and embeddings.

The coordination ledger and `agent_notes` are separate evidence planes: `agent_notes` proves inbox delivery and preserves compatibility, but only authenticated ledger events prove acceptance, ownership, progress, completion, or outcome acknowledgement. Messages have existed in `agent_notes` while the event feed appeared empty, and a delivered inbox projection has been incorrectly treated as if the recipient had accepted the work. Check both systems when locating messages; use the ledger for tracked handoffs and wait for an explicit `accepted` event before starting overlapping mutations.

## 4. Three independent DB-writing consumers (fix one ≠ fix all)

`.local/.chat_capture` is read by three independent code paths, each `INSERT`ing its own `conversation_memories` rows and deriving row-level `participants`/`title` metadata with its own locally-duplicated logic, by design:

- `agent-session-autosave.ts`'s `checkChatCapture()` — the primary live path, polls while the dev server is running.
- `capture-watchdog.ts`'s `writeToDb()` — backup drain when the dev server is down; a separate long-lived process.
- `save-transcript-now.ts`'s `.chat_capture` fallback (`saveNow()` and `saveChatCaptureWithLock()`) — manual force-save script, used directly and by the session-end checklist.

All three render the dialogue body via the shared `formatChatCaptureSpeakerLabel()` in `transcript-parser.ts` (single source of truth for the text), but none imports a shared helper for the row's `participants`/`title` — each has its own copy.

**Why:** the duplication is deliberate — it isolates regression risk, so a bug in the watchdog's copy can't break the primary autosave path. But it means a per-turn identity/attribution bug fixed in one file's metadata derivation is NOT fixed in the other two. A 2026-09 incident fixed the shared body-rendering function first and initially missed that `capture-watchdog.ts` and `save-transcript-now.ts` each had their own unfixed copy of the metadata-derivation logic — producing rows where the body text was correct but the title/participants metadata still claimed the wrong identity.

**How to apply:** any change to how a turn's identity/attribution is derived (new speaker/source combination, changed label rule, etc.) must be checked against all three call sites above, not just the one where the bug was first observed. `agent-session-autosave.ts`'s `saveTranscriptChunk` and `save-transcript-now.ts`'s JSONL primary branch are the exception: both use `extractTurns()` (legacy Replit JSONL format), which structurally can only ever emit `DAVID`/`LUCA` speakers, never `CLAUDE_CODE` — their hardcoded 2-party participants are safe and out of scope for this bug class.

## Write-path failure mode: pre-writing instead of copying

## 5. Write-path failure mode: pre-writing instead of copying

A live test (Aug 10 2026) found Luca's own turns silently diverging from what
was actually said: Luca pre-wrote what it planned to say and appended that
draft to `.local/.chat_capture` instead of copying the actual chat response
after the fact, producing fabricated paragraphs in the canonical record.
David's turns, appended by the same mechanism, were captured verbatim with no
such gap.

**Why:** the append tool has no way to distinguish "text I'm about to send"
from "text I actually sent" — both are just a string argument. Only the
human deciding when to call it enforces that distinction.

**How to apply:** always call `append-turn.ts Luca "..."` with the exact text
already sent to the user, copied after the fact — never with a draft composed
before or during sending, even if it seems identical at the time.


## Capture acknowledgement is not search freshness

Canonical capture acknowledgement must distinguish durable source/projection
completion from search freshness. Save a durable indexing obligation before
acknowledging, but never wait for remote whole-record embeddings under a
capture lock.

**Why:** Large rolling episodes can require hundreds of remote requests after
each short append. Waiting for those requests caused foreground capture to
time out after canonical persistence but before acknowledgement, encouraging
unsafe source replay even though the dialogue was already saved.

**How to apply:** Reuse the existing indexer's durable source selection and
retry machinery. Coalesce edits, retain pending status on partial failure, and
clear the obligation only for the exact canonical version successfully built.
Search freshness is a separate observable state, not evidence of source loss.


## Prove capture absence before backfilling

**Rule:** Prove that the actual conversation content is absent before backfilling. A title search or stale local capture file is not proof that cross-host automatic capture failed.

**Why:** A Windows-side check searched for a hat name in generic conversation titles and found no records, even though a Stop hook was already recording the full exchanges remotely. Seven manual backfills then duplicated those originals; one assistant reply was recalled rather than copied. Independent content and capture-identity checks exposed the false absence conclusion.

**How to apply:** Search the actual user/assistant text and verified source/capture tags in the authoritative database, then inspect automatic hooks and transport acknowledgements. If erroneous duplicates already exist, preserve their complete bytes with explicit non-authoritative labels and links to the authentic originals; refresh all search arms after annotation. Compare each assistant side independently: a later backfill can differ even when adjacent turns are exact copies. Annotation is not an enforced retrieval-exclusion quarantine.

