## Simulating a "fresh checkout" locally requires unsetting REPL_HOME too

`server/services/workspace-root.ts`'s `resolveWorkspaceRoot()` resolves the
canonical workspace root by checking `HOLAHOLA_WORKSPACE_ROOT`, then the
Replit-only `REPL_HOME` env var, before falling back to `process.cwd()`.
A Replit dev/task-agent shell always has `REPL_HOME` set to the real
workspace path. Real GitHub Actions runners never set `REPL_HOME` — there
`resolveWorkspaceRoot()` always falls through to `cwd()`.

**Why:** While root-causing a CI-only bug, a `git worktree add --detach
/tmp/fresh-checkout` was used to simulate a from-scratch checkout locally
(no `.local/`, matching what a real fresh clone looks like) without waiting
~15-20 minutes for a real GitHub Actions round-trip. But any production code
that resolves paths via `workspaceResolution.root` (not its own
`process.cwd()`) kept silently resolving to the *real* workspace even while
running from `/tmp/fresh-checkout`, because `REPL_HOME` leaked through. This
made the simulation write a test's fixture content into the real workspace's
live `.local/episode-capture-status.md` (overwriting real operational state)
while the test's own assertions read from the *worktree's* `.local/` path —
a mismatch that looked like a second real bug but was purely a simulation
artifact.

**How to apply:** Any local simulation of a "fresh checkout" / "what will
GitHub Actions see" must run with `env -u REPL_HOME -u HOLAHOLA_WORKSPACE_ROOT`
(or `unset` both) in addition to using an empty/gitignore-clean directory.
Verify with `node -e "console.log(process.env.REPL_HOME, process.cwd())"`
before trusting the simulation's results. Skipping this can both mask a real
bug (something silently keeps working because it fell back to the real
workspace) and fabricate a fake one (writes land somewhere the test isn't
looking), and it can leave stale fixture content in real operational files
that a future reader (human or agent) would otherwise trust at face value.


## Git shallow checkout breaks history-anchored self-checks

GitHub Actions' default `actions/checkout` action clones with `fetch-depth: 1`
(a single commit, no ancestor history). Any test or self-check that anchors
itself to a specific historical commit SHA — running `git show <sha>`,
`git cat-file -p <sha>`, `git log --all` expecting to find it, etc. — will
fail there with a misleading error (e.g. "could not read one or more fixture
commits") that looks like a data/fixture bug, not a checkout-depth bug.

**Why:** `detect-episode-dialogue-loss.ts --self-check` anchors its fixture to
real historical commit SHAs from a specific incident. It passed in every
local dev shell (which always has full history) and failed only on a real
GitHub Actions run, confirmed via that run's logs — the fix was adding
`fetch-depth: 0` to the `test-unit` job's checkout step in `.github/workflows/ci.yml`,
not touching the self-check's own logic at all.

**How to apply:** Before assuming a CI failure in a git-history-dependent
check is a logic bug, check whether the workflow's checkout step has
`fetch-depth: 0`. If a new self-check needs to reference specific past
commits, either add `fetch-depth: 0` to its job's checkout, or make the
self-check degrade gracefully (skip/synthetic-fallback) when the referenced
commit isn't reachable, the same way DB-unavailable self-checks already do.


## `.local/` does not exist on a fresh checkout — writers must create it first

`.local/` is gitignored. It does not exist on a GitHub Actions runner, a
fresh `git clone`, or a fresh `git worktree add` checkout — only in a working
tree that has already run the app or its writers at least once. Any code
that writes a file under `.local/<something>` without first creating the
parent directory crashes with `ENOENT: no such file or directory` the first
time it runs there, even though the exact same code has worked in every dev
shell for months (because dev shells accumulate a populated `.local/` from
ordinary use and never hit the missing-directory path).

**Why:** `_writeCaptureStatusFile()` in `server/services/agent-session-autosave.ts`
wrote to `.local/episode-capture-status.md` with a bare `writeFileSync`,
no `mkdirSync` first. It passed in every local run (this shell's `.local/`
already existed) and failed only on a real GitHub Actions run at the exact
command that first exercised that write path. Sibling writers
(`canonical-conversation-capture.ts`, `projection-receipts.ts`,
`episode-mirror-outbox.ts`) already called `mkdirSync(dirname(path), { recursive: true })`
before writing — this one writer had drifted from that pattern.

**How to apply:** Any new (or newly-CI-exercised) code path that writes under
`.local/` must call `mkdirSync(dirname(path), { recursive: true })` (or the
async equivalent) immediately before the write, regardless of how confident
you are that "some other process already created the directory." Don't trust
a green local run alone to prove this — local dev shells hide the bug by
already having the directory.


## Test-command parity is not workflow-environment parity

Passing a full test suite in one workflow does not establish that a separate
publication workflow has the system dependencies required to run that same
suite. Test-command parity is not environment parity.

**Why:** A candidate passed every PR-CI job, but its founder-operated
publication gate failed an unchanged test because only PR CI installed
ripgrep. The test deliberately forced the native-tool branch, so the
application's working fallback did not satisfy that assertion.

**How to apply:** When reusing a test suite in another workflow, compare
system-tool installation, PATH setup, checkout history, working directory
and environment gates, not only npm commands. Attribute evidence to the
workflow and exact commit that actually ran; never treat a parent's green
CI as verification of a revised publication workflow.

