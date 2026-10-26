// End-to-end proof for task 1450: Alden can reliably search code (rg-first with a
// bounded production-safe fallback) and message Luca through his own coordination
// tools — create a thread, have "Luca" reply, and observe that reply — all routed
// through Alden's own tool dispatcher (executeAldenTool / ALDEN_TOOLS), never
// Daniela's registry. Handoffs land in PostgreSQL first; nothing here touches
// Markdown.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { coordinationThreads } from '@shared/schema';
import { closeDbConnections, getSharedDb } from '../db';
import { appendCoordinationEvent, createCoordinationThread, getCoordinationThread } from '../services/coordination-ledger-service';
import { getVerifiedCiDatabaseUrl } from '../ci-database';
import {
  ALDEN_TOOLS,
  executeAldenTool,
  __setRgAvailableOverrideForTesting,
} from '../services/alden-functions';

const runId = randomUUID();
const hasIsolatedCiDatabase = Boolean(getVerifiedCiDatabaseUrl());
const databaseTest = hasIsolatedCiDatabase ? test : test.skip;
const threadIds: string[] = [];

after(async () => {
  __setRgAvailableOverrideForTesting(null);
  if (!hasIsolatedCiDatabase) return;
  const db = getSharedDb();
  for (const id of threadIds) {
    await db.delete(coordinationThreads).where(eq(coordinationThreads.id, id));
  }
  await closeDbConnections();
});

test('the coordination tools are registered on Alden\'s own registry', () => {
  const names = ALDEN_TOOLS.map((t) => t.name);
  assert.ok(names.includes('create_coordination_thread'));
  assert.ok(names.includes('list_coordination_inbox'));
  assert.ok(names.includes('reply_to_coordination_thread'));
});

databaseTest('Alden can message Luca through his own tools and observe the reply', async () => {
  const title = `Alden→Luca e2e ${runId}`;
  const description = 'End-to-end proof for task 1450: Alden opens this thread directly through his own create_coordination_thread tool.';

  // 1. Alden creates a thread addressed to Luca through his own tool dispatcher —
  //    not the raw ledger service — proving the declaration is wired end to end.
  const created = await executeAldenTool('create_coordination_thread', {
    recipient: 'luca-replit',
    title,
    description,
    model: 'claude-opus-4.6',
  });
  assert.equal(created.data.error, undefined, `create_coordination_thread failed: ${created.data.error}`);
  assert.equal(typeof created.data.threadId, 'string');
  const threadId = created.data.threadId;
  threadIds.push(threadId);
  assert.equal(created.data.recipient, 'luca-replit');
  assert.equal(created.data.sequence, 1);

  // 2. Simulate Luca replying on the thread — a direct ledger call standing in for
  //    the luca-replit runtime, exactly like the existing multi-actor ledger tests do.
  const replyContent = `Received, Alden — I see thread ${runId}.`;
  await appendCoordinationEvent({
    threadId,
    actor: 'luca-replit',
    eventType: 'comment',
    content: replyContent,
    recipientActor: 'alden',
    idempotencyKey: `coordination-test:${runId}:luca-reply`,
    expectedSequence: created.data.sequence,
  });

  // 3. Alden reads his own inbox through his own tool dispatcher and must see
  //    Luca's reply — proving the read path is also wired to his own registry.
  const inbox = await executeAldenTool('list_coordination_inbox', { limit: 50 });
  assert.equal(inbox.data.error, undefined, `list_coordination_inbox failed: ${inbox.data.error}`);
  assert.ok(Array.isArray(inbox.data.items));
  const seen = inbox.data.items.find(
    (item: any) => item.threadId === threadId && item.content === replyContent,
  );
  assert.ok(seen, "Alden's inbox must contain Luca's reply on the thread Alden created");
  assert.equal(seen.from, 'luca-replit');

  // 4. Alden replies back on the same thread through his own tool dispatcher —
  //    proving the recipient-facing reply path (not just create + read) works.
  const reply = await executeAldenTool('reply_to_coordination_thread', {
    thread_id: threadId,
    recipient: 'luca-replit',
    content: 'Got it — proceeding.',
    model: 'claude-opus-4.6',
  });
  assert.equal(reply.data.error, undefined, `reply_to_coordination_thread failed: ${reply.data.error}`);
  assert.ok(
    reply.data.sequence > created.data.sequence,
    'reply must advance the thread sequence',
  );
});

