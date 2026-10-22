/**
 * Turn identity for the Stop hook (record-stop-turn.mjs).
 *
 * The id must be the same every time the hook fires for the same user message
 * (a retry or double-fire is then a server-side no-op) and different for two
 * distinct messages, even when their text is identical.
 *
 * Version 2 uses the user entry's own transcript `uuid`, which Claude Code
 * assigns once per entry, so the id no longer depends on the entry's position
 * among parsed lines. Version 1 (the position) is kept for every message
 * that predates version 2's first run in this checkout: a message the old hook
 * already recorded keeps its id, so the switch cannot record it twice.
 */
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const SAFE = /[^A-Za-z0-9-]/g;

/** Version 1: position of the user entry among the parsed transcript lines. */
export function positionTurnId(sessionId, index) {
  return `cc-${sessionId}-${index}`.replace(SAFE, '-');
}

/**
 * The id for one user entry. `activatedAt` is when version 2 first ran here
 * (ISO string), or null if it is unknown, in which case version 1 is used.
 */
export function stopTurnId({ sessionId, entry, index, activatedAt }) {
  const uuid = typeof entry?.uuid === 'string' ? entry.uuid.trim() : '';
  const at = typeof entry?.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  const since = activatedAt ? Date.parse(activatedAt) : NaN;
  if (!uuid || !Number.isFinite(at) || !Number.isFinite(since) || at < since) {
    return positionTurnId(sessionId, index);
  }
  return `cc-${sessionId}-u-${uuid}`.replace(SAFE, '-');
}

/**
 * Reads, or on first use creates, the version-2 activation marker. Created
 * exclusively, so the first writer's time stands. Returns null when it can
 * be neither read nor created; the hook then keeps version 1.
 */
export function readOrCreateActivation(markerPath, now = new Date()) {
  const read = () => {
    const parsed = JSON.parse(readFileSync(markerPath, 'utf8'));
    return typeof parsed?.activatedAt === 'string' && Number.isFinite(Date.parse(parsed.activatedAt)) ? parsed.activatedAt : null;
  };
  try {
    return read();
  } catch (error) {
    if (error?.code !== 'ENOENT') return null;
  }
  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    const fd = openSync(markerPath, 'wx');
    try {
      writeSync(fd, JSON.stringify({ activatedAt: now.toISOString() }) + '\n');
    } finally {
      closeSync(fd);
    }
    return now.toISOString();
  } catch (error) {
    if (error?.code !== 'EEXIST') return null;
    try { return read(); } catch { return null; }
  }
}
