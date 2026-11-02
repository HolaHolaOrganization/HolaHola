// Codex recording adapter (native Codex onboarding design 4860f832, step 3):
// parsing a Codex session rollout shaped like the real runtime's (CLI
// 0.166.0-alpha.5.1), and shipping as source "codex" through the Antigravity
// shipper's fail-closed path. Synthetic data only.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { canonicalCodexTurnId, parseCodexRollout } from './lib/codex-rollout-shipper';
import { parseCodexShipperArgs, rolloutPathFromHookPayload, runCodexShipper } from './codex-rollout-shipper';

const SESSION = '01a199ec-4ea3-7063-a513-987ee3e4321e';
const line = (o: unknown) => JSON.stringify(o);
const meta = (turnId: string, provenance: string[], create_time = 1793583767.1) =>
  ({ turn_id: turnId, create_time, content_item_metadata: provenance.map((type) => ({ provenance: { type } })) });
const user = (turnId: string, text: string, provenance = ['user']) =>
  line({ timestamp: '2026-11-02T01:42:47.109Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }], internal_chat_message_metadata_passthrough: meta(turnId, provenance) } });
const developer = (turnId: string, text: string) =>
  line({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text }], internal_chat_message_metadata_passthrough: meta(turnId, ['developer_instructions']) } });
const assistant = (turnId: string, text: string, phase: 'final_answer' | 'commentary') =>
  line({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }], internal_chat_message_metadata_passthrough: { turn_id: turnId } } });
const started = (turnId: string) => line({ type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } });
const context = (turnId: string) => line({ type: 'turn_context', payload: { turn_id: turnId, model: 'gpt-6.1-sol' } });
const complete = (turnId: string, last: string | null) => line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, last_agent_message: last } });
const header = line({ type: 'session_meta', payload: { id: SESSION, cli_version: '0.166.0-alpha.5.1', originator: 'codex_work_desktop', model_provider: 'openai' } });

const T1 = '01a199ec-5d1c-7be0-8056-3146d577ae1f';
const T2 = '01a199ed-77df-70a2-8399-8ea98c10ccb1';
const T3 = '01a199ee-7f43-7f20-93df-ffd5f5023982';
const T4 = '01a199ef-0cc8-7443-a200-6d74dcccfed7';
const T5 = '01a199f3-57f9-70c1-8e3b-dfd577920bd3';

const rollout = [
  header,
  // T1: injected context, then David's words, a progress note, the final answer.
  started(T1), context(T1),
  developer(T1, 'harness instructions'), user(T1, '<environment_context>cwd</environment_context>', ['harness']),
  user(T1, 'hello codex'), assistant(T1, 'looking…', 'commentary'), assistant(T1, 'Hello David.', 'final_answer'), complete(T1, 'Hello David.'),
  // T2: two messages in one turn (steer), one answer.
  started(T2), context(T2), user(T2, 'first part'), user(T2, 'second part'), assistant(T2, 'Both parts read.', 'final_answer'), complete(T2, 'Both parts read.'),
  // T3: an automated turn with no user-provenance message: not dialogue.
  started(T3), context(T3), user(T3, 'automation text', ['harness']), assistant(T3, 'done', 'final_answer'), complete(T3, 'done'),
  // T4: interrupted, never completed, and not the last turn.
  started(T4), context(T4), user(T4, 'interrupted ask'), assistant(T4, 'partial', 'commentary'),
  // T5: the open trailing turn.
  started(T5), context(T5), user(T5, 'still thinking?'),
].join('\n') + '\n';

