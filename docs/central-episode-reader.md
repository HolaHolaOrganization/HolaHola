# Central episode reader — implementation and independent review request

Founder reprioritized episode centralization on 2026-10-27. This is the first
read-only reader/catalog/download increment of the approved Central Records
design, not a claim that all capture paths are live or that all central
document access is complete.

## Implemented

- Founder-authenticated `/admin/records` catalog and canonical-ID reader,
  discoverable as Episode Archive in the existing admin navigation.
- Existing canonical database rows only, no new archive, tables, editor,
  transcript mutations or filesystem fallback.
- Separate full episode and curated-story records. A story must link to a real
  episode via existing stored metadata; it is not synthesized from an episode.
- Exact UTF-8 Markdown downloads with distinct episode/story filenames.
  A SHA-256 pins the downloaded content to the displayed read. Changed content
  returns 409 rather than substituting a newer record. This does not invent
  retained immutable historical versions of a rolling row.
- Private/no-store/nosniff responses, strict pagination and parameter checks,
  redacted service failures, safe plain-text rendering, transient browser
  query caching only, aborted stale reads/downloads.
- Synthetic, non-writing HTTP tests and a CI entry.

## Verification

- `npm run typecheck` passed after the initial nullable-UI-state fix.
- Nine real-HTTP route tests pass with isolated in-memory fixtures:
  authorization before repository access; paging and metadata-only catalog;
  separate story linkage; empty/missing data; byte-identical CRLF/Unicode
  downloads and digest; stale digest refusal; malformed inputs; redaction.
- Actual Neon reads are SELECT-only. Catalog resolves existing episode/story
  rows. Episode 34 read returned 2,633,324 bytes in 295 ms, and its story
  11,909 bytes in 23 ms in this one measurement. No performance guarantee
  inferred. Catalog transferred metadata without transcript bodies.
- Episode 34's linked story already exists; its hash matches its stored
  content-sha256 tag. Do not re-create or re-publish it.
- Full downloads require all bytes and the hash; the Alden bounded-text
  paging interface serves a different use case. No duplicate Alden paging
  tool or model-facing instruction is introduced here.

## Boundaries and remaining work

This first surface is founder-only; it does not widen runtime credential
capabilities or grant students access. Scoped per-runtime reader integration,
active-approved governed-document resolution, and on-air read receipts remain
within the larger approved project, not claims made by this increment.

No app/listener restart, worker activation, backfill, episode append, cleanup,
schema change, new provider or prompt change is authorized by publishing this
candidate. The live mirror remains separately held. Live source health
confirmed its canonical worker armed and pendingBytes=0; that response does
not prove episode projection. LCC reports live mode off and missing episode
membership for recent turns, with its 200-character probe explicitly qualified
as a lead rather than an exact byte receipt.

Independent reviewer should inspect full source, exact native candidate
identity, founder gate wiring and bytes/hash semantics. CI and founder
merge/release gates remain separate. No auto-merge is armed by this request.
