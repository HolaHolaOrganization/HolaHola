## Git add before a pathspec-scoped commit

A commit scoped to one path via `git commit -m "..." -- <path>` only succeeds
if `<path>` is already known to git (tracked, or already staged). For a path
that has never existed in the repository before, it fails with:

    error: pathspec '<path>' did not match any file(s) known to git

**Why:** `git commit -- <pathspec>` performs a "partial commit" of the
worktree state of already-tracked paths matching the pathspec; it is not
equivalent to `git add -- <pathspec> && git commit -- <pathspec>` and does not
pick up a brand-new untracked file. This is easy to miss when writing or
reviewing "commit exactly this one path, never `git add -A`" logic, because
it works fine once the path exists from a prior commit and only breaks on the
very first write to that path — exactly the case a first-sync/bootstrap path
is most likely to hit and least likely to get manually re-tested against.

**How to apply:** any code that converges a single tracked path to new
content and commits it in isolation (working-tree live-sync, scoped
publishers, reconciliation writers) must run `git add -- <path>` immediately
before `git commit -m "..." -- <path>`, even though the commit is already
pathspec-scoped. `git add -- <path>` stages only that one path and stays safe
regardless of what else is staged elsewhere; it never becomes `git add -A`.
Only a test that runs the sync against a brand-new path in a fresh repo
catches this — a test fixture that starts from a repo where the path already
exists from a prior commit will not.


## Use committer date, not author date, for recency filters

A CI/detection script that filters commits by "landed within the last N hours" using git's author date (`%at`/`%ad`) can silently misjudge a commit's age, because author date travels with the commit through rebase, cherry-pick, and `git commit --date=...`, and can be arbitrarily old (or deliberately backdated) even for a commit that just landed in the branch being checked. Committer date (`%ct`/`%cd`) reflects when the commit actually landed in the repository being inspected — a rebase or cherry-pick stamps a fresh committer date even when the author date is preserved from the original authoring time.

**Why:** confirmed via a hermetic regression test — a commit made with `git commit --date <10-years-ago>` (which sets only the author date; git always stamps the committer date with the real current time unless `GIT_COMMITTER_DATE` is also overridden) read as roughly 10 years old under `%at`-based age calculation, but correctly read as "just now" under `%ct`.

**How to apply:** any script answering "did this land recently" — recency-gated CI checks, staleness detectors, "what changed in the last N hours" reports — should use `%ct`/`%cd`, not `%at`/`%ad`, unless there is a specific reason to care about original authorship time rather than landing time.


## SSH hangs in git operations

Two independent ways a git operation can hang forever on an interactive SSH prompt in this environment, even when the push itself targets HTTPS.

### 1. Git LFS pre-push hook can hang mid-HTTPS-push

A `git push https://...` to a repo with Git LFS configured still runs the repo's `pre-push` hook (`git lfs pre-push "$@"`) before the push itself executes. That hook can attempt to negotiate the LFS endpoint in a way that shells out to SSH, producing an interactive host-key confirmation prompt (`The authenticity of host 'github.com' can't be established...`) that hangs indefinitely in a non-interactive shell — even though the push URL actually being used is HTTPS with its own token auth, and even though the commit being pushed contains no LFS-tracked paths at all.

**Why:** observed directly — an explicit HTTPS push authenticated with a GitHub App token hung on an SSH host-key prompt twice. `git config --get-regexp insteadof` showed no URL-rewrite rule, ruling out that explanation, and `git lfs status` confirmed no LFS objects were part of the commit. The hang stopped as soon as the same push was retried with `--no-verify` (skipping the pre-push hook entirely).

**How to apply:** for any scripted/non-interactive git push in a repo that has Git LFS hooks installed, add `--no-verify` when the commit has no LFS-tracked content, and always add `GIT_TERMINAL_PROMPT=0`, `GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=5"`, and `< /dev/null` as defense-in-depth so any unexpected prompt fails fast instead of hanging the command until timeout.

### 2. SSH-transport git operations hang without a pre-trusted host key

Any git operation that resolves to an SSH transport (e.g. a remote configured as `git@github.com:...`) hangs indefinitely on an interactive "authenticity of host ... can't be established" prompt if `~/.ssh/known_hosts` has no entry for github.com. `GIT_TERMINAL_PROMPT=0` does NOT suppress this — it silences git's own prompts (e.g. HTTPS credential prompts), not the separate `ssh` binary's host-key confirmation prompt.

**Why:** observed live — a `git fetch origin` / `git merge --ff-only FETCH_HEAD` chain hung 20+ minutes until manually killed, and separately, the reconciliation pipeline's own `preflight` fetch hit the exact same wall.

**How to apply:** run `ssh-keyscan -t ed25519 github.com`, verify the printed fingerprint equals GitHub's publicly documented ED25519 fingerprint (`SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU` as of this writing — cross-check docs if it ever looks different), then append the line to `~/.ssh/known_hosts`. This is environment-level, not repo-tracked, so it does not survive a fresh workspace/container and may need repeating there. It only fixes host-key verification — actual SSH authentication (a loaded deploy key) is a separate, independent requirement. In this project specifically, the working reconciliation path avoids SSH entirely by using a named HTTPS remote with GitHub App token auth instead — see `reconciliation-git-procedure.md`.


## Git LFS migrate import can rewrite unrelated refs

