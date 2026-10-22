/** Shared-spec authentication accepts a runtime's own broker credential (no database). */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Request } from 'express';

// server/db.ts requires a URL at import time; nothing below opens a connection.
process.env.NEON_SHARED_DATABASE_URL ??= 'postgresql://unused:unused@127.0.0.1:9/unused';
const { HolaHolaSharedSpecAuthenticator } = await import('../adapters/hola-hola-shared-spec-bootstrap');

type Resolver = ConstructorParameters<typeof HolaHolaSharedSpecAuthenticator>[1];
const request = (headers: Record<string, string>) => ({ headers, ip: '203.0.113.7' }) as unknown as Request;

function recorder(result: Awaited<ReturnType<NonNullable<Resolver>>>) {
  const calls: unknown[][] = [];
  const resolve = (async (...args: unknown[]) => { calls.push(args); return result; }) as NonNullable<Resolver>;
  return { calls, resolve };
}

describe('HolaHolaSharedSpecAuthenticator', () => {
  test('a legacy actor token still authenticates, without consulting the broker', async () => {
    const r = recorder({ ok: false, status: 401, error: 'unused' });
    const auth = new HolaHolaSharedSpecAuthenticator({ COORDINATION_LUCA_CLAUDE_CODE_TOKEN: 'legacy-lcc-token-0123456789abcdef0123' }, r.resolve);
    assert.deepEqual(await auth.authenticate(request({ 'x-shared-spec-token': 'legacy-lcc-token-0123456789abcdef0123' })), { actorId: 'luca-claude-code', capabilities: undefined });
    assert.equal(r.calls.length, 0);
  });

  test('a broker credential with coordination:write authenticates as its own actor', async () => {
    const r = recorder({ ok: true, actor: 'luca-replit', authType: 'broker' });
    const auth = new HolaHolaSharedSpecAuthenticator({}, r.resolve);
    assert.deepEqual(await auth.authenticate(request({ 'x-shared-spec-token': 'broker-access-token' })), { actorId: 'luca-replit', capabilities: ['policy_admin'] });
    assert.equal(r.calls.length, 1);
    const [token, capability, allowlist, ip] = r.calls[0];
    assert.deepEqual([token, capability, allowlist, ip], ['broker-access-token', 'coordination:write', undefined, '203.0.113.7']);
  });

  test('the x-coordination-token header carries a broker credential too', async () => {
    const r = recorder({ ok: true, actor: 'luca-claude-code', authType: 'broker' });
    const auth = new HolaHolaSharedSpecAuthenticator({}, r.resolve);
    assert.equal((await auth.authenticate(request({ 'x-coordination-token': 'broker-access-token' })))?.actorId, 'luca-claude-code');
  });

  test('a broker credential without the capability, or an unknown token, is refused', async () => {
    for (const result of [
      { ok: false as const, status: 403, error: 'Credential lacks required capability: coordination:write' },
      { ok: false as const, status: 401, error: 'Coordination token required' },
      { ok: false as const, status: 503, error: 'Coordination credential broker is unavailable' },
    ]) {
      const auth = new HolaHolaSharedSpecAuthenticator({}, recorder(result).resolve);
      assert.equal(await auth.authenticate(request({ 'x-shared-spec-token': 'whatever' })), undefined, result.error);
    }
  });

  test('only a broker resolution is taken from the resolver; an actor outside the coordination set is refused', async () => {
    const legacyShaped = new HolaHolaSharedSpecAuthenticator({}, recorder({ ok: true, actor: 'luca-replit', authType: 'legacy' }).resolve);
    assert.equal(await legacyShaped.authenticate(request({ 'x-shared-spec-token': 'not-a-legacy-token-here' })), undefined);
    const stranger = new HolaHolaSharedSpecAuthenticator({}, recorder({ ok: true, actor: 'mallory' as never, authType: 'broker' }).resolve);
    assert.equal(await stranger.authenticate(request({ 'x-shared-spec-token': 'broker-access-token' })), undefined);
  });

  test('no credential header authenticates nothing and asks no one', async () => {
    const r = recorder({ ok: true, actor: 'luca-replit', authType: 'broker' });
    assert.equal(await new HolaHolaSharedSpecAuthenticator({}, r.resolve).authenticate(request({})), undefined);
    assert.equal(r.calls.length, 0);
  });
});
