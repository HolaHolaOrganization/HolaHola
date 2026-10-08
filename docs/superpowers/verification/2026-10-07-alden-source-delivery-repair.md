# Alden source-delivery repair — implementation and verification

Luca [Replit], main workspace. Implements the separately approved repair
following the read-only grounding audit. No subagents or engine switch.

## Implemented

- The shared-spec reader returns bounded, valid-JSON source pages: immutable
  review/revision IDs, full SHA-256, UTF-16 offsets, total source length,
  page digest and next offset. Full DB/source hashes are checked independently.
  JSON escaping and surrogate-pair boundaries are included in budgeting.
- Both provider loops protect these pages from destructive truncation.
- A generation-local tracker stages serialized pages and grants coverage
  only after the provider responds to the batch containing them. A read and
  decision issued together cannot count as already received source.
- The decision tool requires explicit revision ID/hash, re-reads the
  authoritative target and checks complete contiguous delivery before
  calling the existing claimed-review decision/effects service. Both approval
  and rejection fail closed on incomplete reads, wrong identity or absent
  execution context.
- Only validated source references are persisted in existing message
  context, as versioned JSON text, scoped to engine and conversation.
  References are outside shortened historical prose and are carried between
  phases. New generations always start with zero coverage and re-read.
  Raw tool results, source text and credentials are not logged by this path.

## Verification

- 15 new synthetic tests passed; registered in consolidated CI.
- 15 existing coordination transport tests passed.
- Four existing review-decision bypass-guard assertions passed.
- `npm run typecheck` passed.
- Application workflow restarted; public landing page rendered normally.
  Screenshot checked only the public page, not an authenticated Alden flow.
- System health summary: **All checks passed — safe to mark done.**
- Alden gave a consult-only architectural/wording read on the current
  Anthropic engine, with no blockers. No formal review was claimed/decided.
- Gemini preflight cleared the design. The completed final actual-code
  review returned **APPROVED**, with `finishReason: STOP`.

Synthetic coverage includes complete 20,830- and 30,764-character sources in
both transport envelopes; escaping/Unicode; invalid offsets and hashes;
oversized results; same-batch read/decide; failed provider sends; missing and
duplicated pages; changed sources; wrong review identity; empty sources;
phase resets; and safe engine-scoped context.

These are executed transport/coverage tests and wiring checks, not a live
model-comprehension test or a real shared-spec approval. No live approval
record was modified by verification.

## Limits and publication

Delivery receipts prove source delivery, not comprehension, sound reasoning
or review quality. The historical exact tool payload remains unavailable;
the repair does not establish the cause of each prior invented detail.

No database migration, publication, native Windows execution, policy change,
credential/DPAPI operation or new worker activation was performed. Production
publication remains on the existing founder-controlled release path. Native
diagnostic verification still needs its own matching-source/runtime and
fresh-authorization gates.
