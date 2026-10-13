/**
 * Supervisor wiring tests with in-memory ports (no network, no model, no shared data).
 * The ledger port is backed by FakeLedger, which mirrors the real service's
 * idempotency -> CAS -> transition ordering. Each F-numbered test reproduces a
 * finding from Luca's implementation review (shared-spec 60e19c1b rev a95f6ed8)
 * through the real runSupervisor wiring.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WORKER_MINIMUM_DENYLIST, buildCompletionEvidence, charterBodyDigest, claimKeyFor, writeKeyFor, type WorkerCharterBody,
} from '../../../shared/worker-contracts';
import { configDigest } from './adapter';
import type { CharterRecord } from './authority';
import { FakeLedger } from './fake-ledger';
import { freezeOutboxEntry, type OutboxEntry } from './lifecycle';
import type { MembersSnapshot } from './job-launcher';
import { validateHarnessOutput, type StagedInput } from './staging';
import type { HostPort, LaunchExit, LaunchHandle, LedgerPort, StateStore, ThreadView } from './supervisor';
import { runSupervisor } from './supervisor';

const W = 'luca-claude-code';
const CHARTER_ID = '11111111-2222-4333-8444-555555555555';
const INSTANCE = '99999999-9999-4999-8999-999999999999';
const OLD_RUN = '88888888-8888-4888-8888-888888888888';
const COMMIT = 'c'.repeat(40);
const EXE_SHA = 'e'.repeat(64);
const T0 = Date.parse('2026-10-08T03:00:00.000Z');
const tid = (i: number) => `aaaaaaaa-0000-4000-8000-00000000000${i}`;

type LaunchMode = 'ok' | 'hang' | 'unresponsive' | 'exitNull' | 'spawnFail';

type SetupOpts = {
  qualified?: boolean;
  threads?: number;
  jobOver?: Record<string, unknown>;
  charterOver?: Partial<WorkerCharterBody['limits']>;
  authProfiles?: ('subscription' | 'api')[];
  launch?: LaunchMode;
  stdoutOverflow?: boolean;
  validate?: HostPort['validate'];
  verifyStaged?: HostPort['verifyStaged'];
  stage?: HostPort['stage'];
  launchThrows?: boolean;
  stdoutText?: string;
  treeSize?: number;
  members?: (n: number) => MembersSnapshot | null;
  pageMode?: 'normal' | 'incompleteThenFail' | 'staleCount' | 'freshCountFails' | 'freshCountHigher';
};

function charterBody(o: SetupOpts): WorkerCharterBody {
  return {
    schema: 'hh.worker.charter.v1', workerActor: W, host: 'LITTLENEMO', originators: ['luca-replit'], kinds: ['doc_inspect'],
    pathAllowlist: ['docs/**'], pathDenylist: [...WORKER_MINIMUM_DENYLIST], authProfiles: o.authProfiles ?? ['subscription'], models: ['sonnet'],
    qualifiedHarnesses: o.qualified === false ? [] : (['claude-cli', 'claude-cli-nofiletools'] as const).flatMap((a) => (['subscription', 'api'] as const).map((p) => (
      { adapter: a, executableSha256: EXE_SHA, version: '2.1.289', configDigest: configDigest(a, p), qualificationRef: 'test' }))),
    limits: { maxJobsPerWindow: 5, maxRuntimeSec: 600, maxApiBudgetUsdPerJob: 1, pollIntervalSec: 300, ...o.charterOver },
    window: { notBefore: '2026-10-08T00:00:00.000Z', notAfter: '2026-10-09T00:00:00.000Z' },
  };
}

const goodValidate: HostPort['validate'] = () => ({
  ok: true, answer: { summary: 's', findings: [], citations: [] },
  citations: [{ path: 'docs/a.md', startLine: 1, endLine: 1, excerpt: 'x', excerptSha256: 'f'.repeat(64) }], costTelemetryUsd: 0.01,
});

function setup(opts: SetupOpts = {}) {
  const fake = new FakeLedger();
  const createdAt = new Map<string, string>();
  const body = charterBody(opts);
  const charter: CharterRecord = { id: CHARTER_ID, version: 1, body, bodyDigest: charterBodyDigest(body), approvalState: 'approved', approvedAt: '2026-10-08T01:00:00.000Z' };
  const ids: string[] = [];
  for (let i = 1; i <= (opts.threads ?? 1); i += 1) {
    const T = tid(i);
    ids.push(T);
    fake.createThread(T, 'luca-replit', W);
    fake.events.push({ threadId: T, sequence: 1, actor: 'luca-replit', eventType: 'created', idempotencyKey: `test-created-${i}`, evidence: [], content: 'job',
      payload: { schema: 'hh.worker.job.v1', kind: 'doc_inspect', repository: 'davidwmcintosh/HolaHola', commit: COMMIT, paths: ['docs/*.md'],
        question: 'What is it?', resultSchemaId: 'answer-with-citations.v1', authProfile: 'subscription', model: 'sonnet',
        limits: { maxRuntimeSec: 600 }, charterId: CHARTER_ID, charterVersion: 1, deadline: '2026-10-08T08:00:00.000Z', ...opts.jobOver } });
    createdAt.set(T, '2026-10-08T02:00:00.000Z');
  }
  const appends: string[] = [];
  const hooks = {
    onSleep: (_n: number) => undefined as void,
    /** Return a replacement result to intercept an append (after optionally mutating the fake). */
    onAppend: (_t: string, _et: string, _in: { idempotencyKey: string; expectedSequence: number }) => undefined as ReturnType<LedgerPort['append']> | undefined,
    showFails: false,
    charterStalls: false,
    /** Thread reads omit content, evidence and recipient (an incomplete server response). */
    stripRead: false,
  };

  const view = (id: string): ThreadView => {
    const t = fake.threads.get(id)!;
    return {
      thread: { id, state: t.state, originActor: t.originActor, intendedRecipient: t.intendedRecipient, currentOwner: t.currentOwner, latestSequence: t.latestSequence, sourceReference: null },
      events: fake.events.filter((e) => e.threadId === id).map((e) => ({ ...e, createdAt: e.eventType === 'created' ? createdAt.get(id)! : '2026-10-08T03:00:00.000Z',
        ...(hooks.stripRead && e.eventType !== 'created' ? { content: undefined, evidence: undefined, recipientActor: undefined } : {}) })),
    };
  };
  let listCalls = 0;
  const ledger: LedgerPort = {
    async getCharter() { return hooks.charterStalls ? new Promise(() => undefined) : { ok: true, value: charter }; },
    async listJobs({ after, limit }) {
      listCalls += 1;
      const accepted = fake.events.filter((e) => e.eventType === 'accepted' && (e.payload as { charterId?: string }).charterId === CHARTER_ID).length;
      const all = [...fake.threads.keys()].map((id, i) => ({ threadId: id, createdGlobalSequence: 100 + i })).filter((j) => j.createdGlobalSequence > after);
      const mode = opts.pageMode ?? 'normal';
      if (mode === 'freshCountFails' && limit === 1) return { ok: false, error: 'timeout' };
      // Another instance's acceptance lands between discovery and this claim: only the fresh read sees it.
      if (mode === 'freshCountHigher' && limit === 1) return { ok: true, value: { jobs: [], nextAfter: after, complete: true, acceptedInWindow: accepted + 1 } };
      if (mode === 'incompleteThenFail' && limit === 50) {
        if (after === 0) return { ok: true, value: { jobs: all.slice(0, 1), nextAfter: 100, complete: false, acceptedInWindow: accepted } };
        return { ok: false, error: 'http_5xx' };
      }
      return { ok: true, value: { jobs: all, nextAfter: all.at(-1)?.createdGlobalSequence ?? after, complete: true, acceptedInWindow: mode === 'staleCount' ? 0 : accepted } };
    },
    async showThread(id) {
      if (hooks.showFails) return { ok: false, error: 'timeout' };
      const r = fake.read(id, W);
      return r.ok ? { ok: true, value: view(id) } : { ok: false, error: 'not_participant' };
    },
    async append(threadId, eventType, input) {
      appends.push(eventType);
      const intercepted = hooks.onAppend(threadId, eventType, input);
      if (intercepted) return intercepted;
      return fake.append({ threadId, actor: W, eventType, idempotencyKey: input.idempotencyKey, expectedSequence: input.expectedSequence, payload: input.payload, evidence: input.evidence, recipientActor: input.recipientActor, content: input.content });
    },
  };

  let now = T0;
  const staged: string[] = [];
  const removed: string[] = [];
  let sleeps = 0;
  let launches = 0;
  let listCallsHost = 0;
  const launchCfgs: { exe: string; args: string[]; cwd: string; env: Record<string, string> }[] = [];
  let exitNow: (v: LaunchExit) => void = () => undefined;
  const host: HostPort = {
    now: () => now,
    // Fires on a later macrotask; an aborted (losing) timer never advances fake time.
    sleep: (ms, signal) => new Promise<void>((resolve) => setImmediate(() => {
      if (signal?.aborted) { resolve(); return; }
      now += ms; sleeps += 1; hooks.onSleep(sleeps); resolve();
    })),
    fetchOrigin: async () => true,
    commitExists: (c) => c === COMMIT,
    isAncestorOfOriginMain: (c) => c === COMMIT,
    lsTree: () => [{ mode: '100644', type: 'blob', size: opts.treeSize ?? 30, path: 'docs/a.md' }],
    resolveHarness: async () => ({ path: 'C:\\x\\claude.exe', version: '2.1.289', sha256: EXE_SHA }),
    stage: opts.stage ?? ((_c, files): StagedInput => { staged.push(...files.map((f) => f.path)); return { dir: 'C:\\hh-w\\test\\in', baseline: new Map([['docs/a.md', Buffer.from('x')]]) }; }),
    removeStaging: (d) => { removed.push(d); },
    verifyStaged: opts.verifyStaged ?? (() => ({ ok: true })),
    validate: opts.validate ?? goodValidate,
    launch: (cfg) => {
      if (opts.launchThrows) throw new Error('spawn EINVAL');
      launches += 1;
      launchCfgs.push(cfg);
      const mode = opts.launch ?? 'ok';
      let resolveExit!: (v: LaunchExit) => void;
      const exited = new Promise<LaunchExit>((r) => { resolveExit = r; });
      exitNow = (v) => resolveExit(v);
      if (mode === 'ok') resolveExit({ code: 0 });
      if (mode === 'exitNull') resolveExit({ code: null });
      if (mode === 'spawnFail') resolveExit({ code: null, spawnFailed: true });
      const h: LaunchHandle = {
        terminate: () => { if (mode !== 'unresponsive') resolveExit({ code: 80 }); return true; },
        killLauncher: () => { if (mode !== 'unresponsive') resolveExit({ code: null }); },
        exited,
        stdout: () => ({ text: opts.stdoutText ?? '{"looks":"valid"}', overflow: opts.stdoutOverflow === true }),
        listMembers: async () => {
          listCallsHost += 1;
          if (opts.members) return opts.members(listCallsHost);
          return { listOk: true, active: 2, processes: [
            { pid: 10, state: 'member', image: 'C:\\x\\claude.exe' },
            { pid: 11, state: 'member', image: 'C:\\Windows\\System32\\conhost.exe' },
          ] };
        },
      };
      return h;
    },
    env: () => ({ SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\L' }),
  };

  const outbox = new Map<string, unknown>();
  const launched = new Set<string>();
  const receipts: { threadId: string; kind: string; data: Record<string, unknown> }[] = [];
  const scan = new Map<string, number>();
  let locked = false;
  const state: StateStore = {
    instanceId: () => INSTANCE,
    acquireLock: () => (locked ? { ok: false, reason: 'held' } : ((locked = true), { ok: true })),
    releaseLock: () => { locked = false; return { released: true }; },
    outbox: () => [...outbox.values()].map((e) => JSON.parse(JSON.stringify(e))), // persistence round trip
    saveOutbox: (e) => { outbox.set(e.key, e); },
    receipt: (threadId, kind, data) => { receipts.push({ threadId, kind, data }); },
    launched: (k) => launched.has(k),
    markLaunched: (k) => { launched.add(k); },
    scanAfter: (c, v) => scan.get(`${c}:${v}`) ?? 0,
    saveScanAfter: (c, v, a) => { scan.set(`${c}:${v}`, a); },
  };
  const entries = () => [...outbox.values()] as OutboxEntry[];
  return {
    fake, ledger, host, state, appends, staged, removed, receipts, outbox, entries, hooks, scan, ids, T: ids[0],
    launches: () => launches, launchCfgs, listCalls: () => listCalls, listCallsHost: () => listCallsHost, exitNow: (v: LaunchExit) => exitNow(v), setLocked: (v: boolean) => { locked = v; },
    events: (type: string) => fake.events.filter((e) => e.eventType === type),
  };
}

const opts = (over: Record<string, unknown> = {}) => ({
  workerActor: W, charterId: CHARTER_ID, charterVersion: 1, planOnly: false, untilMs: T0 + 3_600_000, maxJobs: 1, adapter: 'claude-cli' as const, ...over,
});

/** Seeds an earlier run's acceptance of thread T by this instance; returns its claim key. */
function seedOldClaim(s: ReturnType<typeof setup>, T: string) {
  const seq = s.fake.threads.get(T)!.latestSequence;
  const key = claimKeyFor(INSTANCE, T, OLD_RUN, seq);
  const r = s.fake.append({ threadId: T, actor: W, eventType: 'accepted', idempotencyKey: key, expectedSequence: seq, content: 'Local Read-only Worker claim',
    payload: { instanceId: INSTANCE, runNonce: OLD_RUN, claimKey: key, charterId: CHARTER_ID, charterVersion: 1 } });
  assert.equal(r.ok, true);
  return key;
}

// --- baseline behaviour ----------------------------------------------------------

test('--plan-only performs no ledger writes, no staging and no launch', async () => {
  const s = setup();
  const r = await runSupervisor(opts({ planOnly: true }), s.ledger, s.host, s.state);
  assert.equal(r.mode, 'plan-only');
  assert.deepEqual(s.appends, []);
  assert.deepEqual(s.staged, []);
  assert.equal(r.decisions[0].decision, 'eligible(plan-only: not claimed)');
});

test('unqualified harness: ineligible before claim, no writes, no rejection comment, candidate stays discoverable', async () => {
  const s = setup({ qualified: false });
  const r = await runSupervisor(opts({ untilMs: T0 + 1 }), s.ledger, s.host, s.state);
  assert.match(r.decisions[0].decision, /unqualified_harness/);
  assert.deepEqual(s.appends, []);
  assert.equal(s.scan.get(`${CHARTER_ID}:1`), 99, 'scan position stops before the transient candidate (created seq 100)');
});

test('happy path (valid result control): fresh claim, staged run, completed with git evidence and exact content, staging removed', async () => {
  const s = setup();
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'completed' }]);
  assert.deepEqual(s.appends, ['accepted', 'completed']);
  const done = s.events('completed')[0];
  assert.equal((done.payload as { schema: string }).schema, 'hh.worker.result.v1');
  assert.equal((done.evidence as { type: string }[])[0].type, 'commit');
  assert.equal(done.content, 'Local Read-only Worker result');
  assert.deepEqual(s.staged, ['docs/a.md']);
  assert.equal(s.removed.length, 1);
  assert.ok(s.entries().every((e) => e.state === 'sent'));
  assert.equal(r.halted, null);
});

