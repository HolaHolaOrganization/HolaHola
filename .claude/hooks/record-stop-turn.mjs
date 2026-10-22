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
import { readOrCreateActivation, stopTurnId } from './stop-turn-id.mjs';

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

  const userText = extractText(entries[lastUserIdx].message?.content).trim();
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
  // Per-entry text and the model the transcript reports for it, from the SAME
  // assistant entries flattened above. record-exchange builds attribution
  // provenance from these (design f5d77712 section 3.1) and binds it to the
  // exact assistantText bytes; it is dropped, never guessed, if they differ.
  const segmentsFile = join(tmpDir, 'segments.json');
  const segments = entries
    .slice(lastUserIdx + 1)
    .filter(entry => entry.type === 'assistant')
    .map(entry => ({ text: extractText(entry.message?.content), model: entry.message?.model ?? null }));
  writeFileSync(segmentsFile, JSON.stringify(segments), 'utf8');

  // Stable per-turn identity (stop-turn-id.mjs): the user entry's own
  // transcript uuid, so a retry (or an accidental double-fire) is a safe no-op
  // on the server side rather than a duplicate row. Messages from before the
  // uuid ids were first used here keep their old position-based id.
  const turnId = stopTurnId({
    sessionId,
    entry: entries[lastUserIdx],
    index: lastUserIdx,
    activatedAt: readOrCreateActivation(join(PROJECT_ROOT, '.local', 'stop-hook-turn-id-v2.json')),
  });

  const result = spawnSync(
    'npx',
    [
      'tsx', '--env-file-if-exists=.env', 'server/scripts/record-exchange.ts',
      '--source', 'claude-code', '--remote', REMOTE_URL,
      '--david-file', davidFile, '--assistant-file', assistantFile,
      '--provenance-segments', segmentsFile,
      '--turn-id', turnId, '--no-wait',
    ],
    { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 20000, shell: true },
  );
  if (result.status !== 0) {
    console.error('[record-stop-turn] record-exchange failed:', result.stderr || result.stdout || `exit ${result.status}`);
  }
}

main();
