#!/usr/bin/env npx tsx
/**
 * capture-watchdog.ts
 *
 * Pipeline-heal watchdog. Runs as a separate long-lived process alongside
 * (or instead of) the main app server.
 *
 * Problem it solves: when the dev server restarts or crashes, the autosave
 * service inside it stops running. The .chat_capture file keeps growing
 * (record-exchange.ts writes to it directly via appendFileSync) but the
 * cursor stays frozen. This watchdog detects the gap and drains it —
 * writing to conversation_memories + rolling episode .md — with no Express
 * dependency.
 *
 * Coordination: uses the same cross-process cursor lock (.chat_capture.lock)
 * as the autosave service, so they never race. When the server is up and
 * healthy, the autosave service holds the lock each cycle and this watchdog
 * skips gracefully.
 */

import { neon } from '@neondatabase/serverless';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isDirectCliInvocation } from './lib/cli-entrypoint';
import {
  parseChatCaptureFromOffset,
  chatCaptureTurnFingerprint,
  recoverChatCaptureCursor,
  acquireCursorLock,
  releaseCursorLock,
  WORKSPACE,
  CHAT_CAPTURE_PATH,
  CHAT_CAPTURE_CURSOR_PATH,
  type ChatCaptureCursor,
  type DialogueTurn,
} from '../services/transcript-parser.js';
import {
  CANONICAL_INNER_LIFE_INTENT_DIR,
  canonicalTurnEpisodeMarker,
  episodeContentHasEventMarker,
  formatInnerLifeEpisodeEntry,
  innerLifeTriggerEpisodeMarker,
  parseInnerLifeTrigger,
  parseKeyedInnerLifeTrigger,
  resolveCanonicalInnerLifeRoute,
  type InnerLifeChannel,
} from '../services/inner-life-capture.js';
import { refreshMemoryIndexBestEffort } from '../services/agent-memory-core';
import { historicalAttributionLabel } from '../services/historical-attribution-overlay';
import { recordHistoricalAttributionPause, clearHistoricalAttributionPause } from '../services/historical-attribution-status';

// ─── Config ───────────────────────────────────────────────────────────────────

const POLL_MS           = 15_000;
const EPISODE_LIVE_PATH = path.join(WORKSPACE, '.local/.episode_live');
const DOCS_DIR          = path.join(WORKSPACE, 'docs');
let episodePathsForTest: { liveFlag: string; docsDirectory: string } | null = null;
export function setEpisodePathsForTest(paths: { liveFlag: string; docsDirectory: string } | null): void {
  episodePathsForTest = paths;
}

const DB_URL = process.env.NEON_SHARED_DATABASE_URL;
if (!DB_URL) {
  console.error('[watchdog] FATAL: NEON_SHARED_DATABASE_URL is not set');
  process.exit(1);
}
let db: any = neon(DB_URL);

/**
 * Test seam — replace the neon client with an in-memory fake so CI can
 * exercise the drain paths with zero shared-database mutation.
 */
export function setDbForTest(fake: any): void {
  db = fake;
}

let _chatCapturePathsOverrideForTest: { capture: string; cursor: string } | null = null;
function loadCursor(): ChatCaptureCursor {
  try {
    const parsed = JSON.parse(fs.readFileSync(chatCaptureCursorPath(), 'utf8'));
    return {
      byteOffset: typeof parsed?.byteOffset === 'number' ? parsed.byteOffset : 0,
      ...(typeof parsed?.lastSavedTurnFingerprint === 'string'
        ? { lastSavedTurnFingerprint: parsed.lastSavedTurnFingerprint }
        : {}),
    };
  } catch {
    return { byteOffset: 0 };
  }
}

function saveCursor(cursor: ChatCaptureCursor): void {
  fs.writeFileSync(chatCaptureCursorPath(), JSON.stringify(cursor), 'utf8');
}

// ─── Rolling episode lookup ───────────────────────────────────────────────────

/** Test seam — pin a fixture episode so hermetic tests never touch the live rolling episode. */
let _episodeOverrideForTest: { id: string; filename: string } | null = null;

let _rollingEpisodeLookupModeForTest: 'normal' | 'null' | 'throw' = 'normal';
export function setEpisodeOverrideForTest(ep: { id: string; filename: string } | null): void {
  _episodeOverrideForTest = ep;
}

