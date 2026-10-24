/**
 * generate-runtime-notice-relabel-receipt.ts — READ-ONLY.
 *
 * Builds the exact list for the one-time runtime-notice relabel (founder
 * decision 2026-10-23: relabel in place). It writes nothing to the database.
 *
 * A canonical Claude Code row qualifies only when its own source proves the
 * turn was opened by the runtime, not by David:
 *   - its capture id cc-<session>-<index> names a Claude Code transcript that
 *     is present on this machine;
 *   - that transcript's entry at <index> is a user entry that
 *     classifyUserEntry (.claude/hooks/runtime-entries.mjs, the reviewed
 *     provenance rules) classifies as runtime;
 *   - the row's `David [Claude Code]: ` block equals that entry's text exactly;
 *   - the row has no per-turn attribution column.
 * Anything else is never corrected: it is counted as unverified (with the
 * reason) and left exactly as stored. Text shape alone never qualifies a row.
 *
 * The receipt holds no dialogue: row ids, capture ids, the provenance basis,
 * the label span and hashes only.
 *
 *   npx tsx server/scripts/generate-runtime-notice-relabel-receipt.ts [--out <file>] [--transcripts <dir>]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Pool } from '@neondatabase/serverless';
// @ts-expect-error -- plain ESM hook module without type declarations
import { classifyUserEntry } from '../../.claude/hooks/runtime-entries.mjs';
import { RUNTIME_NOTICE_LABEL } from '../services/runtime-notice-relabel';

const OLD_PREFIX = 'David [Claude Code]: ';
const CAPTURE_TAG = /^capture-id:(cc-([0-9a-f-]{36})-(\d+))$/;

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n\n');
}

/** The row's leading founder-labelled block: from the label to the first "\n\nClaude Code: ". */
export function leadingBlock(content: string): string | null {
  if (!content.startsWith(OLD_PREFIX)) return null;
  const end = content.indexOf('\n\nClaude Code: ', OLD_PREFIX.length);
  return end === -1 ? null : content.slice(OLD_PREFIX.length, end);
}

export interface ReceiptEntry {
  rowId: string;
  captureId: string;
  basis: string;
  offset: 0;
  oldLabel: string;
  newLabel: string;
  lineSha256: string;
  preSha256: string;
  postSha256: string;
}

export type Verdict =
  | { kind: 'correct'; entry: ReceiptEntry }
  | { kind: 'founder' }
  | { kind: 'unverified'; reason: string };

/** Decide one row from its stored content and its transcript entry. Pure. */
export function judgeRow(
  row: { id: string; content: string; hasAttribution: boolean; captureId: string | null },
  transcriptEntry: unknown | undefined,
  transcriptPresent: boolean,
): Verdict {
  if (row.hasAttribution) return { kind: 'unverified', reason: 'row has per-turn attribution' };
  if (!row.captureId) return { kind: 'unverified', reason: 'no capture id' };
  const block = leadingBlock(row.content);
  if (block === null) return { kind: 'unverified', reason: 'unexpected row structure' };
  if (!transcriptPresent) return { kind: 'unverified', reason: 'transcript not on this machine' };
  const entry = transcriptEntry as any;
  if (!entry || entry.type !== 'user') return { kind: 'unverified', reason: 'transcript index is not a user entry' };
  if (extractText(entry.message?.content).trim() !== block) return { kind: 'unverified', reason: 'row text differs from transcript entry' };
  const author = classifyUserEntry(entry) as { founder: boolean; basis: string };
  if (author.founder) return { kind: 'founder' };
  const newLabel = `${RUNTIME_NOTICE_LABEL}:`;
  const firstLineEnd = row.content.indexOf('\n', OLD_PREFIX.length);
  const rest = row.content.slice(OLD_PREFIX.length, firstLineEnd === -1 ? row.content.length : firstLineEnd);
  const post = newLabel + row.content.slice(OLD_PREFIX.length - 1);
  return {
    kind: 'correct',
    entry: {
      rowId: row.id, captureId: row.captureId, basis: author.basis, offset: 0,
      oldLabel: 'David [Claude Code]:', newLabel, lineSha256: sha256(rest),
      preSha256: sha256(row.content), postSha256: sha256(post),
    },
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const transcriptsDir = arg('transcripts') ?? join(homedir(), '.claude', 'projects', 'C--Users-David-HolaHola');
  const out = arg('out') ?? join('.local', 'runtime-notice-relabel', `receipt-${Date.now()}.json`);
  // The receipt is evidence for review, never written into tracked source.
  if (!/[\\/]\.local[\\/]/.test(resolve(out))) throw new Error('--out must be inside a .local/ directory');
  const sessions = new Set(existsSync(transcriptsDir) ? readdirSync(transcriptsDir).filter(n => n.endsWith('.jsonl')).map(n => n.slice(0, -6)) : []);
  const cache = new Map<string, unknown[]>();
  const entriesOf = (session: string): unknown[] => {
    if (!cache.has(session)) {
      const lines = readFileSync(join(transcriptsDir, `${session}.jsonl`), 'utf8').split('\n').filter(Boolean);
      cache.set(session, lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
    }
    return cache.get(session)!;
  };

  const pool = new Pool({ connectionString: process.env.NEON_SHARED_DATABASE_URL });
  try {
    const { rows } = await pool.query(
      `SELECT id::text AS id, content, tags, (attribution IS NOT NULL) AS has_attribution
         FROM conversation_memories
        WHERE entry_type = 'conversation' AND content LIKE 'David [Claude Code]: %'
        ORDER BY created_at, id`,
    );
    const entries: ReceiptEntry[] = [];
    const unverified: Record<string, number> = {};
    let founder = 0;
    for (const r of rows) {
      const tag = (r.tags as string[] | null ?? []).map(t => CAPTURE_TAG.exec(t)).find(Boolean);
      const captureId = tag ? tag[1] : null;
      const session = tag ? tag[2] : null;
      const index = tag ? Number(tag[3]) : -1;
      const present = session !== null && sessions.has(session);
      const entry = present ? entriesOf(session!)[index] : undefined;
      const verdict = judgeRow({ id: r.id, content: r.content, hasAttribution: r.has_attribution, captureId }, entry, present);
      if (verdict.kind === 'correct') entries.push(verdict.entry);
      else if (verdict.kind === 'founder') founder++;
      else unverified[verdict.reason] = (unverified[verdict.reason] ?? 0) + 1;
    }
    const byBasis: Record<string, number> = {};
    for (const e of entries) byBasis[e.basis] = (byBasis[e.basis] ?? 0) + 1;
    const receipt = {
      kind: 'runtime-notice-relabel-rows',
      generatedAt: new Date().toISOString(),
      label: RUNTIME_NOTICE_LABEL,
      scanned: rows.length,
      entries,
      listSha256: sha256(JSON.stringify(entries)),
    };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ out, scanned: rows.length, toCorrect: entries.length, byBasis, founderLabelCorrect: founder, unverified, listSha256: receipt.listSha256 }, null, 2));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && /generate-runtime-notice-relabel-receipt\.ts$/.test(process.argv[1].replace(/\\/g, '/'))) {
  main().catch(err => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
}
