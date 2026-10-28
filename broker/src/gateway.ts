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
import { type ClaimEntry, type EffectResult, executeOnce, type ExecutionOutcome, type Ledger, type OutcomeRecord, readRecorded, type Reconciler, statusOf } from './claims.ts';
import { type Envelope, type Operation, verifyOriginalSignature } from './envelope.ts';
import { type GitHubApi, GitHubError, InstallationToken } from './github.ts';
import { BASE_REF, PUBLICATION_OPERATIONS, type PublicationOperation, type TreeEntry, validatePublication, withTrailer, ZERO_OID } from './publication.ts';

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
const SHA1_HEX = /^[0-9a-f]{40}$/;
const ACTOR = /^[a-z][a-z0-9-]{1,62}$/;
const OPERATION_ID = /^[A-Za-z0-9_-]{16,128}$/;
const BROKER_TRAILER = /^Holahola-Broker-Op: ([A-Za-z0-9_-]{16,128}):[0-9a-f]{16}$/m;
/** GitHub's pull-request commits endpoint returns at most 250 commits. */
const MAX_PR_COMMITS = 250;

function sha(value: unknown): value is string {
  return typeof value === 'string' && SHA1_HEX.test(value);
}
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
      // The review tuple (design section 3): repository (fixed), PR and head
      // (envelope), plus the exact base commit and head tree.
      const p = exact(payload, ['event', 'body', 'baseSha', 'headTreeSha']);
      return p && needsPr && ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(p.event as string) && text(p.body, p.event === 'APPROVE')
        && sha(p.baseSha) && sha(p.headTreeSha) ? p : null;
    }
    case 'pr.enqueue': {
      // Names the recorded broker review that authorizes this exact head.
      const p = exact(payload, ['reviewActor', 'reviewOperationId']);
      return p && needsPr && typeof p.reviewActor === 'string' && ACTOR.test(p.reviewActor)
        && typeof p.reviewOperationId === 'string' && OPERATION_ID.test(p.reviewOperationId) ? p : null;
    }
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
    case 'blob.put':
    case 'tree.create':
    case 'commit.create':
    case 'ref.create':
    case 'ref.update':
      return envelope.pr === null && envelope.headSha === null
        ? validatePublication(envelope.operation, envelope.actor, payload, (value) => text(value)) : null;
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
  number: number; node_id?: string; state: string; merged?: boolean; merge_commit_sha?: string | null; title: string; body: string | null;
  user: { login: string }; head: { sha: string; ref: string; repo: { id: number } | null }; base: { ref: string; sha?: string; repo: { id: number } };
};

type PullCommit = {
  sha: string; commit: { message: string };
  author: { login: string } | null; committer: { login: string } | null;
};

type Context = {
  token: string;
  pull?: Pull;
  /** blob.put: whether the blob already existed at preflight. */
  blobPresent?: boolean;
  /** ref.create and ref.update: the repository's GraphQL node id, read with its database id checked. */
  repositoryNodeId?: string;
  /** ref.update: the recorded commit.create success that this update publishes. */
  commitOutcome?: OutcomeRecord;
  /** pr.enqueue: the reviewed and live base commits, recorded with the outcome. */
  enqueue?: { reviewedBase: string; liveBase: string; nodeId: string };
};

type Check = { ok: true } | { ok: false; reason: string };
type ObjectInfo = { type: string; byteSize: number | null } | null;

function isPublication(operation: Operation): operation is PublicationOperation {
  return (PUBLICATION_OPERATIONS as readonly string[]).includes(operation);
}

/**
 * A recorded, EXECUTED success of `operation`: status "succeeded", written by
 * the claim winner from GitHub's own response. A reconciled ("applied")
 * outcome never gates a later publication step.
 */
