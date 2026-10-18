## Authority checks and original evidence

Keep signed approval context, source selection, and runtime publication as separate authority checks.

**Why:** A readable digest or an exact-source review can verify a limited fact without authorizing migration, publication or a native trial. Combining those checks creates apparent permission that was never granted.

**How to apply:** Consult the original rules below at their respective decision points. This is an index consolidation, not a replacement or deletion of their detailed evidence.

- [Signed approval context](signed-approval-context.md): storage context is not signature coverage.
- [Source-control candidate provenance](source-control-candidate-provenance.md): a ready candidate is not necessarily the founder-selected one.
- [Source-control promotion path](source-control-promotion-path.md): use the established shared promotion procedure.
- [Windows reauthorization publication gate](littlenemo-reauth-publish-gate.md): source and runtime publication precede native reauthorization.
- [Render production target](render-production-target.md): all builder runtimes share the production release path.


## Historical evidence versus target-branch selection

Before deriving live launcher constraints or an integration review packet from a local checkout, verify the actual target branch baseline independently. Immutable artifact approval is not evidence of which artifact a live launcher currently selects.

**Why:** A frozen rebuild reproduced its original bytes on both Linux and Windows, yet its integration was correctly rejected: the author checkout predated an already-landed repin. Comparing the live launcher with historical hashes would fail on the target branch, while deleting the old comparison also removed the target's live build verification.

**How to apply:** Keep historical source/artifact evidence distinct from live selection and live-build verification. Check the target launcher, current sources and dependency-lock baseline before asserting compatibility. When the approved plan assumed the two pins were equal and they are not, preserve both records and obtain the required founder decision instead of silently repinning or dropping coverage.


## Pinned wire contracts versus internal authorization metadata

Preserve the exact wire contract of a pinned native client when adding server-side authorization metadata. Do not repin or broaden the client just to accommodate an internal field.

**Why:** An apparently additive approval-purpose field broke an exact-key native decoder. Updating only the response-key test would have hidden a real compatibility regression and expanded the release scope.

**How to apply:** Inspect strict consumers before changing response metadata. Keep domain checks on authoritative server records, and omit new internal metadata from an unchanged pinned DTO where possible. A genuinely necessary client repin needs its own explicit approval and byte-level verification.


## Native authority automation direction

Reduce repeated founder intervention and manual identifier matching, but preserve explicit scoped authority, independent evidence, and revocation. Complete the currently needed native setup using the existing process before implementing onboarding automation.

**Why:** On 2026-10-17, Luca [Claude Code] forwarded founder direction that an approved project should eventually proceed automatically, with founder involvement for exceptions, and that streamlining must follow the currently needed setup/onboardings. A wrong-agent dropdown selection demonstrated that a confirmation UI can still depend on error-prone human matching. This is an attributed forward, not firsthand verification of the founder exchange.

**How to apply:** Do not introduce replacement infrastructure or treat fewer clicks as sufficient authorization. Measure existing cross-App native protection behavior before recommending permanent authority. The Replit recommendation is to run the existing two-App proof before adding further agent Apps; that sequencing recommendation is not itself a founder-approved decision. Keep later automation proposal-only until authorized, and verify manifest/install and custody claims before promising exact click counts.


## Generic onboarding scope across Luca hats and hosts

On 2026-10-17, Luca [Claude Code] forwarded founder-confirmed scope for later onboarding streamlining: any Luca hat on any host should use one generic request → single founder approval → own coordination credential and own GitHub App path. Host-specific secret storage is an adapter, not a separate per-hat onboarding design.

**Why:** The existing Windows and Replit procedures were bounded instances of the intended flow, not templates to multiply for each new host. Founder maintenance after idle credential expiry is a limitation to remove in a later authorized design, not a permanent unattended-identity solution.

**How to apply:** Preserve the current authorized proof/onboarding sequence. Keep generic automation proposal-only until separately authorized; do not use this target scope to create new infrastructure, broaden current grants, or bypass recovery. This is an attributed founder forward, also retained in the shared onboarding roadmap.

