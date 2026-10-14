---
name: Alden workspace verification
description: How to handle an Alden-side response that fails or claims edits without a trustworthy review.
---

An Alden priority-task response is not evidence that the workspace is unchanged
or that its claimed edits are correct. After any ambiguous, failed, or
incomplete Alden response, inspect `git status` and the actual diff before
preserving, replacing, or discarding changes.

**Why:** A failed response can still leave uncommitted workspace edits, and a
claimed policy update may be malformed or contradict an already confirmed
project rule.

**How to apply:** Treat the repository state as the source of truth. Restore a
known-good baseline first when a generated edit is malformed, then apply only
the intended narrow changes and validate them normally.

## Ground native onboarding advice against actual interfaces

---
name: Ground onboarding instructions before handing them to another runtime
description: Consulted guidance is not evidence of native readiness or a valid protocol.
---

Treat a consulted agent's onboarding examples as a draft, not an authoritative
protocol or proof that the destination runtime is registered and connected.
Check the actual routes, authentication policy and client parser before handing
off executable instructions.

**Why:** An orientation consultation supplied an incorrect host, auth guidance,
client arguments and posting shape, and asserted native registration without
evidence. A subsequent read-only own-actor route check verified the endpoint,
but could not establish the other runtime's authentication or result return.

**How to apply:** Use current source to ground the starting brief. Keep actor
catalog membership, credential configuration, authenticated requests and returned
work as separate claims. If guidance is wrong, correct the shared record and
move to the actual native connection check rather than repeating an open-ended
consultation loop.

