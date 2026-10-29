import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertNodeSqliteRuntime,
  assertNotSummariesDb,
  decodeProtobufFields,
  extractAntigravityUserRequest,
  extractAntigravityAssistantText,
  parseAntigravityJournal,
  parseAntigravitySqliteSteps,
  snapshotAndParseAntigravitySqliteDb,
  ShipperStateStore,
  shipAntigravityExchanges,
  persistJournalEvidence,
  calculateContiguousAcknowledgedStep,
  type ParseResult,
} from './antigravity-journal-shipper';

const requireSqlite = createRequire(import.meta.url);
function createTestSqliteDb(dbPath: string): any {
  const mod = requireSqlite('node:sqlite') as { DatabaseSync: new (path: string) => any };
  return new mod.DatabaseSync(dbPath);
}

test('extractAntigravityUserRequest extracts user request byte-exact without stripping internal indentation', () => {
  const raw = `<USER_REQUEST>
  indented line 1
    indented line 2
</USER_REQUEST>
<ADDITIONAL_METADATA>
The current local time is: 2026-10-26T16:00:00Z.
</ADDITIONAL_METADATA>`;

  const result = extractAntigravityUserRequest(raw);
  assert.equal(result.userText, '  indented line 1\n    indented line 2');
  assert.equal(result.error, undefined);
});

test('extractAntigravityUserRequest rejects multiple opening tags (ambiguity guard)', () => {
  const raw = `<USER_REQUEST>
Initial prompt
<USER_REQUEST>
Nested prompt
</USER_REQUEST>`;

  const result = extractAntigravityUserRequest(raw);
  assert.equal(result.userText, undefined);
  assert.equal(result.error, 'ambiguous_multiple_request_tags');
});

test('extractAntigravityUserRequest rejects multiple closing tags (LR synthetic attack)', () => {
  const raw = `<USER_REQUEST>
alpha </USER_REQUEST> injected metadata </USER_REQUEST>`;

  const result = extractAntigravityUserRequest(raw);
  assert.equal(result.userText, undefined);
  assert.equal(result.error, 'ambiguous_multiple_request_tags');
});

test('extractAntigravityUserRequest rejects missing tags', () => {
  const raw = `Just plain text without tags`;
  const result = extractAntigravityUserRequest(raw);
  assert.equal(result.userText, undefined);
  assert.equal(result.error, 'missing_request_tags');
});

test('extractAntigravityUserRequest rejects empty request', () => {
  const raw = `<USER_REQUEST>\n\n</USER_REQUEST>`;
  const result = extractAntigravityUserRequest(raw);
  assert.equal(result.userText, undefined);
  assert.equal(result.error, 'empty_user_request');
});

test('extractAntigravityAssistantText preserves raw content byte-exact without regex alteration', () => {
  const raw = `Here is the response including a literal <thought> mention:\n- Item 1\n- Item 2`;
  const cleaned = extractAntigravityAssistantText(raw);
  assert.equal(cleaned, raw);
});

test('parseAntigravityJournal preserves original native created_at timestamps', () => {
  const conversationId = 'conv-test-time';
  const timestamp = '2026-10-26T15:42:00.123Z';
  const lines = [
    JSON.stringify({
      step_index: 10,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: timestamp,
      content: '<USER_REQUEST>\nWhat time is it?\n</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 11,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'It is time.',
    }),
    JSON.stringify({
      step_index: 12,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-10-26T15:43:00.000Z',
      content: '<USER_REQUEST>\nSecond prompt\n</USER_REQUEST>',
    }),
  ];

  const parsed = parseAntigravityJournal(lines, conversationId);
  assert.equal(parsed.exchanges[0].createdAt, timestamp);
  assert.equal(parsed.unpairedUserInputs[0].createdAt, '2026-10-26T15:43:00.000Z');
});

