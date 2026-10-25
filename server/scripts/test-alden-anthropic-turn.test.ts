/** Alden's Anthropic turn loop: effect-aware refusals on every call, with simulated model and tools (no provider calls). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { aldenRefusalReply, runAldenAnthropicTurn, type TurnModelCall } from '../services/alden-anthropic-turn';

const msg = (content: any[], stop_reason: string, extra: Record<string, unknown> = {}) =>
  ({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 }, ...extra }) as unknown as Anthropic.Message;
const toolUse = (name: string, id = `tu-${name}`) => msg([{ type: 'tool_use', id, name, input: {} }], 'tool_use');
const text = (t: string) => msg([{ type: 'text', text: t }], 'end_turn');
const refusal = (category = 'cyber') => msg([], 'refusal', { stop_details: { type: 'refusal', category, explanation: null } });

function scripted(responses: Anthropic.Message[]) {
  const calls: Array<{ withTools: boolean; maxTokens: number }> = [];
  const call: TurnModelCall = async ({ withTools, maxTokens }) => {
    calls.push({ withTools, maxTokens });
    const next = responses.shift();
    if (!next) throw new Error('model called more times than scripted');
    return next;
  };
  return { call, calls };
}

const base = { maxRounds: 5, maxTokens: 16000, wrapMaxTokens: 8000 };

test('a refusal after a write tool ran says so, and never claims nothing was done', async () => {
  const writes: string[] = [];
  const { call } = scripted([toolUse('start_next_episode'), refusal('bio')]);
  const result = await runAldenAnthropicTurn({
    ...base, messages: [{ role: 'user', content: 'go' }], call,
    runTool: async (block) => { writes.push(block.name); return { content: '{"ok":true}', isError: false }; },
  });
  assert.deepEqual(writes, ['start_next_episode']);
  assert.equal(result.refused, true);
  assert.match(result.response, /after 1 tool call was attempted \(start_next_episode\)/);
  assert.match(result.response, /Whatever those calls did stands/);
  assert.doesNotMatch(result.response, /nothing was changed|Nothing was done\./);
  assert.match(result.response, /category: bio/);
});

test('a refusal before any tool ran says nothing was changed', async () => {
  const { call } = scripted([refusal()]);
  const result = await runAldenAnthropicTurn({ ...base, messages: [{ role: 'user', content: 'go' }], call,
    runTool: async () => { throw new Error('no tool should run'); } });
  assert.equal(result.refused, true);
  assert.match(result.response, /No tool had been called in this turn, so nothing was changed\./);
});

test('a refusal on the continuation wrap is handled the same way', async () => {
  const { call, calls } = scripted([toolUse('queue_build_proposal'), refusal('cyber')]);
  const result = await runAldenAnthropicTurn({ ...base, messages: [{ role: 'user', content: 'go' }], call,
    runTool: async () => ({ content: 'queued', isError: false, continuation: { phaseTitle: 'p' } }) });
  assert.equal(result.refused, true);
  assert.match(result.response, /queue_build_proposal/);
  assert.equal(result.continuation, undefined, 'a refused turn must not hand routes.ts a phase to run');
  assert.equal(calls[1].maxTokens, 8000, 'the second call is the continuation wrap');
});

test('a refusal on the round-limit wrap-up is handled the same way, without tools', async () => {
  const { call, calls } = scripted([toolUse('read_file', 'a'), toolUse('read_file', 'b'), refusal('frontier_llm')]);
  const result = await runAldenAnthropicTurn({ ...base, maxRounds: 2, messages: [{ role: 'user', content: 'go' }], call,
    runTool: async () => ({ content: 'x', isError: false }) });
  assert.equal(result.refused, true);
  assert.match(result.response, /after 2 tool calls were attempted \(read_file\)/);
  assert.deepEqual(calls.map((c) => c.withTools), [true, true, false]);
});

test('an errored tool call is reported as uncertain, never as nothing changed; a normal answer is returned unchanged', async () => {
  const reply = aldenRefusalReply('cyber', [{ name: 'write_file', succeeded: false }]);
  assert.match(reply, /1 of them reported an error, so whether it changed anything is uncertain/);
  assert.doesNotMatch(reply, /nothing was changed/);
  const { call } = scripted([toolUse('get_current_episode'), text('Episode 35 is live.')]);
  const result = await runAldenAnthropicTurn({ ...base, messages: [{ role: 'user', content: 'go' }], call,
    runTool: async () => ({ content: '{}', isError: false }) });
  assert.deepEqual({ response: result.response, refused: result.refused }, { response: 'Episode 35 is live.', refused: false });
});
