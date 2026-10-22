#!/usr/bin/env node
/**
 * Stop hook: keeps a turn from ending while the coordination listener needs
 * attention, so no runtime has to remember to check or re-arm it.
 *
 * Blocks the stop (once) when either:
 *   - a coordination event is pending in the listener's local receipts, or
 *   - the listener is not running (no watch.lock, or a heartbeat older than
 *     the listener's own 90s staleness bound).
 * The block reason tells the agent what to do. On the follow-up stop
 * (stop_hook_active) it only warns, so it can never trap a session in a loop.
 *
 * Reads local listener state only; makes no network calls. A runtime that has
 * no listener state directory is not using the listener and is left alone.
 * Any error fails open (exit 0, no block).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// .claude/hooks/listener-guard.mjs -> project root is two levels up.
const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const STATE_DIR = process.env.LUCAMSG_STATE_DIR || join(PROJECT_ROOT, '.local', 'lucamsg-listener');
const STALE_MS = 90_000;

export function assessListener(stateDir, now = Date.now()) {
  if (!existsSync(stateDir)) return { applies: false, problems: [] };
  const problems = [];
  const pendingDir = join(stateDir, 'pending');
  const pending = existsSync(pendingDir) ? readdirSync(pendingDir).filter(f => f.endsWith('.json')) : [];
  if (pending.length) {
    problems.push(`${pending.length} coordination event(s) pending (${pending.map(f => f.slice(0, -5)).join(', ')}): read each, mark observed then processed, and ack-feed`);
  }
  let running = existsSync(join(stateDir, 'watch.lock'));
  if (running) {
    try {
      const at = Date.parse(JSON.parse(readFileSync(join(stateDir, 'heartbeat.json'), 'utf8')).at);
      running = Number.isFinite(at) && now - at >= 0 && now - at <= STALE_MS;
    } catch {
      running = false;
    }
  }
  if (!running) problems.push('the coordination listener is not running (no lock or stale heartbeat): re-arm it in continuous mode with --resume');
  return { applies: true, problems };
}

function main() {
  let input = {};
  try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* fail open */ }
  const { applies, problems } = assessListener(STATE_DIR);
  if (!applies || problems.length === 0) return;
  const text = `Listener guard: ${problems.join('; ')}.`;
  if (input.stop_hook_active) {
    process.stdout.write(JSON.stringify({ systemMessage: `${text} (not blocking again this turn)` }));
  } else {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: text }));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch { /* fail open */ }
  process.exit(0);
}