function recordedSuccess(recorded: Awaited<ReturnType<typeof readRecorded>>, operation: string): OutcomeRecord | null {
  if (!recorded || recorded.claim.operation !== operation) return null;
  return recorded.outcome.status === 'succeeded' ? recorded.outcome : null;
}

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
    if (isPublication(envelope.operation)) return this.publicationCheck(envelope.operation, envelope.actor, payload, readToken, ctx);
    if (envelope.pr !== null) {
      const pull = await this.getPull(readToken, envelope.pr);
      ctx.pull = pull;
      if (pull.base.repo.id !== this.config.repo.id) return { ok: false, reason: 'wrong_repository' };
      if (pull.head.repo?.id !== this.config.repo.id) return { ok: false, reason: 'fork_head' };
      if (pull.state !== 'open' && envelope.operation !== 'read') return { ok: false, reason: 'pr_not_open' };
      if (pull.head.sha !== envelope.headSha) return { ok: false, reason: 'head_moved' };
      if (envelope.operation === 'pr.review') return this.reviewCheck(envelope, payload, binding, readToken, pull);
      if (envelope.operation === 'pr.enqueue') return this.enqueueCheck(envelope, payload, readToken, pull, ctx);
      return { ok: true };
    }
    // pr.open: the branch must still be at the signed head.
    const sha = await this.refSha(readToken, payload.branch as string);
    if (sha !== envelope.headSha) return { ok: false, reason: 'head_moved' };
    return { ok: true };
  }

  /**
   * pr.review preflight (design sections 3 and 5). The live base and head
   * tree must equal the signed tuple; a base change means a new tuple and a
   * fresh review. No self-review: the reviewer may be neither the PR's App
   * author nor the author, committer or recorded origin of any commit on it.
   */
  private async reviewCheck(envelope: Envelope, payload: Payload, binding: ActorBinding, token: string, pull: Pull): Promise<Check> {
    if (pull.user.login === binding.botLogin) return { ok: false, reason: 'self_review' };
    if (pull.base.sha !== payload.baseSha) return { ok: false, reason: 'base_moved' };
    const head = await this.config.api.rest(token, 'GET', `${this.repoPath()}/git/commits/${envelope.headSha}`) as { tree?: { sha?: unknown } };
    if (head?.tree?.sha !== payload.headTreeSha) return { ok: false, reason: 'tree_mismatch' };
    return this.originCheck(envelope.actor, binding, token, pull.number);
  }

  /**
   * Excludes every originator of the PR's commits from reviewing it.
   * - A commit authored or committed by the reviewer's own bot is the reviewer's.
   * - A commit carrying a broker trailer and authored by a configured actor's
   *   bot must have that actor's recorded commit.create success for exactly
   *   this sha, and its explicitly stored origin decides. A missing outcome or
   *   origin is unknown, which refuses: it never defaults to "no conflict".
   * - More commits than GitHub will list (250) cannot be fully checked, so refuse.
   */
  private async originCheck(reviewer: string, binding: ActorBinding, token: string, pr: number): Promise<Check> {
    const commits: PullCommit[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const batch = await this.config.api.rest(token, 'GET', `${this.repoPath()}/pulls/${pr}/commits?per_page=100&page=${page}`) as PullCommit[];
      commits.push(...batch);
      if (batch.length < 100) break;
    }
    if (commits.length >= MAX_PR_COMMITS) return { ok: false, reason: 'too_many_commits' };
    const actorByBot = new Map([...this.config.actors].map(([actor, b]) => [b.botLogin, actor]));
    for (const commit of commits) {
      if (commit.author?.login === binding.botLogin || commit.committer?.login === binding.botLogin) return { ok: false, reason: 'self_review' };
      const marker = BROKER_TRAILER.exec(commit.commit.message);
      const publisher = commit.author ? actorByBot.get(commit.author.login) : undefined;
      if (!marker || !publisher) continue;
      const outcome = recordedSuccess(await readRecorded(this.config.ledger, publisher, marker[1]), 'commit.create');
      if (!outcome || outcome.result.commitSha !== commit.sha || typeof outcome.result.originActor !== 'string') return { ok: false, reason: 'origin_unknown' };
      if (outcome.result.originActor === reviewer) return { ok: false, reason: 'self_review' };
    }
    return { ok: true };
  }

  /**
   * pr.enqueue preflight (design section 3). A distinct rule from review: the
   * exact head (already checked), and an APPROVE review recorded by the
   * broker for this PR and head whose reviewed base is the live base or an
   * ancestor of it. A rewritten (non-ancestor) base needs a fresh review. The
   * review must still stand on GitHub. The merge queue's own CI then gates
   * the merged result.
   */
  private async enqueueCheck(envelope: Envelope, payload: Payload, token: string, pull: Pull, ctx: Context): Promise<Check> {
    const recorded = await readRecorded(this.config.ledger, payload.reviewActor as string, payload.reviewOperationId as string);
    const review = recorded && recorded.claim.operation === 'pr.review' && (recorded.outcome.status === 'succeeded' || recorded.outcome.status === 'applied')
      ? recorded.outcome : null;
    if (!review || review.result.event !== 'APPROVE' || review.result.pr !== envelope.pr || review.result.headSha !== envelope.headSha
      || typeof review.result.baseSha !== 'string' || typeof review.result.reviewId !== 'number') return { ok: false, reason: 'review_not_recorded' };
    const native = await this.config.api.rest(token, 'GET', `${this.repoPath()}/pulls/${envelope.pr}/reviews/${review.result.reviewId}`) as { state?: unknown; commit_id?: unknown };
    if (native?.state !== 'APPROVED' || native.commit_id !== envelope.headSha) return { ok: false, reason: 'review_not_standing' };
    const liveBase = pull.base.sha;
    if (typeof liveBase !== 'string' || typeof pull.node_id !== 'string') return { ok: false, reason: 'pr_unreadable' };
    if (liveBase !== review.result.baseSha) {
      // "ahead": the live base strictly descends from the reviewed base.
      const compare = await this.config.api.compareCommits(token, this.repoPath(), review.result.baseSha, liveBase);
      if (compare?.status !== 'ahead') return { ok: false, reason: 'base_rewritten' };
    }
    ctx.enqueue = { reviewedBase: review.result.baseSha, liveBase, nodeId: pull.node_id };
    return { ok: true };
  }

  /**
   * Metadata-only object lookup through GraphQL: type and, for blobs, size.
   * Null means absent. Any GraphQL or HTTP error, or a repository that is not
   * this instance's target, throws: existence is then unknown, never assumed
   * absent. No object content is fetched.
   */
  private async objects(token: string, oids: string[]): Promise<ObjectInfo[]> {
    const variables: Record<string, unknown> = { owner: this.config.repo.owner, name: this.config.repo.name };
    const declarations = oids.map((_, i) => `, $o${i}: GitObjectID!`).join('');
    const fields = oids.map((oid, i) => {
      variables[`o${i}`] = oid;
      return `o${i}: object(oid: $o${i}) { __typename ... on Blob { byteSize } }`;
    }).join(' ');
    const { data, errors } = await this.config.api.graphql(token,
      `query($owner: String!, $name: String!${declarations}) { repository(owner: $owner, name: $name) { databaseId ${fields} } }`, variables);
    const repository = (data as { repository?: Record<string, unknown> | null } | null)?.repository;
    if (errors.length > 0 || !repository || repository.databaseId !== this.config.repo.id) throw new Error('object existence unknown');
    return oids.map((_, i) => {
      const found = repository[`o${i}`] as { __typename?: unknown; byteSize?: unknown } | null | undefined;
      if (found === undefined) throw new Error('object existence unknown');
      if (found === null) return null;
      if (typeof found.__typename !== 'string') throw new Error('object existence unknown');
      return { type: found.__typename, byteSize: typeof found.byteSize === 'number' ? found.byteSize : null };
    });
  }

  /** The target repository's GraphQL node id, for updateRefs; its database id must be the configured one. */
  private async repositoryNodeId(token: string): Promise<string> {
    const { data, errors } = await this.config.api.graphql(token,
      'query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId } }',
      { owner: this.config.repo.owner, name: this.config.repo.name });
    const repository = (data as { repository?: { id?: unknown; databaseId?: unknown } | null } | null)?.repository;
    if (errors.length > 0 || typeof repository?.id !== 'string' || repository.databaseId !== this.config.repo.id) throw new Error('repository identity unknown');
    return repository.id;
  }

  /** A PR target named by a commit: open, in this repository, not a fork, with this head branch. */
  private async targetPull(token: string, pr: number, branch: string, headSha: string | null): Promise<Check> {
    const pull = await this.getPull(token, pr);
    if (pull.base.repo.id !== this.config.repo.id || pull.head.repo?.id !== this.config.repo.id || pull.state !== 'open'
      || pull.head.ref !== branch || (headSha !== null && pull.head.sha !== headSha)) return { ok: false, reason: 'target_mismatch' };
    return { ok: true };
  }

  /**
   * Live checks for the publication pipeline (stage-1 design section 4). They
   * run inside the claim winner's preflight, before the single dispatch.
   */
  private async publicationCheck(operation: PublicationOperation, actor: string, payload: Payload, readToken: string, ctx: Context): Promise<Check> {
    switch (operation) {
      case 'blob.put': {
        let info: ObjectInfo;
        try {
          [info] = await this.objects(readToken, [payload.blobSha as string]);
        } catch {
          return { ok: false, reason: 'existence_unknown' };
        }
        if (info !== null && (info.type !== 'Blob' || info.byteSize !== payload.rawSize)) return { ok: false, reason: 'object_conflict' };
        ctx.blobPresent = info !== null;
        return { ok: true };
      }
      case 'tree.create': {
        const parent = await this.config.api.rest(readToken, 'GET', `${this.repoPath()}/git/commits/${payload.parentCommitSha}`, undefined, true) as { tree?: { sha?: unknown } } | null;
        if (parent === null) return { ok: false, reason: 'unknown_parent' };
        if (parent.tree?.sha !== payload.baseTreeSha) return { ok: false, reason: 'base_tree_mismatch' };
        const blobs = [...new Set((payload.entries as TreeEntry[]).flatMap((entry) => (entry.blobSha === null ? [] : [entry.blobSha])))];
        if (blobs.length === 0) return { ok: true };
        let infos: ObjectInfo[];
        try {
          infos = await this.objects(readToken, blobs);
        } catch {
          return { ok: false, reason: 'existence_unknown' };
        }
        return infos.every((info) => info?.type === 'Blob') ? { ok: true } : { ok: false, reason: 'missing_blob' };
      }
      case 'commit.create': {
        // The tree must be this actor's executed tree.create success, for this
        // repository and this parent: GitHub returned exactly expectedTreeSha
        // for the signed base and entries. Trees are never reconciled (see
        // reconcilePublication), and "applied" is never accepted.
        const tree = recordedSuccess(await readRecorded(this.config.ledger, actor, payload.treeOperationId as string), 'tree.create');
        if (!tree || tree.result.treeSha !== payload.treeSha || tree.result.parentCommitSha !== payload.parentCommitSha
          || tree.result.repositoryId !== this.config.repo.id) return { ok: false, reason: 'tree_not_recorded' };
        const target = payload.target as { pr: number | null; branch: string };
        return target.pr === null ? { ok: true } : this.targetPull(readToken, target.pr, target.branch, null);
      }
      case 'ref.create': {
        // Only ever a new branch at the CURRENT base: never new or unrecorded work.
        if (await this.refSha(readToken, BASE_REF) !== payload.afterOid) return { ok: false, reason: 'base_moved' };
        if (await this.refSha(readToken, payload.branch as string) !== null) return { ok: false, reason: 'branch_exists' };
        const rules = await this.config.api.rest(readToken, 'GET', `${this.repoPath()}/rules/branches/${(payload.branch as string).split('/').map(encodeURIComponent).join('/')}`);
        if (!Array.isArray(rules)) return { ok: false, reason: 'rules_unknown' };
        if (rules.length > 0) return { ok: false, reason: 'protected_ref' };
        ctx.repositoryNodeId = await this.repositoryNodeId(readToken);
        return { ok: true };
      }
      case 'ref.update': {
        // Only a commit with a recorded success from this actor's own
        // commit.create, for this repository, this branch and this parent. An
        // uncertain commit has no outcome and can never be published.
        const commit = recordedSuccess(await readRecorded(this.config.ledger, actor, payload.commitOperationId as string), 'commit.create');
        if (!commit || commit.result.commitSha !== payload.afterOid || commit.result.branch !== payload.branch
          || commit.result.parentCommitSha !== payload.beforeOid || commit.result.repositoryId !== this.config.repo.id) {
          return { ok: false, reason: 'commit_not_recorded' };
        }
        if (await this.refSha(readToken, payload.branch as string) !== payload.beforeOid) return { ok: false, reason: 'head_moved' };
        if (typeof commit.result.pr === 'number') {
          const target = await this.targetPull(readToken, commit.result.pr, payload.branch as string, payload.beforeOid as string);
          if (!target.ok) return target;
        }
        ctx.commitOutcome = commit;
        ctx.repositoryNodeId = await this.repositoryNodeId(readToken);
        return { ok: true };
      }
    }
  }

  /** One updateRefs call for one heads ref, never forced. Only an error-free result is success; anything else is unknown. */
  private async updateRef(token: string, nodeId: string, branch: string, beforeOid: string, afterOid: string): Promise<void> {
    const { data, errors } = await this.config.api.graphql(token,
      'mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }',
      { input: { repositoryId: nodeId, refUpdates: [{ name: `refs/heads/${branch}`, beforeOid, afterOid, force: false }] } });
    // As with createCommitOnBranch (phase 2b review, finding 2), no GraphQL
    // error class is yet proven to mean "not applied", so errors stay unknown.
    const updated = (data as { updateRefs?: unknown } | null)?.updateRefs;
    if (errors.length > 0 || typeof updated !== 'object' || updated === null) throw new Error(`ref update result unknown (${errors.length} graphql errors)`);
  }

  /** The single dispatch for a publication operation. */
  private async publish(operation: PublicationOperation, envelope: Envelope, payload: Payload, marker: { trailer: string }, ctx: Context): Promise<EffectResult> {
    const api = this.config.api, repo = this.repoPath(), token = ctx.token, repositoryId = this.config.repo.id;
    switch (operation) {
      case 'blob.put': {
        // Postcondition: an object with this sha exists. Already present is reported as such, never as an upload.
        if (ctx.blobPresent) return { status: 'succeeded', result: { blobSha: payload.blobSha as string, presence: 'already_present', repositoryId } };
        const r = await api.rest(token, 'POST', `${repo}/git/blobs`, { content: payload.contentBase64, encoding: 'base64' }) as { sha?: unknown };
        if (r?.sha !== payload.blobSha) throw new Error('blob result unknown');
        return { status: 'succeeded', result: { blobSha: payload.blobSha as string, presence: 'uploaded', repositoryId } };
      }
      case 'tree.create': {
        const tree = (payload.entries as TreeEntry[]).map((entry) => ({ path: entry.path, mode: entry.mode, type: 'blob', sha: entry.blobSha }));
        const r = await api.rest(token, 'POST', `${repo}/git/trees`, { base_tree: payload.baseTreeSha, tree }) as { sha?: unknown };
        if (typeof r?.sha !== 'string') throw new Error('tree result unknown');
        // A different tree is a definite failure: no commit or ref step may use it.
        if (r.sha !== payload.expectedTreeSha) return { status: 'failed', result: { reason: 'tree_mismatch', treeSha: r.sha } };
        return { status: 'succeeded', result: { treeSha: r.sha, parentCommitSha: payload.parentCommitSha as string, baseTreeSha: payload.baseTreeSha as string, repositoryId } };
      }
      case 'commit.create': {
        // Self-origin (F2): author and committer are both left to GitHub, which
        // sets the authenticated App bot and the current time. Both are then
        // verified against this actor's bot login.
        const message = withTrailer(payload.message as string, marker.trailer);
        const binding = this.config.actors.get(envelope.actor) as ActorBinding;
        const r = await api.rest(token, 'POST', `${repo}/git/commits`, { message, tree: payload.treeSha, parents: [payload.parentCommitSha] }) as {
          sha?: unknown; message?: unknown; tree?: { sha?: unknown }; parents?: Array<{ sha?: unknown }>;
          author?: { name?: unknown; email?: unknown; date?: unknown }; committer?: { name?: unknown; email?: unknown };
        };
        if (typeof r?.sha !== 'string' || !SHA1_HEX.test(r.sha)) throw new Error('commit result unknown');
        const botEmail = (email: unknown) => typeof email === 'string' && email.endsWith(`+${binding.botLogin}@users.noreply.github.com`);
        const exact = r.tree?.sha === payload.treeSha && r.parents?.length === 1 && r.parents[0]?.sha === payload.parentCommitSha
          && r.message === message && r.author?.name === binding.botLogin && r.committer?.name === binding.botLogin
          && botEmail(r.author?.email) && r.committer?.email === r.author?.email && typeof r.author?.date === 'string';
        // A commit that is not exactly the requested one is recorded as failed, so ref.update can never publish it.
        if (!exact) return { status: 'failed', result: { reason: 'postcondition', commitSha: r.sha } };
        const target = payload.target as { pr: number | null; branch: string };
        return {
          status: 'succeeded',
          result: {
            commitSha: r.sha, treeSha: payload.treeSha as string, parentCommitSha: payload.parentCommitSha as string,
            branch: target.branch, pr: target.pr, repositoryId,
            // Effective origin is stored explicitly: self-origin names the publishing actor.
            originActor: envelope.actor, authorDate: r.author?.date as string,
          },
        };
      }
      case 'ref.create':
        await this.updateRef(token, ctx.repositoryNodeId as string, payload.branch as string, ZERO_OID, payload.afterOid as string);
        return { status: 'succeeded', result: { branch: payload.branch as string, afterOid: payload.afterOid as string, repositoryId } };
      case 'ref.update': {
        await this.updateRef(token, ctx.repositoryNodeId as string, payload.branch as string, payload.beforeOid as string, payload.afterOid as string);
        return { status: 'succeeded', result: this.refUpdateResult(payload, ctx.commitOutcome as OutcomeRecord) };
      }
    }
  }

  /** A review's outcome records its full tuple, which pr.enqueue later relies on. */
  private reviewResult(reviewId: number, envelope: Envelope, payload: Payload): Record<string, string | number | null> {
    return {
      reviewId, event: payload.event as string, pr: envelope.pr, headSha: envelope.headSha,
      baseSha: payload.baseSha as string, headTreeSha: payload.headTreeSha as string,
    };
  }

  /** The commit's expected tree, origin and target carry through to the ref outcome. */
  private refUpdateResult(payload: Payload, commit: OutcomeRecord): Record<string, string | number | null> {
    return {
      branch: payload.branch as string, beforeOid: payload.beforeOid as string, afterOid: payload.afterOid as string,
      treeSha: commit.result.treeSha ?? null, originActor: commit.result.originActor ?? null, pr: commit.result.pr ?? null,
      repositoryId: this.config.repo.id,
    };
  }

  /**
   * Positive-only reconciliation for publication.
   * - blob.put settles by existence: the blob sha was verified against the
   *   signed content itself, so an object at that sha IS that content.
   * - tree.create is never settled (luca-replit PR #124 review, B-TREE): an
   *   object at the caller-named expectedTreeSha does not prove it is the
   *   tree of the signed base and entries. Only GitHub's own response to this
   *   operation's POST proves that. An uncertain tree stays unpublishable;
   *   recovery is a fresh tree.create under a new operation id, which is
   *   content-addressed and returns the same sha if it was in fact created.
   * - commit.create is never settled: its sha was never recorded, so it can
   *   never be published.
   * - Refs settle only when the live ref equals the claimed afterOid.
   */
  private async reconcilePublication(operation: PublicationOperation, actor: string, payload: Payload, token: string): ReturnType<Reconciler> {
    const repositoryId = this.config.repo.id;
    switch (operation) {
      case 'blob.put': {
        const [info] = await this.objects(token, [payload.blobSha as string]);
        return info?.type === 'Blob' && info.byteSize === payload.rawSize
          ? { status: 'applied', result: { blobSha: payload.blobSha as string, presence: 'present', repositoryId } } : { status: 'not_observed' };
      }
      case 'tree.create':
      case 'commit.create':
        return { status: 'ambiguous' };
      case 'ref.create':
        return await this.refSha(token, payload.branch as string) === payload.afterOid
          ? { status: 'applied', result: { branch: payload.branch as string, afterOid: payload.afterOid as string, repositoryId } } : { status: 'not_observed' };
      case 'ref.update': {
        if (await this.refSha(token, payload.branch as string) !== payload.afterOid) return { status: 'not_observed' };
        const commit = recordedSuccess(await readRecorded(this.config.ledger, actor, payload.commitOperationId as string), 'commit.create');
        return commit ? { status: 'applied', result: this.refUpdateResult(payload, commit) } : { status: 'ambiguous' };
      }
    }
  }

  /** Exactly one request. Definite GitHub rejections are "failed"; unknown results throw (uncertain). */
  private async dispatch(envelope: Envelope, payload: Payload, marker: { html: string; trailer: string }, ctx: Context): Promise<EffectResult> {
    const api = this.config.api, repo = this.repoPath(), token = ctx.token, pr = envelope.pr, head = envelope.headSha as string;
    try {
      if (isPublication(envelope.operation)) return await this.publish(envelope.operation, envelope, payload, marker, ctx);
      switch (envelope.operation as Exclude<Operation, 'read' | 'status' | 'branch.delete' | PublicationOperation>) {
        case 'pr.comment': {
          const r = await api.rest(token, 'POST', `${repo}/issues/${pr}/comments`, { body: `${payload.body}\n\n${marker.html}` }) as { id: number };
          return { status: 'succeeded', result: { commentId: r.id } };
        }
        case 'pr.review': {
          const r = await api.rest(token, 'POST', `${repo}/pulls/${pr}/reviews`, { commit_id: head, event: payload.event, body: `${payload.body}\n\n${marker.html}` }) as { id: number };
          return { status: 'succeeded', result: this.reviewResult(r.id, envelope, payload) };
        }
        case 'pr.enqueue': {
          const queued = ctx.enqueue as NonNullable<Context['enqueue']>;
          const { data, errors } = await api.graphql(token,
            'mutation($input: EnqueuePullRequestInput!) { enqueuePullRequest(input: $input) { mergeQueueEntry { id } } }',
            { input: { pullRequestId: queued.nodeId, expectedHeadOid: head } });
          // As for every GraphQL mutation here (phase 2b finding 2), only a
          // clean, positive result is success; anything else stays uncertain.
          const entry = (data as { enqueuePullRequest?: { mergeQueueEntry?: unknown } } | null)?.enqueuePullRequest?.mergeQueueEntry;
          if (errors.length > 0 || typeof entry !== 'object' || entry === null) throw new Error(`enqueue result unknown (${errors.length} graphql errors)`);
          return { status: 'succeeded', result: { pr, headSha: head, reviewedBase: queued.reviewedBase, liveBase: queued.liveBase, reviewActor: payload.reviewActor as string, reviewOperationId: payload.reviewOperationId as string } };
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
        if (isPublication(envelope.operation)) return await this.reconcilePublication(envelope.operation, envelope.actor, payload, token);
        switch (envelope.operation) {
          case 'pr.comment': {
            const found = (await list<{ id: number; user: { login: string }; body: string }>(`${repo}/issues/${pr}/comments`))
              .find((c) => c.user.login === binding.botLogin && c.body.endsWith(marker.html));
            return found ? { status: 'applied', result: { commentId: found.id } } : { status: 'not_observed' };
          }
          case 'pr.review': {
            const found = (await list<{ id: number; user: { login: string }; body: string; commit_id: string }>(`${repo}/pulls/${pr}/reviews`))
              .find((r) => r.user.login === binding.botLogin && r.commit_id === head && r.body.endsWith(marker.html));
            return found ? { status: 'applied', result: this.reviewResult(found.id, envelope, payload) } : { status: 'not_observed' };
          }
          case 'pr.enqueue': {
            // Positive only: this exact head is in the merge queue, or was merged at this exact head.
            const { data, errors } = await api.graphql(token,
              'query($owner: String!, $name: String!, $pr: Int!) { repository(owner: $owner, name: $name) { databaseId pullRequest(number: $pr) { headRefOid merged mergeQueueEntry { id } } } }',
              { owner: this.config.repo.owner, name: this.config.repo.name, pr });
            const repository = (data as { repository?: { databaseId?: unknown; pullRequest?: { headRefOid?: unknown; merged?: unknown; mergeQueueEntry?: unknown } | null } | null } | null)?.repository;
            if (errors.length > 0 || repository?.databaseId !== this.config.repo.id || !repository.pullRequest) return { status: 'ambiguous' };
            const p = repository.pullRequest;
            return p.headRefOid === head && (p.merged === true || (typeof p.mergeQueueEntry === 'object' && p.mergeQueueEntry !== null))
              ? { status: 'applied', result: { pr, headSha: head as string, reviewActor: payload.reviewActor as string, reviewOperationId: payload.reviewOperationId as string } }
              : { status: 'not_observed' };
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
