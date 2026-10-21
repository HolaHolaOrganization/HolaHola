/**
 * GitHub token broker — standard-controls plan efb1e3d1 rev 10, Phase A1b.
 *
 * Each agent (a coordination actor) has its own GitHub App. The App's private
 * key lives only in this server's environment (a Render service-level secret,
 * `GITHUB_AGENT_APP_PRIVATE_KEY_<appId>`); it never reaches an agent machine.
 * An agent authenticated by its own BROKER credential asks for a token; the
 * broker mints a GitHub installation token for THAT agent's App only:
 *
 * - only with an ACTIVE, founder-approved, unexpired grant for that actor;
 * - App ID and installation ID come from the grant, never from the request,
 *   and each App/installation is permanently bound to one actor;
 * - the repository and permission ceiling are fixed constants below, sent
 *   explicitly on every mint, and checked again on GitHub's response, so a
 *   token never exceeds them even if the App installation later gains more
 *   permissions or repositories;
 * - only on the production instance (instance-role gate);
 * - every issuance and denial is audited with typed, allowlisted metadata
 *   that never contains a token, a JWT or key material.
 *
 * Authorization boundary (review R1): the whole mint — grant check, GitHub
 * calls, response check — runs inside one database transaction holding a
 * FOR SHARE lock on the grant row. Founder decisions UPDATE that row, so a
 * revoke/disable that arrives during a mint waits until the mint finishes;
 * a decision that commits first is seen by the mint. Expiry is checked
 * against clock_timestamp() read AFTER the lock is acquired.
 *
 * Revocation: revoking or disabling a grant stops NEW mints immediately (after
 * any in-flight mint). Tokens already issued stay valid until they expire: at
 * most 1 hour (GitHub's installation-token lifetime; the broker refuses any
 * token expiring later than 1 hour from its own clock). For immediate cut-off, the founder
 * suspends the App installation on GitHub, which revokes all of its tokens.
 * A token that fails the response check is revoked at once, best effort.
 */
import crypto from 'node:crypto';
import type { GithubAppGrant } from '@shared/schema';

/** davidwmcintosh/HolaHola — verified via GET /repos/davidwmcintosh/HolaHola. The id survives a repository transfer. */
export const HOLAHOLA_REPOSITORY_ID = 1170208766;
/** davidwmcintosh — the founder's personal account, the repository's current owner. */
export const HOLAHOLA_OWNER_ACCOUNT_ID = 34244604;
/** HolaHolaOrganization — the founder's organization; verified via GET /orgs/HolaHolaOrganization. */
export const HOLAHOLA_ORGANIZATION_ACCOUNT_ID = 346076814;
/**
 * The accounts the agent Apps may be installed on. Both are founder-owned. Both
 * stay valid while HolaHola moves from the personal account to the organization:
 * each App is reinstalled on the organization, and its grant then names the new
 * installation. Narrow this back to one account once the move is done.
 */
export const HOLAHOLA_INSTALLATION_ACCOUNT_IDS: ReadonlySet<number> = new Set([HOLAHOLA_OWNER_ACCOUNT_ID, HOLAHOLA_ORGANIZATION_ACCOUNT_ID]);

/** Fixed ceiling for every agent token. Workflows/administration/secrets are never granted. */
export const AGENT_TOKEN_PERMISSIONS: Readonly<Record<string, 'read' | 'write'>> = Object.freeze({
  contents: 'write',
  pull_requests: 'write',
  metadata: 'read',
  checks: 'read',
  statuses: 'read',
});

/** Grant lifetime from founder approval; renewal is a new founder approval. */
export const GRANT_LIFETIME_DAYS = 90;
/** GitHub installation tokens live 1 hour. */
export const MAX_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
/**
 * No tolerance: a token is accepted only if it expires at most 1 hour after
 * this server's clock at check time (the approved residual). If this server's
 * clock lags GitHub's, mints fail closed rather than widen the bound.
 */
export const TOKEN_EXPIRY_CLOCK_TOLERANCE_MS = 0;

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
  | 'broker_credential_required'
  | 'no_active_grant'
  | 'grant_expired'
  | 'app_key_unavailable'
  | 'installation_mismatch'
  | 'github_unavailable'
  | 'token_scope_exceeded';

export interface MintPrincipal {
  actor: string;
  /** 'broker' = the actor's own short-lived broker credential (required). */
  authType: 'broker' | 'legacy' | undefined;
  runtimeId?: string;
  credentialId?: string;
}

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

// ── Typed audit metadata (review R3) ─────────────────────────────────────────

