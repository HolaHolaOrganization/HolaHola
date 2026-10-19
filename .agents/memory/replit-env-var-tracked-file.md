---
name: .replit env vars are git-tracked
description: setEnvVars with environment "shared" writes literally into the repo's own .replit file, not a separate untracked store.
---

Confirmed 2026-09-17: calling `setEnvVars({ environment: "shared", values: {...} })`
to add `SOURCE_RELEASE_HEALTH_URL` landed as a new line under `[userenv.shared]`
inside the repo's own `.replit` file — a file tracked by git, not a separate
secrets/config store. `git diff` showed the addition immediately, and the
working tree became dirty as a result.

**Why:** This project's source-promotion pipeline
(`server/services/source-control-service.ts`) requires the git working tree
to be byte-clean and to exactly match a previously-validated candidate commit
before it will record a promotion. Setting the env var mid-cycle (after
`/prepare` had already validated a candidate, before calling `/record`)
silently dirtied the tree and failed the very `/record` call the env var was
needed for, with error "The requested SHA is not the current unexpired
ready_to_promote candidate with a valid versioned validation manifest." /
`bridgeState: "dirty"`.

**How to apply:** Before starting any git-tree-cleanliness-sensitive workflow
(source-promotion prepare/record, or anything else that snapshots "the exact
current commit"), add/change any needed `setEnvVars`-managed config values
FIRST, as their own step — commit and push `.replit` if it changed — then
start the sensitive workflow fresh against the resulting clean HEAD. Don't set
env vars in the middle of such a workflow. Actual secrets (requested via the
secrets flow, holding real credential values) are stored separately and do
not have this effect; this is specific to plain non-secret config values that
`setEnvVars` resolves into `.replit`.

## Schema-validated configuration replacement

Workspace configuration edits may be blocked even when ordinary source patches are allowed. For a general `.replit` change such as an approved onBoot hook, read the existing file, create a complete candidate TOML in an absolute temporary path inside the workspace, and use `verifyAndReplaceDotReplit({ tempFilePath })`. Preserve unrelated configuration and use the specialized workflow/env/package tools for those operations instead.

**Why:** On 2026-10-18 the platform rejected a direct patch to `.replit` and explicitly required this schema-validated replacement path; the replacement then succeeded. Do not interpret a multi-file patch's partial success as configuration activation.

**How to apply:** Check the replacement result and the resulting intended configuration line before claiming activation. A hook being configured does not prove it has run; actual compute restart and runtime evidence are separate.

