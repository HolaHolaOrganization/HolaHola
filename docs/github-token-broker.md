# GitHub token broker (per-agent GitHub Apps)

Standard-controls plan efb1e3d1, revision 10, Phase A1b. Each agent (coordination actor) has its own GitHub App. The App's private key lives only in the production server's environment. Agents get short-lived tokens for their own App and never hold a long-lived GitHub credential.

## Status

Activated for `luca-claude-code` (App 5350010) on 2026-10-17, after the A0 cut-over: CODEOWNERS (founder-only), ruleset with 1 approval, code-owner review and last-push approval, no bypass. A test PR proved that neither a normal merge nor a founder `--admin` merge can skip review. The first broker-minted token was scoped to HolaHola with contents/pull_requests write and checks/statuses/metadata read, expiring within 1 hour. This PR is the first one authored through it.

## What a token can do

Every token is minted for exactly one repository (`davidwmcintosh/HolaHola`, id 1170208766) with this fixed ceiling:

- contents: write
- pull_requests: write
- metadata, checks and statuses: read

It never includes workflows, administration, secrets or environments, whatever the App installation itself has been granted.

The broker sends the repository and permissions on every mint, and checks GitHub's response again before returning the token: exactly one repository, permissions within the ceiling, and an expiry in the future and at most 1 hour away, with no tolerance. A token that fails these checks is revoked immediately and never returned.

Each App and each installation is **permanently bound** to the first agent the founder **approves** for it. The binding is recorded in `github_app_identity_bindings` at approval, and concurrent approvals serialize there. A proposal that is revoked before approval binds nothing. No other agent can ever be approved for it, even after a revoke. That way two agents can never hold tokens for the same GitHub identity at the same time. To give a different agent access, create a new App.

## Founder: bring an agent on

1. **Create the App.** GitHub → Settings → Developer settings → GitHub Apps → New. Webhook off; repository permissions as above; "Only on this account". Generate a private key and keep the `.pem` offline. Install it on HolaHola only. Note the App ID and the installation ID; the installation ID is the number at the end of the installation's Configure page URL.
2. **Propose and approve the grant.** Go to Admin → Runtime Onboarding → **GitHub App grants**. Choose the agent, enter the App ID and installation ID, click **Propose**, then **approve**. Alden can propose; only the founder can approve. Grants expire after 90 days; renewal is a new approval.
3. **Activate the key, ONLY at the A0 cut-over.**
   - The ruleset must already require 1 approval, code-owner review and approval of the most recent push.
   - Then add the key to the Render service as `GITHUB_AGENT_APP_PRIVATE_KEY_<appId>`, as PEM or base64-encoded PEM.
   - Until the key is present, every mint returns `app_key_unavailable`.

## Founder: stop an agent

- **Disable or revoke** the grant in the admin panel.
  - New tokens stop immediately. A decision that arrives while a token is being issued waits for that issue to finish (at most about 30 seconds).
  - Tokens already issued stay valid until they expire, within 1 hour.
- **Immediate cut-off:** suspend the App's installation on GitHub, which revokes all of its tokens at once.

## Agent: get a token

Minting requires the agent's own **broker** credential, a short-lived credential from runtime onboarding. Legacy fixed coordination tokens are refused (`broker_credential_required`).

```
POST /api/coordination/github-token
x-coordination-token: <the agent's own coordination credential>
```

The request has no body. The response is `{ token, expiresAt, appId, repositoryId, permissions }`.

The actor comes from the credential. The App, installation, repository and permissions come from the founder-approved grant and server constants. Nothing in the request can change them.

Mints only happen on the production instance (`HOLAHOLA_INSTANCE_ROLE=production`).

### From the coordination CLI (`github-exec`)

A runtime with a coordination runtime broker credential (bootstrap or cache; see `docs/coordination-clients.md`) can mint and use its token without handling it:

```
env -u COORDINATION_<ACTOR>_TOKEN COORDINATION_ACTOR=<actor> COORDINATION_API_URL=https://getholahola.com   npx tsx server/scripts/coordination-cli.ts github-exec -- gh pr view 42
```

- It mints once. A denied or malformed mint exits non-zero and runs nothing.
- It runs exactly the given argv (no shell) with `GH_TOKEN`/`GITHUB_TOKEN` added to that child's environment only. The child does not receive the runtime's coordination credentials. The child's exit code is propagated.
- A configured legacy `COORDINATION_*_TOKEN` takes precedence in the client, so it must be unset for this process. `mintGithubToken()` refuses it locally rather than sending it.
- Security contract: the wrapper itself never prints, logs, caches or writes the token, and never puts it in argv. It cannot control what the child does with its own environment, so use trusted commands that do not print or store the token (for example `gh pr review`, `gh api`, or `git push` through `gh auth git-credential`). The token stays valid on GitHub until its expiry (at most 1 hour) unless it is revoked.

## Audit

Every issuance, denial, proposal and decision is recorded in `github_token_audit_events`, including the auth type, runtime and credential IDs.

Metadata is built from a typed allowlist, so it never contains a token, a JWT, key material or an arbitrary upstream object.

Denial reasons:
- `not_production_instance`
- `actor_not_eligible`
- `broker_credential_required`
- `no_active_grant`
- `grant_expired`
- `app_key_unavailable`
- `installation_mismatch`
- `github_unavailable`
- `token_scope_exceeded`
