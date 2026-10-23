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
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

  // Absorbed messages still unanswered when the turn opened: back to the
  // previous assistant text or user message, whichever comes first.
  const carried = [];
  for (let i = lastUserIdx - 1; i >= 0; i--) {
    if (hasAssistantText(entries[i]) || isRealUserMessage(entries[i])) break;
    if (isAbsorbedHumanPrompt(entries[i])) carried.unshift(extractText(entries[i].attachment.prompt).trim());
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
    queueExchange(OUTBOX_DIR, { turnId, userText: exchange.userText, assistantText: exchange.assistantText });
  }
  deliverOutbox({ outboxDir: OUTBOX_DIR, send: recordExchange });
}

const OUTBOX_DIR = join(PROJECT_ROOT, '.local', 'record-stop-turn', 'outbox');
/** The registered Stop hook timeout is 25 s; leave room to exit cleanly. */
const DELIVERY_BUDGET_MS = 21000;
/** Below this, a send cannot complete in time, so it is left for the next Stop. */
const MIN_SEND_MS = 4000;
const PER_SEND_MAX_MS = 20000;

/** Writes one exchange to the outbox (replacing an older version of the same turn). */
export function queueExchange(outboxDir, item) {
  mkdirSync(outboxDir, { recursive: true });
  writeFileSync(join(outboxDir, `${item.turnId}.json`), JSON.stringify(item), 'utf8');
}

/**
 * Sends queued exchanges oldest first, within one shared deadline. A sent item
 * is removed; a failed or unattempted one stays for the next Stop. The server
 * treats a turn id it already holds as a no-op, so a resend is safe.
 */
export function deliverOutbox({ outboxDir, send, now = Date.now, budgetMs = DELIVERY_BUDGET_MS }) {
  const started = now();
  let names;
  try {
    names = readdirSync(outboxDir).filter(n => n.endsWith('.json'));
  } catch {
    return { sent: 0, left: 0 };
  }
  const queued = names
    .map(name => ({ name, mtime: statSync(join(outboxDir, name)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
  let sent = 0;
  for (const { name } of queued) {
    const remaining = budgetMs - (now() - started);
    if (remaining < MIN_SEND_MS) break;
    let item;
    try {
      item = JSON.parse(readFileSync(join(outboxDir, name), 'utf8'));
    } catch {
      continue; // unreadable: left in place for inspection, never deleted unseen
    }
    if (send(item, Math.min(PER_SEND_MAX_MS, remaining))) {
      rmSync(join(outboxDir, name), { force: true });
      sent++;
    }
  }
  return { sent, left: queued.length - sent };
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
