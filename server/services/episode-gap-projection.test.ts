// Planning for the rolling episode gap projection (2026-10-29 repair): which
// canonical turns are missing, which are projected automatically, which are a
// backlog that only a founder-approved backfill may fill, and when to alarm.
// R1-R3 are Luca [Replit]'s review findings on #138, each pinned below.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  EPISODE_GAP_ALARM_AFTER_MS,
  type CanonicalTurn,
  appendTurnsInOrder,
  captureIdFromTags,
  createEpisodeGapAlarmLatch,
  episodeGapAlarmKey,
  episodeTextForTurn,
  overdueTurns,
  planEpisodeGapProjection,
  rollingEpisodeFilenameFromTitle,
  turnEpisodeMarker,
  turnPresentInEpisode,
} from './episode-gap-projection';
import { canonicalTurnEpisodeMarker } from './inner-life-capture';

const T0 = Date.parse('2026-10-29T06:00:00Z');
const turn = (id: string, minutes: number, content: string, captureId?: string): CanonicalTurn =>
  ({ id, captureId, createdAtMs: T0 + minutes * 60_000, content });

describe('rolling episode filename', () => {
  test('bare and subtitled "Episode N" titles both map to episode-N.md', () => {
    assert.equal(rollingEpisodeFilenameFromTitle('Episode 27'), 'episode-27.md');
    assert.equal(rollingEpisodeFilenameFromTitle("Episode 35: Alden's Entry into the Record"), 'episode-35.md');
    assert.equal(rollingEpisodeFilenameFromTitle('Episode 36 — Next'), 'episode-36.md');
  });

  test('a longer number or a non-episode title is not mistaken for an episode number', () => {
    assert.equal(rollingEpisodeFilenameFromTitle('Episode 350'), 'episode-350.md');
    assert.equal(rollingEpisodeFilenameFromTitle('Episode 3x'), 'episode-3x.md');
    assert.equal(rollingEpisodeFilenameFromTitle('Prequel Episode 1'), 'prequel-episode-1.md');
  });
});

describe('turn identity (R1)', () => {
  const prefix = 'David [Replit]: Please continue with the canonical recording review and preserve the existing boundaries.';
  const first = turn('a', 0, `${prefix}\n\nLuca [Replit]: First answer: still blocked.`, 'cap-a');
  const second = turn('b', 1, `${prefix}\n\nLuca [Replit]: Second answer: different independent finding.`, 'cap-b');

  test('R1: two complete turns sharing a long opening are different turns', () => {
    const episode = episodeTextForTurn(first);
    assert.equal(turnPresentInEpisode(first, episode), true);
    assert.equal(turnPresentInEpisode(second, episode), false);
    assert.deepEqual(planEpisodeGapProjection([first, second], episode, 0).toAppend.map((t) => t.id), ['b']);
  });

  test('the marker is the live route\'s chat-capture marker when a capture id exists, else a row marker', () => {
    assert.equal(turnEpisodeMarker(first), canonicalTurnEpisodeMarker('cap-a'));
    assert.equal(turnEpisodeMarker({ id: 'row-9' }), '<!-- canonical-row:row-9 -->');
    assert.equal(episodeTextForTurn(first), `${canonicalTurnEpisodeMarker('cap-a')}\n${first.content}`);
  });

  test('a marker proves presence even if the text was reformatted', () => {
    assert.equal(turnPresentInEpisode(first, `${turnEpisodeMarker(first)}\n(reformatted)`), true);
  });

  test('R1 (re-review): a turn with a capture id is never found by its words, only by its marker', () => {
    const words = 'David: yes\n\nLuca: Done.';
    const one = turn('r1', 3, words, 'cap-1');
    const two = turn('r2', 4, words, 'cap-2');
    assert.equal(turnPresentInEpisode(two, episodeTextForTurn(one)), false);
    assert.deepEqual(planEpisodeGapProjection([one, two], episodeTextForTurn(one), 0).toAppend.map((t) => t.id), ['r2']);
    // Same words under different hat labels are different turns too.
    const replit = turn('h1', 5, 'David [Replit]: yes\n\nLuca [Replit]: Done.', 'cap-h1');
    const code = turn('h2', 6, 'David [Replit]: yes\n\nLuca [Claude Code]: Done.', 'cap-h2');
    assert.equal(turnPresentInEpisode(code, episodeTextForTurn(replit)), false);
  });

  test('an unmarked turn without a capture id needs its WHOLE text, with labels intact', () => {
    const unmarked = turn('c', 2, 'David [Claude Code]: 136 approved\n\nClaude Code: Thanks. I am watching for #136 to merge.');
    assert.equal(turnPresentInEpisode(unmarked, 'David [Claude Code]:   136   APPROVED\n\nClaude Code: Thanks. I am watching for #136 to merge.'), true);
    assert.equal(turnPresentInEpisode(unmarked, 'David [Claude Code]: 136 approved\n\nClaude Code: Thanks. I am watching'), false);
    const relabelled = turn('d', 3, 'David: yes\n\nLuca [Replit]: Done.');
    assert.equal(turnPresentInEpisode(relabelled, 'David: yes\n\nLuca [Claude Code]: Done.'), false);
  });

  test('capture ids are read from the row tags', () => {
    assert.equal(captureIdFromTags(['per-turn', 'capture-id:cc-1-2']), 'cc-1-2');
    assert.equal(captureIdFromTags(['per-turn']), undefined);
    assert.equal(captureIdFromTags(null), undefined);
  });
});

