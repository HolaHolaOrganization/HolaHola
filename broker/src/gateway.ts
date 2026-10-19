// Operation gateway (costed plan ff04f70e, phase 2b; luca-replit design event 2369).
//
// Every mutating operation runs through executeOnce:
//   claim (write-ahead audit) -> preflight -> exactly one dispatch -> outcome.
// The preflight runs after the claim and after every preparatory await
// (installation token, PR or ref lookup) and then re-runs the FULL
// authorization against freshly loaded policy and a fresh clock, so a cached
// token is never cached authorization. A failed preflight is a winner-only
// "aborted". A dispatch whose result is unknown (network error, timeout, 5xx)
// is never resent: it stays uncertain and can only be reconciled to "applied"
// from operation-specific evidence.
//
// Repository, PR and ref identity come from trusted configuration plus the
// signed envelope, never from the payload. There is no passthrough and no
// force or overwrite option.

import { type KeyObject } from 'node:crypto';
import { decide, type LoaderFor } from './authorize.ts';
import { type ClaimEntry, type EffectResult, executeOnce, type ExecutionOutcome, type Ledger, type Reconciler, statusOf } from './claims.ts';
import { type Envelope, type Operation, verifyOriginalSignature } from './envelope.ts';
import { type GitHubApi, GitHubError, InstallationToken } from './github.ts';

export type ActorBinding = {
  appId: number;
  installationId: number;
  privateKey: KeyObject;
  /** The App's bot login, for example "holahola-luca-claude-code[bot]". */
  botLogin: string;
};

export type GatewayConfig = {
  repo: { owner: string; name: string; id: number };
  actors: ReadonlyMap<string, ActorBinding>;
  api: GitHubApi;
  ledger: Ledger;
  loaderFor: LoaderFor;
  now?: () => number;
};

export type GatewayResult =
  | { status: number; body: { decision: 'deny'; reason: string; operationId?: string } }
  | { status: number; body: Record<string, unknown> };

const MARKER_PREFIX = 'holahola-broker-op';
const BRANCH = /^(?!\/)(?!.*\.\.)(?!refs\/)[A-Za-z0-9._/-]{1,200}$/;
const PATH = /^(?!\/)(?!.*\.\.)[^\0]{1,400}$/;
const SHA1_HEX = /^[0-9a-f]{40}$/;
const MAX_TEXT = 60_000;
const PROTECTED_BRANCHES = new Set(['main']);
const WRITE_PERMISSIONS = { contents: 'write', pull_requests: 'write', issues: 'write' } as const;
const READ_PERMISSIONS = { contents: 'read', pull_requests: 'read', issues: 'read' } as const;

type Payload = Record<string, unknown>;

function exact(payload: unknown, required: string[], optional: string[] = []): Payload | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const keys = Object.keys(payload);
  if (!keys.every((key) => required.includes(key) || optional.includes(key))) return null;
  if (!required.every((key) => key in payload)) return null;
  return payload as Payload;
}

/** Caller text: bounded, and never able to contain a broker marker (markers must be unforgeable). */
function text(value: unknown, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= MAX_TEXT && (allowEmpty || value.trim().length > 0)
    && !value.toLowerCase().includes(MARKER_PREFIX);
}

function branchName(value: unknown): value is string {
  return typeof value === 'string' && BRANCH.test(value) && !value.endsWith('/') && !PROTECTED_BRANCHES.has(value);
}

