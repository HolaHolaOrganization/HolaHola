// Migration Gate workflow: the only gate output that reaches the public job log.
// Runs from the trusted main checkout. The raw log is produced by the candidate's
// own code against a production copy, so no raw line (test names, error text,
// command strings, or anything after an expected prefix) is relayed. The output
// is a fixed template filled with a verdict from a closed set and re-rendered
// integers parsed with strict patterns.
//
// Usage: node summarize-gate-log.mjs <gate.log> <gate exit code>
// Exit: the gate's own non-zero code; otherwise 0 only for READY_TO_PROMOTE.
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const READY_LINE = '[gate] READY_TO_PROMOTE — migration and data-ops both passed on an isolated branch.';
const COUNT_LINE = /^ℹ (tests|pass|fail|skipped|cancelled|todo) (\d{1,9})$/;
const COUNT_KEYS = ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo'];

/** Returns { lines, exitCode } for a raw gate log and the gate's exit code string. */
export function summarize(text, exitCodeRaw) {
  const exitCode = /^\d{1,3}$/.test(String(exitCodeRaw)) ? Number(exitCodeRaw) : null;
  const rows = text === null ? [] : text.split(/\r?\n/);
  const totals = Object.fromEntries(COUNT_KEYS.map((key) => [key, 0]));
  let groupsStarted = 0;
  let failedTestLines = 0;
  let readyLines = 0;
  let failedLines = 0;
  for (const row of rows) {
    const count = COUNT_LINE.exec(row);
    if (count) totals[count[1]] += Number(count[2]);
    if (row.startsWith('[gate] Running ')) groupsStarted += 1;
    if (row.startsWith('✖ ') && row !== '✖ failing tests:') failedTestLines += 1;
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
