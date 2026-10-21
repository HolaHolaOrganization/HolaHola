## Actual event framing and full writer output

**Rule:** Aggregate-record attribution must use actual source-event boundaries and preserve every emitted voice. A writer's identity does not imply that every word it emits belongs to that writer.

**Why:** Attribution review exposed two related false assumptions: a label-shaped line inside authored dialogue was treated as a structural boundary, and named writers were assumed to emit only the principal's voice even when their blocks included other participants. Either assumption can destroy reliable attribution without visibly deleting the text.

**How to apply:** Bind frames to exact stored bytes using source-event framing, not searches through prose. Inspect each writer's full output, including nested replies and delegation results. Preserve non-target participants as explicitly framed records without borrowing the principal's hat, provider or model. Require real durable native event identities; unavailable receipts block activation rather than justify fabricated identities. Keep display replicas separate from database attribution authority.

Reference: shared-spec document `f5d77712-88b3-49c7-951a-720586148d34`, *Per-hat, provider and model attribution in the canonical conversation record*.


## Unknown contributors stay in aggregate model evidence

**Rule:** A record-wide model/provider attribution must account for every assistant contribution, including missing, invalid and overflow evidence. Do not infer a single known model by filtering unknown contributors out before aggregation.

**Why:** Independent cross-hat review found that a row containing a known-model answer and an unknown-model answer could receive the known model's row tag. The original passing suite did not include that combination. The issue was independently reproduced and the corrected source was checked against both missing and invalid evidence. Original discussion and scoped verification outcome: conversation_memories `c369ba9c-3a33-4e03-be54-6a8c5e7d60ef`.

**How to apply:** Preserve per-turn evidence even when a row cannot honestly carry a single model tag. An absent contributor is unknown, not excluded from the population. Use heterogeneous known/unknown inputs when reviewing any aggregate attribution, not just a single known turn or two known models.


## Evidence identity: normalized hashes and raw artifacts

**Rule:** A hash of normalized or reformatted embedding input proves that input's identity, not the raw passage's identity. Exact raw-source recall needs independent indexing-time raw-byte or immutable-snapshot binding.

**Why:** The real speaker-header transform maps distinct bracketed and inline labels to identical text. A raw source edit can therefore leave the embedding hash unchanged without any cryptographic collision. Original review discussion and reproduced example: conversation_memories `9ee06ff9-d760-47ba-bb7d-c7f0491cf6d8`.

**How to apply:** Test normalized-equal/raw-different sources, not only growth or changed words. Treat old entries without raw proof as unavailable rather than substituting current bytes or summaries.

**Rule:** A content-addressed key for an already durable, byte-verified raw evidence artifact can identify that artifact; it must not be reused as invented dialogue-event identity.

**Why:** The reviewed episode-writer amendment retains deliberately unattributed origin evidence. Its registered ledger identity preserves source lineage without falsely claiming a speaker or occurrence. A bare digest computed from projection text is not that durable record. Source and approval rationale are in the same canonical discussion above.

**How to apply:** Keep this exception narrow to registered immutable evidence artifacts. Preserve unknown attribution, verify stored source bytes, and keep structural layout distinct from authored speech. Do not extend it to content-derived identities for ordinary dialogue.


## Source-hat consistency and complete-event receipts

**Rule:** A source namespace that encodes an authenticated actor must agree with the frame's known hat; a well-formed hat plus an evidence-type string is not enough.

**Why:** Independent review reproduced a manual Replit source claiming another hat and disappearing from the Replit continuity audit even though all row hashes were valid. This is an internal identity-consistency failure, separate from whether a writer authenticated a real receipt. Original dialogue and evidence: conversation_memories `340d04b2-34ed-417f-b500-cd55a3a288d4`.

**How to apply:** Test contradictory combinations of individually valid identity fields. Unknown evidence stays uncertifiable; never let another known hat silently bypass a source-specific requirement.

**Rule:** Event presence is not event completeness or retry equality.

