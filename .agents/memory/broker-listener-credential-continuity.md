## Listener launch policy and bounded continuity evidence

For Replit credential continuity, restart the standalone coordination listener in broker-only mode, explicitly excluding its legacy actor credential. The listener and own-App command wrapper must share the same configured actor, runtime identity and credential-cache location. Retaining a legacy secret for unrelated commands is not a reason to let the listener prefer it.

**Why:** On 2026-10-18 the founder approved this listener-only change after repeated recovery failures. A successful own-App request did not establish ongoing authentication: legacy-authenticated polling could leave the broker credential idle. This is a source-supported failure mechanism, not proof that expiry rather than cache loss caused every reported failure.

**How to apply:** Preserve this launch policy after workspace restarts; do not silently revert to the older legacy-authenticated listener command. Keep application/workflow holds separate. Verify cached credential renewal beyond its original expiry and a later own-App read after more than an hour without intervening GitHub use before treating continuity as demonstrated. Renewal depends on an active listener and a reachable server; long workspace downtime, cache loss or outages can still require authorized recovery. Never describe the change as eliminating all future reissues.

## Workspace restart can lose the configured credential cache

A cache placed outside the checkout is not necessarily durable across Replit workspace restarts. Inspect cache existence and credential-expiry metadata before attempting broker-only recovery; do not print credential values or silently fall back to legacy authentication.

**Why:** On 2026-10-18 a workspace restart terminated the listener and its renewal observer, and the previously populated configured home-directory cache was absent afterward. The interrupted observation established neither renewal success nor renewal failure.

**How to apply:** Treat lost observers as inconclusive. An already-consumed bootstrap cannot be assumed reusable when its exchanged credential is gone. Obtain authorized recovery before restarting broker-only polling, then begin a fresh full observation. Do not claim an external home-directory cache survives workspace replacement without independent evidence.


## Project-local cache and ordered verification

Keep the Replit broker credential cache within the ignored project directory, with the cache helper enforcing owner-only directory and file permissions. Do not treat a home-directory path outside the checkout as restart-durable.

**Why:** The founder approved project-local cache residence through LCC after an observed workspace restart lost the outside-project cache. A subsequent founder-confirmed workspace restart preserved the project-local credential, and a read with both bootstrap and legacy authentication excluded succeeded without reissue. A separate idle observation confirmed active broker-only polling renewed the cached credential without intermediate GitHub use, followed by a successful own-App read. These are bounded operational proofs, not arbitrary-downtime or expired-credential recovery guarantees.

**How to apply:** Preserve the same actor, runtime and cache configuration across listener and own-App commands. Prove cache survival with an actual workspace restart and broker-only listener resume without another bootstrap exchange, within credential lifetime. Then run the full idle-renewal observation. Do not count a process-only restart as workspace persistence evidence, and keep held application workflows and connector retirement outside this test.


## Intentionally retired Replit GitHub connector

Do not silently reconnect the Replit GitHub integration or restore its OAuth grant as a fallback for GitHub operations. Use the separately authorized own-App path within its actual permissions; failures or missing administration rights require explicit handling, not broader credential substitution.

**Why:** The founder explicitly approved connector unlink and matching OAuth revocation after reviewing possible impacts. Replit confirmed integration removal, the founder confirmed OAuth revocation, and a subsequent broker-only own-App repository read succeeded with bootstrap and legacy actor credentials excluded.

**How to apply:** Keep evidence boundaries clear: platform confirmation proves Replit removal; founder confirmation is the evidence for GitHub revocation; repository-read success does not prove Git writes, administration, Git-pane or task-agent behavior. Preserve installed own-Apps, Render, retained deploy-key and signer holds unless separately authorized.


## Canonical access is not GitHub review access

**Rule:** A working own-actor coordination/shared-spec credential does not prove GitHub broker access or a working local GitHub CLI session. Keep those checks separate, and never substitute another hat's credential.

**Why:** During direct cross-hat review on 2026-10-20, canonical reads and messages worked, while GitHub minting refused the configured legacy credential and the existing GitHub CLI session returned 401. Source review continued using an immutable shared-spec snapshot. Exact discussion and evidence limitations: conversation_memories `f00f3950-5b4f-4790-94a9-0aae0bd59d9f`.

**How to apply:** If the canonical credential works but GitHub access does not, request an immutable exact-source review package rather than stall, borrow credentials or repeatedly retry a known-unavailable broker path. Verify supplied file bytes against manifest hashes, but distinguish that self-consistency check from independently proving the package's commit, ancestry and current GitHub state. Do not issue native commit-bound approval without the missing proof.