test('parseAntigravityJournal treats trailing turn without subsequent USER_INPUT as OPEN (Review Block B)', () => {
  const conversationId = 'conv-test-open';
  const lines = [
    JSON.stringify({
      step_index: 20,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-10-26T18:00:00Z',
      content: '<USER_REQUEST>\nTell me a long story...\n</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 21,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'Chapter 1: The Beginning.',
    }),
  ];

  const parsed = parseAntigravityJournal(lines, conversationId);
  assert.equal(parsed.exchanges.length, 0, 'Must NOT finalize trailing turn without subsequent USER_INPUT');
  assert.ok(parsed.openTrailingTurn, 'Must report openTrailingTurn');
  assert.equal(parsed.openTrailingTurn?.stepIndex, 20);
  assert.equal(parsed.openTrailingTurn?.assistantTextSoFar, 'Chapter 1: The Beginning.');

  // CHECKPOINT does NOT prematurely close the turn!
  lines.push(JSON.stringify({ step_index: 22, type: 'CHECKPOINT' }));
  const parsedStillOpen = parseAntigravityJournal(lines, conversationId);
  assert.equal(parsedStillOpen.exchanges.length, 0, 'CHECKPOINT alone must not close exchange');
  assert.ok(parsedStillOpen.openTrailingTurn);

  // Subsequent PLANNER_RESPONSE parts accumulate in openTrailingTurn
  lines.push(
    JSON.stringify({
      step_index: 23,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'Chapter 2: The Journey.',
    })
  );
  const parsedMultiPart = parseAntigravityJournal(lines, conversationId);
  assert.equal(parsedMultiPart.exchanges.length, 0);
  assert.equal(
    parsedMultiPart.openTrailingTurn?.assistantTextSoFar,
    'Chapter 1: The Beginning.\n\nChapter 2: The Journey.'
  );

  // When a subsequent USER_INPUT arrives, it provides definitive completion evidence for step 20!
  lines.push(
    JSON.stringify({
      step_index: 30,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-10-26T18:05:00Z',
      content: '<USER_REQUEST>\nNext question\n</USER_REQUEST>',
    })
  );
  const parsedClosed = parseAntigravityJournal(lines, conversationId);
  assert.equal(parsedClosed.exchanges.length, 1);
  assert.equal(parsedClosed.exchanges[0].stepIndex, 20);
  assert.equal(
    parsedClosed.exchanges[0].assistantText,
    'Chapter 1: The Beginning.\n\nChapter 2: The Journey.'
  );
});

test('CHECKPOINT before response or between response parts does NOT close exchange (Review Block B probe)', () => {
  const conversationId = 'conv-test-checkpoint-probe';
  // LR synthetic probe: USER_INPUT 20, CHECKPOINT 21, PLANNER_RESPONSE 22
  const lines = [
    JSON.stringify({
      step_index: 20,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-10-26T18:00:00Z',
      content: '<USER_REQUEST>\nProbe\n</USER_REQUEST>',
    }),
    JSON.stringify({ step_index: 21, type: 'CHECKPOINT' }),
    JSON.stringify({
      step_index: 22,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'Response after checkpoint',
    }),
  ];

  // At EOF, step 20 remains open, NOT closed
  const atEof = parseAntigravityJournal(lines, conversationId);
  assert.equal(atEof.exchanges.length, 0);
  assert.equal(atEof.openTrailingTurn?.assistantTextSoFar, 'Response after checkpoint');

  // Appending response 23 survives without splitting
  lines.push(
    JSON.stringify({
      step_index: 23,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'Additional part',
    })
  );
  const appended = parseAntigravityJournal(lines, conversationId);
  assert.equal(appended.exchanges.length, 0);
  assert.equal(
    appended.openTrailingTurn?.assistantTextSoFar,
    'Response after checkpoint\n\nAdditional part'
  );
});

test('parseAntigravityJournal joins multiple communicative PLANNER_RESPONSE parts with double newline', () => {
  const conversationId = 'conv-test-multi';
  const lines = [
    JSON.stringify({
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\nExplain the two parts.\n</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'Part 1: The foundation.',
    }),
    JSON.stringify({
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'Part 2: The architecture.',
    }),
    JSON.stringify({
      step_index: 4,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\nFollow up question.\n</USER_REQUEST>',
    }),
  ];

  const parsed = parseAntigravityJournal(lines, conversationId);
  assert.equal(parsed.exchanges.length, 1);
  assert.equal(
    parsed.exchanges[0].assistantText,
    'Part 1: The foundation.\n\nPart 2: The architecture.'
  );
});

test('parseAntigravityJournal fails closed on mid-file corrupt JSON line', () => {
  const conversationId = 'conv-test-corrupt';
  const lines = [
    JSON.stringify({
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\nTurn 1\n</USER_REQUEST>',
    }),
    '{ corrupt json line mid file',
    JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'Response 1',
    }),
  ];

  assert.throws(
    () => parseAntigravityJournal(lines, conversationId),
    /corrupt_journal_line at line 2/
  );
});