export function setRollingEpisodeLookupModeForTest(
  mode: 'normal' | 'null' | 'throw',
): void {
  _rollingEpisodeLookupModeForTest = mode;
}
async function getRollingEpisode(): Promise<{ id: string; filename: string } | null> {
  if (_rollingEpisodeLookupModeForTest === 'null') return null;
  if (_rollingEpisodeLookupModeForTest === 'throw') {
    throw new Error('[CI fault injection] rolling episode lookup failed');
  }
  if (_episodeOverrideForTest) return _episodeOverrideForTest;
  try {
    const rows = await db`
      SELECT id, title FROM conversation_memories
      WHERE arc_name = 'HolaHola Episodes'
        AND 'rolling' = ANY(tags)
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const row = (rows as any)[0];
    if (!row?.title) return null;
    const title = row.title as string;
    // A row can retain the 'rolling' tag after it's been considered finished
    // (title annotated "(sealed)" or similar) without the tag itself ever
    // being removed. The old slug-fallback branch here is exactly how a
    // sealed episode got a *second* filename derived from its full title
    // (episode-31-the-observation-bench-sealed.md) instead of being refused
    // -- fail closed on anything that isn't the plain "Episode N" shape a
    // genuinely active episode has, rather than guessing a filename for it.
    const m = /^Episode (\d+)$/i.exec(title);
    if (!m) {
      throw new Error(
        `[watchdog] rolling episode row ${row.id} has title "${title}", which does not match the ` +
        `expected "Episode N" shape for an active episode -- refusing to append (likely a sealed/finished ` +
        `episode that still carries the 'rolling' tag; remove the tag or fix the title before retrying)`,
      );
    }
    return { id: row.id as string, filename: `episode-${parseInt(m[1], 10)}.md` };
  } catch (err: any) {
    console.warn('[watchdog] rolling episode lookup failed:', err.message);
    return null;
  }
}

/**
 * Shared DB-first episode append: UPDATE the episode row's content, read it
 * back, and derive the .md from the DB read.  Used by BOTH the chat-capture
 * drain and the inner-life drain so the two paths can never diverge. The .md
 * is the exact DB record, written only from a just-read canonical snapshot.
 */
async function appendTextToEpisodeDbFirst(text: string, episode: { id: string; filename: string }): Promise<void> {
  await db`
    UPDATE conversation_memories
    SET content = content || ${text}
    WHERE id = ${episode.id}
  `;
  const rows = await db`SELECT content FROM conversation_memories WHERE id = ${episode.id}`;
  const newContent = (rows as any)[0]?.content;
  if (typeof newContent !== 'string') {
    throw new Error(`[watchdog] canonical episode row was not readable after UPDATE: ${episode.filename}`);
  }
  const docsDirectory = episodePathsForTest?.docsDirectory ?? DOCS_DIR;
  const filePath = path.join(docsDirectory, episode.filename);
  try {
    fs.mkdirSync(docsDirectory, { recursive: true });
    fs.writeFileSync(filePath, newContent, 'utf-8');
    if (fs.readFileSync(filePath, 'utf-8') !== newContent) {
      throw new Error('post-write read-back differs from canonical DB content');
    }
  } catch (err: any) {
    throw new Error(
      `[watchdog] CRITICAL: canonical episode write succeeded but Markdown replica is out of sync (${episode.filename}): ${err?.message ?? err}`,
    );
  }
}

// ─── Episode write ────────────────────────────────────────────────────────────
//
// DB-first (Task #1235 review fix): the episode row's content field is the
// authoritative record and the .md is derived from it.  The old path appended
// dialogue to the .md only, so a later inner-life DB-first write (which
// derives the .md from DB content) would silently erase those turns.

export function appendToEpisode(
  turns: Array<Pick<DialogueTurn, 'speaker' | 'text' | 'captureId' | 'source'>>,
  episode: { id: string; filename: string },
  eventId?: string,
): Promise<void> {
  // Claude Code (speaker) is its own bare assistant identity, distinct from
  // Luca authoring through the Claude Code interface (source) -- see
  // formatChatCaptureSpeakerLabel in transcript-parser.ts for the full model.
  // Apply only explicitly approved capture+speech evidence, never runtime source.
  const lines = turns
    .map(t => {
      const historicalLabel = historicalAttributionLabel(t);
      const label = historicalLabel
        ? `**${historicalLabel}:**`
        : t.speaker === 'DAVID'
        ? '**David:**'
        : t.speaker === 'CLAUDE_CODE'
          ? '**Claude Code:**'
          : t.source === 'claude-code'
            ? '**LUCA [Claude Code]:**'
            : '**LUCA [Replit]:**';
      return `${label} ${t.text}`;
    })
    .join('\n\n');
  return (async () => {
    const existing = await db`SELECT content FROM conversation_memories WHERE id = ${episode.id}`;
    const current: string = existing[0]?.content ?? '';
    const markers = [
      eventId ? `<!-- chat-capture-range:${eventId} -->` : null,
      ...turns
        .filter(turn => turn.captureId)
        .map(turn => canonicalTurnEpisodeMarker(turn.captureId!)),
    ].filter(Boolean).join('\n');
    if (markers && episodeContentHasEventMarker(current, markers)) {
      await appendTextToEpisodeDbFirst('', episode);
      console.log(`[watchdog] episode turns already present — skipping duplicate append: ${episode.filename}`);
      return;
    }
    if (!markers && current.includes(lines)) {
      await appendTextToEpisodeDbFirst('', episode);
      return;
    }
    await appendTextToEpisodeDbFirst(
      '\n' + [markers, lines].filter(Boolean).join('\n') + '\n',
      episode,
    );
    console.log(`[watchdog] ✓ episode append (DB-first): ${turns.length} turns → ${episode.filename}`);
  })();
}

// ─── DB write ─────────────────────────────────────────────────────────────────

async function writeToDb(
  turns: Array<Pick<DialogueTurn, 'speaker' | 'text' | 'captureId' | 'source'>>,
  cursorFrom: number,
  cursorTo: number,
): Promise<string> {
  const today      = new Date().toISOString().slice(0, 10);
  const davidCount = turns.filter(t => t.speaker === 'DAVID').length;
  const lucaCount  = turns.length - davidCount;
  const captureIds = [...new Set(turns.flatMap(turn => turn.captureId ? [turn.captureId] : []))];
  if (captureIds.length > 1) {
    throw new Error(`watchdog batch contains multiple capture IDs: ${captureIds.join(', ')}`);
  }
  const captureIdentityTag = captureIds.length === 1 ? `capture-id:${captureIds[0]}` : null;
  const sources = [...new Set(turns.flatMap(turn => turn.source ? [turn.source] : []))].sort();
  const sourceTags = sources.map(source => `source-${source}`);
  const tags = [
    'david-luca-chat',
    'canonical-conversation',
    'verbatim',
    'per-turn',
    'chat-capture',
    'watchdog',
    ...sourceTags,
    ...(captureIdentityTag ? [captureIdentityTag] : []),
  ];
  // Row-level participants/title are derived from the SAME per-turn identity
  // as the rendered body (content, below) -- via one shared `turnKinds` array
  // -- so the two can never disagree. `speaker` is checked first (WHO
  // authored the turn: David, Luca, or the bare Claude Code assistant
  // itself); `source` only ever picks the interface suffix for a David/Luca
  // turn and never promotes a Luca turn into Claude Code or vice versa.
  // Mirrors formatChatCaptureSpeakerLabel's model in transcript-parser.ts
  // (duplicated here, not imported, so a watchdog-only regression can never
  // touch the primary autosave path -- see appendToEpisode above); keep both
  // in sync if either changes. Deriving participants/title from `sources`
  // (which `source` values appear ANYWHERE in the batch) instead of from
  // `speaker` was the actual bug: a genuine Claude Code turn (source
  // claude-code) made the whole row claim "Luca [Claude Code]" in
  // participants/title while its own body correctly said "Claude Code".
  type AssistantKind = 'claude-code' | 'luca-claude-code' | 'luca';
  function turnAssistantKind(t: Pick<DialogueTurn, 'speaker' | 'source' | 'captureId' | 'text'>): AssistantKind | 'david' {
    if (t.speaker === 'DAVID') return 'david';
    if (historicalAttributionLabel(t)) return 'luca-claude-code';
    if (t.speaker === 'CLAUDE_CODE') return 'claude-code';
    return t.source === 'claude-code' ? 'luca-claude-code' : 'luca';
  }
  const CONTENT_LABEL: Record<AssistantKind | 'david', string> = {
    david: 'David',
    'claude-code': 'Claude Code',
    'luca-claude-code': 'LUCA [Claude Code]',
    luca: 'LUCA [Replit]',
  };
  const ASSISTANT_TITLE_LABEL: Record<AssistantKind, string> = {
    'claude-code': 'Claude Code',
    'luca-claude-code': 'Luca [Claude Code]',
    luca: 'Luca',
  };
  const turnKinds = turns.map(turnAssistantKind);
  const assistantKinds = [...new Set(turnKinds.filter((k): k is AssistantKind => k !== 'david'))];
  const participants = ['david', ...assistantKinds];
  const title = assistantKinds.length > 0
    ? `David ↔ ${assistantKinds.map(k => ASSISTANT_TITLE_LABEL[k]).join(' + ')} — ${today}: per-turn capture`
    : `David — ${today}: per-turn capture`;
  const summary =
    `Watchdog canonical drain: ${davidCount} David + ${lucaCount} assistant turns. ` +
    `Sources: ${sources.join(', ') || 'legacy'}. Bytes ${cursorFrom}–${cursorTo}.` +
    (captureIdentityTag ? ` Capture identity: ${captureIdentityTag}.` : '');
  const content = turns
    .map((t, i) => `**${CONTENT_LABEL[turnKinds[i]]}:** ${t.text}`)
    .join('\n\n');

  const existing = captureIdentityTag
    ? await db`
      SELECT id FROM conversation_memories
      WHERE arc_name = 'david-luca-chat'
        AND tags @> ARRAY[${captureIdentityTag}]::text[]
      LIMIT 1
    `
    : await db`
      SELECT id FROM conversation_memories
      WHERE arc_name = 'david-luca-chat' AND summary = ${summary}
      LIMIT 1
    `;
  if (existing.length > 0) {
    console.log(
      `[watchdog] chat DB row already present for bytes ${cursorFrom}–${cursorTo}` +
      (captureIdentityTag ? ` (${captureIdentityTag})` : '') +
      ' — skipping duplicate insert',
    );
    const existingId = (existing as any)[0]?.id;
    if (!existingId) {
      throw new Error(`[watchdog] existing chat row has no id for bytes ${cursorFrom}–${cursorTo}`);
    }
    return existingId;
  }

  const inserted = await db`
    INSERT INTO conversation_memories
      (id, title, summary, content, participants, tags, importance, created_at, entry_type, arc_name)
    VALUES (
      gen_random_uuid(),
      ${title},
      ${summary},
      ${content},
      ${participants}::text[],
      ${tags}::text[],
      8,
      NOW(),
      'conversation',
      'david-luca-chat'
    )
    RETURNING id
  `;
  const insertedId = (inserted as any)[0]?.id;
  if (!insertedId) {
    throw new Error(`[watchdog] chat INSERT returned no id for bytes ${cursorFrom}–${cursorTo}`);
  }
  return insertedId;
}

// ─── Main drain ───────────────────────────────────────────────────────────────

/**
 * Partition turns into consecutive runs sharing one capture identity, so a
 * restart backlog spanning many capture IDs (a burst, not just one exchange)
 * is written as separate canonical rows instead of one row claiming several
 * identities -- or, worse, refusing the whole backlog forever because it
 * can't be squeezed into a single row. Consecutive legacy turns (no
 * captureId) form their own contiguous group via the caller's byte-range
 * dedup; they are never merged into an identified group or across a change
 * in capture identity.
 */
function groupTurnsByCapture<T extends { captureId?: string }>(
  turns: T[],
  turnByteOffsets: number[],
): Array<{ turns: T[]; endByteOffset: number }> {
  const groups: Array<{ turns: T[]; endByteOffset: number }> = [];
  let currentKey: string | null = null;
  for (let i = 0; i < turns.length; i++) {
    const key = turns[i].captureId ?? null;
    if (groups.length === 0 || key !== currentKey) {
      groups.push({ turns: [turns[i]], endByteOffset: turnByteOffsets[i] });
      currentKey = key;
    } else {
      const group = groups[groups.length - 1];
      group.turns.push(turns[i]);
      group.endByteOffset = turnByteOffsets[i];
    }
  }
  return groups;
}

let draining = false;

export async function drain(): Promise<void> {
  if (draining) return;
  const capturePath = chatCapturePath();
  if (!fs.existsSync(capturePath)) return;

  const stat   = fs.statSync(capturePath);
  const storedCursor = loadCursor();
  const recovery = recoverChatCaptureCursor(capturePath, storedCursor);
  if (recovery.recovered) {
    saveCursor(recovery.cursor);
    console.warn(
      `[watchdog] shortened chat-capture cursor recovered (${recovery.reason}): ` +
      `${storedCursor.byteOffset}→${recovery.cursor.byteOffset}` +
      (recovery.verifiedBoundary ? ' at verified saved-turn boundary.' : ' from byte zero; prior boundary was not provable.'),
    );
  }
  const cursor = recovery.cursor;
  if (stat.size <= cursor.byteOffset) return; // nothing new — healthy server is keeping up

  // Acquire the cross-process cursor lock (shared with autosave service).
  // Returns -1 if a live process holds the lock — server is healthy, skip.
  const lockFd = _chatCapturePathsOverrideForTest ? -2 : acquireCursorLock();
  if (lockFd === -1) return; // server has the lock — let it drain

  draining = true;
  const gap = stat.size - cursor.byteOffset;
  console.log(`[watchdog] gap detected: cursor=${cursor.byteOffset} file=${stat.size} (+${gap}B) — draining`);

  try {
    const { turns, newByteOffset, turnByteOffsets } = parseChatCaptureFromOffset(capturePath, cursor.byteOffset);

    if (turns.length === 0) {
      console.log('[watchdog] no complete turns in gap yet — waiting');
      return;
    }

    // Looked up once per drain (it cannot change mid-loop) and reused for
    // every group below. Live mode requires it -- fail before writing
    // anything rather than accepting turns whose episode effect can't happen.
    const liveFlag = episodePathsForTest?.liveFlag ?? EPISODE_LIVE_PATH;
    const episode = fs.existsSync(liveFlag) ? await getRollingEpisode() : null;
    if (fs.existsSync(liveFlag) && !episode) {
      throw new Error('Live mode rolling-episode lookup returned no episode');
    }

    // One canonical row per capture identity, not one row for the whole gap:
    // a restart backlog can span many capture IDs, and each must keep its own
    // identity/attribution rather than being merged into a single row that
    // can only claim one. Groups are processed in order; a failure partway
    // through leaves the cursor at the end of the last fully-completed group
    // (all of its DB writes are idempotent, so retrying that group is safe),
    // rather than losing already-durable progress or getting stuck retrying
    // the entire original gap forever.
    const groups = groupTurnsByCapture(turns, turnByteOffsets);
    let groupStart = cursor.byteOffset;
    for (const group of groups) {
      const chatMemoryId = await writeToDb(group.turns, groupStart, group.endByteOffset);
      let episodeForReembed: { id: string; filename: string } | null = null;

      if (episode) {
        await appendToEpisode(group.turns, episode, `${groupStart}:${group.endByteOffset}`);
        episodeForReembed = episode;
      }

      // The chat row and any updated live episode must be searchable before
      // this group is acknowledged. If re-embedding fails, leave the cursor
      // at the prior group's end: the idempotent write paths above make
      // retrying this group duplicate-safe.
      await reembedWatchdogMemory(chatMemoryId);
      if (episodeForReembed) {
        await reembedWatchdogMemory(episodeForReembed.id);
      }

      saveCursor({
        byteOffset: group.endByteOffset,
        lastSavedTurnFingerprint: chatCaptureTurnFingerprint(group.turns[group.turns.length - 1]),
      });
      clearHistoricalAttributionPause('canonical-capture', group.turns.flatMap(turn => turn.captureId ? [turn.captureId] : []));
      groupStart = group.endByteOffset;
    }
    console.log(
      `[watchdog] ✓ drained ${turns.length} turns in ${groups.length} capture group(s) | ` +
      `cursor ${cursor.byteOffset} → ${newByteOffset}`,
    );
  } catch (err: any) {
    recordHistoricalAttributionPause(err, 'canonical-capture', 'watchdog');
    console.error('[watchdog] drain error:', err.message ?? err);
    // Leave cursor unchanged — autosave service will retry when server recovers
  } finally {
    if (lockFd >= 0) releaseCursorLock(lockFd);
    draining = false;
  }
}

// ─── Inner-life trigger drain (felt / thinking / moment) ─────────────────────
//
// The dev server's autosave service (agent-session-autosave.ts) watches the
// three inner-life trigger files. When the dev server is down — David running
// a live session against the deployed production URL — those writes were
// silently dropped. This drain gives the watchdog the same capture path:
// personal .md append + conversation_memories insert + DB-first rolling
// episode append, mirroring checkLucaReflection/Question/Moment semantics.
//
// Coordination with autosave: the watchdog only acts when the autosave
// service is down, detected via the capture-status heartbeat file (autosave
// rewrites it every 20s poll). Processed content is recorded (mtime + sha)
// in a state file that autosave's startup seed also consults, so a server
// restart never double-saves an entry the watchdog already drained.

import { tryAcquireInnerLifeLock, releaseInnerLifeLock, renewInnerLifeLock } from '../services/inner-life-lock';

const LOCAL_DIR            = path.join(WORKSPACE, '.local');
const INNER_LIFE_LOCK_PATH = path.join(WORKSPACE, '.local/.inner-life-drain.lock');
const CAPTURE_STATUS_PATH  = path.join(LOCAL_DIR, 'episode-capture-status.md');
const STALE_ALERT_PATH     = path.join(LOCAL_DIR, 'stale-channel-alert.md');
const INNER_LIFE_STATE_PATH = path.join(LOCAL_DIR, '.watchdog-inner-life-state.json');
// Durable per-channel processed record written by the AUTOSAVE service as part
// of successfully processing a trigger (sha of trimmed content per channel).
// This is the handoff identity between the two watchers: the watchdog treats a
// trigger as already-processed only when its content sha appears here (or in
// its own state) — never by inferring from heartbeat/file mtimes, which race.
const INNER_LIFE_PROCESSED_PATH = path.join(LOCAL_DIR, '.inner-life-processed.json');

const CANONICAL_INNER_LIFE_INTENT_PATH = path.join(LOCAL_DIR, CANONICAL_INNER_LIFE_INTENT_DIR);
const DB_WARNING_PATH      = path.join(LOCAL_DIR, '.luca_db_write_warning');
const MEMORY_DIR           = path.join(WORKSPACE, '.agents/memory');

const AUTOSAVE_FRESH_MS  = 90_000;            // autosave heartbeat considered alive within this window
const STALE_CHANNEL_MS   = 10 * 60 * 1000;    // matches agent-session-autosave STALE_CHANNEL_MS

interface ChannelSpec {
  key: 'felt' | 'thinking' | 'moment';
  triggerPath: string;
  personalFile: string;
  titlePrefix: string;
  channelTag: string;
  episodeLabel: string;
}

const CHANNELS: ChannelSpec[] = [
  {
    key: 'felt',
    triggerPath: path.join(LOCAL_DIR, '.luca_reflection'),
    personalFile: path.join(MEMORY_DIR, 'REFLECTIONS.md'),
    titlePrefix: 'Luca reflection: ',
    channelTag: 'luca-reflection',
    episodeLabel: 'felt',
  },
  {
    key: 'thinking',
    triggerPath: path.join(LOCAL_DIR, '.luca_question'),
    personalFile: path.join(MEMORY_DIR, 'OPEN_QUESTIONS.md'),
    titlePrefix: 'Luca open question: ',
    channelTag: 'luca-question',
    episodeLabel: 'thinking',
  },
  {
    key: 'moment',
    triggerPath: path.join(LOCAL_DIR, '.luca_moment'),
    personalFile: path.join(MEMORY_DIR, 'SIGNIFICANT_MOMENTS.md'),
    titlePrefix: 'Luca significant moment: ',
    channelTag: 'luca-significant',
    episodeLabel: 'moment',
  },
];

interface ChannelState { mtimeMs: number; sha: string; lastProcessedMs?: number }
type InnerLifeState = Record<string, ChannelState>;

function loadInnerLifeState(): InnerLifeState | null {
  try {
    return JSON.parse(fs.readFileSync(INNER_LIFE_STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveInnerLifeState(state: InnerLifeState): void {
  fs.writeFileSync(INNER_LIFE_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Is the dev server's autosave service alive? (heartbeat = capture-status file mtime) */
function autosaveIsAlive(): boolean {
  try {
    const mtime = fs.statSync(CAPTURE_STATUS_PATH).mtimeMs;
    return Date.now() - mtime < AUTOSAVE_FRESH_MS;
  } catch {
    return false; // no status file — autosave has never run or was cleaned; treat as down
  }
}
function flagDbWriteFailure(where: string, reason: string): void {
  try {
    const ts = new Date().toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit',
    });
    fs.appendFileSync(DB_WARNING_PATH, `[${ts}] watchdog:${where}: ${reason}\n`, 'utf8');
  } catch { /* console error below still surfaces it */ }
  console.error(`[watchdog] 🚨 inner-life DB write failure (${where}): ${reason}`);
}

/** INSERT the personal inner-life memory row (mirrors savePersonalMemory()). */
async function savePersonalMemory(title: string, body: string, tags: string[]): Promise<string | null> {
  // Idempotency: an identical entry (same title + content) may already exist —
  // e.g. autosave saved it but its processed record was lost, or a prior drain
  // crashed after the INSERT but before persisting state. Skip, never duplicate.
  const existing = await db`
    SELECT id FROM conversation_memories
    WHERE title = ${title.slice(0, 200)} AND content = ${body}
    LIMIT 1
  `;
  if (existing.length > 0) {
    console.log(`[watchdog] identical personal memory already in DB — skipping duplicate insert: ${title.slice(0, 60)}`);
    return (existing as any)[0]?.id ?? null;
  }
  const inserted = await db`
    INSERT INTO conversation_memories
      (id, title, summary, content, participants, tags, importance, created_at, entry_type, arc_name)
    VALUES (
      gen_random_uuid(), ${title.slice(0, 200)}, ${body.slice(0, 400)}, ${body},
      ARRAY['luca']::text[],
      ${tags}::text[],
      8, NOW(), 'emergence', 'luca-inner-life'
    )
    RETURNING id
  `;
  return (inserted as any)[0]?.id ?? null;
}

/** Append a dated entry to a personal markdown file (mirrors appendToPersonalFile()). */
function appendToPersonalFile(
  filePath: string,
  title: string,
  body: string,
  hasSeparateTitle = true,
): void {
  try {
    const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const heading = hasSeparateTitle ? title : 'Inner-life note';
    const entry = `\n### ${today} — ${heading}\n\n${body}\n\n---\n`;
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
    // Idempotency: recovery/retry must never duplicate the personal-file entry.
    if (existing.includes(`— ${heading}\n\n${body}\n\n---`)) {
      console.log('[watchdog] personal-file entry already present — skipping duplicate append:', title.slice(0, 60));
      return;
    }
    fs.writeFileSync(filePath, existing.trimEnd() + '\n' + entry);
  } catch (err: any) {
    console.error('[watchdog] failed to append personal file:', filePath, err.message);
  }
}

