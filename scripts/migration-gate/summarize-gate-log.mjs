// Migration Gate workflow: the only gate output that reaches the public job log.
// Runs from the trusted main checkout. The raw log is produced by the candidate's
// own code against a production copy, so no raw line (test names, error text,
// command strings, or anything after an expected prefix) is relayed. The output
// is a fixed template filled with a verdict from a closed set and re-rendered
// integers parsed with strict patterns.
//
// Usage: node summarize-gate-log.mjs <gate.log> <gate exit code>
// Exit: the gate's own non-zero code; otherwise 0 only for READY_TO_PROMOTE.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The trusted main checkout this script runs from (scripts/migration-gate/..).
const TRUSTED_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAX_FAILURES_LISTED = 20;
const SOURCE_PATH = /^(?:server|scripts|shared|client|broker)\/[A-Za-z0-9._/-]{1,200}\.(?:test\.)?(?:ts|mts|mjs|js)$/;
const TAP_NOT_OK = /^(\s*)not ok \d{1,9} - (.{1,500})$/;
const TAP_SUBTEST = /^(\s*)# Subtest: (.{1,500})$/;
const SPEC_FAIL = /^(\s*)✖ (.{1,500}?)(?: \(\d+(?:\.\d+)?ms\))?$/;

const READY_LINE = '[gate] READY_TO_PROMOTE — migration and data-ops both passed on an isolated branch.';
// node:test prints its summary with the spec reporter (`ℹ tests 12`) on a TTY and
// with the TAP reporter (`# tests 12`) otherwise, as on a CI runner.
const COUNT_LINE = /^(?:ℹ|#) (tests|pass|fail|skipped|cancelled|todo) (\d{1,9})$/;
const TAP_FAILURE_LINE = /^\s*not ok \d{1,9}\b/;
const COUNT_KEYS = ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo'];

const sha12 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

function isTrustedSourceFile(root, rel) {
  if (!SOURCE_PATH.test(rel) || rel.split('/').includes('..')) return false;
  try {
    return statSync(join(root, rel)).isFile();
  } catch {
    return false;
  }
}

/** True when `name` is written as a string literal in the trusted file's source. */
function isLiteralInSource(root, rel, name) {
  let source;
  try {
    source = readFileSync(join(root, rel), 'utf8');
  } catch {
    return false;
  }
  return [`'${name}'`, `"${name}"`, `\`${name}\``].some((quoted) => source.includes(quoted));
}

/**
 * The failing tests, identified without relaying anything the run produced.
 * The log is public and the run reads a production copy, so a raw test name
 * could carry data (a name built from a row). A file is shown only when it is
 * a real source file in the trusted main checkout; a test name only when that
 * exact name is a string literal in that file, which makes it source text, not
 * output. Every failure always carries a short hash of its name, so a reviewer
 * can match it against a local run even when the name is withheld.
 */
export function failingTestLines(failures, root = TRUSTED_ROOT) {
  const parents = new Set(failures.filter((f) => f.level > 0).map((f) => f.top));
  const seen = new Set();
  const rendered = [];
  for (const failure of failures) {
    // A file-level aggregate is implied by its failing cases; list it only when none is listed.
    if (failure.level === 0 && parents.has(failure.name)) continue;
    const key = `${failure.top}\u0000${failure.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const file = failure.top !== null && isTrustedSourceFile(root, failure.top) ? failure.top : null;
    const isFileItself = file !== null && failure.level === 0 && failure.name === file;
    const name = isFileItself ? '(the file failed; no failing case was listed)'
      : file !== null && isLiteralInSource(root, file, failure.name) ? failure.name : 'withheld';
    rendered.push(`- file: ${file ?? 'withheld'} | test: ${name} | id: ${sha12(failure.name)}`);
  }
  if (rendered.length === 0) return [];
  const listed = rendered.slice(0, MAX_FAILURES_LISTED);
  return [
    'failing tests (file and name shown only when they are source text in main; id is the first 12 hex of the name\'s sha256):',
    ...listed,
    ...(rendered.length > listed.length ? [`- and ${rendered.length - listed.length} more`] : []),
  ];
}

/** Returns { lines, exitCode } for a raw gate log and the gate's exit code string. */
export function summarize(text, exitCodeRaw) {
  const exitCode = /^\d{1,3}$/.test(String(exitCodeRaw)) ? Number(exitCodeRaw) : null;
  const rows = text === null ? [] : text.split(/\r?\n/);
  const totals = Object.fromEntries(COUNT_KEYS.map((key) => [key, 0]));
  let groupsStarted = 0;
  let failedTestLines = 0;
  let readyLines = 0;
  let failedLines = 0;
  // TAP nests subtests by four-space indentation; the top-level subtest of a
  // multi-file `node --test` run is the file itself.
  const subtests = [];
  const failures = [];
  for (const row of rows) {
    const subtest = TAP_SUBTEST.exec(row);
    if (subtest) {
      const level = Math.floor(subtest[1].length / 4);
      subtests.length = level;
      subtests[level] = subtest[2];
    }
    const notOk = TAP_NOT_OK.exec(row);
    if (notOk) {
      const level = Math.floor(notOk[1].length / 4);
      failures.push({ name: notOk[2].replace(/ # (?:TODO|SKIP)\b.*$/, ''), level, top: level === 0 ? notOk[2] : subtests[0] ?? null });
    } else if (row !== '✖ failing tests:') {
      const spec = SPEC_FAIL.exec(row);
      if (spec) failures.push({ name: spec[2], level: Math.floor(spec[1].length / 2), top: null });
    }
    const count = COUNT_LINE.exec(row);
    if (count) totals[count[1]] += Number(count[2]);
    if (row.startsWith('[gate] Running ')) groupsStarted += 1;
    if ((row.startsWith('✖ ') && row !== '✖ failing tests:') || TAP_FAILURE_LINE.test(row)) failedTestLines += 1;
    if (row === READY_LINE) readyLines += 1;
    if (row.startsWith('[gate] FAILED: ')) failedLines += 1;
  }

  let verdict;
  if (text === null || exitCode === null) verdict = 'INCOMPLETE';
  else if (exitCode !== 0) verdict = 'FAILED';
  else if (readyLines === 1 && failedLines === 0) verdict = 'READY_TO_PROMOTE';
  else verdict = 'INCOMPLETE';

  const lines = [
    'migration-gate summary (raw output withheld: public log, production-copy data)',
    `verdict: ${verdict}`,
    `gate exit code: ${exitCode === null ? 'unknown' : exitCode}`,
    `gate groups started: ${groupsStarted}`,
    `test totals: ${COUNT_KEYS.map((key) => `${key} ${totals[key]}`).join(', ')}`,
    `failing test lines: ${failedTestLines}`,
    `log lines: ${text === null ? 'missing' : rows.length}`,
    // Only for a failed gate: on a pass, a mutation proof's expected nested
    // failures would read as real ones.
    ...(verdict === 'FAILED' ? failingTestLines(failures) : []),
  ];
  const outcome = exitCode !== null && exitCode !== 0 ? exitCode : verdict === 'READY_TO_PROMOTE' ? 0 : 1;
  return { lines, exitCode: outcome };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [logPath, exitCodeRaw] = process.argv.slice(2);
  const text = logPath && existsSync(logPath) ? readFileSync(logPath, 'utf8') : null;
  const result = summarize(text, exitCodeRaw ?? '');
  for (const line of result.lines) console.log(line);
  process.exitCode = result.exitCode;
}