test('job-intrinsic rejection: one comment to the originator, idempotent across runs', async () => {
  const s = setup({ jobOver: { model: 'opus' } });
  await runSupervisor(opts({ untilMs: T0 + 1 }), s.ledger, s.host, s.state);
  await runSupervisor(opts({ untilMs: T0 + 1 }), s.ledger, s.host, s.state);
  assert.equal(s.events('comment').length, 1);
  assert.equal(s.events('accepted').length, 0);
});

test('lock held by another supervisor halts before any read or write', async () => {
  const s = setup();
  s.setLocked(true);
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.equal(r.halted, 'lock:held');
  assert.deepEqual(s.appends, []);
});

test('reassignment during a run: stop via job termination, NO ledger write, local receipt (R2)', async () => {
  const s = setup({ launch: 'hang' });
  s.hooks.onSleep = (n) => {
    if (n === 1) s.fake.append({ threadId: s.T, actor: 'luca-replit', eventType: 'reassigned', idempotencyKey: 'test-reassign', expectedSequence: s.fake.threads.get(s.T)!.latestSequence, recipientActor: 'alden' });
  };
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'authority_lost' }]);
  assert.deepEqual(s.appends, ['accepted'], 'no blocked/completed written after losing authority');
  assert.ok(s.receipts.some((x) => x.kind === 'authority_lost'));
  assert.equal(s.fake.threads.get(s.T)!.intendedRecipient, 'alden', 'new owner state untouched');
});

