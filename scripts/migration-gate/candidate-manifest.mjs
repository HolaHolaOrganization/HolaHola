// Migration Gate workflow: print the candidate's source manifest and refuse a
// candidate that does not contain the main commit the workflow was dispatched from.
// Runs from the trusted main checkout against the candidate checkout (cwd).
//
// Usage: node candidate-manifest.mjs --base <40-hex main sha>
//
// Output is line-oriented. Every changed path is one JSON object, so a path with
// spaces, quotes or control characters stays unambiguous. Because the base must be
// an ancestor of HEAD, the base..HEAD diff is the full current-main-to-candidate
// comparison (no main-side changes are missing from it).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const GATED_DIRS = ['migrations/', 'scripts/data-ops/'];

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: options.encoding ?? 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function isAncestor(base, head) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', base, head], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Parses `git diff --name-status -z -M` output into entries. */
export function parseNameStatus(raw) {
  const fields = raw.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const entries = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    if (/^[RC]\d*$/.test(status)) {
      const from = fields[i++];
      const path = fields[i++];
      if (from === undefined || path === undefined) throw new Error('truncated rename/copy entry');
      entries.push({ status, from, path });
    } else if (/^[ADMTUX]$/.test(status)) {
      const path = fields[i++];
      if (path === undefined) throw new Error('truncated entry');
      entries.push({ status, path });
    } else {
      throw new Error(`unexpected diff status ${JSON.stringify(status)}`);
    }
  }
  return entries;
}

const gated = (path) => GATED_DIRS.some((dir) => path.startsWith(dir));
const blobSha256 = (rev, path) => createHash('sha256').update(git(['show', `${rev}:${path}`], { encoding: 'buffer' })).digest('hex');

/** Builds the manifest lines, or throws when the candidate does not contain the base. */
export function buildManifest(base) {
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error('--base must be a 40-hex commit');
  const head = git(['rev-parse', 'HEAD']).trim();
  if (!isAncestor(base, head)) throw new Error(`candidate ${head} does not contain dispatch main ${base}; rebuild it on current main`);
  const entries = parseNameStatus(git(['diff', '--name-status', '-z', '-M', base, head]));
  const lines = [
    `candidate ${head} tree ${git(['rev-parse', `${head}^{tree}`]).trim()}`,
    `parents ${git(['log', '-1', '--format=%P', head]).trim()}`,
    `base (dispatch main) ${base}; merge-base ${git(['merge-base', base, head]).trim()}`,
    `changed paths: ${entries.length}`,
    ...entries.map((entry) => JSON.stringify(entry)),
    'migration and data-op content (sha256 of committed blobs):',
  ];
  for (const entry of entries) {
    if (entry.from && gated(entry.from)) {
      lines.push(JSON.stringify({ status: entry.status, side: 'base', path: entry.from, sha256: blobSha256(base, entry.from) }));
    }
    if (!gated(entry.path)) continue;
    lines.push(entry.status === 'D'
      ? JSON.stringify({ status: 'D', side: 'base', path: entry.path, sha256: blobSha256(base, entry.path) })
      : JSON.stringify({ status: entry.status, side: 'candidate', path: entry.path, sha256: blobSha256(head, entry.path) }));
  }
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--base');
  try {
    for (const line of buildManifest(i > 0 ? process.argv[i + 1] ?? '' : '')) console.log(line);
  } catch (error) {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
