/** The Stop hook guard blocks a stop while the coordination listener needs attention (.claude/hooks/listener-guard.mjs). */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assessListener } from '../../.claude/hooks/listener-guard.mjs';

const HOOK = fileURLToPath(new URL('../../.claude/hooks/listener-guard.mjs', import.meta.url));
const NOW = Date.parse('2026-10-22T17:00:00Z');

function stateDir({ lock = true, heartbeatAt = '2026-10-22T16:59:30Z' as string | null, pending = [] as string[] } = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), 'listener-guard-')), 'state');
  mkdirSync(join(dir, 'pending'), { recursive: true });
  if (lock) writeFileSync(join(dir, 'watch.lock'), '');
  if (heartbeatAt !== null) writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({ at: heartbeatAt }));
  for (const id of pending) writeFileSync(join(dir, 'pending', `${id}.json`), '{}');
  return dir;
}

function runHook(dir: string, stdin: string) {
  const result = spawnSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8', env: { ...process.env, LUCAMSG_STATE_DIR: dir } });
  return { status: result.status, out: result.stdout ? JSON.parse(result.stdout) : null };
}

describe('assessListener', () => {
  test('a runtime with no listener state directory is left alone', () => {
    assert.deepEqual(assessListener(join(tmpdir(), 'listener-guard-absent-dir'), NOW), { applies: false, problems: [] });
  });
  test('a running listener with nothing pending has no problems', () => {
    assert.deepEqual(assessListener(stateDir(), NOW), { applies: true, problems: [] });
  });
  test('pending events are named', () => {
    const { problems } = assessListener(stateDir({ pending: ['e1', 'e2'] }), NOW);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /2 coordination event\(s\) pending \(e1, e2\)/);
  });
  test('no lock, a stale, future or missing heartbeat all mean not running', () => {
    for (const opts of [{ lock: false }, { heartbeatAt: '2026-10-22T16:58:00Z' }, { heartbeatAt: '2026-10-22T17:05:00Z' }, { heartbeatAt: null }, { heartbeatAt: 'nonsense' }]) {
      const { problems } = assessListener(stateDir(opts), NOW);
      assert.equal(problems.length, 1, JSON.stringify(opts));
      assert.match(problems[0], /not running/);
    }
  });
});

describe('the hook process', () => {
  test('blocks the first stop and says what to do', () => {
    const { status, out } = runHook(stateDir({ lock: false, pending: ['e1'] }), '{}');
    assert.equal(status, 0);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /pending \(e1\).*not running/);
  });
  test('only warns on the follow-up stop, so it can never loop', () => {
    const { status, out } = runHook(stateDir({ pending: ['e1'] }), '{"stop_hook_active":true}');
    assert.equal(status, 0);
    assert.equal(out.decision, undefined);
    assert.match(out.systemMessage, /not blocking again/);
  });
  test('is silent for a healthy listener; unreadable input counts as a first stop', () => {
    const healthy = stateDir({ heartbeatAt: new Date().toISOString() });
    assert.deepEqual(runHook(healthy, '{}'), { status: 0, out: null });
    assert.equal(runHook(stateDir({ lock: false }), 'not json').out.decision, 'block');
  });
});
