---
name: GitHub Actions / GitHub App auth pitfalls
description: Nine sharp edges hit wiring GitHub App-based git push, branch protection, and Actions CI auth for this repo — read the matching section before touching any of these areas again.
---

Consolidated Sep 2026 during the SSH-deploy-key → GitHub App migration and
related CI/branch-protection work. Each section is a standalone lesson;
jump to the one matching your current problem.

## 1. Credential lives in three independent stores

`server/services/source-control-service.ts` authenticates git pushes as a
GitHub App installation (`server/services/github-app-auth.ts`: JWT mint →
installation-token exchange, injected via `GIT_CONFIG_KEY_0=http.extraheader`,
never argv/URL-embedded) instead of the long-lived `HOLAHOLA_GITHUB_DEPLOY_KEY`
SSH key. A migration touching only one store leaves the others as a live
bypass path:
1. Replit Secrets — the Replit-side dev/coordinator process.
2. `render.yaml` (`sync: false` placeholders) + the Render dashboard's actual
   values — Render's **production runtime**, for its own read-only
   exact-commit snapshot fetch (Render's image omits `.git`).
3. GitHub Actions repository secrets (separate from both above) — consumed by
   `.github/workflows/cross-tool-promote.yml`'s push step via
   `scripts/print-github-app-token.ts`.

The old `HOLAHOLA_GITHUB_DEPLOY_KEY` was deliberately **not** revoked after
migrating the push path: it remains load-bearing for the separate, read-only
Render source-snapshot fetch. Removing a credential's bypass/write privilege
at the gate that mattered doesn't require deleting it outright if another
legitimate, lower-risk use (e.g. read-only fetch, not gated by branch
protection) still needs it.

**How to apply:** any future credential rotation or transport change for git
push access must touch all three stores. Grep for `HOLAHOLA_GITHUB_DEPLOY_KEY`
/ `HOLAHOLA_GITHUB_APP_` across the whole repo including `.github/workflows/`
before declaring a migration complete.

## 2. Classic branch protection vs. rulesets are separate, unreconciled systems

GitHub has two independent branch-protection systems that can both be active
on the same branch with no automatic reconciliation:
- **Classic protection** (`.../branches/{branch}/protection`) — its
  `required_status_checks` has **no bypass-actor concept at all**. The only
  override, `enforce_admins`, exempts human org/repo admins from everything,
  never bots/Apps/deploy keys.
- **Rulesets** (`.../rulesets/{id}`) — support fine-grained `bypass_actors`
  (Integration/App id, Team, OrgAdmin, DeployKey, each with a `bypass_mode`).

A correctly-configured ruleset bypass_actor does **not** bypass classic
protection. If both require the same check, a ruleset-authorized push still
gets the generic `GH013: ... Required status check "test" is expected` error —
indistinguishable from a ruleset-level rejection without fetching both
configs and comparing.

A ruleset `bypass_actor` with `actor_type: "DeployKey"` is **unscoped** — no
`actor_id` — so it grants bypass to *any* deploy key on the repo, not one
specific key (unlike `Integration`/`OAuthApp`, which pin a numeric
`actor_id`). Narrowing from a deploy key to one App means removing the
`DeployKey` entry entirely; there's no per-key variant.

**How to apply:** before trusting or debugging any branch-protection bypass,
fetch *both* classic protection and the ruleset list/detail and check both for
the same required check. Never assume a bypass works just because the
configuring PUT returned 200 — test the actual push.

## 3. A GitHub App's new permission needs a second, separate approval

Adding a permission (e.g. "Workflows: Read and write") to a GitHub App's own
definition does not retroactively grant it to existing installations. GitHub
queues it as a pending request; the installation owner must separately accept
it (Settings → Applications → Installed GitHub Apps → [app]) before a
freshly-minted installation token actually carries it. Confirmed by
reproduction: a push touching `.github/workflows/*` was rejected with
`refusing to allow a GitHub App to create or update workflow ... without
workflows permission` immediately after editing the App definition, and only
succeeded after the separate installation-level approval.

**How to apply:** whenever a GitHub App gains a new declared permission, both
steps are required — re-verify by minting a fresh token and retrying the real
operation, don't assume the definition edit alone is sufficient.

## 4. No available credential can manage GitHub Actions secrets via API

Setting/rotating a GitHub Actions repo secret (`PUT
/repos/{owner}/{repo}/actions/secrets/{name}`) needs "Secrets: write"
permission. Verified empirically (Sep 18 2026) that neither David's
fine-grained PAT (`GITHUB_ACTIONS_DISPATCH_TOKEN`) nor the GitHub App
installation token has it — both 403 on the secrets public-key endpoint.

Relatedly: a fine-grained PAT's `permissions` object on `GET
/repos/{owner}/{repo}` (e.g. `{admin:true, ...}`) reflects the **authenticated
user's role**, not what that specific token was actually granted — a PAT
scoped to only "Administration: Read and write" still showed the same
full-admin-looking object. It's a legacy back-compat field that predates
fine-grained PATs.

**How to apply:** don't script Actions-secret creation in this project — ask
the user to add/update it via Settings → Secrets and variables → Actions.
To verify what a fine-grained PAT can really do, test real endpoints needing
the specific permission and check 200 vs. 403, never trust the repo-level
`permissions` object.

## 5. Branch protection should require the CI aggregate job, not internal job names

Protect `main` with the single GitHub Actions check named `test` (`CI /
test`), not the individual parallel test-job names. The aggregate job is the
branch-protection contract: it depends on every named test group via `needs`
and fails when any group fails (`if: always()`, fail closed on any
non-success dependency), so requiring the internal names separately makes
future parallelization or job renaming brittle. When changing workflow job
names, preserve the protected `test` context attached to the GitHub Actions
app. This repo's active main ruleset also requires PR-only squash merges and
linear history and forbids direct pushes — check it before attempting to
publish local main.

## 6. `workflow_dispatch` resolves definitions from default main, not the candidate branch

A corrected workflow file that exists only on a candidate/feature branch
cannot repair or unblock `workflow_dispatch` of that same workflow — dispatch
always resolves the definition from the repository's default branch. Land the
workflow repair on default `main` through an already-working approved path
first; only then dispatch candidate-branch work that depends on it.

## 7. GitHub-hosted CI must normalize Replit's npm proxy URLs before `npm ci`

Replit's `package-firewall` npm tarball URL prefix is private to this
environment. npm's `replace-registry-host` setting only replaces the host and
keeps the proxy's `/npm/` path, turning a public request into an invalid
`registry.npmjs.org/npm/...` URL. Normalize only the registry URL prefix
inside the CI workspace before install (keep dependency integrity
hashes/versions unchanged), then explicitly verify the local test toolchain
and application import path before running tests.

## 8. A 200 response can silently omit fields a differently-scoped credential would see

`GET /repos/{owner}/{repo}/rulesets/{id}` returns 200 for the GitHub App
installation token while silently omitting `bypass_actors` entirely (only a
self-referential `current_user_can_bypass` field is present) — no error, no
403, just absent — while `GITHUB_ACTIONS_DISPATCH_TOKEN` hitting the identical
URL gets the full field. GitHub appears to gate the full bypass-actor list
behind a higher permission tier than reading the ruleset's own shape.

**How to apply:** before building any check on a specific response field,
verify empirically (log the actual parsed field, not just HTTP status) that
the credential you intend to use really returns it. If missing under one
credential, check whether another already-available one has it before
requesting new App permissions (see section 3 above — needs a separate manual
approval).

## 9. `actions/checkout`'s persisted token silently wins over a later URL-embedded push token

Any workflow step doing `git push https://x-access-token:$TOKEN@github.com/...`
after an earlier `actions/checkout@vN` (default `persist-credentials: true`)
actually pushes as the checkout-persisted default `GITHUB_TOKEN`, not the
URL-embedded token — even though the URL looks like it should win.
`actions/checkout` writes a `http.https://github.com/.extraheader` git-config
entry scoped to `https://github.com/`; git/curl send the already-configured
extraheader instead of the Authorization implied by URL userinfo, so the URL
credential is silently ignored, not merely deprioritized. Confirmed in
`cross-tool-promote.yml` (Sep 18 2026): a push step authenticated as
`github-actions[bot]` instead of the intended App token, and branch protection
denied it with a 403 that looked like an App-permission problem but wasn't —
a parallel in-process push using the identical token-minting code succeeded at
the same time.

**How to apply:** in any workflow step that pushes with a non-default token
after a `checkout` step, run `git config --unset-all
http.https://github.com/.extraheader || true` immediately before that push
(not earlier — earlier steps like an ancestor/fetch check may still need the
persisted default token for read access). Prefer this targeted unset over
`persist-credentials: false` on checkout when earlier steps in the same job
need read access via the default token.

## Slim-image Git HTTPS trust

Git installed with Debian's --no-install-recommends does not itself guarantee a system CA trust bundle: ca-certificates is a recommendation, not a dependency. Node HTTPS success does not prove Git HTTPS works; they can use different trust sources.

**Why:** A production-only snapshot failure persisted after source-file repair. The runtime used the slim Debian Node base and omitted Git's recommended packages. On 2026-10-01, after explicit CA installation was deployed, the founder confirmed the approval page loaded and pressed Publish; a read-only database check confirmed the new runtime release matched the current published source promotion. The original stderr was unavailable, so this proves operational recovery after the fix, not the exact original TLS error.

**How to apply:** For slim deployment images, explicitly include system trust for HTTPS clients and preserve TLS verification. Diagnose Git with closed non-secret failure labels; do not infer an SSH problem from a generic Git failure when the actual transport is HTTPS. Verify both the deployed build and the actual founder operation, not just a development test.

## Contents push and pull-request permissions are separate

Repository push authentication and pull-request creation can use different existing GitHub credentials with different permissions.

**Why:** The project's source-control GitHub App successfully pushed the reviewed branch but received HTTP403 creating its PR. The already-connected Replit GitHub integration created that same review PR successfully, without changing permissions or issuing new credentials.

**How to apply:** Treat a successful contents push as evidence only for contents access, not pull-request write access. Use the existing authenticated integration for review operations when its permissions allow them; never infer authorization from repo role metadata, expand permissions silently, expose tokens, or republish source merely to retry PR creation.


## Protected Environments do not protect repository-secret copies

An approval-required GitHub Environment protects its environment-scoped
credentials, not copies of the same credentials stored as repository or
organization secrets. CODEOWNERS approval at merge is also not a boundary
against earlier execution of a same-repository PR workflow.

**Why:** Another workflow can omit the protected Environment and request the
repository or organization copy. Protecting one named job is therefore not
equivalent to restricting the credential's availability.

**How to apply:** Inventory every secret store and effective credential
permission before claiming a protected PR or deployment path. Move privileged
credentials into the intended approval boundary, remove unprotected copies,
and protect or retire legacy consumers in the same transition. Preserve
legitimate restricted consumers. Verify locations through metadata and
behavior with harmless canaries; never print or exfiltrate real credentials
as a test.


## Distinguish proxy rejection from credential failure

A proxy's HTTP 403 is not sufficient evidence of a GitHub credential failure.
Check the response issuer and format before proposing reauthorization.

**Why:** A repository contents request returned a Cloudflare HTML rejection
while other reads through the same connection worked and its authorization
context reported healthy. That was not a GitHub JSON permissions response.

**How to apply:** Distinguish CDN/proxy failures from provider authentication
errors. Do not expand scopes or ask for new credentials without evidence.
Prefer the project's established extension points when they fit the change;
do not work around an intentional access restriction.


## Connector source retrieval and pinned test copies

Treat GitHub connector access as endpoint- and concurrency-dependent; successful PR/source reads do not prove archive-download access. Do not respond to an archive denial by hunting for account credentials or weakening checkout holds.

**Why:** During an independent source review, authenticated PR reads worked while the archive endpoint returned 403; a broad concurrent content batch then returned 429. Pinned-tree metadata followed by bounded content retrieval worked without changing authentication or the dirty checkout.

**How to apply:** Obtain the exact commit tree, compare candidate dependency files using Git blob hashes, reuse only byte-matching local files and fetch mismatches with small or sequential batches. Include the runtime dependency closure and test/config files, not only the changed files, before claiming an exact-source test. A partial source snapshot is suitable for focused checks, not proof that the full project typechecks.


## Installation-token expiry is not loss of actor authority

A failed ambient GitHub CLI credential is not evidence that the actor has lost
its approved GitHub authority. Distinguish an expired installation token from
a revoked grant before proposing access changes.

**Why:** Ordinary `gh` returned HTTP 401 during an independent review, while the
existing own-actor token-broker wrapper immediately refreshed access and the
native review was attributed to the correct bot. Searching for another App
key or restoring the retired connector would have been the wrong response.

**How to apply:** For native reviews and other authorized GitHub operations,
use the documented own-actor `github-exec` path first rather than relying on
ambient CLI authentication. Keep minted tokens inside the one trusted child
process. Never print/cache tokens, substitute another actor, reconnect retired
OAuth access, or re-enable revoked credentials merely to repair expiry.

