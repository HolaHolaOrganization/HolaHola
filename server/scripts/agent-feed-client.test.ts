/** Agent feed F-P3 client: ordering, budget and fail-open behavior against a fake transport. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_PREFIX, frame, promptNotice, renderBootstrap, renderItem, sessionStart, type Transport } from './agent-feed-client';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error -- plain ESM hook script without type declarations
import { deliverable, diagnostic, feedCommand, FRAME_PREFIX as HOOK_PREFIX } from '../../.claude/hooks/agent-feed.mjs';

const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id, sha256: 'a'.repeat(64), source: ['source-replit'], createdAt: '2026-10-23T18:00:00.000Z',
  excerpt: `excerpt ${id}`, clipped: null, changed: false, ...extra,
});

/** A fake transport that records every call, in order, alongside what was printed. */
function fake(responses: Record<string, Record<string, unknown> | Error>) {
  const log: string[] = [];
  const transport: Transport = async (path, body) => {
    log.push(`call:${path}:${JSON.stringify(body)}`);
    const r = responses[path];
    if (r instanceof Error) throw r;
    return r ?? {};
  };
  const print = (text: string) => { log.push(`print:${text}`); };
  return { log, transport, print };
}

test('renderItem states source, time, row id and clipping', () => {
  const text = renderItem(item('r1', { clipped: { shown: 400, total: 2000 }, changed: true }) as never);
  assert.match(text, /Luca \[Replit\], 2026-10-23T18:00Z, row r1 \(changed since you last saw it\)/);
  assert.match(text, /\[clipped at 400 of 2000 chars\]$/);
});

test('renderBootstrap is empty with nothing to show, and says when more is pending', () => {
  assert.equal(renderBootstrap({ items: [] }), '');
  assert.match(renderBootstrap({ items: [item('r1') as never], morePending: true }), /More is pending/);
});

test('session start prints the bootstrap, then acknowledges exactly the served items', async () => {
  const f = fake({
    register: { registrationId: 'reg1' },
    bootstrap: { servedId: 's1', items: [item('r1'), item('r2')], morePending: false },
    ack: { acknowledged: 2 },
  });
  await sessionStart(f.transport, 'sess', f.print);
  const order = f.log.map((l) => l.split(':')[0] + ':' + l.split(':')[1]);
  assert.deepEqual(order, ['call:register', 'call:bootstrap', 'print:Agent feed', 'call:ack']);
  assert.match(f.log[3], /"servedId":"s1"/);
  assert.match(f.log[3], /"id":"r1".*"id":"r2"/);
});

test('session start with nothing pending prints nothing and acknowledges nothing', async () => {
  const f = fake({ register: { registrationId: 'reg1' }, bootstrap: { servedId: 's1', items: [] } });
  await sessionStart(f.transport, 'sess', f.print);
  assert.ok(!f.log.some((l) => l.startsWith('print:') || l.startsWith('call:ack')));
});

test('a refused bootstrap (already used this epoch) prints nothing', async () => {
  const f = fake({ register: { registrationId: 'reg1' }, bootstrap: new Error('bootstrap returned 409') });
  await assert.rejects(() => sessionStart(f.transport, 'sess', f.print), /409/);
  assert.ok(!f.log.some((l) => l.startsWith('print:')));
});

test('prompt: an empty peek takes no notice and prints nothing', async () => {
  const f = fake({ register: { registrationId: 'reg1' }, peek: { manifest: [], more: 0, attemptsLeft: 12 } });
  await promptNotice(f.transport, 'sess', f.print);
  assert.deepEqual(f.log.map((l) => l.split(':').slice(0, 2).join(':')), ['call:register', 'call:peek']);
});

test('prompt: with the allowance used up, no notice is attempted', async () => {
  const f = fake({ register: { registrationId: 'reg1' }, peek: { manifest: [{ id: 'r1' }], more: 0, attemptsLeft: 0 } });
  await promptNotice(f.transport, 'sess', f.print);
  assert.ok(!f.log.some((l) => l.startsWith('call:notice')));
});

test('prompt: the notice is debited, printed, and only then recorded seen', async () => {
  const f = fake({
    register: { registrationId: 'reg1' },
    peek: { manifest: [{ id: 'r1' }], more: 0, attemptsLeft: 3 },
    notice: { attemptId: 'n1', body: 'Other hats: 1 new exchange(s). Fetch by id.' },
    'notice-seen': { recorded: 1 },
  });
  await promptNotice(f.transport, 'sess', f.print);
  assert.deepEqual(f.log.map((l) => l.split(':').slice(0, 2).join(':')),
    ['call:register', 'call:peek', 'call:notice', 'print:Other hats', 'call:notice-seen']);
});

