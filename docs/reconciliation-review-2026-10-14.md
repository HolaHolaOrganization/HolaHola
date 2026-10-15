# Preparatory reconciliation candidate — not canonical-ready

## Authorization and boundaries

David authorized preparation of an isolated reconciliation candidate on
2026-10-14. This is direct Luca [Replit] work, not an isolated task-agent
dispatch. The two already-running task agents may finish; their results have
not been merged or incorporated here.

Primary main, running services, shared database schema, Windows installations,
credentials, source synchronization and publication are outside this change.
Guardian development work remains outside the candidate.

## Immutable history inputs

- Local parent: `25be2f5418c3e5c7515976db92f732bc86a2dcd1`
- GitHub parent: `239eceaaeb2dcb03c8e2d14f605c34d16a51fe17`
- Common ancestor: `c7481d8083087cf6f9904d7d56e7f34ce19c409b`
- Fresh GitHub ref checked before construction.
- All 50 pending primary source/record files were copied and byte-hashed before
  worktree creation. Copies and inventory are under
  `/tmp/holahola-reconciliation-preservation-20261014/`.
- Worktree: `.local/reconcile-review-20261014`.

The normal candidate executor requires a clean primary worktree. It was not
used, and primary work was not discarded, stashed, committed or cleaned to
satisfy that requirement. This manual candidate must not be represented as a
successful canonical preparation or publication.

## Conflict decisions

| Path | Resolution and evidence |
| --- | --- |
| `docs/episode-34.md` | Read the rolling episode through Neon HTTP and project its canonical content. All 3,826 local-side and 1,011 incoming-side distinct nontrivial additions since the common ancestor are present. No source dialogue was reconstructed. |
| `docs/luca-to-claude-code.md` | Render from the canonical mailbox ledger, not a hand-merged snapshot. |
| `docs/mailbox-ledgers/luca-to-claude-code.json` | Read canonical unread notes and use the existing normalized ledger formatter and receipt writer. Both mailbox directions preserve all 140 historical IDs, subjects and bodies; the resulting snapshots contain 146 unread notes. This preparation retains all unread notes rather than truncating the snapshot to the live reader's 100-note cap; no live reader behavior changes. |
| `docs/shared-task-registry.md` | Preserve the local documentation, a superset retaining the staged-only verification and release holds. |
| `migrations/meta/_journal.json` | Preserve the local exact incoming prefix plus migration 0066. The migration 0065 SQL and snapshot Git blobs are identical on both sides. No migration was generated or applied. |
| `package.json` | Preserve the effective override block, remove the shadowed duplicate block as main does, retain the exact historical compiler alias and explicit normal-compiler build wrapper. |
| `server/services/founder-task-ownership-service.ts` | Preserve local scope enrichment, descriptor enforcement and locking. The incoming changes do not justify deleting these local safety additions. |
| `server/services/task-ownership-attempt.ts` | Preserve the local V2 descriptor, canonical retry comparison, versioned state paths and bounded hashed keys. No old attempt files are migrated or reused. |
| `server/services/task-ownership-attempt.test.ts` | Preserve both test sets. Port main's length/stability/candidate-separation test to the V2 namespace and additionally verify the exact task/fingerprint/context-bound digest. The namespace change is deliberate, not an assertion removed to obtain a pass. |
| `server/services/task-ownership-client.test.ts` | Preserve the local suite imports and explanatory comment. No test registration is dropped. |

## Other protected source and metadata

- Memory projections were regenerated through the canonical memory CLI into
  this worktree, not hand-merged.
- Shared Agent Instructions were read from the approved shared-spec revision.
  All incoming additions since the common ancestor are present.
- Mailbox projections use read-only canonical data and candidate-local
  projection receipts. No note was marked read or altered.
- Migration 0066, its snapshot, shared schema and ownership UI/context code
  remain staged source; their presence is not activation or release approval.
- Existing incoming workflow and listener changes remain included.
- Pending Guardian implementation, new Guardian test files and their pending
  CI registrations are excluded.

## Revised Gate 3 authority boundary

The live launcher is byte-identical to GitHub main:

- Live run: `b80917ae986766ad46e31c6c17b8b1002b9bb37aad68b42db846f4c3f6bda696`
- Live prepare: `06ce0e36c270bb3796e5b528ceee0200bc334991c0bd512b64ac80d0ddd475ab`

The archived fixture remains unchanged, including its original launcher:

- Historical run: `5e620f6bc4cc5fb2dcf869efbfbbecc79a995178439e30191ada5b19d273363e`
- Historical prepare: `06ce0e36c270bb3796e5b528ceee0200bc334991c0bd512b64ac80d0ddd475ab`

Historical verification reads the byte-verified archived launcher, never the
live launcher or a caller-selected replacement. A separate current-source
build check uses the application's compiler API and verifies both live pins.
Mutation controls cover the archive and live pin assignments, including
misleading comments. Historical output is never executed.

The lockfile was regenerated against the merged manifest without installing
packages. Compared with incoming main, the only package identity addition is
the exact `gate3-historical-esbuild` alias at 0.25.9. Its generated internal
proxy URL was normalized to the existing canonical npm tarball URL only after
checking identical version and integrity against both main's normal compiler
entry and the preserved alias. No registry configuration or firewall policy
was bypassed, and proxy-addr was not upgraded.

## Verification and remaining gates

Passed during preparation:

- `npm run typecheck`
- Focused Gate 3, ownership-attempt, promotion-context and scope tests: 92/92
- `npx tsx server/scripts/verify-system-health.ts`:
  `All checks passed — safe to mark done.`
- `npm run test:package-lock-registry`: 1,016 canonical tarball URLs accepted
- The updated runbook guard passed after the documentation changes
- Canonical mailbox JSON/Markdown round trips and historical note preservation
- Canonical episode and live-instruction added-line coverage
- Primary pending source byte conservation and Guardian exclusion
- Candidate live launcher byte equality with incoming main

The health verifier's generic success text is not publication authorization.
This candidate has not passed full consolidated CI, a fresh full-app install,
native Windows verification, or independent exact-candidate review. Earlier
approval of the original archive does not approve this revised integration.
The earlier implementation rejection remains part of the record.

Canonical source preparation, moving primary main, integrating task-agent
outputs, applying shared migrations, installation and publication require
separate authorization and revalidation against then-current heads.

## Successor validation — October 15, 2026

David authorized completing the remaining isolated validation and fixes.
The previously reviewed candidate remains immutable. This successor:

- Restores the exact approved Shared Agent Instructions bytes from the
  shared-spec raw export; they are byte-identical to the GitHub parent.
- Includes the separately authorized no-automatic-migration setup guard,
  its three hermetic tests and registration in the canonical CI runner.
- Updates Express within major 4 and the compatible proxy-addr patch to
  2.0.8, plus the Capacitor family within major 7 to 7.6.9. The old locked
  proxy-addr and iOS packages were rejected by the package firewall.
  The fresh dependency install succeeds through that firewall; no security
  registry bypass was used. Newly resolved portable lock URLs retain the
  verified registry integrity hashes.
- Updates the real-PostgreSQL ownership fixture to supply the now-required
  promotion descriptor and matching canonical digest, verifies stored context,
  and explicitly rejects missing descriptors and mismatched digests. Its
  connection pool is closed after the test. The first disposable gate found
  this stale fixture; the production descriptor guard is not weakened.

Native scratch-worktree dependency installation, synthetic-only DPAPI tests
and credential-free current-source smoke tests are validation, not runtime
activation or real-credential operations. Restricted Windows policy and
harness denials remain in force; blocked checks must be reported as not run.
LCC owns native verification and independent successor review.

The successor still excludes pending Guardian development and task-agent
outputs. Shared migration, primary-main movement, publication and activation
remain separate authorization boundaries. Current validation results are
recorded externally against the exact successor hash, not inferred from
the original candidate's checks or approval.

## Provisioning regression and purpose-separated successor — October 15

The full disposable gate exposed a real operator-provisioning regression:
the new promotion-descriptor requirement had also been applied to generic
runtime bundle digests. The unchanged GitHub baseline passed the same
coordination suite; the failing test was not weakened or removed.

This successor records immutable challenge purpose: context-free ownership,
runtime provisioning, or source promotion. Receipts inherit their parent's
purpose. Only promotion challenges require the exact promotion descriptor;
runtime proofs cannot authorize standalone source promotion, and promotion
challenges cannot authorize Gate 3 runtime grants or assignment windows.
Public challenge requests cannot choose the trusted provisioning purpose.
The founder UI labels each purpose and blocks unclassified legacy digests.

Staged migration 0066 adds the nullable column before setting its future
default, leaving historical rows unclassified without a forbidden provenance
update. A separate immutable-purpose trigger supplements the existing
lifecycle guard. The promotion-context trigger requires a source-promotion
parent. Existing descriptor, hash and parent-binding checks remain intact.
If the independently reserved competing 0066 lands first, regenerate at the
next free ordinal and repeat the migration gate; never overwrite its history.

The frozen six-module ownership launcher remains unchanged.
The pinned Gate 3 exact-key wire DTO is also preserved: purpose remains
available to server checks and standalone proofs, not added to that DTO.
Checks and independent approval must name this successor, not inherit the earlier
source-only approval. Shared migration, public-history exposure, main
movement and runtime activation remain unapproved and are not performed.

## Structural engine-guard successor

The preceding purpose-separated source passed all 145 unit commands, all
142 coordination-ledger cases and the shared-spec unit stage. Its canonical
gate then stopped at guard 51: exact closed-object strings rejected the
legitimate added review-session metadata in the context type and persona
calls. The engine fields and per-call runtime behavior were still correct.

This successor changes only verification scripts and this note. The static
engine guard now parses the real TypeScript declaration and live call sites,
retains optional conversation/engine typing and literal caller-owned engines,
allows ordinary extra metadata, and rejects spread/computed overrides.
The original two-process behavioral mutation remains intact. New mutations
prove removed/comment-only engine fields, wrong caller engines and context
spreads are rejected. Normal guard, expanded self-check and the three remaining
guard commands passed against the verified disposable Neon branch.

The system-health verifier now explicitly requires the staged promotion-context
table. It passed with zero failures and two acknowledged warnings: app-route
storage reads were not run because this isolated source validation has no
running application server. Direct storage reads and the standard temporary
copy probe passed; mocked failure-path warnings were expected test output.
No server was activated to silence the two warnings.

This is not a canonical-gate pass. Final checks and independent approval must
name the new frozen successor. Earlier approvals and gate results remain
attached to their original bytes. All publication, migration and runtime holds
above remain in force.