databaseTest('list_coordination_inbox token continuation advances past a full page and surfaces the newest reply', async () => {
  const title = `Alden pagination e2e ${runId}`;
  const description = 'Regression test for task 1450 review feedback: a bounded first page must not silently hide a newer reply, and the documented `token` continuation must actually advance past it.';

  const created = await executeAldenTool('create_coordination_thread', {
    recipient: 'luca-replit',
    title,
    description,
    model: 'claude-opus-4.6',
  });
  assert.equal(created.data.error, undefined, `create_coordination_thread failed: ${created.data.error}`);
  const pagingThreadId = created.data.threadId;
  threadIds.push(pagingThreadId);

  // Establish a clean baseline immediately before this test's own events exist,
  // so the assertions below are scoped to exactly what this test creates —
  // regardless of how much other inbox backlog already exists for alden in this
  // shared test-run database.
  const baseline = await executeAldenTool('list_coordination_inbox', { limit: 1 });
  assert.equal(baseline.data.error, undefined, `baseline list_coordination_inbox failed: ${baseline.data.error}`);
  const after = baseline.data.window.through;

  const olderReplyContent = `Older reply, page 1 ${runId}`;
  const newestReplyContent = `Newest reply, page 2 ${runId}`;
  await appendCoordinationEvent({
    threadId: pagingThreadId,
    actor: 'luca-replit',
    eventType: 'comment',
    content: olderReplyContent,
    recipientActor: 'alden',
    idempotencyKey: `coordination-test:${runId}:paging-reply-older`,
    expectedSequence: created.data.sequence,
  });
  await appendCoordinationEvent({
    threadId: pagingThreadId,
    actor: 'luca-replit',
    eventType: 'comment',
    content: newestReplyContent,
    recipientActor: 'alden',
    idempotencyKey: `coordination-test:${runId}:paging-reply-newest`,
    expectedSequence: created.data.sequence + 1,
  });

  // Page 1: a limit:1 read from the baseline must return only the OLDER reply,
  // report an incomplete window, and must NOT contain the newest reply yet.
  const page1 = await executeAldenTool('list_coordination_inbox', { after, limit: 1 });
  assert.equal(page1.data.error, undefined, `page1 list_coordination_inbox failed: ${page1.data.error}`);
  assert.equal(page1.data.items.length, 1, 'page 1 must be capped to the requested limit');
  assert.equal(page1.data.items[0].content, olderReplyContent);
  assert.equal(page1.data.window.complete, false, 'a page that hides newer items must report complete: false');
  assert.ok(page1.data.window.nextToken, 'an incomplete window must carry a continuation token');
  assert.ok(
    !page1.data.items.some((item: any) => item.content === newestReplyContent),
    'the newest reply must not be visible on a bounded first page — this is exactly what token continuation exists to fix',
  );

  // Page 2: forwarding the returned `token` (not re-passing `after`) must
  // advance past page 1 and surface the newest reply. Before this fix, Alden's
  // dispatcher never read or forwarded `token`, so this call would silently
  // repeat page 1 and could hide Luca's newest reply indefinitely.
  const page2 = await executeAldenTool('list_coordination_inbox', { token: page1.data.window.nextToken });
  assert.equal(page2.data.error, undefined, `page2 list_coordination_inbox failed: ${page2.data.error}`);
  assert.ok(
    page2.data.items.some((item: any) => item.content === newestReplyContent),
    "the token-continued page must expose Luca's newest reply",
  );
});

databaseTest('create_coordination_thread refuses a self-addressed thread before touching the ledger', async () => {
  const result = await executeAldenTool('create_coordination_thread', {
    recipient: 'alden',
    title: 'Should not be allowed',
    description: 'Self-addressed thread must be rejected before hitting the ledger.',
  });
  assert.match(result.data.error, /cannot address a coordination thread to yourself/);
});

