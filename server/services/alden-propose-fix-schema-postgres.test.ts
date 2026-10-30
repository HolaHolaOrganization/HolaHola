/**
 * Migration 0074 (gated-fixes design e4f8e988, P1 and P0b) against the CI
 * job's disposable PostgreSQL: build_queue's proposal columns only accept a
 * complete, high-confidence pin, and proposed_code_changes takes the two new
 * statuses plus a link to its stored proposal. Synthetic rows only.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import pg from 'pg';
import { getVerifiedCiDatabaseUrl } from '../ci-database';

let pool: pg.Pool | null = null;
const created: string[] = [];
const changes: string[] = [];
after(async () => {
  if (!pool) return;
  if (changes.length) await pool.query('delete from proposed_code_changes where id = any($1::varchar[])', [changes]);
  if (created.length) await pool.query('delete from build_queue where id = any($1::varchar[])', [created]);
  await pool.end();
});

const SHA = 'a'.repeat(40);
const FILES = JSON.stringify([{ path: 'server/x.ts', beforeSha256: 'b'.repeat(64) }]);

async function insertProposal(columns: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  const all = { id, proposed_by: 'alden', title: `0074 test ${id.slice(0, 8)}`, description: 'synthetic', ...columns };
  const names = Object.keys(all);
  await pool!.query(
    `insert into build_queue (${names.join(', ')}) values (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(all),
  );
  created.push(id);
  return id;
}

async function rejects(columns: Record<string, unknown>, constraint: string): Promise<void> {
  await assert.rejects(insertProposal(columns), (err: any) => err.code === '23514' && err.constraint === constraint, constraint);
}

test('build_queue proposal constraints and the new review statuses', async (context) => {
  const url = getVerifiedCiDatabaseUrl();
  if (!url) {
    context.skip('requires CI=true and matching job-local CI_DATABASE_URL / NEON_SHARED_DATABASE_URL');
    return;
  }
  pool = new pg.Pool({ connectionString: url });

  // Accepted shapes.
  const release = await insertProposal({ confidence: 'high', pin_kind: 'release', pin_commit: SHA, pin_source_digest: 'c'.repeat(64), pin_files: FILES, diff: '--- a\n+++ b\n', notify_state: 'pending' });
  await insertProposal({ confidence: 'high', pin_kind: 'dev-head', pin_commit: SHA, pin_files: FILES, diff: '--- a\n+++ b\n' });
  await insertProposal({ confidence: 'medium' });
  await insertProposal({ confidence: 'low', notify_state: 'failed', notify_error: 'post failed', notify_attempts: 2 });
  await insertProposal({}); // an existing-style proposal with none of the new fields

  // Refused shapes.
  await rejects({ confidence: 'certain' }, 'build_queue_confidence_valid');
  await rejects({ confidence: 'high', pin_kind: 'branch', pin_commit: SHA, pin_files: FILES, diff: 'd' }, 'build_queue_pin_kind_valid');
  await rejects({ confidence: 'high', pin_kind: 'dev-head', pin_files: FILES, diff: 'd' }, 'build_queue_pin_complete');
  await rejects({ confidence: 'high', pin_commit: SHA }, 'build_queue_pin_complete');
  await rejects({ confidence: 'high', pin_kind: 'dev-head', pin_commit: SHA, pin_files: FILES }, 'build_queue_pin_has_diff');
  await rejects({ confidence: 'high', pin_kind: 'dev-head', pin_commit: 'ABC', pin_files: FILES, diff: 'd' }, 'build_queue_pin_commit_sha');
  await rejects({ confidence: 'high', pin_kind: 'release', pin_commit: SHA, pin_files: FILES, diff: 'd' }, 'build_queue_release_pin_digest');
  await rejects({ confidence: 'medium', pin_kind: 'dev-head', pin_commit: SHA, pin_files: FILES, diff: 'd' }, 'build_queue_pin_requires_high');
  await rejects({ notify_state: 'sent' }, 'build_queue_notify_state_valid');

  // proposed_code_changes: both new statuses, and the link to a stored proposal.
  for (const status of ['approved_pending_review', 'review_blocked']) {
    const id = randomUUID();
    await pool.query(
      `insert into proposed_code_changes (id, finding_title, finding_description, finding_severity, file_path, line_start, line_end, before_code, after_code, patch_rationale, status, build_queue_id)
       values ($1, '0074 test', 'synthetic', 'low', 'server/x.ts', 1, 1, 'a', 'b', 'synthetic', $2, $3)`,
      [id, status, status === 'approved_pending_review' ? release : null],
    );
    changes.push(id);
  }
  await assert.rejects(
    pool.query(`update proposed_code_changes set build_queue_id = $1 where id = $2`, [randomUUID(), changes[0]]),
    (err: any) => err.code === '23503',
    'the proposal link is a real foreign key',
  );
});
