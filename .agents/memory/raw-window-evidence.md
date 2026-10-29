---
name: Raw-window evidence — capture, boundary, and attribution
description: Raw Replit evidence must land through the direct DB-first path, stay separated from attributed dialogue, and remain immutable even while its classification is still unresolved.
---

## 1. Startup safety for CLI attachments

Raw-window evidence attachments initiated by a CLI must write through the direct DB-first episode append path rather than rely on the asynchronous `.episode_append` trigger.

**Why:** the autosave worker treats a pre-existing trigger at its own startup as stale and intentionally does not replay it. An attachment made while the HTTP server is available but before that worker arms can therefore retain its raw source but lose the requested episode evidence.

**How to apply:** use the direct canonical append helper for production attachments. Keep a trigger-path override only where a hermetic test needs to inspect the serialized trigger payload.

## 2. Evidence boundary — never blend with attributed dialogue

Treat a raw Replit dump as evidence, not as episode dialogue. Persist the exact raw source and its transformation manifest in the append-only DB evidence lane before any cleaned, attributed dialogue can enter capture. The audit manifest records hashes, byte totals, source offsets, categories, and permitted formatting removals; it must not reproduce raw prose.

Manual raw dumps are reference material while the original record is sought — they must never become ordinary dialogue. A later gap-fill is allowed only when it names the missing original record, attributes the dialogue safely, and explicitly acknowledges the supplied source.

**Why:** a source-recovery aid and a canonical speaker record answer different questions. Blending them makes accidental reconstruction look like authentic dialogue and hides whether the capture pipeline itself lost material.

**How to apply:** keep the evidence lane separate from the episode DB/Markdown replica. Default unknown/manual provenance to reference-only. Use source-hash lifecycle events plus a turn-aware retry to prevent duplicate dialogue; status must query the DB ledger and report unfinished projections.

## 3. Origin data stays even when classification is unresolved

Collector-visible raw Replit source is origin data, not conditional evidence that requires corroboration before it can enter the episode. Preserve it immutably and visibly in the canonical DB-first episode/Markdown record, even when its current classification is unknown.

**Why:** supporting material can improve attribution, but the source itself is the documentation. Excluding it until a second record exists confuses uncertain classification with absence and loses the actual encounter.

**How to apply:** keep raw bytes/hash immutable in the raw ledger. Render the same source as a labeled origin-data block in the canonical episode. Later review may refine classifications or attribution, but must not erase, replace, or invent the original source.

## Recovered channels are unavailable, not intentionally empty

For a founder-authorized recovery from a pasted visible conversation, missing felt/thinking/moment channels must remain unavailable. When the existing recorder requires its empty-channel flags, add explicit recovery provenance saying those channels were **not preserved**, rather than implying they were deliberately empty at the original moment.

Keep the raw source byte-exact. Record new recovery identifiers as recovery identifiers, never original platform turn IDs. If occurrence times were not preserved, say they are unknown; an ingestion timestamp is not an occurrence timestamp. Preserve gaps, source disagreements and the distinction between progress messages and final replies rather than filling or silently combining them.

**Why:** In the 2026-10-28 recovery, the founder authorized honest replay of visible words using the recorder's empty-channel flags. The CLI's generic “intentionally empty” label alone would misrepresent missing historical evidence as a contemporaneous choice.

**How to apply:** Keep recovery provenance alongside the replay manifest or in a linked canonical provenance row. Source preservation, pending intake and acknowledged canonical delivery remain separate evidence stages.

