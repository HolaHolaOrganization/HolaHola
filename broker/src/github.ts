// GitHub access for the broker (costed plan ff04f70e, phase 2a).
//
// Everything goes to one fixed API base with redirects refused and a request
// timeout. Installation tokens stay inside this module: they are never
// returned to callers outside the broker, never logged, and never placed in an
// error message. Each token is minted for exactly one repository with an
// explicit, minimal permission set.

import { createSign, type KeyObject } from 'node:crypto';
import { type Ledger } from './claims.ts';
import { type PolicySnapshot, type PolicySource } from './policy.ts';

export const GITHUB_API = 'https://api.github.com';
export const REQUEST_TIMEOUT_MS = 15_000;
/** Refresh an installation token this long before GitHub says it expires. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** A GitHub call failed. Carries the status and path only, never a token or body. */
export class GitHubError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(status: number, path: string) {
    super(`GitHub ${path} returned ${status}`);
    this.status = status;
    this.path = path;
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** GitHub App JWT (RS256): back-dated 60 s for clock drift, valid 9 minutes (GitHub allows at most 10). */
export function createAppJwt(appId: number, privateKey: KeyObject, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat, exp: iat + 540, iss: String(appId) }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(privateKey))}`;
}

export class GitHubApi {
  private readonly fetch: Fetch;
  private readonly userAgent: string;

  constructor(fetchImpl: Fetch, userAgent = 'holahola-broker') {
    this.fetch = fetchImpl;
    this.userAgent = userAgent;
  }

  /** REST call. `path` must start with "/"; 404 resolves to null when `allow404` is set. */
  async rest(bearer: string, method: string, path: string, body?: unknown, allow404 = false): Promise<unknown> {
    if (!path.startsWith('/') || path.includes('://') || path.includes('..')) throw new TypeError('invalid GitHub path');
    const response = await this.fetch(`${GITHUB_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': this.userAgent,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const pathOnly = path.split('?')[0];
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw new GitHubError(response.status, pathOnly);
    return response.status === 204 ? null : await response.json();
  }

  /** GraphQL call. Returns `data`; GraphQL-level errors are returned, not thrown, so callers can classify them. */
  async graphql(bearer: string, query: string, variables: Record<string, unknown>): Promise<{ data: unknown; errors: Array<{ type?: string; message?: string }> }> {
    const result = await this.rest(bearer, 'POST', '/graphql', { query, variables }) as { data?: unknown; errors?: Array<{ type?: string; message?: string }> };
    return { data: result?.data ?? null, errors: Array.isArray(result?.errors) ? result.errors : [] };
  }
}

export type InstallationConfig = {
  appId: number;
  installationId: number;
  privateKey: KeyObject;
  /** The single repository this token may touch. */
  repositoryId: number;
  /** Explicit permission set, for example { contents: 'read' }. Never omitted. */
  permissions: Record<string, 'read' | 'write'>;
};

