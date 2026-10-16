import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BACKGROUND_TASKS,
  INSTANCE_ROLE_ENV,
  createBackgroundTaskGate,
  isBackgroundTaskAllowed,
  resolveInstanceRole,
  type BackgroundTaskId,
} from './instance-role';

const TASK_IDS = Object.keys(BACKGROUND_TASKS) as BackgroundTaskId[];
const INDEX_SOURCE = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

test('resolveInstanceRole accepts exactly production and dev', () => {
  assert.equal(resolveInstanceRole({ [INSTANCE_ROLE_ENV]: 'production' }), 'production');
  assert.equal(resolveInstanceRole({ [INSTANCE_ROLE_ENV]: 'dev' }), 'dev');
});

test('resolveInstanceRole refuses a missing, empty or unknown role', () => {
  assert.throws(() => resolveInstanceRole({}), /HOLAHOLA_INSTANCE_ROLE is required/);
  assert.throws(() => resolveInstanceRole({ [INSTANCE_ROLE_ENV]: '' }), /is required/);
  for (const bad of ['Production', 'prod', 'development', 'staging', ' production', 'dev ']) {
    assert.throws(() => resolveInstanceRole({ [INSTANCE_ROLE_ENV]: bad }), /unsupported value/, bad);
  }
});

test('default-deny: no background task is allowed on dev today', () => {
  // Allowing a task on dev is a deliberate, reviewed change: update this list with it.
  const allowedOnDev = TASK_IDS.filter((id) => isBackgroundTaskAllowed('dev', id));
  assert.deepEqual(allowedOnDev, []);
});

test('production keeps every registered background task', () => {
  for (const id of TASK_IDS) assert.equal(isBackgroundTaskAllowed('production', id), true, id);
});

test('the gate runs nothing on dev and records every skip', () => {
  const lines: string[] = [];
  const gate = createBackgroundTaskGate('dev', (line) => lines.push(line));
  let ran = 0;
  for (const id of TASK_IDS) gate.run(id, () => { ran++; });
  assert.equal(ran, 0);
  assert.equal(gate.claim('session-monitor'), false);
  const summary = gate.summary();
  assert.equal(summary.started.length, 0);
  assert.equal(summary.skipped.length, TASK_IDS.length + 1);
  assert.ok(lines.every((line) => line.startsWith('[InstanceRole] dev: not starting background task')));
});

test('the gate runs every task on production, synchronously and in call order', () => {
  const gate = createBackgroundTaskGate('production', () => {});
  const order: string[] = [];
  for (const id of TASK_IDS) gate.run(id, () => { order.push(id); });
  assert.deepEqual(order, TASK_IDS);
  assert.equal(gate.claim('session-monitor'), true);
  assert.equal(gate.summary().skipped.length, 0);
});

// ── Structural guard over server/index.ts ─────────────────────────────────────

/** Replaces comments and string/template contents with spaces, keeping offsets. */
function maskCode(src: string): string {
  const out = src.split('');
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2) + 2;
      blank(i, end);
      i = end;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

function matchClose(code: string, openIndex: number): number {
  const open = code[openIndex];
  const close = open === '(' ? ')' : '}';
  let depth = 0;
  for (let k = openIndex; k < code.length; k++) {
    if (code[k] === open) depth++;
    else if (code[k] === close && --depth === 0) return k;
  }
  throw new Error(`unbalanced ${open} at ${openIndex}`);
}

/** Byte ranges of server/index.ts that only execute when the gate allows them. */
function gatedRanges(code: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const m of code.matchAll(/backgroundTasks\.run\(/g)) {
    const open = m.index! + m[0].length - 1;
    ranges.push([m.index!, matchClose(code, open)]);
  }
  for (const m of code.matchAll(/(!?)backgroundTasks\.claim\(/g)) {
    const callEnd = matchClose(code, m.index! + m[0].length - 1);
    if (m[1] === '!') {
      // `if (!claim(id)) { ...return; }` gates the rest of the enclosing block.
      let depth = 0;
      let k = callEnd;
      for (; k < code.length; k++) {
        if (code[k] === '{') depth++;
        else if (code[k] === '}' && --depth < 0) break;
      }
      ranges.push([m.index!, k]);
      continue;
    }
    const after = code.slice(callEnd + 1).match(/^\s*\)\s*(try\s*)?\{/);
    assert.ok(after, `claim at ${m.index} must be followed by a guarded block`);
    const blockOpen = callEnd + 1 + after[0].length - 1;
    let end = matchClose(code, blockOpen);
    const catchMatch = code.slice(end + 1).match(/^\s*catch\s*(\([^)]*\))?\s*\{/);
    if (after[1] && catchMatch) end = matchClose(code, end + 1 + catchMatch[0].length - 1);
    ranges.push([m.index!, end]);
  }
  return ranges;
}

test('every registered task is gated exactly once in server/index.ts', () => {
  for (const id of TASK_IDS) {
    const uses = INDEX_SOURCE.split(`backgroundTasks.run('${id}'`).length - 1
      + INDEX_SOURCE.split(`backgroundTasks.claim('${id}'`).length - 1;
    assert.equal(uses, 1, `${id} must be gated exactly once (found ${uses})`);
  }
  const ids = [...INDEX_SOURCE.matchAll(/backgroundTasks\.(?:run|claim)\('([^']+)'/g)].map((m) => m[1]);
  for (const id of ids) assert.ok(id in BACKGROUND_TASKS, `unregistered task id ${id}`);
});

test('the instance role is resolved before any startup work begins', () => {
  const resolved = INDEX_SOURCE.indexOf('instanceRole = resolveInstanceRole()');
  assert.ok(resolved > 0);
  for (const marker of ['initStripe', 'server.listen(', 'registerRoutes(app)']) {
    assert.ok(resolved < INDEX_SOURCE.indexOf(marker), `role must resolve before ${marker}`);
  }
});

test('no timer or worker starter in server/index.ts runs outside the gate', () => {
  const code = maskCode(INDEX_SOURCE);
  const ranges = gatedRanges(code);
  const inGate = (at: number) => ranges.some(([a, b]) => at >= a && at <= b);
  const starter = /\b(setTimeout|setInterval|setImmediate|start[A-Z]\w*|schedule[A-Z]\w*|run[A-Z]\w*|seed[A-Z]\w*|generate[A-Z]\w*|reap[A-Z]\w*|index[A-Z]\w*|bulk[A-Z]\w*|ensure[A-Z]\w*|populate[A-Z]\w*|connect[A-Z]\w*|sync[A-Z]\w*)\s*\(|\.start(?:[A-Z]\w*)?\s*\(/g;
  // Request-path or read-only calls that are intentionally role-independent.
  const allowed = [
    /voiceTelemetry\.start\(/, // batches telemetry from requests this instance serves
    /runProxyStartupChecks\(/, // read-only reachability log
    /setTimeout\(resolve/, // shutdown / fatal-path drain waits
  ];
  const offenders: string[] = [];
  for (const m of code.matchAll(starter)) {
    if (inGate(m.index!)) continue;
    const line = INDEX_SOURCE.slice(INDEX_SOURCE.lastIndexOf('\n', m.index!) + 1, INDEX_SOURCE.indexOf('\n', m.index!));
    if (allowed.some((re) => re.test(line))) continue;
    const lineNo = INDEX_SOURCE.slice(0, m.index!).split('\n').length;
    offenders.push(`server/index.ts:${lineNo}: ${line.trim()}`);
  }
  assert.deepEqual(offenders, [], 'register these in BACKGROUND_TASKS and gate them');
});