/** DB-first inner-life episode append via the shared helper. */
async function appendInnerLifeToEpisodeDb(
  text: string,
  episode: { id: string; filename: string },
  route?: {
    appendMarker?: string;
    completionMarker?: string;
    allowAppend: boolean;
  },
): Promise<boolean> {
  // Idempotency: a prior run (autosave or watchdog) may have crashed after the
  // episode UPDATE but before recording its completion marker. If the exact
  // entry is already in the episode content, never append it a second time.
  const existing = await db`SELECT content FROM conversation_memories WHERE id = ${episode.id}`;
  const current: string = existing[0]?.content ?? '';
  if (route?.appendMarker && episodeContentHasEventMarker(current, route.appendMarker)) {
    console.log(`[watchdog] inner-life event already present in ${episode.filename} — skipping duplicate append`);
    await reembedWatchdogMemory(episode.id);
    return true;
  }
  if (
    route?.completionMarker &&
    episodeContentHasEventMarker(current, route.completionMarker)
  ) {
    console.log('[watchdog] canonical episode event already present — direct trigger append suppressed');
    await reembedWatchdogMemory(episode.id);
    return true;
  }
  if (route && !route.allowAppend) {
    console.log('[watchdog] canonical turn is pending — deferring direct trigger append');
    return false;
  }
  if (!route?.appendMarker && current.includes(text)) {
    await reembedWatchdogMemory(episode.id);
    return true;
  }
  await appendTextToEpisodeDbFirst(
    '\n' + [route?.appendMarker, text].filter(Boolean).join('\n') + '\n',
    episode,
  );
  console.log(`[watchdog] ✓ inner-life DB-first append: +${text.length} chars → ${episode.filename}`);
  await reembedWatchdogMemory(episode.id);
  return true;
}