When an old ordinary Git blob must become an LFS pointer, do not trust a
branch-scoped `git lfs migrate import` to leave unrelated local refs alone.
Protect every original head first, then rewrite only the non-shared lineage
from the common ancestor. Preserve the original heads as backup refs and
rebuild the reconciliation merge on the unchanged GitHub head.

**Why:** The LFS migration command can rewrite backup and auxiliary refs in
the local repository even when a single branch was requested. Rewriting the
shared ancestor makes a normal non-force push diverge from GitHub.

**How to apply:** Identify the common ancestor, verify the exact source-byte
hash, replace only the known oversized blob in the `base..Replit-lineage`
range with its LFS pointer, scan the rewritten release for ordinary blobs over
GitHub's limit, run `git lfs fsck`, and only then create a new two-parent merge
with the current GitHub head before the guarded push.


## Blobless partial-clone commit recovery

In a `blob:none` partial clone, an ordinary diff or commit may try to fetch promised parent blobs. If the promisor remote is temporarily unavailable, do not change the remote, discard the staged work, or treat the fetch failure as a code failure. After independently verifying the working tree, stage it and write the tree with missing promised objects allowed; create the commit from that tree and update the branch atomically against the expected old head.

**Why:** A fully verified reconciliation bundle could be staged, but ordinary `git commit` failed while trying to materialize old blobs over an unavailable SSH route. The current index already contained the complete intended tree, and an atomic low-level commit preserved it without rewriting history or weakening validation.

**How to apply:** First scan for conflict markers and secrets, run the relevant tests, and confirm there is no Git lock. Remember that `git stash` and `git merge` can also trigger lazy promisor fetches; run them through the same protected deploy-key and pinned-host setup as the source-control coordinator. If the remote is unavailable but the intended index is already complete, use `git write-tree --missing-ok`, `git commit-tree` with the current head as parent, and `git update-ref` with the old head as the expected value. Never use this to bypass unresolved conflicts, hooks that enforce project policy, or a concurrently advancing branch.


## Linked-worktree verification can fall back to the parent repository

**Rule:** Verify the exact repository root before trusting `git -C <linked-worktree>` status, HEAD, or ignored-file results. A directory containing a copied checkout is not proof that Git is operating on that checkout.

**Why:** A restored workspace retained the linked-worktree metadata and files but lost the checkout's `.git` marker. Git silently found the enclosing main repository instead, returning its clean status and HEAD. The worktree list's prunable warning was the evidence that the apparent verification was against the wrong repository.

**How to apply:** Require `rev-parse --show-toplevel` to equal the intended path. If the marker is missing, verify using the preserved linked-worktree git directory and an explicit work-tree path, or repair the linkage before relying on its status. Never delete a purportedly clean duplicate until its own HEAD, uncommitted/ignored files, and recoverable history have been checked.

## Authorize Git filesystem access before acquiring a source lease

Before starting an approved protected source operation in Replit, authorize its required Git filesystem access at process launch. A verification or release-recording operation may fetch Git refs and therefore write Git metadata; it is not filesystem-read-only.

**Why:** Replit's Git permission guard can terminate the CLI outside its normal exception handling, leaving an abandoned source-control lease. A subsequent lock-refused operation changes the ready status and requires fresh preparation even when the source bytes have not changed.

**How to apply:** For founder-authorized canonical Git operations, use the platform's documented process-scoped Git permission flag before acquiring the source lease. This does not authorize direct pushes or bypass source validation. If interrupted, preserve the lock, let the canonical expired-and-dead-owner recovery run, and explicitly prepare the same approved bytes before recording. Never hand-edit the ready status or receipt.


## Remote-read-only fetch and local Git protection

Remote-read-only Git operations can still write protected local repository state. An authorized source-publication scope does not itself remove a workspace Git protection refusal.

**Why:** The canonical preparation CLI stopped while a fetch tried to update local FETCH_HEAD, before any external write or validation suite ran. Treating “read-only fetch” as “no local mutation” would have hidden the actual guard boundary.

**How to apply:** Keep the distinction between remote mutation, local Git writes, and validation results. Honor an approved rollout's stop-on-refusal rule; do not silently add a permission override or move execution to a manufactured checkout identity.


## Fresh GitHub metadata and dispatch identity

Live GitHub ref responses can be stale immediately after a successful landing. Resolve a mismatch with fresh cache-busted ref and branch reads and inspect their server dates before accepting either the reported landing or the old response.

**Why:** A normal ref read returned the former main while fresh ref and branch reads both returned the newly landed commit. Treating the first response as definitive would falsely block dependent work.

**How to apply:** Use independent fresh metadata for disputed live heads. A dispatch workflow's `head_sha` may identify its workflow/ref rather than a separately checked-out promotion candidate; verify the pinned input/checkout in job logs and the resulting main instead of equating those identities.


## Partial review repositories: bounded reads and automatic maintenance

Avoid broad content searches in blobless temporary review repositories.
Disable automatic GC/maintenance and bitmap writing in the disposable
repository before materializing objects; inspect the named candidate blobs.

**Why:** A broad subtree search can lazily fetch many unrelated blobs.
In a shallow, partial review repository this also triggered repeated automatic
repack attempts and bitmap-closure failures. These were review-environment
failures, not evidence that the candidate code failed.

**How to apply:** Limit reads to the candidate inventory and specific baseline
objects needed for the comparison. Configure gc.auto=0, maintenance.auto=false
and repack.writeBitmaps=false only in the disposable review repository.
Do not change the main checkout's maintenance policy or discard verified
source evidence because a temporary repository's automatic repack failed.