// --- F1: complete history and a fresh per-claim count --------------------------------

test('F1 maxJobsPerWindow=1 with two eligible jobs in one page: exactly one accepted and completed', async () => {
  const s = setup({ threads: 2, charterOver: { maxJobsPerWindow: 1 } });
  const r = await runSupervisor(opts({ maxJobs: 2, untilMs: T0 + 1000 }), s.ledger, s.host, s.state);
  assert.equal(s.events('accepted').length, 1);
  assert.equal(s.events('completed').length, 1);
  assert.ok(r.decisions.some((d) => d.threadId === s.ids[1] && d.decision === 'ineligible:limit_reached'));
});

test('F1 a stale server count still cannot exceed the limit: own acceptances this run are counted', async () => {
  const s = setup({ threads: 2, charterOver: { maxJobsPerWindow: 1 }, pageMode: 'staleCount' });
  await runSupervisor(opts({ maxJobs: 2, untilMs: T0 + 1000 }), s.ledger, s.host, s.state);
  assert.equal(s.events('accepted').length, 1);
});

test('F1 incomplete paging then a failed page: no claim at all, scan position not advanced', async () => {
  const s = setup({ threads: 2, pageMode: 'incompleteThenFail' });
  const r = await runSupervisor(opts({ maxJobs: 2, untilMs: T0 + 1 }), s.ledger, s.host, s.state);
  assert.equal(s.events('accepted').length, 0);
  assert.deepEqual(s.appends, []);
  assert.ok(r.decisions.some((d) => d.decision.startsWith('history_incomplete')));
  assert.equal(s.scan.has(`${CHARTER_ID}:1`), false);
});

test('F1 the count rises between discovery and the claim (another acceptance): the fresh read refuses the claim', async () => {
  const s = setup({ charterOver: { maxJobsPerWindow: 1 }, pageMode: 'freshCountHigher' });
  const r = await runSupervisor(opts({ untilMs: T0 + 1 }), s.ledger, s.host, s.state);
  assert.equal(s.events('accepted').length, 0);
  assert.ok(r.decisions.some((d) => d.decision === 'ineligible:limit_reached'));
});

