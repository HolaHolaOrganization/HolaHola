# Alden source-delivery repair

Approved direction: bounded complete document pages, safe exact-source
continuity across turns/phases, and a delivery-coverage decision gate.

## Scope

Replace the shared-spec reader's unbounded payload with valid JSON pages
within the existing 12,000-character serialized budget. Include immutable
review/revision IDs, full content SHA-256, UTF-16 offsets, total length,
next offset and page digest. Never split a surrogate pair. Independently
verify the stored full-source hash before constructing a page.

An execution-local tracker stages successfully serialized pages and records
coverage only after the provider responds to the batch containing them, not
after DB reads or model assertions. Read and decide in one batch cannot use
that batch's unreceived source to authorize the decision.
Decisions require contiguous delivery of the
entire exact revision in this generation. Re-fetch the review target before
deciding and compare its immutable identity/hash. Missing coverage, changed
targets and missing tracker context fail closed for approval and rejection.

Persist only safe source references as versioned JSON in the existing text
Alden message context:
review ID, revision ID and content hash. Never store raw tool payloads,
document text, credentials or claimed comprehension. Load bounded recent
references from the current conversation, scoped to the engine. Carry them
explicitly between phases, outside truncated prose. They are re-read pointers,
not transferable authorization: each generation starts with zero coverage.

## Risks and boundaries

JSON escaping can exceed the budget; budget the entire actual serialized
response, not source length. Metadata must be bounded. Failed serialization
must not create coverage. Wrong-review decisions must not borrow another
review's coverage. Repeated/overlapping pages must not hide gaps.

Decisions explicitly supply the revision ID and full-source hash; server-owned
coverage and a fresh authoritative snapshot verify them. No caller-supplied
coverage token or claim is trusted.

No schema changes, engine switch, global read-coverage cache, general
tool-result logging, publication, Windows execution or worker activation.
Tool descriptions explain paging and exact-source rereading without claiming
that delivery proves understanding. Synthetic tests exercise both transports,
coverage failures, Unicode, wrong targets and phase resets.
