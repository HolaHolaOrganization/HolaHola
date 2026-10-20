## Actual event framing and full writer output

**Rule:** Aggregate-record attribution must use actual source-event boundaries and preserve every emitted voice. A writer's identity does not imply that every word it emits belongs to that writer.

**Why:** Attribution review exposed two related false assumptions: a label-shaped line inside authored dialogue was treated as a structural boundary, and named writers were assumed to emit only the principal's voice even when their blocks included other participants. Either assumption can destroy reliable attribution without visibly deleting the text.

**How to apply:** Bind frames to exact stored bytes using source-event framing, not searches through prose. Inspect each writer's full output, including nested replies and delegation results. Preserve non-target participants as explicitly framed records without borrowing the principal's hat, provider or model. Require real durable native event identities; unavailable receipts block activation rather than justify fabricated identities. Keep display replicas separate from database attribution authority.

Reference: shared-spec document `f5d77712-88b3-49c7-951a-720586148d34`, *Per-hat, provider and model attribution in the canonical conversation record*.

