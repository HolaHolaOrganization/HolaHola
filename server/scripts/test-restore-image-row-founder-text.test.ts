/** Restoring founder messages dropped from image rows: provenance selection and the per-row apply rule. Synthetic only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  IMAGE_PREFIX, LABEL, PERMITTED_EPISODE_ID, buildEpisodePlan, decideEpisodeInsert, decideRestore, founderMessageFor, restoredContent,
} from './restore-image-row-founder-text';

const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
const human = (content: unknown) => ({ type: 'user', origin: { kind: 'human' }, promptSource: 'sdk', message: { content } });
const image = { type: 'user', isMeta: true, message: { content: [{ type: 'text', text: '[Image: source: /tmp/1.png]' }] } };
const reply = (t: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const notice = { type: 'user', origin: { kind: 'task-notification' }, message: { content: '<task-notification>x</task-notification>' } };

test('the founder message is the nearest human entry before the image, by provenance', () => {
  const entries = [reply('earlier'), human([{ type: 'image' }, { type: 'text', text: 'here are two screenshots' }]), { type: 'attachment' }, image];
  assert.deepEqual(founderMessageFor(entries, 3), { index: 1, text: 'here are two screenshots' });
});

test('an image sent with no words, a notice, or assistant text in between restores nothing', () => {
  assert.deepEqual(founderMessageFor([reply('a'), human([{ type: 'image' }]), image], 2), { reason: 'image sent with no words' });
  assert.deepEqual(founderMessageFor([human('mine'), reply('answered'), image], 2), { reason: 'assistant text before any founder message' });
  assert.equal('reason' in founderMessageFor([notice, image], 1), true);
  assert.deepEqual(founderMessageFor([human('x'), reply('y')], 1), { reason: 'capture index is not an image metadata entry' });
});

const current = `${IMAGE_PREFIX} /tmp/1.png]\n\nClaude Code: I see it.`;
const text = 'here are two screenshots';
const entry = { rowId: 'r1', captureId: 'cc-x-1', founderIndex: 1, founderTextSha256: sha(text), preSha256: sha(current), postSha256: sha(restoredContent(current, text)) };

test('apply prepends exactly the founder block; every existing byte is kept; rerun is a no-op', () => {
  const out = decideRestore(current, text, entry);
  assert.equal(out.status, 'apply');
  if (out.status !== 'apply') return;
  assert.equal(out.next, `${LABEL}${text}\n\n${current}`);
  assert.ok(out.next.endsWith(current));
  assert.deepEqual(decideRestore(out.next, text, entry), { status: 'already-applied' });
});

test('changed transcript text, a changed row, or a non-image row is refused', () => {
  assert.equal(decideRestore(current, 'different words', entry).status, 'drifted');
  assert.equal(decideRestore(current + ' edited', text, entry).status, 'drifted');
  const other = `David [Claude Code]: something\n\nClaude Code: ok`;
  assert.equal(decideRestore(other, text, { ...entry, preSha256: sha(other) }).status, 'drifted');
});

// --- Episode 34 copy of a restored exchange ---
const pre = `${IMAGE_PREFIX} /tmp/1.png]\n\nClaude Code: I see it.`;
const frame = `\n${pre}\n`;
const episode = `# Ep\n\nDavid [Claude Code]: earlier\n\nClaude Code: ok\n${frame}\nDavid [Claude Code]: later\n\nClaude Code: fine\ntail`;
const insert = { rowId: 'r1', frameOffset: episode.indexOf(frame), frameLength: frame.length, frameSha256: sha(frame), founderTextSha256: sha(text) };
const texts = new Map([['r1', text]]);
const plan = buildEpisodePlan(episode, 'restore-list', [insert], texts);

test('episode: the founder block is inserted at the start of the frame; prefix before and tail after are unchanged', () => {
  assert.equal(plan.episodeId, PERMITTED_EPISODE_ID);
  const out = decideEpisodeInsert(episode, plan, texts);
  assert.equal(out.status, 'apply');
  if (out.status !== 'apply') return;
  assert.ok(out.next.includes(`\n${LABEL}${text}\n\n${pre}\n`), 'the copy now reads like the restored row');
  assert.ok(out.next.startsWith(episode.slice(0, insert.frameOffset + 1)));
  assert.ok(out.next.endsWith(episode.slice(plan.L)));
  assert.equal(out.next.length, episode.length + `${LABEL}${text}\n\n`.length);
});

test('episode: rerun after later appends is a no-op; a changed prefix, wrong text or forged plan is refused', () => {
  const out = decideEpisodeInsert(episode, plan, texts);
  if (out.status !== 'apply') throw new Error('expected apply');
  assert.deepEqual(decideEpisodeInsert(out.next + '\nappended later\n', plan, texts), { status: 'already-applied' });
  assert.equal(decideEpisodeInsert(episode.replace('# Ep', '# Edited'), plan, texts).status, 'drifted');
  assert.equal(decideEpisodeInsert(episode, plan, new Map([['r1', 'other words']])).status, 'drifted');
  assert.equal(decideEpisodeInsert(episode, { ...plan, episodeId: 'another-episode' }, texts).status, 'drifted');
  const shifted = { ...plan, inserts: [{ ...insert, frameOffset: insert.frameOffset + 1 }] };
  assert.equal(decideEpisodeInsert(episode, shifted, texts).status, 'drifted');
});
