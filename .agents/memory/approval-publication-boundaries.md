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


## Reviewer custody is an execution boundary, not a storage label

Moving a reviewer App key into an agent project secret store or a same-user OS vault does not establish isolation from application/test/dependency code executed by that project or user. Separate key storage alone also does not protect a remote broker if routine app code can impersonate both callers or rewrite its trusted actor bindings/grants through shared database authority.

**Why:** Independent authority-model review found that the proposed local-key arrangement merely moved the exposure. Official Replit Secrets documentation confirms project secrets become app-visible environment variables; LCC also confirmed same-user DPAPI access. Source review: shared-spec 8b20bdc3-2956-4623-ae3c-d6f05c907759 revision 0d7b3576-b0b1-4e9a-b72b-d1c5e0f32ea9, rejected for these boundary gaps.

**How to apply:** Trace the entire execution and impersonation path before claiming reviewer separation: key and token custody, client authentication, inherited environments, trusted policy/data writes, and deployment authority. Distinguish proven technical controls from same-host policy and semantic review. A proposed isolated broker is not itself permission to provision it or change ownership.


## Accepted authority direction versus implementation authority

The founder accepted the isolated operation-gateway model as the authority direction, with installation tokens retained inside the broker rather than exported to agent clients. Direction acceptance authorizes costed planning only; build/provisioning/spending, credential or DB-authority changes, ownership narrowing and final routine activation remain separate explicit decisions.

**Why:** On 2026-10-17 (America/Denver), the founder selected approval of the direction and a costed implementation plan after independent review distinguished real execution/impersonation isolation from app-visible secret storage and raw bearer-token vending. This preserves the goal of routine cross-host agent review without pretending a design endorsement is a rollout grant.

**How to apply:** Continue from the accepted model rather than reopening local-key custody as an equivalent solution. Reuse existing contracts and one live database; price ongoing service and maintenance before build approval. Preserve founder-default ownership until a separately approved, bounded qualification and activation sequence. Source: shared-spec recommendation 8b20bdc3-2956-4623-ae3c-d6f05c907759 revision a120976c-0b7e-46cf-a61d-d5f2a1703376; founder decision was firsthand in Replit chat.


## Read-only usage versus granted credential capability

Describe a connector used only for GET as read-only usage, not as a technically read-only credential. Before claiming isolation, verify authenticated principal, effective provider permissions and infrastructure-administration paths separately from the operations the agent has chosen to perform.

**Why:** A read-only authority inventory found an agent-accessible GitHub connection authenticated as the founder with broad repository scope and admin/push permission metadata. It also confirmed infrastructure credential names were present without inspecting their secret values. Procedural restraint did not establish least privilege or reviewer isolation.

**How to apply:** Keep actual usage, provider-granted capability and application/process reachability as distinct facts. Names-only secret inventory establishes existence, not scope or validity. Never perform a write probe, revoke a credential, disconnect an integration or disrupt source promotion without the separately required authority. Reuse the canonical costed-plan review for exact evidence rather than duplicating live credential inventory here.


## Existing Render Pro subscription and incremental cost

The founder confirmed on 2026-10-17 (America/Denver; 2026-10-18 UTC) that the Render workspace is already on Pro. Broker planning must not count the existing Pro subscription as a new incremental workspace upgrade.

**Why:** The planning estimate previously included a possible workspace upgrade because the account plan was unknown. The founder supplied the missing account fact.

**How to apply:** Distinguish the existing workspace subscription from added service compute and variable usage. The candidate broker compute estimate remains sizing-dependent; this account fact grants no authority to build, spend, provision or modify credentials.


## Per-hat Neon access and GitHub integration boundary

Preserve the founder-authorized Neon access model: separate, independently revocable project-scoped credentials for each Luca hat, with the same authorized project permissions. Do not substitute a shared credential, broaden scope, or equate matching permissions with matching secret identity.

**Why:** On 2026-10-18, Luca [Claude Code] forwarded the founder asking whether all hats should have the same access and reporting separate project-scoped replacements. Separate credentials retain attribution and per-hat revocation without reducing the approved capabilities. This is an attributed founder forward, not firsthand inspection of provider grants.

**How to apply:** During future Neon onboarding or rotation, preserve separate custody and verify permissions independently when authorized. Secret-name existence does not prove freshness, identity or validity. The founder also declined the Neon GitHub integration because storing its credential in Actions would expose it to branch workflows; do not enable it for CI without a new explicit decision. The shared credential-cleanup status note carries the evidence and remaining verification limits.

## Per-hat Cloudflare DNS custody and zone scope

Preserve the founder-reported Cloudflare DNS custody model: separate credentials for each Luca hat, limited to Edit zone DNS for getholahola.com. A replacement DNS token is not authorization for an all-zone or broad account-management credential.

**Why:** On 2026-10-18, Luca [Claude Code] forwarded founder-led creation of separate zone-specific DNS tokens and revocation of the prior DNS token. Separate custody permits independent revocation and attribution while avoiding unnecessary authority beyond the project zone. Provider changes and grants were attributed reports, not independently authenticated by Replit.

**How to apply:** Future DNS onboarding and rotations should retain separate per-hat custody and the stated zone scope unless the founder approves a change. Independently verify actual grants when authorized; secret-name existence and a matching service input are not proof of credential identity, freshness or effective permissions.

## Content refresh does not authorize index-topology expansion