test('F1 the fresh count immediately before a claim fails: never treated as zero, no claim', async () => {
  const s = setup({ pageMode: 'freshCountFails' });
  const r = await runSupervisor(opts({ untilMs: T0 + 1 }), s.ledger, s.host, s.state);
  assert.equal(s.events('accepted').length, 0);
  assert.ok(r.decisions.some((d) => d.decision === 'ineligible:history_incomplete'));
});

// --- F2: unsafe output never completes ------------------------------------------------

test('F2 a result containing a secret pattern is BLOCKED (schema_invalid), never completed', async () => {
  const s = setup({ validate: () => ({ ok: true, answer: { summary: 'token sk-ABCDEFGHIJKLMNOPQRSTUV', findings: [], citations: [] }, citations: [], costTelemetryUsd: 0 }) });
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.equal(s.events('completed').length, 0);
  const b = s.events('blocked');
  assert.equal(b.length, 1);
  assert.equal((b[0].payload as { failureClass: string }).failureClass, 'schema_invalid');
  assert.deepEqual(b[0].evidence, [], 'no completion evidence on the failure');
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'schema_invalid' }]);
});

test('F2 an oversize result is BLOCKED, never completed', async () => {
  const big = 'a '.repeat(40_000);
  const s = setup({ validate: () => ({ ok: true, answer: { summary: big, findings: [], citations: [] }, citations: [], costTelemetryUsd: 0 }) });
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.equal(s.events('completed').length, 0);
  assert.equal((s.events('blocked')[0].payload as { detail: string }).detail, 'payload_too_large');
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'schema_invalid' }]);
});

// --- F3: fencing on every attempt and exact frozen envelopes --------------------------

test('F3 sequence conflict, then a same-actor NEW claim: the old claim\'s terminal write is abandoned, not appended', async () => {
  const s = setup();
  let done = false;
  s.hooks.onAppend = (T, et, input) => {
    if (et !== 'completed' || done) return undefined;
    done = true;
    const seq = () => s.fake.threads.get(T)!.latestSequence;
    s.fake.append({ threadId: T, actor: 'luca-replit', eventType: 'reassigned', idempotencyKey: 'away', expectedSequence: seq(), recipientActor: 'alden' });
    s.fake.append({ threadId: T, actor: 'luca-replit', eventType: 'reassigned', idempotencyKey: 'back', expectedSequence: seq(), recipientActor: W });
    const k = claimKeyFor('77777777-7777-4777-8777-777777777777', T, OLD_RUN, seq());
    s.fake.append({ threadId: T, actor: W, eventType: 'accepted', idempotencyKey: k, expectedSequence: seq(), payload: { claimKey: k }, content: 'other claim' });
    return Promise.resolve(s.fake.append({ threadId: T, actor: W, eventType: 'completed', idempotencyKey: input.idempotencyKey, expectedSequence: input.expectedSequence, payload: {}, evidence: [{}] }));
  };
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.equal(s.events('completed').length, 0, 'the newer claim never receives the old claim\'s completion');
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'authority_lost' }]);
  assert.ok(s.receipts.some((x) => x.kind === 'authority_lost_on_send' && x.data.reason === 'fence_claim_superseded'));
  assert.equal(s.entries().find((e) => e.op === 'completed')!.state, 'abandoned_authority_lost');
});

test('F3 authority unknown at send time: no mutation, entry kept unresolved, run halts', async () => {
  const s = setup();
  s.hooks.onAppend = (_T, et) => { if (et === 'accepted') queueMicrotask(() => { /* run proceeds */ }); return undefined; };
  const validate = goodValidate;
  s.host.validate = (...a) => { s.hooks.showFails = true; return validate(...a); };
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.equal(s.events('completed').length, 0);
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'send_unresolved' }]);
  const e = s.entries().find((x) => x.op === 'completed')!;
  assert.equal(e.state, 'pending');
  assert.equal(r.halted, null, 'the run had already used its single job');
  s.hooks.showFails = false;
  // Next start replays the exact frozen bytes.
  const r2 = await runSupervisor(opts({ untilMs: T0 + 1 }), s.ledger, s.host, s.state);
  assert.equal(r2.halted, null);
  assert.equal(s.events('completed').length, 1);
  assert.equal(s.events('completed')[0].content, e.content);
});

test('F3 restart with a pending owner write whose thread was reassigned away: abandoned locally, nothing appended', async () => {
  const s = setup();
  const key = seedOldClaim(s, s.T);
  s.fake.append({ threadId: s.T, actor: 'luca-replit', eventType: 'reassigned', idempotencyKey: 'away', expectedSequence: s.fake.threads.get(s.T)!.latestSequence, recipientActor: 'alden' });
  const pending = freezeOutboxEntry({ key: writeKeyFor(INSTANCE, s.T, 'blocked', key), threadId: s.T, op: 'blocked', eventType: 'blocked',
    content: 'Local Read-only Worker stopped: timeout', recipientActor: null, claimKey: key, payload: { p: 1 }, evidence: [] });
  s.state.saveOutbox(pending);
  const r = await runSupervisor(opts({ untilMs: T0 + 1 }), s.ledger, s.host, s.state);
  assert.equal(r.halted, null);
  assert.equal(s.events('blocked').length, 0);
  assert.equal(s.entries().find((e) => e.key === pending.key)!.state, 'abandoned_authority_lost');
  assert.ok(s.receipts.some((x) => x.kind === 'authority_lost_on_send'));
});

test('F3 exact-envelope restart replay: the original content, payload and evidence bytes are sent, never a replacement', async () => {
  const s = setup();
  const key = seedOldClaim(s, s.T);
  const evidence = buildCompletionEvidence(COMMIT, [{ path: 'docs/a.md', startLine: 1, endLine: 1, excerpt: 'x', excerptSha256: 'f'.repeat(64) }]);
  const pending = freezeOutboxEntry({ key: writeKeyFor(INSTANCE, s.T, 'completed', key), threadId: s.T, op: 'completed', eventType: 'completed',
    content: 'Local Read-only Worker result — original bytes ✓', recipientActor: null, claimKey: key, payload: { original: true }, evidence });
  s.state.saveOutbox(pending);
  const r = await runSupervisor(opts({ untilMs: T0 + 1 }), s.ledger, s.host, s.state);
  assert.equal(r.halted, null);
  const done = s.events('completed');
  assert.equal(done.length, 1);
  assert.equal(done[0].content, pending.content);
  assert.deepEqual(done[0].payload, { original: true });
  assert.deepEqual(done[0].evidence, evidence);
  assert.equal(s.launches(), 0);
});

