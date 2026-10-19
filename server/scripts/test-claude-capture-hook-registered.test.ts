import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Claude Code turns reach the canonical conversation record only through the
// Stop hook. Its registration used to live in the untracked
// .claude/settings.local.json, so losing that file would have stopped capture
// silently (founder decision 2026-10-19: track it in git). This guard fails CI
// unless the tracked settings register the exact reviewed, portable
// invocation -- not merely a command that mentions the script.

/** The one reviewed invocation: project-relative, run by node, no wrappers. */
const APPROVED_CAPTURE_COMMAND = 'node .claude/hooks/record-stop-turn.mjs';

function isApprovedCaptureCommand(command: string): boolean {
  return command === APPROVED_CAPTURE_COMMAND;
}

type Settings = { hooks?: { Stop?: Array<{ hooks?: Array<{ type?: string; command?: string }> }> } };

function stopCommands(settings: Settings): string[] {
  return (settings.hooks?.Stop ?? []).flatMap((group) => group.hooks ?? [])
    .filter((hook) => hook.type === 'command').map((hook) => hook.command ?? '');
}

test('tracked .claude/settings.json registers exactly the reviewed portable capture invocation', () => {
  const settings = JSON.parse(readFileSync(resolve('.claude/settings.json'), 'utf8')) as Settings;
  assert.ok(stopCommands(settings).some(isApprovedCaptureCommand), `Stop hook must run exactly: ${APPROVED_CAPTURE_COMMAND}`);
});

test('commands that only mention the script, wrap it, or pin a machine-specific path are not accepted', () => {
  for (const command of [
    'echo record-stop-turn.mjs',
    'echo node .claude/hooks/record-stop-turn.mjs',
    'node /home/runner/workspace/.claude/hooks/record-stop-turn.mjs',
    'node C:/Users/David/HolaHola/.claude/hooks/record-stop-turn.mjs',
    'node "C:\\Users\\David\\HolaHola\\.claude\\hooks\\record-stop-turn.mjs"',
    'node .claude/hooks/record-stop-turn.mjs || true',
    'true; node .claude/hooks/record-stop-turn.mjs',
    ' node .claude/hooks/record-stop-turn.mjs',
    'node ./.claude/hooks/record-stop-turn.mjs.bak',
  ]) {
    assert.equal(isApprovedCaptureCommand(command), false, command);
  }
  assert.equal(isApprovedCaptureCommand(APPROVED_CAPTURE_COMMAND), true);
});

test('the registered capture hook script is tracked and present', () => {
  const hookPath = resolve('.claude/hooks/record-stop-turn.mjs');
  assert.ok(existsSync(hookPath));
  assert.match(readFileSync(hookPath, 'utf8'), /--source', 'claude-code'/);
});
