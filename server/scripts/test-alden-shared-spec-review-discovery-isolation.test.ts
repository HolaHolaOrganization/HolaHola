import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import { getVerifiedCiDatabaseUrl } from "../ci-database";
import { bindReviewDiscoveryDatabase, reviewDiscoveryTarget } from "./alden-review-discovery-test-database";

const targetUrl = "postgresql://postgres@127.0.0.1:5432/permitted";
const trapUrl = "postgresql://postgres@127.0.0.1:5432/ambient_trap";
const dedicated = {
  SHARED_SPEC_TEST_DATABASE_URL: targetUrl,
  SHARED_SPEC_TEST_DATABASE_DISPOSABLE: "1",
  SHARED_SPEC_REQUIRE_DATABASE_TESTS: "1",
  SHARED_SPEC_FORBIDDEN_SHARED_URL: trapUrl,
};

test("target selection fails closed without the exact required disposable contract", () => {
  assert.equal(reviewDiscoveryTarget({ NEON_SHARED_DATABASE_URL: trapUrl }), undefined);
  assert.throws(() => reviewDiscoveryTarget({
    CI: "true", CI_DATABASE_URL: targetUrl, NEON_SHARED_DATABASE_URL: targetUrl,
    SHARED_SPEC_REQUIRE_DATABASE_TESTS: "1",
  }), /SHARED_SPEC_TEST_DATABASE_URL is required/);
  assert.throws(() => reviewDiscoveryTarget({
    ...dedicated, SHARED_SPEC_TEST_DATABASE_DISPOSABLE: undefined,
  }), /DISPOSABLE=1 is required/);
  assert.throws(() => reviewDiscoveryTarget({
    ...dedicated, SHARED_SPEC_FORBIDDEN_SHARED_URL: targetUrl,
  }), /refuses the shared Neon database/);
  assert.throws(() => reviewDiscoveryTarget({
    CI: "true", CI_DATABASE_URL: targetUrl, NEON_SHARED_DATABASE_URL: trapUrl,
  }), /must match CI_DATABASE_URL/);
  assert.throws(() => reviewDiscoveryTarget({
    CI: "true", CI_DATABASE_URL: "postgresql://db.example.com/nonlocal",
    NEON_SHARED_DATABASE_URL: "postgresql://db.example.com/nonlocal",
  }), /job-local/);
  assert.throws(() => reviewDiscoveryTarget({
    ...dedicated, SHARED_SPEC_TEST_DATABASE_URL: "https://db.example.com/not-postgres",
  }), /PostgreSQL target/);
  assert.throws(() => reviewDiscoveryTarget({
    CI: "true", CI_DATABASE_URL: targetUrl, NEON_SHARED_DATABASE_URL: targetUrl,
    SHARED_SPEC_FORBIDDEN_SHARED_URL: targetUrl,
  }), /refuses the shared Neon database/);
});

test("binding selects the verified target and its transport, not an ambient singleton URL", () => {
  const env: NodeJS.ProcessEnv = {
    ...dedicated, NEON_SHARED_DATABASE_URL: trapUrl, CI: "true", CI_DATABASE_URL: trapUrl,
  };
  assert.equal(bindReviewDiscoveryDatabase(env), targetUrl);
  assert.equal(getVerifiedCiDatabaseUrl(env), targetUrl);
  const neonUrl = "postgresql://disposable.example.com/branch";
  const neonEnv = { ...env, SHARED_SPEC_TEST_DATABASE_URL: neonUrl };
  assert.equal(bindReviewDiscoveryDatabase(neonEnv), neonUrl);
  assert.equal(neonEnv.NEON_SHARED_DATABASE_URL, neonUrl);
  assert.equal(neonEnv.CI_DATABASE_URL, undefined);
});

// Never inherit application credentials in a child. In particular the test's
// db.ts imports must not be able to fall back to a shared production URL.
function childEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "NODE_ENV", "REPL_HOME"].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]!]]),
  );
}

async function runDiscovery(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [
    "--import", "tsx", "--test", "--test-reporter=tap",
    "server/scripts/test-alden-shared-spec-review-discovery.test.ts",
  ], {
    cwd: process.cwd(), env: { ...childEnvironment(), ...env },
    stdio: ["ignore", "pipe", "pipe"], timeout: 90_000,
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, output };
}

