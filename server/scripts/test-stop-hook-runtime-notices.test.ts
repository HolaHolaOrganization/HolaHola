/** The Stop hook never records runtime-injected entries as David (.claude/hooks/runtime-entries.mjs). */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyUserEntry } from '../../.claude/hooks/runtime-entries.mjs';

const HOOK = fileURLToPath(new URL('../../.claude/hooks/record-stop-turn.mjs', import.meta.url));
const NOTICE = '<task-notification>\n<task-id>b9</task-id>\n</task-notification>';

describe('classifyUserEntry: only provenance fields decide, never the text', () => {
  test('origin "human" is the founder; any other origin is the runtime', () => {
    assert.deepEqual(classifyUserEntry({ origin: { kind: 'human' }, promptSource: 'sdk' }), { founder: true, basis: 'origin:human' });
    assert.deepEqual(classifyUserEntry({ origin: { kind: 'task-notification' }, promptSource: 'system' }), { founder: false, basis: 'origin:task-notification' });
  });
  test('isMeta and isCompactSummary are runtime material, whatever the origin says', () => {
    assert.deepEqual(classifyUserEntry({ isMeta: true }), { founder: false, basis: 'isMeta' });
    assert.deepEqual(classifyUserEntry({ isMeta: true, origin: { kind: 'human' } }), { founder: false, basis: 'isMeta' });
    assert.deepEqual(classifyUserEntry({ isCompactSummary: true, turnOrigin: 'human' }), { founder: false, basis: 'isCompactSummary' });
  });
  test('partial metadata: turnOrigin, then promptSource, decide', () => {
    assert.deepEqual(classifyUserEntry({ turnOrigin: 'human' }), { founder: true, basis: 'turnOrigin:human' });
    assert.deepEqual(classifyUserEntry({ turnOrigin: 'task_notification' }), { founder: false, basis: 'turnOrigin:task_notification' });
    assert.deepEqual(classifyUserEntry({ promptSource: 'sdk' }), { founder: true, basis: 'promptSource:sdk' });
    assert.deepEqual(classifyUserEntry({ promptSource: 'system' }), { founder: false, basis: 'promptSource:system' });
  });
  test('no provenance fields keeps the original rule (founder), and says so', () => {
    assert.deepEqual(classifyUserEntry({ type: 'user' }), { founder: true, basis: 'no provenance fields (legacy rule)' });
  });
});

/** Run the real hook on a synthetic transcript; the remote is a dead local port, never production. */
function runHook(entries: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), 'stop-hook-runtime-'));
  const transcript = join(dir, 'transcript.jsonl');
  writeFileSync(transcript, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ transcript_path: transcript, session_id: '11111111-1111-4111-8111-111111111111' }),
    env: { ...process.env, HOLAHOLA_STOP_HOOK_URL: 'http://127.0.0.1:9' },
    encoding: 'utf8', timeout: 60_000,
  });
}
const human = (content: unknown) => ({ type: 'user', origin: { kind: 'human' }, promptSource: 'sdk', message: { content } });
const meta = (text: string) => ({ type: 'user', isMeta: true, message: { content: [{ type: 'text', text }] } });
const assistant = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const RECORDED = /record-exchange failed/; // reached record-exchange (which then fails on the dead port)
const SKIPPED = /started by the runtime \(.+\), not by David; nothing recorded/;

describe('the Stop hook', () => {
  test('a turn started by a task notice records nothing and never invokes record-exchange', () => {
    const notice = { type: 'user', origin: { kind: 'task-notification' }, promptSource: 'system', message: { content: NOTICE } };
    const r = runHook([human('please check the deploy'), assistant('Checking now.'), notice, assistant('The deploy finished.')]);
    assert.equal(r.status, 0);
    assert.match(r.stderr, SKIPPED);
    assert.doesNotMatch(r.stderr, RECORDED);
  });

  test('founder text that looks like a notice is recorded: with origin human, with partial metadata, and with none', () => {
    for (const entry of [
      human(NOTICE),
      { type: 'user', promptSource: 'sdk', message: { content: NOTICE } },
      { type: 'user', message: { content: NOTICE } },
    ]) {
      const r = runHook([entry, assistant('That is a background-task notice.')]);
      assert.doesNotMatch(r.stderr, SKIPPED);
      assert.match(r.stderr, RECORDED);
    }
  });

  test("image metadata before any reply belongs to the founder's message, which is recorded", () => {
    const r = runHook([
      human([{ type: 'image' }, { type: 'text', text: 'these are the only modes available' }]),
      meta('[Image: source: C:\\Users\\David\\one.png]'), meta('[Image: source: C:\\Users\\David\\two.png]'),
      assistant('Thanks, I see the three modes.'),
    ]);
    assert.doesNotMatch(r.stderr, SKIPPED);
    assert.match(r.stderr, RECORDED);
  });

  test('metadata after reply text has started is never folded back into an already-replied founder turn', () => {
    // Stop 1 could already have recorded (human, "I would like that."). Re-selecting the human entry here
    // would resend that turn id with a longer reply, so the metadata entry stays the start and nothing is sent.
    const r = runHook([
      human('I would encourage you to talk with daniela'), assistant('I would like that.'),
      meta('Your response above was stopped by a safety classifier.'), assistant('Continuing.'),
    ]);
    assert.match(r.stderr, /started by the runtime \(isMeta\)/);
    assert.doesNotMatch(r.stderr, RECORDED);
  });

  test('the compaction summary is excluded by its field; a founder quoting that sentence is kept', () => {
    const SUMMARY = 'This session is being continued from a previous conversation that ran out of context.';
    const summary = { type: 'user', isCompactSummary: true, turnOrigin: 'human', message: { content: SUMMARY } };
    // The summary never starts a turn: the founder message before it is the turn.
    let r = runHook([human('please check the deploy'), summary, assistant('Checking now.')]);
    assert.match(r.stderr, RECORDED);
    // A founder message that quotes the sentence (origin human) is recorded.
    r = runHook([human(`${SUMMARY} What does that line mean?`), assistant('It marks a resumed session.')]);
    assert.doesNotMatch(r.stderr, SKIPPED);
    assert.match(r.stderr, RECORDED);
    // With no provenance fields at all, the original text rule still excludes the summary text.
    r = runHook([{ type: 'user', message: { content: SUMMARY } }, assistant('Resuming.')]);
    assert.doesNotMatch(r.stderr, RECORDED);
  });

  test('an ordinary founder turn is recorded exactly as before', () => {
    const r = runHook([human('please check the deploy'), assistant('Checking now.')]);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stderr, SKIPPED);
    assert.match(r.stderr, RECORDED);
  });
});
