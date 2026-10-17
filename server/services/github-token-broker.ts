/**
 * GitHub token broker — standard-controls plan efb1e3d1 rev 10, Phase A1b.
 *
 * Each agent (a coordination actor) has its own GitHub App. The App's private
 * key lives only in this server's environment (a Render service-level secret,
 * `GITHUB_AGENT_APP_PRIVATE_KEY_<appId>`); it never reaches an agent machine.
 * An agent authenticated by its own coordination credential asks for a token;
 * the broker mints a GitHub installation token for THAT agent's App only:
 *
 * - only with an ACTIVE, founder-approved, unexpired grant for that actor;
 * - App ID and installation ID come from the grant, never from the request;
 * - the repository and permission ceiling are fixed constants below, sent
 *   explicitly on every mint, and checked again on GitHub's response, so a
 *   token never exceeds them even if the App installation later gains more
 *   permissions or repositories;
 * - only on the production instance (instance-role gate);
 * - every issuance and denial is audited, and audits never contain a token,
 *   a JWT or key material.
 *
 * Revocation: revoking or disabling a grant stops NEW mints immediately.
 * Tokens already issued stay valid until they expire (at most 1 hour, GitHub's
 * installation-token lifetime). For immediate cut-off, the founder suspends
 * the App installation on GitHub, which revokes all of its tokens.
 */
import crypto from 'node:crypto';
import type { GithubAppGrant } from '@shared/schema';

/** davidwmcintosh/HolaHola — verified via GET /repos/davidwmcintosh/HolaHola. */
export const HOLAHOLA_REPOSITORY_ID = 1170208766;
/** davidwmcintosh — the only account the agent Apps may be installed on. */
export const HOLAHOLA_OWNER_ACCOUNT_ID = 34244604;

/** Fixed ceiling for every agent token. Workflows/administration/secrets are never granted. */
export const AGENT_TOKEN_PERMISSIONS = Object.freeze({
  contents: 'write',
  pull_requests: 'write',
  metadata: 'read',
  checks: 'read',
  statuses: 'read',
} as const);

/** Grant lifetime from founder approval; renewal is a new founder approval. */
export const GRANT_LIFETIME_DAYS = 90;
const MAX_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Coordination actors that may hold a GitHub App grant (agents, not people or Daniela). */
export const GITHUB_GRANT_ACTORS = [
  'luca-holahola',
  'luca-replit',
  'luca-claude-code',
  'luca-gemini',
  'luca-antigravity',
  'luca-cursor',
  'luca-openai-agents',
  'alden',
] as const;

export type BrokerDenial =
  | 'not_production_instance'
  | 'actor_not_eligible'
  | 'no_active_grant'
  | 'grant_expired'
  | 'app_key_unavailable'
  | 'installation_mismatch'
  | 'github_unavailable'
  | 'token_scope_exceeded';

export type MintResult =
  | {
      ok: true;
      token: string;
      expiresAt: string;
      appId: number;
      repositoryId: number;
      permissions: Record<string, string>;
    }
  | { ok: false; status: 403 | 503; reason: BrokerDenial };

