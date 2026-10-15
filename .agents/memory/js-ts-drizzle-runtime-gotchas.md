---
name: JS/TS/Drizzle runtime gotchas
description: 6 sharp edges in esbuild bundling, Node ESM imports, and Drizzle's sql tag that look like unrelated bugs (server restart loops, "Unexpected reserved word", silently-failed queries, TOCTOU races, truncated regex matches) but each has a narrow, specific fix.
---

## esbuild isMain guard — bundle collapse

## The rule

Never use `import.meta.url.endsWith(process.argv[1])` (or `===`) as a "am I the main script?" guard in any file that is or could be imported by the server bundle.

**Why:** esbuild merges all source files into one `dist/index.js`. Inside that bundle, every module's `import.meta.url` is `file:///…/dist/index.js` — the same value as `process.argv[1]`. The check is always `true`, so any top-level `if (isMain) { … process.exit() … }` block fires at server boot as an async IIFE, then kills the process when it finishes (exit 0 on success, exit 1 on failure).

**How it manifested:** `populate-principle-embeddings.ts` was killing the production server ~1–2 min after every boot. Logs showed "command finished successfully with exit code 0" (Neon WS query succeeded → `process.exit(0)`) or "exit status 1" (Neon WS dropped mid-query → catch → `process.exit(1)`). The server appeared to start and serve briefly, then die in a restart loop.

## Correct pattern

Check the **exact actual filename** in `process.argv[1]`, not `import.meta.url`:

```ts
import { basename } from 'node:path';

// Safe — works with tsx source paths and cannot be triggered by importing
// my-script-name.test.ts.
const isMain = basename(process.argv[1] ?? '') === 'my-script-name.ts';
```

- `npx tsx server/scripts/my-script-name.ts` → basename is the filename ✓
- `node dist/index.js` → `argv[1]` is `dist/index.js` ✗ → `isMain` false ✓

`reembed-memory.ts` already uses the safe suffix pattern
(`argv[1]?.endsWith('reembed-memory.ts')`).

Avoid `.includes('my-script-name')` for scripts imported by tests: a file named
`my-script-name.test.ts` would incorrectly execute the CLI IIFE during import.

## How to apply

Any script in `server/scripts/` that (a) exports a function AND (b) is dynamically
imported by `server/index.ts`, `server/routes.ts`, or a test must use an exact
basename or a narrow `.endsWith('<script>.ts')` check, NOT `import.meta.url`.
Scripts that are CLI-only (never imported by the server) are still affected by
the bundle collapse if esbuild touches them, so prefer the argv form everywhere.

## Shared helper now exists