test('persistJournalEvidence persists source evidence even on input-only or ambiguous-only journal (Review Point 1)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shipper-evidence-test-'));
  try {
    const store = new ShipperStateStore(dir);
    const conversationId = 'conv-input-only';

    const parseResult: ParseResult = {
      exchanges: [], // Zero completed exchanges!
      unpairedUserInputs: [
        {
          conversationId,
          stepIndex: 1,
          turnId: 'ag-conv-input-only-1',
          userText: 'Solo user prompt',
          createdAt: '2026-10-26T18:00:00Z',
        },
      ],
      unresolvedTurns: [
        {
          conversationId,
          stepIndex: 2,
          turnId: 'ag-conv-input-only-2',
          rawContent: '<USER_REQUEST>tag1</USER_REQUEST><USER_REQUEST>tag2</USER_REQUEST>',
          reason: 'ambiguous_multiple_request_tags',
          createdAt: '2026-10-26T18:01:00Z',
        },
      ],
      lastProcessedStepIndex: 2,
    };

    await persistJournalEvidence(parseResult, store);

    const pending = await store.listPendingUserInputs();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].turnId, 'ag-conv-input-only-1');

    const unresolved = await store.listUnresolvedTurns();
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].turnId, 'ag-conv-input-only-2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('calculateContiguousAcknowledgedStep does not leap past unacknowledged earlier steps (Review Point 2)', () => {
  const exchanges = [
    {
      conversationId: 'c1',
      stepIndex: 10,
      turnId: 'ag-c1-10',
      userText: 'Turn 10',
      assistantText: 'Reply 10',
      createdAt: '2026-10-26T18:00:00Z',
    },
  ];

  const unpaired = [
    {
      conversationId: 'c1',
      stepIndex: 1, // Step 1 is unpaired / unacknowledged!
      turnId: 'ag-c1-1',
      userText: 'Turn 1',
      createdAt: '2026-10-26T17:59:00Z',
    },
  ];

  const acknowledgedSet = new Set<number>([10]); // Step 10 is acknowledged, but step 1 is not!

  const contiguous = calculateContiguousAcknowledgedStep(exchanges, unpaired, [], acknowledgedSet);
  assert.equal(contiguous, -1, 'Contiguous cursor must NOT jump past unacknowledged step 1!');

  // Now when step 1 is also acknowledged:
  acknowledgedSet.add(1);
  const contiguousAfter1 = calculateContiguousAcknowledgedStep(exchanges, unpaired, [], acknowledgedSet);
  assert.equal(contiguousAfter1, 10, 'Contiguous cursor advances to 10 once step 1 is accounted for');
});

