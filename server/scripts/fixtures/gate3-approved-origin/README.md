# Frozen Gate 3 source inputs — never execute

These `.source` files preserve exact Git blobs from
`6569e244b2b0ee096ee20ac9f5444ca25a45ecf6`. They are data, not live application
modules. The six-file run closure and five-file preparation closure share one
module; thirteen records include their union, the original `tsconfig.json`,
`package.json` and launcher snapshot.

`manifest.json` records paths, byte lengths, SHA-256 hashes, Git blob IDs,
compiler configuration, allowed built-ins and the immutable artifact archive
revision. Its own SHA-256 is independently sealed in
`server/scripts/lib/gate3-historical-integrity.mjs`.

The original generated bundle bytes are preserved in shared-spec document
`ff9d266e-65ef-45fe-ae9c-9e85fe49f122`, immutable revision
`04b00c37-8198-4daf-a296-523dafecec8a`, content SHA-256
`a9983127d8db2b9aa9fb1ae7bcadcdb5d34262d6fa017b5134e6553f95c6b54e`.
The archive uses base64, exact lengths and artifact hashes; creation readback
was decoded and verified. It is preservation, not an approved executable
distribution. Routine CI does not fetch it or rely on Git history.

Run the build-only integrity checks with:

```sh
node --test server/scripts/gate3-historical-integrity.test.mjs
```

Historical pin verification reads the byte-verified launcher in this archive,
not `scripts/antigravity-gate3.ps1` in the live application. Main's live run pin
is `b80917ae…`; the archived run remains `5e620f6b…`. The preparation artifact
remains `06ce0e36…` in both. A separate test in
`server/scripts/test-antigravity-windows-dpapi.test.ts` rebuilds current source
with the normal application compiler and verifies the live pins. This does not
authorize installation, execution of archived output, or publication.

The dedicated `gate3-historical-esbuild` alias is exactly esbuild `0.25.9`.
The checker imports that API directly. It never uses `npx`, installs packages,
imports historical code, or runs either historical output. It verifies every
source/config byte before constructing a closed temporary build root, refuses
unlisted imports and external packages, checks input closures and approved
output hashes, and removes the temporary root on success or failure.

The application's server-build wrapper also resolves its own `esbuild` API
explicitly, preserving the prior flags. This matters because npm aliases expose
the underlying package's same `esbuild` CLI name; a shared `.bin/esbuild` symlink
is not compiler isolation.

Keep LF bytes even on Windows with `core.autocrlf=true`; `.gitattributes`
enforces this and the identity checks detect conversion. The original
`tsconfig.json` is load-bearing: ignoring it changes the approved output.

Application compiler upgrades do not authorize changing this alias, recipe,
manifest, source snapshots or historical hashes. A historical-record correction
requires explicit founder approval **and** independent review of the exact new
record, including why a correction is needed. Neither a failing test nor a
successful modern rebuild is correction authority. Preserve the prior immutable
archive and review history. If the old compiler becomes unusable, report it and
obtain a reviewed policy decision; do not silently refresh the historical hash.

Current-source behavior and launcher security guards remain in
`test-antigravity-windows-dpapi.test.ts`; it imports this build-only suite.
Linux CI runs that entrypoint. Windows CI runs this historical suite directly.
The current-source smoke check imports the app's `esbuild` API explicitly,
passes no application credentials and verifies named fail-closed entrypoint
errors. Neither suite establishes native PowerShell/DPAPI/ACL acceptance.
