import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isValidGuardianToken } from './guardian-token';

const configured = 'synthetic-guardian-token-value';

test('unset, empty or whitespace configuration rejects every request, including a header-less one', () => {
  for (const value of [undefined, '', '   ', '\t\n']) {
    assert.equal(isValidGuardianToken(undefined, value), false, `configured=${JSON.stringify(value)}, no header`);
    assert.equal(isValidGuardianToken('', value), false);
    assert.equal(isValidGuardianToken(value, value), false, 'matching a blank configuration never authenticates');
    assert.equal(isValidGuardianToken('anything', value), false);
  }
});

test('missing, empty, wrong, prefixed and non-string headers are rejected', () => {
  for (const header of [undefined, null, '', 'wrong', `${configured}x`, configured.slice(0, -1), ` ${configured}`,
    [configured], 42, { value: configured }]) {
    assert.equal(isValidGuardianToken(header, configured), false, JSON.stringify(header));
  }
});

test('only the exact configured token is accepted, and a rotated value replaces the old one', () => {
  assert.equal(isValidGuardianToken(configured, configured), true);
  const rotated = 'synthetic-guardian-token-rotated';
  assert.equal(isValidGuardianToken(rotated, rotated), true);
  assert.equal(isValidGuardianToken(configured, rotated), false);
});

test('reads the environment at call time when no configured value is passed', () => {
  const saved = process.env.GUARDIAN_TOKEN;
  try {
    delete process.env.GUARDIAN_TOKEN;
    assert.equal(isValidGuardianToken(undefined), false);
    process.env.GUARDIAN_TOKEN = configured;
    assert.equal(isValidGuardianToken(configured), true);
    assert.equal(isValidGuardianToken(undefined), false);
  } finally {
    if (saved === undefined) delete process.env.GUARDIAN_TOKEN;
    else process.env.GUARDIAN_TOKEN = saved;
  }
});

test('every guardian route in routes.ts uses the shared fail-closed check', () => {
  const routes = readFileSync(new URL('../routes.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(routes, /token\s*!==\s*GUARDIAN_TOKEN/, 'no inline fail-open comparison may remain');
  assert.doesNotMatch(routes, /\{\s*GUARDIAN_TOKEN\s*\}\s*=\s*await import/, 'routes must not read the module-level constant');
  const guarded = routes.match(/isValidGuardianToken\(req\.headers\['x-guardian-token'\]\)/g) ?? [];
  assert.equal(guarded.length, 8, 'all eight guardian-protected routes use the shared check');
});
