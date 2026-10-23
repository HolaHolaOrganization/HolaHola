import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { GithubAppGrant } from '@shared/schema';
import {
  AGENT_TOKEN_PERMISSIONS,
  GRANT_TRANSITIONS,
  HOLAHOLA_INSTALLATION_ACCOUNT_IDS,
  HOLAHOLA_ORGANIZATION_ACCOUNT_ID,
  HOLAHOLA_OWNER_ACCOUNT_ID,
  HOLAHOLA_REPOSITORY_ID,
  buildAuditMetadata,
  createAppJwt,
  loadPrivateKeyFromEnv,
  mintAgentGithubToken,
  permissionsWithinCeiling,
  tokenExpiryAcceptable,
  validateGrantProposal,
  type GithubAccessTokenResponse,
  type GithubAppApi,
  type GithubInstallationInfo,
  type GithubTokenAuditEvent,
  type MintDependencies,
  type MintPrincipal,
} from './github-token-broker';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const NOW = new Date('2026-10-16T20:00:00Z');
const APP_ID = 5350010;
const INSTALLATION_ID = 777;
const TOKEN = 'ghs_' + 'x'.repeat(36);
const AGENT: MintPrincipal = { actor: 'luca-claude-code', authType: 'broker', runtimeId: 'lcc-littlenemo', credentialId: 'cred-1' };

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
    expires_at: new Date(NOW.getTime() + 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z'),
    permissions: { ...AGENT_TOKEN_PERMISSIONS },
    repository_selection: 'selected',
    repositories: [{ id: HOLAHOLA_REPOSITORY_ID }],
    ...overrides,
  };
}

/**
 * A fake store whose lock behaves like FOR SHARE vs an UPDATE: `decide` waits
 * until any in-flight mint has released the lock, then changes the grant.
 */
function harness(options: {
  grant?: GithubAppGrant | null;
  installation?: GithubInstallationInfo;
  token?: GithubAccessTokenResponse;
  key?: string | null;
  role?: string;
  githubThrows?: boolean;
  dbNow?: Date;
  duringCreate?: () => Promise<void>;
} = {}) {
  const audits: GithubTokenAuditEvent[] = [];
  const mintBodies: unknown[] = [];
  const revoked: string[] = [];
  const events: string[] = [];
  let current: GithubAppGrant | null = options.grant === undefined ? grant() : options.grant;
  let lockHeld = false;
  let release: () => void = () => {};
  let released = Promise.resolve();
  const github: GithubAppApi = {
    async getInstallation(jwt) {
      if (options.githubThrows) throw new Error('down');
      events.push(`getInstallation lock=${lockHeld}`);
      const [h, p, sig] = jwt.split('.');
      assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, 'base64url')), 'JWT must verify');
      return options.installation ?? { app_id: APP_ID, account: { id: HOLAHOLA_ORGANIZATION_ACCOUNT_ID, login: 'HolaHolaOrganization' } };
    },
    async createInstallationToken(_jwt, _id, body) {
      events.push(`createToken lock=${lockHeld}`);
      mintBodies.push(body);
      await options.duringCreate?.();
      return options.token ?? goodToken();
    },
    async revokeInstallationToken(token) { revoked.push(token); },
  };
  const deps: MintDependencies = {
    store: {
      async withMintLock(_actor, fn) {
        lockHeld = true;
        released = new Promise((resolve) => { release = resolve; });
        try {
          return await fn(current, options.dbNow ?? NOW);
        } finally {
          lockHeld = false;
          release();
        }
      },
      async audit(event) { audits.push(event); },
    },
    github,
    loadPrivateKey: () => (options.key === undefined ? PEM : options.key),
    instanceRole: options.role ?? 'production',
    now: () => NOW,
  };
  const decide = async (state: string) => {
    await released; // UPDATE blocks behind the share lock
    events.push(`decide ${state} lock=${lockHeld}`);
    if (current) current = { ...current, state };
  };
  return { deps, audits, mintBodies, revoked, events, decide };
}

// ── Success path ────────────────────────────────────────────────────────────

test('an active grant mints a downscoped token for the caller\'s own App, all inside the grant lock', async () => {
  const h = harness();
  const result = await mintAgentGithubToken(AGENT, h.deps);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.token, TOKEN);
  assert.equal(result.repositoryId, HOLAHOLA_REPOSITORY_ID);
  assert.deepEqual(h.mintBodies, [{ repository_ids: [HOLAHOLA_REPOSITORY_ID], permissions: { ...AGENT_TOKEN_PERMISSIONS } }]);
  assert.deepEqual(h.events, ['getInstallation lock=true', 'createToken lock=true']);
  assert.equal(h.audits.at(-1)?.eventType, 'token_issued');
  assert.equal(h.audits.at(-1)?.metadata?.authType, 'broker');
  assert.equal(h.audits.at(-1)?.metadata?.runtimeId, 'lcc-littlenemo');
});

