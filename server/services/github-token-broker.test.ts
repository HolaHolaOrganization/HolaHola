import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { GithubAppGrant } from '@shared/schema';
import {
  AGENT_TOKEN_PERMISSIONS,
  GRANT_TRANSITIONS,
  HOLAHOLA_OWNER_ACCOUNT_ID,
  HOLAHOLA_REPOSITORY_ID,
  createAppJwt,
  loadPrivateKeyFromEnv,
  mintAgentGithubToken,
  permissionsWithinCeiling,
  validateGrantProposal,
  type GithubAccessTokenResponse,
  type GithubAppApi,
  type GithubInstallationInfo,
  type GithubTokenAuditEvent,
  type MintDependencies,
  scrubAuditMetadata,
} from './github-token-broker';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const NOW = new Date('2026-10-16T20:00:00Z');
const APP_ID = 5350010;
const INSTALLATION_ID = 777;
const TOKEN = 'ghs_' + 'x'.repeat(36);

function grant(overrides: Partial<GithubAppGrant> = {}): GithubAppGrant {
  return {
    id: 'grant-1', actor: 'luca-claude-code', appId: APP_ID, installationId: INSTALLATION_ID, state: 'active',
    proposedBy: 'david', decidedBy: 'david', decidedAt: NOW, expiresAt: new Date(NOW.getTime() + 86_400_000),
    revokedBy: null, revokedAt: null, createdAt: NOW, updatedAt: NOW, ...overrides,
  };
}

function goodToken(overrides: Partial<GithubAccessTokenResponse> = {}): GithubAccessTokenResponse {
  return {
    token: TOKEN,
    expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
    permissions: { ...AGENT_TOKEN_PERMISSIONS },
    repository_selection: 'selected',
    repositories: [{ id: HOLAHOLA_REPOSITORY_ID }],
    ...overrides,
  };
}

