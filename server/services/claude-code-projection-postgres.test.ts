/** Shadow projection against the CI job's disposable PostgreSQL (stage R-P2). Publishes nothing. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { filterEntry } from '@shared/claude-code-mirror-core.mjs';
import { getVerifiedCiDatabaseUrl } from '../ci-database';

let opened = false;
after(async () => {
  if (opened) {
    const { closeDbConnections } = await import('../db');
    await closeDbConnections();
  }
});

test('shadow projection compares with existing rows and never writes canonical records', async (context) => {
  const url = getVerifiedCiDatabaseUrl();
  if (!url) {
    if (process.env.CI === 'true') throw new Error('CI requires a verified disposable database for shadow coverage');
    context.skip('requires CI=true and matching job-local CI_DATABASE_URL / NEON_SHARED_DATABASE_URL');
    return;
  }
  opened = true;
  const pg = (await import('pg')).default;
  const mirror = await import('./claude-code-mirror');
  const session = `shadow-${randomUUID()}`;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const human = (t: string) => filterEntry({ type: 'user', origin: { kind: 'human' }, message: { content: t } });
    const reply = (t: string) => filterEntry({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
    await mirror.ingestEntries('luca-claude-code', session, [
      { position: 0, uuid: 'a', entry: human('first question') }, { position: 1, uuid: 'b', entry: reply('first answer') },
      { position: 2, uuid: 'c', entry: human('second question') }, { position: 3, uuid: 'd', entry: reply('second answer') },
      { position: 4, uuid: 'e', entry: human('third question') }, { position: 5, uuid: 'f', entry: reply('third answer') },
      { position: 6, uuid: 'g', entry: human('last question') }, { position: 7, uuid: 'h', entry: reply('last answer') },
    ]);
    // Existing canonical rows: one matching, one with different words; none for position 4.
    const row = async (pos: number, content: string) => client.query(
      `insert into conversation_memories (id, title, summary, content, tags) values ($1, 't', 's', $2, $3)`,
      [randomUUID(), content, ['canonical-conversation', 'source-claude-code', `capture-id:cc-${session}-${pos}`]],
    );
    await row(0, 'David [Claude Code]: first question\n\nClaude Code: first answer');
    await row(2, 'David [Claude Code]: a notice, not the question\n\nClaude Code: second answer');
    const before = (await client.query(`select count(*)::int as n from conversation_memories`)).rows[0].n;

    const result = await mirror.runShadowProjection(session);
    assert.equal(result.exchanges, 4);
    assert.deepEqual(result.byState, { certified: 3, 'provisional-candidate': 1 });
    assert.deepEqual(result.byComparison, { match: 1, mismatch: 1, missing: 1, 'not-applicable': 1 });

    const shadow = await client.query(`select opening_position, state, comparison from claude_code_projection_shadow where run_id = $1 order by opening_position`, [result.runId]);
    assert.deepEqual(shadow.rows.map((r) => [r.opening_position, r.state, r.comparison]), [
      [0, 'certified', 'match'], [2, 'certified', 'mismatch'], [4, 'certified', 'missing'], [6, 'provisional-candidate', 'not-applicable'],
    ]);
    const after = (await client.query(`select count(*)::int as n from conversation_memories`)).rows[0].n;
    assert.equal(after, before, 'the shadow run writes nothing to conversation_memories');
  } finally {
    await client.end().catch(() => {});
  }
});
