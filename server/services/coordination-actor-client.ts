import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  COORDINATION_TOKEN_ENV_BY_ACTOR,
} from '../middleware/coordination-auth';
import type {
  CoordinationActorId,
  CoordinationEvidenceReference,
  CoordinationEventType,
} from '@shared/schema';

export type DirectCoordinationActor = 'luca-holahola' | 'alden' | 'daniela';
export type CoordinationClientActor = Exclude<CoordinationActorId, 'coordination-system'>;
export type CoordinationClientAction =
  | 'list'
  | 'acknowledge-feed'
  | 'list-inbox'
  | 'acknowledge-inbox'
  | 'show'
  | 'create'
  | 'accept'
  | 'progress'
  | 'evidence'
  | 'block'
  | 'complete'
  | 'acknowledge'
  | 'reopen'
  | 'reassign'
  | 'comment'
  | 'reply-and-verify'
  | 'complete-with-linked-outcome';

const DIRECT_CLIENT_ACTIONS: Record<DirectCoordinationActor, ReadonlySet<CoordinationClientAction>> = {
  'luca-holahola': new Set(['list', 'acknowledge-feed', 'list-inbox', 'acknowledge-inbox', 'show', 'create', 'reassign', 'comment']),
  alden: new Set([
    'list', 'acknowledge-feed', 'list-inbox', 'acknowledge-inbox', 'show', 'create', 'accept', 'progress', 'evidence', 'block', 'complete',
    'acknowledge', 'reassign', 'comment',
  ]),
  daniela: new Set([
    'list', 'acknowledge-feed', 'list-inbox', 'acknowledge-inbox', 'show', 'accept', 'progress', 'evidence', 'block', 'complete', 'comment',
  ]),
};

type Environment = Record<string, string | undefined>;
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * A persisted broker credential, keyed by actor + runtimeId. Implementations
 * must never hand back an entry whose stored actor/runtimeId does not match
 * the arguments the caller asked for.
 */
export type CoordinationCredentialCacheEntry = {
  actor: CoordinationClientActor;
  runtimeId: string;
  accessToken: string;
  /** ISO-8601 string, exactly the broker's expiresAt from exchange or renewal. */
  expiresAt: string;
};

export type CoordinationActorClientOptions = {
  apiUrl: string;
  environment?: Environment;
  fetchImpl?: FetchLike;
  /**
   * Optional local file path used to persist the broker-issued access token
   * across process restarts, so a properly-configured client can recover on
   * its own instead of needing a human to hand-carry a new bootstrap. Opt-in
   * only: falls back to `COORDINATION_RUNTIME_TOKEN_CACHE_PATH`, and with
   * neither set the client behaves exactly as before (in-memory only).
   *
   * Legacy static tokens (`broker: false`) are never written here. Treat the
   * file with the same handling care as the bootstrap itself: a location
   * outside the repository, never logged, never in shell history.
   */
  tokenCachePath?: string;
  /**
   * Optional cross-process credential persistence purpose-built for the
   * standalone CLI (coordination-cli.ts): it lets a second invocation in the
   * same container reuse the access token the first invocation exchanged,
   * automatically scoped by actor + runtime ID with no path to configure.
   * The main server's own long-running clients (alden/daniela/luca-holahola)
   * do not pass this and keep their credential in memory only, unless they
   * separately opt into `tokenCachePath` above.
   */
  credentialCache?: CoordinationCredentialCache;
};

type CachedCredential = {
  token: string;
  expiresAt: number | null;
  broker: boolean;
};

type PersistedCredential = {
  runtimeId: string;
  actor: string;
  token: string;
  expiresAt: number | null;
  broker: true;
};
export type CoordinationFeedOptions = {
  cursor?: number;
  limit?: number;
};

export type CoordinationInboxOptions = {
  token?: string;
  after?: number;
  limit?: number;
};

export type CoordinationThreadCreate = {
  title: string;
  description: string;
  intendedRecipient: Exclude<CoordinationActorId, 'coordination-system'>;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  sourceReference?: CoordinationEvidenceReference;
  /** Structured created-event payload; the server accepts only a valid hh.worker.job.v1. */
  payload?: Record<string, unknown>;
  idempotencyKey: string;
};