test('reply_to_coordination_thread refuses a self-addressed reply', async () => {
  const result = await executeAldenTool('reply_to_coordination_thread', {
    thread_id: 'irrelevant-because-rejected-first',
    recipient: 'alden',
    content: 'Should not be allowed',
  });
  assert.match(result.data.error, /cannot address a reply to yourself/);
});

test('search_code finds a known symbol with rg, and the bounded JS fallback finds the same match when rg is unavailable', async () => {
  const pattern = 'export async function createCoordinationThread';
  const opts = { pattern, directory: 'server/services', file_glob: '*.ts' };

  __setRgAvailableOverrideForTesting(true);
  const withRg = await executeAldenTool('search_code', opts);
  assert.equal(withRg.data.error, undefined, `rg search_code failed: ${withRg.data.error}`);
  assert.equal(withRg.data.matchCount, 1, 'rg path must find exactly one match for this unique symbol');
  assert.ok(
    withRg.data.matches[0].file.endsWith('coordination-ledger-service.ts'),
    `expected match in coordination-ledger-service.ts, got: ${JSON.stringify(withRg.data.matches[0])}`,
  );
  assert.equal(withRg.data.note, undefined, 'rg path should carry no fallback note');

  __setRgAvailableOverrideForTesting(false);
  const withFallback = await executeAldenTool('search_code', opts);
  assert.equal(withFallback.data.error, undefined, `fallback search_code failed: ${withFallback.data.error}`);
  assert.equal(withFallback.data.matchCount, 1, 'fallback path must find the same single match');
  assert.ok(
    withFallback.data.matches[0].file.endsWith('coordination-ledger-service.ts'),
    `expected fallback match in coordination-ledger-service.ts, got: ${JSON.stringify(withFallback.data.matches[0])}`,
  );
  assert.match(withFallback.data.note ?? '', /bounded JS fallback/);

  __setRgAvailableOverrideForTesting(null);
});

test('interject_on_coordination_thread and brief_new_actor are registered on Alden\'s own registry', () => {
  const names = ALDEN_TOOLS.map((t) => t.name);
  assert.ok(names.includes('interject_on_coordination_thread'));
  assert.ok(names.includes('brief_new_actor'));
});

databaseTest('interject_on_coordination_thread lets Alden comment on a thread he never joined, through his own tool', async () => {
  // A thread with no reference to Alden at all -- not origin, not recipient, not owner.
  const created = await createCoordinationThread({
    actor: 'luca-replit',
    intendedRecipient: 'luca-claude-code',
    title: `Steward interjection via tool ${runId}`,
    description: 'Alden is not a participant on this thread; interject_on_coordination_thread must still work.',
    idempotencyKey: `coordination-test:${runId}:interject-create`,
  });
  threadIds.push(created.thread.id);

  const interjected = await executeAldenTool('interject_on_coordination_thread', {
    thread_id: created.thread.id,
    recipient: 'luca-replit',
    content: 'Stewardship note: this overlaps with another thread you may want to see.',
  });
  assert.equal(interjected.data.error, undefined, `interject_on_coordination_thread failed: ${interjected.data.error}`);
  assert.equal(interjected.data.state, 'created', 'interjecting must not change thread state');
  assert.ok(interjected.data.sequence > created.event.sequence, 'interjection must advance the thread sequence');

  const selfAddressed = await executeAldenTool('interject_on_coordination_thread', {
    thread_id: created.thread.id,
    recipient: 'alden',
    content: 'Should not be allowed',
  });
  assert.match(selfAddressed.data.error, /cannot address an interjection to yourself/);
});

