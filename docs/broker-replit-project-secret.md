# Replit broker signing key: explicit project-Secret custody

The founder selected project-Secret custody for the Replit actor, as relayed by
Luca [Claude Code]. This is not native Linux Secret Service storage and is not
a runtime-restricted signing service. Replit encrypts the Secret at rest and
injects it as an environment variable. Workspace code and the platform can
access it. Revisit restricted signing-service custody before production cutover.

## Fixed identity and explicit selection

- Actor: `luca-replit`
- Key id: `lr-replit-1`
- Secret name: `BROKER_SIGNING_KEY_LR_REPLIT_1`
- Proposed policy host label: `REPLIT`
- App: `5361771`, bot `holahola-luca-replit[bot]`

The adapter requires the explicit store selection `replit-project-secret`.
It accepts only this actor/key and the existing broker-key scope. It is
read-only, never changes native secure-store selection, and never silently
falls back to files, other environment keys or another actor's credentials.

## Owner provisioning

The supported secret form requires owner input; there is no generated-value
secret setter available to this agent. Do not invent one or stage a private
key in a file, chat, tool result, application log or source patch.

The agreed owner-side process is:

1. The founder generates an Ed25519 key in their own local shell, outside any
   agent tool. Prefer a single-line base64 encoding of the private PKCS#8 PEM,
   sent directly to the local clipboard; multiline PEM is also accepted.
   Only the SPKI public PEM and its SHA-256 fingerprint are printed.
2. The founder pastes the private value into the secure Replit Secrets form
   for `BROKER_SIGNING_KEY_LR_REPLIT_1`, then clears the clipboard. This
   clipboard step is owner-controlled and temporary; it is not a claim of
   hardware-backed or runtime-restricted key generation.
3. After the Secret is available, inspect only its public half:

   ```sh
   npx tsx server/scripts/broker-project-secret-cli.ts public \
     --store replit-project-secret --actor luca-replit --key-id lr-replit-1
   ```

4. Compare the returned `fingerprintSha256` with the fingerprint the founder
   saw locally. A match is required before proposing policy enrollment. A
   mismatch is an error, not a reason to rotate or overwrite a key silently.

`init` always fails with `broker_project_secret_owner_provision_required`
before reading a Secret or generating any key. A missing, malformed,
oversized or non-Ed25519 value fails with fixed non-secret error codes.
Base64 must be canonical and single-line, is decoded exactly once, and must
contain an unencrypted Ed25519 PKCS#8 PEM. Base64 is only a transport encoding,
not encryption or stronger custody. RSA, encrypted PEM, malformed base64,
non-UTF-8 decoded bytes and nested encodings are rejected.
The public command emits public metadata only. The signer loader returns a
process-local key object for the existing broker client; never serialize it.

## Enrollment and authority

Generation, provisioning, fingerprint confirmation, policy enrollment, App
installation access and sandbox actor configuration are separate steps. The
helper does not perform any of them automatically. App installation id must
be verified separately; the App id and bot login are not a substitute.

Production policy stays closed. Sandbox operations require the separate
founder-approved policy and App configuration. Replacing or removing the
Secret does not itself revoke an already loaded signing key. Revocation is a
founder-approved policy change removing the key id, subject to the broker's
bounded policy refresh (currently at most 60 seconds). No immediate global
revocation or production-cutover authority is implied.
