// The Claude Code Stop-hook listener guard (.claude/hooks/listener-guard.mjs):
// a turn may not end silently while coordination events are pending or the
// listener is down. It blocks once, then only warns (stop_hook_active), reads
// local state only and fails open. Temporary state directories only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const HOOK = resolve('.claude/hooks/listener-guard.mjs');
const { assessListener } = await import(pathToFileURL(HOOK).href) as {
  assessListener: (stateDir: string, now?: number) => { applies: boolean; problems: string[] };
};
const NOW = Date.parse('2026-11-02T04:00:00.000Z');

function stateDir(options: { lock?: boolean; heartbeatAgoMs?: number; pending?: string[] } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'listener-guard-'));
  if (options.lock) writeFileSync(join(dir, 'watch.lock'), '{}');
  if (options.heartbeatAgoMs !== undefined) writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({ at: new Date(NOW - options.heartbeatAgoMs).toISOString() }));
  if (options.pending) {
    mkdirSync(join(dir, 'pending'));
    for (const id of options.pending) writeFileSync(join(dir, 'pending', `${id}.json`), '{}');
  }
  return dir;
}

function runHook(dir: string, input: unknown) {
  const result = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env: { ...process.env, LUCAMSG_STATE_DIR: dir }, encoding: 'utf8' });
  return { status: result.status, out: result.stdout ? JSON.parse(result.stdout) : null };
}

test('a runtime with no listener state is left alone', () => {
  assert.deepEqual(assessListener(join(tmpdir(), 'no-such-listener-state-dir'), NOW), { applies: false, problems: [] });
});

test('a running listener with nothing pending passes; a stale heartbeat, a missing lock or a pending event is a problem', () => {
  assert.deepEqual(assessListener(stateDir({ lock: true, heartbeatAgoMs: 10_000 }), NOW).problems, []);
  assert.match(assessListener(stateDir({ lock: true, heartbeatAgoMs: 120_000 }), NOW).problems.join(), /not running/);
  assert.match(assessListener(stateDir({ heartbeatAgoMs: 1_000 }), NOW).problems.join(), /not running/);
  assert.match(assessListener(stateDir({ lock: true }), NOW).problems.join(), /not running/, 'a lock with no readable heartbeat is not running');
  const pending = assessListener(stateDir({ lock: true, heartbeatAgoMs: 1_000, pending: ['abc'] }), NOW).problems;
  assert.equal(pending.length, 1);
  assert.match(pending[0], /1 coordination event\(s\) pending \(abc\)/);
});

test('the hook blocks the first stop with a reason, then only warns, and prints nothing when all is well', () => {
  const down = stateDir({ pending: ['evt-1'] });
  const first = runHook(down, { hook_event_name: 'Stop', stop_hook_active: false });
  assert.equal(first.status, 0);
  assert.equal(first.out.decision, 'block');
  assert.match(first.out.reason, /^Listener guard: .*pending.*not running/);
  const second = runHook(down, { hook_event_name: 'Stop', stop_hook_active: true });
  assert.equal(second.out.decision, undefined, 'never blocks twice in one turn');
  assert.match(second.out.systemMessage, /not blocking again this turn/);
  // A real-time heartbeat (the hook process uses the wall clock, not NOW).
  const fine = mkdtempSync(join(tmpdir(), 'listener-guard-'));
  writeFileSync(join(fine, 'watch.lock'), '{}');
  writeFileSync(join(fine, 'heartbeat.json'), JSON.stringify({ at: new Date().toISOString() }));
  assert.deepEqual(runHook(fine, { hook_event_name: 'Stop' }), { status: 0, out: null });
});

test('bad input fails open, and the tracked settings register the guard as a Stop hook', () => {
  const result = spawnSync(process.execPath, [HOOK], { input: 'not json', env: { ...process.env, LUCAMSG_STATE_DIR: stateDir({ lock: true, heartbeatAgoMs: 0 }) }, encoding: 'utf8' });
  assert.equal(result.status, 0);
  const settings = JSON.parse(readFileSync(resolve('.claude/settings.json'), 'utf8'));
  const commands = (settings.hooks?.Stop ?? []).flatMap((g: any) => g.hooks ?? []).map((h: any) => h.command);
  assert.ok(commands.includes('node .claude/hooks/listener-guard.mjs'));
  assert.ok(commands.includes('node .claude/hooks/record-stop-turn.mjs'), 'the capture hook is still registered');
});
