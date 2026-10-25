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

if (process.argv[1] && /restore-image-row-founder-text\.ts$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const command = process.argv[2];
  const pool = new Pool({ connectionString: process.env.NEON_SHARED_DATABASE_URL });
  (command === 'generate' ? generate(pool) : command === 'apply' ? apply(pool) : Promise.reject(new Error('usage: generate|apply')))
    .catch(err => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1; })
    .finally(() => pool.end());
}
