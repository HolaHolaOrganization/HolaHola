#!/usr/bin/env node
/**
 * Stop hook: records the just-finished David <-> Claude Code turn into
 * HolaHola's canonical conversation record via record-exchange.ts's remote
 * intake endpoint (POST /api/internal/canonical-conversation-exchange).
 *
 * Best-effort only: this must never block or fail the session. Every error
 * path logs to stderr and exits 0 rather than surfacing to the user.
 *
 * Finds the last "real" user message in the transcript (plain text, not a
 * tool_result-only message), then concatenates every text block from every
 * assistant message after it -- this is the dialogue for the turn that just
 * completed, independent of how many tool calls happened in between.
 *
 * A message David sends while a turn is running is absorbed into that turn as
 * a queued_command attachment (origin human, commandMode prompt), not as a
 * user entry. Each absorbed message starts its own exchange: the assistant
 * text before it stays with the earlier message, the text after it belongs to
 * the absorbed one. Each exchange keeps the stable id of its own position.
 *
 * Delivery goes through a local outbox (.local/record-stop-turn/outbox): each
 * exchange is written there first, then sent within one deadline that fits the
 * registered hook timeout. Whatever is not sent in time, or fails, stays queued
 * and is retried at the next Stop.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// .claude/hooks/record-stop-turn.mjs -> project root is two levels up.
const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REMOTE_URL = process.env.HOLAHOLA_STOP_HOOK_URL || 'https://getholahola.com';

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n\n');
}

// Claude Code re-injects the pre-compaction summary as a plain-string "user"
// message when a session resumes -- it must never be recorded as something
// David said.
const COMPACTION_SUMMARY_PREFIX = 'This session is being continued from a previous conversation';

function isRealUserMessage(entry) {
  if (!entry || entry.type !== 'user') return false;
  const content = entry.message?.content;
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed.length > 0 && !trimmed.startsWith(COMPACTION_SUMMARY_PREFIX);
  }
  if (Array.isArray(content)) {
    return content.some(block => block && block.type === 'text' && block.text?.trim()
      && !block.text.trim().startsWith(COMPACTION_SUMMARY_PREFIX));
  }
  return false;
}

/**
 * A message David sent mid-turn, absorbed as a queued_command attachment, that
 * carries text. One without text (empty, or an image only) is not a start: it
 * would split the turn with no words of David's to record, and the reply after
 * it stays with the open exchange, as before.
 */
function isAbsorbedHumanPrompt(entry) {
  const a = entry?.type === 'attachment' ? entry.attachment : null;
  return a?.type === 'queued_command' && a.origin?.kind === 'human' && a.commandMode === 'prompt'
    && extractText(a.prompt).trim().length > 0;
}

function hasAssistantText(entry) {
  return entry?.type === 'assistant' && extractText(entry.message?.content).trim().length > 0;
}

/**
 * The exchanges to record for the turn that just completed: the last real user
 * message, then one more per absorbed mid-turn message after it. Each runs to
 * the next start. Consecutive messages with no assistant text between them are
 * one exchange: their texts, in order, so a message is never dropped for having
 * no reply of its own. That includes absorbed messages left unanswered at an
 * earlier Stop: they precede this turn's opening message with no assistant
 * text between, so they open its exchange, under the opening message's
 * existing id. An exchange still without assistant text is not returned.
 *
 * Limitation: the opening message is the last user entry with text, so a
 * runtime notice shaped as a user entry can still become the anchor and hide
 * an absorbed message before it. Notice attribution is out of this change's scope.
 */