test('F3 a tampered or pre-v2 outbox entry halts before any claim', async () => {
  const s = setup();
  s.outbox.set('legacy', { key: 'lrw.x', eventType: 'completed', payload: {}, evidence: [], state: 'pending', attempts: 0 });
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.equal(r.halted, 'outbox_corrupt');
  assert.deepEqual(s.appends, []);
});

// --- F4: ambiguous claims and post-accept exceptions ----------------------------------

test('F4 committed-but-lost accept: same-key reconciliation launches exactly once', async () => {
  const s = setup();
  s.hooks.onAppend = (T, et, input) => {
    if (et !== 'accepted') return undefined;
    s.fake.append({ threadId: T, actor: W, eventType: 'accepted', idempotencyKey: input.idempotencyKey, expectedSequence: input.expectedSequence,
      payload: (input as { payload?: Record<string, unknown> }).payload, content: (input as { content?: string }).content });
    return Promise.resolve({ ok: false as const, errorCode: 'timeout' });
  };
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.equal(s.launches(), 1);
  assert.equal(s.events('accepted').length, 1);
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'completed' }]);
  assert.ok(r.decisions.some((d) => d.decision === 'claim:committed_reply_lost'));
});

test('F4 proven-absent accept: no launch, no acceptance, candidate stays discoverable', async () => {
  const s = setup();
  s.hooks.onAppend = (_T, et) => (et === 'accepted' ? Promise.resolve({ ok: false as const, errorCode: 'timeout' }) : undefined);
  const r = await runSupervisor(opts({ untilMs: T0 + 1 }), s.ledger, s.host, s.state);
  assert.equal(s.launches(), 0);
  assert.equal(s.events('accepted').length, 0);
  assert.ok(r.decisions.some((d) => d.decision === 'claim:proven_absent'));
  assert.equal(s.entries().find((e) => e.op === 'accept')!.state, 'not_applied');
  assert.equal(s.scan.get(`${CHARTER_ID}:1`), 99);
});

test('F4 accept key conflict (same key, different content): halt, no launch', async () => {
  const s = setup();
  s.hooks.onAppend = (T, et, input) => {
    if (et !== 'accepted') return undefined;
    s.fake.events.push({ threadId: T, sequence: 99, actor: W, eventType: 'accepted', idempotencyKey: input.idempotencyKey, payload: { claimKey: 'forged' }, evidence: [], content: 'x' });
    return Promise.resolve({ ok: false as const, errorCode: 'timeout' });
  };
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.equal(r.halted, 'claim_idempotency_conflict');
  assert.equal(s.launches(), 0);
});

test('F4 accept outcome unknowable (read also fails): claims blocked, run halts, no launch', async () => {
  const s = setup();
  s.hooks.onAppend = (_T, et) => {
    if (et !== 'accepted') return undefined;
    s.hooks.showFails = true;
    return Promise.resolve({ ok: false as const, errorCode: 'timeout' });
  };
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.equal(r.halted, 'claim_unresolved');
  assert.equal(s.launches(), 0);
  assert.equal(s.entries().find((e) => e.op === 'accept')!.state, 'send_ambiguous');
});

test('F4 a committed accept from an earlier run whose reply was lost: blocked as interrupted at restart, never launched', async () => {
  const s = setup();
  const key = seedOldClaim(s, s.T);
  s.state.saveOutbox(freezeOutboxEntry({ key, threadId: s.T, op: 'accept', eventType: 'accepted', content: 'Local Read-only Worker claim',
    recipientActor: null, claimKey: key, evidence: [], payload: { instanceId: INSTANCE, runNonce: OLD_RUN, claimKey: key, charterId: CHARTER_ID, charterVersion: 1 } }));
  const r = await runSupervisor(opts({ untilMs: T0 + 1 }), s.ledger, s.host, s.state);
  assert.equal(s.launches(), 0);
  const b = s.events('blocked');
  assert.equal(b.length, 1);
  assert.equal((b[0].payload as { failureClass: string }).failureClass, 'interrupted');
  assert.ok(r.outcomes.some((o) => o.outcome === 'recovered_interrupted'));
});

test('F4 staging exception after acceptance: fenced blocked failure, never an escaped exception', async () => {
  const s = setup({ stage: () => { throw new Error('git cat-file failed'); } });
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'harness_unavailable' }]);
  assert.equal((s.events('blocked')[0].payload as { stage: string }).stage, 'staging');
  const c = setup({ stage: () => { throw new Error('staging_reparse_point'); } });
  const rc = await runSupervisor(opts(), c.ledger, c.host, c.state);
  assert.deepEqual(rc.outcomes, [{ threadId: c.T, outcome: 'confinement_violation' }]);
});

test('F4 launch exception after acceptance: fenced blocked failure', async () => {
  const s = setup({ launchThrows: true });
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'harness_unavailable' }]);
  assert.equal((s.events('blocked')[0].payload as { stage: string }).stage, 'launch');
  assert.equal(s.events('completed').length, 0);
});

test('F4 an API-profile job with no designated key fails BEFORE claim', async () => {
  const s = setup({ authProfiles: ['subscription', 'api'], jobOver: { authProfile: 'api', limits: { maxRuntimeSec: 600, maxApiBudgetUsd: 1 } } });
  const r = await runSupervisor(opts({ untilMs: T0 + 1 }), s.ledger, s.host, s.state);
  assert.equal(s.events('accepted').length, 0);
  assert.ok(r.decisions.some((d) => d.decision === 'ineligible:api_key_not_configured'));
});

// --- F5: independent deadlines, bounded fallback, uncertain exits ----------------------

test('F5 remote reads that stall across the local deadline: the run still stops on its own timer (timeout)', async () => {
  // 30 s runtime: the local deadline falls before the 15 s + 30 s unconfirmed-authority bound.
  const s = setup({ launch: 'hang', jobOver: { limits: { maxRuntimeSec: 30 } } });
  s.hooks.onAppend = (_T, et) => { if (et === 'accepted') s.hooks.charterStalls = true; return undefined; };
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'timeout' }]);
  assert.equal((s.events('blocked')[0].payload as { failureClass: string }).failureClass, 'timeout');
  assert.ok(s.listCallsHost() >= 13, `monitoring continued while the read stalled (LIST calls ${s.listCallsHost()})`);
});

// --- Review 58d3fcaf item 1.1: monitoring is independent of in-flight remote reads -------------