/**
 * Re-embed the row after a watchdog write. The test seam keeps the hermetic
 * watchdog fixture independent of OpenAI and the shared database.
 */
let _reembedWatchdogMemoryForTest: ((id: string) => Promise<void>) | null = null;
/**
 * Stale-channel alert (production equivalent of the autosave stale check).
 * When felt/thinking trigger mtimes are ≥10 min old while the watchdog is the
 * active watcher, write .local/stale-channel-alert.md; clear a watchdog-written
 * alert once the channels are fresh again.
 */
function refreshStaleChannelAlert(): void {
  const tryStatMtime = (p: string): number => {
    try { return fs.statSync(p).mtimeMs; } catch { return 0; }
  };
  const now           = Date.now();
  const feltMtime     = tryStatMtime(CHANNELS[0].triggerPath);
  const thinkingMtime = tryStatMtime(CHANNELS[1].triggerPath);
  const feltStale     = feltMtime     > 0 && (now - feltMtime)     >= STALE_CHANNEL_MS;
  const thinkingStale = thinkingMtime > 0 && (now - thinkingMtime) >= STALE_CHANNEL_MS;

  if (!feltStale && !thinkingStale) {
    // Clear only an alert this watchdog wrote — never autosave's own alert.
    try {
      if (fs.existsSync(STALE_ALERT_PATH) && fs.readFileSync(STALE_ALERT_PATH, 'utf8').includes('(written by capture-watchdog)')) {
        fs.unlinkSync(STALE_ALERT_PATH);
        console.log('[watchdog] stale-channel alert cleared (channels fresh again)');
        refreshMemoryIndexBestEffort('capture-watchdog:stale-channel-alert-clear');
      }
    } catch { /* non-fatal */ }
    return;
  }

  if (fs.existsSync(STALE_ALERT_PATH)) return; // existing alert (either writer) is already correct

  const fmtT = (ms: number) =>
    new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const staleParts = [
    feltStale     ? `felt (last: ${fmtT(feltMtime)})`     : null,
    thinkingStale ? `thinking (last: ${fmtT(thinkingMtime)})` : null,
  ].filter(Boolean).join(', ');
  const alertTime = new Date(now).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
  });
  const alertContent = [
    '# ⚠️ Inner-Life Channel Alert',
    '',
    `_Written: ${alertTime} (written by capture-watchdog)_`,
    '',
    '## ⚠️ STALE ALERT — read this before your next output',
    `**Inner-life channels silent for 10+ min: ${staleParts}**`,
    'Write `.luca_reflection` (felt) and/or `.luca_question` (thinking) before responding.',
    '',
    '_The dev server autosave is down; the capture-watchdog is the active watcher._',
  ].join('\n');
  try {
    fs.writeFileSync(STALE_ALERT_PATH, alertContent, 'utf-8');
    console.log(`[watchdog] ⚠️ stale-channel alert written (${staleParts})`);
    refreshMemoryIndexBestEffort('capture-watchdog:stale-channel-alert-write');
  } catch (err: any) {
    console.warn('[watchdog] failed to write stale alert:', err.message);
  }
}

