# Broker sandbox instance (stage 1, decision F4-a)

A **temporary** second deployment of the same broker code. Its only job is to prove the stage-1 operations live (design dc6f8927, section 6, tier 2). The founder approved the cost (about $7/month while it exists) on 2026-10-28. It is removed after the proofs.

## What it can and cannot do

**What the broker code limits:**
- Its gateway acts only on the sandbox repository, and every write token it mints is scoped to that one repository.
- The only token it mints for HolaHola is contents:read, used to read its policy file from `main`.
- It refuses to start if configured to target HolaHola or the audit repository.

**What it does not limit: the App key's own authority.** The private key it holds belongs to the existing `holahola-luca-claude-code` App installation (`174218337`), which also covers HolaHola.
- A new key is not limited to one repository.
- Whoever holds it can mint any token that App installation allows, including HolaHola tokens with all of the App's permissions.
- So the sandbox's secret store holds the same class of authority as the production App key, and the same custody statement applies (decision F1).
- What a separate key buys is independent revocation, not a smaller authority. Revoke it at teardown.

This is a statement of fact, not a redesign: the sandbox keeps using the actor's real App, so the proofs exercise the real identity.

## Fixed identities

| What | Value |
|---|---|
| Target repository (the only one it acts on) | `HolaHolaOrganization/holahola-broker-sandbox`, id `1436541790` |
| Audit repository (its claim ledger) | `HolaHolaOrganization/holahola-broker-sandbox-audit`, id `1436542316` |
| Audit App | App id `5505040`, installation `176041046`, Contents read/write, installed only on the audit repository |
| Actor | `luca-claude-code`: App `5350010`, installation `174218337`, bot `holahola-luca-claude-code[bot]` |
| Policy | `broker/policy.sandbox.json` on HolaHola `main` (founder-owned), read through the actor App's contents:read token on HolaHola. It is never read from the sandbox repository. |

The broker refuses to start if the target is HolaHola (under any owner or id) or is the audit repository (`broker/src/main.ts`). Every request and policy must name the sandbox repository id, or it fails closed.

## Prerequisite: App repository access (founder)

Before the Render service starts, the `holahola-luca-claude-code` App's existing installation (`174218337`) must cover **both** repositories:
- `holahola-broker-sandbox`, the target, for the write tokens;
- `HolaHola`, which must stay selected, for the read token on `broker/policy.sandbox.json`.

To set it: in the org's settings, open **GitHub Apps**, then **holahola-luca-claude-code**, then **Configure**. Under **Repository access**, keep `HolaHola` and add `holahola-broker-sandbox`.

The audit App (`5505040`) stays installed on `holahola-broker-sandbox-audit` only.

## Founder setup: Render service (about 5 minutes)

1. Render dashboard: **New**, then **Web Service**. Choose `HolaHolaOrganization/HolaHola`, branch `main`.
2. Fill in:
   - **Name:** `holahola-broker-sandbox`
   - **Root directory:** leave empty (the repository root)
   - **Runtime:** Node
   - **Build command:** `echo "broker has no dependencies"`
   - **Start command:** `node broker/src/main.ts`. Node 24 runs the TypeScript source directly; the broker uses erasable syntax only and has no dependencies.
   - **Instance type:** Starter
   - **Health check path:** `/healthz`
3. **Environment variables:**

| Name | Value |
|---|---|
| `NODE_VERSION` | `24` |
| `BROKER_TARGET` | `sandbox` |
| `BROKER_TARGET_REPO` | `HolaHolaOrganization/holahola-broker-sandbox` |
| `BROKER_TARGET_REPO_ID` | `1436541790` |
| `BROKER_AUDIT_REPO` | `HolaHolaOrganization/holahola-broker-sandbox-audit` |
| `BROKER_AUDIT_REPO_ID` | `1436542316` |
| `BROKER_AUDIT_APP_ID` | `5505040` |
| `BROKER_AUDIT_INSTALLATION_ID` | `176041046` |
| `BROKER_AUDIT_APP_PRIVATE_KEY` | the audit App's `.pem`, **base64-encoded** (see below) |
| `BROKER_ACTORS` | `[{"actor":"luca-claude-code","appId":5350010,"installationId":174218337,"botLogin":"holahola-luca-claude-code[bot]"}]` |
| `BROKER_APP_PRIVATE_KEY_5350010` | a **new** private key for the holahola-luca-claude-code App, base64-encoded (see below) |

   - Do **not** set any `BROKER_ADMISSION_*` variable. Large-body admission stays disabled until it has been measured (decision F5).
   - Mark both private-key variables as secret. Neither value is ever pasted into a chat, a PR or a log.

### Keys

- **New App key.** In the org's settings, open **GitHub Apps**, then **holahola-luca-claude-code**, then **Private keys**, then **Generate a private key**. A new, separate key means the sandbox never holds a copy of a production key, and it can be revoked on its own at teardown.
- **Base64 for Render** (one line, no line breaks). In PowerShell:

  ```
  [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\key.pem"))
  ```

  The broker accepts base64 PEM (`appKey` in `broker/src/main.ts`).

## Smoke test (LCC runs it after the deploy)

- `GET https://<service>.onrender.com/healthz` returns `{"ok":true,"state":"closed","epoch":"<git blob sha of policy.sandbox.json>"}`.
- A correctly signed `luca-claude-code` request is denied with `policy_closed`.

A failing health check names its cause in the service log without secrets, for example a missing App installation.

**What the smoke test does NOT prove.** A closed health check proves only the policy path: the HolaHola contents:read token, the policy file, its repository binding and the epoch.
- A closed policy denies every request before the gateway mints a write token for the sandbox repository.
- It therefore says nothing about sandbox target-token access, the audit App's ledger writes, or any operation.

Those are proven only by the first operations after the policy is opened.

## Opening it for the proofs (separate PR)

A later founder-approved PR to `broker/policy.sandbox.json` moves it to `routine`, and adds Luca [Replit]'s key once that key is enrolled. Only then do the live W1–W7 proofs run: branch, publish (including a large blob, once admission caps are configured from measurement), PR, review, enqueue. All of them act on the sandbox repository only.

## Teardown (after the proofs)

1. Delete the Render service.
2. In the holahola-luca-claude-code App, delete the private key generated for the sandbox.
3. Delete (or uninstall) the audit App `5505040`.
4. Remove `holahola-broker-sandbox` from the holahola-luca-claude-code App's repository access.
5. Archive or delete both sandbox repositories.
6. Open a PR removing `broker/policy.sandbox.json`.
