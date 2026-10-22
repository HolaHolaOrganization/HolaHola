/** Projection traces from the recording-gap design (R6.5), run on FILTERED entries (test 16). */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { filterEntry } from '@shared/claude-code-mirror-core.mjs';
import { projectSession, type MirroredEntry } from './claude-code-projection';

let uuid = 0;
/** Builds filtered mirrored entries from raw transcript-shaped entries, at consecutive positions. */
function mirror(raw: Array<Record<string, unknown> | null>, from = 0): MirroredEntry[] {
  return raw.flatMap((r, i) => (r === null ? [] : [{ position: from + i, uuid: `u${++uuid}`, entry: filterEntry(r) }]));
}
const human = (text: string) => ({ type: 'user', origin: { kind: 'human' }, promptSource: 'sdk', message: { content: text } });
const notice = (text: string) => ({ type: 'user', origin: { kind: 'task-notification' }, promptSource: 'system', message: { content: text } });
const reply = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'assistant', ...extra, message: { content: [{ type: 'text', text }] } });
const toolCall = (id: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'x' } }] } });
const toolResult = (id: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'out' }] } });
const feedback = () => [
  { type: 'user', isMeta: true, message: { content: 'Stop hook feedback: reply BETA' } },
  { type: 'attachment', attachment: { type: 'hook_blocking_error', blockingError: 'reason' } },
  { type: 'system', subtype: 'stop_hook_summary', level: 'suggestion', content: 'reason' },
];
const S = 'session-1';
const summary = (x: ReturnType<typeof projectSession>) => x.map((e) => [e.openingPosition, e.kind, e.state, e.userText, e.replyText, e.reasons]);

describe('certified closure and terminal exchanges', () => {
  test('a later human start certifies the previous exchange; the last one is a provisional candidate', () => {
    const out = projectSession(S, mirror([human('U1'), reply('A1'), human('U2'), reply('A2')]));
    assert.deepEqual(summary(out), [
      [0, 'human', 'certified', 'U1', 'A1', []],
      [2, 'human', 'provisional-candidate', 'U2', 'A2', []],
    ]);
    assert.equal(out[0].captureId, 'cc-session-1-0');
  });

  test('R6-4: blocked then continuation is one exchange, U1 / A1+B1; the feedback is never David', () => {
    const out = projectSession(S, mirror([human('U1'), reply('A1'), ...feedback(), reply('B1'), human('U2')]));
    assert.deepEqual(summary(out)[0], [0, 'human', 'certified', 'U1', 'A1\n\nB1', []]);
    assert.equal(out.length, 2);
    assert.ok(!out.some((e) => e.userText.includes('Stop hook feedback')));
  });

  test('R6-5: deferred U1 plus a genuine U2 gives two exchanges; neither absorbed nor lost', () => {
    const out = projectSession(S, mirror([human('U1'), reply('A1'), ...feedback(), reply('B1'), human('U2'), reply('A2')]));
    assert.deepEqual(summary(out), [
      [0, 'human', 'certified', 'U1', 'A1\n\nB1', []],
      [6, 'human', 'provisional-candidate', 'U2', 'A2', []],
    ]);
  });

  test('R6-6: repeated blocks join into one reply', () => {
    const out = projectSession(S, mirror([human('U1'), reply('A1'), ...feedback(), reply('B1'), ...feedback(), reply('C1'), human('U2')]));
    assert.equal(out[0].replyText, 'A1\n\nB1\n\nC1');
    assert.equal(out[0].state, 'certified');
  });

  test('R6-7: no continuation speech keeps the exchange open until a later start, then U1 / A1', () => {
    const terminal = projectSession(S, mirror([human('U1'), reply('A1'), ...feedback()]));
    assert.deepEqual(summary(terminal), [[0, 'human', 'open', 'U1', 'A1', ['trailing-hook-feedback']]]);
    const closed = projectSession(S, mirror([human('U1'), reply('A1'), ...feedback(), human('U2')]));
    assert.deepEqual(summary(closed)[0], [0, 'human', 'certified', 'U1', 'A1', []]);
  });

  test('R6-8: an image-bearing user keeps its text; image metadata before the reply folds in, not a start', () => {
    const out = projectSession(S, mirror([
      { type: 'user', origin: { kind: 'human' }, message: { content: [{ type: 'text', text: 'look' }, { type: 'image', source: { data: 'B64' } }] } },
      { type: 'user', isMeta: true, message: { content: '[Image: source: x.png]' } },
      reply('I see it'), human('next'),
    ]));
    assert.deepEqual(summary(out)[0], [0, 'human', 'certified', 'look', 'I see it', []]);
    assert.equal(out.length, 2);
  });
});

