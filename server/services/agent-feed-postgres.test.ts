/** Agent awareness feed contracts against the CI job's disposable PostgreSQL (stage F-P1). */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { getVerifiedCiDatabaseUrl } from '../ci-database';

let opened = false;
after(async () => {
  if (opened) {
    const { closeDbConnections } = await import('../db');
    await closeDbConnections();
  }
});

test('feed delivery: enrollment, snapshot visibility, served-only acks, budgets and epochs', async (context) => {
  const url = getVerifiedCiDatabaseUrl();
  if (!url) {
    if (process.env.CI === 'true') throw new Error('CI requires a verified disposable database for feed coverage');
    context.skip('requires CI=true and matching job-local CI_DATABASE_URL / NEON_SHARED_DATABASE_URL');
    return;
  }
  opened = true;
  const pg = (await import('pg')).default;
  const feed = await import('./agent-feed');
  const reader = 'luca-claude-code';
  const writerTag = 'source-replit';
  const admin = new pg.Client({ connectionString: url });
  const other = new pg.Client({ connectionString: url });
  await admin.connect();
  await other.connect();
  try {
    // Disposable database only (verified above): start from a clean feed state for the reader.
    await admin.query(`delete from agent_feed_session_receipts where registration_id in (select id from agent_feed_registrations where actor = $1)`, [reader]);
    await admin.query(`delete from agent_feed_served where registration_id in (select id from agent_feed_registrations where actor = $1)`, [reader]);
    await admin.query(`delete from agent_feed_registrations where actor = $1`, [reader]);
    await admin.query(`delete from agent_feed_actor_receipts where actor = $1`, [reader]);
    await admin.query(`delete from agent_feed_enrollments where actor = $1`, [reader]);

    const insertRow = async (client: InstanceType<typeof pg.Client>, content: string, tag = writerTag) => {
      const id = randomUUID();
      await client.query(
        `insert into conversation_memories (id, title, summary, content, tags) values ($1, 'feed test', 'feed test', $2, $3)`,
        [id, content, ['canonical-conversation', tag]],
      );
      return id;
    };

    const before = await insertRow(admin, 'David [Replit]: an old exchange');
    await assert.rejects(feed.register(reader, 'session-a'), /not enrolled/);

    // Test 23: an uncommitted row during enrollment is pending afterwards; a visible one is not.
    await other.query('begin');
    const concurrent = await insertRow(other, 'David [Replit]: written during enrollment');
    const { baselineCount } = await feed.enroll(reader);
    await other.query('commit');
    assert.ok(baselineCount >= 1);
    await assert.rejects(feed.enroll(reader), /already enrolled/);
    const own = await insertRow(admin, 'Claude Code: my own words', 'source-claude-code');

    const { registrationId: a } = await feed.register(reader, 'session-a');
    let p = await feed.page(reader, a);
    let ids = p.items.map((i) => i.id);
    assert.ok(ids.includes(concurrent), 'a row invisible to enrollment is pending');
    assert.ok(!ids.includes(before), 'a row visible to enrollment is baseline, not pending');
    assert.ok(!ids.includes(own), 'a reader never receives its own rows');

    // Acknowledgment may name only served items.
    await assert.rejects(feed.ackPage(reader, a, p.servedId, [{ itemKind: 'canonical', id: before, sha256: 'a'.repeat(64) }]), /not served/);
    const servedConcurrent = p.items.find((i) => i.id === concurrent)!;
    await feed.ackPage(reader, a, p.servedId, [{ itemKind: 'canonical', id: concurrent, sha256: servedConcurrent.sha256 }]);
    p = await feed.page(reader, a);
    assert.ok(!p.items.some((i) => i.id === concurrent), 'acknowledged rows leave the pending set');

    // Test 13 (commit-order race): a receipt written by a transaction in progress
    // when session B registers must not hide the row from B.
    const raced = await insertRow(admin, 'David [Replit]: raced');
    const racedSha = (await admin.query(`select encode(sha256(convert_to(content, 'UTF8')), 'hex') as sha from conversation_memories where id = $1`, [raced])).rows[0].sha;
    await other.query('begin');
    await other.query(`insert into agent_feed_actor_receipts (actor, row_id, content_sha256, kind, xid) values ($1, $2, $3, 'delivered', pg_current_xact_id()::text)`, [reader, raced, racedSha]);
    const { registrationId: b } = await feed.register(reader, 'session-b');
    await other.query('commit');
    assert.ok((await feed.page(reader, b)).items.some((i) => i.id === raced), 'B still sees the raced row');
    const { registrationId: c } = await feed.register(reader, 'session-c');
    assert.ok(!(await feed.page(reader, c)).items.some((i) => i.id === raced), 'a session registered after the commit does not');

    // Bootstrap once per epoch (test 19), even if its output was lost.
    await feed.bootstrap(reader, c);
    await assert.rejects(feed.bootstrap(reader, c), /already used/);

    // Notices: debited before output, 12 per epoch, failed confirmation still costs (test 18).
    await insertRow(admin, 'David [Replit]: fresh for notices');
    const { registrationId: d } = await feed.register(reader, 'session-d');
    let bytes = 0;
    for (let n = 0; n < 12; n++) {
      const attempt = await feed.noticeAttempt(reader, d);
      assert.ok(attempt.body && Buffer.byteLength(attempt.body, 'utf8') <= 400);
      bytes += Buffer.byteLength(attempt.body!, 'utf8');
    }
    await assert.rejects(feed.noticeAttempt(reader, d), /allowance/);
    assert.ok(bytes <= 12 * 400);
    const receipts = await admin.query(`select count(*)::int as n from agent_feed_session_receipts where registration_id = $1 and receipt_kind = 'notice-seen'`, [d]);
    assert.equal(receipts.rows[0].n, 0, 'attempts never create receipts by themselves');

    // Peek writes nothing: the epoch row version (xmin) and activity time are unchanged.
    const { registrationId: e } = await feed.register(reader, 'session-e');
    const rowVersion = async () => (await admin.query(`select xmin::text as x, last_activity_at from agent_feed_registrations where id = $1`, [e])).rows[0];
    const v0 = await rowVersion();
    const peek1 = await feed.peek(reader, e);
    const peek2 = await feed.peek(reader, e);
    assert.deepEqual(peek1.manifest, peek2.manifest);
    assert.deepEqual(await rowVersion(), v0, 'peek must not write the epoch');
    const attempt = await feed.noticeAttempt(reader, e);
    await feed.noticeSeen(reader, e, attempt.attemptId);
    const peek3 = await feed.peek(reader, e);
    assert.ok(!peek3.manifest.some((m) => peek1.manifest.slice(0, 3).some((x) => x.id === m.id)), 'noticed items are not noticed again');

    // Acceptance case 4: a row whose bytes change after delivery is pending again, flagged changed.
    const { registrationId: g } = await feed.register(reader, 'session-g');
    const edited = await insertRow(admin, 'David [Replit]: before edit');
    let pg1 = await feed.page(reader, g);
    const first = pg1.items.find((i) => i.id === edited)!;
    assert.equal(first.changed, false);
    await feed.ackPage(reader, g, pg1.servedId, [{ itemKind: 'canonical', id: edited, sha256: first.sha256 }]);
    await admin.query(`update conversation_memories set content = 'David [Replit]: after edit' where id = $1`, [edited]);
    pg1 = await feed.page(reader, g);
    const again = pg1.items.find((i) => i.id === edited)!;
    assert.ok(again, 'changed bytes are pending again');
    assert.notEqual(again.sha256, first.sha256);
    assert.equal(again.changed, true);

    // Every source-carrying response stays within 9,000 serialized bytes.
    for (let i = 0; i < 30; i++) await insertRow(admin, `David [Replit]: filler ${i} ${'y'.repeat(400)}`);
    const { registrationId: h } = await feed.register(reader, 'session-h');
    assert.ok(Buffer.byteLength(JSON.stringify(await feed.bootstrap(reader, h)), 'utf8') <= 9000);
    assert.ok(Buffer.byteLength(JSON.stringify(await feed.page(reader, h)), 'utf8') <= 9000);

    // Chunked read (test 17): fetched per chunk, read only on a verified complete version.
    const big = await insertRow(admin, 'x'.repeat(30_000));
    const firstChunk = await feed.rowChunk(reader, e, big, 0);
    assert.equal(firstChunk.chunks, Math.ceil(30_000 / 6_498));
    assert.ok(Buffer.byteLength(JSON.stringify(firstChunk), 'utf8') <= 9000, 'an encoded chunk response stays within the cap');
    assert.equal((await feed.confirmRead(reader, e, big, firstChunk.sha256, 'b'.repeat(64))).read, false);
    assert.equal((await feed.confirmRead(reader, e, big, firstChunk.sha256, firstChunk.sha256)).read, true);

    // Epoch TTL: an epoch idle for 48 hours is closed, and registering again opens a new one.
    await admin.query(`update agent_feed_registrations set last_activity_at = clock_timestamp() - interval '49 hours' where id = $1`, [e]);
    await assert.rejects(feed.page(reader, e), /epoch closed/);
    const { registrationId: e2 } = await feed.register(reader, 'session-e');
    assert.notEqual(e2, e);
  } finally {
    await other.end().catch(() => {});
    await admin.end().catch(() => {});
  }
});
