import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseShipperArgs, runShipper } from './antigravity-journal-shipper';
import { ShipperStateStore } from './lib/antigravity-journal-shipper';

test('parseShipperArgs parses valid arguments', () => {
  const opts = parseShipperArgs([
    '--transcript',
    'C:/path/to/transcript.jsonl',
    '--conversation-id',
    'conv-1234',
    '--dry-run',
  ]);

  assert.equal(opts.conversationId, 'conv-1234');
  assert.equal(opts.dryRun, true);
  assert.match(opts.transcriptPath, /transcript\.jsonl/);
});

test('parseShipperArgs rejects missing required arguments', () => {
  assert.throws(() => parseShipperArgs(['--transcript', 'foo.jsonl']), /--conversation-id is required/);
  assert.throws(() => parseShipperArgs(['--conversation-id', '1234']), /--transcript is required/);
});

test('parseShipperArgs rejects unknown arguments', () => {
  assert.throws(
    () => parseShipperArgs(['--transcript', 'foo.jsonl', '--conversation-id', '123', '--unknown-flag']),
    /Unknown or invalid argument: --unknown-flag/
  );
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
