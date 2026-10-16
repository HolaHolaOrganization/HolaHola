import { getVerifiedCiDatabaseUrl } from "../ci-database";

/** Select the test's own target, never the ambient application connection. */
export function reviewDiscoveryTarget(env: NodeJS.ProcessEnv): string | undefined {
  let url = env.SHARED_SPEC_TEST_DATABASE_URL;
  if (!url && env.SHARED_SPEC_REQUIRE_DATABASE_TESTS === "1") {
    throw new Error("SHARED_SPEC_TEST_DATABASE_URL is required by the migration gate");
  }
  if (url) {
    if (env.SHARED_SPEC_TEST_DATABASE_DISPOSABLE !== "1") {
      throw new Error("SHARED_SPEC_TEST_DATABASE_DISPOSABLE=1 is required");
    }
  } else {
    url = getVerifiedCiDatabaseUrl(env);
  }
  if (!url) return undefined;
  const parsed = new URL(url);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("review-discovery tests require a PostgreSQL target");
  }
  if (url === env.SHARED_SPEC_FORBIDDEN_SHARED_URL) {
    throw new Error("shared-spec review-discovery test refuses the shared Neon database");
  }
  return url;
}

/**
 * Must run BEFORE importing db.ts or Alden's dispatch module: db.ts captures
 * its URL at module evaluation, and the tool lazily reuses that singleton.
 * This changes only this test process, never the application's DB routing.
 */
export function bindReviewDiscoveryDatabase(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const url = reviewDiscoveryTarget(env);
  if (!url) return undefined;
  env.NEON_SHARED_DATABASE_URL = url;
  if (["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
    // A verified disposable local target needs the node-postgres transport,
    // including when selected through the dedicated migration-gate variables.
    env.CI = "true";
    env.CI_DATABASE_URL = url;
    getVerifiedCiDatabaseUrl(env);
  } else {
    // A dedicated Neon branch must not inherit an unrelated job-local URL.
    delete env.CI_DATABASE_URL;
  }
  return url;
}
