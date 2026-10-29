import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseShipperArgs, resolveShipperSource, runShipper } from './antigravity-journal-shipper';
import { ShipperStateStore } from './lib/antigravity-journal-shipper';

const requireSqlite = createRequire(import.meta.url);
function createTestSqliteDb(dbPath: string): any {
  const mod = requireSqlite('node:sqlite') as { DatabaseSync: new (path: string) => any };
  return new mod.DatabaseSync(dbPath);
}

function encodeVarint(val: bigint | number): Buffer {
  let v = BigInt(val);
  const bytes: number[] = [];
  const limit = BigInt(0x80);
  const mask = BigInt(0x7f);
  const shift = BigInt(7);
  while (v >= limit) {
    bytes.push(Number((v & mask) | limit));
    v >>= shift;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function encodeVarintField(fieldNumber: number, val: bigint | number): Buffer {
  const tag = encodeVarint((BigInt(fieldNumber) << BigInt(3)) | BigInt(0));
  return Buffer.concat([tag, encodeVarint(val)]);
}

function encodeBytesField(fieldNumber: number, payload: Buffer | string): Buffer {
  const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const tag = encodeVarint((BigInt(fieldNumber) << BigInt(3)) | BigInt(2));
  return Buffer.concat([tag, encodeVarint(buf.length), buf]);
}

function buildStepMetadata(seconds: number, sourceEnum: number): Buffer {
  const ts = Buffer.concat([encodeVarintField(1, seconds), encodeVarintField(2, 0)]);
  return Buffer.concat([encodeBytesField(1, ts), encodeVarintField(3, sourceEnum)]);
}

function buildUserInputPayload(metadata: Buffer, userText: string): Buffer {
  const f19 = encodeBytesField(2, userText);
  return Buffer.concat([
    encodeVarintField(1, 14),
    encodeVarintField(4, 3),
    encodeBytesField(5, metadata),
    encodeBytesField(19, f19),
  ]);
}

function buildPlannerResponsePayload(metadata: Buffer, responseText: string): Buffer {
  const f20 = encodeBytesField(1, responseText);
  return Buffer.concat([
    encodeVarintField(1, 15),
    encodeVarintField(4, 3),
    encodeBytesField(5, metadata),
    encodeBytesField(20, f20),
  ]);
}

test('parseShipperArgs parses valid arguments including --db', () => {
  const opts = parseShipperArgs([
    '--transcript',
    'C:/path/to/transcript.jsonl',
    '--conversation-id',
    'conv-1234',
    '--dry-run',
  ]);

  assert.equal(opts.conversationId, 'conv-1234');
  assert.equal(opts.dryRun, true);
  assert.match(opts.transcriptPath!, /transcript\.jsonl/);

  const dbOpts = parseShipperArgs([
    '--db',
    'C:/path/to/conv-1234.db',
    '--conversation-id',
    'conv-1234',
    '--dry-run',
  ]);
  assert.equal(dbOpts.conversationId, 'conv-1234');
  assert.match(dbOpts.dbPath!, /conv-1234\.db/);
});

test('parseShipperArgs rejects missing required arguments and conversation_summaries.db', () => {
  assert.throws(() => parseShipperArgs(['--transcript', 'foo.jsonl']), /--conversation-id is required/);
  assert.throws(() => parseShipperArgs(['--conversation-id', '1234']), /--transcript or --db is required/);
  assert.throws(
    () => parseShipperArgs(['--db', 'C:/path/conversation_summaries.db', '--conversation-id', '1234']),
    /forbidden_summaries_db/
  );
  assert.throws(
    () => parseShipperArgs(['--transcript', 'C:/path/conversation_summaries.db', '--conversation-id', '1234']),
    /forbidden_summaries_db/
  );
});

test('parseShipperArgs rejects unknown arguments', () => {
  assert.throws(
    () => parseShipperArgs(['--transcript', 'foo.jsonl', '--conversation-id', '123', '--unknown-flag']),
    /Unknown or invalid argument: --unknown-flag/
  );
});

test('resolveShipperSource automatically upgrades transcript.jsonl to sibling transcript_full.jsonl', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shipper-upgrade-full-'));
  try {
    const compactPath = join(dir, 'transcript.jsonl');
    const fullPath = join(dir, 'transcript_full.jsonl');

    await writeFile(compactPath, '{}\n');
    await writeFile(fullPath, '{}\n');

    const resolved = resolveShipperSource({
      transcriptPath: compactPath,
      conversationId: 'conv-full-test',
      stateDir: join(dir, 'state'),
    });

    assert.equal(resolved.mode, 'jsonl');
    assert.equal(resolved.path, fullPath, 'Must automatically prefer sibling transcript_full.jsonl');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runShipper persists source evidence on input-only and ambiguous-only journals (Review Point 1 CLI probe)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shipper-cli-probe-'));
  try {
    const transcriptPath = join(dir, 'transcript.jsonl');
    const stateDir = join(dir, 'state');

    // Probe 1: input-only journal (0 exchanges)
    await writeFile(
      transcriptPath,
      JSON.stringify({
        step_index: 1,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-10-26T18:00:00Z',
        content: '<USER_REQUEST>lone user input</USER_REQUEST>',
      }) + '\n'
    );

    const report1 = await runShipper({
      transcriptPath,
      conversationId: 'probe-conv',
      stateDir,
      dryRun: true,
    });

    assert.equal(report1.shipped, 0);
    assert.equal(report1.pendingUnpaired, 1);
    assert.equal(report1.unresolvedCount, 0);

    const store = new ShipperStateStore(stateDir);
    const pending = await store.listPendingUserInputs();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].userText, 'lone user input');
    assert.equal(pending[0].createdAt, '2026-10-26T18:00:00Z');

    // Probe 2: ambiguous-only journal (0 exchanges)
    await writeFile(
      transcriptPath,
      JSON.stringify({
        step_index: 2,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-10-26T18:05:00Z',
        content: '<USER_REQUEST>tag1</USER_REQUEST><USER_REQUEST>tag2</USER_REQUEST>',
      }) + '\n'
    );

    const report2 = await runShipper({
      transcriptPath,
      conversationId: 'probe-conv',
      stateDir,
      dryRun: true,
    });

    assert.equal(report2.shipped, 0);
    assert.equal(report2.pendingUnpaired, 0);
    assert.equal(report2.unresolvedCount, 1);

    const unresolved = await store.listUnresolvedTurns();
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].reason, 'ambiguous_multiple_request_tags');
    assert.equal(unresolved[0].createdAt, '2026-10-26T18:05:00Z');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runShipper refuses mismatched conversation scope before cursor use or parsing (Review Block A CLI probe)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shipper-scope-probe-'));
  try {
    const transcriptPath = join(dir, 'transcript.jsonl');
    const stateDir = join(dir, 'state');

    // Create state dir with checkpoint for 'foreign-conversation'
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'checkpoint.json'),
      JSON.stringify({
        conversationId: 'foreign-conversation',
        acknowledgedSteps: [10],
        lastContiguousAcknowledgedStepIndex: 10,
        updatedAt: new Date().toISOString(),
      })
    );

    // Write a dummy transcript
    await writeFile(
      transcriptPath,
      JSON.stringify({
        step_index: 10,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        content: '<USER_REQUEST>hello</USER_REQUEST>',
      }) + '\n'
    );

    // Invoking runShipper for 'my-conversation' must immediately throw mismatched_conversation_scope!
    await assert.rejects(
      () =>
        runShipper({
          transcriptPath,
          conversationId: 'my-conversation',
          stateDir,
          dryRun: true,
        }),
      /mismatched_conversation_scope/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runShipper falls back to read-only conversations/<id>.db when brain/<id>/transcript.jsonl is absent and records eviction alarm at >= 1500 steps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shipper-sqlite-fallback-'));
  try {
    const conversationId = 'conv-fallback-uuid';
    const missingTranscriptPath = join(
      dir,
      'brain',
      conversationId,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    );
    const conversationsDir = join(dir, 'conversations');
    await mkdir(conversationsDir, { recursive: true });
    const dbPath = join(conversationsDir, `${conversationId}.db`);
    const stateDir = join(dir, 'state');

    const db = createTestSqliteDb(dbPath);
    db.exec(`
      CREATE TABLE steps (
        idx integer PRIMARY KEY,
        step_type integer,
        status integer,
        has_subtrajectory numeric,
        metadata blob,
        error_details blob,
        permissions blob,
        task_details blob,
        render_info blob,
        step_payload blob,
        step_format integer
      );
    `);

    const insert = db.prepare(
      'INSERT INTO steps (idx, step_type, status, metadata, step_payload, step_format) VALUES (?, ?, ?, ?, ?, ?)'
    );

    const meta0 = buildStepMetadata(1793201000, 4);
    insert.run(0, 14, 3, meta0, buildUserInputPayload(meta0, 'First question from SQLite'), 0);

    const meta1 = buildStepMetadata(1793201005, 2);
    insert.run(1, 15, 3, meta1, buildPlannerResponsePayload(meta1, 'First answer from SQLite'), 0);

    // Seal step 0 at step 1600 (>= 1500 unshipped steps -> triggers eviction-horizon alarm!)
    const meta1600 = buildStepMetadata(1793202000, 4);
    insert.run(1600, 14, 3, meta1600, buildUserInputPayload(meta1600, 'Second question at step 1600'), 0);

    db.close();

    const warningsObserved: any[] = [];
    const report = await runShipper({
      transcriptPath: missingTranscriptPath,
      conversationId,
      stateDir,
      dryRun: true,
      onEvictionWarning: warning => {
        warningsObserved.push(warning);
      },
    });

    assert.equal(report.simulated, 1);
    assert.equal(report.pendingUnpaired, 1);
    assert.equal(report.evictionWarning, true);
    assert.ok(report.sourceDbSha256 && /^[0-9a-f]{64}$/.test(report.sourceDbSha256));
    assert.equal(warningsObserved.length, 1);
    assert.equal(warningsObserved[0].unshippedStepSpan, 1601);

    const store = new ShipperStateStore(stateDir);
    const snapshot = await store.loadSourceSnapshotEvidence();
    assert.ok(snapshot);
    assert.equal(snapshot?.sourceDbSha256, report.sourceDbSha256);

    const evictionWarning = await store.loadEvictionWarning();
    assert.ok(evictionWarning);
    assert.equal(evictionWarning?.unshippedStepSpan, 1601);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