async function counts(pool: Pool) {
  const { rows } = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM shared_spec_reviewer_policies) AS policies,
      (SELECT count(*)::int FROM shared_spec_documents) AS documents,
      (SELECT count(*)::int FROM shared_spec_revisions) AS revisions,
      (SELECT count(*)::int FROM shared_spec_reviews) AS reviews,
      (SELECT count(*)::int FROM shared_spec_idempotency_records) AS idempotency
  `);
  return rows[0] as Record<string, number>;
}

test("real tool dispatch writes only to the permitted database in dedicated and job-local CI modes", { timeout: 300_000 }, async (context) => {
  // CREATE DATABASE is permitted only inside the existing verified local CI
  // service. A Neon branch or an ordinary dev shell never enters this path.
  const ciUrl = getVerifiedCiDatabaseUrl();
  if (!ciUrl) {
    context.skip("two-database proof requires the verified job-local CI PostgreSQL service");
    return;
  }
  const admin = new Pool({ connectionString: ciUrl });
  const pools: Pool[] = [];
  const databases: string[] = [];
  try {
    for (const mode of ["dedicated", "ci"] as const) {
      const urls: string[] = [];
      for (const role of ["permitted", "trap"]) {
        const name = `review_discovery_${role}_${randomUUID().replaceAll("-", "")}`;
        await admin.query(`CREATE DATABASE "${name}"`);
        databases.push(name);
        const url = new URL(ciUrl);
        url.pathname = `/${name}`;
        urls.push(url.href);
        const pool = new Pool({ connectionString: url.href });
        pools.push(pool);
        // Apply the real shared-spec migrations, not a mock repository/schema.
        for (const migration of [
          "0030_shared_spec_workspace.sql", "0058_fearless_meteorite.sql", "0061_conscious_havok.sql",
        ]) {
          await pool.query(await readFile(new URL(`../../migrations/${migration}`, import.meta.url), "utf8"));
        }
      }
      const [permittedUrl, ambientUrl] = urls;
      const [permitted, trap] = pools.slice(-2);
      const empty = await counts(trap);
      assert.deepEqual(empty, { policies: 0, documents: 0, revisions: 0, reviews: 0, idempotency: 0 });
      const result = await runDiscovery(mode === "dedicated" ? {
        SHARED_SPEC_TEST_DATABASE_URL: permittedUrl,
        SHARED_SPEC_TEST_DATABASE_DISPOSABLE: "1",
        SHARED_SPEC_REQUIRE_DATABASE_TESTS: "1",
        SHARED_SPEC_FORBIDDEN_SHARED_URL: ambientUrl,
        NEON_SHARED_DATABASE_URL: ambientUrl,
        CI: "true", CI_DATABASE_URL: ambientUrl,
      } : {
        CI: "true", CI_DATABASE_URL: permittedUrl, NEON_SHARED_DATABASE_URL: permittedUrl,
        SHARED_SPEC_FORBIDDEN_SHARED_URL: ambientUrl,
      });
      assert.equal(result.code, 0, `${mode}: ${result.output}`);
      assert.match(result.output, /# pass 2/);
      assert.match(result.output, /# skipped 0/);
      const written = await counts(permitted);
      assert.equal(written.policies, 2);
      assert.equal(written.documents, 5);
      assert.equal(written.revisions, 5);
      assert.equal(written.reviews, 5);
      assert.ok(written.idempotency > 0);
      assert.deepEqual(await counts(trap), empty, `${mode}: ambient database must receive no fixture writes`);

      // Exercise the actual entry point, not just its selector, for every
      // unsafe gate state. Neither database may change, even on failures.
      const rejectedEnvs: NodeJS.ProcessEnv[] = [
        { NEON_SHARED_DATABASE_URL: ambientUrl, SHARED_SPEC_REQUIRE_DATABASE_TESTS: "1" },
        { SHARED_SPEC_TEST_DATABASE_URL: permittedUrl, NEON_SHARED_DATABASE_URL: ambientUrl },
        {
          SHARED_SPEC_TEST_DATABASE_URL: ambientUrl, SHARED_SPEC_TEST_DATABASE_DISPOSABLE: "1",
          SHARED_SPEC_FORBIDDEN_SHARED_URL: ambientUrl, NEON_SHARED_DATABASE_URL: ambientUrl,
        },
        { CI: "true", CI_DATABASE_URL: permittedUrl, NEON_SHARED_DATABASE_URL: ambientUrl },
      ];
      for (const env of rejectedEnvs) {
        const rejected = await runDiscovery(env);
        assert.notEqual(rejected.code, 0, `unsafe target must fail: ${rejected.output}`);
        assert.doesNotMatch(rejected.output, /Database pool initialized/);
        assert.deepEqual(await counts(permitted), written, "rejected run must not mutate the permitted database");
        assert.deepEqual(await counts(trap), empty, "rejected run must not mutate the ambient trap");
      }
      const skipped = await runDiscovery({ NEON_SHARED_DATABASE_URL: ambientUrl });
      assert.equal(skipped.code, 0, skipped.output);
      assert.match(skipped.output, /# skipped 1/);
      assert.doesNotMatch(skipped.output, /Database pool initialized/);
      assert.deepEqual(await counts(trap), empty);
    }
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
    // Drop only databases this invocation successfully created. Immutable
    // policy/revision history is retained until disposable DB destruction.
    try {
      for (const name of databases) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }
});
