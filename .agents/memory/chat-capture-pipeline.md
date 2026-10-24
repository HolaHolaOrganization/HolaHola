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


## Recency is not a delivery boundary

A recent-message window is not an acknowledgment or recovery boundary. A capture design must distinguish already delivered source occurrences from outstanding ones; selecting only the latest founder-adjacent turns can permanently omit earlier speech that never received its own capture event.

**Why:** A proposed segmentation design selected the final runtime turn and the most recent preceding founder turn. The first-Stop trace U1,A1,absorbed-human-U2,A2,runtime-N,B therefore selected U2/N and omitted uncaptured U1/A1. This was an abstract executable counterexample to the proposed rule, not a test of implemented hook code. Source: conversation_memories b3afe098-5b09-4db2-901c-3fb0828494bb preserves the full draft, qualification and delivered review.

**How to apply:** Tie recovery to evidence of delivery and retained outstanding source, without assuming a particular ledger or API. Test multiple source boundaries before the first capture event and a failed delivery followed by later activity. A conflict guard protects immutable records but does not itself preserve omitted content; stderr and an eventual future Stop are not durable acknowledgment.


## Filtered evidence order is not canonical identity

Filtering an evidence stream changes its ordinal positions. Never use an entry’s index in a filtered mirror as proof of its original canonical occurrence identity. Intake-event identity and published-record identity are separate contracts; choosing UUIDs for a new evidence store does not authorize migrating canonical IDs or changing recall.

**Why:** An actual pinned capture hook assigned a human entry position2 after two tool-only entries. A privacy-filtered mirror put the same human at ordinal0, so the proposed old-ID lookup could miss an existing record and duplicate it under a new UUID. Source: conversation_memories 45462c6c-4345-41d0-8a22-0fce93d9d2e2 preserves the exact review packet and independent memory-only proof.

**How to apply:** Preserve independently verifiable original-source coordinates and delivery order alongside transport/event identity. Hold ambiguous compatibility mappings rather than guessing from filtered order or timestamps. Exact-key retries need payload equality; a reused key with different evidence must be a visible retained conflict/variant, not silent ON CONFLICT DO NOTHING.


## Prompt-hook identity may span multiple messages

Do not use Claude Code UserPromptSubmit prompt_id alone as a per-message occurrence or deduplication key. The observed path reused one prompt_id for an initiating message and a different human prompt absorbed mid-turn. This is bounded evidence of non-uniqueness, not a universal claim about the field’s semantics.

**Why:** LCC’s reported metadata-only probe logged UserPromptSubmit for one absorbed message and correlated it to a queued_command; the prompt_id matched the initiating turn rather than uniquely identifying the new message. Probe execution/source details were still being independently reviewed. Source: conversation_memories 331e2128-a828-4cfb-967e-ad9b5d156e3d preserves the complete report, metadata log and qualifications.

**How to apply:** Preserve a separate occurrence identity and retry/link contract. Keep transcript source_uuid/delivery_id, hook prompt_id and canonical identity distinct. Text hashes may help bound a candidate match but cannot distinguish repeated identical messages; ambiguous links stay held rather than guessed.


## Network interruption is not API-failure evidence

A network interruption is not by itself evidence of a Claude Code StopFailure event or its input schema. One reported mid-reply disconnection resumed automatically through runtime metadata, without an API-error entry or failure-hook invocation. Do not infer which API errors trigger StopFailure from that negative result.

**Why:** LCC reported a founder-approved network-cut test that interrupted thinking before visible text, followed by an isMeta automatic-resume message and resumed speech. Source: conversation_memories a68db890-d3fa-431c-883b-7d526aee2994 preserves the exact report and explicit evidence limits; LR did not independently reproduce it.

**How to apply:** Keep transport interruption, automatic continuation and API-failure lifecycle cases separate. Preserve source metadata and visible speech boundaries. If a design removes a previously blocking hook dependency, re-present the actual alternative and limitations to the reviewer rather than treating absence of the event as clearance.


## Metadata-only diagnostics must validate error paths and value types

Metadata-only diagnostics must not persist arbitrary exception messages or copy unvalidated metadata values wholesale. JSON.parse errors may contain excerpts of their input; an object-valued session identifier may contain nested text rather than an identifier. Use fixed error codes and validated scalar metadata, never raw error text as a privacy fallback.

**Why:** The supplied probe body, executed in an in-memory VM with synthetic stdin, echoed CANARY through a parser error and a nested session_id object. Its replacement fixed the exception path but still copied unexpected objects. No real secret/conversation exposure was observed. Source: conversation_memories 124d0164-8143-4fba-b2b2-8a1d748dfa14 retains safe source pointers, synthetic checks and the exact review without redistributing out-of-scope prompt metadata.

**How to apply:** Audit error paths and metadata types, not just successful text filtering. Stop temporary diagnostics when no longer needed. Preserve attribution through source references without unnecessarily copying disclosed out-of-scope metadata into more records.


## Stop veto and immutable publication must compose safely

A Stop-hook veto is not a transaction barrier for another hook publishing a canonical turn. Matching Claude Code hooks execute in parallel; registering the recorder before a guard in an array does not make the guard settle before publication. Preserve the actual final source boundary before making an immutable canonical outcome.

**Why:** Exact-source synthetic integration traces showed the guard blocking the first Stop while the existing recorder could submit U/A. A continuation B then reused the same capture identity with different assistant bytes; the immutable ingress rejects that change. A metadata-shaped feedback alternative was selected as human text by the older recorder. These are conditional source traces, not proof of native provider representation or observed loss. Source: conversation_memories 2c147be7-f807-4ed4-99cf-7e6a50a903d9 includes the official dispatch excerpt, source reviews and fixtures.

