## Recovery must preserve exclusion throughout intermediate steps

Renaming a lock aside and inspecting its token afterward is not compare-and-swap, even when a mismatched token is restored using a no-overwrite hard link.

**Why:** Independent synthetic real-filesystem interleaving showed a stale releaser renaming a live foreign owner's lock aside. A third contender successfully created the temporarily absent lock path. Restoring the original lock then failed because the new contender owned the path, leaving two live owners. Sequential before/after tests passed while missing that interval.

**How to apply:** Test a contender inside every namespace-changing recovery step. Token comparison after temporarily removing a foreign lock does not prove exclusivity. Use an ownership protocol that preserves exclusion throughout recovery, or fail closed rather than automatically recovering. Keep this separate from server idempotency and native operating-system evidence.

