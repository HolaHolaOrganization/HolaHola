# Render production release

Render is HolaHola's production target. Replit and other builder runtimes
share the GitHub-to-Render release path; publishing an instance on a builder's
own hosting platform is not production publication.

## Shared procedure

1. Validate the intended source and settle the tracked worktree. Synchronize
   through the canonical source-control service, never a direct push or force
   push. Inspect its result and independently confirm the GitHub commit.
2. Run `npm run source-control:prepare -- --actor <your-actor>`. Preparation
   requires equal source heads, a clean tracked tree, and all eight mandatory
   checks. Use the resulting exact candidate commit, source-context digest,
   validation identity, and expiry; an automatically validated sync candidate
   alone is insufficient.
3. Obtain founder publication approval for that candidate and publish it on
   the existing Render service. Verify its actual repository, branch, deployment
   mode, and CI requirements; a checked-in Blueprint is not proof of dashboard
   settings. Replit's native Publish button deploys to Replit, not Render.
4. Read the operator-pinned Render `/health/release` endpoint. Require HTTP 200,
   `authority: "build"`, `promotable: true`, and exact matches for the candidate
   commit, source-context digest, and digest algorithm. Application readiness
   and a successful GitHub push are not release proof.
5. Record using the same canonical service from any authorized builder:

   ```sh
   npm run source-control:record -- <candidate-sha> \
     --actor <your-actor> \
     --publication-reference "render-release:<candidate-sha>:<candidate-source-context-sha256>"
   ```

   The shared protected API alternatively accepts `sha` and
   `sourceContextSha256` at `/api/admin/source-promotion/record`, with the
   existing actor authentication and idempotency requirements. Use the
   protected candidate digest, not a digest copied from an unrelated runtime.
6. Confirm successful recording. The service checks Render twice, including
   immediately before appending production authority. A valid Replit marker can
   explain same-tree source-head differences, but can never replace Render
   evidence.

## Schema migrations and data-ops (pre-deploy)

Since 2026-10-15, `main` changes only through reviewed, CI-green pull requests
and Render auto-deploys `main` after its checks pass. Pending migrations and
data-ops are applied by Render's **Pre-Deploy Command**,
`npx tsx scripts/render-predeploy.ts`, which runs in the built image before
the new release starts:

1. `drizzle-kit migrate` over a direct (unpooled) connection. It uses
   `NEON_DIRECT_DATABASE_URL` when set, otherwise it derives the direct URL
   from `NEON_SHARED_DATABASE_URL` by dropping Neon's `-pooler` host suffix.
2. `scripts/run-data-ops.ts` (every data-op must be idempotent).

Any failure exits non-zero. Render then fails the deploy and the previous
release keeps serving, so code never starts ahead of its migration. This
replaces the retired `cross-tool-promote.yml` production-apply step. A
migration PR still needs its normal CI validation, and it reaches production
the moment it merges, so review the migration SQL as a production change.
The dashboard setting, not `render.yaml`, is what Render actually runs:
verify it there.

## Stops and failures

- Expiry, source changes, dirty tracked files, non-explicit preparation,
  failed validation, or any release mismatch require repair and fresh
  preparation, not a bypass or a rewritten historical receipt.
- If Render has not deployed the candidate, inspect GitHub CI and actual Render
  deployment history/settings before retrying. Do not silently trigger a
  deployment, change deployment cadence, or weaken CI.
- Failed or unavailable release checks must retain their JSON error bodies for
  diagnosis. `/health/release` can intentionally return 503 for a non-promotable
  manifest while `/health/readiness` returns ready.
- Keep production DNS on Render. Windows enrollment, runtime publication,
  credentials, host/source pins, and other downstream gates remain separate.