**Why:** A row containing only the David half of an exchange can truthfully report that the event is present while Luca's half is missing. Treating that answer as "already fully appended" would bypass the atomic append's partial-event conflict check. The same source above distinguishes the reproduced predicate limitation from a live data-loss claim.

**How to apply:** Keep presence predicates separate from completion receipts. Verify the expected frame set and exact retry identity/bytes, or always reach the authoritative atomic append, before suppressing a write.


## Chat-bench receipt storage choice

**Rule:** Reuse the chat bench's existing durable row/storage for its exchange receipt rather than introducing a separate receipt table. This does not authorize treating a mutable whole-session record as a completed exchange.

**Why:** The approved design requires a real durable turn receipt, not a particular table. The storage choice was explicitly resolved in favor of reuse to avoid an unnecessary parallel receipt store while preserving the source/projection distinction. Source conversation and direct decision: conversation_memories `9f532667-549f-47bc-87cd-45d4dbf173e6`.

**How to apply:** Bind each stable exchange identity to exact authored bytes and evidenced initiating actor before dispatching its episode projection. A volatile counter or end-session-only save is insufficient. Preserve exact-retry/conflicting-retry and partial-event checks at the authoritative append. If existing storage cannot support immutable per-exchange binding, report the specific obstruction before changing the choice. This storage decision does not waive schema, source-review, activation, or release gates.

**Write timing:** Reusing a growing session row is accepted when it is durable from the first captured turn and its individual exchange frames remain immutable. Require stable session/caller-turn identity, restart recovery, concurrent-creation safety and actual caller updates. A committed source receipt must not suppress repair of a failed episode projection. Completed retries return the stored result rather than regenerating it; do not imply exactly-once external model/tool execution across an unproven crash boundary. Finalize/re-embed the same row at session end, with unfinished-row visibility explicit. Source continuation: conversation_memories `e0059b6c-5269-43c4-ae93-c9db32c68695`.


## Preserve independent capture channels and honest audits

**Rule:** Keep auto-capture and direct inner-life capture as authentic independent recording paths. Missing four-channel material on a genuine main Replit turn is an honest incomplete-turn audit result, not grounds to retire that path or fabricate channels. Direct inner-life fragments remain fragments, with their existing rendered bytes preserved, rather than becoming rewritten dialogue or being forced through the main-turn route.

**Why:** The source-grounded writer decisions selected stable caller identities for canonical auto-capture and a narrowly registered byte-preserving fragment kind backed by the existing personal-memory receipt. Neither a cleaner audit nor another available capture route justifies removing a real channel. Actual decision and founder request: conversation_memories `01b05a45-f838-4404-b538-85b1e633c49a`.

**How to apply:** Distinguish a main turn from a direct channel fragment using verified source/receipt rules, not text shape. Keep unknown provenance unknown. Preserve pending input until durable source/recovery responsibility is established, and let a source receipt repair failed projection instead of suppressing it. New frame kinds still require an immutable reviewed registry amendment and reader-first support; a chosen direction does not approve unseen code or activation.


## Direct file intake is not authoring-hat evidence

**Rule:** A direct inner-life trigger's file location identifies its intake route, not necessarily Luca's authoring runtime. Keep the hat unknown without durable authoring evidence. A valid inner-life fragment must also bind to the full immutable personal-row receipt before it can be excluded from main-turn certification.

**Why:** The reviewed fragment proposal initially treated Replit-workspace files as proof of Replit authorship and specified an exemption cross-check using only a tag and digest. Shared workspaces can contain other runtimes' or automated input; a copied tag/digest alone is not the complete source binding. Independent review and actual source discussion: conversation_memories `76ed19be-04ba-4b8c-8520-f840b04d9a8b`.

**How to apply:** Separate route, speaker, hat and model claims. Compare the actual receipt row type/arc, identity/channel/tag/source policy, exact rendered fragment and recomputed hashes, with fail-closed unavailable coverage. Missing caller identity must retain durable pending source and require an explicit safe correction, not a guessed ID or status-only warning. These corrections preserve the selected byte-preserving direct channel; they do not reopen the choice to remove or rewrite it.