export interface GithubTokenAuditEvent {
  eventType: 'token_issued' | 'token_denied' | 'grant_proposed' | 'grant_decided';
  success: boolean;
  actor?: string;
  grantId?: string;
  appId?: number;
  installationId?: number;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface GithubTokenBrokerStore {
  /** The single live grant (active or disabled) for this actor, if any. */
  findLiveGrant(actor: string): Promise<GithubAppGrant | null>;
  audit(event: GithubTokenAuditEvent): Promise<void>;
}

export interface GithubInstallationInfo {
  app_id: number;
  account?: { id?: number; login?: string } | null;
}

export interface GithubAccessTokenResponse {
  token: string;
  expires_at: string;
  permissions?: Record<string, string>;
  repository_selection?: string;
  repositories?: Array<{ id: number }>;
}

export interface GithubAppApi {
  getInstallation(jwt: string, installationId: number): Promise<GithubInstallationInfo>;
  createInstallationToken(
    jwt: string,
    installationId: number,
    body: { repository_ids: number[]; permissions: Record<string, string> },
  ): Promise<GithubAccessTokenResponse>;
}

export interface MintDependencies {
  store: GithubTokenBrokerStore;
  github: GithubAppApi;
  /** Returns the PEM private key for an App, or null when not provisioned. */
  loadPrivateKey: (appId: number) => string | null;
  instanceRole: string;
  now?: () => Date;
}

const PERMISSION_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** True when every granted permission is within AGENT_TOKEN_PERMISSIONS. */
export function permissionsWithinCeiling(granted: Record<string, string> | undefined): boolean {
  if (!granted || typeof granted !== 'object') return false;
  for (const [name, level] of Object.entries(granted)) {
    const ceiling = (AGENT_TOKEN_PERMISSIONS as Record<string, string>)[name];
    if (!ceiling) return false;
    const rank = PERMISSION_RANK[level];
    if (!rank || rank > PERMISSION_RANK[ceiling]) return false;
  }
  return true;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** GitHub App JWT (RS256), valid at most 10 minutes, back-dated 60s for clock drift. */
export function createAppJwt(appId: number, privateKeyPem: string, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat, exp: iat + 540, iss: String(appId) }));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKeyPem);
  return `${header}.${payload}.${base64url(signature)}`;
}

/** Reads GITHUB_AGENT_APP_PRIVATE_KEY_<appId> as PEM or base64-encoded PEM. */
export function loadPrivateKeyFromEnv(appId: number, env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[`GITHUB_AGENT_APP_PRIVATE_KEY_${appId}`]?.trim();
  if (!raw) return null;
  const pem = raw.startsWith('-----BEGIN') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  return pem.includes('PRIVATE KEY-----') ? pem.replace(/\\n/g, '\n') : null;
}

/**
 * Mints an installation token for `actor`'s own App. `actor` is the
 * authenticated principal; nothing else from the request is consulted.
 */
export async function mintAgentGithubToken(actor: string, deps: MintDependencies): Promise<MintResult> {
  const now = deps.now?.() ?? new Date();
  const deny = async (
    status: 403 | 503,
    reason: BrokerDenial,
    grant?: GithubAppGrant | null,
    metadata?: Record<string, unknown>,
  ): Promise<MintResult> => {
    await deps.store.audit({
      eventType: 'token_denied',
      success: false,
      actor,
      grantId: grant?.id,
      appId: grant?.appId,
      installationId: grant?.installationId,
      reason,
      metadata,
    });
    return { ok: false, status, reason };
  };

  if (deps.instanceRole !== 'production') return deny(503, 'not_production_instance');
  if (!(GITHUB_GRANT_ACTORS as readonly string[]).includes(actor)) return deny(403, 'actor_not_eligible');

  const grant = await deps.store.findLiveGrant(actor);
  if (!grant || grant.actor !== actor || grant.state !== 'active') {
    return deny(403, 'no_active_grant', grant, grant ? { state: grant.state } : undefined);
  }
  if (!grant.expiresAt || grant.expiresAt.getTime() <= now.getTime()) return deny(403, 'grant_expired', grant);

  const key = deps.loadPrivateKey(grant.appId);
  if (!key) return deny(503, 'app_key_unavailable', grant);

  let jwt: string;
  try {
    jwt = createAppJwt(grant.appId, key, now);
  } catch {
    return deny(503, 'app_key_unavailable', grant, { detail: 'key could not sign' });
  }

  let installation: GithubInstallationInfo;
  try {
    installation = await deps.github.getInstallation(jwt, grant.installationId);
  } catch {
    return deny(503, 'github_unavailable', grant, { step: 'get_installation' });
  }
  if (installation.app_id !== grant.appId || installation.account?.id !== HOLAHOLA_OWNER_ACCOUNT_ID) {
    return deny(403, 'installation_mismatch', grant, {
      installationAppId: installation.app_id,
      installationAccountId: installation.account?.id ?? null,
    });
  }

  let response: GithubAccessTokenResponse;
  try {
    response = await deps.github.createInstallationToken(jwt, grant.installationId, {
      repository_ids: [HOLAHOLA_REPOSITORY_ID],
      permissions: { ...AGENT_TOKEN_PERMISSIONS },
    });
  } catch {
    return deny(503, 'github_unavailable', grant, { step: 'create_token' });
  }

  const repositories = response.repositories ?? [];
  const expiresAtMs = Date.parse(response.expires_at);
  const scopeOk = typeof response.token === 'string' && response.token.length > 0
    && repositories.length === 1 && repositories[0]?.id === HOLAHOLA_REPOSITORY_ID
    && permissionsWithinCeiling(response.permissions)
    && Number.isFinite(expiresAtMs)
    && expiresAtMs <= now.getTime() + MAX_TOKEN_LIFETIME_MS + CLOCK_SKEW_MS;
  if (!scopeOk) {
    // The token is discarded, never returned. GitHub expires it within the hour.
    return deny(403, 'token_scope_exceeded', grant, {
      permissions: response.permissions ?? null,
      repositoryIds: repositories.map((r) => r.id),
      expiresAt: response.expires_at ?? null,
    });
  }

  await deps.store.audit({
    eventType: 'token_issued',
    success: true,
    actor,
    grantId: grant.id,
    appId: grant.appId,
    installationId: grant.installationId,
    metadata: { permissions: response.permissions, repositoryId: HOLAHOLA_REPOSITORY_ID, expiresAt: response.expires_at },
  });
  return {
    ok: true,
    token: response.token,
    expiresAt: response.expires_at,
    appId: grant.appId,
    repositoryId: HOLAHOLA_REPOSITORY_ID,
    permissions: response.permissions ?? {},
  };
}

