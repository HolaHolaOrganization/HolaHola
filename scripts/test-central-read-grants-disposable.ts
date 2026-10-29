import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import pg from "pg";
import { getVerifiedCiDatabaseUrl } from "../server/ci-database";

// Native CI has a job-local PostgreSQL service. Own an entire child database,
// not a schema in a database other suites might concurrently be using.
async function main() {
  if (!process.env.CI_DATABASE_URL) {
    console.log("SKIP central-read PostgreSQL proof: no job-local CI database supplied.");
    return;
  }
  const parent = getVerifiedCiDatabaseUrl();
  if (!parent) throw new Error("A verified job-local CI database is required");
  const name = `central_grants_test_${randomBytes(8).toString("hex")}`;
  const target = new URL(parent);
  target.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: parent });
  let created = false;
  try {
    await pool.query(`CREATE DATABASE "${name}"`);
    created = true;
    const cases = [
      { timezone: "UTC", databaseTimezone: "UTC", args: [] as string[] },
      { timezone: "America/Denver", databaseTimezone: "UTC", args: ["--test-name-pattern=central exchange expiry uses only database timestamps|one-calendar-year cap|expiry warning|warning window|failed warning|failed founder-inbox|warning scan racing"] },
      { timezone: "Asia/Kolkata", databaseTimezone: "UTC", args: ["--test-name-pattern=central exchange expiry uses only database timestamps|one-calendar-year cap|expiry warning|warning window|failed warning|failed founder-inbox|warning scan racing"] },
      { timezone: "Asia/Kolkata", databaseTimezone: "America/Denver", args: ["--test-name-pattern=central exchange expiry uses only database timestamps|one-calendar-year cap|expiry warning|warning window|failed warning|failed founder-inbox|warning scan racing"] },
    ];
    for (const proof of cases) {
    console.log(`Central-read PostgreSQL proof: host timezone ${proof.timezone}; database timezone ${proof.databaseTimezone}`);
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1",
        ...proof.args,
        "server/scripts/test-central-read-grants-postgres.ts"], {
        stdio: "inherit", env: { ...process.env, CI: "true", TZ: proof.timezone,
          PGOPTIONS: `-c TimeZone=${proof.databaseTimezone}`, CI_DATABASE_URL: target.toString(),
          NEON_SHARED_DATABASE_URL: target.toString(), CENTRAL_READ_DISPOSABLE_TEST_URL: target.toString() },
      });
      child.once("error", reject);
      child.once("exit", code => resolve(code ?? 1));
    });
    if (code !== 0) throw new Error(`Central-read PostgreSQL proof failed (exit ${code})`);
    }
  } finally {
    if (created) await pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await pool.end();
  }
}
main().catch(() => { console.error("Central-read disposable PostgreSQL proof failed"); process.exitCode = 1; });