describe('parseCodexRollout', () => {
  test('only user-provenance messages are David, only final answers are the reply, and turns are keyed by Codex turn id', () => {
    const r = parseCodexRollout(rollout);
    assert.equal(r.runtime.sessionId, SESSION);
    assert.equal(r.runtime.modelProvider, 'openai');
    assert.equal(r.runtime.modelByTurn[T1], 'gpt-6.1-sol');
    assert.deepEqual(r.exchanges.map((e) => [e.stepIndex, e.turnId, e.userText, e.assistantText]), [
      [0, `codex-${T1}`, 'hello codex', 'Hello David.'],
      [1, `codex-${T2}`, 'first part\n\nsecond part', 'Both parts read.'],
    ]);
    assert.equal(r.exchanges[0].conversationId, SESSION);
    assert.equal(r.exchanges[0].createdAt, new Date(Math.round(1793583767.1 * 1000)).toISOString());
    assert.equal(r.skippedNonDialogueTurns, 1, 'the harness-only turn is not dialogue');
    assert.deepEqual(r.unresolvedTurns.map((u) => [u.turnId, u.reason]), [[`codex-${T4}`, 'turn never completed']]);
    assert.equal(r.openTrailingTurn?.turnId, `codex-${T5}`);
    assert.equal(r.openTrailingTurn?.userText, 'still thinking?');
  });

  test('a final answer that disagrees with task_complete, an aborted turn, or a missing answer is held, never shipped', () => {
    const mismatch = [header, started(T1), user(T1, 'q'), assistant(T1, 'A', 'final_answer'), complete(T1, 'B')].join('\n') + '\n';
    assert.deepEqual(parseCodexRollout(mismatch).unresolvedTurns.map((u) => u.reason), ['final answer differs from task_complete.last_agent_message']);
    const aborted = [header, started(T1), user(T1, 'q'), line({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: T1 } }), started(T2), user(T2, 'next')].join('\n') + '\n';
    assert.deepEqual(parseCodexRollout(aborted).unresolvedTurns.map((u) => u.reason), ['turn aborted before a final answer']);
    const empty = [header, started(T1), user(T1, 'q'), complete(T1, null)].join('\n') + '\n';
    assert.deepEqual(parseCodexRollout(empty).unresolvedTurns.map((u) => u.reason), ['turn completed with no final answer']);
    for (const r of [parseCodexRollout(mismatch), parseCodexRollout(aborted), parseCodexRollout(empty)]) assert.equal(r.exchanges.length, 0);
  });

  test('a partially written last line is set aside, a malformed complete line refuses, and a rollout needs its session id', () => {
    const partial = rollout + '{"type":"response_item","payload":{"type":"mess';
    const r = parseCodexRollout(partial);
    assert.equal(r.exchanges.length, 2);
    assert.ok(r.incompleteTrailingLine?.startsWith('{"type":"response_item"'));
    assert.throws(() => parseCodexRollout(rollout + 'not json\n'), /malformed complete line/);
    assert.throws(() => parseCodexRollout(user(T1, 'x') + '\n'), /no session_meta id/);
    assert.throws(() => canonicalCodexTurnId('bad id'), /not usable/);
  });
});

describe('codex shipper', () => {
  test('ships completed pairs as source codex with codex- turn ids, checkpoints them, and a rerun ships nothing new', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-shipper-'));
    const rolloutPath = join(dir, 'rollout.jsonl');
    writeFileSync(rolloutPath, rollout);
    const posted: any[] = [];
    const fetchImpl = (async (url: string, init: any) => {
      posted.push({ url, auth: init.headers['x-coordination-token'], body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }) as unknown as typeof fetch;
    const options = { ...parseCodexShipperArgs(['--rollout', rolloutPath, '--runtime-id', 'luca-codex-test', '--state-dir', join(dir, 'state')], {}), rolloutPath };
    const deps = { fetchImpl, accessToken: async () => 'codex-own-token' };
    const first = await runCodexShipper(options, deps);
    assert.equal(first.report.shipped, 2);
    assert.deepEqual(posted.map((p) => [p.body.source, p.body.turnId, p.auth]), [
      ['codex', `codex-${T1}`, 'codex-own-token'],
      ['codex', `codex-${T2}`, 'codex-own-token'],
    ]);
    assert.ok(posted.every((p) => p.url === 'https://getholahola.com/api/internal/canonical-conversation-exchange'));
    const second = await runCodexShipper(options, deps);
    assert.equal(second.report.shipped, 0);
    assert.equal(second.report.skipped, 2);
    assert.equal(posted.length, 2);
  });

  test('without a runtime id nothing is shipped (no default identity); dry-run needs none and posts nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-shipper-'));
    const rolloutPath = join(dir, 'rollout.jsonl');
    writeFileSync(rolloutPath, rollout);
    const fetchImpl = (async () => { throw new Error('must not post'); }) as unknown as typeof fetch;
    const noId = { ...parseCodexShipperArgs(['--rollout', rolloutPath, '--state-dir', join(dir, 's1')], {}), rolloutPath };
    await assert.rejects(runCodexShipper(noId, { fetchImpl }), /no default luca-codex runtime/);
    const dry = { ...parseCodexShipperArgs(['--rollout', rolloutPath, '--state-dir', join(dir, 's2'), '--dry-run'], {}), rolloutPath };
    const { report } = await runCodexShipper(dry, { fetchImpl });
    assert.equal(report.simulated, 2);
    assert.equal(report.shipped, 0);
  });

  test('arguments: exactly one of --rollout or --hook; the hook payload names the rollout', () => {
    assert.throws(() => parseCodexShipperArgs([], {}), /Exactly one/);
    assert.throws(() => parseCodexShipperArgs(['--hook', '--rollout', 'x'], {}), /Exactly one/);
    assert.throws(() => parseCodexShipperArgs(['--hook', '--hook'], {}), /repeated/);
    assert.equal(parseCodexShipperArgs(['--hook'], { CODEX_HOME: 'C:/codexhome' }).stateBaseDir.replace(/\\/g, '/').endsWith('codexhome/holahola-shipper'), true);
    assert.equal(rolloutPathFromHookPayload(JSON.stringify({ hook_event_name: 'Stop', transcript_path: 'C:/x/rollout.jsonl' })), 'C:/x/rollout.jsonl');
    assert.throws(() => rolloutPathFromHookPayload('{}'), /no transcript_path/);
  });
});