describe('open and retained exchanges', () => {
  test('R6-14: an isMeta after reply with its lookahead not yet held is unresolved and closes nothing', () => {
    const sync1 = projectSession(S, mirror([human('U1'), reply('A1'), feedback()[0]]));
    assert.deepEqual(summary(sync1), [[0, 'human', 'open', 'U1', 'A1', ['unresolved-lookahead']]]);
    const sync2 = projectSession(S, mirror([human('U1'), reply('A1'), ...feedback(), reply('B1'), human('U2')]));
    assert.equal(sync2[0].state, 'certified');
  });

  test('an isMeta after reply WITHOUT the witnesses is a runtime start (revision 3)', () => {
    const out = projectSession(S, mirror([human('U1'), reply('A1'), { type: 'user', isMeta: true, message: { content: 'auto-resume' } }, reply('R'), human('U2')]));
    assert.deepEqual(summary(out).slice(0, 2), [
      [0, 'human', 'certified', 'U1', 'A1', []],
      [2, 'runtime', 'certified', 'auto-resume', 'R', []],
    ]);
  });

  test('R6-12: a long tool run with no result keeps the terminal exchange open; the result closes it', () => {
    const running = projectSession(S, mirror([human('U'), reply('starting'), toolCall('t1')]));
    assert.deepEqual(summary(running), [[0, 'human', 'open', 'U', 'starting', ['unmatched-tool-call']]]);
    const done = projectSession(S, mirror([human('U'), reply('starting'), toolCall('t1'), toolResult('t1'), reply('done')]));
    assert.deepEqual(summary(done), [[0, 'human', 'provisional-candidate', 'U', 'starting\n\ndone', []]]);
  });

  test('a hole keeps an exchange open even when a later start is held', () => {
    const out = projectSession(S, mirror([human('U1'), null, reply('A1'), human('U2')]));
    assert.equal(out[0].state, 'open');
    assert.deepEqual(out[0].reasons, ['hole']);
  });

  test('conflicting variants at a position retain the exchange', () => {
    const entries = mirror([human('U1'), reply('A1'), human('U2')]);
    entries[1].conflicted = true;
    assert.deepEqual(summary(projectSession(S, entries))[0], [0, 'human', 'retained', 'U1', 'A1', ['conflicting-variants']]);
  });
});

describe('revision 3 provenance rules', () => {
  test('runtime notices start runtime turns; absorbed founder prompts start their own exchange', () => {
    const out = projectSession(S, mirror([
      human('U1'), reply('A1'),
      { type: 'attachment', attachment: { type: 'queued_command', origin: { kind: 'human' }, commandMode: 'prompt', prompt: 'quick question' } },
      reply('answer'),
      notice('<task-notification>done</task-notification>'), reply('noted'),
      human('U2'),
    ]));
    assert.deepEqual(summary(out).slice(0, 3), [
      [0, 'human', 'certified', 'U1', 'A1', []],
      [2, 'absorbed-human', 'certified', 'quick question', 'answer', []],
      [4, 'runtime', 'certified', '<task-notification>done</task-notification>', 'noted', []],
    ]);
  });

  test('an unresolved queued_command shape is a retained boundary, never merged', () => {
    const out = projectSession(S, mirror([
      human('U1'), reply('A1'),
      { type: 'attachment', attachment: { type: 'queued_command', origin: { kind: 'mystery' }, commandMode: 'other' } },
      reply('x'), human('U2'),
    ]));
    assert.deepEqual(summary(out).slice(0, 2), [
      [0, 'human', 'certified', 'U1', 'A1', []],
      [2, 'unresolved-boundary', 'retained', '', 'x', ['unresolved-boundary']],
    ]);
  });

  test('API-error text is never Luca\'s words; tool-only and compact-summary entries never start turns', () => {
    const out = projectSession(S, mirror([
      human('U1'), reply('API Error: 529', { isApiErrorMessage: true }), toolResult('nope'),
      { type: 'user', isCompactSummary: true, message: { content: 'summary' } },
      reply('real answer'), human('U2'),
    ]));
    assert.deepEqual(summary(out)[0], [0, 'human', 'certified', 'U1', 'real answer', []]);
    assert.equal(out[0].apiErrorCount, 1);
  });

  test('a turn with no reply is retained, not published; an interrupted tool is flagged when a later start closes it', () => {
    const out = projectSession(S, mirror([human('U1'), human('U2'), toolCall('t9'), human('U3')]));
    assert.deepEqual(summary(out).slice(0, 2), [
      [0, 'human', 'retained', 'U1', '', ['no-reply']],
      [1, 'human', 'retained', 'U2', '', ['interrupted-tool-call', 'no-reply']],
    ]);
  });

  test('the version hash changes when an exchange grows', () => {
    const v1 = projectSession(S, mirror([human('U'), reply('A')]))[0].versionSha256;
    const v2 = projectSession(S, mirror([human('U'), reply('A'), ...feedback(), reply('B')]))[0].versionSha256;
    assert.notEqual(v1, v2);
  });
});
