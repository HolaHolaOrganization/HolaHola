// Migration Gate workflow, final step: prove the gate's disposable Neon branch is
// gone. Runs from the trusted main checkout, never from the candidate, and talks to
// the Neon API directly rather than through the candidate's scripts/neon-branch.ts.
//
// Fails closed. Only two outcomes pass:
//   - the gate step never started (outcome "skipped") and left no log;
//   - the gate log names exactly one well-formed branch, the branch list request
//     succeeded and parsed, and no branch has exactly that name.
// A failed or unparseable list, a missing or ambiguous log, or a match all fail.
// The gate itself only warns when its own delete fails, and a branch's expiry is
// a backstop, not proof of absence, so this check is independent of both.
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const API_BASE = 'https://console.neon.tech/api/v2';
const CREATING_PREFIX = '[gate] Creating branch';
const CREATING_LINE =
  /^\[gate\] Creating branch "(test\/migration-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)" from production\.\.\.$/;
const STARTED_OUTCOMES = new Set(['success', 'failure', 'cancelled']);

/** Returns the single branch name the gate log says it created, or an error. */
export function branchNameFromGateLog(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.startsWith(CREATING_PREFIX));
  if (lines.length === 0) return { error: 'gate log has no branch-creation line; cannot prove no branch was created' };
  if (lines.length > 1) return { error: `gate log has ${lines.length} branch-creation lines; expected exactly one` };
  const match = CREATING_LINE.exec(lines[0]);
  if (!match) return { error: 'gate log branch-creation line is malformed' };
  return { name: match[1] };
}

/** Lists the project's branches. Any transport, status or shape problem is an error. */
export async function listBranches({ apiKey, projectId, fetchImpl = fetch }) {
  if (!apiKey || !projectId) return { error: 'NEON_API_KEY and NEON_PROJECT_ID are required' };
  let response;
  try {
    response = await fetchImpl(`${API_BASE}/projects/${encodeURIComponent(projectId)}/branches`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { error: `branch list request failed: ${error instanceof Error ? error.name : 'unknown'}` };
  }
  if (!response.ok) return { error: `branch list returned HTTP ${response.status}` };
  let body;
  try {
    body = await response.json();
  } catch {
    return { error: 'branch list response is not JSON' };
  }
  const branches = body?.branches;
  if (!Array.isArray(branches) || branches.some((b) => !b || typeof b !== 'object' || typeof b.name !== 'string')) {
    return { error: 'branch list response has no well-formed branches array' };
  }
  // The endpoint is cursor-paginated (response.pagination.next). Rather than
  // follow cursors, refuse: a further page could hold the branch, so any
  // pagination object other than an explicitly empty one makes absence unknown.
  if (body.pagination !== undefined) {
    const pagination = body.pagination;
    const empty = pagination && typeof pagination === 'object' && !Array.isArray(pagination)
      && (pagination.next === undefined || pagination.next === null || pagination.next === '');
    if (!empty) return { error: 'branch list is paginated or has an unrecognized pagination object' };
  }
  return { names: branches.map((b) => b.name) };
}

/** Decides the step's result. Returns { ok, message }. */
export async function verifyBranchAbsent({ outcome, logPath, apiKey, projectId, fetchImpl }) {
  const logExists = Boolean(logPath) && existsSync(logPath);
  if (outcome === 'skipped') {
    return logExists
      ? { ok: false, message: 'gate step is reported skipped but its log exists' }
      : { ok: true, message: 'gate never started; no branch to verify' };
  }
  if (!STARTED_OUTCOMES.has(outcome)) return { ok: false, message: `unknown gate step outcome "${outcome}"` };
  if (!logExists) return { ok: false, message: 'gate started but its log is missing' };

  const parsed = branchNameFromGateLog(readFileSync(logPath, 'utf8'));
  if (parsed.error) return { ok: false, message: parsed.error };

  const listed = await listBranches({ apiKey, projectId, fetchImpl });
  if (listed.error) return { ok: false, message: `${listed.error}; absence of ${parsed.name} is unknown` };

  const matches = listed.names.filter((name) => name === parsed.name).length;
  return matches === 0
    ? { ok: true, message: `disposable branch ${parsed.name} confirmed absent (${listed.names.length} branches listed)` }
    : { ok: false, message: `disposable branch ${parsed.name} still exists` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyBranchAbsent({
    outcome: process.env.GATE_OUTCOME ?? '',
    logPath: process.env.GATE_LOG ?? '',
    apiKey: process.env.NEON_API_KEY,
    projectId: process.env.NEON_PROJECT_ID,
  });
  console.log(result.ok ? result.message : `::error::${result.message}`);
  process.exitCode = result.ok ? 0 : 1;
}