// ── R1: lifecycle decisions are serialized with mint authorization ──────────

test('R1: a revoke arriving during a mint waits for the mint; the next mint sees it', async () => {
  let h!: ReturnType<typeof harness>;
  let revokePromise!: Promise<void>;
  h = harness({ duringCreate: async () => { revokePromise = h.decide('revoked'); await new Promise((r) => setTimeout(r, 5)); } });
  const first = await mintAgentGithubToken(AGENT, h.deps);
  await revokePromise;
  assert.equal(first.ok, true, 'a mint authorized before the revoke commits completes (residual <= 1h)');
  assert.deepEqual(h.events, ['getInstallation lock=true', 'createToken lock=true', 'decide revoked lock=false']);
  const second = await mintAgentGithubToken(AGENT, h.deps);
  assert.deepEqual(second, { ok: false, status: 403, reason: 'no_active_grant' });
  assert.equal(h.mintBodies.length, 1, 'no token requested after the revoke');
});

test('R1: a revoke or disable that commits before the mint is seen by the mint', async () => {
  for (const state of ['revoked', 'disabled']) {
    const h = harness();
    await h.decide(state);
    assert.deepEqual(await mintAgentGithubToken(AGENT, h.deps), { ok: false, status: 403, reason: 'no_active_grant' });
    assert.equal(h.mintBodies.length, 0);
  }
});

test('R1: expiry is judged by the database clock at lock time', async () => {
  const h = harness({ grant: grant({ expiresAt: new Date(NOW.getTime() + 1000) }), dbNow: new Date(NOW.getTime() + 2000) });
  assert.deepEqual(await mintAgentGithubToken(AGENT, h.deps), { ok: false, status: 403, reason: 'grant_expired' });
  assert.equal(h.mintBodies.length, 0);
});

// ── Denials (each must be audited and must not mint) ────────────────────────

async function expectDenied(h: ReturnType<typeof harness>, principal: MintPrincipal, status: number, reason: string) {
  const result = await mintAgentGithubToken(principal, h.deps);
  assert.deepEqual(result, { ok: false, status, reason });
  assert.equal(h.mintBodies.length, 0, 'no token may be requested');
  assert.equal(h.audits.at(-1)?.eventType, 'token_denied');
  assert.equal(h.audits.at(-1)?.reason, reason);
}

test('only the actor\'s own broker credential may mint; legacy and missing auth are refused and attributed', async () => {
  const h = harness();
  await expectDenied(h, { ...AGENT, authType: 'legacy' }, 403, 'broker_credential_required');
  assert.equal(h.audits.at(-1)?.metadata?.authType, 'legacy');
  await expectDenied(harness(), { ...AGENT, authType: undefined }, 403, 'broker_credential_required');
});

test('no grant, or a pending, disabled, rejected or revoked grant, is denied', async () => {
  await expectDenied(harness({ grant: null }), AGENT, 403, 'no_active_grant');
  for (const state of ['pending', 'disabled', 'rejected', 'revoked']) {
    await expectDenied(harness({ grant: grant({ state }) }), AGENT, 403, 'no_active_grant');
  }
});

test('an expired or expiry-less grant is denied', async () => {
  await expectDenied(harness({ grant: grant({ expiresAt: new Date(NOW.getTime() - 1) }) }), AGENT, 403, 'grant_expired');
  await expectDenied(harness({ grant: grant({ expiresAt: null }) }), AGENT, 403, 'grant_expired');
});

test('another actor\'s grant can never be used', async () => {
  await expectDenied(harness({ grant: grant({ actor: 'luca-replit' }) }), AGENT, 403, 'no_active_grant');
});

test('people, Daniela and the system actor are not eligible', async () => {
  for (const actor of ['david', 'daniela', 'coordination-system', 'someone-else']) {
    await expectDenied(harness(), { ...AGENT, actor }, 403, 'actor_not_eligible');
  }
});

test('a non-production instance never mints', async () => {
  await expectDenied(harness({ role: 'dev' }), AGENT, 503, 'not_production_instance');
});

test('a missing or unusable App key is reported as unavailable', async () => {
  await expectDenied(harness({ key: null }), AGENT, 503, 'app_key_unavailable');
  await expectDenied(harness({ key: '-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----' }), AGENT, 503, 'app_key_unavailable');
});