describe('gap planning', () => {
  const present = turn('a', 0, 'David [Claude Code]: 135 approved\n\nClaude Code: Thanks.', 'cap-a');
  const episode = `Episode 35 opening prose.\n${episodeTextForTurn(present)}\n`;

  test('a present turn is skipped; absent turns at or after the floor are projected in order', () => {
    const plan = planEpisodeGapProjection([
      turn('c', 30, 'David [Claude Code]: 136 approved\n\nClaude Code: Watching #136.', 'cap-c'),
      present,
      turn('b', 25, 'David [Claude Code]: anything from lr?\n\nClaude Code: Nothing new.', 'cap-b'),
    ], episode, T0 + 20 * 60_000);
    assert.deepEqual(plan.toAppend.map((t) => t.id), ['b', 'c']);
    assert.deepEqual([plan.backlog, plan.held], [[], []]);
  });

  test('while an older turn is missing, newer turns are held, never appended out of order', () => {
    const turns = [turn('old', 10, 'David: old\n\nClaude Code: old reply', 'o'), turn('new', 30, 'David: new\n\nClaude Code: new reply', 'n')];
    const plan = planEpisodeGapProjection(turns, episode, T0 + 20 * 60_000);
    assert.deepEqual([plan.backlog.map((t) => t.id), plan.held.map((t) => t.id), plan.toAppend], [['old'], ['new'], []]);
    // A floor below every turn (the founder-approved backfill) appends all, oldest first.
    assert.deepEqual(planEpisodeGapProjection(turns, episode, 0).toAppend.map((t) => t.id), ['old', 'new']);
  });

  test('a turn exactly at the floor is projected, not backlog; equal timestamps order by id', () => {
    assert.deepEqual(planEpisodeGapProjection([turn('x', 20, 'David: x\n\nClaude Code: y', 'x')], episode, T0 + 20 * 60_000).toAppend.map((t) => t.id), ['x']);
    assert.deepEqual(planEpisodeGapProjection([turn('b', 5, 'B text', 'b'), turn('a', 5, 'A text', 'a2')], '', 0).toAppend.map((t) => t.id), ['a', 'b']);
  });
});