**How to apply:** Any new blocking/continuation hook needs a paired-recorder lifecycle regression, not only guard predicate tests. Keep source preservation independent from notification-liveness goals; do not weaken immutability or silently turn off recording as the integration fix.


## Runtime origin does not determine dialogue boundary

Classifying a source entry as runtime-origin does not by itself decide whether following assistant speech continues an existing human exchange or begins a separate runtime-started turn. Origin and dialogue segmentation need separate evidence.

**Why:** A native owner-reported synthetic Stop diagnostic placed isMeta user feedback after an initial assistant reply and before continued assistant speech. Treating every such entry as a new runtime turn can discard legitimate continuation. Separately, an exact-recorder memory-only trace showed that deferring publication until a later Stop lets a newer genuine user hide the earlier deferred exchange under a last-user-only selector. These are bounded reported/conditional findings, not independently observed production loss. Source: conversation_memories cab74fa0-a045-4db0-b7ff-4e08de8431d3.

**How to apply:** Test hook feedback, genuine newer user messages and ordinary runtime notices as different sequencing cases. Preserve unsupported source without inventing human authorship or assuming a boundary from one provenance flag. A listener composition fix must respect capture authorization and source-completeness review.


## Projection rules must survive the preservation filter

A projection rule is unsupported if an upstream preservation/privacy filter removes the structural evidence that the rule requires. Review the representation the classifier actually receives, not only the original source.

**Why:** A capture proposal classified hook continuation only when an isMeta user was adjacent to a typed hook-error attachment and a typed system summary, while its mirror retained neither of those latter witnesses. The unfiltered trace matched; the filtered trace could not. This was a design-contract counterexample, not an implemented candidate failure or observed live loss. Source: conversation_memories bb371b9a-76bb-4e1b-8490-abed88e0b575.

**How to apply:** Run segmentation fixtures through the real proposed filter first. Either retain an approved minimal typed structural witness at its original position or explicitly hold the classification unsupported; do not infer missing proof from error-like prose. Retaining structural metadata is not permission to copy diagnostic bodies or tool results, and choosing its schema still requires the normal review and activation gates.


## Boundary proof requires lookahead and source freshness

A source boundary is not certified merely because required lookahead has not arrived, or because two uploads reached the server far apart. Unavailable future positions remain unknown; server receipt time is not the time the source snapshot was captured.

**Why:** In a capture-design review, a partial U/A/isMeta mirror met the literal runtime-start fallback and could close U before the following hook witnesses reclassified it as continuation feedback. Separately, an old snapshot captured before B but received after the settle interval met the written timer rule while B already existed at source. These were executable abstract contract cases, not native failures or observed live losses. Source: conversation_memories 5452f350-d7cb-45d6-bdea-9e6699073199.

**How to apply:** Test classification and publication at intermediate batch boundaries, including prefixes inside a multi-entry marker. Require enough actual lookahead to prove a nonmatch. Distinguish upload arrival from source-read freshness, and distinguish heuristic terminal availability from certified canonical completeness. Retaining a late tail for repair protects evidence but does not prove the published exchange was complete.


## Founder policy: provisional cross-hat visibility, certified-only Daniela recall

Provisional source exchanges may initially enter the cross-hat awareness feed, but not Daniela's normal recall. Canonical publication remains certified-only. Each provisional delivery must clearly retain provisional status and source identity, and its projection must be replaced or retired upon certification without deleting preserved source evidence. Provisional projections are separate from canonical capture IDs and conversation_memories.

**Why:** The founder directly accepted the recommendation “separate provisional view + cross-hat feed; Daniela’s normal recall receives the certified record only,” replying “sounds good to me.” The purpose distinction is operational awareness of work in progress versus recall of stable source exchanges, not greater trust in one team member. Exact question, recommendation and acceptance are preserved in conversation_memories b2dda136-e621-4a6f-a41e-2f6fdbbd501f.

**How to apply:** Treat this as an approved design policy, not permission to implement or activate a reader/writer, change recall/indexing, or merge/release. Extending a previously canonical-only feed to provisional material needs an explicit source/identity/status/acknowledgment/retirement design, not relabelling provisional items as canonical. A later separate current-activity view for Daniela was a future suggestion, not part of the accepted scope. The cancelled interactive form supplied no approval; the direct conversational acceptance is the source.


## Complete evidence-version identity

Source-evidence version identity must cover accepted structural anchors as well as preserved text. A content hash alone is not a complete evidence-version hash when anchor metadata can change independently.

**Why:** A real-database review showed a missing-to-populated transcript anchor silently discarded as an idempotent retry because the text and occurrence identifier were unchanged. The text survived, but the newly supplied source-placement evidence did not.

**How to apply:** Keep canonical dialogue content hashing distinct from complete preservation-evidence versioning. An exact retry must match the accepted evidence, not just its text. Preserve and flag differing anchors, or reject inconsistent retransmissions explicitly; never report a matching no-op while discarding an accepted source-evidence variant.


## Closing witnesses belong to the certification boundary

Certification depends on the closing witness as well as the content before it. An unknown or conflicting prospective boundary cannot be omitted from validation merely because its position lies outside the interval being certified.

**Why:** Independent source review found a previous exchange labelled certified while the very entry used to close it was retained for conflicting evidence. Validating the interval's contents did not validate the proof of its end.

**How to apply:** Include all classification dependencies of a closing event in the certification boundary. Test alternatives where one observation is a new turn and another is continuation, not only conflicts inside an already-selected interval. Keep preservation, provisional visibility and certified finality as distinct claims.

