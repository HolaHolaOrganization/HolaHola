// Planning for the rolling episode gap projection (2026-10-29 repair): which
// canonical turns are missing, which are projected automatically, which are a
// backlog that only a founder-approved backfill may fill, and when to alarm.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  EPISODE_GAP_ALARM_AFTER_MS,
  type CanonicalTurn,
  exchangeInMd,
  normForGap,
  overdueTurns,
  planEpisodeGapProjection,
  rollingEpisodeFilenameFromTitle,
} from './episode-gap-projection';

const T0 = Date.parse('2026-10-29T06:00:00Z');
const turn = (id: string, minutes: number, content: string): CanonicalTurn => ({ id, createdAtMs: T0 + minutes * 60_000, content });

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

describe('gap planning', () => {
  const episode = [
    'Episode 35 opening prose.',
    '',
    'David [Claude Code]: 135 approved',
    '',
    'Claude Code: Thanks. #135 will merge automatically, and I am watching main for it.',
  ].join('\n');

  test('a turn already in the episode is skipped; absent turns at or after the floor are projected in order', () => {
    const turns = [
      turn('c', 30, 'David [Claude Code]: 136 approved\n\nClaude Code: Thanks. I am watching for #136 to merge.'),
      turn('a', 0, 'David [Claude Code]: 135 approved\n\nClaude Code: Thanks. #135 will merge automatically, and I am watching main for it.'),
      turn('b', 25, 'David [Claude Code]: anything from lr?\n\nClaude Code: Nothing new from LR yet.'),
    ];
    const plan = planEpisodeGapProjection(turns, episode, T0 + 20 * 60_000);
    assert.deepEqual(plan.toAppend.map((t) => t.id), ['b', 'c']);
    assert.deepEqual([plan.backlog, plan.held], [[], []]);
  });

  test('while an older turn is missing, newer turns are held, never appended out of order', () => {
    const turns = [
      turn('old', 10, 'David [Claude Code]: anything from lr?\n\nClaude Code: Nothing new from LR yet.'),
      turn('new', 30, 'David [Claude Code]: 136 approved\n\nClaude Code: Thanks. I am watching for #136 to merge.'),
    ];
    const plan = planEpisodeGapProjection(turns, episode, T0 + 20 * 60_000);
    assert.deepEqual(plan.backlog.map((t) => t.id), ['old']);
    assert.deepEqual(plan.held.map((t) => t.id), ['new']);
    assert.deepEqual(plan.toAppend, []);
    // With a floor below every turn (the founder-approved backfill), all are appended, oldest first.
    assert.deepEqual(planEpisodeGapProjection(turns, episode, 0).toAppend.map((t) => t.id), ['old', 'new']);
  });

  test('a turn exactly at the floor is projected, not backlog', () => {
    const plan = planEpisodeGapProjection([turn('x', 20, 'David [Claude Code]: x\n\nClaude Code: y')], episode, T0 + 20 * 60_000);
    assert.deepEqual(plan.toAppend.map((t) => t.id), ['x']);
    assert.deepEqual(plan.backlog, []);
  });

  test('presence ignores whitespace, case and markdown bold, as the boot gap check always has', () => {
    const md = '**David [Claude Code]:**   136   APPROVED\n\n**Claude Code:** Thanks.';
    assert.equal(exchangeInMd('David [Claude Code]: 136 approved\n\nClaude Code: Thanks.', normForGap(md)), true);
    assert.equal(exchangeInMd('David [Claude Code]: 137 approved', normForGap(md)), false);
  });

  test('equal timestamps keep a stable order by id', () => {
    const plan = planEpisodeGapProjection([turn('b', 5, 'B text here'), turn('a', 5, 'A text here')], '', 0);
    assert.deepEqual(plan.toAppend.map((t) => t.id), ['a', 'b']);
  });
});

describe('alarm', () => {
  test('only turns absent for more than 15 minutes are overdue', () => {
    const now = T0 + 60 * 60_000;
    const absent = [turn('old', 0, 'x'), turn('edge', 45, 'y'), turn('fresh', 50, 'z')];
    assert.equal(EPISODE_GAP_ALARM_AFTER_MS, 15 * 60_000);
    assert.deepEqual(overdueTurns(absent, now).map((t) => t.id), ['old']);
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
  });

  test('the rolling filename is bound to the exact rolling row before any append', () => {
    assert.match(source, /episodeIdCache\.set\(filename, row\.id as string\);/);
    assert.match(source, /SELECT content FROM conversation_memories WHERE id = \$\{memoryId\} FOR UPDATE/);
  });

  test('automatic projection starts at the process floor; older turns are backlog only', () => {
    assert.match(source, /floorMs: number = PROCESS_STARTED_AT_MS - EPISODE_PROJECTION_FLOOR_MARGIN_MS/);
  });
});