export function exchangesForStop(entries) {
  let lastUserIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isRealUserMessage(entries[i])) {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return [];

  // David's messages still unanswered when this turn opened: every absorbed
  // prompt and every explicitly human user message back to the previous
  // assistant text, however many earlier turns opened and ended without a
  // reply. None of them was returned before, because an exchange without
  // assistant text never is. Runtime-shaped user entries (notices, entries
  // without provenance) are skipped: never carried into David's words.
  const carried = [];
  for (let i = lastUserIdx - 1; i >= 0; i--) {
    if (hasAssistantText(entries[i])) break;
    if (isAbsorbedHumanPrompt(entries[i])) carried.unshift(extractText(entries[i].attachment.prompt).trim());
    else if (isRealUserMessage(entries[i]) && entries[i].origin?.kind === 'human') carried.unshift(extractText(entries[i].message?.content).trim());
  }

  const starts = [lastUserIdx];
  for (let i = lastUserIdx + 1; i < entries.length; i++) {
    if (isAbsorbedHumanPrompt(entries[i])) starts.push(i);
  }

  const exchanges = [];
  let pending = carried.length ? { index: lastUserIdx, texts: carried } : null; // messages not yet answered
  starts.forEach((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : entries.length;
    const source = start === lastUserIdx ? entries[start].message?.content : entries[start].attachment.prompt;
    const text = extractText(source).trim();
    pending = pending ?? { index: start, texts: [] };
    if (text) pending.texts.push(text);
    const assistantText = entries
      .slice(start + 1, end)
      .filter(entry => entry.type === 'assistant')
      .map(entry => extractText(entry.message?.content))
      .filter(Boolean)
      .join('\n\n')
      .trim();
    if (!assistantText) return; // no reply yet: this message joins the next one's exchange
    const userText = pending.texts.join('\n\n');
    if (userText) exchanges.push({ index: pending.index, userText, assistantText });
    pending = null;
  });
  return exchanges;
}

function main() {
  let input = '';
  try {
    input = readFileSync(0, 'utf8');
  } catch {
    return;
  }
  if (!input.trim()) return;

  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return;
  }

  const transcriptPath = payload.transcript_path;
  const sessionId = payload.session_id || 'unknown-session';
  if (!transcriptPath) return;

  let lines;
  try {
    lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  } catch (err) {
    console.error('[record-stop-turn] could not read transcript:', err instanceof Error ? err.message : err);
    return;
  }

  const entries = lines
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);

  // Each exchange goes into the outbox first, then the outbox is delivered within
  // the hook's deadline. Anything not delivered stays for the next Stop.
  for (const exchange of exchangesForStop(entries)) {
    const turnId = `cc-${sessionId}-${exchange.index}`.replace(/[^A-Za-z0-9-]/g, '-');
    try {
      queueExchange(OUTBOX_DIR, { turnId, userText: exchange.userText, assistantText: exchange.assistantText });
    } catch (err) {
      console.error('[record-stop-turn] could not queue', turnId, '(any earlier queued version is kept):', err instanceof Error ? err.message : err);
    }
  }
  deliverOutbox({ outboxDir: OUTBOX_DIR, send: recordExchange });
}

const OUTBOX_DIR = join(PROJECT_ROOT, '.local', 'record-stop-turn', 'outbox');
/** The registered Stop hook timeout is 25 s; leave room to exit cleanly. */
const DELIVERY_BUDGET_MS = 21000;
/** Below this, a send cannot complete in time, so it is left for the next Stop. */
const MIN_SEND_MS = 4000;
const PER_SEND_MAX_MS = 20000;

/** One file per exchange version: <turnId>.<content hash>.json. turnIds contain no dots. */
function versionName(item) {
  const hash = createHash('sha256').update(`${item.userText}\u0000${item.assistantText}`, 'utf8').digest('hex').slice(0, 16);
  return `${item.turnId}.${hash}.json`;
}

function turnIdOf(name) {
  return name.split('.')[0];
}

function safeList(dir) {
  try {
    return readdirSync(dir).filter(n => n.endsWith('.json'));
  } catch {
    return [];
  }
}

/**
 * Writes one exchange version to the outbox. The file appears only complete:
 * it is written under a temporary name and renamed into place, so an
 * interrupted write never truncates a valid queued version. A producer never
 * deletes anything, so concurrent producers cannot remove each other's
 * versions; superseded versions are removed only by a drainer, after a newer
 * version of the same turn was sent.
 */
