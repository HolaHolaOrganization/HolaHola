import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Claude Code turns reach the canonical conversation record only through the
// Stop hook. Its registration used to live in the untracked
// .claude/settings.local.json, so losing that file would have stopped capture
// silently (founder decision 2026-10-19: track it in git). This guard fails CI
// if the tracked settings stop registering the hook.

const settingsPath = resolve('.claude/settings.json');
const hookPath = resolve('.claude/hooks/record-stop-turn.mjs');

test('tracked .claude/settings.json registers the Stop capture hook', () => {
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
    hooks?: { Stop?: Array<{ hooks?: Array<{ type?: string; command?: string }> }> };
  };
  const commands = (settings.hooks?.Stop ?? []).flatMap((group) => group.hooks ?? [])
    .filter((hook) => hook.type === 'command').map((hook) => hook.command ?? '');
  assert.ok(commands.some((command) => /record-stop-turn\.mjs/.test(command)), 'Stop hook must run record-stop-turn.mjs');
  assert.ok(commands.every((command) => !/[A-Za-z]:\\/.test(command)), 'the registration must not hard-code a machine-specific absolute path');
});

test('the registered capture hook script is tracked and present', () => {
  assert.ok(existsSync(hookPath));
  assert.match(readFileSync(hookPath, 'utf8'), /--source', 'claude-code'/);
});
