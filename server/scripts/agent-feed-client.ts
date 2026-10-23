/**
 * Agent awareness feed, stage F-P3: the Claude Code runtime client (hat feed
 * design r5.1, §4 and §7). It reads the F-P1 endpoints under this runtime's own
 * credential and prints what should enter the session's context:
 *
 *   session-start: register this session's epoch, run its one bootstrap, print
 *     a bounded summary of what the other hats said, and only after printing,
 *     acknowledge exactly the items that bootstrap served;
 *   prompt: peek; only when something unseen is pending, take one notice
 *     (debited by the server before it returns), print it, then record it seen.
 *
 * Fails open: any error prints nothing to stdout, logs one line to stderr and
 * exits 0, so a session never waits on or breaks because of the feed.
 *
 *   npx tsx server/scripts/agent-feed-client.ts session-start|prompt --session <id> [--runtime-id <id>] [--remote URL]
 */

export type Transport = (path: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;

interface FeedItem {
  id: string;
  sha256: string;
  source: string[];
  createdAt: string;
  excerpt: string;
  clipped: { shown: number; total: number } | null;
  changed: boolean;
}

const SOURCE_LABELS: Record<string, string> = {
  'source-replit': 'Luca [Replit]',
  'source-claude-code': 'Luca [Claude Code]',
};

function label(source: string[]): string {
  const names = source.map((s) => SOURCE_LABELS[s] ?? s);
  return names.length ? names.join(', ') : 'unknown source';
}

/** One item, as it appears in context. Pure. Clipping is always stated. */
export function renderItem(item: FeedItem): string {
  const clip = item.clipped ? ` [clipped at ${item.clipped.shown} of ${item.clipped.total} chars]` : '';
  const changed = item.changed ? ' (changed since you last saw it)' : '';
  return `- ${label(item.source)}, ${item.createdAt.slice(0, 16)}Z, row ${item.id}${changed}\n${item.excerpt}${clip}`;
}

/**
 * The session-start context block, or '' when there is nothing to show. Pure.
 * Two bounded, separately labelled pages: other hats' pending exchanges, and
 * this hat's own most recent prior-session exchanges (continuity, lookup only).
 */
export function renderBootstrap(result: { items?: FeedItem[]; morePending?: boolean; ownRecent?: FeedItem[] }): string {
  const items = result.items ?? [];
  const own = result.ownRecent ?? [];
  const sections: string[] = [];
  if (items.length) {
    const more = result.morePending ? '\nMore is pending: it arrives through notices or a catch-up page.' : '';
    sections.push([
      `Agent feed: ${items.length} exchange(s) from other hats since you last read the record (oldest first). Excerpts only; fetch a full row by id.`,
      ...items.map(renderItem),
    ].join('\n') + more);
  }
  if (own.length) {
    sections.push([
      `Your own most recent exchanges from earlier sessions (${own.length}, oldest first), for continuity. Excerpts only.`,
      ...own.map(renderItem),
    ].join('\n'));
  }
  return sections.join('\n\n');
}

/**
 * Marks the end of a complete output block on stdout. The hook forwards a block
 * only once this marker has arrived, and forwards it even if the client fails
 * or times out afterwards, so anything acknowledged has always been delivered.
 */
export const OUTPUT_END = '[[agent-feed:end]]';

export type Print = (text: string) => void | Promise<void>;

function servedItems(items: FeedItem[]): Array<{ itemKind: 'canonical'; id: string; sha256: string }> {
  return items.map((i) => ({ itemKind: 'canonical', id: i.id, sha256: i.sha256 }));
}

/**
 * Session start: register, bootstrap once, print the complete block, then
 * acknowledge only the other-hat items that bootstrap served. Own-hat rows are
 * lookup only (not in the served manifest), so they are never acknowledged.
 */
export async function sessionStart(transport: Transport, sessionId: string, print: Print): Promise<void> {
  const { registrationId } = await transport('register', { runtimeSessionId: sessionId });
  const result = await transport('bootstrap', { registrationId }) as { servedId?: string; items?: FeedItem[]; morePending?: boolean; ownRecent?: FeedItem[] };
  const text = renderBootstrap(result);
  if (!text) return;
  await print(text);
  if ((result.items ?? []).length) {
    await transport('ack', { registrationId, servedId: result.servedId, items: servedItems(result.items ?? []) });
  }
}

/** Before a prompt: only when something unseen is pending, take one notice, print it, then record it seen. */
export async function promptNotice(transport: Transport, sessionId: string, print: Print): Promise<void> {
  const { registrationId } = await transport('register', { runtimeSessionId: sessionId });
  const peeked = await transport('peek', { registrationId }) as { manifest?: unknown[]; attemptsLeft?: number };
  if (!peeked.manifest?.length || !peeked.attemptsLeft) return;
  const notice = await transport('notice', { registrationId }) as { attemptId?: string | null; body?: string | null };
  if (!notice.attemptId || !notice.body) return;
  await print(notice.body);
  await transport('notice-seen', { registrationId, attemptId: notice.attemptId });
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const sessionId = arg(args, 'session');
  const runtimeId = arg(args, 'runtime-id') ?? process.env.HOLAHOLA_RUNTIME_ID;
  const remote = arg(args, 'remote') ?? 'https://getholahola.com';
  if (command !== 'session-start' && command !== 'prompt') throw new Error('usage: session-start|prompt --session <id>');
  if (!sessionId || !/^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)) throw new Error('a valid --session is required');
  if (!runtimeId) throw new Error('a runtime id is required (--runtime-id or HOLAHOLA_RUNTIME_ID)');
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(remote)) throw new Error('--remote must be an https origin');
  const { RuntimeOnboardingClient } = await import('../services/runtime-onboarding-client');
  const { createNativeRuntimeOnboardingStore } = await import('../services/runtime-onboarding-store');
  const client = new RuntimeOnboardingClient({ endpoint: remote, actor: 'luca-claude-code', runtimeId, store: createNativeRuntimeOnboardingStore() });
  const transport: Transport = async (path, body) => {
    const res = await client.authenticatedFetch(`${remote}/api/coordination/agent-feed/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(6000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} returned ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
  // Writes the whole block and its end marker, and resolves only once the pipe
  // has taken them, before any acknowledgement is sent.
  const print: Print = (text) => new Promise<void>((done) => { process.stdout.write(`${text}\n${OUTPUT_END}\n`, () => done()); });
  if (command === 'session-start') await sessionStart(transport, sessionId, print);
  else await promptNotice(transport, sessionId, print);
}

if (process.argv[1] && /agent-feed-client\.ts$/.test(process.argv[1].replace(/\\/g, '/'))) {
  main().catch((e) => { console.error(`[agent-feed] ${e instanceof Error ? e.message : String(e)}`); });
}