test('R5 a stalled remote read coexists with a later unexpected image: the image stop happens on the 2 s cadence', async () => {
  // The first remote read starts at 15 s and never settles; the unexpected image appears on LIST call 10 (20 s).
  const s = setup({ launch: 'hang', members: (n) => ({ listOk: true, active: 2, processes: [
    { pid: 10, state: 'member', image: 'C:\\x\\claude.exe' },
    ...(n >= 10 ? [{ pid: 12, state: 'member' as const, image: 'C:\\Windows\\System32\\cmd.exe' }] : []),
  ] }) });
  s.hooks.onAppend = (_T, et) => { if (et === 'accepted') s.hooks.charterStalls = true; return undefined; };
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'confinement_violation' }]);
  assert.equal(s.listCallsHost(), 10, 'stopped at the first LIST that saw the image, not after the stalled read');
});

test('R5 a remote read pending for 30 s is unconfirmed authority: authority_unknown (owner write deferred); monitoring ran throughout', async () => {
  const s = setup({ launch: 'hang' });
  s.hooks.onAppend = (_T, et) => { if (et === 'accepted') s.hooks.charterStalls = true; return undefined; };
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'authority_unknown' }]);
  assert.equal(s.events('blocked').length, 0);
  assert.ok(s.receipts.some((x) => x.kind === 'remote_read_unconfirmed'));
  assert.ok(s.listCallsHost() >= 21, `LIST calls continued during the pending read (${s.listCallsHost()})`);
});

test('R5 only one remote read pair is ever in flight (serialized, no overlapping or stale authority results)', async () => {
  const s = setup({ launch: 'hang', jobOver: { limits: { maxRuntimeSec: 120 } } });
  let inFlight = 0; let maxInFlight = 0; let calls = 0;
  const orig = s.ledger.showThread.bind(s.ledger);
  s.ledger.showThread = async (id) => {
    calls += 1; inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
    try { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); return await orig(id); } finally { inFlight -= 1; }
  };
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'timeout' }]);
  assert.equal(maxInFlight, 1);
  assert.ok(calls >= 5);
});

test('F5 an exit that never settles after TERMINATE and the launcher kill: bounded, termination_unverified, staging preserved, no ledger write', async () => {
  const s = setup({ launch: 'unresponsive' });
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'termination_unverified' }]);
  assert.equal(r.halted, 'termination_unverified');
  assert.deepEqual(s.appends, ['accepted']);
  assert.deepEqual(s.removed, [], 'staging is preserved when termination is uncertain');
  assert.ok(s.receipts.some((x) => x.kind === 'staging_preserved'));
});

test('F5 valid-looking stdout with an unexpected/uncertain launcher exit never completes', async () => {
  const s = setup({ launch: 'exitNull' });
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.equal(s.events('completed').length, 0);
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'termination_unverified' }]);
  assert.equal(r.halted, 'termination_unverified');
});

test('F5 launcher spawn failure: harness_unavailable, no completion', async () => {
  const s = setup({ launch: 'spawnFail' });
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'harness_unavailable' }]);
  assert.equal(s.events('completed').length, 0);
});

test('F5 retained stdout overflow is never validated as a complete result', async () => {
  const s = setup({ stdoutOverflow: true });
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'schema_invalid' }]);
  assert.equal(s.events('completed').length, 0);
});

// --- F7: staged bytes must still be the pinned blobs --------------------------------

test('F7 a staged tree that no longer matches the pinned blobs is confinement_violation, never completed', async () => {
  const s = setup({ verifyStaged: () => ({ ok: false, detail: 'staged_file_changed' }) });
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'confinement_violation' }]);
  assert.equal(s.events('completed').length, 0);
});

// --- Review d3ac7b68 item 1: §5.6 process-image monitoring ---------------------------------

const blockedDetail = (s: ReturnType<typeof setup>) => s.events('blocked').map((e) => (e.payload as { failureClass: string; detail: string }));

test('R1 an unexpected job-member image stops the run through job termination: confinement_violation, never completed', async () => {
  const s = setup({ launch: 'hang', members: () => ({ listOk: true, active: 2, processes: [
    { pid: 10, state: 'member', image: 'C:\\x\\claude.exe' },
    { pid: 12, state: 'member', image: 'C:\\Windows\\System32\\cmd.exe' },
  ] }) });
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'confinement_violation' }]);
  assert.deepEqual(blockedDetail(s).map((p) => [p.failureClass, p.detail]), [['confinement_violation', 'unexpected_image']]);
  assert.ok(s.receipts.some((x) => x.kind === 'monitor_violation' && (x.data.images as string[]).includes('C:\\Windows\\System32\\cmd.exe')));
  assert.equal(s.events('completed').length, 0);
  assert.equal(s.listCallsHost(), 1, 'stopped at the first 2 s monitoring tick');
});

test('R1 monitoring unknown (no reply, failed job query, unreadable member) stops safely', async () => {
  for (const members of [
    () => null,
    () => ({ listOk: false, active: 1, processes: [] }),
    () => ({ listOk: true, active: 1, processes: [{ pid: 10, state: 'unknown' as const }] }),
  ]) {
    const s = setup({ launch: 'hang', members });
    const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
    assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'confinement_violation' }]);
    assert.deepEqual(blockedDetail(s).map((p) => p.detail), ['monitoring_unknown']);
    assert.ok(s.receipts.some((x) => x.kind === 'monitor_unknown'));
  }
});

test('R1 a member that exited between list and open ("gone") is ignored; allowed images keep running until the local deadline', async () => {
  const s = setup({ launch: 'hang', members: () => ({ listOk: true, active: 1, processes: [
    { pid: 10, state: 'member', image: 'c:\\X\\CLAUDE.EXE' }, { pid: 13, state: 'gone' },
  ] }) });
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'timeout' }]);
  // 600 s run at a 2 s monitoring interval: one LIST per tick, independent of the 15 s remote reads.
  assert.ok(s.listCallsHost() >= 295 && s.listCallsHost() <= 300, `LIST calls ${s.listCallsHost()}`);
});

test('R1 an exit that races a LIST with no reply is a normal end, not a monitoring failure', async () => {
  const s = setup({ launch: 'hang', members: () => { setImmediate(() => s.exitNow({ code: 0 })); return null; } });
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'completed' }]);
});

// --- Review item 2: authority_unknown is recovered as authority_unknown ---------------------