/** Strict per-operation payload validation. Returns the normalised payload or null. */
export function validatePayload(envelope: Envelope, payload: unknown): Payload | null {
  const needsPr = envelope.pr !== null && envelope.headSha !== null;
  switch (envelope.operation) {
    case 'read':
      return needsPr ? exact(payload, []) : null;
    case 'status': {
      const p = exact(payload, ['original']);
      return p && envelope.pr === null && envelope.headSha === null && typeof p.original === 'object' && p.original !== null ? p : null;
    }
    case 'pr.comment': {
      const p = exact(payload, ['body']);
      return p && needsPr && text(p.body) ? p : null;
    }
    case 'pr.review': {
      const p = exact(payload, ['event', 'body']);
      return p && needsPr && ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(p.event as string) && text(p.body, p.event === 'APPROVE') ? p : null;
    }
    case 'pr.merge':
    case 'pr.close':
    case 'pr.update-branch':
      return needsPr ? exact(payload, []) : null;
    case 'pr.edit': {
      const p = exact(payload, [], ['title', 'body']);
      if (!p || !needsPr || (p.title === undefined && p.body === undefined)) return null;
      if (p.title !== undefined && !(text(p.title) && (p.title as string).length <= 256)) return null;
      if (p.body !== undefined && !text(p.body, true)) return null;
      return p;
    }
    case 'pr.open': {
      const p = exact(payload, ['branch', 'title', 'body']);
      return p && envelope.pr === null && envelope.headSha !== null && branchName(p.branch)
        && text(p.title) && (p.title as string).length <= 256 && text(p.body, true) ? p : null;
    }
    case 'branch.create': {
      const p = exact(payload, ['branch']);
      return p && envelope.pr === null && envelope.headSha !== null && branchName(p.branch) ? p : null;
    }
    case 'commit.write': {
      const p = exact(payload, ['branch', 'message', 'additions', 'deletions']);
      if (!p || envelope.headSha === null || !branchName(p.branch) || !text(p.message)) return null;
      const additions = p.additions, deletions = p.deletions;
      if (!Array.isArray(additions) || !Array.isArray(deletions) || additions.length + deletions.length === 0 || additions.length + deletions.length > 100) return null;
      const seen = new Set<string>();
      for (const item of additions) {
        const a = exact(item, ['path', 'contentBase64']);
        if (!a || typeof a.path !== 'string' || !PATH.test(a.path) || typeof a.contentBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.contentBase64) || seen.has(a.path)) return null;
        seen.add(a.path);
      }
      for (const item of deletions) {
        const d = exact(item, ['path']);
        if (!d || typeof d.path !== 'string' || !PATH.test(d.path) || seen.has(d.path)) return null;
        seen.add(d.path);
      }
      return p;
    }
    default:
      return null; // branch.delete and anything unnamed: no adapter.
  }
}

/** Broker-generated evidence markers, bound to the operation id and request digest. */
export function markerFor(operationId: string, digest: string): { html: string; trailer: string } {
  const tag = `${operationId}:${digest.slice(0, 16)}`;
  return { html: `<!-- ${MARKER_PREFIX}:${tag} -->`, trailer: `Holahola-Broker-Op: ${tag}` };
}

type Pull = {
  number: number; state: string; merged?: boolean; merge_commit_sha?: string | null; title: string; body: string | null;
  user: { login: string }; head: { sha: string; ref: string; repo: { id: number } | null }; base: { ref: string; repo: { id: number } };
};

type Context = { token: string; pull?: Pull };

export class Gateway {
  private readonly config: GatewayConfig;
  private readonly now: () => number;
  private readonly tokens = new Map<string, InstallationToken>();
  private readonly readTokens = new Map<string, InstallationToken>();

  constructor(config: GatewayConfig) {
    this.config = config;
    this.now = config.now ?? Date.now;
  }

  private repoPath(): string {
    return `/repos/${this.config.repo.owner}/${this.config.repo.name}`;
  }

  private tokenFor(actor: string, binding: ActorBinding): InstallationToken {
    let token = this.tokens.get(actor);
    if (!token) {
      token = new InstallationToken(this.config.api, {
        appId: binding.appId, installationId: binding.installationId, privateKey: binding.privateKey,
        repositoryId: this.config.repo.id, permissions: { ...WRITE_PERMISSIONS },
      }, this.now);
      this.tokens.set(actor, token);
    }
    return token;
  }

  private readTokenFor(actor: string, binding: ActorBinding): InstallationToken {
    let token = this.readTokens.get(actor);
    if (!token) {
      token = new InstallationToken(this.config.api, {
        appId: binding.appId, installationId: binding.installationId, privateKey: binding.privateKey,
        repositoryId: this.config.repo.id, permissions: { ...READ_PERMISSIONS },
      }, this.now);
      this.readTokens.set(actor, token);
    }
    return token;
  }

