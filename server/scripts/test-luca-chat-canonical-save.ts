/**
 * test-luca-chat-canonical-save.ts
 *
 * CI check: confirms that every David↔Luca exchange sent via
 * POST /api/admin/luca/chat is written to:
 *   1. conversation_memories with tag 'david-luca-chat' and both speaker lines
 *   2. memory_embeddings (parent + chunk arms stable)
 *
 * Normal execution owns a disposable migrated PostgreSQL database, temporary
 * workspace, and private application/provider HTTP server. Production routing,
 * authentication, persistence, and re-embedding run unchanged. Only outbound
 * completion/vector responses are deterministic fixtures. No live-server or
 * shared-database fallback is permitted; the owner tears everything down.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Normal mode
 * ─────────────────────────────────────────────────────────────────────────────
 *   0. Create the sandbox; verify its private server identity (max 15 s)
 *   1. POST a uniquely-sentinel-marked message to /api/admin/luca/chat
 *   2. Assert response shape: { reply, savedAt, noteIds }
 *   3. Immediately query conversation_memories by sentinel (synchronous insert)
 *   4. Poll memory_embeddings until count stabilises across all arms (max 30 s)
 *   5. Assert embeddings present
 *   6. [finally] Delete only the exact IDs returned by step 1:
 *        memory_embeddings (parent + chunks), conversation_memories,
 *        and the two agent_notes rows (David + Luca).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Self-check mode  (--self-check)
 * ─────────────────────────────────────────────────────────────────────────────
 *   - Runs assertion functions against fabricated broken payloads.
 *   - Each assertion must FAIL on the broken payload.
 *   - Exit 0 when all self-checks caught the failure.
 *   - Exit 1 when any assertion passed on a broken payload (guard is missing).
 *
 * Usage:
 *   npx tsx server/scripts/test-luca-chat-canonical-save.ts
 *   npx tsx server/scripts/test-luca-chat-canonical-save.ts --self-check
 *   npx tsx server/scripts/test-luca-chat-canonical-save.ts --sandbox-self-check
 */

import http from 'http';
import { randomUUID } from 'crypto';
import { assertCanonicalSaveIsolation } from './luca-chat-canonical-isolation';
import { runCanonicalSaveSandbox } from './luca-chat-canonical-sandbox';
import { sql } from 'drizzle-orm';
import { holdUnlessDisposableTarget } from './lib/launch-hold';

let getMonitoringDb: typeof import('../db').getMonitoringDb;

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT       = process.env.CANONICAL_SAVE_SERVER_PORT ?? '';
const HOST       = '127.0.0.1';
let AUTH_HEADERS: Record<string, string> = {};
const SELF_CHECK = process.argv.includes('--self-check');

// ─── Colour helpers ──────────────────────────────────────────────────────────
const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const B = (s: string) => `\x1b[34m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;

// ─── Assertion state ─────────────────────────────────────────────────────────
let _failed = false;

function assert(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(G(`  ✓ ${label}`));
  } else {
    console.error(R(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`));
    _failed = true;
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
const PORT_NUM           = parseInt(PORT, 10);
const REQUEST_TIMEOUT_MS = 30_000;

function httpGet(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      hostname: HOST, port: PORT_NUM, path, method: 'GET',
      timeout: REQUEST_TIMEOUT_MS,
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode ?? 0, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('request timed out')); });
    req.end();
  });
}

function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts: http.RequestOptions = {
      hostname: HOST, port: PORT_NUM, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...AUTH_HEADERS,
      },
      timeout: REQUEST_TIMEOUT_MS,
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode ?? 0, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('request timed out')); });
    req.write(payload);
    req.end();
  });
}

/** Poll GET /api/health until the server responds 200 or timeout elapses. */
async function waitForServer(maxMs = 15_000, intervalMs = 250): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await httpGet('/api/health');
      if (r.status === 200) {
        if (r.body?.canonicalSaveRunId !== process.env.CANONICAL_SAVE_RUN_ID) {
          throw new Error('REFUSING TO RUN: canonical-save server is not owned by this invocation');
        }
        return true;
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('REFUSING TO RUN:')) throw error;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ─── Embedding helpers ────────────────────────────────────────────────────────

