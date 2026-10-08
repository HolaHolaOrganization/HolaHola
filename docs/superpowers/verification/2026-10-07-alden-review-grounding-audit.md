# Alden review grounding: read-only investigation

## Scope and outcome

Performed by Luca [Replit] in the main workspace. No subagents, live model
consultations, engine switches, prompt edits, approval-record changes or
worker execution were used.

**Established:** the review source-delivery path has a reproducible truncation
defect, plus a cross-turn source-continuity gap. The archived review also
contains descriptions contradicted by its named source.

**Not established:** which tool calls the model actually made in the fourth
review, the exact historical tool payload, the origin of each invented detail,
or a model-internal cause. This is not proof that Alden lost intelligence or
that one provider caused the incident.

## Primary evidence

- Archived conversation `66dc0484-59ec-475d-a933-184dfb316dd2`.
- Fourth review: Alden message `6e2c51f9-ed55-46e5-b230-e44159caaf67`.
- Named source: immutable revision
  `ed98a1e0-73a9-4da8-9e8c-f6e6bb0eaf10`.
- Independently recomputed source SHA-256:
  `722930660483e4343630e7729f0b560696f2be8bf5a8bdfeb49e5c9a4f941da7`,
  matching the shared-spec record.
- Source size: **20,830 characters**.
- Live Render release observed during investigation:
  `d468ac7bfa62c8ceb1b1f2ede6dbefcc7631131a`.
  Its `server/services/alden-tool-result.ts` bytes match the investigated
  checkout: SHA-256
  `b6c2540f4f190b619826dc1af50b7b2a0b5fccc63d12a64289b5bc2a8bd6ce72`.

### Descriptions contradicted by the source

The review describes a local window JSON file, append-only JSON-lines counter,
two checkouts beneath `.local/worker/runs/`, DPAPI credential storage, and
`--dangerously-skip-upgrade` / `--offline-mode` CLI flags. Those mechanisms are
absent from the named revision. Section 5.5 explicitly says:

> The job count is read from the ledger, not local state.

The invented file counter is therefore not merely an omitted caveat. It
contradicts the actual design. The review also refers to a nonexistent §7.2.

## Finding 1: full retrieval is not full delivery

`readAldenSharedSpecReview()` retrieves the revision identified by the review.
The `read_shared_spec_review` tool returns its markdown together with review
and document metadata. No fault was found in this DB lookup.

Both Anthropic and Gemini loops subsequently call
`serializeAldenToolResult()`. Its ordinary limit is **12,000 serialized
characters**, not 12,000 source characters. Only the two coordination reader
tools receive complete-result handling. The shared-spec reader does not.

Consequently, a long review source is cut inside its JSON string, followed by
a truncation notice. The result is incomplete JSON with incomplete markdown.
The loop delivers it as a normal tool result rather than a failed/incomplete
review read. Claiming a review is a separate operation and does not restore
the source.

### Executed reproduction

The investigation imported and called the actual serializer, with the exact
hashed source and **synthetic review metadata**. No model was invoked.

| Measurement | Observed |
| --- | ---: |
| Source characters | 20,830 |
| Encoded tool-result characters | 21,571 |
| Delivered prefix characters | 12,000 |
| Omitted characters | 9,571 |
| Result parses as JSON | No |
| Confinement section present | No |
| Verification section present | No |
| Authorization section present | No |
| Limitations section present | No |

In this reproduction, the prefix stops within §5.5. Actual metadata length
changes the exact cutoff; this is **not** a recovered historical payload.
The small-metadata reproduction still delivers the ledger-derived-count
statement. Truncation therefore explains missing source coverage, but does
not by itself explain why the model invented a contradictory counter.

The archived critique of review three also says it stopped at §5.5. That is
consistent with this delivery defect, but temporal consistency is not proof
of the exact causal sequence.

The 12,000-character cut also exists in the parent version before the
serializer extraction. It was not introduced by that extraction. The
available history does not establish when the defect first became relevant
to Alden's work.

## Finding 2: subsequent turns lose the source

Both chat backends retain only the last 12 supplied text messages and cut
each historical message to 2,000 characters. The current user message is
appended separately, without this historical-message cut.

Tool calls and results live only inside one generation loop. The API's
continuation phase starts a new loop with generated text added to history,
not the original retrieved source. Persisted chat records likewise contain
user/model text, not raw tool payloads. A long review is therefore shortened
on later turns, and "continue" does not restore the document.

This is a concrete source-continuity limitation, not proof that the source
was lost *within* the same generation loop. Within one loop, successful
tool results are appended to the provider conversation.

## Finding 3: review identifiers are also being confused

The archived later summary proposes deciding review
`196f2401-2027-4fd3-a5c1-e5d9a0a30a06` while describing the newer `ed98a1e0`
revision. The authoritative review record targets
`bb1998c5-425b-4811-b85d-391f343501d4` instead and was already approved.
A self-described completed review or plan to approve is not evidence of a
correct revision binding.

This finding does not say the server approved the wrong revision: the
server's stored target remained explicit. It identifies a model-authored
identity mismatch.

## Smallest corrective proposal — not implemented in this investigation

1. Give review reading a bounded, valid-JSON **chunked source protocol**:
   immutable review/revision IDs, full source hash, offsets and explicit
   completeness, with every page fitting the serialized output budget.
2. Carry only safe source pointers/read receipts across turns and phases.
   Re-read the needed exact source when answering; do not substitute
   truncated prior prose for it.
3. Bind review decisions to the exact source identity and independently
   tracked delivery coverage. Delivery receipts prove delivery, **not**
   comprehension or review quality.
4. Keep raw tool-result persistence restricted: some other Alden tools return
   credentials. Do not repair continuity by logging every tool payload.
5. Verify long sources, Unicode/JSON expansion, failed reads, incomplete
   coverage, changed revisions and phase resets with synthetic transport
   tests before any live consultation. Provider-specific prompt/tool wording
   changes need their applicable separate review.

The highest-priority repair is source delivery, not an engine switch or a
generic instruction to "be more thorough." No repair or new worker
authorization is implied by these findings.
