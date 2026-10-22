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
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { classifyUserEntry, hasProvenanceFields } from './runtime-entries.mjs';

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
  // The transcript marks the re-injected summary itself (isCompactSummary).
  // The text prefix is only a fallback for entries with no provenance fields,
  // so a founder message that happens to quote that sentence is still kept.
  if (entry.isCompactSummary === true) return false;
  const byPrefix = !hasProvenanceFields(entry);
  const isSummaryText = text => byPrefix && text.startsWith(COMPACTION_SUMMARY_PREFIX);
  const content = entry.message?.content;
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed.length > 0 && !isSummaryText(trimmed);
  }
  if (Array.isArray(content)) {
    return content.some(block => block && block.type === 'text' && block.text?.trim()
      && !isSummaryText(block.text.trim()));
  }
  return false;
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

  let lastUserIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isRealUserMessage(entries[i])) {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return; // nothing real to record yet

  // A runtime metadata entry (isMeta) written right after a founder message,
  // before any reply text, belongs to that message: an attached image's
  // "[Image: source: ...]" entry, for example. Without this the hook recorded
  // the image path as David and dropped the founder's actual words. Once reply
  // text has started, a metadata entry is not folded back: re-selecting the
  // earlier message would resend an already-recorded turn with a different
  // reply, so the metadata entry stays the turn's start and is not recorded.
  if (entries[lastUserIdx].isMeta === true) {
    let j = lastUserIdx - 1;
    while (j >= 0 && !(isRealUserMessage(entries[j]) && entries[j].isMeta !== true)) {
      if (entries[j].type === 'assistant' && extractText(entries[j].message?.content).trim()) { j = -1; break; }
      j--;
    }
    if (j >= 0) lastUserIdx = j;
  }

  const userText = extractText(entries[lastUserIdx].message?.content).trim();
  // A turn the runtime started (task notice, system reminder, scheduled task,
  // classifier notice, image metadata, slash command) has no founder words to
  // record. Recording it would label runtime text as David. The transcript's
  // own provenance fields decide (runtime-entries.mjs). Nothing is recorded for
  // such a turn; the reply stays in the Claude Code transcript until a
  // non-dialogue label exists.
  const author = classifyUserEntry(entries[lastUserIdx]);
  if (!author.founder) {
    console.error(`[record-stop-turn] turn was started by the runtime (${author.basis}), not by David; nothing recorded`);
    return;
  }
  const assistantText = entries
    .slice(lastUserIdx + 1)
    .filter(entry => entry.type === 'assistant')
    .map(entry => extractText(entry.message?.content))
    .filter(Boolean)
    .join('\n\n')
    .trim();

  if (!userText || !assistantText) return; // incomplete turn -- skip silently, will catch next Stop

  let tmpDir;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-stop-hook-'));
  } catch (err) {
    console.error('[record-stop-turn] could not create temp dir:', err instanceof Error ? err.message : err);
    return;
  }
  const davidFile = join(tmpDir, 'david.txt');
  const assistantFile = join(tmpDir, 'assistant.txt');
  writeFileSync(davidFile, userText, 'utf8');
  writeFileSync(assistantFile, assistantText, 'utf8');

  // Stable per-turn identity: same session + same transcript position always
  // produces the same id, so a retry (or an accidental double-fire) is a
  // safe no-op on the server side rather than a duplicate row.
  const turnId = `cc-${sessionId}-${lastUserIdx}`.replace(/[^A-Za-z0-9-]/g, '-');

  const result = spawnSync(
    'npx',
    [
      'tsx', '--env-file-if-exists=.env', 'server/scripts/record-exchange.ts',
      '--source', 'claude-code', '--remote', REMOTE_URL,
      '--david-file', davidFile, '--assistant-file', assistantFile,
      '--turn-id', turnId, '--no-wait',
    ],
    { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 20000, shell: true },
  );
  if (result.status !== 0) {
    console.error('[record-stop-turn] record-exchange failed:', result.stderr || result.stdout || `exit ${result.status}`);
  }
}

main();
