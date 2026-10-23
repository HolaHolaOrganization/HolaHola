#!/usr/bin/env node
/**
 * Agent awareness feed hook (hat feed design r5.1 §7, stage F-P3).
 *
 * Meant for SessionStart (the epoch's one bootstrap page) and UserPromptSubmit
 * (a bounded notice, only when something unseen is pending). It runs the feed
 * client and passes the client's stdout through, which Claude Code adds to the
 * session context.
 *
 * NOT REGISTERED in any settings file by this change. Registering it, and the
 * actor's one-time enrollment, need the founder's explicit go-ahead.
 * Any error fails open: nothing is printed and the exit code is 0.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// .claude/hooks/agent-feed.mjs -> project root is two levels up.
const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SESSION = /^[A-Za-z0-9._:-]{1,128}$/;
const COMMANDS = { SessionStart: 'session-start', UserPromptSubmit: 'prompt' };

/** The client invocation for one hook input, or null when the input is unusable. */
export function feedCommand(input, root = PROJECT_ROOT) {
  const command = COMMANDS[input?.hook_event_name];
  const sessionId = input?.session_id;
  if (!command || typeof sessionId !== 'string' || !SESSION.test(sessionId)) return null;
  return {
    command: process.execPath,
    args: [
      '--env-file-if-exists=.env',
      join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join(root, 'server', 'scripts', 'agent-feed-client.ts'),
      command, '--session', sessionId,
    ],
    cwd: root,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const cmd = feedCommand(JSON.parse(readFileSync(0, 'utf8') || '{}'));
    if (cmd) {
      const result = spawnSync(cmd.command, cmd.args, { cwd: cmd.cwd, encoding: 'utf8', timeout: 9000, windowsHide: true });
      if (result.status === 0 && result.stdout) process.stdout.write(result.stdout);
    }
  } catch { /* fail open */ }
  process.exit(0);
}
