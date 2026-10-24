/** The receipt generator's row judgement and the data-op's per-row apply rule. Synthetic only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { judgeRow, leadingBlock } from './generate-runtime-notice-relabel-receipt';
import { relabelContent } from '../../scripts/data-ops/relabel-runtime-notices';
import { RUNTIME_NOTICE_LABEL } from '../services/runtime-notice-relabel';

const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
const NOTICE = '<task-notification>\n<task-id>b9</task-id>\n</task-notification>';
const row = (content: string, extra: Partial<{ hasAttribution: boolean; captureId: string | null }> = {}) =>
  ({ id: 'row-1', content, hasAttribution: false, captureId: 'cc-11111111-1111-4111-8111-111111111111-7', ...extra });
const content = `David [Claude Code]: ${NOTICE}\n\nClaude Code: CI is green.`;
const noticeEntry = { type: 'user', origin: { kind: 'task-notification' }, message: { content: NOTICE } };
const founderEntry = { type: 'user', origin: { kind: 'human' }, message: { content: NOTICE } };

test('leadingBlock is the founder-labelled block up to the reply', () => {
  assert.equal(leadingBlock(content), NOTICE);
  assert.equal(leadingBlock('Claude Code: x'), null);
  assert.equal(leadingBlock('David [Claude Code]: no reply'), null);
});

test('a provenance-verified runtime turn is corrected; the receipt holds hashes, not dialogue', () => {
  const v = judgeRow(row(content), noticeEntry, true);
  assert.equal(v.kind, 'correct');
  if (v.kind !== 'correct') return;
  assert.equal(v.entry.basis, 'origin:task-notification');
  assert.equal(v.entry.preSha256, sha(content));
  assert.equal(v.entry.postSha256, sha(content.replace('David [Claude Code]:', `${RUNTIME_NOTICE_LABEL}:`)));
  assert.ok(!JSON.stringify(v.entry).includes('task-id'), 'no dialogue in the receipt entry');
});

test('a founder message that looks like a notice is never corrected (provenance, not text)', () => {
  assert.deepEqual(judgeRow(row(content), founderEntry, true), { kind: 'founder' });
});

test('anything unproven is left as stored, with a reason', () => {
  const reasons = [
    judgeRow(row(content, { hasAttribution: true }), noticeEntry, true),
    judgeRow(row(content, { captureId: null }), noticeEntry, true),
    judgeRow(row('David [Claude Code]: no reply block'), noticeEntry, true),
    judgeRow(row(content), undefined, false),
    judgeRow(row(content), { type: 'assistant' }, true),
    judgeRow(row(content), { ...noticeEntry, message: { content: 'different text' } }, true),
  ].map(v => (v.kind === 'unverified' ? v.reason : v.kind));
  assert.deepEqual(reasons, [
    'row has per-turn attribution', 'no capture id', 'unexpected row structure',
    'transcript not on this machine', 'transcript index is not a user entry', 'row text differs from transcript entry',
  ]);
});

test('the data-op applies exactly the receipt, is idempotent, and leaves a drifted row alone', () => {
  const v = judgeRow(row(content), noticeEntry, true);
  if (v.kind !== 'correct') throw new Error('expected a correct verdict');
  const first = relabelContent(content, v.entry);
  assert.equal(first.status, 'apply');
  if (first.status !== 'apply') return;
  assert.equal(first.next, content.replace('David [Claude Code]:', `${RUNTIME_NOTICE_LABEL}:`));
  assert.equal(first.next.slice(first.next.indexOf(':') + 1), content.slice(content.indexOf(':') + 1), 'every byte after the label is unchanged');
  assert.deepEqual(relabelContent(first.next, v.entry), { status: 'already-applied' });
  assert.deepEqual(relabelContent(content + ' edited', v.entry), { status: 'drifted' });
  assert.deepEqual(relabelContent(content, { ...v.entry, postSha256: '0'.repeat(64) }), { status: 'drifted' });
  assert.deepEqual(relabelContent(content, { ...v.entry, oldLabel: 'Claude Code:' }), { status: 'drifted' });
});
