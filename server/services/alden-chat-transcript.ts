/**
 * Pure helpers for syncing the conversational part of David's Alden sessions
 * into conversation_memories (Daniela's recall), per the founder's direction
 * (2026-10-25): memory is the human narrative; the technical record stays in
 * alden_conversations / alden_messages, where any hat or tool can query it.
 *
 * Rules (reviewed with Luca [Replit], Gemini-approved):
 * - The unit is an exchange: one caller message and its reply. It is kept or
 *   dropped whole; nothing inside a kept exchange is ever altered.
 * - Only exchanges David starts are candidates. A reply from more than one
 *   engine is excluded rather than collapsed into one voice; one engine
 *   replying in several phases is joined in order (one speaker).
 * - Labels bind the exact source text and the policy, via labelKey.
 * - Consecutive kept exchanges form a cluster: one memory row each, opening
 *   with the Gemini-approved framing line.
 * See founder-chat-sync.ts for the worker that uses them.
 */
import { createHash } from 'node:crypto';

export type AldenMessageRow = { id: string; role: string; content: string };

/** Bump whenever selection, prefilter, classifier or framing changes. */
export const ALDEN_NARRATIVE_POLICY_VERSION = 'alden-narr-policy:1';

/** Alden's primer, Gemini-approved unconditionally 2026-10-25 (rephrase rule). */
export const ALDEN_MEMORY_FRAMING_LINE = 'From a conversation between David and Alden, his development partner:';

export const sha256Utf8 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const sha256 = sha256Utf8;

/**
 * Speaker label for an alden_messages role. Unknown roles keep their raw value
 * so nothing is silently relabelled as someone else.
 */
export function aldenSpeakerLabel(role: string): string {
  if (role === 'david') return 'David';
  if (role === 'luca') return 'Luca [Replit]';
  if (role === 'daniela') return 'Daniela';
  if (role === 'alden') return 'Alden';
  const engine = /^alden-([a-z0-9_-]+)$/i.exec(role);
  if (engine) return `Alden [${engine[1]}]`;
  return role;
}

const isAldenRole = (role: string) => role === 'alden' || /^alden-[a-z0-9_-]+$/i.test(role);

export type AldenExchange = {
  caller: AldenMessageRow;
  /** The selected reply: all replies when every one has the same role, joined in order. */
  reply: { role: string; content: string; messageIds: string[] } | null;
  /** Why the exchange cannot be a candidate at all, before any classification. */
  excludedReason: string | null;
};

/** Group an ordered message list into caller turns with their replies, applying the selection policy. */
export function groupAldenExchanges(messages: readonly AldenMessageRow[]): AldenExchange[] {
  const groups: Array<{ caller: AldenMessageRow; replies: AldenMessageRow[] }> = [];
  for (const m of messages) {
    if (isAldenRole(m.role)) groups[groups.length - 1]?.replies.push(m);
    else groups.push({ caller: m, replies: [] });
  }
  return groups.map(({ caller, replies }) => {
    if (caller.role !== 'david') return { caller, reply: null, excludedReason: `caller is ${caller.role}, not David` };
    if (replies.length === 0) return { caller, reply: null, excludedReason: 'no reply' };
    const roles = new Set(replies.map((r) => r.role));
    if (roles.size > 1) {
      return { caller, reply: null, excludedReason: `replies from more than one engine (${[...roles].sort().join(', ')})` };
    }
    return {
      caller,
      reply: { role: replies[0].role, content: replies.map((r) => r.content).join('\n\n'), messageIds: replies.map((r) => r.id) },
      excludedReason: null,
    };
  });
}

/**
 * Technical markers per 1,000 characters: code fences, inline code, SQL,
 * file paths, PR/issue numbers, long hex ids, stack-trace lines.
 */
