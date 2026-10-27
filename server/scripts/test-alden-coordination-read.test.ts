import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { listAldenCoordinationInbox, readAldenCoordinationMessage } from "../services/alden-coordination-read";
import { aldenCoordinationReadReceipt, aldenWatchToolResultContent, serializeAldenToolResult, ALDEN_TOOL_RESULT_LIMIT } from "../services/alden-tool-result";
import type { listCoordinationInbox } from "../services/coordination-inbox-service";
import type { getCoordinationThread } from "../services/coordination-ledger-service";

const event = (content: string, index = 1) => ({
  id: `event-${index}`, content, actor: "luca-claude-code", recipientActor: "alden",
  eventType: "comment", sequence: index, globalSequence: 1300 + index,
  createdAt: new Date("2026-10-06T17:00:00Z"),
});
const window = {
  after: 1300, through: 1400, complete: false,
  token: "signed-window", nextToken: "signed-window", acknowledged: 0,
};
function listFixture(content: string, extraWindow = {}) {
  return (async (actor, options) => {
    assert.equal(actor, "alden");
    assert.ok(options!.limit! <= 5);
    return {
      window: { ...window, ...extraWindow },
      items: Array.from({ length: options!.limit! }, (_, i) => ({
        event: event(content, i + 1),
        thread: { id: "thread", title: "\u0000".repeat(5000) },
      })),
    };
  }) as typeof listCoordinationInbox;
}
const getFixture = (content: string) => (async (threadId, actor) => {
  assert.equal(threadId, "thread");
  assert.equal(actor, "alden");
  return { events: [event(content)], thread: { id: "thread" } };
}) as typeof getCoordinationThread;

test("short content remains complete and retains source identifiers and paging", async () => {
  const data = await listAldenCoordinationInbox({}, listFixture("hello"));
  assert.equal(data.items.length, 5);
  assert.deepEqual(data.window, window);
  assert.equal(data.items[0].content, "hello");
  assert.equal(data.items[0].contentComplete, true);
  assert.equal(data.items[0].eventId, "event-1");
  assert.equal(data.items[0].recipient, "alden");
  assert.ok(!("contentPreview" in data.items[0]));
  assert.equal(data.items[0].threadTitleComplete, false);
});

for (const [label, text] of [
  ["long prose", "reconstruction report ".repeat(3000)],
  ["JSON control expansion", "\u0000\"\\\n".repeat(9000)],
  ["astral Unicode", "🙂漢".repeat(9000)],
]) {
  test(`${label}: complete JSON preserves a long token and distinguishes previews`, async () => {
    const token = "opaque".repeat(600);
    const data = await listAldenCoordinationInbox({ limit: 50 }, listFixture(text, {
      token, nextToken: token,
    }));
    const wire = serializeAldenToolResult("list_coordination_inbox", data);
    assert.ok(wire.length <= ALDEN_TOOL_RESULT_LIMIT);
    const received = JSON.parse(wire);
    assert.equal(received.window.nextToken, token);
    assert.equal(received.items.length, 5);
    for (const item of received.items) {
      assert.equal(item.contentComplete, false);
      assert.ok(!("content" in item));
      assert.ok(text.startsWith(item.contentPreview));
      assert.equal(item.contentRead.offset, 0);
      assert.equal(item.contentRead.tool, "read_coordination_message");
      assert.equal(item.totalCharacters, text.length);
    }
  });
  test(`${label}: every chunk reconstructs exact content and a matching source digest`, async () => {
    let offset = 0;
    let reassembled = "";
    let chunks = 0;
    for (;;) {
      const result = await readAldenCoordinationMessage({
        thread_id: "thread", event_id: "event-1", offset,
      }, getFixture(text));
      const received = JSON.parse(serializeAldenToolResult("read_coordination_message", result));
      assert.equal(received.offset, offset);
      assert.equal(received.totalCharacters, text.length);
      assert.equal(received.contentSha256, createHash("sha256").update(text).digest("hex"));
      reassembled += received.content;
      chunks++;
      if (received.complete) {
        assert.equal(received.nextOffset, null);
        break;
      }
      assert.ok(received.nextOffset > offset);
      offset = received.nextOffset;
    }
    assert.ok(chunks > 1);
    assert.equal(reassembled, text);
  });
}

test("multi-page continuation forwards the real token, retains window bounds and never acknowledges", async () => {
  const requests: unknown[] = [];
  const list = (async (actor, options) => {
    requests.push({ actor, ...options });
    if (!options!.token) {
      return { window, items: [{ event: event("first"), thread: { id: "thread", title: "title" } }] };
    }
    assert.equal(options!.token, window.nextToken);
    return {
      window: { ...window, complete: true, nextToken: null },
      items: [{ event: event("second", 2), thread: { id: "thread", title: "title" } }],
    };
  }) as typeof listCoordinationInbox;
  const first = await listAldenCoordinationInbox({ after: 1300 }, list);
  const second = await listAldenCoordinationInbox({ token: first.window.nextToken }, list);
  assert.equal(second.items[0].content, "second");
  assert.equal(second.window.complete, true);
  assert.equal(second.window.acknowledged, 0);
  assert.deepEqual(requests, [
    { actor: "alden", token: undefined, after: 1300, limit: 5 },
    { actor: "alden", token: "signed-window", after: undefined, limit: 5 },
  ]);
});

test("a complete inbox window does not claim previewed bodies were read", async () => {
  const data = await listAldenCoordinationInbox({ limit: 1 }, listFixture("x".repeat(20000), {
    complete: true, nextToken: null,
  }));
  assert.equal(data.window.complete, true);
  assert.equal(data.items[0].contentComplete, false);
});

