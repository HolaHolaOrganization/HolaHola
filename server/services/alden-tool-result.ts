import { createHash } from "node:crypto";

// Coordination pages/chunks have their own bounded, structured transport.
// Never turn their valid JSON into an incomplete string.
export const ALDEN_TOOL_RESULT_LIMIT = 12_000;
const COORDINATION_RESULT_TOOLS = new Set([
  "list_coordination_inbox",
  "read_coordination_message",
]);
// Conversation memory discovery and content chunks are bounded by their
// builders (alden-memory-read.ts), so they are delivered whole, never cut.
const MEMORY_RESULT_TOOLS = new Set([
  "read_conversation_memories",
  "read_conversation_memory_content",
]);
const COMPLETE_RESULT_TOOLS = new Set([
  ...COORDINATION_RESULT_TOOLS, ...MEMORY_RESULT_TOOLS, "read_shared_spec_review",
]);

export function serializeAldenToolResult(name: string, data: unknown): string {
  const result = JSON.stringify(data);
  if (COMPLETE_RESULT_TOOLS.has(name)) {
    if (result.length > ALDEN_TOOL_RESULT_LIMIT) {
      const kind = COORDINATION_RESULT_TOOLS.has(name) ? "coordination"
        : MEMORY_RESULT_TOOLS.has(name) ? "memory" : "review_source";
      throw new Error(`${kind}_tool_result_too_large: no content or paging token was delivered`);
    }
    return result;
  }
  // The notice leads, so a cut result can't be read as complete: something not
  // shown here (a match, a definition, a file) may still exist.
  return result.length > ALDEN_TOOL_RESULT_LIMIT
    ? truncatedResultNotice(result.length)
      + result.slice(0, ALDEN_TOOL_RESULT_LIMIT)
      + `\n... [truncated: ${result.length - ALDEN_TOOL_RESULT_LIMIT} chars omitted]`
    : result;
}

export function truncatedResultNotice(totalChars: number): string {
  return `[truncated result: showing the first ${ALDEN_TOOL_RESULT_LIMIT} of ${totalChars} characters. `
    + 'Anything not shown may still exist, so do not conclude from this result that something is absent; '
    + 'narrow the query or read the specific file or lines instead.]\n';
}

export function isCompleteAldenResultTool(name: string): boolean {
  return COMPLETE_RESULT_TOOLS.has(name);
}

/** The watch worker's tool_result content: whole for bounded tools, else a 3000-char cut. */
export function aldenWatchToolResultContent(name: string, toolOutput: any): string {
  return isCompleteAldenResultTool(name)
    ? serializeAldenToolResult(name, toolOutput?.data ?? toolOutput)
    : JSON.stringify(toolOutput).substring(0, 3000);
}

// Evidence for the authenticated priority-task caller, not model-authored
// assertions. Never include message text, credentials or signed window tokens.
export function aldenCoordinationReadReceipt(name: string, data: any, args: Record<string, unknown> = {}) {
  if (!COORDINATION_RESULT_TOOLS.has(name) || !data) return null;
  const tokenHash = (value: unknown) => typeof value === "string"
    ? createHash("sha256").update(value.trim(), "utf8").digest("hex") : null;
  const request = name === "list_coordination_inbox"
    ? { requestedTokenSha256: tokenHash(args.token) } : {};
  if (data.error) {
    return { tool: name, errorCode: data.code ?? "tool_error", ...request };
  }
  if (name === "list_coordination_inbox") {
    return {
      tool: name,
      ...request,
      window: {
        after: data.window.after,
        through: data.window.through,
        complete: data.window.complete,
        acknowledged: data.window.acknowledged,
        hasNextToken: typeof data.window.nextToken === "string",
        nextTokenSha256: tokenHash(data.window.nextToken),
      },
      items: data.items.map((item: any) => ({
        threadId: item.threadId, eventId: item.eventId,
        globalSequence: item.globalSequence, from: item.from, recipient: item.recipient,
        contentComplete: item.contentComplete, totalCharacters: item.totalCharacters,
        contentSha256: item.contentSha256,
      })),
    };
  }
  return {
    tool: name,
    threadId: data.threadId,
    eventId: data.eventId,
    globalSequence: data.globalSequence,
    from: data.from,
    recipient: data.recipient,
    offset: data.offset,
    nextOffset: data.nextOffset,
    totalCharacters: data.totalCharacters,
    contentSha256: data.contentSha256,
    complete: data.complete,
  };
}
