import assert from 'node:assert/strict';
import test from 'node:test';
import { COORDINATION_ACTOR_IDS } from '@shared/schema';
import {
  COORDINATION_LEGACY_CAPABILITIES_BY_ACTOR,
  requireFounderOrCoordinationCapability,
  resolveCoordinationActor,
  resolveCoordinationCapability,
} from './coordination-auth';

const token = (label: string) => `${label}-`.repeat(8);
const environment = {
  COORDINATION_LUCA_HOLAHOLA_TOKEN: token('hola'),
  COORDINATION_LUCA_REPLIT_TOKEN: token('replit'),
  COORDINATION_LUCA_CLAUDE_CODE_TOKEN: token('claude'),
  COORDINATION_LUCA_GEMINI_TOKEN: token('gemini'),
  COORDINATION_LUCA_ANTIGRAVITY_TOKEN: token('antigravity'),
  COORDINATION_ALDEN_TOKEN: token('alden'),
  COORDINATION_LUCA_CURSOR_TOKEN: token('cursor'),
  COORDINATION_LUCA_OPENAI_AGENTS_TOKEN: token('openai-agents'),
  COORDINATION_LUCA_CODEX_TOKEN: token('codex'),
  COORDINATION_DANIELA_TOKEN: token('daniela'),
  COORDINATION_DAVID_TOKEN: token('david'),
};
const lucaActors = [
  'luca-replit', 'luca-claude-code', 'luca-gemini', 'luca-antigravity', 'luca-holahola',
  'luca-cursor', 'luca-openai-agents', 'luca-codex',
] as const;
const tokenByLucaActor = {
  'luca-replit': environment.COORDINATION_LUCA_REPLIT_TOKEN,
  'luca-claude-code': environment.COORDINATION_LUCA_CLAUDE_CODE_TOKEN,
  'luca-gemini': environment.COORDINATION_LUCA_GEMINI_TOKEN,
  'luca-antigravity': environment.COORDINATION_LUCA_ANTIGRAVITY_TOKEN,
  'luca-holahola': environment.COORDINATION_LUCA_HOLAHOLA_TOKEN,
  'luca-cursor': environment.COORDINATION_LUCA_CURSOR_TOKEN,
  'luca-openai-agents': environment.COORDINATION_LUCA_OPENAI_AGENTS_TOKEN,
  'luca-codex': environment.COORDINATION_LUCA_CODEX_TOKEN,
} as const;

test('every enumerated fixed Luca credential receives observation:read', async () => {
  for (const actor of lucaActors) {
    assert.ok(COORDINATION_LEGACY_CAPABILITIES_BY_ACTOR[actor].includes('observation:read'));
    const result = await resolveCoordinationCapability(
      tokenByLucaActor[actor],
      'observation:read',
      lucaActors,
      undefined,
      environment,
    );
    assert.equal(result.ok, true, `${actor} should resolve`);
    if (result.ok) assert.equal(result.actor, actor);
  }
});

test('fixed non-Luca actors cannot read Luca observation', async () => {
  for (const actor of ['alden', 'daniela', 'david'] as const) {
    assert.equal(COORDINATION_LEGACY_CAPABILITIES_BY_ACTOR[actor].includes('observation:read'), false);
    const result = await resolveCoordinationCapability(
      environment[`COORDINATION_${actor.toUpperCase()}_TOKEN` as keyof typeof environment],
      'observation:read',
      lucaActors,
      undefined,
      environment,
    );
    assert.deepEqual(result, {
      ok: false,
      status: 403,
      error: 'Coordination actor is not authorized for this endpoint',
    });
  }
});

test('actor names cannot self-authorize by using a luca prefix', () => {
  // Derived from CoordinationActorId's own canonical list (shared/schema.ts)
  // rather than a second hardcoded array: COORDINATION_LEGACY_CAPABILITIES_BY_ACTOR
  // is typed as Record<CoordinationActorId, ...>, so TypeScript already forces
  // its keys to match COORDINATION_ACTOR_IDS exactly. A hardcoded expected list
  // here would silently drift out of sync every time a new actor is onboarded
  // (as happened with 'luca-antigravity'), hiding a real future regression --
  // e.g. a 9th actor added to the enum but never wired into the legacy-
  // capabilities map -- behind an already-red test.
  assert.deepEqual(
    Object.keys(COORDINATION_LEGACY_CAPABILITIES_BY_ACTOR).sort(),
    [...COORDINATION_ACTOR_IDS].sort(),
  );
});

test('luca-gemini recognizes the Gemini Code token alias', () => {
  const aliasToken = token('gemini-code');
  const aliasOnly = {
    ...environment,
    COORDINATION_LUCA_GEMINI_TOKEN: undefined,
    COORDINATION_LUCA_GEMINI_CODE_TOKEN: aliasToken,
  };
  assert.deepEqual(resolveCoordinationActor(aliasToken, undefined, aliasOnly), {
    ok: true,
    actor: 'luca-gemini',
  });
});

test('matching luca-gemini legacy and Gemini Code aliases converge', () => {
  const sharedToken = token('gemini-shared');
  const matchingAliases = {
    ...environment,
    COORDINATION_LUCA_GEMINI_TOKEN: sharedToken,
    COORDINATION_LUCA_GEMINI_CODE_TOKEN: sharedToken,
  };
  assert.deepEqual(resolveCoordinationActor(sharedToken, undefined, matchingAliases), {
    ok: true,
    actor: 'luca-gemini',
  });
});

