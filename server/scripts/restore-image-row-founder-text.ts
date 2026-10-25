/**
 * restore-image-row-founder-text.ts — one-time restoration, founder-approved
 * (2026-10-24, option 1: run from LCC's machine, no founder text in the repo).
 *
 * Until PR #81, when David sent an image with a message, the Claude Code Stop
 * hook recorded only the image's metadata entry ("[Image: source: ...]") as the
 * turn and dropped his message. The runtime-notice relabel (#100) has since
 * marked that metadata "[SISTEMA]: ". This restores his own words, verbatim
 * from the Claude Code transcript, as a leading block:
 *
 *   David [Claude Code]: <his message>\n\n[SISTEMA]: [Image: source: ...]\n\nClaude Code: <reply>
 *
 * Provenance, not text: the message is the nearest preceding transcript entry
 * of type user, origin human, not isMeta, with text, before the image entry and
 * with no assistant text in between. An image sent with no words restores
 * nothing. The repository is public, so the committed receipt holds only row
 * ids, transcript positions and hashes; the words are read from the local
 * transcript at apply time and must match the receipt's hash.
 *
 *   generate --out <.local/...json>                       read-only; writes the receipt and a local review packet
 *   apply --receipt <path> --list-sha <approved sha>      writes, per row under FOR UPDATE, fail-closed
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Pool } from '@neondatabase/serverless';

export const LABEL = 'David [Claude Code]: ';
export const IMAGE_PREFIX = '[SISTEMA]: [Image: source:';
export const RECEIPT_KIND = 'restore-image-founder-text';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b: any) => b && b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n\n');
}

/** The founder message an image entry belongs to, by provenance. Pure. */
export function founderMessageFor(entries: any[], imageIndex: number): { index: number; text: string } | { reason: string } {
  const image = entries[imageIndex];
  if (!image || image.type !== 'user' || image.isMeta !== true || !extractText(image.message?.content).startsWith('[Image: source:')) {
    return { reason: 'capture index is not an image metadata entry' };
  }
  for (let i = imageIndex - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === 'assistant' && extractText(e.message?.content).trim()) return { reason: 'assistant text before any founder message' };
    if (e?.type === 'user' && e.isMeta !== true && e.origin?.kind === 'human') {
      const text = extractText(e.message?.content).trim();
      return text ? { index: i, text } : { reason: 'image sent with no words' };
    }
  }
  return { reason: 'no founder message found' };
}

export function restoredContent(current: string, text: string): string {
  return `${LABEL}${text}\n\n${current}`;
}

export interface RestoreEntry {
  rowId: string;
  captureId: string;
  founderIndex: number;
  founderTextSha256: string;
  preSha256: string;
  postSha256: string;
}

export type RestoreOutcome = { status: 'apply'; next: string } | { status: 'already-applied' } | { status: 'drifted'; reason: string };