test('ShipperStateStore fails closed on corrupted checkpoint, scope mismatch, or invalid values (Review Block A & 4)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shipper-fail-closed-test-'));
  try {
    const store = new ShipperStateStore(dir);

    // ENOENT returns null cleanly
    assert.equal(await store.loadCheckpoint('c1'), null);

    // Malformed JSON checkpoint throws corrupt_checkpoint_json
    await writeFile(join(dir, 'checkpoint.json'), '{ not valid json');
    await assert.rejects(() => store.loadCheckpoint('c1'), /corrupt_checkpoint_json/);

    // Invalid schema checkpoint throws corrupt_checkpoint_schema
    await writeFile(join(dir, 'checkpoint.json'), JSON.stringify({ conversationId: 'c1' }));
    await assert.rejects(() => store.loadCheckpoint('c1'), /corrupt_checkpoint_schema/);

    // Non-integer in acknowledgedSteps throws corrupt_checkpoint_schema
    await writeFile(
      join(dir, 'checkpoint.json'),
      JSON.stringify({
        conversationId: 'c1',
        acknowledgedSteps: [10, 'not-a-number'],
        lastContiguousAcknowledgedStepIndex: 10,
        updatedAt: new Date().toISOString(),
      })
    );
    await assert.rejects(() => store.loadCheckpoint('c1'), /corrupt_checkpoint_schema/);

    // Invalid negative cursor (< -1) throws corrupt_checkpoint_schema
    await writeFile(
      join(dir, 'checkpoint.json'),
      JSON.stringify({
        conversationId: 'c1',
        acknowledgedSteps: [10],
        lastContiguousAcknowledgedStepIndex: -5,
        updatedAt: new Date().toISOString(),
      })
    );
    await assert.rejects(() => store.loadCheckpoint('c1'), /corrupt_checkpoint_schema/);

    // Valid checkpoint for c1
    await writeFile(
      join(dir, 'checkpoint.json'),
      JSON.stringify({
        conversationId: 'c1',
        acknowledgedSteps: [10],
        lastContiguousAcknowledgedStepIndex: 10,
        updatedAt: new Date().toISOString(),
      })
    );
    // Scope mismatch: asking for other-conversation throws mismatched_conversation_scope!
    await assert.rejects(
      () => store.loadCheckpoint('other-conversation'),
      /mismatched_conversation_scope/
    );

    // Matching scope succeeds
    const loaded = await store.loadCheckpoint('c1');
    assert.equal(loaded?.conversationId, 'c1');

    // Malformed pending file throws corrupt_pending_file
    await store.persistPendingUserInput({
      conversationId: 'c1',
      stepIndex: 5,
      turnId: 'ag-c1-5',
      userText: 'Hello',
      createdAt: '2026-10-26T18:00:00Z',
    });
    // Corrupt the pending file
    await writeFile(join(dir, 'pending', 'ag-c1-5.json'), '{ broken');
    await assert.rejects(() => store.listPendingUserInputs(), /corrupt_pending_file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('shipAntigravityExchanges posts turns, updates checkpoint on 202, archives accepted ledger, and preserves pending inputs (Review Block C)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shipper-ship-test-'));
  try {
    const store = new ShipperStateStore(dir);
    const postedPayloads: any[] = [];
    const postedHeaders: any[] = [];

    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      postedPayloads.push(body);
      postedHeaders.push(init?.headers);

      if (body.turnId === 'ag-conv-test-20') {
        return new Response(JSON.stringify({ error: 'conflict' }), { status: 409 });
      }

      return new Response(
        JSON.stringify({
          ok: true,
          acknowledgement: 'pending',
          receipt: { turnId: body.turnId, status: 'pending' },
        }),
        { status: 202 }
      );
    };

    const parseResult: ParseResult = {
      exchanges: [
        {
          conversationId: 'conv-test',
          stepIndex: 10,
          turnId: 'ag-conv-test-10',
          userText: 'Turn 1',
          assistantText: 'Reply 1',
          createdAt: '2026-10-26T18:00:00Z',
        },
        {
          conversationId: 'conv-test',
          stepIndex: 20,
          turnId: 'ag-conv-test-20',
          userText: 'Turn 2',
          assistantText: 'Reply 2',
          createdAt: '2026-10-26T18:01:00Z',
        },
      ],
      unpairedUserInputs: [
        {
          conversationId: 'conv-test',
          stepIndex: 1, // Step 1 is unpaired!
          turnId: 'ag-conv-test-1',
          userText: 'Unpaired Turn 1',
          createdAt: '2026-10-26T17:59:00Z',
        },
      ],
      unresolvedTurns: [],
      lastProcessedStepIndex: 20,
    };

    const report = await shipAntigravityExchanges(parseResult, {
      apiUrl: 'https://example.com',
      authToken: 'test-broker-token',
      stateStore: store,
      fetchImpl: mockFetch as any,
    });

    assert.equal(report.attempted, 2);
    assert.equal(report.shipped, 1);
    assert.equal(report.failed, 1);
    assert.equal(report.pendingUnpaired, 1);

    // Outbound wire body strictly conforms to PR #116 (source, turnId, userText, assistantText)
    assert.deepEqual(postedPayloads[0], {
      source: 'antigravity',
      turnId: 'ag-conv-test-10',
      userText: 'Turn 1',
      assistantText: 'Reply 1',
    });

    // Contiguous cursor remains -1 because step 1 was unpaired and unacknowledged!
    assert.equal(report.lastAcknowledgedStepIndex, -1);

    // Checkpoint saved contains acknowledgedSteps: [10], contiguous: -1
    const cp = await store.loadCheckpoint('conv-test');
    assert.deepEqual(cp?.acknowledgedSteps, [10]);
    assert.equal(cp?.lastContiguousAcknowledgedStepIndex, -1);

    // Accepted ledger retains original source occurrence timestamp and server receipt time (Review Block C)
    const accepted = await store.listAcceptedExchanges();
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].turnId, 'ag-conv-test-10');
    assert.equal(accepted[0].sourceCreatedAt, '2026-10-26T18:00:00Z');
    assert.ok(accepted[0].serverAcceptedAt, 'Must record server receipt timestamp');

    // Verify step 1 and step 20 remain pending on disk!
    const pending = await store.listPendingUserInputs();
    const pendingIds = pending.map((p) => p.turnId);
    assert.ok(pendingIds.includes('ag-conv-test-1'), 'Unpaired turn 1 must remain pending locally');
    assert.ok(pendingIds.includes('ag-conv-test-20'), 'Failed turn 20 must remain pending locally');
    assert.ok(!pendingIds.includes('ag-conv-test-10'), 'Shipped turn 10 must be cleared from pending');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dryRun simulation leaves accepted ledger empty, retains pending, and does not advance cursor (Review Finding B3-DRY)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shipper-b3-dry-test-'));
  try {
    const store = new ShipperStateStore(dir);
    const conversationId = 'conv-dry-test';

    // 1. Pre-existing unacknowledged pending record
    await store.persistPendingUserInput({
      conversationId,
      stepIndex: 1,
      turnId: `ag-${conversationId}-1`,
      userText: 'Earlier pending question',
      createdAt: '2026-10-26T17:50:00Z',
    });

    // 2. Newly parsed exchange at step 10
    const parseResult: ParseResult = {
      exchanges: [
        {
          conversationId,
          stepIndex: 10,
          turnId: `ag-${conversationId}-10`,
          userText: 'Hello',
          assistantText: 'World',
          createdAt: '2026-10-26T18:00:00Z',
        },
      ],
      unpairedUserInputs: [],
      unresolvedTurns: [],
      lastProcessedStepIndex: 10,
    };

    // fetchImpl forbidden: throws if invoked!
    let networkCalls = 0;
    const forbiddenFetch = async () => {
      networkCalls++;
      throw new Error('network_call_forbidden_in_dry_run');
    };

    const report = await shipAntigravityExchanges(parseResult, {
      apiUrl: 'https://example.com',
      authToken: 'test-token',
      stateStore: store,
      dryRun: true,
      fetchImpl: forbiddenFetch as any,
    });

    assert.equal(networkCalls, 0, 'No network calls in dry-run');
    assert.equal(report.shipped, 0, 'shipped must be 0 in dry-run');
    assert.equal(report.simulated, 1, 'simulated must be 1 in dry-run');
    assert.equal(report.lastAcknowledgedStepIndex, -1, 'cursor must remain unchanged');

    // Assert accepted ledger is empty: NO false evidence of server acceptance!
    const accepted = await store.listAcceptedExchanges();
    assert.equal(accepted.length, 0, 'accepted ledger must remain completely empty in dry-run');

    // Assert checkpoint is untouched
    const cp = await store.loadCheckpoint(conversationId);
    assert.equal(cp, null, 'checkpoint must not be created or updated in dry-run');

    // Assert pending inputs are NOT removed: both pre-existing step 1 and step 10 remain on disk
    const pending = await store.listPendingUserInputs();
    const pendingIds = pending.map(p => p.turnId);
    assert.ok(pendingIds.includes(`ag-${conversationId}-1`), 'Pre-existing pending input must remain');
    assert.ok(pendingIds.includes(`ag-${conversationId}-10`), 'Newly parsed input must remain pending');

    // 3. Now perform a real synthetic 202 dispatch: ONLY this branch creates acceptance evidence!
    const mock202Fetch = async () =>
      new Response(JSON.stringify({ ok: true, acknowledgement: 'pending' }), { status: 202 });

    const liveReport = await shipAntigravityExchanges(parseResult, {
      apiUrl: 'https://example.com',
      authToken: 'test-token',
      stateStore: store,
      dryRun: false,
      fetchImpl: mock202Fetch as any,
    });

    assert.equal(liveReport.shipped, 1);
    assert.equal(liveReport.simulated, 0);

    // Now accepted ledger contains exactly the accepted exchange
    const liveAccepted = await store.listAcceptedExchanges();
    assert.equal(liveAccepted.length, 1);
    assert.equal(liveAccepted[0].turnId, `ag-${conversationId}-10`);
    assert.equal(liveAccepted[0].sourceCreatedAt, '2026-10-26T18:00:00Z');
    assert.ok(liveAccepted[0].serverAcceptedAt);

    // Pending input for step 10 is cleared; step 1 remains
    const livePending = await store.listPendingUserInputs();
    const livePendingIds = livePending.map(p => p.turnId);
    assert.ok(!livePendingIds.includes(`ag-${conversationId}-10`), 'Accepted input cleared');
    assert.ok(livePendingIds.includes(`ag-${conversationId}-1`), 'Earlier unacknowledged input remains');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── Protobuf Encoding Helpers for Synthetic SQLite Fixture Tests ────────────

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

function buildUserInputPayload(opts: {
  status?: number;
  metadata: Buffer;
  userText?: string;
  artifactUri?: string;
  omitF19?: boolean;
}): Buffer {
  const status = opts.status ?? 3;
  const parts: Buffer[] = [
    encodeVarintField(1, 14),
    encodeVarintField(4, status),
    encodeBytesField(5, opts.metadata),
  ];
  if (!opts.omitF19) {
    const f19Parts: Buffer[] = [];
    if (opts.userText !== undefined) {
      f19Parts.push(encodeBytesField(2, opts.userText));
    }
    if (opts.artifactUri !== undefined) {
      f19Parts.push(encodeBytesField(7, opts.artifactUri));
    }
    parts.push(encodeBytesField(19, Buffer.concat(f19Parts)));
  }
  return Buffer.concat(parts);
}

function buildPlannerResponsePayload(opts: {
  status?: number;
  metadata: Buffer;
  responseText?: string;
  thinkingText?: string;
  omitF20?: boolean;
}): Buffer {
  const status = opts.status ?? 3;
  const parts: Buffer[] = [
    encodeVarintField(1, 15),
    encodeVarintField(4, status),
    encodeBytesField(5, opts.metadata),
  ];
  if (!opts.omitF20) {
    const f20Parts: Buffer[] = [];
    if (opts.responseText !== undefined) {
      f20Parts.push(encodeBytesField(1, opts.responseText));
    }
    if (opts.thinkingText !== undefined) {
      f20Parts.push(encodeBytesField(3, opts.thinkingText));
    }
    parts.push(encodeBytesField(20, Buffer.concat(f20Parts)));
  }
  return Buffer.concat(parts);
}

test('assertNotSummariesDb refuses conversation_summaries.db (Inviolability of the Narrative)', () => {
  assert.throws(
    () => assertNotSummariesDb('C:/Users/David/.gemini/antigravity/conversations/conversation_summaries.db'),
    /forbidden_summaries_db/
  );
  assert.doesNotThrow(() =>
    assertNotSummariesDb('C:/Users/David/.gemini/antigravity/conversations/c9a6e229-61fb-4e4a-983d-61defdc8b7da.db')
  );
});

test('parseAntigravityJournal rejects compact JSONL truncation in both USER_INPUT and PLANNER_RESPONSE', () => {
  const conversationId = 'conv-trunc-test';
  const lines = [
    // Turn 1: truncated_fields on USER_INPUT
    JSON.stringify({
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-10-28T10:00:00Z',
      truncated_fields: ['content'],
      content: '<USER_REQUEST>\nHello\n</USER_REQUEST>',
    }),
    // Turn 2: literal <truncated N bytes> inside PLANNER_RESPONSE
    JSON.stringify({
      step_index: 10,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-10-28T10:01:00Z',
      content: '<USER_REQUEST>\nGive me a long answer\n</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 11,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'Start of answer\n<truncated 1849 bytes>\nEnd of answer',
    }),
    // Turn 3: clean complete turn sealing Turn 2
    JSON.stringify({
      step_index: 20,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-10-28T10:02:00Z',
      content: '<USER_REQUEST>\nClean prompt\n</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 21,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'Clean response',
    }),
    JSON.stringify({
      step_index: 30,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-10-28T10:03:00Z',
      content: '<USER_REQUEST>\nFinal prompt\n</USER_REQUEST>',
    }),
  ];

  const parsed = parseAntigravityJournal(lines, conversationId);
  assert.equal(parsed.exchanges.length, 1, 'Only clean Turn 20 must be emitted as a complete exchange');
  assert.equal(parsed.exchanges[0].stepIndex, 20);
  assert.equal(parsed.unresolvedTurns.length, 2, 'Both truncated turns (1 and 10) must be held in unresolvedTurns');
  assert.equal(parsed.unresolvedTurns[0].stepIndex, 1);
  assert.equal(parsed.unresolvedTurns[0].reason, 'compact_jsonl_truncated');
  assert.equal(parsed.unresolvedTurns[1].stepIndex, 10);
  assert.equal(parsed.unresolvedTurns[1].reason, 'compact_jsonl_truncated');
});

test('decodeProtobufFields fails closed on empty, truncated, overflowed, or unsupported wire types', () => {
  assert.throws(() => decodeProtobufFields(new Uint8Array(0)), /empty_buffer/);
  // Truncated varint tag
  assert.throws(() => decodeProtobufFields(Buffer.from([0x80])), /truncated_tag_varint/);
  // Unsupported wire type 3 (start group)
  assert.throws(() => decodeProtobufFields(Buffer.from([(1 << 3) | 3])), /unsupported_wire_type_3/);
  // Length-delimited overflow: claims 50 bytes, only 2 bytes follow
  assert.throws(
    () => decodeProtobufFields(Buffer.from([(1 << 3) | 2, 50, 0x61, 0x62])),
    /length_overflow/
  );
});

test('snapshotAndParseAntigravitySqliteDb parses synthetic .db fixtures, preserves bare trailing CR, and fails closed on evicted/corrupt rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shipper-sqlite-fixture-'));
  try {
    const dbPath = join(dir, 'test-conv.db');
    const conversationId = 'test-conv';

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

    // 1. Step 0: Evicted USER_INPUT (status = 5, no field 19) -> reason: evicted_step_payload
    const meta0 = buildStepMetadata(1793200000, 4);
    insert.run(0, 14, 5, meta0, buildUserInputPayload({ status: 5, metadata: meta0, omitF19: true }), 0);

    // 2. Step 10: Normal USER_INPUT with bare trailing \r and leading/trailing \r\n (LCC seq 83 edge case!)
    const bareCrUserText = '\r\nLine 1 with indentation\r\nLine 2 ending with bare CR\r';
    const meta10 = buildStepMetadata(1793200100, 4);
    insert.run(10, 14, 3, meta10, buildUserInputPayload({ metadata: meta10, userText: bareCrUserText }), 0);

    // 3. Step 11: Tool-call-only PLANNER_RESPONSE (thinking present, no responseText field 1)
    const meta11 = buildStepMetadata(1793200105, 2);
    insert.run(11, 15, 3, meta11, buildPlannerResponsePayload({ metadata: meta11, thinkingText: 'internal thought' }), 0);

    // 4. Step 12: Communicative PLANNER_RESPONSE part 1
    const meta12 = buildStepMetadata(1793200110, 2);
    insert.run(
      12,
      15,
      3,
      meta12,
      buildPlannerResponsePayload({ metadata: meta12, responseText: 'First part of answer.', thinkingText: 't2' }),
      0
    );

    // 5. Step 13: Communicative PLANNER_RESPONSE part 2
    const meta13 = buildStepMetadata(1793200115, 2);
    insert.run(
      13,
      15,
      3,
      meta13,
      buildPlannerResponsePayload({ metadata: meta13, responseText: 'Second part of answer.' }),
      0
    );

    // 6. Step 20: Artifact empty-proceed USER_INPUT (field 19.7 URI, no field 19.2) -> seals Step 10 and records empty_user_request
    const meta20 = buildStepMetadata(1793200200, 4);
    insert.run(
      20,
      14,
      3,
      meta20,
      buildUserInputPayload({ metadata: meta20, artifactUri: 'file:///artifact/plan.md' }),
      0
    );

    // 7. Step 30: Malformed protobuf blob in step_payload (valid tag for field 19 wireType 2, length 99, only 2 bytes follow) -> reason: corrupt_protobuf_payload
    const meta30 = buildStepMetadata(1793200300, 4);
    insert.run(
      30,
      14,
      3,
      meta30,
      Buffer.concat([encodeVarint((BigInt(19) << BigInt(3)) | BigInt(2)), Buffer.from([99, 0x01, 0x02])]),
      0
    );

    // 8. Step 40: Unsupported step_format = 1 -> reason: unsupported_step_format
    const meta40 = buildStepMetadata(1793200400, 4);
    insert.run(40, 14, 3, meta40, buildUserInputPayload({ metadata: meta40, userText: 'Future format' }), 1);

    // 9. Step 50: Trailing open turn (USER_INPUT + PLANNER_RESPONSE at EOF)
    const meta50 = buildStepMetadata(1793200500, 4);
    insert.run(50, 14, 3, meta50, buildUserInputPayload({ metadata: meta50, userText: 'Trailing prompt' }), 0);
    const meta51 = buildStepMetadata(1793200505, 2);
    insert.run(
      51,
      15,
      3,
      meta51,
      buildPlannerResponsePayload({ metadata: meta51, responseText: 'Trailing response in progress' }),
      0
    );

    db.close();

    // Write a synthetic -wal sidecar to verify WAL snapshot SHA-256 capture
    const walPath = `${dbPath}-wal`;
    await writeFile(walPath, 'synthetic-wal-bytes');
    const expectedWalSha = createHash('sha256').update('synthetic-wal-bytes').digest('hex');

    const res = await snapshotAndParseAntigravitySqliteDb(dbPath, conversationId);

    // Snapshot SHA-256 evidence
    assert.equal(res.sourceSnapshot.conversationId, conversationId);
    assert.equal(res.sourceSnapshot.pinnedIdeVersion, '2.6.0');
    assert.ok(/^[0-9a-f]{64}$/.test(res.sourceSnapshot.sourceDbSha256));
    assert.equal(res.sourceSnapshot.walSha256, expectedWalSha);

    // Completed exchange at Step 10 preserves bare trailing \r and internal \r\n byte-for-byte!
    assert.equal(res.exchanges.length, 1);
    assert.equal(res.exchanges[0].stepIndex, 10);
    assert.equal(res.exchanges[0].userText, bareCrUserText);
    assert.ok(res.exchanges[0].userText.endsWith('\r'), 'Trailing bare CR must be preserved byte-exact');
    assert.equal(res.exchanges[0].assistantText, 'First part of answer.\n\nSecond part of answer.');

    // Unresolved turns: Step 0 (evicted_step_payload), Step 20 (empty_user_request), Step 30 (corrupt_protobuf_payload), Step 40 (unsupported_step_format)
    assert.deepEqual(
      res.unresolvedTurns.map(u => ({ stepIndex: u.stepIndex, reason: u.reason })),
      [
        { stepIndex: 0, reason: 'evicted_step_payload' },
        { stepIndex: 20, reason: 'empty_user_request' },
        { stepIndex: 30, reason: 'corrupt_protobuf_payload' },
        { stepIndex: 40, reason: 'unsupported_step_format' },
      ]
    );

    // Trailing turn at Step 50 held open
    assert.ok(res.openTrailingTurn);
    assert.equal(res.openTrailingTurn?.stepIndex, 50);
    assert.equal(res.openTrailingTurn?.assistantTextSoFar, 'Trailing response in progress');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parseAntigravitySqliteSteps holds the entire affected turn when a second assistant response part has a malformed wire type on f20.1 (R2 regression)', () => {
  const conversationId = 'conv-r2-regression';
  const metaUser1 = buildStepMetadata(1793201000, 4);
  const metaModel1 = buildStepMetadata(1793201005, 2);
  const metaModel2 = buildStepMetadata(1793201010, 2);
  const metaUser2 = buildStepMetadata(1793201020, 4);

  // Build a second assistant response step where field 20 -> field 1 is VARINT (wireType 0) instead of LEN (wireType 2)
  const malformedF20Inner = Buffer.concat([
    encodeVarintField(1, 42), // f20.1 as VARINT instead of string/bytes!
  ]);
  const malformedStep15Payload = Buffer.concat([
    encodeVarintField(1, 15),
    encodeVarintField(4, 3),
    encodeBytesField(5, metaModel2),
    encodeBytesField(20, malformedF20Inner),
  ]);

  const rows = [
    {
      idx: 1,
      step_type: 14,
      status: 3,
      metadata: metaUser1,
      step_payload: buildUserInputPayload({ metadata: metaUser1, userText: 'First user question' }),
      step_format: 0,
    },
    {
      idx: 2,
      step_type: 15,
      status: 3,
      metadata: metaModel1,
      step_payload: buildPlannerResponsePayload({ metadata: metaModel1, responseText: 'Valid first part.' }),
      step_format: 0,
    },
    {
      idx: 3,
      step_type: 15,
      status: 3,
      metadata: metaModel2,
      step_payload: malformedStep15Payload,
      step_format: 0,
    },
    {
      idx: 4,
      step_type: 14,
      status: 3,
      metadata: metaUser2,
      step_payload: buildUserInputPayload({ metadata: metaUser2, userText: 'Second user question' }),
      step_format: 0,
    },
  ];

  const res = parseAntigravitySqliteSteps(rows, conversationId);

  // Must NOT emit a partial exchange containing only 'Valid first part.'!
  assert.equal(res.exchanges.length, 0);
  assert.equal(res.unresolvedTurns.length, 1);
  assert.equal(res.unresolvedTurns[0].stepIndex, 1);
  assert.equal(res.unresolvedTurns[0].turnId, `ag-${conversationId}-1`);
  assert.equal(res.unresolvedTurns[0].reason, 'corrupt_protobuf_payload');

  // Following valid user row is preserved as unpaired input at EOF
  assert.equal(res.unpairedUserInputs.length, 1);
  assert.equal(res.unpairedUserInputs[0].stepIndex, 4);
  assert.equal(res.unpairedUserInputs[0].userText, 'Second user question');
});

test('assertNodeSqliteRuntime fails fast with clear error when node:sqlite is unavailable (R1 runtime contract)', () => {
  assert.doesNotThrow(() => assertNodeSqliteRuntime());
  assert.throws(
    () =>
      assertNodeSqliteRuntime(() => {
        const err = new Error('No such built-in module: node:sqlite') as Error & { code?: string };
        err.code = 'ERR_UNKNOWN_BUILTIN_MODULE';
        throw err;
      }),
    /antigravity-journal-shipper requires Node 22\+ \(node:sqlite\)/
  );
});