test('conflicting luca-gemini token aliases fail closed', () => {
  const legacyToken = token('gemini-legacy');
  const codeToken = token('gemini-code');
  const conflictingAliases = {
    ...environment,
    COORDINATION_LUCA_GEMINI_TOKEN: legacyToken,
    COORDINATION_LUCA_GEMINI_CODE_TOKEN: codeToken,
  };
  for (const supplied of [legacyToken, codeToken]) {
    assert.deepEqual(resolveCoordinationActor(supplied, undefined, conflictingAliases), {
      ok: false,
      status: 503,
      error: 'Coordination authentication has conflicting luca-gemini token aliases',
    });
  }
});

test('Gemini Code alias preserves duplicate-token ambiguity protection', () => {
  const duplicate = token('shared-luca');
  const ambiguous = {
    ...environment,
    COORDINATION_LUCA_GEMINI_TOKEN: undefined,
    COORDINATION_LUCA_GEMINI_CODE_TOKEN: duplicate,
    COORDINATION_LUCA_REPLIT_TOKEN: duplicate,
  };
  assert.deepEqual(resolveCoordinationActor(duplicate, undefined, ambiguous), {
    ok: false,
    status: 503,
    error: 'Coordination authentication has ambiguous token bindings',
  });
});

test('alden and david hold coordination:runtime:admin; no other actor does', async () => {
  assert.ok(COORDINATION_LEGACY_CAPABILITIES_BY_ACTOR.alden.includes('coordination:runtime:admin'));
  assert.ok(COORDINATION_LEGACY_CAPABILITIES_BY_ACTOR.david.includes('coordination:runtime:admin'));

  const alden = await resolveCoordinationCapability(
    environment.COORDINATION_ALDEN_TOKEN, 'coordination:runtime:admin', undefined, undefined, environment,
  );
  assert.equal(alden.ok, true);
  if (alden.ok) assert.equal(alden.actor, 'alden');

  const david = await resolveCoordinationCapability(
    environment.COORDINATION_DAVID_TOKEN, 'coordination:runtime:admin', undefined, undefined, environment,
  );
  assert.equal(david.ok, true);
  if (david.ok) assert.equal(david.actor, 'david');

  const tokenByOtherActor = { ...tokenByLucaActor, daniela: environment.COORDINATION_DANIELA_TOKEN };
  for (const actor of [...lucaActors, 'daniela'] as const) {
    assert.equal(
      COORDINATION_LEGACY_CAPABILITIES_BY_ACTOR[actor].includes('coordination:runtime:admin'),
      false,
      `${actor} should not hold coordination:runtime:admin`,
    );
    const result = await resolveCoordinationCapability(
      tokenByOtherActor[actor], 'coordination:runtime:admin', undefined, undefined, environment,
    );
    assert.deepEqual(result, {
      ok: false,
      status: 403,
      error: 'Credential lacks required capability: coordination:runtime:admin',
    });
  }
});

test('the runtime-admin route allowlist excludes every actor except alden and david', async () => {
  const tokenByOtherActor = { ...tokenByLucaActor, daniela: environment.COORDINATION_DANIELA_TOKEN };
  for (const actor of [...lucaActors, 'daniela'] as const) {
    const result = await resolveCoordinationCapability(
      tokenByOtherActor[actor], 'coordination:runtime:admin', ['alden', 'david'], undefined, environment,
    );
    assert.deepEqual(result, {
      ok: false,
      status: 403,
      error: 'Coordination actor is not authorized for this endpoint',
    });
  }
});

test('founder fallback runs only when no coordination credential is presented', async () => {
  const previous = process.env.COORDINATION_LUCA_REPLIT_TOKEN;
  process.env.COORDINATION_LUCA_REPLIT_TOKEN = environment.COORDINATION_LUCA_REPLIT_TOKEN;
  try {
    let founderCalls = 0;
    let nextCalls = 0;
    let statusCode = 200;
    let responseBody: unknown;
    const founder = (_req: any, _res: any, next: () => void) => {
      founderCalls++;
      next();
    };
    const middleware = requireFounderOrCoordinationCapability(founder, 'observation:read', lucaActors);
    const makeResponse = () => ({
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(body: unknown) {
        responseBody = body;
        return this;
      },
    });

    await middleware(
      { headers: {}, ip: '127.0.0.1', socket: {} } as any,
      makeResponse() as any,
      () => { nextCalls++; },
    );
    assert.equal(founderCalls, 1);
    assert.equal(nextCalls, 1);

    founderCalls = 0;
    nextCalls = 0;
    statusCode = 200;
    await middleware(
      {
        headers: { 'x-coordination-token': 'invalid-presented-token-that-must-not-fall-through' },
        ip: '127.0.0.1',
        socket: {},
      } as any,
      makeResponse() as any,
      () => { nextCalls++; },
    );
    assert.equal(founderCalls, 0);
    assert.equal(nextCalls, 0);
    assert.equal(statusCode, 401);
    assert.deepEqual(responseBody, { error: 'Invalid coordination token' });
  } finally {
    if (previous === undefined) delete process.env.COORDINATION_LUCA_REPLIT_TOKEN;
    else process.env.COORDINATION_LUCA_REPLIT_TOKEN = previous;
  }
});