export type CoordinationEventInput = {
  content?: string;
  expectedSequence: number;
  idempotencyKey: string;
  recipientActor?: Exclude<CoordinationActorId, 'coordination-system'>;
  evidence?: CoordinationEvidenceReference[];
  payload?: Record<string, unknown>;
  causalParentEventId?: string;
};

export type AgentNoteReplyInput = {
  parentNoteId: string;
  body: string;
  idempotencyKey: string;
  subject?: string;
  sessionLabel?: string;
  /** Explicit lifecycle action; omitted replies remain notes-only. */
  eventType?: Exclude<CoordinationEventType, 'created' | 'delivered'>;
};

export type CompleteWithLinkedOutcomeClientInput = CoordinationEventInput & {
  reply: Omit<AgentNoteReplyInput, 'parentNoteId' | 'idempotencyKey'>;
};

export function coordinationClientActions(
  actor: DirectCoordinationActor,
): ReadonlySet<CoordinationClientAction> {
  return DIRECT_CLIENT_ACTIONS[actor];
}

function legacyTokenForActor(actor: CoordinationClientActor, environment: Environment): string | undefined {
  const envName = COORDINATION_TOKEN_ENV_BY_ACTOR[actor];
  const token = environment[envName]?.trim();
  if (!token) return undefined;
  if (token.length < 32) throw new Error(`${envName} must be at least 32 characters`);
  return token;
}

// Bootstrap tokens are minted by generateCoordinationSecret('cb') in
// coordination-credential-broker.ts: a "cb_" prefix followed by the unpadded
// base64url encoding of 32 random bytes, always 43 characters (46 total).
// This module intentionally never imports that broker file by value -- doing
// so would pull in server/db.ts, which throws at load time on any machine
// with no database credential configured, exactly the machines external
// runtimes like Claude Code run on (see coordination-auth.ts's import-chain
// comment and test-coordination-cli-hermetic-env.test.ts) -- so the shape is
// duplicated here as a plain pattern instead of imported.
// server/scripts/prepare-antigravity-provisioning.ts independently encodes
// the identical `^cb_[A-Za-z0-9_-]{43}$` shape for the same reason; keep the
// two in sync if either changes. test-coordination-actor-clients.test.ts
// cross-checks this pattern against real generateCoordinationSecret('cb')
// output so the two can never silently drift apart.
const BOOTSTRAP_TOKEN_PATTERN = /^cb_[A-Za-z0-9_-]{43}$/;

/**
 * Local, offline check for a mistyped or truncated bootstrap token -- by far
 * the most common cause of a wasted `invalid_bootstrap` round trip against
 * the live server (see docs/coordination-clients.md's "Diagnosing a failed
 * exchange"). Returns a description of what looks wrong, or undefined when
 * the token's shape is plausible. This cannot prove the token is *correct*
 * -- only the server's hash comparison can -- but it catches the copy/paste
 * mistakes that used to cost a full reissue-and-retry cycle just to diagnose.
 */
export function coordinationBootstrapTokenShapeIssue(token: string): string | undefined {
  if (BOOTSTRAP_TOKEN_PATTERN.test(token)) return undefined;
  if (!token.startsWith('cb_')) {
    return 'must start with "cb_" -- double-check this is the bootstrap token itself, not an access token (ct_) or another value';
  }
  if (token.length !== 46) {
    return `must be exactly 46 characters ("cb_" plus 43 base64url characters), but is ${token.length}; `
      + 'it looks truncated or has extra/stray characters from a copy/paste';
  }
  return 'must contain only letters, digits, "-", and "_" after the "cb_" prefix; '
    + 'it looks corrupted by a copy/paste (e.g. stray whitespace, a newline, or URL-encoding)';
}

