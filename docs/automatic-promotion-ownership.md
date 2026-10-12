# Automatic ownership verification for source promotion

Promotion now obtains its own fresh key-possession proof before branch
freshening, before uploading any resulting merge, and before GitHub dispatch. A separate `prove` CLI invocation
is not required, and its successful result is never reused as authority.

## Normal operation

Configure the host's **own** `COORDINATION_ACTOR`, its matching coordination
credential, and `COORDINATION_API_URL` (the trusted HolaHola server origin).
Do not use another actor's credential. The `--source` label is not identity.

First publish the reviewed candidate branch. Request approval for its exact
commit (the CLI checks both local HEAD and the fetched branch):

```sh
npx tsx server/scripts/task-ownership-cli.ts begin \
  --task-ref <task-ref> --actor <your-actor> --app-url <trusted-origin> \
  --promote-branch <reviewed-branch> --promote-commit <full-40-hex-commit>
```

For explicit renewal of an expired, never-approved request, use `renew` with
the existing `--challenge-id` and both promotion flags. Renewal never replaces
an approved decision. Publish the printed repository, branch, candidate commit
and context digest on the coordination thread before asking for approval.

After candidate-specific founder approval:

```sh
npx tsx scripts/cross-tool-promote.ts push <reviewed-branch> --task-ref <task-ref>
```

`--actor` and `--app-url` may supply identity and origin explicitly. An explicit
actor must agree with `COORDINATION_ACTOR` when that variable is set.

Begin/renew retains immutable **public challenge handles** under
`.local/task-ownership-discovery/`, scoped by server origin, actor and task.
Promotion reads authenticated status to discover the receipt, then loads the
existing custody key, obtains a new nonce, signs it and asks the server to
verify it. The exact local artifact digest, actor, task, receipt, key and expiry
must agree. Both proof responses and the artifact are checked before returning
verified ownership.

The local handle and status are discovery hints, not approval or proof. Older
status responses without public binding fields cannot weaken the subsequent
nonce/result binding checks. Keep handles with the worktree; no receipt or
verified result is cached.

## Candidate binding and controlled freshening

The descriptor is canonical JSON with purpose `cross-tool-promote`, canonical
GitHub repository, branch and candidate commit. Its SHA-256 is carried in the
existing `context_digest`; no new database field or migration is required.
The server includes that digest in both nonce issuance and signature
verification, using one shared payload builder. Null-context proofs retain
their original payload shape. Standalone proof explicitly requests no runtime
grant, and promotion rejects an unexpected grant.

Task-only approvals and Antigravity bundle approvals cannot authorize promotion.
Before freshening, local HEAD and the fetched remote branch must both equal the
approved candidate. The only permitted derivative is this process's own
`--no-ff` merge with exactly two parents: approved candidate, freshly fetched
main. Its SHA is retained only in memory, rechecked with fresh proof before
upload and dispatch, and uploaded by immutable SHA rather than a moving branch
reference. A later process cannot reconstruct that exception from Git history.
It needs approval of its current candidate.

Dispatch includes `expectedSha`. The workflow validates its format, checks out
that SHA rather than a branch name, and refuses a branch that no longer names
it. Subsequent branch movement cannot change the checked-out code. Existing
main-ancestor and pre-production-operation checks remain in place.

## Explicit receipt discovery

Hosts without discovery handles can supply a candidate-bound receipt ID for
that invocation; it still obtains a fresh server proof. An old task-only receipt
is not compatible and will be refused:

```sh
npx tsx scripts/cross-tool-promote.ts push <reviewed-branch> \
  --task-ref <task-ref> --actor <your-actor> \
  --app-url <trusted-HolaHola-origin> --receipt-id <approved-receipt-id>
```

Do not create another key or renew an approved challenge just to add a handle.
Generic, non-promotion begin/renew and runtime grant contracts remain available.

## Rollout hold and approval UI dependency

The old workflow does not accept `expectedSha`, and the old server omits the
context digest from proof nonces. There is no fallback to either old behavior.
The new workflow and proof receiver need separately authorized publication
before using this client. This build does not dispatch, publish or migrate.

Task 1724 remains blocked on its registry/release dependencies. Its scope must
include rendering the decoded promotion descriptor (repository, branch and
full candidate SHA), verifying its canonical digest against `contextDigest`,
and refusing a mismatched descriptor at approval. Until that UI lands, founder
visibility requires the CLI's full descriptor posted on the coordination
thread; the digest alone is not a readable approval description.

## Fail-closed behavior

Missing custody/approval, revoked or expired receipts, malformed responses,
identity or artifact mismatch, unreadable/conflicting discovery state,
ambiguous active receipts and unavailable endpoints stop promotion. The
artifact is reread after the server proof to detect changes during verification.
Requests have a fifteen-second timeout and do not follow redirects.

Promotion never begins or renews a challenge, approves a request, creates a
key, rotates custody, mints runtime execution authority or falls back to an
unverified probe. The general infrastructure guard retains its deny-by-default
behavior for callers without a real verifier.

This proof does **not** approve unreviewed branch scope, migrations, data
operations or runtime publication. Cross-tool promotion still freshens against
main and runs the existing workflow; its SYNCED result is source promotion,
not evidence that the published runtime serves those bytes.

## Verification scope

The focused promotion test suite uses private temporary Git repositories and
local bare remotes, private custody, synthetic authenticated HTTP responses,
real Ed25519 signatures and separate CLI processes. Git configuration and hooks
are fixture-local; the harness does not shadow Git with a Unix-only executable.
It never approves a real challenge, dispatches a real workflow
or accesses shared database rows. Native Windows evidence and live release
results must be recorded separately from Linux fixture results.
