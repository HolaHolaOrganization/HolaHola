/** The Stop hook never records runtime-injected entries as David (.claude/hooks/runtime-entries.mjs). */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RUNTIME_ENTRY_OPENERS, isRuntimeInjectedText } from '../../.claude/hooks/runtime-entries.mjs';

const HOOK = fileURLToPath(new URL('../../.claude/hooks/record-stop-turn.mjs', import.meta.url));

describe('isRuntimeInjectedText', () => {
  test('each runtime kind is recognised by its exact opening bytes', () => {
    for (const text of [
      '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>',
      '<system-reminder>\nContext...\n</system-reminder>',
      '<scheduled-task name="holahola-inbox-proof" file="C:\\x\\SKILL.md">',
      '[SYSTEM NOTIFICATION - NOT USER INPUT]',
      'Your response above was stopped by a safety classifier — this is not a tool or API error.',
      '<command-name>/compact</command-name>',
      '<command-message>compact</command-message>',
      '<local-command-stdout>Compacted</local-command-stdout>',
      '   \n<task-notification>leading whitespace</task-notification>',
    ]) assert.equal(isRuntimeInjectedText(text), true, text.slice(0, 40));
    assert.equal(RUNTIME_ENTRY_OPENERS.length, 8);
  });

  test("founder text is never classified as runtime, even when it mentions a marker", () => {
    for (const text of [
      'yes for hat lables. As for who the hat was talking to...',
      'daniela is more than just a tutor here she is a cofounder, collaborator and friend',
      'what does <task-notification> mean in the transcript?',
      'I saw "Your response above was stopped by a safety classifier" earlier, what happened?',
      'system reminder: call me later',
      '',
    ]) assert.equal(isRuntimeInjectedText(text), false, text.slice(0, 40));
    assert.equal(isRuntimeInjectedText(undefined), false);
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
const user = (text: string) => ({ type: 'user', message: { content: text } });
const assistant = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

describe('the Stop hook', () => {
  test('a turn started by a runtime notice records nothing and never invokes record-exchange', () => {
    const result = runHook([
      user('please check the deploy'), assistant('Checking now.'),
      user('<task-notification>\n<task-id>b9</task-id>\n<status>completed</status>\n</task-notification>'),
      assistant('The deploy finished; #77 is live.'),
    ]);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /started by a runtime notice, not by David; nothing recorded/);
    assert.doesNotMatch(result.stderr, /record-exchange failed/);
  });

  test("a founder turn still goes to record-exchange (here it fails against the dead local port)", () => {
    const result = runHook([user('please check the deploy'), assistant('Checking now.')]);
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stderr, /runtime notice/);
    assert.match(result.stderr, /record-exchange failed/);
  });
});