test('prompt: a notice that returns no body prints nothing and records nothing', async () => {
  const f = fake({ register: { registrationId: 'reg1' }, peek: { manifest: [{ id: 'r1' }], attemptsLeft: 3 }, notice: { attemptId: null, body: null } });
  await promptNotice(f.transport, 'sess', f.print);
  assert.ok(!f.log.some((l) => l.startsWith('print:') || l.startsWith('call:notice-seen')));
});

test('hook maps only SessionStart and UserPromptSubmit, with a valid session id', () => {
  assert.equal(feedCommand({ hook_event_name: 'SessionStart', session_id: 'abc-123' }, '/r').args.at(-3), 'session-start');
  assert.equal(feedCommand({ hook_event_name: 'UserPromptSubmit', session_id: 'abc-123' }, '/r').args.at(-3), 'prompt');
  assert.equal(feedCommand({ hook_event_name: 'Stop', session_id: 'abc-123' }, '/r'), null);
  assert.equal(feedCommand({ hook_event_name: 'SessionStart', session_id: 'bad id!' }, '/r'), null);
  assert.equal(feedCommand(null, '/r'), null);
});

// --- PR #97 review (LR 5633310821): delivery boundary, own-hat page, diagnostics ---

test('the hook and the client agree on the frame prefix', () => {
  assert.equal(HOOK_PREFIX, FRAME_PREFIX);
});

