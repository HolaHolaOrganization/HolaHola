/**
 * The Anthropic tool loop for one Alden turn, with the model call and tool
 * execution injected, so the loop's behaviour (refusals above all) is tested
 * without a live provider. alden-persona-service.ts supplies the real ones.
 *
 * Refusals are effect-aware: a model can decline after earlier rounds already
 * ran tools, so the reply must never claim "nothing was done" when something
 * was. Every model call in the turn (rounds, the continuation wrap and the
 * round-limit wrap) goes through the same reading, and a refused turn never
 * returns a continuation (routes.ts would run it as another phase).
 */
import type Anthropic from "@anthropic-ai/sdk";

export type ToolRun = { name: string; succeeded: boolean };

export type TurnModelCall = (params: {
  messages: Anthropic.MessageParam[];
  maxTokens: number;
  withTools: boolean;
}) => Promise<Anthropic.Message>;

export type TurnToolCall = (block: Anthropic.ToolUseBlock) => Promise<{
  content: string;
  isError: boolean;
  continuation?: unknown;
}>;

export function refusalCategory(resp: Anthropic.Message): string | null {
  if ((resp.stop_reason as string) !== 'refusal') return null;
  return (resp as unknown as { stop_details?: { category?: string | null } }).stop_details?.category ?? 'unknown';
}

/**
 * What to tell the founder when the model declines, accounting for every tool
 * call already attempted. A call that reported an error may still have
 * committed something before failing, so an error is "uncertain", never
 * "nothing happened"; only a turn with no attempted call changed nothing.
 */
export function aldenRefusalReply(category: string, toolsRun: readonly ToolRun[]): string {
  if (toolsRun.length === 0) {
    return `I couldn't complete that turn: the model declined it (category: ${category}). No tool had been called in this turn, so nothing was changed.`;
  }
  const names = [...new Set(toolsRun.map((t) => t.name))].join(', ');
  const failed = toolsRun.filter((t) => !t.succeeded).length;
  const uncertain = failed === 0 ? '' : ` ${failed} of them reported an error, so whether ${failed === 1 ? 'it' : 'they'} changed anything is uncertain.`;
  return `I couldn't finish that turn: the model declined to continue (category: ${category}) after ${toolsRun.length} tool call${toolsRun.length === 1 ? ' was' : 's were'} attempted (${names}).${uncertain} `
    + 'Whatever those calls did stands, and nothing after the decline was done. Check their results before retrying.';
}

const textOf = (resp: Anthropic.Message) =>
  resp.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n');

export const ROUND_LIMIT_FALLBACK = "I've been researching but ran into my context limit. Ask me again to continue.";

export async function runAldenAnthropicTurn(deps: {
  messages: Anthropic.MessageParam[];
  call: TurnModelCall;
  runTool: TurnToolCall;
  maxRounds: number;
  maxTokens: number;
  wrapMaxTokens: number;
  onModelResponse?: (resp: Anthropic.Message) => void;
}): Promise<{ response: string; toolsRun: ToolRun[]; continuation?: unknown; refused: boolean }> {
  const { messages, call, runTool } = deps;
  const toolsRun: ToolRun[] = [];
  let continuation: unknown;

  const read = (resp: Anthropic.Message): { text: string | null; refusal: string | null } => {
    deps.onModelResponse?.(resp);
    const category = refusalCategory(resp);
    if (category) {
      console.warn(`[Alden Chat/Claude] Turn declined by the model (category: ${category}) after ${toolsRun.length} tool call(s)`);
      return { text: null, refusal: aldenRefusalReply(category, toolsRun) };
    }
    return { text: textOf(resp) || null, refusal: null };
  };

  for (let round = 0; round < deps.maxRounds; round++) {
    const resp = await call({ messages, maxTokens: deps.maxTokens, withTools: true });
    const { text, refusal } = read(resp);
    if (refusal) return { response: refusal, toolsRun, continuation: undefined, refused: true };

    const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (toolUses.length === 0) {
      if (text) return { response: text, toolsRun, continuation, refused: false };
      break;
    }

    console.log(`[Alden Chat/Claude] Round ${round + 1}: ${toolUses.length} tool call(s) — ${toolUses.map((b) => b.name).join(', ')}`);
    messages.push({ role: 'assistant', content: resp.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUses) {
      const result = await runTool(block);
      toolsRun.push({ name: block.name, succeeded: !result.isError });
      results.push({ type: 'tool_result', tool_use_id: block.id, content: result.content, ...(result.isError ? { is_error: true } : {}) });
      if (result.continuation) continuation = result.continuation;
    }
    messages.push({ role: 'user', content: results });

    if (continuation) {
      const wrap = read(await call({ messages, maxTokens: deps.wrapMaxTokens, withTools: true }));
      if (wrap.refusal) return { response: wrap.refusal, toolsRun, continuation: undefined, refused: true };
      if (wrap.text) return { response: wrap.text, toolsRun, continuation, refused: false };
      break;
    }
  }

  console.log(`[Alden Chat/Claude] Round limit hit — requesting wrap-up summary`);
  try {
    messages.push({ role: 'user', content: '[SYSTEM] You have reached the tool-use limit for this turn. Summarise what you have found and discovered so far, and clearly state what you still intend to do next turn.' });
    const wrap = read(await call({ messages, maxTokens: deps.wrapMaxTokens, withTools: false }));
    if (wrap.refusal) return { response: wrap.refusal, toolsRun, continuation: undefined, refused: true };
    return { response: wrap.text ?? ROUND_LIMIT_FALLBACK, toolsRun, continuation, refused: false };
  } catch {
    return { response: ROUND_LIMIT_FALLBACK, toolsRun, continuation, refused: false };
  }
}
