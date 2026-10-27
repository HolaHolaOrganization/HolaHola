# holahola-broker

The isolated GitHub operation broker from costed plan `ff04f70e`. The founder approved building it as decision D1 on 2026-10-18.

**Status: phase 2 (2a GitHub access, 2b gateway). It is not deployed, and the server has no production entry point yet.**

- `src/canonical.ts`: the canonical JSON that clients sign.
- `src/policy.ts`: parses `broker/policy.json` and computes its policy epoch, which is the git blob SHA. The loader caches it for at most 60 seconds and fails closed, with no stale fallback.
- `src/envelope.ts`: verifies the signed request envelope. It checks Ed25519 signatures against the actor's keys in the policy, the bindings to audience, repository, PR, head, payload and epoch, and a validity window of at most 60 seconds.
- `src/authorize.ts`: the decision. Phase 1 has no gateway operations, so every request is denied: `closed` returns `policy_closed`, and every other state returns `not_implemented`.
- `src/claims.ts`: unique-executor operation claims, from plan revision 4.
  - Each write is a compare-and-swap on the ledger branch head, so at most one broker instance executes a given `(actor, operationId)`.
  - The same id with a different digest is denied.
  - A claim with no outcome is `pending` until its deadline and `uncertain` after it. An uncertain claim is never re-executed.
  - Reconciliation is positive-only: it records `applied` when GitHub shows the effect, and never a negative outcome, because a deadline does not prove a slow winner has stopped.
  - A winner past the start budget does not begin its effect.
  - Retrying under a new operation id is a deliberate decision, never automatic.
  - The ledger is an interface. The real audit-repository ledger comes in phase 2.
- `src/server.ts`: two routes, `GET /healthz` and `POST /v1/operations`. There is no passthrough and no admin route.

It is kept separate from the web app: it has its own tree, its own `package.json` and no runtime dependencies, and it never imports from `server/`, `shared/` or `client/`. Only erasable TypeScript syntax is used, so a later deploy can run the source directly on Node with type stripping.

Tests: `npx tsx --test broker/test/broker.test.ts broker/test/claims.test.ts`. Typecheck: `npx tsc -p broker/tsconfig.json`. Both are registered in `scripts/run-ci-test-steps.mjs`.

## Phase 2

- **`src/github.ts`: GitHub access.** One fixed API base. Each App installation token is scoped to one repository with explicit permissions, and is never returned. Policy is read from `main`. The audit-repository ledger commits with `createCommitOnBranch` and `expectedHeadOid`, after checking that every file is absent at that head.
- **`src/authorize.ts`: authorization by state.**
  - The policy is read through the requesting actor's own loader.
  - `closed` allows nothing.
  - `qualification` allows only the exact listed (PR, head).
  - `routine` allows every named operation.
  - `branch.delete` is always denied, because GitHub has no compare-and-delete.
- **`src/gateway.ts`: the named operations, each run through `executeOnce`.**
  - Payloads are validated strictly. Callers cannot write broker markers.
  - The repository, PR and ref are bound from trusted configuration and the signed envelope.
  - A preflight runs after the claim and after every preparatory await. It looks up the token and the live PR or ref, then re-runs the full authorization.
  - Each operation makes exactly one dispatch. A 4xx response is a recorded failure. Any unknown result is never resent and stays uncertain.
  - Evidence is positive-only, bound to the App identity, the target and the head. `pr.update-branch` has no reliable evidence and stays uncertain.

## Stage 1: instance target (decision F4-a)

Each broker instance acts on exactly **one** repository, fixed by its own environment for the life of the process.
- **Production (default, `BROKER_TARGET` unset or `main`):** the main repository, with policy from `broker/policy.json`.
- **The temporary sandbox instance (`BROKER_TARGET=sandbox`):**
  - its target comes from `BROKER_TARGET_REPO` (owner/name) and `BROKER_TARGET_REPO_ID`;
  - the target can never be HolaHola, under any owner or by id, and never the audit repository;
  - it reads `broker/policy.sandbox.json`, always from **main of HolaHola**, never from the sandbox, so sandbox writers cannot edit their own policy.

**Binding to the target:** a policy whose `repositoryId` is not the instance's target fails closed. So does a request or status original that names another repository. Nothing is multiplexed.