function harness(options: {
  grant?: GithubAppGrant | null;
  installation?: GithubInstallationInfo;
  token?: GithubAccessTokenResponse;
  key?: string | null;
  role?: string;
  githubThrows?: boolean;
} = {}) {
  const audits: GithubTokenAuditEvent[] = [];
  const mintBodies: unknown[] = [];
  const keyRequests: number[] = [];
  const installationRequests: number[] = [];
  const github: GithubAppApi = {
    async getInstallation(jwt, installationId) {
      if (options.githubThrows) throw new Error('down');
      installationRequests.push(installationId);
      assert.ok(crypto.verify('RSA-SHA256', Buffer.from(jwt.split('.').slice(0, 2).join('.')), publicKey,
        Buffer.from(jwt.split('.')[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64')), 'JWT must verify with the App key');
      return options.installation ?? { app_id: APP_ID, account: { id: HOLAHOLA_OWNER_ACCOUNT_ID, login: 'davidwmcintosh' } };
    },
    async createInstallationToken(_jwt, _installationId, body) {
      mintBodies.push(body);
      return options.token ?? goodToken();
    },
  };
  const deps: MintDependencies = {
    store: {
      async findLiveGrant() { return options.grant === undefined ? grant() : options.grant; },
      async audit(event) { audits.push(event); },
    },
    github,
    loadPrivateKey: (appId) => { keyRequests.push(appId); return options.key === undefined ? PEM : options.key; },
    instanceRole: options.role ?? 'production',
    now: () => NOW,
  };
  return { deps, audits, mintBodies, keyRequests, installationRequests };
}

// ── Success path ────────────────────────────────────────────────────────────

test('an active grant mints a downscoped token for the caller\'s own App', async () => {
  const h = harness();
  const result = await mintAgentGithubToken('luca-claude-code', h.deps);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.token, TOKEN);
  assert.equal(result.appId, APP_ID);
  assert.equal(result.repositoryId, HOLAHOLA_REPOSITORY_ID);
  assert.deepEqual(h.keyRequests, [APP_ID]);
  assert.deepEqual(h.installationRequests, [INSTALLATION_ID]);
  assert.deepEqual(h.mintBodies, [{ repository_ids: [HOLAHOLA_REPOSITORY_ID], permissions: { ...AGENT_TOKEN_PERMISSIONS } }]);
  assert.equal(h.audits.length, 1);
  assert.equal(h.audits[0].eventType, 'token_issued');
});

test('audit events never contain the token, a JWT or key material', async () => {
  const h = harness();
  await mintAgentGithubToken('luca-claude-code', h.deps);
  const serialized = JSON.stringify(h.audits);
  assert.ok(!serialized.includes(TOKEN));
  assert.ok(!/eyJ[\w-]+\./.test(serialized));
  assert.ok(!serialized.includes('PRIVATE KEY'));
  const scrubbed = scrubAuditMetadata({ token: TOKEN, jwt: 'eyJabc.def.ghi', note: TOKEN, keyId: 'k', ok: 'fine', pem: '-----BEGIN PRIVATE KEY-----' });
  assert.deepEqual(scrubbed, { ok: 'fine' });
});

test('the permission ceiling never includes workflows, administration, secrets or environments', () => {
  for (const forbidden of ['workflows', 'administration', 'secrets', 'environments', 'actions']) {
    assert.ok(!(forbidden in AGENT_TOKEN_PERMISSIONS), forbidden);
  }
  assert.deepEqual({ ...AGENT_TOKEN_PERMISSIONS }, { contents: 'write', pull_requests: 'write', metadata: 'read', checks: 'read', statuses: 'read' });
});

// ── Denials (each must be audited and must not mint) ────────────────────────

async function expectDenied(h: ReturnType<typeof harness>, actor: string, status: number, reason: string) {
  const result = await mintAgentGithubToken(actor, h.deps);
  assert.deepEqual(result, { ok: false, status, reason });
  assert.equal(h.mintBodies.length, 0, 'no token may be requested');
  assert.equal(h.audits.at(-1)?.eventType, 'token_denied');
  assert.equal(h.audits.at(-1)?.reason, reason);
}

test('no grant at all is denied', async () => {
  await expectDenied(harness({ grant: null }), 'luca-claude-code', 403, 'no_active_grant');
});

test('a pending, disabled, rejected or revoked grant is denied', async () => {
  for (const state of ['pending', 'disabled', 'rejected', 'revoked']) {
    await expectDenied(harness({ grant: grant({ state }) }), 'luca-claude-code', 403, 'no_active_grant');
  }
});

test('an expired active grant is denied', async () => {
  await expectDenied(harness({ grant: grant({ expiresAt: new Date(NOW.getTime() - 1) }) }), 'luca-claude-code', 403, 'grant_expired');
  await expectDenied(harness({ grant: grant({ expiresAt: null }) }), 'luca-claude-code', 403, 'grant_expired');
});

test('another actor\'s grant can never be used', async () => {
  // The store is asked for the caller's grant; a mismatched row is refused anyway.
  await expectDenied(harness({ grant: grant({ actor: 'luca-replit' }) }), 'luca-claude-code', 403, 'no_active_grant');
});

test('people, Daniela and the system actor are not eligible', async () => {
  for (const actor of ['david', 'daniela', 'coordination-system', 'someone-else']) {
    await expectDenied(harness(), actor, 403, 'actor_not_eligible');
  }
});

test('a non-production instance never mints', async () => {
  await expectDenied(harness({ role: 'dev' }), 'luca-claude-code', 503, 'not_production_instance');
});

test('a missing App key is reported as unavailable, not as success', async () => {
  await expectDenied(harness({ key: null }), 'luca-claude-code', 503, 'app_key_unavailable');
  await expectDenied(harness({ key: '-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----' }), 'luca-claude-code', 503, 'app_key_unavailable');
});

test('an installation belonging to another App or account is refused', async () => {
  await expectDenied(harness({ installation: { app_id: 999, account: { id: HOLAHOLA_OWNER_ACCOUNT_ID } } }), 'luca-claude-code', 403, 'installation_mismatch');
  await expectDenied(harness({ installation: { app_id: APP_ID, account: { id: 1 } } }), 'luca-claude-code', 403, 'installation_mismatch');
  await expectDenied(harness({ installation: { app_id: APP_ID, account: null } }), 'luca-claude-code', 403, 'installation_mismatch');
});

test('GitHub being unreachable fails closed', async () => {
  await expectDenied(harness({ githubThrows: true }), 'luca-claude-code', 503, 'github_unavailable');
});

// ── Upstream installation gained more than the grant allows ────────────────

async function expectScopeRejected(token: GithubAccessTokenResponse) {
  const h = harness({ token });
  const result = await mintAgentGithubToken('luca-claude-code', h.deps);
  assert.deepEqual(result, { ok: false, status: 403, reason: 'token_scope_exceeded' });
  assert.ok(!JSON.stringify(result).includes(TOKEN), 'the over-scoped token is never returned');
  assert.ok(!JSON.stringify(h.audits).includes(TOKEN));
}

test('a token carrying extra or elevated permissions is discarded', async () => {
  await expectScopeRejected(goodToken({ permissions: { ...AGENT_TOKEN_PERMISSIONS, workflows: 'write' } }));
  await expectScopeRejected(goodToken({ permissions: { ...AGENT_TOKEN_PERMISSIONS, administration: 'read' } }));
  await expectScopeRejected(goodToken({ permissions: { ...AGENT_TOKEN_PERMISSIONS, checks: 'write' } }));
  await expectScopeRejected(goodToken({ permissions: { ...AGENT_TOKEN_PERMISSIONS, contents: 'admin' } }));
  await expectScopeRejected(goodToken({ permissions: undefined }));
});

test('a token covering other or additional repositories is discarded', async () => {
  await expectScopeRejected(goodToken({ repositories: [{ id: HOLAHOLA_REPOSITORY_ID }, { id: 42 }] }));
  await expectScopeRejected(goodToken({ repositories: [{ id: 42 }] }));
  await expectScopeRejected(goodToken({ repositories: [] }));
  await expectScopeRejected(goodToken({ repositories: undefined, repository_selection: 'all' }));
});

test('a token living longer than an hour, or with no expiry, is discarded', async () => {
  await expectScopeRejected(goodToken({ expires_at: new Date(NOW.getTime() + 3 * 3_600_000).toISOString() }));
  await expectScopeRejected(goodToken({ expires_at: 'never' }));
  await expectScopeRejected(goodToken({ token: '' }));
});

test('permissionsWithinCeiling accepts a downscoped subset only', () => {
  assert.equal(permissionsWithinCeiling({ contents: 'read', metadata: 'read' }), true);
  assert.equal(permissionsWithinCeiling({ contents: 'write' }), true);
  assert.equal(permissionsWithinCeiling({ statuses: 'write' }), false);
  assert.equal(permissionsWithinCeiling({ issues: 'read' }), false);
  assert.equal(permissionsWithinCeiling({ contents: 'superuser' }), false);
  assert.equal(permissionsWithinCeiling(undefined), false);
});

// ── JWT, key loading, grant lifecycle and proposals ─────────────────────────

test('the App JWT is RS256, issued by the App, back-dated and short-lived', () => {
  const jwt = createAppJwt(APP_ID, PEM, NOW);
  const [header, payload] = jwt.split('.').slice(0, 2).map((part) => JSON.parse(Buffer.from(part, 'base64url').toString()));
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
  assert.equal(payload.iss, String(APP_ID));
  assert.equal(payload.iat, Math.floor(NOW.getTime() / 1000) - 60);
  assert.ok(payload.exp - payload.iat <= 600);
});

test('keys load per App ID from PEM or base64 PEM, and nothing else', () => {
  assert.equal(loadPrivateKeyFromEnv(APP_ID, { [`GITHUB_AGENT_APP_PRIVATE_KEY_${APP_ID}`]: PEM }), PEM.trim());
  assert.equal(loadPrivateKeyFromEnv(APP_ID, { [`GITHUB_AGENT_APP_PRIVATE_KEY_${APP_ID}`]: Buffer.from(PEM).toString('base64') }), PEM);
  assert.equal(loadPrivateKeyFromEnv(APP_ID, { GITHUB_AGENT_APP_PRIVATE_KEY_1: PEM }), null);
  assert.equal(loadPrivateKeyFromEnv(APP_ID, { [`GITHUB_AGENT_APP_PRIVATE_KEY_${APP_ID}`]: 'garbage' }), null);
  assert.equal(loadPrivateKeyFromEnv(APP_ID, {}), null);
});

test('grant transitions: only founder decisions, no skipping, revoke is terminal', () => {
  assert.deepEqual(GRANT_TRANSITIONS.approve, { from: ['pending'], to: 'active' });
  assert.deepEqual(GRANT_TRANSITIONS.enable, { from: ['disabled'], to: 'active' });
  assert.ok(!GRANT_TRANSITIONS.revoke.from.includes('revoked'));
  for (const [, t] of Object.entries(GRANT_TRANSITIONS)) {
    assert.ok(!t.from.includes('revoked') && !t.from.includes('rejected'), 'terminal states never transition');
  }
});

test('grant proposals accept only eligible agents and positive integer IDs', () => {
  assert.deepEqual(validateGrantProposal({ actor: 'luca-claude-code', appId: '5350010', installationId: 9 }),
    { ok: true, proposal: { actor: 'luca-claude-code', appId: 5350010, installationId: 9 } });
  for (const bad of [
    { actor: 'david', appId: 1, installationId: 1 },
    { actor: 'luca-claude-code', appId: 0, installationId: 1 },
    { actor: 'luca-claude-code', appId: 1, installationId: -5 },
    { actor: 'luca-claude-code', appId: 1.5, installationId: 1 },
    {},
  ]) {
    assert.equal(validateGrantProposal(bad).ok, false, JSON.stringify(bad));
  }
});

// ── Route wiring (static) ───────────────────────────────────────────────────

const ROUTES = readFileSync(new URL('../routes/github-token-broker-routes.ts', import.meta.url), 'utf8');

test('the mint route takes the actor from the credential and reads no request body', () => {
  const mint = ROUTES.slice(ROUTES.indexOf("'/api/coordination/github-token'"));
  assert.match(mint, /const actor = req\.coordinationActor;/);
  assert.doesNotMatch(mint, /req\.body/);
  assert.doesNotMatch(mint, /req\.query/);
});

test('grant decisions require the founder session and CSRF; proposals cannot activate', () => {
  const decide = ROUTES.slice(ROUTES.indexOf("'/api/coordination/github-grants/admin/:id/:decision'"), ROUTES.indexOf("'/api/coordination/github-token'"));
  assert.match(decide, /\.\.\.founderSession/);
  assert.match(decide, /csrfAndSameOrigin\(req\)/);
  const propose = ROUTES.slice(ROUTES.indexOf("app.post('/api/coordination/github-grants',"), ROUTES.indexOf("app.get('/api/coordination/github-grants/admin'"));
  assert.match(propose, /githubTokenBrokerStore\.propose\(/);
  assert.doesNotMatch(propose, /decide\(/);
});