/** Mints and caches one installation token for one (installation, repository, permission set). */
export class InstallationToken {
  private readonly api: GitHubApi;
  private readonly config: InstallationConfig;
  private readonly now: () => number;
  private cached: { token: string; refreshAt: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(api: GitHubApi, config: InstallationConfig, now: () => number = Date.now) {
    if (Object.keys(config.permissions).length === 0) throw new TypeError('installation token needs an explicit permission set');
    this.api = api;
    this.config = config;
    this.now = now;
  }

  get(): Promise<string> {
    if (this.cached && this.now() < this.cached.refreshAt) return Promise.resolve(this.cached.token);
    this.cached = null;
    if (!this.inflight) {
      this.inflight = this.mint().finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  private async mint(): Promise<string> {
    const { appId, installationId, privateKey, repositoryId, permissions } = this.config;
    const jwt = createAppJwt(appId, privateKey, this.now());
    const response = await this.api.rest(jwt, 'POST', `/app/installations/${installationId}/access_tokens`, {
      repository_ids: [repositoryId],
      permissions,
    }) as { token?: unknown; expires_at?: unknown };
    const expiresAt = typeof response?.expires_at === 'string' ? Date.parse(response.expires_at) : NaN;
    if (typeof response?.token !== 'string' || !Number.isFinite(expiresAt)) throw new GitHubError(502, '/app/installations/:id/access_tokens');
    this.cached = { token: response.token, refreshAt: expiresAt - TOKEN_REFRESH_MARGIN_MS };
    return response.token;
  }
}

export type RepositoryRef = { owner: string; name: string };
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

function repoPath(repo: RepositoryRef): string {
  if (!NAME.test(repo.owner) || !NAME.test(repo.name)) throw new TypeError('invalid repository name');
  return `/repos/${repo.owner}/${repo.name}`;
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * Reads broker/policy.json from main. The contents API returns the file's git
 * blob sha alongside its bytes; PolicyLoader recomputes the sha from the bytes
 * and refuses a mismatch, so this source cannot vouch for content it did not
 * actually receive.
 */
export class GitHubPolicySource implements PolicySource {
  private readonly api: GitHubApi;
  private readonly repo: RepositoryRef;
  private readonly token: () => Promise<string>;

  constructor(api: GitHubApi, repo: RepositoryRef, token: () => Promise<string>) {
    this.api = api;
    this.repo = repo;
    this.token = token;
  }

  async fetch(): Promise<PolicySnapshot> {
    const file = await this.api.rest(await this.token(), 'GET', `${repoPath(this.repo)}/contents/broker/policy.json?ref=main`) as
      { type?: unknown; encoding?: unknown; content?: unknown; sha?: unknown };
    if (file?.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string' || typeof file.sha !== 'string') {
      throw new GitHubError(502, `${repoPath(this.repo)}/contents/broker/policy.json`);
    }
    return { bytes: new Uint8Array(Buffer.from(file.content, 'base64')), blobSha: file.sha };
  }
}

const SHA1_HEX = /^[0-9a-f]{40}$/;

/** A ledger commit named a file that already exists. Never retried: the ledger is append-only. */
export class LedgerOverwriteError extends Error {
  constructor(path: string) {
    super(`ledger refuses to overwrite ${path}`);
  }
}

const CREATE_COMMIT = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid } }
}`;

/**
 * The claim ledger on the audit repository's `main` branch. Every commit is a
 * createCommitOnBranch with expectedHeadOid, which GitHub applies only if the
 * branch still points at that commit -- the compare-and-swap executeOnce relies
 * on. A head-mismatch rejection is reported as { ok: false }; any other
 * failure throws, so executeOnce denies rather than guesses.
 *
 * Assumption to verify on the deployed system (plan F3): GitHub's error for a
 * moved head is recognisable by its STALE_DATA type or "Expected branch to
 * point to" message.
 */
export class GitHubLedger implements Ledger {
  private readonly api: GitHubApi;
  private readonly repo: RepositoryRef;
  private readonly token: () => Promise<string>;
  private readonly branch = 'main';

  constructor(api: GitHubApi, repo: RepositoryRef, token: () => Promise<string>) {
    this.api = api;
    this.repo = repo;
    this.token = token;
  }

  async head(): Promise<string> {
    const ref = await this.api.rest(await this.token(), 'GET', `${repoPath(this.repo)}/git/ref/heads/${this.branch}`) as { object?: { sha?: unknown } };
    const sha = ref?.object?.sha;
    if (typeof sha !== 'string' || !SHA1_HEX.test(sha)) throw new GitHubError(502, `${repoPath(this.repo)}/git/ref/heads/${this.branch}`);
    return sha;
  }

  async read(head: string, path: string): Promise<string | null> {
    if (!SHA1_HEX.test(head)) throw new TypeError('ledger head must be a commit sha');
    const file = await this.api.rest(await this.token(), 'GET', `${repoPath(this.repo)}/contents/${encodePath(path)}?ref=${head}`, undefined, true) as
      { type?: unknown; encoding?: unknown; content?: unknown } | null;
    if (file === null) return null;
    if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string') {
      throw new GitHubError(502, `${repoPath(this.repo)}/contents`);
    }
    return Buffer.from(file.content, 'base64').toString('utf8');
  }

  /**
   * createCommitOnBranch "additions" REPLACE existing files, so the
   * never-overwrite contract is enforced here: every destination must be absent
   * at exactly `expectedHead`. Commits are immutable and the CAS below applies
   * only while the branch still points at `expectedHead`, so absence checked at
   * that head holds at the moment the commit lands -- check and write are one
   * atomic step. Any existing destination rejects the whole batch.
   */
  async commit(expectedHead: string, files: Record<string, string>, message: string): Promise<{ ok: true; head: string } | { ok: false }> {
    if (!SHA1_HEX.test(expectedHead)) throw new TypeError('expected head must be a commit sha');
    for (const path of Object.keys(files)) {
      if ((await this.read(expectedHead, path)) !== null) throw new LedgerOverwriteError(path);
    }
    const additions = Object.entries(files).map(([path, contents]) => ({ path, contents: Buffer.from(contents, 'utf8').toString('base64') }));
    const { data, errors } = await this.api.graphql(await this.token(), CREATE_COMMIT, {
      input: {
        branch: { repositoryNameWithOwner: `${this.repo.owner}/${this.repo.name}`, branchName: this.branch },
        message: { headline: message.slice(0, 200) },
        expectedHeadOid: expectedHead,
        fileChanges: { additions },
      },
    });
    if (errors.length > 0) {
      const stale = errors.every((error) => error.type === 'STALE_DATA' || /Expected branch to point to/i.test(error.message ?? ''));
      if (stale) return { ok: false };
      throw new GitHubError(502, '/graphql createCommitOnBranch');
    }
    const oid = (data as { createCommitOnBranch?: { commit?: { oid?: unknown } } } | null)?.createCommitOnBranch?.commit?.oid;
    if (typeof oid !== 'string' || !SHA1_HEX.test(oid)) throw new GitHubError(502, '/graphql createCommitOnBranch');
    return { ok: true, head: oid };
  }
}