  /**
   * Full re-authorization of the signed request after preparatory awaits:
   * fresh policy and clock, the same digest and epoch as on arrival, and the
   * configured App/installation equal to the policy's binding for the actor.
   */
  private async reauthorize(body: unknown, envelope: Envelope, digest: string, epoch: string, binding: ActorBinding): Promise<{ ok: true } | { ok: false; reason: string }> {
    const again = await decide(body, this.config.loaderFor, this.now);
    if (again.decision !== 'allow') return { ok: false, reason: again.reason };
    if (again.authorized.digest !== digest || again.authorized.policy.epoch !== epoch) return { ok: false, reason: 'stale_policy_epoch' };
    const policyActor = again.authorized.policy.actors.get(envelope.actor);
    if (!policyActor || policyActor.appId !== binding.appId || policyActor.installationId !== binding.installationId) {
      return { ok: false, reason: 'binding_mismatch' };
    }
    return { ok: true };
  }

  private async getPull(token: string, pr: number): Promise<Pull> {
    return await this.config.api.rest(token, 'GET', `${this.repoPath()}/pulls/${pr}`) as Pull;
  }

  private async refSha(token: string, branch: string): Promise<string | null> {
    const ref = await this.config.api.rest(token, 'GET', `${this.repoPath()}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, undefined, true) as { object?: { sha?: string } } | null;
    return ref?.object?.sha ?? null;
  }

  /**
   * Executes an authorized request. `body` is the original signed request,
   * re-authorized in the preflight; `envelope`, `digest`, `payload` and
   * `epoch` come from the arrival-time decision.
   */
  async execute(body: unknown, envelope: Envelope, digest: string, payload: unknown, epoch: string): Promise<GatewayResult> {
    const deny = (reason: string) => ({ status: 403, body: { decision: 'deny' as const, reason, operationId: envelope.operationId } });
    const binding = this.config.actors.get(envelope.actor);
    if (!binding) return deny('unknown_actor');
    const valid = validatePayload(envelope, payload);
    if (!valid) return deny('malformed_payload');

    if (envelope.operation === 'read') return this.read(body, envelope, digest, epoch, valid, binding);
    if (envelope.operation === 'status') return this.status(body, envelope, digest, epoch, valid.original, binding);

    const ctx: Context = { token: '' };
    const marker = markerFor(envelope.operationId, digest);
    const preflight = async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
      const readToken = await this.readTokenFor(envelope.actor, binding).get();
      const live = await this.liveCheck(envelope, valid, binding, readToken, ctx);
      if (!live.ok) return live;
      ctx.token = await this.tokenFor(envelope.actor, binding).get();
      // Last: full re-authorization after every preparatory await.
      return this.reauthorize(body, envelope, digest, epoch, binding);
    };

    const entry: ClaimEntry = {
      actor: envelope.actor, operationId: envelope.operationId, digest, operation: envelope.operation,
      pr: envelope.pr, headSha: envelope.headSha, policyEpoch: epoch,
    };
    let outcome: ExecutionOutcome;
    try {
      outcome = await executeOnce(
        this.config.ledger, entry,
        () => this.dispatch(envelope, valid, marker, ctx),
        this.reconciler(envelope, valid, marker, binding),
        this.now, preflight,
      );
    } catch {
      return deny('ledger_unavailable');
    }
    return toResult(outcome, envelope.operationId);
  }

  private async read(body: unknown, envelope: Envelope, digest: string, epoch: string, payload: Payload, binding: ActorBinding): Promise<GatewayResult> {
    const deny = (reason: string) => ({ status: 403, body: { decision: 'deny' as const, reason, operationId: envelope.operationId } });
    const ctx: Context = { token: '' };
    const live = await this.liveCheck(envelope, payload, binding, await this.readTokenFor(envelope.actor, binding).get(), ctx);
    if (!live.ok) return deny(live.reason);
    const again = await this.reauthorize(body, envelope, digest, epoch, binding);
    if (!again.ok) return deny(again.reason);
    const pull = ctx.pull as Pull;
    return {
      status: 200,
      body: {
        decision: 'read', operationId: envelope.operationId,
        pull: { number: pull.number, state: pull.state, merged: pull.merged ?? false, headSha: pull.head.sha, headRef: pull.head.ref, author: pull.user.login },
      },
    };
  }

  /**
   * Status of an earlier operation (luca-replit phase 2b review, finding 1).
   * The status request itself was fully authorized on arrival (fresh
   * signature, current policy, not closed). It carries the ORIGINAL signed
   * request, which is authenticated by signature only, so its digest equals
   * the stored claim's. It must name the same actor. The claim is looked up,
   * never created; its recorded outcome is returned or positively
   * reconciled; nothing is ever executed or resent.
   */
  private async status(body: unknown, envelope: Envelope, digest: string, epoch: string, original: unknown, binding: ActorBinding): Promise<GatewayResult> {
    const deny = (reason: string) => ({ status: 403, body: { decision: 'deny' as const, reason, operationId: envelope.operationId } });
    const policy = await this.config.loaderFor(envelope.actor)?.current();
    if (!policy) return deny('no_policy');
    const verified = verifyOriginalSignature(original, policy);
    if (!verified.ok) return deny(`original_${verified.reason}`);
    const origin = verified.envelope;
    if (origin.actor !== envelope.actor) return deny('actor_mismatch');
    if (origin.operation === 'status' || origin.operation === 'read') return deny('not_a_claim');
    const originPayload = validatePayload(origin, (original as { payload: unknown }).payload);
    if (!originPayload) return deny('original_malformed_payload');
    await this.readTokenFor(envelope.actor, binding).get();
    const again = await this.reauthorize(body, envelope, digest, epoch, binding);
    if (!again.ok) return deny(again.reason);
    const entry: ClaimEntry = {
      actor: origin.actor, operationId: origin.operationId, digest: verified.digest, operation: origin.operation,
      pr: origin.pr, headSha: origin.headSha, policyEpoch: origin.policyEpoch,
    };
    let outcome: ExecutionOutcome;
    try {
      outcome = await statusOf(this.config.ledger, entry,
        this.reconciler(origin, originPayload, markerFor(origin.operationId, verified.digest), binding), this.now);
    } catch {
      return deny('ledger_unavailable');
    }
    return toResult(outcome, origin.operationId);
  }

  /** Binds the request to live GitHub state. Runs inside the preflight, after the token await. */
  private async liveCheck(envelope: Envelope, payload: Payload, binding: ActorBinding, readToken: string, ctx: Context): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (envelope.pr !== null) {
      const pull = await this.getPull(readToken, envelope.pr);
      ctx.pull = pull;
      if (pull.base.repo.id !== this.config.repo.id) return { ok: false, reason: 'wrong_repository' };
      if (pull.head.repo?.id !== this.config.repo.id) return { ok: false, reason: 'fork_head' };
      if (pull.state !== 'open' && envelope.operation !== 'read') return { ok: false, reason: 'pr_not_open' };
      if (pull.head.sha !== envelope.headSha) return { ok: false, reason: 'head_moved' };
      if (envelope.operation === 'pr.review' && pull.user.login === binding.botLogin) return { ok: false, reason: 'self_review' };
      if (envelope.operation === 'commit.write' && pull.head.ref !== payload.branch) return { ok: false, reason: 'branch_not_pr_head' };
      return { ok: true };
    }
    const branch = payload.branch as string;
    const sha = await this.refSha(readToken, branch);
    if (envelope.operation === 'branch.create') return sha === null ? { ok: true } : { ok: false, reason: 'branch_exists' };
    if (sha !== envelope.headSha) return { ok: false, reason: 'head_moved' };
    return { ok: true };
  }

  /** Exactly one request. Definite GitHub rejections are "failed"; unknown results throw (uncertain). */
  private async dispatch(envelope: Envelope, payload: Payload, marker: { html: string; trailer: string }, ctx: Context): Promise<EffectResult> {
    const api = this.config.api, repo = this.repoPath(), token = ctx.token, pr = envelope.pr, head = envelope.headSha as string;
    try {
      switch (envelope.operation as Exclude<Operation, 'read' | 'branch.delete'>) {
        case 'pr.comment': {
          const r = await api.rest(token, 'POST', `${repo}/issues/${pr}/comments`, { body: `${payload.body}\n\n${marker.html}` }) as { id: number };
          return { status: 'succeeded', result: { commentId: r.id } };
        }
        case 'pr.review': {
          const r = await api.rest(token, 'POST', `${repo}/pulls/${pr}/reviews`, { commit_id: head, event: payload.event, body: `${payload.body}\n\n${marker.html}` }) as { id: number };
          return { status: 'succeeded', result: { reviewId: r.id } };
        }
        case 'pr.merge': {
          const r = await api.rest(token, 'PUT', `${repo}/pulls/${pr}/merge`, { merge_method: 'squash', sha: head }) as { sha: string };
          return { status: 'succeeded', result: { mergeSha: r.sha } };
        }
        case 'pr.close': {
          await api.rest(token, 'PATCH', `${repo}/pulls/${pr}`, { state: 'closed' });
          return { status: 'succeeded', result: {} };
        }
        case 'pr.edit': {
          const update: Record<string, string> = {};
          if (payload.title !== undefined) update.title = payload.title as string;
          if (payload.body !== undefined) update.body = `${payload.body}\n\n${marker.html}`;
          await api.rest(token, 'PATCH', `${repo}/pulls/${pr}`, update);
          return { status: 'succeeded', result: {} };
        }
        case 'pr.update-branch': {
          await api.rest(token, 'PUT', `${repo}/pulls/${pr}/update-branch`, { expected_head_sha: head });
          return { status: 'succeeded', result: {} };
        }
        case 'pr.open': {
          const r = await api.rest(token, 'POST', `${repo}/pulls`, { head: payload.branch, base: 'main', title: payload.title, body: `${payload.body}\n\n${marker.html}` }) as { number: number };
          return { status: 'succeeded', result: { pr: r.number } };
        }
        case 'branch.create': {
          await api.rest(token, 'POST', `${repo}/git/refs`, { ref: `refs/heads/${payload.branch}`, sha: head });
          return { status: 'succeeded', result: {} };
        }
        case 'commit.write': {
          const additions = (payload.additions as Array<{ path: string; contentBase64: string }>).map((a) => ({ path: a.path, contents: a.contentBase64 }));
          const deletions = (payload.deletions as Array<{ path: string }>).map((d) => ({ path: d.path }));
          const { data, errors } = await api.graphql(token, `mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }`, {
            input: {
              branch: { repositoryNameWithOwner: `${this.config.repo.owner}/${this.config.repo.name}`, branchName: payload.branch },
              message: { headline: payload.message, body: marker.trailer },
              expectedHeadOid: head,
              fileChanges: { additions, deletions },
            },
          });
          // luca-replit phase 2b review, finding 2: GraphQL can report errors
          // alongside an applied mutation, and no error class (including
          // STALE_DATA, pending live qualification) is yet proven to mean "not
          // applied". So only a returned commit oid is terminal (succeeded);
          // any other response is unknown and stays uncertain -- never "failed".
          const oid = (data as { createCommitOnBranch?: { commit?: { oid?: string } } } | null)?.createCommitOnBranch?.commit?.oid;
          if (typeof oid === 'string' && SHA1_HEX.test(oid)) return { status: 'succeeded', result: { commitSha: oid } };
          throw new Error(`commit result unknown (${errors.length} graphql errors)`);
        }
      }
    } catch (error) {
      // 4xx is a definite rejection; everything else (5xx, timeout, network, malformed) is unknown.
      if (error instanceof GitHubError && error.status >= 400 && error.status < 500) return { status: 'failed', result: { http: error.status } };
      throw error;
    }
    throw new Error('unreachable');
  }

  /**
   * Positive-only evidence, bound to this repository, target, App identity and
   * the claim's head/payload. Markers are broker-generated and callers cannot
   * write them (validatePayload rejects marker text). Where no reliable
   * evidence exists the result is not_observed or ambiguous, never negative.
   */
  private reconciler(envelope: Envelope, payload: Payload, marker: { html: string; trailer: string }, binding: ActorBinding): Reconciler {
    return async (): ReturnType<Reconciler> => {
      const api = this.config.api, repo = this.repoPath(), pr = envelope.pr, head = envelope.headSha;
      let token: string;
      try {
        token = await this.readTokenFor(envelope.actor, binding).get();
      } catch {
        return { status: 'ambiguous' };
      }
      const list = async <T>(path: string): Promise<T[]> => {
        const items: T[] = [];
        for (let page = 1; page <= 10; page += 1) {
          const batch = await api.rest(token, 'GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`) as T[];
          items.push(...batch);
          if (batch.length < 100) break;
        }
        return items;
      };
      try {
        switch (envelope.operation) {
          case 'pr.comment': {
            const found = (await list<{ id: number; user: { login: string }; body: string }>(`${repo}/issues/${pr}/comments`))
              .find((c) => c.user.login === binding.botLogin && c.body.endsWith(marker.html));
            return found ? { status: 'applied', result: { commentId: found.id } } : { status: 'not_observed' };
          }
          case 'pr.review': {
            const found = (await list<{ id: number; user: { login: string }; body: string; commit_id: string }>(`${repo}/pulls/${pr}/reviews`))
              .find((r) => r.user.login === binding.botLogin && r.commit_id === head && r.body.endsWith(marker.html));
            return found ? { status: 'applied', result: { reviewId: found.id } } : { status: 'not_observed' };
          }
          case 'pr.merge': {
            const pull = await this.getPull(token, pr as number);
            return pull.merged && pull.head.sha === head && typeof pull.merge_commit_sha === 'string'
              ? { status: 'applied', result: { mergeSha: pull.merge_commit_sha } } : { status: 'not_observed' };
          }
          case 'pr.close': {
            const pull = await this.getPull(token, pr as number);
            return pull.state === 'closed' && !pull.merged ? { status: 'applied', result: {} } : { status: 'not_observed' };
          }
          case 'pr.edit': {
            const pull = await this.getPull(token, pr as number);
            const titleOk = payload.title === undefined || pull.title === payload.title;
            const bodyOk = payload.body === undefined || pull.body === `${payload.body}\n\n${marker.html}`;
            return titleOk && bodyOk ? { status: 'applied', result: {} } : { status: 'not_observed' };
          }
          case 'pr.open': {
            const found = (await list<{ number: number; user: { login: string }; body: string | null; base: { ref: string } }>(`${repo}/pulls?state=all&head=${this.config.repo.owner}:${encodeURIComponent(payload.branch as string)}`))
              .find((p) => p.user.login === binding.botLogin && p.base.ref === 'main' && (p.body ?? '').endsWith(marker.html));
            return found ? { status: 'applied', result: { pr: found.number } } : { status: 'not_observed' };
          }
          case 'branch.create': {
            const sha = await this.refSha(token, payload.branch as string);
            return sha === head ? { status: 'applied', result: {} } : { status: 'not_observed' };
          }
          case 'commit.write': {
            const commits = await api.rest(token, 'GET', `${repo}/commits?sha=${encodeURIComponent(payload.branch as string)}&per_page=50`) as
              Array<{ sha: string; commit: { message: string }; parents: Array<{ sha: string }>; author: { login: string } | null }>;
            const found = commits.find((c) => c.commit.message.includes(marker.trailer) && c.parents[0]?.sha === head && c.author?.login === binding.botLogin);
            return found ? { status: 'applied', result: { commitSha: found.sha } } : { status: 'not_observed' };
          }
          default:
            // pr.update-branch: GitHub offers no operation-bound evidence; never guess.
            return { status: 'ambiguous' };
        }
      } catch {
        return { status: 'ambiguous' };
      }
    };
  }
}

function toResult(outcome: ExecutionOutcome, operationId: string): GatewayResult {
  switch (outcome.kind) {
    case 'executed': return { status: 200, body: { decision: 'executed', operationId, status: outcome.outcome.status, result: outcome.outcome.result } };
    case 'recorded': return { status: 200, body: { decision: 'recorded', operationId, status: outcome.outcome.status, result: outcome.outcome.result } };
    case 'aborted': return { status: 409, body: { decision: 'aborted', operationId, result: outcome.outcome.result } };
    case 'pending': return { status: 202, body: { decision: 'pending', operationId } };
    case 'uncertain': return { status: 202, body: { decision: 'uncertain', operationId } };
    case 'digest_conflict': return { status: 409, body: { decision: 'deny', reason: 'digest_conflict', operationId } };
    case 'not_found': return { status: 404, body: { decision: 'not_found', operationId } };
  }
}