function unknownAuthorityRun(s: ReturnType<typeof setup>) {
  s.hooks.onAppend = (_T, et) => { if (et === 'accepted') setImmediate(() => { s.hooks.showFails = true; }); return undefined; };
  return runSupervisor(opts(), s.ledger, s.host, s.state);
}

test('R2 after an authority_unknown stop, re-confirmed authority writes blocked authority_unknown (not interrupted)', async () => {
  const s = setup({ launch: 'hang' });
  const r1 = await unknownAuthorityRun(s);
  assert.deepEqual(r1.outcomes, [{ threadId: s.T, outcome: 'authority_unknown' }]);
  assert.equal(s.events('blocked').length, 0, 'nothing written while authority is unknown');
  assert.equal(s.entries().find((e) => e.op === 'blocked')!.state, 'awaiting_authority');
  s.hooks.showFails = false;
  s.hooks.onAppend = () => undefined;
  const r2 = await runSupervisor(opts({ untilMs: s.host.now() + 1 }), s.ledger, s.host, s.state);
  assert.equal(r2.halted, null);
  assert.deepEqual(blockedDetail(s).map((p) => p.failureClass), ['authority_unknown']);
  assert.ok(r2.outcomes.some((o) => o.outcome === 'recovered_authority_unknown'));
  assert.equal(r2.outcomes.some((o) => o.outcome === 'recovered_interrupted'), false);
});

test('R2 if a same-actor superseding claim exists by then, the frozen authority_unknown write is abandoned, never appended', async () => {
  const s = setup({ launch: 'hang' });
  await unknownAuthorityRun(s);
  s.hooks.showFails = false;
  s.hooks.onAppend = () => undefined;
  const seq = () => s.fake.threads.get(s.T)!.latestSequence;
  s.fake.append({ threadId: s.T, actor: 'luca-replit', eventType: 'reassigned', idempotencyKey: 'away', expectedSequence: seq(), recipientActor: 'alden' });
  s.fake.append({ threadId: s.T, actor: 'luca-replit', eventType: 'reassigned', idempotencyKey: 'back', expectedSequence: seq(), recipientActor: W });
  const k = claimKeyFor('77777777-7777-4777-8777-777777777777', s.T, OLD_RUN, seq());
  s.fake.append({ threadId: s.T, actor: W, eventType: 'accepted', idempotencyKey: k, expectedSequence: seq(), payload: { claimKey: k }, content: 'other claim' });
  const r2 = await runSupervisor(opts({ untilMs: s.host.now() + 1 }), s.ledger, s.host, s.state);
  assert.equal(s.events('blocked').length, 0);
  assert.equal(s.entries().find((e) => e.op === 'blocked')!.state, 'abandoned_authority_lost');
  assert.ok(r2.outcomes.some((o) => o.outcome === 'authority_unknown_authority_lost'));
});

test('R2 while authority stays unknown, the frozen authority_unknown write keeps waiting (not sent, not abandoned)', async () => {
  const s = setup({ launch: 'hang', threads: 2 });
  await unknownAuthorityRun(s);
  assert.equal(s.entries().find((e) => e.op === 'blocked')!.state, 'awaiting_authority');
});

// --- Review item 3: no synthesized equality from omitted response fields --------------------

test('R3 an append response omitting content/evidence/recipient is read back; a matching committed event is sent', async () => {
  const s = setup();
  s.hooks.onAppend = (T, et, input) => {
    const full = s.fake.append({ threadId: T, actor: W, eventType: et, idempotencyKey: input.idempotencyKey, expectedSequence: input.expectedSequence,
      payload: (input as { payload?: Record<string, unknown> }).payload, evidence: (input as { evidence?: unknown[] }).evidence, content: (input as { content?: string }).content });
    return Promise.resolve(full.ok ? { ok: true as const, deduplicated: false, event: { eventType: full.event.eventType, payload: full.event.payload } } : full);
  };
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'completed' }]);
  assert.ok(r.decisions.some((d) => d.decision === 'claim:response_incomplete'));
  assert.ok(s.entries().every((e) => e.state === 'sent'));
});

test('R3 an incomplete response whose read-back shows different content is a conflict, never sent', async () => {
  const s = setup();
  s.hooks.onAppend = (T, et, input) => {
    if (et !== 'completed') return undefined;
    s.fake.append({ threadId: T, actor: W, eventType: et, idempotencyKey: input.idempotencyKey, expectedSequence: input.expectedSequence,
      payload: (input as { payload?: Record<string, unknown> }).payload, evidence: (input as { evidence?: unknown[] }).evidence, content: 'DIFFERENT CONTENT' });
    return Promise.resolve({ ok: true as const, deduplicated: false, event: { eventType: 'completed', payload: (input as { payload?: Record<string, unknown> }).payload } });
  };
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.equal(r.halted, 'idempotency_conflict');
  assert.equal(s.entries().find((e) => e.op === 'completed')!.state, 'idempotency_conflict');
});

test('R3 an incomplete response with an incomplete read-back stays unresolved (claims blocked), never sent', async () => {
  const s = setup();
  s.hooks.onAppend = (T, et, input) => {
    if (et !== 'completed') return undefined;
    s.hooks.stripRead = true;
    const full = s.fake.append({ threadId: T, actor: W, eventType: et, idempotencyKey: input.idempotencyKey, expectedSequence: input.expectedSequence,
      payload: (input as { payload?: Record<string, unknown> }).payload, evidence: (input as { evidence?: unknown[] }).evidence, content: (input as { content?: string }).content });
    return Promise.resolve(full.ok ? { ok: true as const, deduplicated: false, event: { eventType: 'completed', payload: full.event.payload } } : full);
  };
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'send_unresolved' }]);
  assert.equal(s.entries().find((e) => e.op === 'completed')!.state, 'send_ambiguous');
});

