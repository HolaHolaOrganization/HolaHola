import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COORDINATION_ACTOR_IDS, type CoordinationActorId } from '@shared/schema';

// Guards the one actor-completeness registry in the coordination system that
// TypeScript does NOT already enforce exhaustively.
//
// COORDINATION_TOKEN_ENV_BY_ACTOR and COORDINATION_LEGACY_CAPABILITIES_BY_ACTOR
// in server/middleware/coordination-auth.ts are both typed as
// Record<CoordinationActorId, ...> (or Record<Exclude<...>, ...>), so `npm run
// typecheck` already fails hard if either is missing an actor -- no separate
// runtime check is needed for those two.
//
// ALL_COORDINATION_ACTORS in server/services/operations-catalog.ts has no such
// guarantee: it's a plain `readonly CoordinationActorId[]` array literal used
// as the actorScope for "every actor" operations (e.g. production readiness,
// coordination feed). Forgetting an actor there is silent -- the array still
// type-checks, the app still boots, and the omitted actor just quietly loses
// access to those operations. This was caught for real: 'luca-gemini' was
// missing from this array before this self-check and its accompanying fix
// were added (see docs/coordination-new-actor-onboarding.md).
//
// This script does NOT import operations-catalog.ts directly -- that module
// eagerly imports semantic-memory-service, pulling in embedding/DB machinery
// this check has no business depending on. It statically parses the source
// text instead, the same convention used by the validation-suite CI-parity
// guard elsewhere in this repo.

const root = resolve(import.meta.dirname, '../..');
const CATALOG_PATH =
  process.env.ACTOR_COMPLETENESS_CATALOG_PATH_OVERRIDE
    ?? resolve(root, 'server/services/operations-catalog.ts');

const ARRAY_DECLARATION_START = 'const ALL_COORDINATION_ACTORS: readonly CoordinationActorId[] = [';

function extractAllCoordinationActors(sourcePath: string): string[] {
  const source = readFileSync(sourcePath, 'utf8');
  const startIndex = source.indexOf(ARRAY_DECLARATION_START);
  assert.ok(
    startIndex >= 0,
    `Could not find "${ARRAY_DECLARATION_START}" in ${sourcePath}. ` +
      'Has ALL_COORDINATION_ACTORS been renamed or restructured? Update this self-check to match.',
  );

  const bodyStart = startIndex + ARRAY_DECLARATION_START.length;
  const closeIndex = source.indexOf('];', bodyStart);
  assert.ok(closeIndex >= 0, `Could not find the closing "];" for ALL_COORDINATION_ACTORS in ${sourcePath}`);

  const body = source.slice(bodyStart, closeIndex);
  const matches = [...body.matchAll(/'([a-z0-9-]+)'/g)].map((match) => match[1]);
  assert.ok(matches.length > 0, `ALL_COORDINATION_ACTORS in ${sourcePath} parsed to zero entries -- parsing bug?`);
  return matches;
}

function extractOperationBlock(source: string, operationId: string): string {
  const start = source.indexOf(`id: '${operationId}'`);
  assert.ok(start >= 0, `Could not find operation ${operationId} in operations catalog`);
  const close = source.indexOf('\n  },', start);
  assert.ok(close >= 0, `Could not find the end of operation ${operationId} in operations catalog`);
  return source.slice(start, close);
}

function extractActorScope(block: string, operationId: string): string[] {
  const marker = 'actorScope: [';
  const start = block.indexOf(marker);
  assert.ok(start >= 0, `Could not find a literal actorScope for ${operationId}`);
  const bodyStart = start + marker.length;
  const close = block.indexOf(']', bodyStart);
  assert.ok(close >= 0, `Could not find the end of actorScope for ${operationId}`);
  return [...block.slice(bodyStart, close).matchAll(/'([a-z0-9-]+)'/g)].map((match) => match[1]);
}

function main() {
  const catalogSource = readFileSync(CATALOG_PATH, 'utf8');
  const declared = extractAllCoordinationActors(CATALOG_PATH);
  const declaredSet = new Set(declared);
  const canonicalSet = new Set<string>(COORDINATION_ACTOR_IDS);

  const missing = COORDINATION_ACTOR_IDS.filter((actor: CoordinationActorId) => !declaredSet.has(actor));
  const unknown = declared.filter((actor) => !canonicalSet.has(actor));

  assert.deepStrictEqual(
    missing,
    [],
    `ALL_COORDINATION_ACTORS in ${CATALOG_PATH} is missing actor(s): ${missing.join(', ')}. ` +
      'Every actor in COORDINATION_ACTOR_IDS (shared/schema.ts) must appear in ALL_COORDINATION_ACTORS, ' +
      'or that actor silently loses access to every "all actors" operation (e.g. production readiness, ' +
      'coordination feed). See docs/coordination-new-actor-onboarding.md.',
  );

  assert.deepStrictEqual(
    unknown,
    [],
    `ALL_COORDINATION_ACTORS in ${CATALOG_PATH} contains unknown value(s) not in COORDINATION_ACTOR_IDS: ` +
      `${unknown.join(', ')}. Likely a typo introduced when hand-editing the array.`,
  );

  assert.strictEqual(
    declared.length,
    COORDINATION_ACTOR_IDS.length,
    `ALL_COORDINATION_ACTORS in ${CATALOG_PATH} has ${declared.length} entries but COORDINATION_ACTOR_IDS has ` +
      `${COORDINATION_ACTOR_IDS.length} -- likely a duplicate entry.`,
  );

  // These operations are intentionally available to ordinary runtime Luca
  // hats which can use the shared repository/coordination protocol. Keep
  // cursor and OpenAI Agents peers aligned with the Replit and Claude Code
  // executor scope without widening exceptional surfaces such as the
  // Replit-only canonical capture endpoint or admin-only tools.
  const ordinaryLucaExecutorOperations = [
    'system.verify-health',
    'production.uptime-monitor',
    'source.status',
    'source.synchronize',
    'source.candidate-drift',
    'learning.actfl-audit',
    'learning.curriculum-audit',
    'learning.lesson-audit',
    'learning.textbook-audit',
    'capture.episode-integrity',
  ];
  for (const operationId of ordinaryLucaExecutorOperations) {
    const scope = extractActorScope(extractOperationBlock(catalogSource, operationId), operationId);
    for (const actor of ['luca-cursor', 'luca-openai-agents', 'luca-codex']) {
      assert.ok(
        scope.includes(actor),
        `Operation ${operationId} is missing ${actor} from its scoped Luca executor access`,
      );
    }
  }
  const captureHealthScope = extractActorScope(
    extractOperationBlock(catalogSource, 'capture.health'),
    'capture.health',
  );
  assert.equal(
    captureHealthScope.includes('luca-cursor')
      || captureHealthScope.includes('luca-openai-agents')
      || captureHealthScope.includes('luca-codex'),
    false,
    'Canonical capture health is intentionally narrower than generic Luca executor operations.',
  );

  console.log(
    `PASS: ALL_COORDINATION_ACTORS in ${CATALOG_PATH} exactly matches COORDINATION_ACTOR_IDS ` +
      `(${declared.length} actors).`,
  );
}

main();