type AuditScalar = string | number | boolean | null;
type AuditValue = AuditScalar | AuditScalar[];

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const PERMISSION_PAIR = /^[a-z_]{1,40}:(read|write|admin)$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const CREDENTIAL_LIKE = /(gh[pousr]_[A-Za-z0-9]{8,})|(eyJ[\w-]{4,}\.)|(PRIVATE KEY)/;

const shortText = (pattern: RegExp) => (value: unknown): AuditValue | undefined =>
  typeof value === 'string' && pattern.test(value) && !CREDENTIAL_LIKE.test(value) ? value : undefined;
const safeInteger = (value: unknown): AuditValue | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : value === null ? null : undefined;
const integerList = (value: unknown): AuditValue | undefined =>
  Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number' && Number.isSafeInteger(v)).slice(0, 20) : undefined;
/** Permissions are stored as "name:level" strings only, never as an upstream object. */
const permissionList = (value: unknown): AuditValue | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value === null ? null : undefined;
  return Object.keys(value)
    .filter((name) => Object.prototype.hasOwnProperty.call(value, name))
    .map((name) => `${name}:${String((value as Record<string, unknown>)[name])}`)
    .filter((pair) => PERMISSION_PAIR.test(pair))
    .sort()
    .slice(0, 40);
};

const AUDIT_FIELDS: Record<string, (value: unknown) => AuditValue | undefined> = {
  authType: shortText(/^(broker|legacy|none)$/),
  runtimeId: shortText(ID_PATTERN),
  credentialId: shortText(ID_PATTERN),
  state: shortText(/^(pending|active|disabled|rejected|revoked)$/),
  step: shortText(/^(get_installation|create_token|revoke_token)$/),
  detail: shortText(/^[a-z_ ]{1,80}$/),
  proposedBy: shortText(ID_PATTERN),
  founder: shortText(ID_PATTERN),
  installationAppId: safeInteger,
  installationAccountId: safeInteger,
  repositoryId: safeInteger,
  repositoryIds: integerList,
  permissions: permissionList,
  expiresAt: shortText(ISO_INSTANT),
  revokedRejectedToken: (value) => (typeof value === 'boolean' ? value : undefined),
};

/**
 * Builds audit metadata from an allowlist: unknown fields are dropped, each
 * known field must match its type, nested objects never pass through, and any
 * string that looks like a token, a JWT or a key is dropped.
 */
export function buildAuditMetadata(input: Record<string, unknown> | undefined): Record<string, AuditValue> {
  const out: Record<string, AuditValue> = {};
  if (!input || typeof input !== 'object') return out;
  for (const name of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(AUDIT_FIELDS, name)) continue;
    const value = AUDIT_FIELDS[name](input[name]);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

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
  /**
   * Runs `fn` while holding a FOR SHARE lock on the actor's single live grant
   * (active or disabled), inside one transaction. `dbNow` is the database
   * clock at lock time. Founder decisions block until `fn` returns.
   */
  withMintLock<T>(actor: string, fn: (grant: GithubAppGrant | null, dbNow: Date) => Promise<T>): Promise<T>;
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
  /** Revokes an installation token immediately (DELETE /installation/token). */
  revokeInstallationToken(token: string): Promise<void>;
}

export interface MintDependencies {
  store: GithubTokenBrokerStore;
  github: GithubAppApi;
  /** Returns the PEM private key for an App, or null when not provisioned. */
  loadPrivateKey: (appId: number) => string | null;
  instanceRole: string;
  now?: () => Date;
}

const PERMISSION_RANK: Readonly<Record<string, number>> = Object.freeze({ read: 1, write: 2, admin: 3 });

/**
 * True when `granted` is a plain object whose OWN properties are all named in
 * the ceiling, with string levels no higher than the ceiling (review R5).
 */
export function permissionsWithinCeiling(granted: unknown): boolean {
  if (!granted || typeof granted !== 'object' || Array.isArray(granted)) return false;
  const proto = Object.getPrototypeOf(granted);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const name of Reflect.ownKeys(granted)) {
    if (typeof name !== 'string') return false;
    if (!Object.prototype.hasOwnProperty.call(AGENT_TOKEN_PERMISSIONS, name)) return false;
    const level = (granted as Record<string, unknown>)[name];
    if (typeof level !== 'string' || !Object.prototype.hasOwnProperty.call(PERMISSION_RANK, level)) return false;
    if (PERMISSION_RANK[level] > PERMISSION_RANK[AGENT_TOKEN_PERMISSIONS[name]]) return false;
  }
  return true;
}