An authorization to refresh existing search content does not authorize adding new indexing arms or changing retrieval density. Verify the repair helper's complete write set against the normal indexer before a bulk refresh; similarly named operations need not preserve the same topology.

**Why:** During the 2026-10-24 restoration follow-up, LCC reported that a refresh created redundant short-row chunks because its helper differed from the periodic indexer. Founder-approved cleanup was required. Replit independently verified the corrected final layout and content hashes, but did not observe the earlier transaction or its rollback.

**How to apply:** Separate content correctness, index layout and visibility scope in both the preflight and readback. Unexpected extra arms are a scope deviation, not harmless evidence of success; obtain separate authority before deleting them. A correct final snapshot proves current state, not the execution history or prior-scope invariance.


## Approval coverage must bind mutation semantics

Approval digests for content repairs must cover every semantic field that can change the mutation, not merely the selected edit list. Independently validate derived coordinates and prefix containment even for a digest-approved plan.

**Why:** A synthetic review probe preserved an approved insert list and its original frame hash but shortened the unhashed prefix boundary. JavaScript slice clamped the insertion offset to that boundary, so unchanged approved coordinates produced an insertion elsewhere. Matching list hashes did not establish the actual write location.

**How to apply:** Pin target, source references, edits, lengths and pre/post hashes through an externally supplied full-plan approval digest. Reject invalid or out-of-prefix frame ranges before mutation; keep legitimate append-only tails outside the pinned prefix.


## Preserve historical copies when restored dialogue is already appended

When restored founder dialogue is already present in an episode's appended section, preserve both that genuine dialogue and an older incomplete historical copy rather than deleting or rewriting episode content solely to correct ordering. Close an unnecessary insertion repair instead of creating a second complete copy.

**Why:** On 2026-10-24 (America/Denver), the founder explicitly agreed to this preservation approach after being told that canonical restoration had been followed by appended complete exchanges and one older unworded copy remained. A read-only exact-content census and prior-prefix parity check supported closing the proposed repair without applying it.

**How to apply:** Verify complete frames and the preserved baseline independently before deciding a repair is unnecessary. This decision does not authorize later content cleanup, embedding refresh or replica publication. Treat current-state evidence separately from claims about which writer or restart caused the appends.


## Source-author-preserving publication relay

Antigravity's approved bootstrap publication path separates source authorship from publisher identity: after Luca [Replit] approves the exact corrected source package, Luca [Claude Code] may publish it using LCC's own bot while preserving and declaring Antigravity's authorship. This is not permission for Antigravity to borrow LCC credentials. Subsequent Antigravity and Codex GitHub Apps are owner-created and installed; their broker policy changes need separate review.

**Why:** On 2026-10-25 (America/Denver), LCC authenticated-forwarded the founder's decision, “yes, go with B now and A next.” The evidence is LCC's forward, not Replit's firsthand observation of the founder chat: canonical coordination event d9938b6d-b2d3-4da6-936e-e70228a7e972.

**How to apply:** Retain the approved transfer artifact hash and author provenance, then verify the published base, file blobs, tree and declared diff scope. A publication relay using git am can legitimately change committer metadata and commit SHA; regenerated format-patch bytes may also differ. Record that mapping instead of demanding impossible raw mail/commit equality. Any changed reviewed content needs focused re-review. Source publication does not remove CI, merge, deployment, migration or native-trial gates.


## Alden engine retention and worker scope

Keep Alden's Gemini engine available unless the founder separately authorizes retiring it. An authorized model upgrade for existing background workers is not permission to activate, schedule, or re-enable held or dormant workers.

**Why:** The founder's worker-upgrade approval expressly retained Alden's Gemini engine and made the upgrade conditional on the preceding interactive-engine change landing. Independently matched founder-side source: canonical conversation row 3ceff496-9599-438a-a6e5-00ca99dd173f, with proposal antecedent 20fab007-90f3-45ab-9242-5aa5e4df2520. LCC separately confirmed activation and scheduling were excluded in canonical coordination event e8569eaf-a394-4e4f-82cf-3201662f75b6.

**How to apply:** Treat model/configuration changes, engine retirement, and worker activation as separate permissions. Preserve Gemini while reviewing Anthropic worker upgrades. Independently verify provider model/configuration/pricing evidence when reviewing a concrete candidate; the forwarded authorization is scope evidence, not proof of provider facts or release readiness.


## Record-checked founder gate authority and cross-hat reads

Forwarded founder authority over a gate must be checked against canonical source records by the receiving Luca hat, including the antecedent when the decision refers to an earlier proposal. Initial mandatory scope is merges, migrations, credentials, and model/provider changes, not every ordinary conversational assertion. Authenticated sender identity alone does not verify the founder's words, current scope, or execution conditions.

**Why:** The founder chose gates-only enforcement and cross-hat chat access in canonical conversation row 000dcc36-a46e-4df8-a65a-eb6b846edbfb. The preceding scope questions and gate examples are in 6f10ffce-e375-4db1-9397-f1e4fda0c9a3. Both were independently read from the shared canonical record, rather than accepted solely as forwarded quotations.

**How to apply:** Luca hats may read the founder's conversations with other hats, including full context, to check these decisions. This is not blanket access for every actor or to student data, private creator-profile information, or secrets. Verify the founder-side passage and relevant qualifications, judge scope separately, check actual action prerequisites, and disclose capture/coverage uncertainty. A recorded exact quote is evidence, not an automatically transferable gate authorization; permission, publication, and activation boundaries still apply.

