// Credential renewal and GitHub token minting are limited per authenticated
// runtime or actor, not per IP (founder, 2026-11-03): several hats share one
// machine's IP, and a single 10/hour IP bucket let one hat's PR work starve
// every hat's renewals. The 429 handler in rate-limiter.ts writes to the shared
// database, so behaviour is exercised with the real key functions and a local
// no-op handler, and the route wiring is checked from source.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { authenticatedActorKey, authenticatedRuntimeKey } from '../middleware/rate-limiter';

test('the keys name the authenticated runtime or actor, and fall back to the IP only without one', () => {
  const req = (fields: Record<string, unknown>) => ({ ip: '10.0.0.7', ...fields }) as any;
  assert.equal(authenticatedRuntimeKey(req({ coordinationCredential: { actor: 'luca-codex', runtimeId: 'luca-codex-littlenemo' } })), 'runtime:luca-codex:luca-codex-littlenemo');
  assert.equal(authenticatedRuntimeKey(req({ coordinationActor: 'luca-replit' })), 'actor:luca-replit');
  assert.equal(authenticatedRuntimeKey(req({})), 'ip:10.0.0.7');
  assert.equal(authenticatedActorKey(req({ coordinationActor: 'luca-claude-code' })), 'actor:luca-claude-code');
  assert.equal(authenticatedActorKey(req({ coordinationCredential: { actor: 'luca-antigravity' } })), 'actor:luca-antigravity');
  assert.equal(authenticatedActorKey(req({})), 'ip:10.0.0.7');
});

test('two runtimes on one machine each get their own renewal budget', async () => {
  const app = express();
  // Stand-in for requireCoordinationAuth: the runtime named in a header.
  app.use((req, _res, next) => {
    const [actor, runtimeId] = String(req.headers['x-test-runtime'] ?? '').split('/');
    (req as any).coordinationCredential = { actor, runtimeId };
    next();
  });
  app.post('/renew', rateLimit({
    windowMs: 60_000, max: 2, keyGenerator: authenticatedRuntimeKey, validate: { keyGeneratorIpFallback: false },
    handler: (_req, res) => { res.status(429).end(); },
  }), (_req, res) => { res.status(200).end(); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/renew`;
  const renew = async (runtime: string) => (await fetch(url, { method: 'POST', headers: { 'x-test-runtime': runtime } })).status;
  try {
    // All from 127.0.0.1, as hats on one machine would be.
    assert.deepEqual([await renew('luca-codex/a'), await renew('luca-codex/a'), await renew('luca-codex/a')], [200, 200, 429]);
    assert.deepEqual([await renew('luca-claude-code/b'), await renew('luca-claude-code/b')], [200, 200], 'another runtime is unaffected');
    assert.equal(await renew('luca-antigravity/c'), 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('renewal and token minting use their own limiters, keyed after authentication', () => {
  const limiter = readFileSync(new URL('../middleware/rate-limiter.ts', import.meta.url), 'utf8');
  const credentialRoutes = readFileSync(new URL('../routes/coordination-credential-routes.ts', import.meta.url), 'utf8');
  const githubRoutes = readFileSync(new URL('../routes/github-token-broker-routes.ts', import.meta.url), 'utf8');
  assert.match(credentialRoutes, /app\.post\('\/api\/coordination\/credentials\/renew', credentialRenewIpLimiter, requireCoordinationAuth, credentialRenewLimiter, /);
  assert.match(githubRoutes, /app\.post\('\/api\/coordination\/github-token', githubTokenIpLimiter, agentGate, githubTokenLimiter, /);
  // Each is its own instance (its own store), and the per-identity ones use the identity keys.
  for (const name of ['credentialRenewIpLimiter', 'credentialRenewLimiter', 'githubTokenIpLimiter', 'githubTokenLimiter']) {
    assert.match(limiter, new RegExp(`export const ${name} = rateLimit\\(`), name);
  }
  assert.match(limiter, /export const credentialRenewLimiter = rateLimit\(\{[^}]*keyGenerator: authenticatedRuntimeKey/);
  assert.match(limiter, /export const githubTokenLimiter = rateLimit\(\{[^}]*keyGenerator: authenticatedActorKey/);
  // Routes that run before authentication keep the strict per-IP limiter.
  assert.match(credentialRoutes, /'\/api\/coordination\/credentials\/exchange', strictLimiter/);
});
