/**
 * Local Read-only Worker v1 — staging writer and result validation (design §6.1, §6.5).
 *
 * Staging contains ONLY the selected files, written from `git cat-file blob`
 * bytes at the pinned commit. The supervisor keeps those blob bytes in memory as
 * the immutable baseline (F7). After the harness runs, the staged tree must be
 * byte-identical to that baseline (no changed, added, linked or replaced entry),
 * and every citation is computed from the baseline bytes — never from harness
 * output and never from a re-read of the mutable staged files.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import {
  answerWithCitationsSchema, sha256Hex, type WorkerCitationRecord,
} from '../../../shared/worker-contracts';

/** What was staged: the directory plus the exact Git blob bytes written into it, keyed by repository path. */
export type StagedInput = { dir: string; baseline: ReadonlyMap<string, Buffer> };

export function stageFiles(input: { repoRoot: string; commit: string; files: readonly { path: string }[]; stagingDir: string }): StagedInput {
  mkdirSync(input.stagingDir, { recursive: true });
  if (readdirSync(input.stagingDir).length > 0) throw new Error('staging_not_empty');
  const baseline = new Map<string, Buffer>();
  for (const f of input.files) {
    const bytes = execFileSync('git', ['cat-file', 'blob', `${input.commit}:${f.path}`], { cwd: input.repoRoot, maxBuffer: 1024 * 1024 });
    const dest = join(input.stagingDir, ...f.path.split('/'));
    const rel = relative(input.stagingDir, dest);
    if (rel.startsWith('..') || rel.includes(`..${sep}`)) throw new Error('staging_escape');
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes, { flag: 'wx' });
    baseline.set(f.path, Buffer.from(bytes));
  }
  assertNoLinks(input.stagingDir);
  return { dir: input.stagingDir, baseline };
}

/** Fails if any entry under root is a symbolic link or junction. */
export function assertNoLinks(root: string): void {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error('staging_reparse_point');
      if (st.isDirectory()) stack.push(p);
    }
  }
}

/**
 * Post-run check (F7): the staged tree holds exactly the baseline files with
 * exactly the baseline bytes. Any link, extra entry, missing file, hard link or
 * changed byte is reported; the caller treats it as confinement_violation.
 */
export function verifyStagedTree(staged: StagedInput): { ok: true } | { ok: false; detail: string } {
  const parents = new Set<string>();
  for (const p of staged.baseline.keys()) {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i += 1) parents.add(segs.slice(0, i).join('/'));
  }
  const seen = new Set<string>();
  const stack = [''];
  try {
    while (stack.length) {
      const relDir = stack.pop()!;
      for (const name of readdirSync(join(staged.dir, ...relDir.split('/').filter(Boolean)))) {
        const rel = relDir ? `${relDir}/${name}` : name;
        const st = lstatSync(join(staged.dir, ...rel.split('/')));
        if (st.isSymbolicLink()) return { ok: false, detail: 'staged_entry_is_link' };
        if (st.isDirectory()) {
          if (!parents.has(rel)) return { ok: false, detail: 'staged_extra_directory' };
          stack.push(rel);
          continue;
        }
        const expected = staged.baseline.get(rel);
        if (!expected || !st.isFile()) return { ok: false, detail: 'staged_extra_entry' };
        if (st.nlink > 1) return { ok: false, detail: 'staged_file_hard_linked' };
        const now = readFileSync(join(staged.dir, ...rel.split('/')));
        if (now.length !== expected.length || sha256Hex(now) !== sha256Hex(expected)) return { ok: false, detail: 'staged_file_changed' };
        seen.add(rel);
      }
    }
  } catch {
    return { ok: false, detail: 'staged_tree_unreadable' };
  }
  if (seen.size !== staged.baseline.size) return { ok: false, detail: 'staged_file_missing' };
  return { ok: true };
}

export function removeStaging(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export type HarnessOutcome =
  | { ok: true; answer: unknown; citations: WorkerCitationRecord[]; costTelemetryUsd: number }
  | { ok: false; failureClass: 'schema_invalid' | 'citation_mismatch' | 'auth_required' | 'harness_unavailable' | 'confinement_violation'; detail: string };

const MAX_EXCERPT = 2000;

/** Validates `claude -p --output-format json` stdout; citations come from the immutable baseline bytes. */
export function validateHarnessOutput(stdout: string, baseline: ReadonlyMap<string, Buffer>): HarnessOutcome {
  let raw: unknown;
  try { raw = JSON.parse(stdout.trim()); } catch { return { ok: false, failureClass: 'schema_invalid', detail: 'output_not_json' }; }
  // JSON null, arrays and primitives are valid JSON but never a harness result object.
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, failureClass: 'schema_invalid', detail: 'output_not_object' };
  const parsed = raw as Record<string, unknown>;
  if (parsed.type !== 'result') return { ok: false, failureClass: 'schema_invalid', detail: 'output_not_result' };
  if (parsed.is_error === true) {
    const result = String(parsed.result ?? '');
    return /not logged in|login|authenticat/i.test(result)
      ? { ok: false, failureClass: 'auth_required', detail: 'harness_reported_auth_error' }
      : { ok: false, failureClass: 'harness_unavailable', detail: 'harness_reported_error' };
  }
  const answer = answerWithCitationsSchema.safeParse(parsed.structured_output);
  if (!answer.success) return { ok: false, failureClass: 'schema_invalid', detail: `structured_output_invalid:${answer.error.issues[0]?.path.join('.') ?? 'root'}` };

  const citations: WorkerCitationRecord[] = [];
  for (const c of answer.data.citations) {
    const bytes = baseline.get(c.path);
    if (!bytes) return { ok: false, failureClass: 'citation_mismatch', detail: 'citation_path_not_staged' };
    const lines = bytes.toString('utf8').split(/\r?\n/);
    if (c.endLine > lines.length) return { ok: false, failureClass: 'citation_mismatch', detail: 'citation_beyond_file' };
    const excerpt = lines.slice(c.startLine - 1, c.endLine).join('\n');
    if (excerpt.length > MAX_EXCERPT) return { ok: false, failureClass: 'citation_mismatch', detail: 'citation_excerpt_too_long' };
    citations.push({ path: c.path, startLine: c.startLine, endLine: c.endLine, excerpt, excerptSha256: sha256Hex(Buffer.from(excerpt, 'utf8')) });
  }
  const cost = typeof parsed.total_cost_usd === 'number' && Number.isFinite(parsed.total_cost_usd) ? parsed.total_cost_usd : 0;
  return { ok: true, answer: answer.data, citations, costTelemetryUsd: Math.max(0, Math.min(cost, 1000)) };
}