test('after the move, only an installation on the organization mints; the personal account is refused', async () => {
  const result = await mintAgentGithubToken(AGENT, harness({ installation: { app_id: APP_ID, account: { id: HOLAHOLA_ORGANIZATION_ACCOUNT_ID } } }).deps);
  assert.equal(result.ok, true);
  await expectDenied(harness({ installation: { app_id: APP_ID, account: { id: HOLAHOLA_OWNER_ACCOUNT_ID } } }), AGENT, 403, 'installation_mismatch');
  assert.deepEqual([...HOLAHOLA_INSTALLATION_ACCOUNT_IDS], [346076814]);
});

test('an installation belonging to another App or account is refused', async () => {
  await expectDenied(harness({ installation: { app_id: 999, account: { id: HOLAHOLA_OWNER_ACCOUNT_ID } } }), AGENT, 403, 'installation_mismatch');
  await expectDenied(harness({ installation: { app_id: 999, account: { id: HOLAHOLA_ORGANIZATION_ACCOUNT_ID } } }), AGENT, 403, 'installation_mismatch');
  await expectDenied(harness({ installation: { app_id: APP_ID, account: { id: 1 } } }), AGENT, 403, 'installation_mismatch');
  await expectDenied(harness({ installation: { app_id: APP_ID, account: null } }), AGENT, 403, 'installation_mismatch');
});

test('GitHub being unreachable fails closed', async () => {
  await expectDenied(harness({ githubThrows: true }), AGENT, 503, 'github_unavailable');
});

// ── Response checks: upstream expansion (R2, R5) ────────────────────────────

async function expectScopeRejected(token: GithubAccessTokenResponse) {
  const h = harness({ token });
  const result = await mintAgentGithubToken(AGENT, h.deps);
  assert.deepEqual(result, { ok: false, status: 403, reason: 'token_scope_exceeded' });
  assert.ok(!JSON.stringify(result).includes(TOKEN), 'the rejected token is never returned');
  assert.ok(!JSON.stringify(h.audits).includes(TOKEN));
  if (token.token) assert.deepEqual(h.revoked, [token.token], 'the rejected token is revoked at once');
}

test('a token carrying extra or elevated permissions is discarded and revoked', async () => {
  await expectScopeRejected(goodToken({ permissions: { ...AGENT_TOKEN_PERMISSIONS, workflows: 'write' } }));
  await expectScopeRejected(goodToken({ permissions: { ...AGENT_TOKEN_PERMISSIONS, administration: 'read' } }));
  await expectScopeRejected(goodToken({ permissions: { ...AGENT_TOKEN_PERMISSIONS, checks: 'write' } }));
  await expectScopeRejected(goodToken({ permissions: { ...AGENT_TOKEN_PERMISSIONS, contents: 'admin' } }));
  await expectScopeRejected(goodToken({ permissions: undefined }));
  await expectScopeRejected(goodToken({ permissions: { toString: 'write' } as unknown as Record<string, string> }));
});

test('a token covering other or additional repositories is discarded', async () => {
  await expectScopeRejected(goodToken({ repositories: [{ id: HOLAHOLA_REPOSITORY_ID }, { id: 42 }] }));
  await expectScopeRejected(goodToken({ repositories: [{ id: 42 }] }));
  await expectScopeRejected(goodToken({ repositories: [] }));
  await expectScopeRejected(goodToken({ repositories: undefined, repository_selection: 'all' }));
});

test('R2: a token living over an hour, already expired, or with an invalid expiry is discarded', async () => {
  const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString().replace(/\.\d+Z$/, 'Z');
  await expectScopeRejected(goodToken({ expires_at: at(61 * 60_000) }));
  await expectScopeRejected(goodToken({ expires_at: at(64 * 60_000) }));
  await expectScopeRejected(goodToken({ expires_at: at(3 * 3_600_000) }));
  await expectScopeRejected(goodToken({ expires_at: at(-1000) }));
  await expectScopeRejected(goodToken({ expires_at: at(0) }));
  await expectScopeRejected(goodToken({ expires_at: 'never' }));
  await expectScopeRejected(goodToken({ token: '' }));
});

test('R2: expiry window is (now, now + 1h] with no tolerance', () => {
  const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
  assert.equal(tokenExpiryAcceptable(at(3_600_000), NOW), true);
  assert.equal(tokenExpiryAcceptable(at(3_600_001), NOW), false);
  assert.equal(tokenExpiryAcceptable(at(3_660_000), NOW), false);
  assert.equal(tokenExpiryAcceptable(at(1), NOW), true);
  assert.equal(tokenExpiryAcceptable(at(0), NOW), false);
  assert.equal(tokenExpiryAcceptable(1_000, NOW), false);
});

