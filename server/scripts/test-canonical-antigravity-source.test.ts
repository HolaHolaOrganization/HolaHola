/**
 * Antigravity as a canonical conversation source (founder priority,
 * 2026-10-26; approved central-records design 535ca04f, sections 5-7).
 *
 * Hermetic: a temp capture file and ingress lock, no DB, no network. Covers:
 *   - each coordination actor may submit only its own source;
 *   - an Antigravity exchange is written as David + Luca with SOURCE
 *     antigravity, parses back byte-exact, and renders "[Antigravity]";
 *   - text that looks like harness envelopes or speaker labels is stored
 *     verbatim, never parsed or trimmed;
 *   - retry with the same identity appends nothing; changed bytes are refused;
 *   - Replit's four-channel envelope rule does not apply to Antigravity, so an
 *     Antigravity turn cannot hold the capture cursor for every source.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendCanonicalConversationExchange,
  canonicalSourceForActor,
  isCompleteCanonicalCaptureBatch,
} from '../services/canonical-conversation-capture';
import { formatChatCaptureSpeakerLabel, parseChatCaptureFromOffset, requiresFourChannelEnvelope } from '../services/transcript-parser';

const root = mkdtempSync(join(tmpdir(), 'canonical-antigravity-source-'));
after(() => rmSync(root, { recursive: true, force: true }));

const paths = (name: string) => ({ capturePath: join(root, `${name}.log`), ingressLockPath: join(root, `${name}.lock`) });

test('each coordination actor may submit only its own source', () => {
  assert.equal(canonicalSourceForActor('luca-replit'), 'replit');
  assert.equal(canonicalSourceForActor('luca-claude-code'), 'claude-code');
  assert.equal(canonicalSourceForActor('luca-antigravity'), 'antigravity');
  assert.equal(canonicalSourceForActor('luca-codex'), 'codex');
  for (const actor of ['alden', 'david', 'luca-openai-agents', 'luca-holahola', 'luca-cursor', 'luca-gemini', '', undefined]) {
    assert.equal(canonicalSourceForActor(actor), null, `${actor} may submit no source`);
  }
});

test('a Codex exchange is recorded as David and Luca under SOURCE codex, and only luca-codex may submit it', () => {
  const p = paths('codex-exchange');
  const userText = 'Hello from Codex';
  const assistantText = 'Codex reply';
  const result = appendCanonicalConversationExchange({ source: 'codex', userText, assistantText, turnId: 'codex-turn-1', ...p });
  assert.deepEqual(result.appendedSpeakers, ['user', 'assistant']);

  const { turns } = parseChatCaptureFromOffset(p.capturePath, 0);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((t) => [t.speaker, t.source, t.captureId]), [
    ['DAVID', 'codex', 'codex-turn-1'],
    ['LUCA', 'codex', 'codex-turn-1'],
  ]);
  assert.ok(isCompleteCanonicalCaptureBatch(turns), 'a David + Luca pair is a complete Codex exchange');
  assert.deepEqual(turns.map((t) => formatChatCaptureSpeakerLabel(t)), ['David [Codex]', 'Luca [Codex]']);
  assert.equal(requiresFourChannelEnvelope({ speaker: 'LUCA', source: 'codex' }), false);
});

test('an Antigravity exchange is recorded as David and Luca under SOURCE antigravity, byte-exact', () => {
  const p = paths('exchange');
  // Literal envelope-, metadata- and speaker-label-shaped text stays verbatim.
  const userText = '<USER_REQUEST>\nalpha\n</USER_REQUEST>\nLuca [Replit]: not a speaker\n\nnaïve café 🙂';
  const assistantText = 'Reply with a literal "\n\nDavid: " inside it.';
  const result = appendCanonicalConversationExchange({ source: 'antigravity', userText, assistantText, turnId: 'ag-3d85b125-316c-4b5c-81ea-9de52dd90897-2219', ...p });
  assert.deepEqual(result.appendedSpeakers, ['user', 'assistant']);

  const raw = readFileSync(p.capturePath, 'utf8');
  assert.equal((raw.match(/^SOURCE: antigravity$/gm) ?? []).length, 2);
  assert.match(raw, /^SPEAKER: David$/m);
  assert.match(raw, /^SPEAKER: Luca$/m);

  const { turns } = parseChatCaptureFromOffset(p.capturePath, 0);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((t) => [t.speaker, t.source, t.captureId]), [
    ['DAVID', 'antigravity', 'ag-3d85b125-316c-4b5c-81ea-9de52dd90897-2219'],
    ['LUCA', 'antigravity', 'ag-3d85b125-316c-4b5c-81ea-9de52dd90897-2219'],
  ]);
  assert.equal(turns[0].text, userText);
  assert.equal(turns[1].text, assistantText);
  assert.ok(isCompleteCanonicalCaptureBatch(turns), 'a David + Luca pair is a complete Antigravity exchange');
  assert.deepEqual(turns.map((t) => formatChatCaptureSpeakerLabel(t)), ['David [Antigravity]', 'Luca [Antigravity]']);
});

test('a retry with the same identity appends nothing; changed bytes under that identity are refused', () => {
  const p = paths('retry');
  const exchange = { source: 'antigravity' as const, userText: 'hello', assistantText: 'hi', turnId: 'ag-conv-1-7', ...p };
  appendCanonicalConversationExchange(exchange);
  const size = readFileSync(p.capturePath).length;
  assert.deepEqual(appendCanonicalConversationExchange(exchange).appendedSpeakers, []);
  assert.equal(readFileSync(p.capturePath).length, size, 'the exact retry wrote no bytes');
  assert.throws(() => appendCanonicalConversationExchange({ ...exchange, assistantText: 'hi, changed' }), /different assistant text/);
});

test('the four-channel envelope rule stays Replit-only and never applies to Antigravity', () => {
  assert.equal(requiresFourChannelEnvelope({ speaker: 'LUCA', source: 'replit' }), true);
  assert.equal(requiresFourChannelEnvelope({ speaker: 'LUCA', source: undefined }), true, 'legacy unsourced Luca turns keep the rule');
  assert.equal(requiresFourChannelEnvelope({ speaker: 'LUCA', source: 'antigravity' }), false);
  assert.equal(requiresFourChannelEnvelope({ speaker: 'LUCA', source: 'claude-code' }), false);
  assert.equal(requiresFourChannelEnvelope({ speaker: 'DAVID', source: 'replit' }), false);
});
