/**
 * Live test 2, G6: Daniela called exercise_language compare with word1/word2, the handler did
 * nothing, the tool result said "done", and she told the student it was on the board.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  compareArgsToVisualCompare,
  DANIELA_FUNCTION_REGISTRY,
  DANIELA_GL_FUNCTION_DECLARATIONS,
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

  it('never requires spoken text, which handlers treat as optional', () => {
    const declaresText = DANIELA_FUNCTION_REGISTRY.filter(e =>
      ((e.declaration.parametersJsonSchema as { required?: string[] } | undefined)?.required ?? []).includes('text'));
    assert.ok(declaresText.length > 0, 'the premise: some tools declare text as required');
    for (const entry of declaresText) {
      assert.ok(!missingRequiredParams(entry.declaration.name, {}).includes('text'), entry.declaration.name);
    }
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

describe('declarations match handlers', () => {
  it('every required input of a voice selector is one its handler reads', () => {
    // The dispatcher now rejects calls on these declarations, so one the handler ignores would
    // reject a call for no reason.
    const selectors = new Set<string>();
    for (const declaration of DANIELA_GL_FUNCTION_DECLARATIONS as any[]) {
      const properties = declaration.parametersJsonSchema?.properties ?? {};
      if (!properties.params_json) continue;
      for (const property of Object.values<any>(properties)) {
        if (Array.isArray(property?.enum)) for (const value of property.enum) selectors.add(value);
      }
    }
    const handlers = readFileSync(new URL('../services/native-fc-handlers.ts', import.meta.url), 'utf8');
    const unread: string[] = [];
    let checked = 0;
    for (const entry of DANIELA_FUNCTION_REGISTRY) {
      if (!selectors.has(entry.declaration.name)) continue;
      const at = handlers.indexOf(`case '${entry.legacyType}':`);
      if (at < 0) continue;
      const rest = handlers.slice(at + 5);
      const next = rest.search(/\n\s*case '[A-Z0-9_]+': \{/);
      const block = next < 0 ? rest : rest.slice(0, next);
      const required = (entry.declaration.parametersJsonSchema as { required?: string[] } | undefined)?.required ?? [];
      checked++;
      for (const key of required) {
        if (key !== 'text' && key !== 'spoken_text' && !new RegExp(`\\.${key}\\b`).test(block)) unread.push(`${entry.declaration.name}.${key}`);
      }
    }
    assert.ok(checked > 80, `checked ${checked} selectors`);
    assert.deepEqual(unread, []);
  });
});