const SECRET_KEY_PATTERN = /token|jwt|key|secret|authorization/i;

/** Audit metadata never carries credential material, whatever a caller passes. */
export function scrubAuditMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(metadata ?? {})) {
    if (SECRET_KEY_PATTERN.test(name)) continue;
    if (typeof value === 'string' && (/^gh[spu]_/.test(value) || /^eyJ[\w-]+\./.test(value) || value.includes('PRIVATE KEY'))) continue;
    out[name] = value;
  }
  return out;
}

// ── Grant lifecycle (founder decisions) ─────────────────────────────────────

export type GrantDecision = 'approve' | 'reject' | 'disable' | 'enable' | 'revoke';

/** Allowed state transitions; anything else is refused. */
export const GRANT_TRANSITIONS: Readonly<Record<GrantDecision, { from: readonly string[]; to: string }>> = {
  approve: { from: ['pending'], to: 'active' },
  reject: { from: ['pending'], to: 'rejected' },
  disable: { from: ['active'], to: 'disabled' },
  enable: { from: ['disabled'], to: 'active' },
  revoke: { from: ['pending', 'active', 'disabled'], to: 'revoked' },
};

export interface GrantProposal {
  actor: string;
  appId: number;
  installationId: number;
}

export function validateGrantProposal(input: unknown): { ok: true; proposal: GrantProposal } | { ok: false; error: string } {
  const body = (input ?? {}) as Record<string, unknown>;
  const actor = body.actor;
  if (typeof actor !== 'string' || !(GITHUB_GRANT_ACTORS as readonly string[]).includes(actor)) {
    return { ok: false, error: `actor must be one of: ${GITHUB_GRANT_ACTORS.join(', ')}` };
  }
  const appId = Number(body.appId);
  const installationId = Number(body.installationId);
  if (!Number.isSafeInteger(appId) || appId <= 0) return { ok: false, error: 'appId must be a positive integer' };
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return { ok: false, error: 'installationId must be a positive integer' };
  }
  return { ok: true, proposal: { actor, appId, installationId } };
}

// ── Production wiring ───────────────────────────────────────────────────────

const GITHUB_API = 'https://api.github.com';

async function githubFetch<T>(jwt: string, path: string, init?: { method: string; body?: unknown }): Promise<T> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'holahola-github-token-broker',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub API ${path} returned ${response.status}`);
  return response.json() as Promise<T>;
}

export const githubAppApi: GithubAppApi = {
  getInstallation: (jwt, installationId) =>
    githubFetch<GithubInstallationInfo>(jwt, `/app/installations/${installationId}`),
  createInstallationToken: (jwt, installationId, body) =>
    githubFetch<GithubAccessTokenResponse>(jwt, `/app/installations/${installationId}/access_tokens`, { method: 'POST', body }),
};