test('R5: permissionsWithinCeiling accepts only own, allowlisted names with valid levels', () => {
  assert.equal(permissionsWithinCeiling({ contents: 'read', metadata: 'read' }), true);
  assert.equal(permissionsWithinCeiling({ contents: 'write' }), true);
  assert.equal(permissionsWithinCeiling({ toString: 'write' }), false);
  assert.equal(permissionsWithinCeiling({ constructor: 'read' }), false);
  assert.equal(permissionsWithinCeiling({ __proto__: { contents: 'write' } }), false);
  assert.equal(permissionsWithinCeiling(Object.create({ contents: 'write' })), false);
  assert.equal(permissionsWithinCeiling({ statuses: 'write' }), false);
  assert.equal(permissionsWithinCeiling({ issues: 'read' }), false);
  assert.equal(permissionsWithinCeiling({ contents: 'superuser' }), false);
  assert.equal(permissionsWithinCeiling({ contents: { level: 'write' } }), false);
  assert.equal(permissionsWithinCeiling({ contents: 'toString' }), false);
  assert.equal(permissionsWithinCeiling({ [Symbol('x')]: 'read' }), false);
  assert.equal(permissionsWithinCeiling(['contents']), false);
  assert.equal(permissionsWithinCeiling(undefined), false);
});

// ── R3: typed, allowlisted audit metadata ───────────────────────────────────

test('R3: audit metadata is allowlisted, typed and never nests upstream objects', () => {
  const marker = 'ghs_SYNTHETICMARKER1234';
  const built = buildAuditMetadata({
    token: marker,
    nested: { token: marker },
    list: [marker],
    authType: 'broker',
    runtimeId: marker,
    detail: 'key could not sign',
    permissions: { contents: 'write', evil: { token: marker }, admin_x: 'admin', toString: 'write' },
    repositoryIds: [HOLAHOLA_REPOSITORY_ID, marker, { id: 1 }],
    expiresAt: '2026-10-16T21:00:00Z',
    installationAppId: { nested: marker },
    revokedRejectedToken: true,
  });
  assert.deepEqual(built, {
    authType: 'broker',
    detail: 'key could not sign',
    permissions: ['admin_x:admin', 'contents:write'],
    repositoryIds: [HOLAHOLA_REPOSITORY_ID],
    expiresAt: '2026-10-16T21:00:00Z',
    revokedRejectedToken: true,
  });
  assert.ok(!JSON.stringify(built).includes(marker));
  for (const value of Object.values(built)) {
    assert.ok(value === null || typeof value !== 'object' || (Array.isArray(value) && value.every((v) => typeof v !== 'object')));
  }
});

test('R3: rejected-upstream audits carry only flattened, typed facts', async () => {
  const h = harness({ token: goodToken({ permissions: { ...AGENT_TOKEN_PERMISSIONS, workflows: 'write', nested: { token: TOKEN } } as unknown as Record<string, string> }) });
  await mintAgentGithubToken(AGENT, h.deps);
  const built = buildAuditMetadata(h.audits.at(-1)?.metadata);
  assert.ok(Array.isArray(built.permissions));
  assert.ok(!JSON.stringify(built).includes(TOKEN));
  assert.ok((built.permissions as string[]).includes('workflows:write'));
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

test('the permission ceiling never includes workflows, administration, secrets, environments or actions', () => {
  for (const forbidden of ['workflows', 'administration', 'secrets', 'environments', 'actions']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(AGENT_TOKEN_PERMISSIONS, forbidden), forbidden);
  }
  assert.deepEqual({ ...AGENT_TOKEN_PERMISSIONS }, { contents: 'write', pull_requests: 'write', metadata: 'read', checks: 'read', statuses: 'read' });
});

test('grant transitions: only founder decisions, no skipping, revoked and rejected are terminal', () => {
  assert.deepEqual(GRANT_TRANSITIONS.approve, { from: ['pending'], to: 'active' });
  assert.deepEqual(GRANT_TRANSITIONS.enable, { from: ['disabled'], to: 'active' });
  for (const [, t] of Object.entries(GRANT_TRANSITIONS)) {
    assert.ok(!t.from.includes('revoked') && !t.from.includes('rejected'));
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

test('the mint route takes the principal from the credential and reads no request body', () => {
  const mint = ROUTES.slice(ROUTES.indexOf("'/api/coordination/github-token'"));
  assert.match(mint, /const actor = req\.coordinationActor;/);
  assert.match(mint, /authType: req\.coordinationAuthType/);
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
