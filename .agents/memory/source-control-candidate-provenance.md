A `ready_to_promote` status does not by itself prove a human ran `prepare`: the sync scheduler's own auto-merge-and-revalidate path (GitHub ahead of Replit, a clean fast-forward) produces the identical shape -- correct candidateSha, unexpired, a structurally valid manifest. Only a `candidateSource` field distinguishes an explicit `prepare` from a scheduler auto-promotion, and only a live re-check of HEAD (not the last recorded status) can prove HEAD hasn't since moved past that candidate.

**Why this matters:** Replit's Publish button always builds whatever commit is on HEAD, not a specific validated SHA. Treating `ready_to_promote` alone as "safe to publish" lets an auto-promoted, never-reviewed commit slip through undetected until a bad deploy surfaces it.

**How to apply:** Never treat `state === 'ready_to_promote'` alone as clearance to publish -- check its provenance and re-verify HEAD live via a dedicated drift check, not the cached status, before telling anyone it's safe. Keep that live check a separate opt-in action rather than folding it into every status read: it re-authenticates before even a local, no-network git call, so it is meaningfully more expensive than a plain status read.


## Whole-file release snapshots need the destination baseline

Complete-file release snapshots must be derived from the intended destination baseline plus the owned patch, not blindly copied from a mixed workspace.

**Why:** A one-line CI registration change was scoped correctly against the local checkout, but exporting the whole file also carried inherited, unreleased registrations. Their test files were absent from the destination, so that seemingly small release would have broken CI. A clean diff against a local starting point did not prove a clean diff against the release destination.

**How to apply:** Inspect the candidate against the actual destination branch. For whole-file transfers, explicitly label any destination-based projection, record its baseline and digest, and confirm that every registered test exists in that candidate. Preserve unrelated legitimate workspace edits; do not delete them to make an export look scoped. If the destination advances, rederive and recheck the projection before release.