test('R3 restart reconciliation never accepts an omitted field as a match; a mismatched recipient is a conflict', async () => {
  const s = setup();
  const key = seedOldClaim(s, s.T);
  const pending = freezeOutboxEntry({ key: writeKeyFor(INSTANCE, s.T, 'blocked', key), threadId: s.T, op: 'blocked', eventType: 'blocked',
    content: 'Local Read-only Worker stopped: timeout', recipientActor: null, claimKey: key, payload: { p: 1 }, evidence: [] });
  s.state.saveOutbox(pending);
  // The write was committed earlier, but reads omit content/evidence/recipient.
  s.fake.append({ threadId: s.T, actor: W, eventType: 'blocked', idempotencyKey: pending.key, expectedSequence: s.fake.threads.get(s.T)!.latestSequence, payload: { p: 1 }, evidence: [], content: pending.content });
  s.hooks.stripRead = true;
  const r = await runSupervisor(opts({ untilMs: T0 + 1 }), s.ledger, s.host, s.state);
  assert.equal(r.halted, 'outbox_unresolved');
  s.hooks.stripRead = false;
  const r2 = await runSupervisor(opts({ untilMs: T0 + 1 }), s.ledger, s.host, s.state);
  assert.equal(r2.halted, null);
  assert.equal(s.entries().find((e) => e.key === pending.key)!.state, 'sent');

  // Recipient binding: the same key committed with another recipient is a conflict.
  const t = setup();
  const k2 = seedOldClaim(t, t.T);
  const p2 = freezeOutboxEntry({ key: writeKeyFor(INSTANCE, t.T, 'blocked', k2), threadId: t.T, op: 'blocked', eventType: 'blocked',
    content: 'c', recipientActor: null, claimKey: k2, payload: { p: 1 }, evidence: [] });
  t.state.saveOutbox(p2);
  t.fake.append({ threadId: t.T, actor: W, eventType: 'blocked', idempotencyKey: p2.key, expectedSequence: t.fake.threads.get(t.T)!.latestSequence, payload: { p: 1 }, evidence: [], content: 'c', recipientActor: 'alden' });
  const r3 = await runSupervisor(opts({ untilMs: T0 + 1 }), t.ledger, t.host, t.state);
  assert.equal(r3.halted, 'idempotency_conflict');
});

// --- Review item 4: null output and validation exceptions -------------------------------

test('R4 actual stdout JSON null through the real validator: blocked schema_invalid, no escaped exception, no completion', async () => {
  const s = setup({ stdoutText: 'null', validate: validateHarnessOutput });
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'schema_invalid' }]);
  assert.deepEqual(blockedDetail(s).map((p) => p.detail), ['output_not_object']);
  assert.equal(s.events('completed').length, 0);
});

test('R4 a throwing validation port becomes a fenced blocked failure, never an escaped exception', async () => {
  const s = setup({ validate: () => { throw new TypeError('boom'); } });
  const r = await runSupervisor(opts(), s.ledger, s.host, s.state);
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'schema_invalid' }]);
  assert.deepEqual(blockedDetail(s).map((p) => p.detail), ['validation_exception']);
  assert.equal(s.events('completed').length, 0);
  const t = setup({ verifyStaged: () => { throw new Error('io'); } });
  const r2 = await runSupervisor(opts(), t.ledger, t.host, t.state);
  assert.deepEqual(r2.outcomes, [{ threadId: t.T, outcome: 'schema_invalid' }]);
});

// --- Review 610d057b F-B: execute-to-prompt wiring for claude-cli-nofiletools ---------------------

test('F-B the no-file-tools adapter launches with --tools "" and a prompt embedding ONLY the staged baseline bytes', async () => {
  const s = setup({ stage: () => ({ dir: 'C:\\hh-w\\nf\\in', baseline: new Map([['docs/a.md', Buffer.from('approved line one\napproved line two\n')]]) }) });
  const r = await runSupervisor(opts({ adapter: 'claude-cli-nofiletools' }), s.ledger, s.host, s.state);
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'completed' }]);
  assert.equal(s.launchCfgs.length, 1);
  const args = s.launchCfgs[0].args;
  assert.equal(args[args.indexOf('--tools') + 1], '');
  const prompt = args[args.indexOf('-p') + 1];
  assert.ok(prompt.includes('APPROVED EXCERPTS (the only content you may use):\n--- docs/a.md ---\napproved line one\napproved line two\n'));
  assert.ok(s.receipts.some((x) => x.kind === 'nofiletools_excerpts' && (x.data.files as { path: string }[])[0].path === 'docs/a.md'));
});

test('F-B the file-tools adapter never embeds staged content in its prompt', async () => {
  const s = setup({ stage: () => ({ dir: 'C:\\hh-w\\ft\\in', baseline: new Map([['docs/a.md', Buffer.from('secret-looking-but-staged\n')]]) }) });
  await runSupervisor(opts(), s.ledger, s.host, s.state);
  const prompt = s.launchCfgs[0].args[s.launchCfgs[0].args.indexOf('-p') + 1];
  assert.equal(prompt.includes('APPROVED EXCERPTS'), false);
  assert.equal(prompt.includes('secret-looking-but-staged'), false);
});

test('F-B an over-bound selection is a deterministic job-intrinsic refusal BEFORE claim (no truncation, no launch)', async () => {
  const s = setup({ treeSize: 20_001 });
  const r = await runSupervisor(opts({ adapter: 'claude-cli-nofiletools', untilMs: T0 + 1 }), s.ledger, s.host, s.state);
  assert.equal(s.events('accepted').length, 0);
  assert.equal(s.launches(), 0);
  assert.ok(r.decisions.some((d) => d.decision === 'ineligible:path_file_exceeds_nofiletools_bound'));
  const c = s.events('comment');
  assert.equal(c.length, 1);
  assert.equal((c[0].payload as { reasonCode: string }).reasonCode, 'path_file_exceeds_nofiletools_bound');
});

test('F-B non-UTF-8 or missing staged input after claim is a fenced blocked failure, never a launch', async () => {
  const s = setup({ stage: () => ({ dir: 'C:\\hh-w\\nf2\\in', baseline: new Map([['docs/a.md', Buffer.from([0xff, 0xfe, 0x00])]]) }) });
  const r = await runSupervisor(opts({ adapter: 'claude-cli-nofiletools' }), s.ledger, s.host, s.state);
  assert.deepEqual(r.outcomes, [{ threadId: s.T, outcome: 'harness_unavailable' }]);
  assert.equal(s.launches(), 0);
  assert.equal((s.events('blocked')[0].payload as { detail: string }).detail, 'nofiletools_input_not_utf8');
  const m = setup({ stage: () => ({ dir: 'C:\\hh-w\\nf3\\in', baseline: new Map() }) });
  const rm = await runSupervisor(opts({ adapter: 'claude-cli-nofiletools' }), m.ledger, m.host, m.state);
  assert.deepEqual(rm.outcomes, [{ threadId: m.T, outcome: 'harness_unavailable' }]);
  assert.equal((m.events('blocked')[0].payload as { detail: string }).detail, 'nofiletools_input_missing');
});