describe('in-order append (R2)', () => {
  test('R2: after a failure nothing newer is appended, and the retry appends in order', async () => {
    const older = turn('older', 1, 'older'), newer = turn('newer', 2, 'newer');
    const episode: string[] = [];
    let fail = true;
    const append = async (t: CanonicalTurn) => {
      if (t.id === 'older' && fail) { fail = false; throw new Error('transient'); }
      episode.push(t.id);
      return true;
    };
    const first = await appendTurnsInOrder([older, newer], append);
    assert.deepEqual([first.appended.map((t) => t.id), first.held.map((t) => t.id)], [[], ['older', 'newer']]);
    assert.deepEqual(episode, []);
    const second = await appendTurnsInOrder(first.held, append);
    assert.deepEqual([second.appended.map((t) => t.id), second.held], [['older', 'newer'], []]);
    assert.deepEqual(episode, ['older', 'newer']);
  });

  test('a turn found already present (append returns false) is not counted as appended', async () => {
    const result = await appendTurnsInOrder([turn('a', 1, 'a')], async () => false);
    assert.deepEqual([result.appended, result.held], [[], []]);
  });
});

describe('alarm (R3)', () => {
  test('only turns absent for more than 15 minutes are overdue', () => {
    const now = T0 + 60 * 60_000;
    assert.equal(EPISODE_GAP_ALARM_AFTER_MS, 15 * 60_000);
    assert.deepEqual(overdueTurns([turn('old', 0, 'x'), turn('edge', 45, 'y'), turn('fresh', 50, 'z')], now).map((t) => t.id), ['old']);
  });

  test('R3: a failed delivery is retried; a delivered gap is not repeated; a closed gap re-arms', async () => {
    const latch = createEpisodeGapAlarmLatch();
    const key = episodeGapAlarmKey('episode-35.md', 3, '2026-10-29T06:00:00.000Z');
    let attempts = 0;
    const failing = async () => { attempts++; throw new Error('inbox down'); };
    const working = async () => { attempts++; };
    assert.equal(await latch.raise(key, failing), 'failed');
    assert.equal(await latch.raise(key, working), 'delivered');
    assert.equal(await latch.raise(key, working), 'already-delivered');
    assert.equal(attempts, 2);
    assert.equal(await latch.raise(null, working), 'cleared');
    assert.equal(await latch.raise(key, working), 'delivered');
  });

  test('the alarm key distinguishes episodes and gaps, not only counts', () => {
    assert.notEqual(episodeGapAlarmKey('episode-35.md', 3, 'a'), episodeGapAlarmKey('episode-36.md', 3, 'a'));
    assert.notEqual(episodeGapAlarmKey('episode-35.md', 3, 'a'), episodeGapAlarmKey('episode-35.md', 3, 'b'));
  });
});

describe('agent-session-autosave wiring', () => {
  const source = readFileSync(new URL('./agent-session-autosave.ts', import.meta.url), 'utf8');

  test('the boot gap check no longer needs a docs/ file to project', () => {
    assert.doesNotMatch(source, /Startup gap check: \$\{episodeFilename\} not on disk/);
    assert.match(source, /const report = await projectRollingEpisodeGaps\(\);/);
  });

  test('the poll loop runs the throttled projection pass, which raises the founder alarm', () => {
    assert.match(source, /await checkRollingEpisodeGaps\(\);/);
    assert.match(source, /fingerprint: 'episode_projection_gap'/);
    assert.match(source, /_episodeGapAlarmLatch\.raise\(key,/);
  });

  test('the rolling filename is bound to the exact rolling row; appends are marked, ordered and locked', () => {
    assert.match(source, /episodeIdCache\.set\(filename, row\.id as string\);/);
    assert.match(source, /SELECT content FROM conversation_memories WHERE id = \$\{memoryId\} FOR UPDATE/);
    assert.match(source, /if \(turnPresentInEpisode\(turn, locked\.content\)\)/);
    assert.match(source, /\$\{'\\n' \+ episodeTextForTurn\(turn\) \+ '\\n'\}/);
    assert.match(source, /await appendTurnsInOrder\(plan\.toAppend,/);
  });

  test('automatic projection starts at the process floor; older turns are backlog only', () => {
    assert.match(source, /floorMs: number = PROCESS_STARTED_AT_MS - EPISODE_PROJECTION_FLOOR_MARGIN_MS/);
  });
});