/** A token expiry must be in the future and at most 1 hour away (review R2; no tolerance). */
export function tokenExpiryAcceptable(expiresAt: unknown, now: Date): boolean {
  if (typeof expiresAt !== 'string' || !ISO_INSTANT.test(expiresAt)) return false;
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return false;
  return ms > now.getTime() && ms <= now.getTime() + MAX_TOKEN_LIFETIME_MS + TOKEN_EXPIRY_CLOCK_TOLERANCE_MS;
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
 * Mints an installation token for the principal's own App. Only the
 * authenticated principal is consulted; nothing else from the request.
 */
export async function mintAgentGithubToken(principal: MintPrincipal, deps: MintDependencies): Promise<MintResult> {
  const actor = principal.actor;
  const who = {
    authType: principal.authType ?? 'none',
    runtimeId: principal.runtimeId,
    credentialId: principal.credentialId,
  };
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
      metadata: { ...who, ...metadata },
    });
    return { ok: false, status, reason };
  };

  if (deps.instanceRole !== 'production') return deny(503, 'not_production_instance');
  if (!(GITHUB_GRANT_ACTORS as readonly string[]).includes(actor)) return deny(403, 'actor_not_eligible');
  if (principal.authType !== 'broker') return deny(403, 'broker_credential_required');

  return deps.store.withMintLock(actor, async (grant, dbNow) => {
    if (!grant || grant.actor !== actor || grant.state !== 'active') {
      return deny(403, 'no_active_grant', grant, grant ? { state: grant.state } : undefined);
    }
    if (!grant.expiresAt || grant.expiresAt.getTime() <= dbNow.getTime()) return deny(403, 'grant_expired', grant);

    const key = deps.loadPrivateKey(grant.appId);
    if (!key) return deny(503, 'app_key_unavailable', grant);

    let jwt: string;
    try {
      jwt = createAppJwt(grant.appId, key, deps.now?.() ?? new Date());
    } catch {
      return deny(503, 'app_key_unavailable', grant, { detail: 'key could not sign' });
    }

    let installation: GithubInstallationInfo;
    try {
      installation = await deps.github.getInstallation(jwt, grant.installationId);
    } catch {
      return deny(503, 'github_unavailable', grant, { step: 'get_installation' });
    }
    const accountId = installation?.account?.id;
    if (installation?.app_id !== grant.appId || typeof accountId !== 'number' || !HOLAHOLA_INSTALLATION_ACCOUNT_IDS.has(accountId)) {
      return deny(403, 'installation_mismatch', grant, {
        installationAppId: installation?.app_id ?? null,
        installationAccountId: installation?.account?.id ?? null,
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

    const checkedAt = deps.now?.() ?? new Date();
    const repositories = Array.isArray(response?.repositories) ? response.repositories : [];
    const scopeOk = typeof response?.token === 'string' && response.token.length > 0
      && repositories.length === 1 && repositories[0]?.id === HOLAHOLA_REPOSITORY_ID
      && permissionsWithinCeiling(response.permissions)
      && tokenExpiryAcceptable(response.expires_at, checkedAt);
    if (!scopeOk) {
      // Never returned. Revoke it now rather than leaving it to expire.
      let revoked = false;
      if (typeof response?.token === 'string' && response.token) {
        try {
          await deps.github.revokeInstallationToken(response.token);
          revoked = true;
        } catch {
          revoked = false;
        }
      }
      return deny(403, 'token_scope_exceeded', grant, {
        permissions: response?.permissions ?? null,
        repositoryIds: repositories.map((r) => r?.id),
        expiresAt: response?.expires_at,
        revokedRejectedToken: revoked,
      });
    }

    await deps.store.audit({
      eventType: 'token_issued',
      success: true,
      actor,
      grantId: grant.id,
      appId: grant.appId,
      installationId: grant.installationId,
      metadata: { ...who, permissions: response.permissions, repositoryId: HOLAHOLA_REPOSITORY_ID, expiresAt: response.expires_at },
    });
    return {
      ok: true as const,
      token: response.token,
      expiresAt: response.expires_at,
      appId: grant.appId,
      repositoryId: HOLAHOLA_REPOSITORY_ID,
      permissions: { ...response.permissions },
    };
  });
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

async function githubFetch<T>(bearer: string, path: string, init?: { method: string; body?: unknown }): Promise<T> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${bearer}`,
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
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export const githubAppApi: GithubAppApi = {
  getInstallation: (jwt, installationId) =>
    githubFetch<GithubInstallationInfo>(jwt, `/app/installations/${installationId}`),
  createInstallationToken: (jwt, installationId, body) =>
    githubFetch<GithubAccessTokenResponse>(jwt, `/app/installations/${installationId}/access_tokens`, { method: 'POST', body }),
  revokeInstallationToken: async (token) => {
    await githubFetch<void>(token, '/installation/token', { method: 'DELETE' });
  },
};
