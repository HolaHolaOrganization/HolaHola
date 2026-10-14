# Founder ownership: readable promotion context

## Authority boundary

The task starting commit is not a promotion candidate. A promotion request carries the existing exact four-field descriptor: `purpose`, `repository`, `branch`, `candidateCommit`. Its existing canonical SHA-256 must match the challenge and receipt context digest. No field has been added to the signed ownership-proof payload.

The append-only side table stores a descriptor against its pending challenge. Inserts check the parent state and digest, exact keys/types, repository/branch/commit constraints and independently reconstructed canonical hash. UPDATE, DELETE and TRUNCATE are refused. Challenge and metadata creation share one transaction. An approved challenge cannot be retroactively given metadata.

Modern promotion attempts send the descriptor, use bounded promotion-specific idempotency keys and separate versioned attempt files. Deep-canonical comparisons support actual disk retries without overwriting older opaque attempts. Context-free request and signature contracts are preserved.

## Review and failure states

Only null context is context-free. An absent table/catalog failure is `storage_unavailable`; a present table without a descriptor is `descriptor_missing`. Parent/receipt/stored digest disagreement is `hash_mismatch`; malformed descriptors are `invalid`. Only verified context displays exact repository, branch, candidate SHA and both hashes.

Non-null context must verify before approval, nonce issuance and proof verification. Rejection and receipt revocation remain available. Registry scope remains informative and non-authoritative, as before.

This verification is not a live remote-head check and not permission to publish. Execution independently rechecks the selected branch and commit.

## Verification and rollout

- Focused projection, SSR, legacy/deep promotion retry and auth-negative route tests are registered in the consolidated CI list.
- `server/scripts/test-promotion-context-local-db.ts` requires an explicit loopback database named `ownership_context_disposable`; ambient shared/Neon connections are refused.
- `scripts/verify-ownership-ui.mjs` runs directly through Playwright against the actual admin UI, with fixture founder authentication and all API/WebSocket traffic intercepted. Decisions only modify fixture objects; no real account, role or approval writes occur. This does **not** prove real founder sign-in.
- Browser screenshots/results live under ignored `generated-artifacts/ownership-ui/`.

Migration `0066_ownership_promotion_contexts.sql` was generated from the shared schema and reviewed with Alden. Local PostgreSQL proof is **not** a full Neon migration gate.

**Still held:** disposable Neon gate under the established ownership authorization, shared migration, source/runtime publication and real founder sign-in verification. No READY_TO_PROMOTE claim. Until migration is properly authorized and applied, promotion requests fail explicitly with `PROMOTION_CONTEXT_UNAVAILABLE`; context-free requests continue without the new table. Existing opaque promotion requests need a new challenge, not a fabricated backfill.