/** Per-arm counts from memory_embeddings for a given conversation_memories id. */
interface EmbeddingArmCounts {
  conversationMemory: number;  // memory_type='conversation_memory', memory_id=memId
  conversationSummary: number; // memory_type='conversation_summary', memory_id=memId
  conversationChunk: number;   // memory_type='conversation_chunk', memory_id LIKE memId:chunk:%
  total: number;
}

async function fetchEmbeddingArmCounts(
  db: ReturnType<typeof getMonitoringDb>,
  memId: string,
): Promise<EmbeddingArmCounts> {
  const rows = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE memory_type = 'conversation_memory'  AND memory_id = ${memId}) AS mem_cnt,
      COUNT(*) FILTER (WHERE memory_type = 'conversation_summary' AND memory_id = ${memId}) AS sum_cnt,
      COUNT(*) FILTER (WHERE memory_type = 'conversation_chunk'   AND memory_id LIKE ${memId + ':chunk:%'}) AS chunk_cnt,
      COUNT(*) AS total_cnt
    FROM memory_embeddings
    WHERE memory_id = ${memId}
       OR memory_id LIKE ${memId + ':chunk:%'}
  `);
  const row = (rows as any).rows?.[0] ?? (Array.isArray(rows) ? rows[0] : null) ?? {};
  return {
    conversationMemory:  Number(row.mem_cnt   ?? 0),
    conversationSummary: Number(row.sum_cnt   ?? 0),
    conversationChunk:   Number(row.chunk_cnt ?? 0),
    total:               Number(row.total_cnt ?? 0),
  };
}

/**
 * Poll until arm counts are stable (same non-zero total for stableRoundsNeeded
 * consecutive checks) so every arm has finished writing before we assert or clean up.
 */
async function pollForEmbeddingStable(
  db: ReturnType<typeof getMonitoringDb>,
  memId: string,
  maxMs = 30_000,
  intervalMs = 2_000,
  stableRoundsNeeded = 2,
): Promise<EmbeddingArmCounts> {
  const deadline = Date.now() + maxMs;
  let lastTotal = -1;
  let stableRounds = 0;
  while (Date.now() < deadline) {
    const counts = await fetchEmbeddingArmCounts(db, memId);
    if (counts.total > 0 && counts.total === lastTotal) {
      stableRounds++;
      if (stableRounds >= stableRoundsNeeded) {
        console.log(`  embedding counts stable (total=${counts.total}) for ${stableRounds} consecutive polls`);
        console.log(`    conversation_memory: ${counts.conversationMemory}`);
        console.log(`    conversation_summary: ${counts.conversationSummary}`);
        console.log(`    conversation_chunk: ${counts.conversationChunk}`);
        return counts;
      }
    } else {
      lastTotal = counts.total;
      stableRounds = 0;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return fetchEmbeddingArmCounts(db, memId);
}

// ─── Core assertion helpers ───────────────────────────────────────────────────

function assertResponseShape(resp: { status: number; body: any }): void {
  assert(
    'POST /api/admin/luca/chat returns 200',
    resp.status === 200,
    `status ${resp.status}, body: ${JSON.stringify(resp.body).slice(0, 200)}`,
  );
  assert(
    'Response has reply string',
    typeof resp.body?.reply === 'string' && resp.body.reply.trim().length > 0,
    `reply: ${JSON.stringify(resp.body?.reply)}`,
  );
  assert(
    'Response has savedAt timestamp',
    typeof resp.body?.savedAt === 'string' && resp.body.savedAt.length > 0,
    `savedAt: ${JSON.stringify(resp.body?.savedAt)}`,
  );
  assert(
    'Response has canonical memory ID',
    typeof resp.body?.memId === 'string' && resp.body.memId.length > 0,
    `memId: ${JSON.stringify(resp.body?.memId)}`,
  );
  assert(
    'Response has noteIds (davidNoteId + lucaNoteId)',
    typeof resp.body?.noteIds?.davidNoteId === 'string' &&
    typeof resp.body?.noteIds?.lucaNoteId  === 'string',
    `noteIds: ${JSON.stringify(resp.body?.noteIds)}`,
  );
}

function assertMemoryRow(
  row: { id: string; tags: string[] | null; content: string } | null,
  sentinel: string,
): void {
  assert(
    'conversation_memories row created',
    row !== null,
    `no row found containing sentinel "${sentinel}"`,
  );
  if (!row) return;
  assert(
    "Row has tag 'david-luca-chat'",
    Array.isArray(row.tags) && row.tags.includes('david-luca-chat'),
    `tags: ${JSON.stringify(row.tags)}`,
  );
  assert(
    "Content starts with 'David:'",
    row.content.startsWith('David:'),
    `content prefix: "${row.content.slice(0, 40)}"`,
  );
  assert(
    "Content contains 'Luca:' reply line",
    row.content.includes('\n\nLuca:'),
    `content snippet: "${row.content.slice(0, 120)}"`,
  );
}

/**
 * Assert all three re-embed arms are present.
 * The reembedConversationMemory job writes:
 *   - conversation_memory  (parent full-text arm)
 *   - conversation_summary (summary arm, when summary is set)
 *   - conversation_chunk   (≥1 chunk arm for chunked content)
 */
function assertEmbeddingArms(counts: EmbeddingArmCounts, memId: string): void {
  assert(
    'memory_embeddings: conversation_memory arm written',
    counts.conversationMemory >= 1,
    `0 conversation_memory rows found for id ${memId}`,
  );
  assert(
    'memory_embeddings: conversation_summary arm written',
    counts.conversationSummary >= 1,
    `0 conversation_summary rows found for id ${memId}`,
  );
  assert(
    'memory_embeddings: ≥1 conversation_chunk arm written',
    counts.conversationChunk >= 1,
    `0 conversation_chunk rows found for id ${memId}:chunk:*`,
  );
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

/**
 * Delete exactly the artifacts this run created using the IDs the route
 * returned.  No time-window queries; no patterns that could affect live data.
 * Throws on failure so contamination fails CI visibly.
 */
async function cleanup(
  db: ReturnType<typeof getMonitoringDb>,
  memId: string | null,
  davidNoteId: string | null,
  lucaNoteId: string | null,
): Promise<void> {
  console.log(Y('\nCleanup: removing CI test artifacts by exact ID...'));

  // 1. Delete parent + chunk embeddings before the memory row (no FK cascade).
  if (memId) {
    await db.execute(sql`
      DELETE FROM memory_embeddings
      WHERE memory_id = ${memId}
         OR memory_id LIKE ${memId + ':chunk:%'}
    `);
    console.log(Y(`  deleted memory_embeddings (parent + chunks) for ${memId}`));
  }

  // 2. Delete the conversation_memories row by exact ID.
  if (memId) {
    await db.execute(sql`DELETE FROM conversation_memories WHERE id = ${memId}`);
    console.log(Y(`  deleted conversation_memories row ${memId}`));
  }

  // 3. Delete the two agent_notes rows by the exact IDs the route returned.
  for (const id of [davidNoteId, lucaNoteId].filter(Boolean) as string[]) {
    await db.execute(sql`DELETE FROM agent_notes WHERE id = ${id}`);
  }
  console.log(Y(`  deleted agent_notes IDs: ${[davidNoteId, lucaNoteId].filter(Boolean).join(', ')}`));
}

// ─── Self-check mode ──────────────────────────────────────────────────────────

async function runSelfCheck(): Promise<void> {
  console.log(B('\n[self-check] Verifying assertions fail on a missing/broken save...\n'));
  let selfCheckCaughtAll = true;

  const tests: Array<{ label: string; fn: () => void }> = [
    {
      label: 'Sub-test A: broken HTTP response (status 500, no reply)',
      fn: () => assertResponseShape({ status: 500, body: { error: 'Something went wrong' } }),
    },
    {
      label: 'Sub-test B: missing noteIds in response',
      fn: () => assertResponseShape({ status: 200, body: { reply: 'hi', savedAt: 'x', memId: 'fake-memory' } }),
    },
    {
      label: 'Sub-test C: missing conversation_memories row (null)',
      fn: () => assertMemoryRow(null, 'CI-sentinel-TEST'),
    },
    {
      label: "Sub-test D: row with wrong tag (empty array)",
      fn: () => assertMemoryRow(
        { id: 'fake-id', tags: [], content: 'David: hello\n\nLuca: hi' },
        'CI-sentinel-TEST',
      ),
    },
    {
      label: "Sub-test E: content missing Luca reply line",
      fn: () => assertMemoryRow(
        { id: 'fake-id', tags: ['david-luca-chat'], content: 'David: hello only' },
        'CI-sentinel-TEST',
      ),
    },
    {
      label: 'Sub-test F: missing conversation_memory arm',
      fn: () => assertEmbeddingArms(
        { conversationMemory: 0, conversationSummary: 1, conversationChunk: 1, total: 2 },
        'fake-id',
      ),
    },
    {
      label: 'Sub-test G: missing conversation_summary arm',
      fn: () => assertEmbeddingArms(
        { conversationMemory: 1, conversationSummary: 0, conversationChunk: 1, total: 2 },
        'fake-id',
      ),
    },
    {
      label: 'Sub-test H: missing conversation_chunk arm',
      fn: () => assertEmbeddingArms(
        { conversationMemory: 1, conversationSummary: 1, conversationChunk: 0, total: 2 },
        'fake-id',
      ),
    },
    {
      label: 'Sub-test I: missing canonical memory ID only',
      fn: () => assertResponseShape({
        status: 200,
        body: { reply: 'hi', savedAt: 'x', noteIds: { davidNoteId: 'fake-david', lucaNoteId: 'fake-luca' } },
      }),
    },
  ];

  for (const { label, fn } of tests) {
    console.log(Y(`\n  ${label}`));
    _failed = false;
    fn();
    if (!_failed) {
      console.error(R(`  [self-check] ✗ assertion passed on broken payload — guard is missing`));
      selfCheckCaughtAll = false;
    } else {
      console.log(G(`  [self-check] ✓ assertion correctly failed on broken payload`));
    }
  }

  console.log('');
  if (selfCheckCaughtAll) {
    console.log(G('[self-check] PASS — all assertion guards are load-bearing\n'));
    process.exit(0);
  } else {
    console.error(R('[self-check] FAIL — one or more guards did not catch the broken payload\n'));
    process.exit(1);
  }
}

// ─── Main test ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (SELF_CHECK) { await runSelfCheck(); return; }

  if (!Object.keys(AUTH_HEADERS).length) {
    console.error(R('FATAL: COORDINATION_LUCA_REPLIT_TOKEN not set — cannot authenticate'));
    process.exit(1);
  }

  console.log(B('\n── Luca Chat Canonical Save CI ──────────────────────────────\n'));

  // ── 0. Wait for server ────────────────────────────────────────────────────
  console.log('Step 0: Verifying the invocation-owned fixture server...');
  if (!await waitForServer()) {
    console.error(R('FATAL: owned fixture server did not become ready'));
    process.exit(1);
  }
  console.log('  Server is ready.\n');

  const sentinel    = `CI-save-${randomUUID()}`;
  const db          = getMonitoringDb();
  let memId: string | null        = null;
  let davidNoteId: string | null  = null;
  let lucaNoteId: string | null   = null;

  try {
    // ── 1. POST the test message ────────────────────────────────────────────
    const testMessage = `[${sentinel}] Automated CI check — please reply with one sentence.`;
    console.log(`Step 1: POST test message...`);
    console.log(`  sentinel: ${sentinel}`);

    const resp = await post('/api/admin/luca/chat', { message: testMessage });
    assertResponseShape(resp);

    // Capture exact IDs returned by the route — no time-window queries needed.
    // memId is returned by the route so cleanup is deterministic even if the
    // DB assertion in Step 2 fails (e.g. malformed content or tag mismatch).
    memId       = resp.body?.memId ?? null;
    davidNoteId = resp.body?.noteIds?.davidNoteId ?? null;
    lucaNoteId  = resp.body?.noteIds?.lucaNoteId  ?? null;
    console.log(`  reply: "${(resp.body?.reply ?? '').slice(0, 100)}"`);
    console.log(`  memId:       ${memId}`);
    console.log(`  davidNoteId: ${davidNoteId}`);
    console.log(`  lucaNoteId:  ${lucaNoteId}`);
    if (process.env.CANONICAL_SAVE_INJECT_FAILURE === 'after-post') {
      throw new Error('CANONICAL_SAVE_EXPECTED_DRIVER_FAILURE');
    }
    const noteRows = await db.execute(sql`
      SELECT id, from_agent, to_agent, body FROM agent_notes
      WHERE id IN (${davidNoteId}, ${lucaNoteId})
    `);
    const notes = ((noteRows as any).rows ?? noteRows) as any[];
    assert('Both exact chat-history rows persisted',
      notes.length === 2 &&
      notes.some(n => n.id === davidNoteId && n.from_agent === 'david' && n.to_agent === 'luca' && n.body === testMessage) &&
      notes.some(n => n.id === lucaNoteId && n.from_agent === 'luca' && n.to_agent === 'david' && n.body === resp.body.reply));

    // ── 2. Query conversation_memories (synchronous insert in route) ────────
    console.log('\nStep 2: Querying conversation_memories...');
    const memRows = await db.execute(sql`
      SELECT id, tags, content
      FROM conversation_memories
      WHERE content LIKE ${'%' + sentinel + '%'}
        AND arc_name = 'david-luca-chat'
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const raw = (memRows as any).rows?.[0] ?? (Array.isArray(memRows) ? memRows[0] : null) ?? null;
    // memId from the response body is primary — only fill from DB if the route
    // failed to return it (shouldn't happen but gives a clean fallback).
    if (!memId && raw?.id) memId = raw.id as string;
    assertMemoryRow(
      raw ? { id: raw.id as string, tags: (raw.tags as string[] | null) ?? null, content: raw.content as string } : null,
      sentinel,
    );
    assert('Returned memory ID matches the canonical stored row', typeof memId === 'string' && raw?.id === memId);
    assert('Canonical speaker text preserves both exact turns',
      raw?.content === `David: ${testMessage}\n\nLuca: ${resp.body?.reply}`);
    console.log(`  memory id: ${memId ?? '(not found)'}`);

    // ── 3. Poll embeddings until stable, then assert each arm type ─────────
    if (memId) {
      console.log('\nStep 3: Polling memory_embeddings until stable (max 30 s)...');
      const armCounts = await pollForEmbeddingStable(db, memId, 30_000, 2_000, 2);
      assertEmbeddingArms(armCounts, memId);
      const vectors = await db.execute(sql`
        SELECT embedding, content_hash FROM memory_embeddings
        WHERE memory_id = ${memId} OR memory_id LIKE ${memId + ':chunk:%'}
      `);
      const storedVectors = ((vectors as any).rows ?? vectors) as any[];
      assert('All embedding arms contain actual 768-dimensional vectors and hashes',
        storedVectors.length >= 3 &&
        storedVectors.every(row => Array.isArray(row.embedding) && row.embedding.length === 768 &&
          typeof row.content_hash === 'string' && row.content_hash.length === 64));
    } else {
      assert('memory_embeddings check (skipped — row not found)', false, 'cannot check embeddings without a memory id');
    }

  } finally {
    // Cleanup uses only exact IDs — never touches unrelated live data.
    // Throws on failure so orphaned rows fail CI.
    await cleanup(db, memId, davidNoteId, lucaNoteId);
  }

  console.log('\n── Results ──────────────────────────────────────────────────\n');
  if (_failed) {
    console.error(R('FAIL — one or more assertions failed (see ✗ above)\n'));
    process.exit(1);
  } else {
    console.log(G('PASS — David↔Luca exchange confirmed in conversation_memories + memory_embeddings\n'));
    process.exit(0);
  }
}

async function isolatedMain(): Promise<void> {
  if (SELF_CHECK) {
    await runSelfCheck();
    return;
  }
  if (!process.argv.includes('--isolated-driver')) {
    process.exitCode = await runCanonicalSaveSandbox(process.argv.slice(2));
    return;
  }
  assertCanonicalSaveIsolation();
  if (!/^\d+$/.test(PORT) || PORT_NUM < 1 || PORT_NUM > 65535) {
    throw new Error('REFUSING TO RUN: canonical-save driver requires its invocation-owned server port');
  }
  // Check server identity before loading application database modules.
  if (!await waitForServer()) throw new Error('Owned canonical-save server unavailable');
  ({ getMonitoringDb } = await import('../db'));
  const { getAgentAuthHeaders } = await import('../services/agent-auth');
  AUTH_HEADERS = getAgentAuthHeaders() ?? {};
  await main();
}

// O2/O3 containment: inserts and deletes rows through the live route; held
// unless the target is the verified disposable CI database.
holdUnlessDisposableTarget('luca-chat-canonical-save');

isolatedMain().catch((err) => {
  console.error(R('FATAL:'), err.message ?? err);
  process.exit(1);
});
