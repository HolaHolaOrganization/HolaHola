#!/usr/bin/env node
/**
 * Claude Code transcript mirror launcher (recording-gap design R6.5, stage R-P3).
 *
 * Meant for Stop, StopFailure, UserPromptSubmit (async), PreCompact, SessionEnd
 * and SessionStart. It only starts a DETACHED background sync of this session's
 * transcript and returns at once: the session never waits on the network.
 *
 * NOT REGISTERED in any settings file by this change. Registering it activates a
 * new preservation writer and needs the founder's explicit go-ahead.
 * Any error fails open (exit 0).
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// .claude/hooks/mirror-sync.mjs -> project root is two levels up.
const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SESSION = /^[A-Za-z0-9-]{8,64}$/;

/** The detached sync command for one hook input, or null when the input is unusable. */
export function syncCommand(input, root = PROJECT_ROOT) {
  const sessionId = input?.session_id;
  const transcript = input?.transcript_path;
  if (typeof sessionId !== 'string' || !SESSION.test(sessionId) || typeof transcript !== 'string' || !transcript) return null;
  return {
    command: process.execPath,
    args: [
      '--env-file-if-exists=.env',
      join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join(root, 'server', 'scripts', 'claude-code-mirror-sync.ts'),
      '--transcript', transcript,
      '--session', sessionId,
    ],
    cwd: root,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const cmd = syncCommand(JSON.parse(readFileSync(0, 'utf8') || '{}'));
    if (cmd) spawn(cmd.command, cmd.args, { cwd: cmd.cwd, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch { /* fail open */ }
  process.exit(0);
}
