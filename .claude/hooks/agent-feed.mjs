#!/usr/bin/env node
/**
 * Agent awareness feed hook (hat feed design r5.1 §7, stage F-P3).
 *
 * Meant for SessionStart (the epoch's one bootstrap page) and UserPromptSubmit
 * (a bounded notice, only when something unseen is pending). It runs the feed
 * client and passes the client's stdout through, which Claude Code adds to the
 * session context.
 *
 * NOT REGISTERED in any settings file by this change. Registering it (with a
 * timeout of at least 12 s) and the actor's one-time enrollment need the
 * founder's explicit go-ahead.
 *
 * Delivery boundary: the client writes each complete block as one JSON frame
 * line, and acknowledges a receipt only after that. This hook forwards every
 * complete block it received even if the client later fails or times out, so
 * an acknowledged item has always reached the session. An unacknowledged item
 * may be shown again later (a duplicate), never lost.
 * Errors exit 0 with one bounded line on stderr; no feed context goes to stderr.
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

/** Must match FRAME_PREFIX in server/scripts/agent-feed-client.ts. */
export const FRAME_PREFIX = '[[agent-feed:frame]]';
/**
 * The client's time limit. The hook's registered timeout must exceed it (12 s
 * or more). Tests may lower it through AGENT_FEED_CHILD_TIMEOUT_MS, clamped to
 * 1 to 9 seconds, so it can never be raised past the hook's own budget.
 */
export const CHILD_TIMEOUT_MS = Math.min(9000, Math.max(1000, Number(process.env.AGENT_FEED_CHILD_TIMEOUT_MS) || 9000));

/**
 * The context to forward: every complete frame the client wrote, whatever
 * happened afterwards (a later failure, a nonzero exit, a timeout). A frame is
 * one newline-terminated line: FRAME_PREFIX, then the block as a JSON string.
 * The client acknowledges a receipt only after its frame was written. The
 * unterminated tail, any line that is not a frame, and any frame that does not
 * parse as a JSON string are dropped, so a truncated block is never forwarded
 * and text inside a block can never end or forge one.
 */
export function deliverable(stdout) {
  if (typeof stdout !== 'string') return '';
  const lines = stdout.split('\n');
  lines.pop(); // unterminated (possibly empty) tail
  const blocks = [];
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.startsWith(FRAME_PREFIX)) continue;
    try {
      const text = JSON.parse(line.slice(FRAME_PREFIX.length));
      if (typeof text === 'string' && text) blocks.push(text);
    } catch { /* not a complete frame */ }
  }
  return blocks.join('\n');
}

/** One bounded diagnostic line for the hook's stderr, or '' when the client ran cleanly. */
export function diagnostic(result) {
  const parts = [];
  if (result?.error) parts.push(`client could not run: ${result.error.code ?? result.error.message}`);
  if (result?.signal) parts.push(`client stopped by ${result.signal} (time limit ${CHILD_TIMEOUT_MS} ms)`);
  else if (typeof result?.status === 'number' && result.status !== 0) parts.push(`client exited ${result.status}`);
  const stderr = typeof result?.stderr === 'string' ? result.stderr.trim() : '';
  if (stderr) parts.push(stderr.replace(/\s+/g, ' '));
  const line = parts.join('; ');
  return line ? `[agent-feed] ${line.slice(0, 500)}` : '';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let out = '';
  let err = '';
  try {
    const cmd = feedCommand(JSON.parse(readFileSync(0, 'utf8') || '{}'));
    if (cmd) {
      const result = spawnSync(cmd.command, cmd.args, { cwd: cmd.cwd, encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, windowsHide: true });
      out = deliverable(result.stdout);
      err = diagnostic(result);
    }
  } catch (e) {
    err = `[agent-feed] hook error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
  }
  if (err) process.stderr.write(`${err}\n`);
  // Exit only after stdout has taken the context, so it is never cut off.
  if (out) process.stdout.write(`${out}\n`, () => process.exit(0));
  else process.exit(0);
}