Both failure modes above (bundle collapse and test-file substring collision)
are now consolidated into one guard: `server/scripts/lib/cli-entrypoint.ts`
exports `isDirectCliInvocation(scriptBasename)`, an exact
`basename(process.argv[1]) === scriptBasename` check. It is safe both for a
script reached by the esbuild bundle (the bundle's argv[1] basename is never
the script's own filename) and for a script whose own test file imports it
(a `test-<subject>.test.ts` file is never an *exact* basename match, even
though it contains the script's name as a substring). New CLI scripts under
`server/scripts/` should import this helper rather than re-deriving either
check ad hoc — a project-wide audit (Sept 2026) found 20 scripts using the
unsafe `process.argv[1]?.includes(...)` form and migrated all of them, plus
the original `coordination-runtime-status.ts` reference implementation, to
this helper.

## Node.js ESM await import() inside a callback

## The rule

When using `node --input-type=module` (inline ESM scripts), **always import at the top of the file**. Never `await import()` inside a Promise constructor, callback, or any non-async scope.

## What fails

```javascript
// BROKEN — "Unexpected reserved word" in Node 20
const req = https.request ? https.request(options) : (await import('http')).request(options);

// ALSO BROKEN — await import inside Promise constructor callback
const result = await new Promise((resolve, reject) => {
  const req = (await import('https')).request(options, (res) => { ... });
});
```

## What works

```javascript
// CORRECT — static import at the top
import https from 'https';
import http from 'http';
import fs from 'fs';

// ... then use https / http anywhere below, including inside callbacks
const req = https.request(options, (res) => { ... });
```

**Why:** In Node 20 ESM, `await` is only valid at the top level of the module — not inside a callback passed to a `new Promise()` constructor, even though the outer script is async. The parser sees `await` in a synchronous callback scope and rejects it.

**How to apply:** Any time you write an inline Node.js script for API calls (Gemini, Alden, internal endpoints), put all imports at the top as static `import` statements. The `node --input-type=module << 'EOF'` heredoc pattern supports top-level await natively — use it, but keep imports static.

## Drizzle sql tag — dynamic import required in route handlers

The top-level `import { sql } from 'drizzle-orm'` at the module head produces a SQL template tag object that is NOT compatible with `getSharedDb().execute()` in route handlers. The call silently fails with a "Failed query" error (params are empty; the query text is shown but never runs).

**Why:** The drizzle `sql` tagged template literal creates a `SQL` object. The Neon pooled connection's `.execute()` expects the SQL object to come from the same import chain that was used to configure the DB pool. When imported statically at the top of a large file like `routes.ts`, the binding breaks in this specific combination.

**How to apply:** Inside any route handler that needs raw SQL via `getSharedDb()`, use:

```ts
const { sql: rawSql } = await import('drizzle-orm');
const obsDb = getSharedDb();
const rows = await obsDb.execute(rawSql`SELECT ... FROM ... WHERE id = ${someId}`);
```

The dynamic import resolves to the same module — no performance concern. The pattern already appears in many handlers throughout `routes.ts`; match it rather than inventing a new approach. The row accessor pattern also varies by driver: try `(result as any).rows?.[0] ?? (result as any)[0] ?? null`.

**Why this matters:** The top-level `sql` import looks identical and TypeScript doesn't catch the mismatch. The error ("Failed query: ... params: ") looks like a DB connectivity problem but is actually an import binding issue.

## Drizzle sql tag cannot bind a raw array for ::text[]

postgres.js's own tagged-template client (`` db`INSERT ... VALUES (${jsArray}::text[])` ``) serializes a JS array directly into a Postgres array literal. Drizzle-orm's `sql` tag used with `db.execute(sql\`...\`)` (via `getSharedDb()`/`getUserDb()` — both Drizzle instances, per `server/db.ts`) does not do this: a raw JS array bound this way does not cast to `text[]` correctly.

**How to apply:** Build the array as a Postgres array-literal STRING and interpolate that string with the `::text[]` cast, instead of interpolating the array itself:

```ts
function pgTextArrayLiteral(values: string[]): string {
  return `{${values.map(v => `"${v.replace(/"/g, '\\"')}"`).join(',')}}`;
}
// ...
await db.execute(sql`INSERT INTO t (col) VALUES (${pgTextArrayLiteral(['a', 'b'])}::text[])`);
```

This pattern already existed in `agent-session-autosave.ts` (`participantsArray`) before being reused in `save-transcript-now.ts`'s chat-capture participants fix (Sep 2026). Scripts using the raw postgres.js tag directly (e.g. `capture-watchdog.ts`'s `` db`...` ``) don't need this — they can bind a JS array to `::text[]` natively.

## SQL CASE expression — Drizzle parameter vs column disambiguation

## The rule
In a Drizzle `sql\`...\`` template, `${content}` is a **bound parameter** and bare `content` is the **SQL column reference**. They are not ambiguous — the SQL engine distinguishes them correctly. The atomic CASE WHEN pattern is safe and preferred over a JS read-then-write sequence.

## Correct atomic pattern
```sql
UPDATE conversation_memories
SET content = CASE
      WHEN LENGTH(${content}) >= LENGTH(content)
      THEN ${content}
      ELSE content
    END,
    summary = ${summary}
WHERE id = ${memoryId}
```
`LENGTH(${content})` → length of the incoming JS string (bound parameter).
`LENGTH(content)` → length of the existing DB column value.
Both evaluate correctly in a single round-trip with no concurrency window.

**Why:** A read-then-write alternative (SELECT length, then conditional UPDATE) introduces a TOCTOU race: two concurrent writers can both read the old length and then both write, allowing a shorter stale write to overwrite a longer committed one. The atomic CASE expression eliminates this window.

**How to apply:** When writing a monotonic-guard UPDATE (e.g. "only overwrite if new value is larger/newer"), use a SQL CASE expression inside the UPDATE rather than a SELECT + conditional UPDATE. Drizzle's interpolation disambiguates parameters from column names correctly.

## Lazy regex + multiline $ silently truncates a match

A regex meant to lazily consume "everything up to a following marker or the
end of the document" typically looks like:

```js
new RegExp(`PREFIX[\\s\\S]*?(?=\\nNEXT_MARKER|$)`)
```

Adding the `m` (multiline) flag to that pattern breaks it silently. With `m`,
`$` matches before *every* line's terminator, not just at the true end of the
input. Because the quantifier is lazy, the engine stops at the *first*
position satisfying the lookahead -- which is now the end of the first line
of the block, not the end of the document. The match (and anything built on
it, like a `.replace()`) then only ever covers the first line of the intended
span, silently leaving the rest of that block's old content sitting in the
output instead of being replaced.

**Why:** in JavaScript, `$` without `m` already matches only the true end of
the input (unlike some other regex flavors that match before a trailing
newline), so `m` was never needed to make `$` reachable there at all -- it
only adds extra, unwanted reachability at every line break, which defeats the
"don't stop until you truly must" point of the lazy quantifier. A fixture
where the block being matched is a single line, or is the last thing in the
document, will not expose this -- the bug only shows up when the intended
match spans multiple lines *and* something else follows it.

**How to apply:** whenever pairing a lazy `[\s\S]*?` (or `.*?`) with
`(?=OTHER_MARKER|$)` to consume up to a marker-or-end, do not add the `m`
flag unless `^`/`$` are also doing real per-line anchoring work elsewhere in
the same pattern. Test with a fixture where the target block has multiple
lines of body content *and* a further section follows it -- that is the
minimal case that distinguishes "matched the whole block" from "matched only
its first line."

## Omit of a discriminated union collapses to common keys only

`Omit<T, K>` on a discriminated union `T` (e.g. a union of command variants each with a different `type` and different extra fields) does not distribute over the union members. TypeScript first computes `keyof T` as only the keys common to *every* member, then omits `K` from that. The result is a type with only the shared keys (e.g. just `type`), silently dropping every variant-specific field (e.g. a field present on one variant but not another).

**Why this matters:** annotating a fresh object literal with a computed `Omit<Union, K>` type (intending "the union minus these common fields") looks reasonable and compiles fine for the variant that has no extra fields, but fails excess-property checking the moment the literal includes a field that isn't in the shared-keys-only result, even though that field is perfectly valid on the real union member.

**How to apply:** don't annotate a fresh discriminated-union literal with a computed `Omit<Union, K>` type. Leave the literal's type inferred (let TypeScript pick the correct narrowed member from the `type` field), then pass the resulting variable -- not a fresh literal -- into the function expecting the `Omit<...>` type. Passing a variable of the full union type is structurally assignable there; only a *fresh object literal* triggers excess-property checking against the collapsed common-keys-only type.


## Portable TypeScript exports need module-format metadata

When exporting TypeScript tooling outside the repository, preserve its package
module format explicitly with a minimal package.json. Test both the CLI and
named ESM imports from the extracted location.

**Why:** An exported ownership CLI passed its CLI checks without a package
marker, but tsx treated its modules as CommonJS outside the repository. Named
ESM imports then reported missing exports. Restoring type: module made the
entire extracted-tool suite pass.

**How to apply:** Portable source-transfer bundles should carry their required
local imports and module-format metadata, but no credentials or private keys.
For ownership bootstrap, keep the original task checkout as process.cwd() and
run the extracted tool externally rather than editing an unverified checkout.

## Date precision across canonical evidence creation and replay

**Rule:** Never round-trip a JavaScript Date through String(date) when constructing signed or hashed evidence. Date.toString() loses milliseconds, whereas a database timestamp string can retain them.

**Why:** A read-only reconstruction of eight historical runtime manifests matched their stored digests only when creation timestamps lost their milliseconds. Replay reconstructed the same records with database precision and rejected all eight. This was an evidence-serialization discrepancy, not damaged Windows credentials.

**How to apply:** Verify canonical payloads across fresh in-memory values and actual database-driver results, including nonzero milliseconds. Historical signed evidence must remain verifiable against its original stored digest; do not rewrite digests or bypass integrity checks to repair a serialization change.


## Test-fixture typechecking boundary

The TypeScript tooling lessons include [test-fixture typechecking boundaries](tsc-excludes-test-files.md). That original topic retains the full lesson and evidence.

**Why:** A successful compiler run may omit test fixtures entirely. Keeping this pointer with the other TypeScript tooling lessons reduces index duplication without deleting the original record.

**How to apply:** Check which files the compiler includes, and execute affected test files rather than treating a clean typecheck as fixture verification.


## Constructor-free offline lifecycle tests

When reproducing live-session behavior offline by bypassing its constructor, retain the real method bodies AND their safe state defaults. A partial synthetic object can fail on missing rolling arrays or lexical constants before it ever reaches the suspected bug.

**Why:** Avoiding the live constructor also avoids its field initialization. Several initial harness failures were missing fixture state, not evidence against the production lifecycle. Separately verify the state mutation, the recorded event, and the external delivery sink; a correct safety discard can coexist with an incomplete trace.

**How to apply:** Project reviewed method bodies into an isolated runtime with explicit external stubs; preserve only literal, non-I/O field initializers; block unknown side effects. Compare event orderings and use a runtime-only mutation as a detector control. Clearly distinguish passing characterization of an existing defect from a passing correctness gate.


## Historical esbuild resolver metadata

A closed esbuild resolver plugin must preserve native Node-built-in side-effect metadata when reproducing historical bytes.

**Why:** Returning external:true alone retained otherwise unused built-in imports, changed symbol allocation, and produced a different bundle from identical source/configuration. Returning sideEffects:false for an exact allowlist of Node built-ins reproduced the original output.

**How to apply:** Do not dismiss historical hash mismatches as compiler drift. Compare emitted bytes, verify the resolver metadata, and prove the original hash before accepting a closed-graph build wrapper.