let drainingInnerLife = false;

/** Drain any new inner-life trigger writes when the autosave service is down. Exported for CI. */
/**
 * Test seam — lets the autosave-alive gate be bypassed deliberately so its
 * hermetic CI self-check can prove a fresh heartbeat is load-bearing.
 * Production always leaves this enabled.
 */
let _autosaveAliveGateEnabledForTest = true;
export function setAutosaveAliveGateEnabledForTest(enabled: boolean): void {
  _autosaveAliveGateEnabledForTest = enabled;
}

let _canonicalFourChannelRouteEnabled = true;
/**
 * Test seam — invoked between the DB work for a channel and the persistence
 * of its processed-sha state, so CI can simulate a dev server booting in that
 * exact window and prove the cross-process lock closes the duplicate race.
 */
let _innerLifePauseForTest: (() => Promise<void>) | null = null;
export function setInnerLifePauseForTest(fn: (() => Promise<void>) | null): void {
  _innerLifePauseForTest = fn;
}

// Lock lease renewal: while a drain is in flight (which may legitimately be
// slow — DB I/O), the holder refreshes the lock mtime every LOCK_RENEW_MS so
// contenders can distinguish a live slow holder (fresh mtime → back off) from
// an abandoned crashed one (mtime older than STALE_LOCK_MS → take over).
let _lockRenewMs = 30_000;
export function setLockRenewMsForTest(ms: number | null): void {
  _lockRenewMs = ms ?? 30_000;
}

