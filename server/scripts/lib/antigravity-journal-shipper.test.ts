import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractAntigravityUserRequest,
  extractAntigravityAssistantText,
  parseAntigravityJournal,
  ShipperStateStore,
  shipAntigravityExchanges,
  persistJournalEvidence,
  calculateContiguousAcknowledgedStep,
  type ParseResult,
} from './antigravity-journal-shipper';

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
  const dir = await mkdtemp(join(tmpdir(), 'shipper-evidence-test-'));
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
  const dir = await mkdtemp(join(tmpdir(), 'shipper-fail-closed-test-'));
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
  const dir = await mkdtemp(join(tmpdir(), 'shipper-ship-test-'));
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
  const dir = await mkdtemp(join(tmpdir(), 'shipper-b3-dry-test-'));
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