databaseTest('brief_new_actor assembles a scoped briefing from the real operations catalog and posts it as a thread', async () => {
  const briefing = await executeAldenTool('brief_new_actor', { recipient: 'luca-replit' });
  assert.equal(briefing.data.error, undefined, `brief_new_actor failed: ${briefing.data.error}`);
  assert.equal(typeof briefing.data.threadId, 'string');
  threadIds.push(briefing.data.threadId);
  assert.equal(briefing.data.recipient, 'luca-replit');
  assert.ok(briefing.data.operationCount > 0, 'luca-replit has real operations catalog entries to brief');

  const { thread, events } = await getCoordinationThread(briefing.data.threadId, 'luca-replit');
  assert.equal(thread.originActor, 'alden');
  assert.equal(thread.intendedRecipient, 'luca-replit');
  assert.match(events[0].content, /operations catalog/);
  assert.match(events[0].content, /coordination-new-actor-onboarding\.md/);
  assert.match(events[0].content, /Registered runtime capabilities/);
  // The tool result is the posted artifact itself, so Alden can quote it and read it back.
  assert.equal(briefing.data.eventId, events[0].id);
  assert.equal(briefing.data.postedContent, events[0].content);
  assert.equal(briefing.data.operationIds.length, briefing.data.operationCount);
  const readBack = await executeAldenTool('read_coordination_message', {
    thread_id: briefing.data.threadId, event_id: briefing.data.eventId,
  });
  assert.equal(readBack.data.error, undefined, `read_coordination_message failed: ${readBack.data.error}`);
});

databaseTest('brief_new_actor fails closed instead of posting an empty or fabricated briefing when the recipient has no catalog entries', async () => {
  // Every real CoordinationActorId already has at least the ALL_COORDINATION_ACTORS-scoped
  // entries, so this proves the runtime fail-closed check itself works using a value that
  // bypasses the tool's declared enum -- exactly what an unonboarded id (added to
  // COORDINATION_ACTOR_IDS but not yet to operations-catalog.ts) would look like.
  const result = await executeAldenTool('brief_new_actor', { recipient: 'not-a-real-onboarded-actor' });
  assert.match(result.data.error, /No operations catalog entries are scoped to/);
  assert.match(result.data.error, /coordination-new-actor-onboarding\.md/);
});

test('search_multi also falls back cleanly when rg is unavailable', async () => {
  __setRgAvailableOverrideForTesting(false);
  const result = await executeAldenTool('search_multi', {
    searches: [
      { pattern: 'export async function appendCoordinationEvent', directory: 'server/services', file_glob: '*.ts' },
    ],
  });
  __setRgAvailableOverrideForTesting(null);
  assert.equal(result.data.error, undefined, `search_multi failed: ${result.data.error}`);
  assert.ok(Array.isArray(result.data.results));
  assert.equal(result.data.results[0].matchCount, 1);
  assert.match(result.data.results[0].note ?? '', /rg unavailable.*JS fallback/);
});

// Runtime-admin onboarding tools are non-secret. The old registration tool
// name remains in the registry for compatibility, but model conversations
// cannot use it to mint or receive bootstrap credentials.
test('runtime-admin tools are registered on Alden\'s own registry', () => {
  const names = ALDEN_TOOLS.map((t) => t.name);
  assert.ok(names.includes('register_coordination_runtime'));
  assert.ok(names.includes('revoke_coordination_runtime'));
  assert.ok(names.includes('list_coordination_runtimes'));
});

test('revoke_coordination_runtime rejects a missing runtime ID before touching the database', async () => {
  const missingRuntimeId = await executeAldenTool('revoke_coordination_runtime', {});
  assert.match(missingRuntimeId.data.error, /runtime_id is required/);
});

test('legacy register_coordination_runtime cannot create a runtime or expose bootstrap credentials', async () => {
  const result = await executeAldenTool('register_coordination_runtime', {
    runtime_id: `alden-tool-validation-${runId}`,
    actor: 'luca-replit',
    display_name: 'Must not be registered through model tools',
  });
  assert.match(result.data.error, /Direct bootstrap issuance through model tools is disabled/);
  assert.equal('bootstrapToken' in result.data, false);
  assert.equal('accessToken' in result.data, false);
});

databaseTest('revoke_coordination_runtime reports a clean error for an unknown runtime', async () => {
  const result = await executeAldenTool('revoke_coordination_runtime', { runtime_id: `unknown-${runId}` });
  assert.match(result.data.error, /Runtime registration not found/);
});