export function technicalDensity(text: string): number {
  if (!text) return 0;
  const count = (re: RegExp) => (text.match(re) ?? []).length;
  const markers =
    count(/```/g) * 5
    + count(/`[^`\n]+`/g)
    + count(/\b(SELECT|INSERT|UPDATE|DELETE|CREATE TABLE|ALTER TABLE)\b[\s\S]{0,80}?\b(FROM|INTO|SET|TABLE|WHERE)\b/g) * 3
    + count(/\b[\w.-]+\/[\w./-]+\.(ts|tsx|js|mjs|md|sql|json|yml|ps1)\b/g)
    + count(/(?:\bPR\s*#?\d{2,}|#\d{2,}\b)/g)
    + count(/\b[0-9a-f]{8,40}\b/g)
    + count(/^\s+at\s+\S+\s*\(/gm);
  return (markers * 1000) / text.length;
}

/** Above this many markers per 1,000 characters the prefilter labels an exchange technical. */
export const NARRATIVE_MAX_DENSITY = 4;

export type Prefilter =
  | { decision: 'classify'; density: number }
  | { decision: 'label'; label: 'technical' | 'excluded'; reason: string; density: number | null };

/**
 * Deterministic first stage. `alters` reports whether the founder-chat
 * sanitizer would change the text: such an exchange is excluded rather than
 * stored altered, so "verbatim" stays literally true.
 */
export function prefilterExchange(exchange: AldenExchange, alters: (raw: string) => boolean): Prefilter {
  if (exchange.excludedReason || !exchange.reply) {
    return { decision: 'label', label: 'excluded', reason: exchange.excludedReason ?? 'no reply', density: null };
  }
  const text = `${exchange.caller.content}\n${exchange.reply.content}`;
  if (/```/.test(text)) return { decision: 'label', label: 'excluded', reason: 'contains a code fence', density: null };
  if (alters(exchange.caller.content) || alters(exchange.reply.content)) {
    return { decision: 'label', label: 'excluded', reason: 'sanitizer would alter the text', density: null };
  }
  const density = technicalDensity(text);
  if (density > NARRATIVE_MAX_DENSITY) {
    return { decision: 'label', label: 'technical', reason: `prefilter density ${density.toFixed(2)} > ${NARRATIVE_MAX_DENSITY}`, density };
  }
  return { decision: 'classify', density };
}

/**
 * Everything that defines a label, including both speakers (a reply relabelled
 * from `alden` to `alden-gemini` renders differently, so it must not reuse the
 * label). Any change gives a new key, and so a fresh label.
 */
export function exchangeLabelKey(exchange: AldenExchange, classifierModel: string, promptSha256: string): string {
  return sha256(JSON.stringify([
    exchange.caller.id,
    exchange.caller.role,
    exchange.reply?.role ?? null,
    sha256(exchange.caller.content),
    exchange.reply?.messageIds ?? [],
    exchange.reply ? sha256(exchange.reply.content) : null,
    ALDEN_NARRATIVE_POLICY_VERSION,
    classifierModel,
    promptSha256,
  ]));
}

export const isKeptLabel = (label: string) => label === 'conversational' || label === 'mixed';

export type AldenCluster = {
  /** Stable while a cluster only grows at its end: the first caller message id. */
  anchorCallerId: string;
  /** Changes whenever the cluster's exchanges or their labels change. */
  clusterSha256: string;
  exchangeCount: number;
  content: string;
};

/**
 * Consecutive kept exchanges (in order) form a cluster; any other exchange
 * ends it. Each cluster's content is the framing line and then the exchanges,
 * verbatim, as "<Speaker>: <text>".
 */
export function buildAldenClusters(labelled: ReadonlyArray<{ exchange: AldenExchange; labelKey: string; label: string }>): AldenCluster[] {
  const clusters: AldenCluster[] = [];
  let run: typeof labelled[number][] = [];
  const close = () => {
    if (run.length === 0) return;
    const lines = [ALDEN_MEMORY_FRAMING_LINE];
    for (const { exchange } of run) {
      lines.push(`${aldenSpeakerLabel(exchange.caller.role)}: ${exchange.caller.content}`);
      lines.push(`${aldenSpeakerLabel(exchange.reply!.role)}: ${exchange.reply!.content}`);
    }
    clusters.push({
      anchorCallerId: run[0].exchange.caller.id,
      // Binds the labels AND the exact rendered text, so a change in either is an update.
      clusterSha256: sha256(JSON.stringify([run.map((r) => r.labelKey), sha256(lines.join('\n\n'))])),
      exchangeCount: run.length,
      content: lines.join('\n\n'),
    });
    run = [];
  };
  for (const item of labelled) {
    if (isKeptLabel(item.label) && item.exchange.reply) run.push(item);
    else close();
  }
  close();
  return clusters;
}

export type ExistingClusterRow = { id: string; anchorCallerId: string | null; clusterSha256: string | null };

/**
 * Deterministic reconciliation of one session's derived rows against its
 * current clusters. Rows are matched by anchor; a changed cluster updates its
 * row, a vanished one retires it, and a duplicate anchor retires the extras.
 * Source rows are never involved.
 */
export function reconcileAldenClusters(existing: readonly ExistingClusterRow[], desired: readonly AldenCluster[]) {
  const byAnchor = new Map<string, ExistingClusterRow[]>();
  for (const row of existing) {
    const key = row.anchorCallerId ?? `?${row.id}`;
    byAnchor.set(key, [...(byAnchor.get(key) ?? []), row]);
  }
  const insert: AldenCluster[] = [];
  const update: Array<{ id: string; cluster: AldenCluster }> = [];
  const unchanged: string[] = [];
  const retire: string[] = [];
  for (const cluster of desired) {
    const rows = [...(byAnchor.get(cluster.anchorCallerId) ?? [])].sort((a, b) => a.id.localeCompare(b.id));
    byAnchor.delete(cluster.anchorCallerId);
    if (rows.length === 0) { insert.push(cluster); continue; }
    const [keep, ...extra] = rows;
    retire.push(...extra.map((r) => r.id));
    if (keep.clusterSha256 === cluster.clusterSha256) unchanged.push(keep.id);
    else update.push({ id: keep.id, cluster });
  }
  for (const rows of byAnchor.values()) retire.push(...rows.map((r) => r.id));
  return { insert, update, unchanged, retire };
}

/** The memory-arm inputs reembed-memory.ts builds for a conversation_memories row, reproduced exactly. */
export type RecallArm = { memoryType: 'conversation_memory' | 'conversation_summary' | 'conversation_chunk'; memoryId: string; input: string };

export function aldenRecallArms(
  row: { id: string; title: string; summary: string; content: string },
  chunker: { split: (text: string) => string[]; reformat: (chunk: string) => string },
): RecallArm[] {
  const arms: RecallArm[] = [
    { memoryType: 'conversation_memory', memoryId: row.id, input: [row.title, row.summary, row.content].filter(Boolean).join('\n\n') },
  ];
  if (row.summary && row.summary.length > 10) {
    arms.push({ memoryType: 'conversation_summary', memoryId: row.id, input: [row.title, row.summary].filter(Boolean).join('\n\n') });
  }
  const chunks = chunker.split(row.content);
  chunks.forEach((chunk, i) => arms.push({
    memoryType: 'conversation_chunk',
    memoryId: `${row.id}:chunk:${i}`,
    input: `[Memory: ${row.title ?? 'Untitled'} | Part ${i + 1} of ${chunks.length}]\n\n${chunker.reformat(chunk)}`,
  }));
  return arms;
}

/**
 * Is a derived row's recall exactly current? Every expected arm (full,
 * summary, each chunk) must exist with the hash of its input as the row
 * stands now, and no other arm may exist for the row. Anything else (a
 * missing, stale or extra arm) means the row is re-embedded.
 */
export function aldenEmbeddingCurrent(
  expected: readonly RecallArm[],
  stored: ReadonlyArray<{ memoryType: string; memoryId: string; contentHash: string }>,
  hash: (text: string) => string,
): boolean {
  if (stored.length !== expected.length) return false;
  const have = new Map(stored.map((arm) => [`${arm.memoryType}|${arm.memoryId}`, arm.contentHash]));
  return expected.every((arm) => have.get(`${arm.memoryType}|${arm.memoryId}`) === hash(arm.input));
}

/** The full-content arm's input, as reembed-memory.ts builds it: title, summary, content. */
export const fullArmInput = (row: { title: string; summary: string; content: string }) =>
  [row.title, row.summary, row.content].filter(Boolean).join('\n\n');
