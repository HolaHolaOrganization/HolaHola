import { createHash } from "node:crypto";
import type { getCoordinationThread } from "./coordination-ledger-service";
import type { listCoordinationInbox } from "./coordination-inbox-service";
import { ALDEN_TOOL_RESULT_LIMIT, serializeAldenToolResult } from "./alden-tool-result";

export const ALDEN_INBOX_PAGE_SIZE = 5;
// Most messages fit in one read. It was 1000, which cost a 16-round wake turn
// 3–8 rounds per ordinary message (founder, 2026-11-03). A chunk still shrinks
// below this when escaping would push the result past ALDEN_TOOL_RESULT_LIMIT.
export const ALDEN_MESSAGE_CHUNK_SIZE = 8000;

function integer(value: unknown, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new Error("invalid_request: expected a safe integer");
  }
  return value;
}

function surrogateBoundary(text: string, end: number): number {
  if (end > 0 && end < text.length
    && /[\uD800-\uDBFF]/.test(text[end - 1])
    && /[\uDC00-\uDFFF]/.test(text[end])) return end - 1;
  return end;
}

// Bound escaped JSON, not just source characters (control chars expand 6x).
function jsonPrefix(text: string, budget: number): string {
  let low = 0;
  let high = Math.min(text.length, budget);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (JSON.stringify(text.slice(0, mid)).length <= budget) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, surrogateBoundary(text, low));
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function listAldenCoordinationInbox(
  args: Record<string, unknown>,
  listInbox: typeof listCoordinationInbox,
) {
  const limit = Math.min(integer(args.limit, ALDEN_INBOX_PAGE_SIZE, 1), ALDEN_INBOX_PAGE_SIZE);
  const after = args.after === undefined ? undefined : integer(args.after, 0, 0);
  if (args.token !== undefined && typeof args.token !== "string") {
    throw new Error("invalid_request: token must be a string");
  }
  const token = typeof args.token === "string" && args.token.trim() ? args.token.trim() : undefined;
  const result = await listInbox("alden", { token, after, limit });
  const buildData = (previewBudget: number) => ({
    // Keep the genuine service window and token, not a reconstructed cursor.
    window: result.window,
    items: result.items.map(({ thread, event }) => {
      const preview = jsonPrefix(event.content, previewBudget);
      const title = jsonPrefix(thread.title, 180);
      const contentComplete = preview.length === event.content.length;
      return {
        threadId: thread.id,
        eventId: event.id,
        threadTitle: title,
        threadTitleComplete: title.length === thread.title.length,
        eventType: event.eventType,
        from: event.actor,
        recipient: event.recipientActor,
        sequence: event.sequence,
        globalSequence: event.globalSequence,
        createdAt: event.createdAt,
        contentComplete,
        totalCharacters: event.content.length,
        contentSha256: sha256(event.content),
        ...(contentComplete ? { content: event.content } : {
          contentPreview: preview,
          contentRead: {
            tool: "read_coordination_message",
            thread_id: thread.id,
            event_id: event.id,
            offset: 0,
          },
        }),
      };
    }),
  });
  let budget = 900;
  let data = buildData(budget);
  // Tokens occur twice in the canonical window. Reserve their actual size,
  // not an assumed token length, before budgeting per-message previews.
  while (JSON.stringify(data).length > ALDEN_TOOL_RESULT_LIMIT && data.items.length && budget > 2) {
    const excess = JSON.stringify(data).length - ALDEN_TOOL_RESULT_LIMIT;
    budget = Math.max(2, budget - Math.ceil(excess / data.items.length));
    data = buildData(budget);
  }
  serializeAldenToolResult("list_coordination_inbox", data);
  return data;
}

export async function readAldenCoordinationMessage(
  args: Record<string, unknown>,
  getThread: typeof getCoordinationThread,
) {
  const threadId = args.thread_id;
  const eventId = args.event_id;
  if (typeof threadId !== "string" || !threadId || typeof eventId !== "string" || !eventId) {
    throw new Error("invalid_request: thread_id and event_id are required");
  }
  const offset = integer(args.offset, 0, 0);
  // The canonical service checks participation before returning any events.
  const { events } = await getThread(threadId, "alden");
  const event = events.find((candidate) => candidate.id === eventId);
  if (!event) throw new Error("event_not_found: event is not on the authorized thread");
  const source = event.content;
  if (offset > source.length || surrogateBoundary(source, offset) !== offset) {
    throw new Error("invalid_request: offset is outside the message or splits a surrogate pair");
  }
  const build = (end: number) => {
    const complete = end === source.length;
    return {
      threadId,
      eventId,
      from: event.actor,
      recipient: event.recipientActor,
      eventType: event.eventType,
      sequence: event.sequence,
      globalSequence: event.globalSequence,
      content: source.slice(offset, end),
      offset,
      nextOffset: complete ? null : end,
      totalCharacters: source.length,
      contentSha256: sha256(source),
      complete,
    };
  };
  let data = build(surrogateBoundary(source, Math.min(source.length, offset + ALDEN_MESSAGE_CHUNK_SIZE)));
  if (JSON.stringify(data).length > ALDEN_TOOL_RESULT_LIMIT) {
    // Escaping expanded the chunk: keep the largest prefix whose escaped form
    // fits beside the rest of the result. The envelope is measured with the
    // widest nextOffset, so the final result can only be shorter.
    const envelope = JSON.stringify({ ...data, content: "", nextOffset: source.length }).length;
    const prefix = jsonPrefix(data.content, ALDEN_TOOL_RESULT_LIMIT - envelope);
    data = build(offset + prefix.length);
  }
  serializeAldenToolResult("read_coordination_message", data);
  return data;
}
