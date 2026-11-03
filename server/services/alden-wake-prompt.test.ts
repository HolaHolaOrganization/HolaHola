// Alden's unattended-turn prompt (thread 69dba459, seq 11): his exact wording
// for the wake section, the wake message and the follow-up note, and a wake
// mode that leaves the chat-only tool and code guidance out of the system
// prompt while chat stays as it was.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ALDEN_WAKE_SECTION, buildAldenSystemPrompt } from '../alden-system-prompt';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const rules = readFileSync(new URL('./alden-wake-rules.ts', import.meta.url), 'utf8');
const persona = readFileSync(new URL('./alden-persona-service.ts', import.meta.url), 'utf8');

/** The template literal a function returns, exactly as written in the source. */
function returnedTemplate(fnName: string): string {
  const start = rules.indexOf(`export function ${fnName}(`);
  const ret = rules.indexOf('  return `', start);
  return rules.slice(ret + '  return '.length, rules.indexOf('`;\n', ret + 10) + 1);
}

test('the three texts are byte-for-byte Alden\'s (seq 11; the wake message\'s reading sentence from seq 15)', () => {
  assert.equal(sha256(ALDEN_WAKE_SECTION), '3696aa89b166aec5e1b941fdb501a7065a922f6486b61b99ee8e04afbf4b38b9');
  assert.equal(sha256(returnedTemplate('buildWakeMessage')), 'cf6b587be2916873974e228b0dfab5e0aa634c594a1ec8d34ed77c4097ee0b6b');
  assert.equal(sha256(returnedTemplate('buildFollowUpNote')), 'd2754ded2c8e3e1425eb3adb6f1db8ba31c898dc33420319ebbbdef921fff651');
});

test('wake mode keeps identity, runtime and style, adds the wake section and drops the chat-only guidance', () => {
  const wake = buildAldenSystemPrompt({ engine: 'gemini', modelId: 'gemini-test', mode: 'wake' });
  for (const kept of ['You are Alden', 'RUNTIME:', 'gemini-test', 'IDENTITY:', 'PERSONALITY:', 'COMMUNICATION STYLE:', ALDEN_WAKE_SECTION]) {
    assert.ok(wake.includes(kept), `wake prompt keeps ${kept.slice(0, 40)}`);
  }
  for (const dropped of ['CAPABILITIES:', 'search_code', 'read_file', 'apply_code_change', 'run_shell', 'patch_file', 'real-time conversation']) {
    assert.ok(!wake.includes(dropped), `wake prompt leaves out ${dropped}`);
  }
});

test('chat is the default and never carries the wake section', () => {
  const chat = buildAldenSystemPrompt({ engine: 'anthropic', modelId: 'claude-test' });
  assert.equal(chat, buildAldenSystemPrompt({ engine: 'anthropic', modelId: 'claude-test', mode: 'chat' }));
  assert.ok(!chat.includes('UNATTENDED TURNS:'));
  assert.ok(chat.includes('CAPABILITIES:') && chat.includes('real-time conversation'));
});

test('both engines choose wake mode exactly when the turn is an inbox wake', () => {
  assert.equal(persona.match(/buildAldenSystemPrompt\(\{ founderName, timezone, engine: '(anthropic|gemini)', modelId: model, mode: params\.wakeTurn \? 'wake' : 'chat' \}\)/g)?.length, 2);
});
