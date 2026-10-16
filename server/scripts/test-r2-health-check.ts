/**
 * test-r2-health-check.ts
 *
 * Live health check for the R2 object-storage read paths used by student-facing
 * media routes (/api/media/ai-image/:file and /api/media/vm-audio/:file).
 *
 * Not part of PR CI since 2026-10-15 (Phase S, plan efb1e3d1): it needs the real
 * storage credentials, and PR CI receives no repository secrets. Production's own
 * startup + periodic storage probe (storage-probe-alerter.ts) covers live
 * reachability. Run it by hand where the credentials already exist.
 *
 * Three outcomes:
 *   PASS – credentials are valid and both prefixes are reachable (empty or not)
 *   PASS – credentials are valid but both watched prefixes are empty
 *   FAIL – required env vars are absent, credentials are rejected, or
 *           ListObjectsV2 throws for any other reason
 *
 * An empty bucket is NOT a failure — it just means there is nothing to
 * read-verify yet; the credentials check still passes.
 *
 * When the bucket has objects in a watched prefix the script ALSO fetches
 * the first matching object through the Express proxy route that students
 * actually hit (/api/media/ai-image/:file or /api/media/vm-audio/:file) and
 * fails if the status is not 200 or the response body is empty.  If the app
 * server is not reachable the app-route check is skipped with a warning
 * (not a failure), matching the behaviour in verify-system-health.ts.
 *
 * Usage:
 *   npx tsx server/scripts/test-r2-health-check.ts
 *
 * Exit code: 0 = all checks passed, 1 = at least one check failed.
 */

export {}; // top-level await requires module mode

// ── shared app-route check (imported so negative-path test exercises same code) ─
import { checkAppRouteUrl } from './r2-app-route-check.js';

// ── helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function pass(label: string, detail = ""): void {
  console.log(`  ✅  ${label}${detail ? `  — ${detail}` : ""}`);
  passed++;
}

function fail(label: string, detail = ""): void {
  console.error(`  ❌  ${label}${detail ? `  — ${detail}` : ""}`);
  failed++;
}

function warn(label: string, detail = ""): void {
  console.warn(`  ⚠️   ${label}${detail ? `  — ${detail}` : ""}`);
}

// ── env ──────────────────────────────────────────────────────────────────────

const BUCKET    = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID ?? "";
const REGION    = process.env.AWS_S3_REGION ?? "auto";
const ENDPOINT  = process.env.AWS_S3_ENDPOINT ?? "";
const ACCESS_KEY = process.env.AWS_S3_ACCESS_KEY_ID ?? "";
const SECRET_KEY = process.env.AWS_S3_SECRET_ACCESS_KEY ?? "";

// App HTTP base — used to verify the Express proxy routes students actually hit.
// Falls back to localhost:5000 (same default as verify-system-health.ts).
const APP_BASE = process.env.APP_BASE ?? "http://localhost:5000";

console.log("\n── R2 Health Check (CI) ─────────────────────────────────────");

// Required vars — absent = immediate failure so CI surfaces the misconfiguration.
const missing: string[] = [];
if (!BUCKET)      missing.push("DEFAULT_OBJECT_STORAGE_BUCKET_ID");
if (!ACCESS_KEY)  missing.push("AWS_S3_ACCESS_KEY_ID");
if (!SECRET_KEY)  missing.push("AWS_S3_SECRET_ACCESS_KEY");

if (missing.length > 0) {
  fail("R2 env vars present", `Missing: ${missing.join(", ")}`);
  console.log(`\n  ❌  1 failure — R2 credentials not configured in this environment.\n`);
  process.exit(1);
}

// ── S3 client ────────────────────────────────────────────────────────────────

const { S3Client, ListObjectsV2Command, GetObjectCommand } = await import("@aws-sdk/client-s3");

const s3Config: ConstructorParameters<typeof S3Client>[0] = {
  region: REGION,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
};
if (ENDPOINT) {
  s3Config.endpoint = ENDPOINT;
  s3Config.forcePathStyle = true;
}
const s3 = new S3Client(s3Config);

// ── helpers ───────────────────────────────────────────────────────────────────

async function listPrefix(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const resp = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, MaxKeys: 20, ContinuationToken: token })
    );
    for (const obj of resp.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    token = resp.NextContinuationToken;
  } while (token && keys.length < 20);
  return keys;
}

async function directRead(key: string): Promise<number> {
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  let bytes = 0;
  if (resp.Body) {
    for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) bytes += chunk.length;
  }
  return bytes;
}

// ── prefixes to verify ───────────────────────────────────────────────────────

type PrefixSpec = { prefix: string; routeFn: (fname: string) => string; label: string };

const PREFIXES: PrefixSpec[] = [
  { prefix: "public/ai-images/",      routeFn: (f) => `/api/media/ai-image/${f}`,  label: "ai-image" },
  { prefix: "public/voice-messages/", routeFn: (f) => `/api/media/vm-audio/${f}`,  label: "vm-audio" },
];

let anySucceeded = false;
let anyRead = false;

for (const { prefix, routeFn, label } of PREFIXES) {
  let keys: string[];
  try {
    keys = await listPrefix(prefix);
    anySucceeded = true;
  } catch (err: any) {
    fail(`R2 list ${label}`, `ListObjectsV2 failed: ${err?.message ?? err}`);
    continue;
  }

  if (keys.length === 0) {
    // Empty prefix is fine — credentials work, nothing to read-verify yet.
    continue;
  }

  anyRead = true;

  // Prefer a key with a file extension so content-type is meaningful.
  const key = keys.find((k) => (k.split("/").pop() ?? "").includes(".")) ?? keys[0];
  const filename = key.split("/").pop()!;

  // 1. Direct S3 read
  try {
    const bytes = await directRead(key);
    if (bytes === 0) {
      fail(`R2 direct read ${label}`, `Key "${key}" returned 0 bytes`);
    } else {
      pass(`R2 direct read ${label}`, `${bytes} bytes`);
    }
  } catch (err: any) {
    fail(`R2 direct read ${label}`, `GetObject failed: ${err?.message ?? err}`);
  }

  // 2. App route (server must be running; gracefully skip if refused)
  const url = `${APP_BASE}${routeFn(filename)}`;
  const r = await checkAppRouteUrl(url);
  if (r.outcome === "pass") {
    pass(`R2 app route ${label}`, `HTTP ${r.status}, ${r.bytes} bytes`);
  } else if (r.outcome === "fail-empty") {
    fail(`R2 app route ${label}`, `HTTP 200 but 0 bytes returned for "${filename}"`);
  } else if (r.outcome === "fail-non-200") {
    fail(`R2 app route ${label}`, `HTTP ${r.status} for GET ${routeFn(filename)}`);
  } else if (r.outcome === "fail-error") {
    fail(`R2 app route ${label}`, r.message ?? "unknown error");
  } else {
    // outcome === "skip"
    warn(`R2 app route ${label}`, `Server not reachable at ${APP_BASE} — app-route check skipped`);
  }
}

// ── summary ──────────────────────────────────────────────────────────────────

if (failed === 0) {
  if (anySucceeded && !anyRead) {
    // Both prefixes were empty but ListObjectsV2 succeeded — credentials valid.
    pass("R2 credentials valid", "ListObjectsV2 succeeded; both watched prefixes are empty");
  }
  console.log(`\n  ✅  All R2 checks passed (${passed} passed, 0 failed).\n`);
  process.exit(0);
} else {
  console.log(`\n  ❌  ${failed} R2 check(s) failed.\n`);
  process.exit(1);
}
