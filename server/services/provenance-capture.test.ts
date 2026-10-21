import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { verifyProvenance } from './canonical-attribution';
import { appendCanonicalConversationExchange } from './canonical-conversation-capture';
import { buildClaudeCodeProvenance } from './provenance-builder';
import { parseChatCaptureFromOffset } from './transcript-parser';

const root = mkdtempSync(join(tmpdir(), 'provenance-capture-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const paths = () => { n++; return { capturePath: join(root, `capture-${n}.log`), ingressLockPath: join(root, `lock-${n}`) }; };

describe('provenance through the canonical capture file', () => {
  test('an assistant block carries verified provenance that parses back intact', () => {
    const { assistantText, provenance } = buildClaudeCodeProvenance([
      { text: 'First — résumé ✓', model: 'claude-opus-5-5' },
      { text: 'Second', model: 'claude-sonnet-5-5' },
    ]);
    assert.ok(provenance);
    const p = paths();
    appendCanonicalConversationExchange({ source: 'claude-code', userText: 'q', assistantText, turnId: 'cc-prov-1', provenance, ...p });
    const turns = parseChatCaptureFromOffset(p.capturePath, 0).turns;
    assert.equal(turns.length, 2);
    assert.equal(turns[0].provenance, undefined, 'David turns carry no provenance');
    assert.deepEqual(turns[1].provenance, provenance);
    assert.equal(turns[1].text, assistantText, 'the body is byte-identical');
    assert.equal(verifyProvenance(turns[1].provenance, turns[1].text, 'claude-code').status, 'valid');
  });

  test('without provenance the capture block has no provenance header (unchanged format)', () => {
    const p = paths();
    appendCanonicalConversationExchange({ source: 'claude-code', userText: 'q', assistantText: 'a', turnId: 'cc-prov-2', ...p });
    assert.doesNotMatch(readFileSync(p.capturePath, 'utf8'), /PROVENANCE-B64/);
    assert.equal(parseChatCaptureFromOffset(p.capturePath, 0).turns[1].provenance, undefined);
  });

  test('an exact retry writes no bytes and keeps the first provenance', () => {
    const first = buildClaudeCodeProvenance([{ text: 'answer', model: 'claude-opus-5-5' }]);
    const second = buildClaudeCodeProvenance([{ text: 'answer', model: 'claude-sonnet-5-5' }]);
    const p = paths();
    appendCanonicalConversationExchange({ source: 'claude-code', userText: 'q', assistantText: 'answer', turnId: 'cc-prov-3', provenance: first.provenance, ...p });
    const size = statSync(p.capturePath).size;
    const retry = appendCanonicalConversationExchange({ source: 'claude-code', userText: 'q', assistantText: 'answer', turnId: 'cc-prov-3', provenance: second.provenance, ...p });
    assert.deepEqual(retry.appendedSpeakers, []);
    assert.equal(statSync(p.capturePath).size, size);
    assert.deepEqual(parseChatCaptureFromOffset(p.capturePath, 0).turns[1].provenance, first.provenance);
  });

  test('an undecodable provenance header keeps the turn and fails verification', () => {
    const p = paths();
    appendCanonicalConversationExchange({ source: 'claude-code', userText: 'q', assistantText: 'a', turnId: 'cc-prov-4', ...p });
    // Inject into the assistant (last) block only.
    const raw = readFileSync(p.capturePath, 'utf8');
    const at = raw.lastIndexOf('CHARLEN: 1');
    writeFileSync(p.capturePath, `${raw.slice(0, at)}PROVENANCE-B64: bm90IGpzb24=\n${raw.slice(at)}`);
    const turn = parseChatCaptureFromOffset(p.capturePath, 0).turns[1];
    assert.equal(turn.text, 'a');
    assert.equal(verifyProvenance(turn.provenance, turn.text, 'claude-code').status, 'invalid');
  });
});