function apiResult(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export class CoordinationActorClient {
  readonly actor: CoordinationClientActor;

  private readonly baseUrl: string;

  private readonly environment: Environment;

  private credential: CachedCredential | null;

  private renewalPromise: Promise<CachedCredential> | null = null;

  private readonly fetchImpl: FetchLike;

  private readonly tokenCachePath: string | undefined;

  private cacheLoadAttempted = false;

  private readonly credentialCache: CoordinationCredentialCache | undefined;

  constructor(
    actor: CoordinationClientActor,
    options: CoordinationActorClientOptions,
  ) {
    this.actor = actor;
    this.baseUrl = options.apiUrl.replace(/\/+$/, '');
    if (!this.baseUrl) throw new Error('Coordination API URL is required');
    this.environment = options.environment ?? process.env;
    const legacyToken = legacyTokenForActor(actor, this.environment);
    this.credential = legacyToken ? { token: legacyToken, expiresAt: null, broker: false } : null;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tokenCachePath =
      options.tokenCachePath?.trim() || this.environment.COORDINATION_RUNTIME_TOKEN_CACHE_PATH?.trim() || undefined;
    this.credentialCache = options.credentialCache;
  }

  /**
   * Cache-backed alternative to exchangeBootstrap() for a fresh process that
   * has no in-memory credential yet. Returns null (never throws) whenever
   * there is nothing usable to load, so the caller falls straight through to
   * a bootstrap exchange exactly as if no cache had been configured. Tries
   * `credentialCache` (the CLI's auto-scoped cache) first, then falls back
   * to the generic single-path `tokenCachePath` mechanism.
   */
  private async loadCachedCredential(): Promise<CachedCredential | null> {
    const runtimeId = this.environment.COORDINATION_RUNTIME_ID?.trim();
    if (!runtimeId) return null;

    if (this.credentialCache) {
      const cached = await this.credentialCache.load(this.actor, runtimeId);
      if (cached) {
        const expiresAt = Date.parse(cached.expiresAt);
        if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
          return { token: cached.accessToken, expiresAt, broker: true };
        }
        // Already expired: fall through exactly as if no cache entry existed
        // rather than ever presenting a stale credential anywhere.
      }
    }

    if (this.tokenCachePath) {
      let raw: string;
      try {
        raw = await readFile(this.tokenCachePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          console.warn(`[coordination-actor-client] ${this.actor}: token cache read failed, continuing without it`, error);
        }
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        console.warn(`[coordination-actor-client] ${this.actor}: token cache is not valid JSON, ignoring it`);
        return null;
      }
      if (typeof parsed !== 'object' || parsed === null) return null;
      const cached = parsed as Record<string, unknown>;
      if (
        cached.broker !== true
        || cached.actor !== this.actor
        || cached.runtimeId !== runtimeId
        || typeof cached.token !== 'string'
        || !cached.token
        || (cached.expiresAt !== null && typeof cached.expiresAt !== 'number')
      ) {
        console.warn(`[coordination-actor-client] ${this.actor}: token cache entry does not match this runtime/actor, ignoring it`);
        return null;
      }
      if (typeof cached.expiresAt === 'number' && cached.expiresAt <= Date.now()) {
        return null;
      }
      return { token: cached.token, expiresAt: cached.expiresAt as number | null, broker: true };
    }

    return null;
  }

  /**
   * Persists a broker-issued token so a later process (a CLI re-invocation
   * via `credentialCache`, or -- if `tokenCachePath` is configured -- a
   * restarted long-running client) can recover without a human re-issuing
   * credentials. Never lets a write failure fail the caller: both caches are
   * a convenience, not a trust boundary, and the caller already has a
   * perfectly valid in-memory credential regardless of what happens here.
   */
  private async persistCredential(credential: CachedCredential): Promise<void> {
    if (!credential.broker) return;
    const runtimeId = this.environment.COORDINATION_RUNTIME_ID?.trim();
    if (!runtimeId) return;

    if (this.credentialCache && credential.expiresAt !== null) {
      try {
        await this.credentialCache.save({
          actor: this.actor,
          runtimeId,
          accessToken: credential.token,
          expiresAt: new Date(credential.expiresAt).toISOString(),
        });
      } catch (error) {
        console.error(
          `[coordination-actor-client] could not cache credential for ${this.actor}: `
          + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (this.tokenCachePath) {
      const payload: PersistedCredential = {
        runtimeId,
        actor: this.actor,
        token: credential.token,
        expiresAt: credential.expiresAt,
        broker: true,
      };
      const tempPath = `${this.tokenCachePath}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(this.tokenCachePath), { recursive: true });
        await writeFile(tempPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
        await chmod(tempPath, 0o600);
        await rename(tempPath, this.tokenCachePath);
      } catch (error) {
        console.warn(`[coordination-actor-client] ${this.actor}: token cache write failed, continuing in-memory only`, error);
        await rm(tempPath, { force: true }).catch(() => undefined);
      }
    }
  }

  private async exchangeBootstrap(): Promise<CachedCredential> {
    const runtimeId = this.environment.COORDINATION_RUNTIME_ID?.trim();
    const bootstrap = this.environment.COORDINATION_RUNTIME_BOOTSTRAP_TOKEN?.trim();
    if (!runtimeId || !bootstrap) {
      const envName = COORDINATION_TOKEN_ENV_BY_ACTOR[this.actor];
      throw new Error(
        `${this.actor} coordination authentication is not configured; set ${envName} during migration or set COORDINATION_RUNTIME_ID and COORDINATION_RUNTIME_BOOTSTRAP_TOKEN`,
      );
    }
    const shapeIssue = coordinationBootstrapTokenShapeIssue(bootstrap);
    if (shapeIssue) {
      throw new Error(
        `COORDINATION_RUNTIME_BOOTSTRAP_TOKEN ${shapeIssue}. Checked locally before contacting the server, `
        + 'so no reissue is needed for this -- fix the value in this runtime\'s secret store and retry.',
      );
    }
    const response = await this.fetchImpl(new URL('/api/coordination/credentials/exchange', `${this.baseUrl}/`), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-coordination-bootstrap': bootstrap,
      },
      body: JSON.stringify({ runtimeId }),
    });
    const result = apiResult(await response.text());
    if (!response.ok || typeof result !== 'object' || result === null) {
      const reason = typeof result === 'object' && result !== null && typeof (result as Record<string, unknown>).reason === 'string'
        ? (result as Record<string, unknown>).reason as string
        : undefined;
      // A reissue only helps when the runtime registration itself is fine and
      // just needs a fresh bootstrap secret; it fails with runtime_not_found
      // for unknown_runtime, so don't suggest it there or for a client-side
      // missing_credentials bug.
      const reissuable = reason === 'bootstrap_already_consumed'
        || reason === 'consumed_bootstrap_digest_conflict'
        || reason === 'invalid_bootstrap';
      throw new Error(
        `Coordination credential exchange failed (${response.status})${reason ? `: ${reason}` : ''} for runtime ${runtimeId}`
        + (reissuable
          ? '; an operator must reissue it in place with '
            + `\`npx tsx server/scripts/coordination-runtime-rotation.ts reissue --runtime-id ${runtimeId}\` `
            + 'and inject the new token before this process can authenticate again'
          : ''),
      );
    }
    const payload = result as Record<string, unknown>;
    if (payload.actor !== this.actor || typeof payload.accessToken !== 'string' || typeof payload.expiresAt !== 'string') {
      throw new Error('Coordination credential exchange returned an invalid or cross-actor credential');
    }
    const credential: CachedCredential = {
      token: payload.accessToken,
      expiresAt: Date.parse(payload.expiresAt),
      broker: true,
    };
    await this.persistCredential(credential);
    return credential;
  }

  private async currentCredential(): Promise<CachedCredential> {
    if (!this.credential && !this.cacheLoadAttempted) {
      this.cacheLoadAttempted = true;
      this.credential = await this.loadCachedCredential();
    }
    if (!this.credential) {
      this.credential = await this.exchangeBootstrap();
    } else if (
      this.credential.broker
      && this.credential.expiresAt !== null
      && this.credential.expiresAt - Date.now() < 60_000
    ) {
      this.renewalPromise ??= this.renewCredential(this.credential);
      try {
        this.credential = await this.renewalPromise;
      } finally {
        this.renewalPromise = null;
      }
    }
    return this.credential;
  }

  private async renewCredential(current: CachedCredential): Promise<CachedCredential> {
      const response = await this.fetchImpl(new URL('/api/coordination/credentials/renew', `${this.baseUrl}/`), {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-coordination-token': current.token,
        },
        body: '{}',
      });
      const result = apiResult(await response.text()) as Record<string, unknown>;
      if (!response.ok || result.actor !== this.actor || typeof result.accessToken !== 'string' || typeof result.expiresAt !== 'string') {
        throw new Error(`Coordination credential renewal failed (${response.status})`);
      }
      const credential: CachedCredential = {
        token: result.accessToken,
        expiresAt: Date.parse(result.expiresAt),
        broker: true,
      };
      await this.persistCredential(credential);
      return credential;
  }

  private assertAllowed(action: CoordinationClientAction): void {
    if (
      (this.actor === 'luca-holahola' || this.actor === 'alden' || this.actor === 'daniela')
      && !DIRECT_CLIENT_ACTIONS[this.actor].has(action)
    ) {
      throw new Error(`${this.actor} coordination client cannot perform ${action}`);
    }
  }

  private async request(
    action: CoordinationClientAction,
    path: string,
    options: { body?: Record<string, unknown>; idempotencyKey?: string } = {},
  ): Promise<unknown> {
    this.assertAllowed(action);
    const credential = await this.currentCredential();
    const response = await this.fetchImpl(new URL(path, `${this.baseUrl}/`), {
      method: options.body ? 'POST' : 'GET',
      headers: {
        accept: 'application/json',
        'x-coordination-token': credential.token,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const result = apiResult(await response.text());
    if (!response.ok) {
      const message = typeof result === 'object' && result !== null && 'error' in result
        ? String((result as { error: unknown }).error)
        : JSON.stringify(result);
      throw new Error(`Coordination ${action} failed (${response.status}): ${message}`);
    }
    return result;
  }

  listFeed(options: CoordinationFeedOptions = {}): Promise<unknown> {
    const query = new URLSearchParams();
    if (options.cursor !== undefined) query.set('cursor', String(options.cursor));
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    return this.request('list', `/api/coordination/threads${query.size ? `?${query}` : ''}`);
  }

  acknowledgeFeed(globalSequence: number): Promise<unknown> {
    if (!Number.isSafeInteger(globalSequence) || globalSequence < 0) {
      throw new Error('Coordination feed cursor must be a non-negative integer');
    }
    return this.request('acknowledge-feed', '/api/coordination/threads/ack', {
      body: { globalSequence },
    });
  }

  listInbox(options: CoordinationInboxOptions = {}): Promise<unknown> {
    const query = new URLSearchParams();
    if (options.token !== undefined) query.set('token', options.token);
    if (options.after !== undefined) query.set('after', String(options.after));
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    return this.request(
      'list-inbox',
      `/api/coordination/inbox${query.size ? `?${query}` : ''}`,
    );
  }

  acknowledgeInbox(windowToken: string): Promise<unknown> {
    if (!windowToken) throw new Error('Coordination inbox window token is required');
    return this.request('acknowledge-inbox', '/api/coordination/inbox/ack', {
      body: { windowToken },
    });
  }

  show(threadId: string, afterSequence = 0): Promise<unknown> {
    const query = afterSequence ? `?afterSequence=${encodeURIComponent(String(afterSequence))}` : '';
    return this.request('show', `/api/coordination/threads/${encodeURIComponent(threadId)}${query}`);
  }

  create(input: CoordinationThreadCreate): Promise<unknown> {
    return this.request('create', '/api/coordination/threads', {
      body: {
        title: input.title,
        description: input.description,
        intendedRecipient: input.intendedRecipient,
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.sourceReference ? { sourceReference: input.sourceReference } : {}),
        ...(input.payload ? { payload: input.payload } : {}),
      },
      idempotencyKey: input.idempotencyKey,
    });
  }

  private event(
    action: CoordinationClientAction,
    threadId: string,
    eventType: CoordinationEventType,
    input: CoordinationEventInput,
  ): Promise<unknown> {
    return this.request(action, `/api/coordination/threads/${encodeURIComponent(threadId)}/events`, {
      body: {
        eventType,
        content: input.content ?? '',
        expectedSequence: input.expectedSequence,
        ...(input.recipientActor ? { recipientActor: input.recipientActor } : {}),
        ...(input.evidence ? { evidence: input.evidence } : {}),
        ...(input.payload ? { payload: input.payload } : {}),
        ...(input.causalParentEventId ? { causalParentEventId: input.causalParentEventId } : {}),
      },
      idempotencyKey: input.idempotencyKey,
    });
  }

  accept(threadId: string, input: CoordinationEventInput): Promise<unknown> {
    return this.event('accept', threadId, 'accepted', input);
  }

  progress(threadId: string, input: CoordinationEventInput): Promise<unknown> {
    return this.event('progress', threadId, 'progress', input);
  }

  evidence(threadId: string, input: CoordinationEventInput): Promise<unknown> {
    return this.event('evidence', threadId, 'evidence_added', input);
  }

  block(threadId: string, input: CoordinationEventInput): Promise<unknown> {
    return this.event('block', threadId, 'blocked', input);
  }

  complete(threadId: string, input: CoordinationEventInput): Promise<unknown> {
    return this.event('complete', threadId, 'completed', input);
  }

  acknowledge(threadId: string, input: CoordinationEventInput): Promise<unknown> {
    return this.event('acknowledge', threadId, 'outcome_acknowledged', input);
  }

  reopen(threadId: string, input: CoordinationEventInput): Promise<unknown> {
    return this.event('reopen', threadId, 'reopened', input);
  }

  reassign(threadId: string, input: CoordinationEventInput): Promise<unknown> {
    return this.event('reassign', threadId, 'reassigned', input);
  }

  comment(threadId: string, input: CoordinationEventInput): Promise<unknown> {
    return this.event('comment', threadId, 'comment', input);
  }

  /** Returns delivered only after the server rereads the exact reply row from
   * the recipient inbox. This intentionally says nothing about later states. */
  replyAndVerify(input: AgentNoteReplyInput): Promise<unknown> {
    if (this.actor !== 'luca-replit' && this.actor !== 'luca-claude-code') {
      throw new Error(`${this.actor} coordination client cannot reply to an agent note`);
    }
    return this.request('reply-and-verify', `/api/agent/notes/${encodeURIComponent(input.parentNoteId)}/reply`, {
      body: {
        body: input.body,
        ...(input.subject ? { subject: input.subject } : {}),
        ...(input.sessionLabel ? { session_label: input.sessionLabel } : {}),
        ...(input.eventType ? { eventType: input.eventType } : {}),
      },
      idempotencyKey: input.idempotencyKey,
    });
  }

  completeWithLinkedOutcome(
    threadId: string,
    input: CompleteWithLinkedOutcomeClientInput,
  ): Promise<unknown> {
    if (this.actor !== 'luca-replit' && this.actor !== 'luca-claude-code') {
      throw new Error(`${this.actor} coordination client cannot complete agent-note-origin work`);
    }
    return this.request(
      'complete-with-linked-outcome',
      `/api/coordination/threads/${encodeURIComponent(threadId)}/complete-with-linked-outcome`,
      {
        body: {
          content: input.content ?? 'Work completed',
          expectedSequence: input.expectedSequence,
          ...(input.evidence ? { evidence: input.evidence } : {}),
          ...(input.causalParentEventId ? { causalParentEventId: input.causalParentEventId } : {}),
          reply: {
            body: input.reply.body,
            ...(input.reply.subject ? { subject: input.reply.subject } : {}),
            ...(input.reply.sessionLabel ? { sessionLabel: input.reply.sessionLabel } : {}),
          },
        },
        idempotencyKey: input.idempotencyKey,
      },
    );
  }
}

export function createCoordinationActorClient(
  actor: CoordinationClientActor,
  options: CoordinationActorClientOptions,
): CoordinationActorClient {
  return new CoordinationActorClient(actor, options);
}

export interface CoordinationCredentialCache {
  load(actor: CoordinationClientActor, runtimeId: string): Promise<CoordinationCredentialCacheEntry | null>;
  save(entry: CoordinationCredentialCacheEntry): Promise<void>;
}