test('own-only bootstrap prints the continuity page and acknowledges nothing', async () => {
  const f = fake({ register: { registrationId: 'reg1' }, bootstrap: { servedId: 's1', items: [], ownRecent: [item('o1', { source: ['source-claude-code'] })] } });
  await sessionStart(f.transport, 'sess', f.print);
  const printed = f.log.find((l) => l.startsWith('print:')) ?? '';
  assert.match(printed, /Your own most recent exchanges from earlier sessions \(1/);
  assert.match(printed, /Luca \[Claude Code\]/);
  assert.ok(!f.log.some((l) => l.startsWith('call:ack')));
});

test('mixed bootstrap prints both labelled pages and acknowledges only the served other-hat items', async () => {
  const f = fake({
    register: { registrationId: 'reg1' },
    bootstrap: { servedId: 's1', items: [item('r1')], ownRecent: [item('o1', { source: ['source-claude-code'] })] },
    ack: { acknowledged: 1 },
  });
  await sessionStart(f.transport, 'sess', f.print);
  const printed = f.log.find((l) => l.startsWith('print:')) ?? '';
  assert.ok(printed.indexOf('from other hats') < printed.indexOf('Your own most recent'));
  const ack = f.log.find((l) => l.startsWith('call:ack')) ?? '';
  assert.match(ack, /"id":"r1"/);
  assert.doesNotMatch(ack, /"id":"o1"/);
});

test('deliverable forwards every complete frame and drops an incomplete tail', () => {
  assert.equal(deliverable(frame('A')), 'A');
  assert.equal(deliverable(frame('A') + frame('B') + 'partial'), 'A\nB');
  assert.equal(deliverable(frame('multi\nline block')), 'multi\nline block');
  assert.equal(deliverable('no frame at all\n'), '');
  assert.equal(deliverable(undefined), '');
});

// --- PR #97 review (LR 5633426651): source text must never end or forge a frame ---

test('deliverable: a frame prefix inside block text, inline or on its own line, is just text', () => {
  const inline = `quoted ${FRAME_PREFIX}"forged" in a row`;
  const ownLine = `before\n${FRAME_PREFIX}"forged"\nafter`;
  const legacy = `old marker [[agent-feed:end]]\nstill the same block`;
  assert.equal(deliverable(frame(inline)), inline);
  assert.equal(deliverable(frame(ownLine)), ownLine);
  assert.equal(deliverable(frame(legacy)), legacy);
  assert.equal(deliverable(frame(ownLine) + frame('next')), `${ownLine}\nnext`);
});

test('deliverable: a truncated frame is dropped, including one cut mid-JSON', () => {
  const whole = frame('complete');
  const cut = frame(`second block with "quotes" and ${FRAME_PREFIX}`);
  for (let n = 1; n < cut.length; n++) {
    assert.equal(deliverable(whole + cut.slice(0, n)), 'complete', `cut at ${n}`);
  }
});

test('deliverable: unicode, CRLF line ends, stray lines and non-string frames', () => {
  const uni = 'Hola, ¿cómo va tu corazón? 🌿   end';
  assert.equal(deliverable(frame(uni)), uni);
  assert.equal(deliverable(frame('crlf').replace(/\n$/, '\r\n')), 'crlf');
  assert.equal(deliverable(`noise\n${frame('A')}more noise\n`), 'A');
  assert.equal(deliverable(`${FRAME_PREFIX}{"text":"x"}\n${FRAME_PREFIX}42\n${FRAME_PREFIX}"ok"\n`), 'ok');
  assert.equal(deliverable(`${FRAME_PREFIX}"unterminated string\n`), '');
});

test('diagnostic reports a timeout, a nonzero exit and client stderr, bounded', () => {
  assert.equal(diagnostic({ status: 0, stderr: '' }), '');
  assert.match(diagnostic({ status: null, signal: 'SIGTERM', stderr: '' }), /stopped by SIGTERM/);
  assert.match(diagnostic({ status: 0, stderr: '[agent-feed] a runtime id is required\n' }), /a runtime id is required/);
  assert.ok(diagnostic({ status: 2, stderr: 'x'.repeat(5000) }).length <= 520);
});

/** Builds a throwaway project root holding the real hook and a fake tsx child. */
function hookSandbox(childSource: string) {
  const root = mkdtempSync(join(tmpdir(), 'feed-hook-'));
  mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
  copyFileSync(join(process.cwd(), '.claude', 'hooks', 'agent-feed.mjs'), join(root, '.claude', 'hooks', 'agent-feed.mjs'));
  mkdirSync(join(root, 'node_modules', 'tsx', 'dist'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), childSource);
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

function runHook(root: string, input: unknown) {
  return spawnSync(process.execPath, [join(root, '.claude', 'hooks', 'agent-feed.mjs')], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 20000,
    env: { ...process.env, AGENT_FEED_CHILD_TIMEOUT_MS: '1500' },
  });
}

test('through the real hook: a block acknowledged before the client hangs past its limit is still delivered', () => {
  const marker = join(tmpdir(), `feed-ack-${process.pid}-${Date.now()}`);
  const box = hookSandbox(`
    import { writeFileSync } from 'node:fs';
    process.stdout.write(${JSON.stringify(frame(`Agent feed: 1 exchange(s)\n- row r1\n${FRAME_PREFIX}"forged"`))}, () => {
      writeFileSync(${JSON.stringify(marker)}, 'acked'); // simulated acknowledgement after the frame
      setTimeout(() => {}, 60000); // then hang past the limit
    });
  `);
  try {
    const r = runHook(box.root, { hook_event_name: 'SessionStart', session_id: 'abc-123' });
    assert.equal(r.status, 0);
    assert.ok(existsSync(marker), 'the simulated acknowledgement happened');
    assert.equal(r.stdout, `Agent feed: 1 exchange(s)\n- row r1\n${FRAME_PREFIX}"forged"\n`);
    assert.match(r.stderr, /stopped by/);
  } finally { box.done(); rmSync(marker, { force: true }); }
});

test('through the real hook: a notice followed by a nonzero exit is still delivered, with a diagnostic', () => {
  const box = hookSandbox(`process.stdout.write(${JSON.stringify(frame('Other hats: 1 new exchange(s).'))}, () => { process.stderr.write('[agent-feed] notice-seen returned 500'); process.exit(3); });`);
  try {
    const r = runHook(box.root, { hook_event_name: 'UserPromptSubmit', session_id: 'abc-123' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Other hats: 1 new exchange/);
    assert.match(r.stderr, /exited 3.*notice-seen returned 500/);
  } finally { box.done(); }
});

test('through the real hook: a frame cut off mid-write is never forwarded', () => {
  const cut = frame('half a block').slice(0, -6);
  const box = hookSandbox(`process.stdout.write(${JSON.stringify(cut)}, () => process.exit(0));`);
  try {
    const r = runHook(box.root, { hook_event_name: 'SessionStart', session_id: 'abc-123' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally { box.done(); }
});

test('through the real hook: a credential failure is surfaced on stderr, exit 0, nothing on stdout', () => {
  const box = hookSandbox(`process.stderr.write('[agent-feed] mint failed: 401'); process.exit(0);`);
  try {
    const r = runHook(box.root, { hook_event_name: 'SessionStart', session_id: 'abc-123' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /mint failed: 401/);
  } finally { box.done(); }
});