/** Decide one row from its current content and the transcript text. Pure. */
export function decideRestore(current: string, text: string, entry: RestoreEntry): RestoreOutcome {
  if (sha256(text) !== entry.founderTextSha256) return { status: 'drifted', reason: 'transcript text does not match the receipt' };
  const hash = sha256(current);
  if (hash === entry.postSha256) return { status: 'already-applied' };
  if (hash !== entry.preSha256 || !current.startsWith(IMAGE_PREFIX)) return { status: 'drifted', reason: 'row changed since the receipt' };
  const next = restoredContent(current, text);
  return sha256(next) === entry.postSha256 ? { status: 'apply', next } : { status: 'drifted', reason: 'restored content does not match the receipt' };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Local evidence (receipt, review packet) goes only inside a .local/ directory. */
function writeLocal(path: string, data: string): void {
  if (!/[\\/]\.local[\\/]/.test(resolve(path))) throw new Error('output must be inside a .local/ directory');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

const TRANSCRIPTS = join(homedir(), '.claude', 'projects', 'C--Users-David-HolaHola');
const CAPTURE = /^cc-([0-9a-f-]{36})-(\d+)$/;

function transcriptLoader(dir: string) {
  const cache = new Map<string, any[]>();
  return (session: string): any[] | null => {
    const file = join(dir, `${session}.jsonl`);
    if (!existsSync(file)) return null;
    if (!cache.has(session)) {
      cache.set(session, readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
    }
    return cache.get(session)!;
  };
}

async function generate(pool: Pool): Promise<void> {
  const out = arg('out');
  if (!out) throw new Error('--out is required');
  const relabel = JSON.parse(readFileSync(arg('relabel-receipt') ?? 'scripts/data-ops/relabel-runtime-notices.receipt.json', 'utf8'));
  const load = transcriptLoader(arg('transcripts') ?? TRANSCRIPTS);
  const candidates = relabel.entries.filter((e: any) => e.basis === 'isMeta');
  const { rows } = await pool.query(
    `SELECT id::text AS id, content, attribution IS NOT NULL AS attributed FROM conversation_memories
      WHERE id::text IN (SELECT jsonb_array_elements_text($1::jsonb))`,
    [JSON.stringify(candidates.map((e: any) => e.rowId))],
  );
  const byId = new Map(rows.map((r: any) => [r.id, r]));
  const entries: RestoreEntry[] = [];
  const packet: string[] = ['# Founder messages to restore (LOCAL ONLY, never commit)', ''];
  const skipped: Record<string, number> = {};
  for (const c of candidates) {
    const row: any = byId.get(c.rowId);
    const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
    if (!row || !row.content.startsWith(IMAGE_PREFIX)) { skip('not an image row'); continue; }
    if (row.attributed) { skip('row has attribution'); continue; }
    if (sha256(row.content) !== c.postSha256) { skip('row is not in its relabelled state'); continue; }
    const m = CAPTURE.exec(c.captureId);
    const transcript = m ? load(m[1]) : null;
    if (!m || !transcript) { skip('transcript not on this machine'); continue; }
    const found = founderMessageFor(transcript, Number(m[2]));
    if ('reason' in found) { skip(found.reason); continue; }
    const post = restoredContent(row.content, found.text);
    entries.push({ rowId: c.rowId, captureId: c.captureId, founderIndex: found.index, founderTextSha256: sha256(found.text), preSha256: c.postSha256, postSha256: sha256(post) });
    packet.push(`## ${entries.length}. row ${c.rowId.slice(0, 8)} (transcript ${m[1].slice(0, 8)} #${found.index})`, '', '```', found.text, '```', '');
  }
  const receipt = { kind: RECEIPT_KIND, relabelListSha256: relabel.listSha256, entries, listSha256: sha256(JSON.stringify(entries)) };
  writeLocal(out, JSON.stringify(receipt, null, 2) + '\n');
  writeLocal(out.replace(/\.json$/, '') + '.review.md', packet.join('\n'));
  console.log(JSON.stringify({ out, restore: entries.length, skipped, listSha256: receipt.listSha256 }, null, 2));
}

async function apply(pool: Pool): Promise<void> {
  const receiptPath = arg('receipt');
  const approved = arg('list-sha');
  if (!receiptPath || !approved) throw new Error('--receipt and --list-sha are required');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (receipt.kind !== RECEIPT_KIND || sha256(JSON.stringify(receipt.entries)) !== receipt.listSha256 || receipt.listSha256 !== approved) {
    throw new Error('receipt is not the approved restoration list');
  }
  const load = transcriptLoader(arg('transcripts') ?? TRANSCRIPTS);
  const counts: Record<string, number> = {};
  const untouched: string[] = [];
  for (const entry of receipt.entries as RestoreEntry[]) {
    const m = CAPTURE.exec(entry.captureId);
    const transcript = m ? load(m[1]) : null;
    const found = transcript ? founderMessageFor(transcript, Number(m![2])) : { reason: 'transcript missing' };
    const text = 'text' in found && found.index === entry.founderIndex ? found.text : null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT content, attribution FROM conversation_memories WHERE id = $1 FOR UPDATE', [entry.rowId]);
      let status: string;
      if (!rows.length || text === null) status = 'drifted';
      else if (rows[0].attribution !== null && rows[0].attribution !== undefined) status = 'attributed';
      else {
        const outcome = decideRestore(rows[0].content, text, entry);
        status = outcome.status;
        if (outcome.status === 'apply') await client.query('UPDATE conversation_memories SET content = $2 WHERE id = $1', [entry.rowId, outcome.next]);
      }
      await client.query('COMMIT');
      counts[status] = (counts[status] ?? 0) + 1;
      if (status === 'drifted' || status === 'attributed') untouched.push(entry.rowId);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  console.log(JSON.stringify({ counts, untouched }, null, 2));
}

// ── Episode 34 copies (founder: "yes, restore the Episode 34 copies too") ──────
//
// The gap patcher projected a canonical row into Episode 34 as
// "\n" + row.trim() + "\n". For a restored row whose projection is there, the
// same founder block is inserted at the start of that frame, so the episode
// copy reads exactly like the restored row. Only the permitted episode is
// touched; each frame must be the unique projection of the row's pre-restoration
// content and sit at its approved relabel location (mapped to corrected
// coordinates). The prefix up to the end of the last frame is hash-checked and
// everything after it is kept; a rerun is detected by the corrected prefix.

export const EPISODE_KIND = 'restore-image-founder-text-episode';
export const PERMITTED_EPISODE_ID = '41200170-1c49-4660-838c-9d397aff5d27';

export interface EpisodeInsert {
  rowId: string;
  /** Offset of the frame's leading "\n" in the current (relabelled) episode. */
  frameOffset: number;
  frameLength: number;
  frameSha256: string;
  founderTextSha256: string;
}

export interface EpisodeInsertPlan {
  kind: typeof EPISODE_KIND;
  episodeId: string;
  restoreListSha256: string;
  inserts: EpisodeInsert[];
  L: number;
  Lprime: number;
  prefixSha256: string;
  correctedPrefixSha256: string;
  insertListSha256: string;
}

function insertBlocks(prefix: string, inserts: EpisodeInsert[], texts: Map<string, string>): string {
  let out = prefix;
  for (const e of [...inserts].sort((a, b) => b.frameOffset - a.frameOffset)) {
    out = out.slice(0, e.frameOffset + 1) + `${LABEL}${texts.get(e.rowId)}\n\n` + out.slice(e.frameOffset + 1);
  }
  return out;
}

/** Build the plan for the given inserts and texts. Pure. */
export function buildEpisodePlan(content: string, restoreListSha256: string, inserts: EpisodeInsert[], texts: Map<string, string>): EpisodeInsertPlan {
  const sorted = [...inserts].sort((a, b) => a.frameOffset - b.frameOffset);
  const L = sorted[sorted.length - 1].frameOffset + sorted[sorted.length - 1].frameLength;
  const corrected = insertBlocks(content.slice(0, L), sorted, texts);
  return {
    kind: EPISODE_KIND, episodeId: PERMITTED_EPISODE_ID, restoreListSha256, inserts: sorted, L, Lprime: corrected.length,
    prefixSha256: sha256(content.slice(0, L)), correctedPrefixSha256: sha256(corrected), insertListSha256: sha256(JSON.stringify(sorted)),
  };
}

/** Decide the episode from its current content and the transcript texts. Pure. */
export function decideEpisodeInsert(content: string, plan: EpisodeInsertPlan, texts: Map<string, string>): RestoreOutcome {
  if (plan.kind !== EPISODE_KIND || plan.episodeId !== PERMITTED_EPISODE_ID || sha256(JSON.stringify(plan.inserts)) !== plan.insertListSha256) {
    return { status: 'drifted', reason: 'plan is not a valid episode insert plan' };
  }
  for (const e of plan.inserts) {
    if (!texts.has(e.rowId) || sha256(texts.get(e.rowId)!) !== e.founderTextSha256) return { status: 'drifted', reason: 'transcript text does not match the plan' };
  }
  if (content.length >= plan.L && sha256(content.slice(0, plan.L)) === plan.prefixSha256) {
    for (const e of plan.inserts) {
      if (sha256(content.slice(e.frameOffset, e.frameOffset + e.frameLength)) !== e.frameSha256) return { status: 'drifted', reason: `frame at ${e.frameOffset} changed` };
    }
    const corrected = insertBlocks(content.slice(0, plan.L), plan.inserts, texts);
    if (corrected.length !== plan.Lprime || sha256(corrected) !== plan.correctedPrefixSha256) return { status: 'drifted', reason: 'corrected prefix does not match the plan' };
    return { status: 'apply', next: corrected + content.slice(plan.L) };
  }
  if (content.length >= plan.Lprime && sha256(content.slice(0, plan.Lprime)) === plan.correctedPrefixSha256) return { status: 'already-applied' };
  return { status: 'drifted', reason: 'episode prefix changed since the plan' };
}

async function readTexts(entries: RestoreEntry[], load: (s: string) => any[] | null): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for (const entry of entries) {
    const m = CAPTURE.exec(entry.captureId);
    const transcript = m ? load(m[1]) : null;
    const found = transcript ? founderMessageFor(transcript, Number(m![2])) : { reason: 'transcript missing' };
    if ('text' in found && found.index === entry.founderIndex && sha256(found.text) === entry.founderTextSha256) texts.set(entry.rowId, found.text);
  }
  return texts;
}

async function generateEpisode(pool: Pool): Promise<void> {
  const out = arg('out');
  if (!out) throw new Error('--out is required');
  const restore = JSON.parse(readFileSync(arg('restore-receipt') ?? 'server/scripts/receipts/restore-image-founder-text.json', 'utf8'));
  const relabel = JSON.parse(readFileSync(arg('relabel-episode-receipt') ?? 'scripts/data-ops/relabel-runtime-notices.episode-receipt.json', 'utf8'));
  const editIndex = new Map<string, { offset: number; i: number }>(relabel.edits.map((e: any, i: number) => [e.sourceRowId, { offset: e.offset, i }]));
  const episode: string = (await pool.query('SELECT content FROM conversation_memories WHERE id = $1', [PERMITTED_EPISODE_ID])).rows[0].content;
  const { rows } = await pool.query(`SELECT id::text AS id, content FROM conversation_memories WHERE id::text IN (SELECT jsonb_array_elements_text($1::jsonb))`,
    [JSON.stringify(restore.entries.map((e: RestoreEntry) => e.rowId))]);
  const byId = new Map(rows.map((r: any) => [r.id, r.content as string]));
  const texts = await readTexts(restore.entries, transcriptLoader(arg('transcripts') ?? TRANSCRIPTS));
  const inserts: EpisodeInsert[] = [];
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  for (const entry of restore.entries as RestoreEntry[]) {
    const relabelEdit = editIndex.get(entry.rowId);
    if (!relabelEdit) { skip('row has no Episode 34 projection'); continue; }
    const current = byId.get(entry.rowId);
    const text = texts.get(entry.rowId);
    if (!current || !text || sha256(current) !== entry.postSha256) { skip('row is not in its restored state'); continue; }
    const pre = current.slice(`${LABEL}${text}\n\n`.length);
    if (sha256(pre) !== entry.preSha256) { skip('restored row does not split cleanly'); continue; }
    const frame = `\n${pre.trim()}\n`;
    const at = episode.indexOf(frame);
    const mapped = relabelEdit.offset - 10 * relabelEdit.i - 1; // relabel shrank each earlier label by 10
    if (at < 0 || episode.indexOf(frame, at + 1) !== -1 || at !== mapped) { skip('projection not found uniquely at its approved location'); continue; }
    inserts.push({ rowId: entry.rowId, frameOffset: at, frameLength: frame.length, frameSha256: sha256(frame), founderTextSha256: entry.founderTextSha256 });
  }
  if (!inserts.length) { console.log(JSON.stringify({ inserts: 0, skipped }, null, 2)); return; }
  const plan = buildEpisodePlan(episode, restore.listSha256, inserts, texts);
  writeLocal(out, JSON.stringify(plan, null, 2) + '\n');
  console.log(JSON.stringify({ out, inserts: inserts.length, skipped, L: plan.L, Lprime: plan.Lprime, insertListSha256: plan.insertListSha256 }, null, 2));
}

async function applyEpisode(pool: Pool): Promise<void> {
  const planPath = arg('plan');
  const approved = arg('insert-list-sha');
  if (!planPath || !approved) throw new Error('--plan and --insert-list-sha are required');
  const plan: EpisodeInsertPlan = JSON.parse(readFileSync(planPath, 'utf8'));
  if (plan.insertListSha256 !== approved) throw new Error('plan is not the approved insert list');
  const restore = JSON.parse(readFileSync(arg('restore-receipt') ?? 'server/scripts/receipts/restore-image-founder-text.json', 'utf8'));
  if (plan.restoreListSha256 !== restore.listSha256) throw new Error('plan is not bound to the restoration receipt');
  const texts = await readTexts(restore.entries.filter((e: RestoreEntry) => plan.inserts.some(i => i.rowId === e.rowId)), transcriptLoader(arg('transcripts') ?? TRANSCRIPTS));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT content, attribution FROM conversation_memories WHERE id = $1 FOR UPDATE', [PERMITTED_EPISODE_ID]);
    let status: string;
    if (!rows.length) status = 'drifted';
    else if (rows[0].attribution !== null && rows[0].attribution !== undefined) status = 'attributed';
    else {
      const outcome = decideEpisodeInsert(rows[0].content, plan, texts);
      status = outcome.status === 'drifted' ? `drifted: ${outcome.reason}` : outcome.status;
      if (outcome.status === 'apply') await client.query('UPDATE conversation_memories SET content = $2 WHERE id = $1', [PERMITTED_EPISODE_ID, outcome.next]);
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ episode: PERMITTED_EPISODE_ID, status, inserts: plan.inserts.length }, null, 2));
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

if (process.argv[1] && /restore-image-row-founder-text\.ts$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const command = process.argv[2];
  const pool = new Pool({ connectionString: process.env.NEON_SHARED_DATABASE_URL });
  const commands: Record<string, (p: Pool) => Promise<void>> = { generate, apply, 'generate-episode': generateEpisode, 'apply-episode': applyEpisode };
  (commands[command] ? commands[command](pool) : Promise.reject(new Error('usage: generate|apply|generate-episode|apply-episode')))
    .catch(err => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1; })
    .finally(() => pool.end());
}