test("thread authorization failures propagate, never expose a fallback event", async () => {
  const deny = (async (_threadId, actor) => {
    assert.equal(actor, "alden");
    throw new Error("thread_participant_required");
  }) as typeof getCoordinationThread;
  await assert.rejects(readAldenCoordinationMessage({
    thread_id: "private", event_id: "event-1",
  }, deny), /thread_participant_required/);
  await assert.rejects(readAldenCoordinationMessage({
    thread_id: "thread", event_id: "event-on-another-thread",
  }, getFixture("secret")), /event_not_found/);
});

test("invalid arguments and surrogate-interior offsets fail explicitly", async () => {
  for (const offset of [-1, 0.5, NaN, "0", 4, 1]) {
    await assert.rejects(readAldenCoordinationMessage({
      thread_id: "thread", event_id: "event-1", offset,
    }, getFixture("🙂a")), /invalid_request/);
  }
  for (const limit of [0, -1, 1.5, "5"]) {
    await assert.rejects(listAldenCoordinationInbox({ limit }, listFixture("hello")), /invalid_request/);
  }
  await assert.rejects(listAldenCoordinationInbox({ token: 123 }, listFixture("hello")), /invalid_request/);
});

test("empty message terminates and a chunk boundary never splits an emoji", async () => {
  const empty = await readAldenCoordinationMessage({
    thread_id: "thread", event_id: "event-1",
  }, getFixture(""));
  assert.equal(empty.complete, true);
  assert.equal(empty.content, "");
  assert.equal(empty.nextOffset, null);
  const first = await readAldenCoordinationMessage({
    thread_id: "thread", event_id: "event-1",
  }, getFixture("a".repeat(999) + "🙂tail"));
  assert.equal(first.nextOffset, 999);
  assert.equal(first.content, "a".repeat(999));
});

test("oversized structured results fail closed; unrelated tools retain existing behavior", () => {
  for (const name of ["list_coordination_inbox", "read_coordination_message"]) {
    assert.throws(() => serializeAldenToolResult(name, { content: "x".repeat(12001) }), /too_large/);
  }
  assert.match(serializeAldenToolResult("other", { content: "x".repeat(12001) }), /truncated/);
});

test("execution receipts preserve actual reading metadata without text or window tokens", async () => {
  const data = await listAldenCoordinationInbox({}, listFixture("private text"));
  const receipt = aldenCoordinationReadReceipt("list_coordination_inbox", data)!;
  assert.match(JSON.stringify(receipt), /event-1/);
  assert.doesNotMatch(JSON.stringify(receipt), /private text|signed-window|"nextToken":/);
  assert.equal(receipt.window!.hasNextToken, true);
  const chunk = await readAldenCoordinationMessage({
    thread_id: "thread", event_id: "event-1",
  }, getFixture("private text"));
  const readReceipt = aldenCoordinationReadReceipt("read_coordination_message", chunk)!;
  assert.equal(readReceipt.contentSha256, chunk.contentSha256);
  assert.doesNotMatch(JSON.stringify(readReceipt), /private text|"content"/);
  assert.equal(aldenCoordinationReadReceipt("other", data), null);
  assert.deepEqual(aldenCoordinationReadReceipt("read_coordination_message", {
    error: "denied", code: "thread_participant_required",
  }), { tool: "read_coordination_message", errorCode: "thread_participant_required" });
  const pagingReceipt = aldenCoordinationReadReceipt("list_coordination_inbox", data, { token: "signed-window" })!;
  assert.equal(pagingReceipt.requestedTokenSha256, pagingReceipt.window!.nextTokenSha256);
  const badTokenReceipt = aldenCoordinationReadReceipt("list_coordination_inbox", {
    error: "signature is invalid", code: "invalid_inbox_window",
  }, { token: "modified-token" })!;
  assert.equal(badTokenReceipt.errorCode, "invalid_inbox_window");
  assert.notEqual(badTokenReceipt.requestedTokenSha256, pagingReceipt.requestedTokenSha256);
  assert.doesNotMatch(JSON.stringify(badTokenReceipt), /modified-token/);
});

test("both provider loops and the background worker use the non-slicing coordination transport", () => {
  const persona = readFileSync("server/services/alden-persona-service.ts", "utf8");
  assert.match(persona, /serializeAldenToolResult\(tu.name, toolResult.data\)/);
  assert.match(persona, /serializeAldenToolResult\(toolName, toolResult.data\)/);
  assert.match(persona, /aldenCoordinationReadReceipt\(tu.name, toolResult.data,/);
  assert.match(persona, /aldenCoordinationReadReceipt\(toolName, toolResult.data, toolArgs\)/);
  const worker = readFileSync("server/services/alden-watch-worker.ts", "utf8");
  assert.match(worker, /aldenWatchToolResultContent\(block.name, toolOutput\)/);
  // The worker's helper delivers coordination results whole, never sliced.
  const message = { content: "x".repeat(5_000) };
  for (const name of ["read_coordination_message", "list_coordination_inbox"]) {
    assert.equal(aldenWatchToolResultContent(name, { data: message }), JSON.stringify(message));
  }
  assert.equal(aldenWatchToolResultContent("some_other_tool", { data: message }).length, 3000);
  const dispatch = readFileSync("server/services/alden-functions.ts", "utf8");
  assert.match(dispatch, /name: "read_coordination_message"/);
  assert.match(dispatch, /readAldenCoordinationMessage\(args, getCoordinationThread\)/);
  assert.match(dispatch, /listAldenCoordinationInbox\(args, listCoordinationInbox\)/);
  assert.match(readFileSync("server/routes.ts", "utf8"),
    /coordinationReadReceipts: result.coordinationReadReceipts \?\? \[\]/);
});