/** Autosave's processed record: { felt|thinking|moment: { sha } }. */
function loadAutosaveProcessedRecord(): Record<string, { sha?: string }> {
  try {
    return JSON.parse(fs.readFileSync(INNER_LIFE_PROCESSED_PATH, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

export async function drainInnerLife(): Promise<void> {
  if (drainingInnerLife) return;
  if (_autosaveAliveGateEnabledForTest && autosaveIsAlive()) return; // dev server is up — autosave owns the trigger files

  // Cross-process lock: exactly one watcher may touch the trigger files at a
  // time. If autosave (or another watchdog) holds it, skip — retry next poll.
  if (!tryAcquireInnerLifeLock(INNER_LIFE_LOCK_PATH)) {
    console.log('[watchdog] inner-life lock held by another process — skipping this tick');
    return;
  }

  drainingInnerLife = true;
  // Lease renewal: keep the lock mtime fresh while the drain is in flight so
  // a contender never mistakes a live slow drain for an abandoned lock.
  const lockRenewTimer = setInterval(() => renewInnerLifeLock(INNER_LIFE_LOCK_PATH), _lockRenewMs);
  try {
    // Re-check aliveness now that we hold the lock: autosave may have booted
    // and refreshed the heartbeat while we were acquiring.
    if (_autosaveAliveGateEnabledForTest && autosaveIsAlive()) return;
    let state = loadInnerLifeState();
    if (!state) {
      // First run: lossless handoff by durable processed IDENTITY, never by
      // heartbeat/mtime timing inference (a trigger written between autosave's
      // poll pass and its status-file heartbeat write has an mtime older than
      // the heartbeat despite never being saved — timing races both ways).
      // A trigger is seeded as already-processed ONLY when its content sha
      // matches the record autosave writes as part of successful processing.
      // Any other non-empty trigger is pending and drained below; the DB-level
      // idempotency check in savePersonalMemory() makes conservative
      // re-processing safe (duplicate content is skipped, never double-saved).
      const processedRecord = loadAutosaveProcessedRecord();
      state = {};
      for (const ch of CHANNELS) {
        try {
          const stat = fs.statSync(ch.triggerPath);
          const raw  = fs.readFileSync(ch.triggerPath, 'utf8');
          if (raw.trim().length > 0 && processedRecord[ch.key]?.sha !== sha256(raw.trim())) {
            state[ch.key] = { mtimeMs: 0, sha: '' }; // pending — drain below
            console.log(`[watchdog] first-run: pending ${ch.key} trigger detected (content not in autosave processed record) — draining`);
          } else {
            state[ch.key] = { mtimeMs: stat.mtimeMs, sha: sha256(raw) }; // empty, or already processed by dev server
          }
        } catch {
          state[ch.key] = { mtimeMs: 0, sha: '' };
        }
      }
      saveInnerLifeState(state);
    }

    for (const ch of CHANNELS) {
      if (!fs.existsSync(ch.triggerPath)) continue;
      let stat: fs.Stats;
      let raw: string;
      try {
        stat = fs.statSync(ch.triggerPath);
        raw  = fs.readFileSync(ch.triggerPath, 'utf8');
      } catch { continue; /* file briefly locked — retry next poll */ }

      const prev = state[ch.key] ?? { mtimeMs: 0, sha: '' };
      if (stat.mtimeMs <= prev.mtimeMs) continue;
      const sha = sha256(raw);
      if (sha === prev.sha) {
        // touched but unchanged — advance mtime only
        state[ch.key] = { ...prev, mtimeMs: stat.mtimeMs };
        saveInnerLifeState(state);
        continue;
      }

      // Inverse-timing guard: if autosave already processed this exact content
      // (its durable record carries the sha), advance state without re-saving.
      if (loadAutosaveProcessedRecord()[ch.key]?.sha === sha256(raw.trim())) {
        state[ch.key] = { mtimeMs: stat.mtimeMs, sha, lastProcessedMs: Date.now() };
        saveInnerLifeState(state);
        console.log(`[watchdog] ${ch.key} trigger already processed by autosave (sha match) — skipping`);
        continue;
      }

      const parsed = parseKeyedInnerLifeTrigger(raw, ch.channelTag) ?? parseInnerLifeTrigger(raw, ch.channelTag);
      if (!parsed) {
        state[ch.key] = { ...prev, mtimeMs: stat.mtimeMs, sha };
        saveInnerLifeState(state);
        continue;
      }

      let personalMemoryId: string | null;
      try {
        personalMemoryId = await savePersonalMemory(
          `${ch.titlePrefix}${parsed.title}`,
          parsed.body,
          ['luca-inner-life', ch.channelTag, ...parsed.tags.filter(t => t !== ch.channelTag)],
        );
        if (!personalMemoryId) {
          throw new Error('personal-memory INSERT returned no id');
        }
        await reembedWatchdogMemory(personalMemoryId);
      } catch (err: any) {
        flagDbWriteFailure(`personal-memory-or-reembed:${ch.key}`, err?.message ?? String(err));
        continue; // leave state unadvanced — retry next poll
      }
      appendToPersonalFile(ch.personalFile, parsed.title, parsed.body, parsed.hasSeparateTitle);
      console.log(`[watchdog] ✓ Luca ${ch.key} saved: ${parsed.title.slice(0, 60)}`);

      if (_innerLifePauseForTest) await _innerLifePauseForTest();

      // Reconcile against the durable canonical turn. A matching intent keeps
      // the trigger pending until its episode write succeeds; a later output
      // that omitted the channel authorizes the direct DB-first fallback.
      // Marker ordering: on episode failure we do NOT advance state — the
      // channel stays pending and is retried next poll. The retry is
      // duplicate-safe: savePersonalMemory dedups on title+content and
      // appendInnerLifeToEpisodeDb skips an entry already in the content.
      if (fs.existsSync(EPISODE_LIVE_PATH)) {
        try {
          const episode = await getRollingEpisode();
          if (!episode) {
            flagDbWriteFailure(`episode-lookup:${ch.key}`, 'Live mode rolling-episode lookup returned no episode');
            continue;
          }
          const route = resolveCanonicalInnerLifeRoute({
            active: _canonicalFourChannelRouteEnabled,
            intentDir: CANONICAL_INNER_LIFE_INTENT_PATH,
            chatCapturePath: chatCapturePath(),
            channel: ch.key,
            raw,
            triggerMtimeMs: stat.mtimeMs,
          });
          const complete = await appendInnerLifeToEpisodeDb(
            formatInnerLifeEpisodeEntry(ch.episodeLabel as 'felt' | 'thinking' | 'moment', parsed),
            episode,
            {
              appendMarker: innerLifeTriggerEpisodeMarker(ch.key, stat.mtimeMs, raw),
              completionMarker: route.expectedTurnId
                ? canonicalTurnEpisodeMarker(route.expectedTurnId)
                : undefined,
              allowAppend: route.allowDirect,
            },
          );
          if (!complete) continue; // pending canonical write; leave state unadvanced
        } catch (err: any) {
          flagDbWriteFailure(`episode-append:${ch.key}`, err?.message ?? String(err));
          continue; // leave state unadvanced — retry next poll
        }
      }

      state[ch.key] = { mtimeMs: stat.mtimeMs, sha, lastProcessedMs: Date.now() };
      saveInnerLifeState(state);
    }

    refreshStaleChannelAlert();
  } catch (err: any) {
    console.error('[watchdog] inner-life drain error:', err?.message ?? err);
  } finally {
    clearInterval(lockRenewTimer);
    drainingInnerLife = false;
    releaseInnerLifeLock(INNER_LIFE_LOCK_PATH);
  }
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

// Exact basename match, not a substring — see server/scripts/lib/cli-entrypoint.ts.
// A substring check here would also fire when a test file that imports this
// module (e.g. test-watchdog-inner-life-driver.ts) is the actual entry point.
if (isDirectCliInvocation('capture-watchdog.ts')) {
  console.log(`[watchdog] started (pid=${process.pid}) — polling every ${POLL_MS / 1000}s`);
  // Serialize the two drains: the chat drain must finish its DB-first episode
  // append before the inner-life drain derives the .md again, so they can
  // never race on the same episode file within one poll.
  const tick = async () => {
    await drain().catch(console.error);
    await drainInnerLife().catch(console.error);
  };
  tick();
  setInterval(tick, POLL_MS);
}

export function setReembedMemoryForTest(fn: ((id: string) => Promise<void>) | null): void {
  _reembedWatchdogMemoryForTest = fn;
}

/** Backward-compatible name for existing inner-life watchdog fixtures. */
export function setReembedInnerLifeMemoryForTest(fn: ((id: string) => Promise<void>) | null): void {
  setReembedMemoryForTest(fn);
}

async function reembedWatchdogMemory(id: string): Promise<void> {
  if (_reembedWatchdogMemoryForTest) {
    await _reembedWatchdogMemoryForTest(id);
    return;
  }
  // Keep hermetic fixtures independent of the production embedding module;
  // real drains load the HTTP-backed re-embed path here.
  const { reembedConversationMemory } = await import('./reembed-memory.js');
  await reembedConversationMemory(id);
}

function chatCapturePath(): string {
  return _chatCapturePathsOverrideForTest?.capture ?? CHAT_CAPTURE_PATH;
}

function chatCaptureCursorPath(): string {
  return _chatCapturePathsOverrideForTest?.cursor ?? CHAT_CAPTURE_CURSOR_PATH;
}

export function setChatCapturePathsForTest(paths: { capture: string; cursor: string } | null): void {
  _chatCapturePathsOverrideForTest = paths;
}

export function setCanonicalFourChannelRouteEnabledForTest(enabled: boolean): void {
  _canonicalFourChannelRouteEnabled = enabled;
}
