---
name: Neon destructive postconditions
description: Safety rule for interpreting destructive statements issued through Neon’s HTTP driver.
---

For approved destructive cleanup through Neon HTTP, use explicit allowlists and verify the committed database state independently after the statement. Success means every allowlisted row is absent and unrelated-row counts or fingerprints are preserved; a returned data-modifying CTE counter is not sufficient proof by itself.

**Why:** An exact, guarded cleanup removed precisely the approved rows while the statement response reported a no-op. Independent before/after totals and exact-ID queries proved the committed result. Treating the response counter as authoritative would have misreported the database state and risked an unsafe retry.

**How to apply:** Export the exact IDs before mutation, validate their shape and expected count, make deletion idempotent and allowlist-bound, then query the exact IDs and unrelated cohort immediately afterward. Preserve both preflight evidence and a postcondition receipt.

## Absence checks must fail closed

**Rule:** Resource absence is a conclusion from a successful, complete lookup, never from a lookup failure or missing output. Unknown cleanup state must remain unknown and block a clean result.

**Why:** A cleanup shell conditional swallowed a failed branch-list request and printed successful absence even with strict error and pipeline handling enabled. Shell conditionals intentionally consume command failure as a Boolean result. A replacement then correctly handled request failures but still treated the first page of a paginated provider response as the complete result.

**How to apply:** Verify lookup success separately from exact resource-identity matching. Exhaust documented pagination or refuse an absence conclusion when more results are indicated. Validate the evidence shape and distinguish "operation never started" from missing post-start evidence. Regression tests must distinguish lookup failure, malformed or partial evidence, successful complete absence and continued presence.