export function queueExchange(outboxDir, item, io = { writeFileSync, renameSync }) {
  mkdirSync(outboxDir, { recursive: true });
  const name = versionName(item);
  const finalPath = join(outboxDir, name);
  if (existsSync(finalPath)) return;
  const tmpPath = join(outboxDir, `${name}.${process.pid}.${Date.now()}.tmp`);
  try {
    io.writeFileSync(tmpPath, JSON.stringify(item), 'utf8');
    io.renameSync(tmpPath, finalPath);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err; // the caller logs it; any older queued version is untouched
  }
}

/**
 * Sends queued exchanges within one shared deadline: for each turn only its
 * newest queued version, newest turns first, so a version that keeps failing
 * (the server rejects changed content under a turn id it already holds) can
 * never use up the budget ahead of newer exchanges. A failed or unattempted
 * version stays on disk for the next Stop and for inspection.
 *
 * A successful send removes exactly the file it sent, then the versions of the
 * same turn that are strictly older than it (superseded). A version queued
 * after the one sent is never removed.
 *
 * Ownership: producers only add files; only drainers remove them. Any hook
 * process may drain; there is no lock. Two drainers can send the same version,
 * which is safe because the server treats a turn id it already holds with
 * identical content as a no-op. Files another process removes mid-drain are
 * skipped, never an uncaught failure.
 */
export function deliverOutbox({ outboxDir, send, now = Date.now, budgetMs = DELIVERY_BUDGET_MS }) {
  const started = now();
  const byTurn = new Map(); // turnId -> versions, oldest first
  for (const name of safeList(outboxDir)) {
    let mtime;
    try {
      mtime = statSync(join(outboxDir, name)).mtimeMs;
    } catch {
      continue; // removed by another process since the listing
    }
    const turnId = turnIdOf(name);
    if (!byTurn.has(turnId)) byTurn.set(turnId, []);
    byTurn.get(turnId).push({ name, mtime });
  }
  const order = (a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name);
  for (const versions of byTurn.values()) versions.sort(order);
  const turns = [...byTurn.values()].sort((a, b) => order(b.at(-1), a.at(-1))); // newest turn first
  let sent = 0;
  for (const versions of turns) {
    const remaining = budgetMs - (now() - started);
    if (remaining < MIN_SEND_MS) break;
    const chosen = versions.at(-1);
    let item;
    try {
      item = JSON.parse(readFileSync(join(outboxDir, chosen.name), 'utf8'));
    } catch {
      continue; // gone, or unreadable: never deleted unseen
    }
    if (send(item, Math.min(PER_SEND_MAX_MS, remaining))) {
      rmSync(join(outboxDir, chosen.name), { force: true });
      for (const older of versions.slice(0, -1)) {
        try {
          JSON.parse(readFileSync(join(outboxDir, older.name), 'utf8'));
          rmSync(join(outboxDir, older.name), { force: true });
        } catch {
          // gone already, or unreadable: never deleted unseen
        }
      }
      sent++;
    }
  }
  return { sent, left: safeList(outboxDir).length };
}

function recordExchange({ turnId, userText, assistantText }, timeoutMs) {
  let tmpDir;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-stop-hook-'));
  } catch (err) {
    console.error('[record-stop-turn] could not create temp dir:', err instanceof Error ? err.message : err);
    return false;
  }
  const davidFile = join(tmpDir, 'david.txt');
  const assistantFile = join(tmpDir, 'assistant.txt');
  writeFileSync(davidFile, userText, 'utf8');
  writeFileSync(assistantFile, assistantText, 'utf8');

  // Stable per-turn identity (cc-<session>-<position>): a retry or an accidental
  // double-fire is a safe no-op on the server side rather than a duplicate row.
  const result = spawnSync(
    'npx',
    [
      'tsx', '--env-file-if-exists=.env', 'server/scripts/record-exchange.ts',
      '--source', 'claude-code', '--remote', REMOTE_URL,
      '--david-file', davidFile, '--assistant-file', assistantFile,
      '--turn-id', turnId, '--no-wait',
    ],
    { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: timeoutMs, shell: true },
  );
  if (result.status !== 0) {
    console.error('[record-stop-turn] record-exchange failed (kept for the next Stop):', result.stderr || result.stdout || `exit ${result.status}`);
    return false;
  }
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
