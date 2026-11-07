/**
 * Live test 2, G6: Daniela called exercise_language compare with word1/word2, the handler did
 * nothing, the tool result said "done", and she told the student it was on the board.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  compareArgsToVisualCompare,
  missingRequiredParams,
} from '../services/daniela-function-registry';

// Loading the handler module requires this to be set. These tests never open a connection.
process.env.NEON_SHARED_DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
const { NativeFunctionCallHandler } = await import('../services/native-fc-handlers');

describe('missingRequiredParams', () => {
  it('names what the observed compare call left out', () => {
    assert.deepEqual(missingRequiredParams('compare', { word1: 'ser', word2: 'estar' }), ['item1', 'item2']);
  });

  it('accepts a complete call', () => {
    assert.deepEqual(missingRequiredParams('compare', { item1: 'ser', item2: 'estar' }), []);
  });

  it('treats empty values as missing', () => {
    assert.deepEqual(missingRequiredParams('compare', { item1: '', item2: null }), ['item1', 'item2']);
  });

  it('leaves selectors alone whose declarations have not been checked', () => {
    // Her guidance for tone teaches word and tones while it declares syllable and toneNumber, and
    // flag_for_agent's handler defaults its "required" urgency. Rejecting these would be a regression.
    assert.deepEqual(missingRequiredParams('tone', { word: 'ma', tones: [1, 2, 3, 4] }), []);
    assert.deepEqual(missingRequiredParams('flag_for_agent', { topic: 'a', description: 'b' }), []);
  });

  it('passes an unknown tool through for the known-tool check to handle', () => {
    assert.deepEqual(missingRequiredParams('no_such_tool', {}), []);
  });
});

describe('compare selector', () => {
  it('maps onto the comparison card inputs', () => {
    assert.deepEqual(
      compareArgsToVisualCompare({ item1: 'ser', item2: 'estar', item1_meaning: 'identity', item2_example: 'Estoy aquí', text: 'Mira' }),
      { text: 'Mira', concept_a: 'ser', concept_b: 'estar', a_meaning: 'identity', b_meaning: undefined, a_example: undefined, b_example: 'Estoy aquí' },
    );
  });

  it('routes to VISUAL_COMPARE, the item the whiteboard renders', () => {
    const handlers = readFileSync(new URL('../services/native-fc-handlers.ts', import.meta.url), 'utf8');
    const start = handlers.indexOf("case 'COMPARE':");
    assert.ok(start > 0);
    const block = handlers.slice(start, handlers.indexOf('case ', start + 10));
    assert.match(block, /legacyType: 'VISUAL_COMPARE'/);
    assert.doesNotMatch(block, /type: 'compare'/);
  });

  it('tells her the parameter names in the guidance she reads', () => {
    const registry = readFileSync(new URL('../services/daniela-function-registry.ts', import.meta.url), 'utf8');
    assert.match(registry, /type: "compare" → [^\n]*params_json: \{"item1":"ser","item2":"estar"/);
  });
});

describe('dispatcher', () => {
  const dispatch = async (session: any, params: string, handled: unknown[]) => {
    const handler = { handle: async (_id: string, _s: unknown, fn: unknown) => { handled.push(fn); } };
    await (NativeFunctionCallHandler.prototype as any).dispatchSubTool.call(
      handler, 'session-1', session, 'compare', params, 'exercise_language', 'type');
    return session._lastDispatch;
  };

  it('does not run a selector missing its inputs, and says what happened', async () => {
    const handled: unknown[] = [];
    const result = await dispatch({}, '{"word1":"ser","word2":"estar"}', handled);
    assert.equal(handled.length, 0);
    assert.equal(result.status, 'error');
    assert.equal(result.error, 'Nothing was shown. "compare" needs item1 and item2 in params_json, and received word1, word2.');
    assert.equal(result.hint, '{"item1":"...","item2":"..."}');
  });

  it('aborts on a second failure in a row, so she cannot loop', async () => {
    const session = {};
    await dispatch(session, '{"word1":"ser"}', []);
    assert.equal((await dispatch(session, '{"word1":"ser"}', [])).status, 'abort');
  });

  it('runs a complete call and clears earlier failures', async () => {
    const session = {};
    await dispatch(session, '{"word1":"ser"}', []);
    const handled: any[] = [];
    assert.equal((await dispatch(session, '{"item1":"ser","item2":"estar"}', handled)).status, 'success');
    assert.deepEqual(handled[0].args, { item1: 'ser', item2: 'estar' });
    assert.equal((await dispatch(session, '{"word1":"ser"}', [])).status, 'error', 'the count started again');
  });
});
