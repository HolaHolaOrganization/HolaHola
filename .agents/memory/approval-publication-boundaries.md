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

