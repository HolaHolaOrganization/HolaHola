# holahola-broker

The isolated GitHub operation broker from costed plan `ff04f70e`. The founder approved building it as decision D1 on 2026-10-18.

**Status: phase 1 (1a and 1b). It is not deployed, has no entry point and is not wired to anything.** It contains:

- `src/canonical.ts`: the canonical JSON that clients sign.
- `src/policy.ts`: parses `broker/policy.json` and computes its policy epoch, which is the git blob SHA. The loader caches it for at most 60 seconds and fails closed, with no stale fallback.
- `src/envelope.ts`: verifies the signed request envelope. It checks Ed25519 signatures against the actor's keys in the policy, the bindings to audience, repository, PR, head, payload and epoch, and a validity window of at most 60 seconds.
- `src/authorize.ts`: the decision. Phase 1 has no gateway operations, so every request is denied: `closed` returns `policy_closed`, and every other state returns `not_implemented`.
- `src/claims.ts`: unique-executor operation claims, from plan revision 4.
  - Each write is a compare-and-swap on the ledger branch head, so at most one broker instance executes a given `(actor, operationId)`.
  - The same id with a different digest is denied.
  - A claim with no outcome is `pending` until its deadline and `uncertain` after it. An uncertain claim is reconciled against GitHub and never re-executed.
  - The ledger is an interface. The real audit-repository ledger comes in phase 2.
- `src/server.ts`: two routes, `GET /healthz` and `POST /v1/operations`. There is no passthrough and no admin route.

It is kept separate from the web app: it has its own tree, its own `package.json` and no runtime dependencies, and it never imports from `server/`, `shared/` or `client/`. Only erasable TypeScript syntax is used, so a later deploy can run the source directly on Node with type stripping.

Tests: `npx tsx --test broker/test/broker.test.ts broker/test/claims.test.ts`. Typecheck: `npx tsc -p broker/tsconfig.json`. Both are registered in `scripts/run-ci-test-steps.mjs`.
