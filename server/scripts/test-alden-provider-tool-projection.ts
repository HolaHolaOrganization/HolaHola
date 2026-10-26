import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ALDEN_TOOLS,
  toAnthropicAldenTools,
  type AldenTool,
} from '../services/alden-functions';

const anthropicTools = toAnthropicAldenTools();

assert.equal(anthropicTools.length, ALDEN_TOOLS.length);
assert.ok(
  ALDEN_TOOLS.some((tool) => 'gemini_description' in tool),
  'fixture must include Gemini-only metadata',
);

for (const tool of anthropicTools) {
  assert.deepEqual(
    Object.keys(tool).sort(),
    ['description', 'input_schema', 'name'],
    `${tool.name} must contain only Anthropic-supported top-level keys`,
  );
  assert.equal(typeof tool.name, 'string');
  assert.equal(typeof tool.description, 'string');
  assert.equal(tool.input_schema.type, 'object');
}

const synthetic = {
  name: 'provider_projection_canary',
  description: 'Anthropic description',
  gemini_description: 'Gemini description',
  input_schema: { type: 'object', properties: {} },
  future_provider_metadata: 'must not leak',
} as AldenTool & { future_provider_metadata: string };

assert.deepEqual(toAnthropicAldenTools([synthetic]), [{
  name: 'provider_projection_canary',
  description: 'Anthropic description',
  input_schema: { type: 'object', properties: {} },
}]);

const personaSource = readFileSync(
  resolve(process.cwd(), 'server/services/alden-persona-service.ts'),
  'utf8',
);
// Every Anthropic call in a turn goes through one injected callback
// (alden-anthropic-turn.ts). Rounds and the continuation wrap ask for tools,
// and the callback attaches the projected declarations, never any other set.
assert.match(personaSource, /const anthropicTools = toAnthropicAldenTools\(\);/,
  'persona service must build the provider projection');
assert.equal(
  (personaSource.match(/tools: anthropicTools/g) ?? []).length,
  1,
  'the single Anthropic call callback must attach the projected declarations',
);
assert.match(personaSource, /\.\.\.\(withTools \? \{ tools: anthropicTools \} : \{\}\)/,
  'tools are attached exactly when the turn loop asks for them');
const turnSource = readFileSync(resolve(process.cwd(), 'server/services/alden-anthropic-turn.ts'), 'utf8');
assert.equal((turnSource.match(/withTools: true/g) ?? []).length, 2,
  'initial rounds and the continuation wrap must request the projected tools');
assert.doesNotMatch(
  personaSource,
  /tools:\s*ALDEN_TOOLS/,
  'persona service must never send canonical mixed-provider declarations to Anthropic',
);

const watchSource = readFileSync(
  resolve(process.cwd(), 'server/services/alden-watch-worker.ts'),
  'utf8',
);
assert.match(
  watchSource,
  /const anthropicTools = toAnthropicAldenTools\(\);/,
  'watch worker must share the provider projection',
);

const consultSkill = readFileSync(
  resolve(process.cwd(), '.agents/skills/consult-alden/SKILL.md'),
  'utf8',
);
assert.match(
  consultSkill,
  /x-coordination-token: \$COORDINATION_LUCA_REPLIT_TOKEN/,
  'consult skill must document Luca Replit actor-scoped authentication',
);
assert.doesNotMatch(
  consultSkill,
  /x-agent-token|\bREPLIT_AGENT_TOKEN\b/,
  'consult skill must not regress to the removed legacy agent credential',
);

console.log('✓ Alden provider tool projection guard passed');