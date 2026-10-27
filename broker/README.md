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

## Stage 1: source publication (design dc6f8927, section 4)

Source reaches a branch only through four signed steps, each its own operation under `executeOnce`. The steps live in `src/publication.ts` (pure validation) and `src/gateway.ts` (live checks, dispatch and reconciliation).

1. **`blob.put`:** the content must be canonical base64 that decodes to exactly `rawSize` bytes with the named git blob SHA. A metadata-only GraphQL existence check runs first, and an unknown result refuses the upload. A blob that already exists is reported as `already_present`, never as uploaded.
2. **`tree.create`:**
   - the base tree must be the parent commit's tree, and every referenced blob must exist;
   - paths must be normalized and unique, with no path that is both a file and a directory prefix of another;
   - entries are regular files only (`100644` or `100755`), at most 100, and never under `.github/workflows/`;
   - a result other than `expectedTreeSha` is a recorded failure.
3. **`commit.create`:**
   - the tree must be this actor's **recorded** `tree.create` success for this repository and parent;
   - every commit is self-origin (decision F2: trailer-only), so the author and committer are left to GitHub, which uses the App bot, and both are then verified;
   - the commit must match the request in tree, single parent, message and identity, or it is recorded as failed;
   - the broker trailer joins any existing trailer block in the message;
   - the effective origin actor is stored explicitly;
   - **an uncertain commit is never reconciled**, so it can never be published.
4. **`ref.update`:**
   - the new head must be this actor's **recorded** `commit.create` success, for this branch, with `beforeOid` as its parent;
   - it is applied by a single unforced `updateRefs` call that compares against `beforeOid`;
   - zero OIDs are refused;
   - the commit's tree, origin and PR carry through to the outcome.

**`ref.create`** starts a new branch only at the **live head of `main`**, only if the branch is absent, and only if no ruleset matches its name. It never points a branch at new work: all publication goes through `ref.update`.

**Branches:** every branch is under the actor's own prefix (`lcc/`, `lr/`), derived from the authenticated actor and never from the request. The default branch is never written.

**Retired operations:** `branch.create` and `commit.write`. They were a second publication path that bypassed the recorded-success gate.

**Not yet included:**
- large-body admission: requests keep the 64 KiB cap, so a blob over about 47 KiB raw is not yet publishable;
- relay origin attestations;
- origin-aware `pr.review` exclusion.

Each of those is a later stage-1 PR. The behaviour of GraphQL object existence, `updateRefs`, and App-created commit identity are sandbox acceptance proofs, not yet run.
