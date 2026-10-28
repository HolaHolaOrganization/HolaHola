// Stage-1 design sections 3 and 5: pr.review is bound to the exact tuple and
// excludes every originator; pr.enqueue queues only the exact approved head
// behind a recorded broker review whose reviewed base is the live base or an
// ancestor of it.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, test } from 'node:test';
import { decide } from '../src/authorize.ts';
import { canonicalJson } from '../src/canonical.ts';
import { claimPath, EXECUTION_DEADLINE_MS, type Ledger, outcomePath } from '../src/claims.ts';
import { AUDIENCE, type Envelope, payloadDigest, PROTOCOL } from '../src/envelope.ts';
import { Gateway, validatePayload } from '../src/gateway.ts';
import { type Fetch, GitHubApi } from '../src/github.ts';
import { gitBlobSha, PolicyLoader, REPOSITORY_ID } from '../src/policy.ts';

const NOW = 1_800_000_000_000;
const HEAD = 'a'.repeat(40);
const BASE = '1'.repeat(40);
const NEWER_BASE = '3'.repeat(40);
const HEAD_TREE = '2'.repeat(40);
const LCC_BOT = 'holahola-luca-claude-code[bot]';
const LR_BOT = 'holahola-luca-replit[bot]';
const REPO = { owner: 'HolaHolaOrganization', name: 'HolaHola', id: REPOSITORY_ID };
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const signer = generateKeyPairSync('ed25519');
const TUPLE = { baseSha: BASE, headTreeSha: HEAD_TREE };

const policyBytes = (state = 'routine') => new TextEncoder().encode(JSON.stringify({
  version: 1, state, repositoryId: REPOSITORY_ID, qualification: state === 'qualification' ? [{ pr: 48, headSha: HEAD }] : [],
  actors: { 'luca-claude-code': { appId: 5350010, installationId: 172194780, host: 'LITTLENEMO', signingKeys: [{ id: 'lcc-1', publicKeyPem: signer.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] } },
}));

class MemoryLedger implements Ledger {
  commits: Array<Map<string, string>> = [new Map()];
  async head() { await Promise.resolve(); return String(this.commits.length - 1).padStart(40, '0'); }
  async read(head: string, path: string) { return this.commits[Number(head)]?.get(path) ?? null; }
  async commit(expected: string, files: Record<string, string>) {
    if (Number(expected) !== this.commits.length - 1) return { ok: false as const };
    const next = new Map(this.commits[this.commits.length - 1]);
    for (const [path, content] of Object.entries(files)) { if (next.has(path)) throw new Error('overwrite'); next.set(path, content); }
    this.commits.push(next);
    return { ok: true as const, head: String(this.commits.length - 1).padStart(40, '0') };
  }
  /** Writes a claim and outcome directly, as another actor's earlier operation would have. */
  async forge(actor: string, operationId: string, operation: string, status: string, result: Record<string, unknown>) {
    const digest = 'd'.repeat(64);
    const claim = { actor, operationId, digest, operation, pr: null, headSha: null, policyEpoch: 'e'.repeat(40), decision: 'allow', status: 'claimed', claimedAt: NOW };
    const outcome = { actor, operationId, digest, status, result, reconciled: false, recordedAt: NOW };
    const ok = await this.commit(await this.head(), { [claimPath(actor, operationId)]: `${canonicalJson(claim)}\n`, [outcomePath(actor, operationId)]: `${canonicalJson(outcome)}\n` });
    assert.ok(ok.ok);
  }
}

type Commit = { sha: string; commit: { message: string }; author: { login: string } | null; committer: { login: string } | null };

class FakeGitHub {
  calls: Array<{ method: string; path: string; body?: unknown }> = [];
  pull = { number: 48, node_id: 'PR_node48', state: 'open', merged: false, title: 't', body: 'b', user: { login: LR_BOT }, head: { sha: HEAD, ref: 'lr/feature', repo: { id: REPOSITORY_ID } }, base: { ref: 'main', sha: BASE, repo: { id: REPOSITORY_ID } } };
  prCommits: Commit[] = [{ sha: HEAD, commit: { message: 'Work' }, author: { login: LR_BOT }, committer: { login: LR_BOT } }];
  headTree = HEAD_TREE;
  reviews: Array<{ id: number; user: { login: string }; body: string; commit_id: string; state: string }> = [];
  compareStatus = 'ahead';
  /** What GitHub's live PR commit listing would show; the broker must never use it. */
  liveListing: Commit[] = [];
  /** Overrides compare's total_commits, to simulate an incomplete enumeration. */
  totalOverride: number | null = null;
  comparePaths: string[] = [];
  queued = false;
  failAfterApply = false;
  enqueueResponse: unknown = null;

  private json(status: number, body: unknown) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }

  readonly fetch: Fetch = async (url, init) => {
    await new Promise((resolve) => setImmediate(resolve));
    const { pathname, searchParams } = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path: pathname, body });
    if (pathname.endsWith('/access_tokens')) return this.json(201, { token: 'ghs_test', expires_at: new Date(NOW + 3_600_000).toISOString() });
    const base = `/repos/${REPO.owner}/${REPO.name}`;
    if (pathname === `${base}/pulls/48` && method === 'GET') return this.json(200, this.pull);
    if (pathname === `${base}/pulls/48/commits`) return this.json(200, this.liveListing);
    if (pathname === `${base}/git/commits/${HEAD}`) return this.json(200, { sha: HEAD, tree: { sha: this.headTree } });
    if (pathname === `${base}/pulls/48/reviews` && method === 'POST') {
      const r = { id: 900 + this.reviews.length, user: { login: LCC_BOT }, body: body.body, commit_id: body.commit_id, state: body.event === 'APPROVE' ? 'APPROVED' : body.event };
      this.reviews.push(r);
      return this.failAfterApply ? (this.failAfterApply = false, this.json(502, {})) : this.json(200, r);
    }
    if (pathname === `${base}/pulls/48/reviews` && method === 'GET') return this.json(200, Number(searchParams.get('page') ?? 1) > 1 ? [] : this.reviews);
    const one = pathname.match(new RegExp(`^${base}/pulls/48/reviews/(\\d+)$`));
    if (one) { const r = this.reviews.find((x) => x.id === Number(one[1])); return r ? this.json(200, r) : this.json(404, {}); }
    if (pathname.startsWith(`${base}/compare/`)) {
      this.comparePaths.push(`${pathname}?${searchParams.toString()}`);
      if (pathname === `${base}/compare/${BASE}...${HEAD}`) {
        const page = Number(searchParams.get('page') ?? 1);
        return this.json(200, { status: 'ahead', total_commits: this.totalOverride ?? this.prCommits.length, commits: this.prCommits.slice((page - 1) * 100, page * 100) });
      }
      return this.json(200, { status: this.compareStatus });
    }
    if (pathname === '/graphql') {
      const { query, variables } = body as { query: string; variables: Record<string, any> };
      if (query.includes('enqueuePullRequest')) {
        assert.deepEqual(variables.input, { pullRequestId: 'PR_node48', expectedHeadOid: HEAD });
        this.queued = true;
        if (this.failAfterApply) { this.failAfterApply = false; return this.json(502, {}); }
        return this.json(200, this.enqueueResponse ?? { data: { enqueuePullRequest: { mergeQueueEntry: { id: 'MQE_1' } } } });
      }
      return this.json(200, { data: { repository: { databaseId: REPOSITORY_ID, pullRequest: { headRefOid: this.pull.head.sha, merged: false, mergeQueueEntry: this.queued ? { id: 'MQE_1' } : null } } } });
    }
    return this.json(500, { message: `unhandled ${method} ${pathname}` });
  };

  count(method: string, fragment: string) { return this.calls.filter((c) => c.method === method && (c.path.includes(fragment) || JSON.stringify(c.body ?? '').includes(fragment))).length; }
}

function harness(state = 'routine') {
  const github = new FakeGitHub();
  const ledger = new MemoryLedger();
  const clock = { now: NOW };
  const bytes = policyBytes(state);
  const loader = new PolicyLoader({ fetch: async () => ({ bytes, blobSha: gitBlobSha(bytes) }) }, () => clock.now, 1);
  const gateway = new Gateway({
    repo: REPO,
    actors: new Map([
      ['luca-claude-code', { appId: 5350010, installationId: 172194780, privateKey: rsa.privateKey, botLogin: LCC_BOT }],
      ['luca-replit', { appId: 5350011, installationId: 172194781, privateKey: rsa.privateKey, botLogin: LR_BOT }],
    ]),
    api: new GitHubApi(github.fetch), ledger, loaderFor: (a) => (a === 'luca-claude-code' ? loader : undefined), now: () => clock.now,
  });
  return { github, ledger, clock, gateway, loader, epoch: gitBlobSha(bytes) };
}
type H = ReturnType<typeof harness>;

let counter = 0;
const nextId = () => `op-review-${String(++counter).padStart(12, '0')}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Result = { status: number; body: Record<string, any> };

async function run(h: H, operation: Envelope['operation'], payload: unknown, operationId = nextId()): Promise<Result & { operationId: string; replay: () => Promise<Result> }> {
  const envelope: Envelope = {
    audience: AUDIENCE, protocol: PROTOCOL, repositoryId: REPOSITORY_ID, actor: 'luca-claude-code', keyId: 'lcc-1',
    operation, pr: 48, headSha: HEAD, payloadSha256: payloadDigest(payload), policyEpoch: h.epoch,
    issuedAt: h.clock.now - 1_000, expiresAt: h.clock.now + 30_000, operationId,
  };
  const signed = { envelope, signature: sign(null, Buffer.from(canonicalJson(envelope), 'utf8'), signer.privateKey).toString('base64'), payload };
  const decision = await decide(signed, () => h.loader, () => h.clock.now);
  if (decision.decision !== 'allow') return { status: 403, body: decision as unknown as Record<string, unknown>, operationId, replay: async () => { throw new Error('denied'); } };
  const { envelope: e, digest, payload: p, policy } = decision.authorized;
  const replay = async () => await h.gateway.execute(signed, e, digest, p, policy.epoch) as Result;
  return { ...(await replay()), operationId, replay };
}

const approve = (h: H) => run(h, 'pr.review', { event: 'APPROVE', body: '', ...TUPLE });
const brokerCommit = (sha: string, opId: string, author = LR_BOT): Commit =>
  ({ sha, commit: { message: `Change\n\nHolahola-Broker-Op: ${opId}:${'f'.repeat(16)}\n` }, author: { login: author }, committer: { login: author } });

describe('pr.review: the exact tuple', () => {
  test('a review on the signed base, head and head tree executes and records its full tuple', async () => {
    const h = harness();
    const review = await approve(h);
    assert.equal(review.body.status, 'succeeded');
    assert.deepEqual(review.body.result, { reviewId: 900, event: 'APPROVE', pr: 48, headSha: HEAD, baseSha: BASE, headTreeSha: HEAD_TREE });
  });

  test('a moved base or a different head tree refuses before any review is posted', async () => {
    const moved = harness();
    moved.github.pull.base.sha = NEWER_BASE;
    assert.deepEqual((await approve(moved)).body.result, { reason: 'base_moved' });
    const tree = harness();
    tree.github.headTree = '9'.repeat(40);
    assert.deepEqual((await approve(tree)).body.result, { reason: 'tree_mismatch' });
    assert.equal(moved.github.reviews.length + tree.github.reviews.length, 0);
  });

  test('the tuple fields are required and well-formed', () => {
    const env = { operation: 'pr.review', pr: 48, headSha: HEAD } as Envelope;
    assert.ok(validatePayload(env, { event: 'APPROVE', body: '', ...TUPLE }));
    assert.equal(validatePayload(env, { event: 'APPROVE', body: '' }), null);
    assert.equal(validatePayload(env, { event: 'APPROVE', body: '', baseSha: 'x', headTreeSha: HEAD_TREE }), null);
  });
});

describe('pr.review: no self-review, including by origin', () => {
  test('the PR\'s App author cannot review it', async () => {
    const h = harness();
    h.github.pull.user.login = LCC_BOT;
    assert.deepEqual((await approve(h)).body.result, { reason: 'self_review' });
  });

  test('a commit authored or committed by the reviewer\'s bot excludes the reviewer', async () => {
    for (const who of ['author', 'committer'] as const) {
      const h = harness();
      h.github.prCommits.push({ sha: 'b'.repeat(40), commit: { message: 'x' }, author: { login: LR_BOT }, committer: { login: LR_BOT }, [who]: { login: LCC_BOT } });
      assert.deepEqual((await approve(h)).body.result, { reason: 'self_review' }, who);
      assert.equal(h.github.reviews.length, 0);
    }
  });

  test('a broker-published commit decides by its recorded origin; unknown origin refuses', async () => {
    const cases: Array<[string, Record<string, unknown> | null, string | null]> = [
      ['origin is the reviewer (a relay published by another actor)', { originActor: 'luca-claude-code' }, 'self_review'],
      ['origin is another actor', { originActor: 'luca-replit' }, null],
      ['no recorded outcome', null, 'origin_unknown'],
      ['outcome lacks an origin', {}, 'origin_unknown'],
      ['outcome is for a different commit', { originActor: 'luca-replit', commitSha: 'e'.repeat(40) }, 'origin_unknown'],
    ];
    for (const [name, result, expected] of cases) {
      const h = harness();
      const sha = 'c'.repeat(40);
      h.github.prCommits.push(brokerCommit(sha, 'op-published-000000000001'));
      if (result) await h.ledger.forge('luca-replit', 'op-published-000000000001', 'commit.create', 'succeeded', { commitSha: sha, ...result });
      const review = await approve(h);
      if (expected) assert.deepEqual(review.body.result, { reason: expected }, name);
      else assert.equal(review.body.status, 'succeeded', name);
    }
  });

  test('a failed commit.create outcome is not an origin record', async () => {
    const h = harness();
    const sha = 'c'.repeat(40);
    h.github.prCommits.push(brokerCommit(sha, 'op-published-000000000002'));
    await h.ledger.forge('luca-replit', 'op-published-000000000002', 'commit.create', 'failed', { commitSha: sha, originActor: 'luca-replit' });
    assert.deepEqual((await approve(h)).body.result, { reason: 'origin_unknown' });
  });

  test('a broker trailer on a commit not authored by a configured bot is judged by its GitHub identity only', async () => {
    const h = harness();
    h.github.prCommits.push(brokerCommit('c'.repeat(40), 'op-foreign-00000000000001', 'davidwmcintosh'));
    assert.equal((await approve(h)).body.status, 'succeeded');
  });

  test('a PR with more commits than GitHub will list cannot be fully checked, so it is refused', async () => {
    const h = harness();
    h.github.prCommits = Array.from({ length: 250 }, (_, i) => ({ sha: i.toString(16).padStart(40, '0'), commit: { message: 'x' }, author: { login: LR_BOT }, committer: { login: LR_BOT } }));
    assert.deepEqual((await approve(h)).body.result, { reason: 'too_many_commits' });
  });

  // luca-replit PR #128 review, C-ORIGIN-SNAPSHOT.
  test('commits come from the immutable signed base...head compare, never the live PR listing', async () => {
    const h = harness();
    // The live listing (as after an ABA head change) shows only someone else's commit;
    // the immutable range holds the reviewer's own. The review must be refused.
    h.github.prCommits.push({ sha: 'b'.repeat(40), commit: { message: 'mine' }, author: { login: LCC_BOT }, committer: { login: LCC_BOT } });
    h.github.liveListing = [{ sha: 'c'.repeat(40), commit: { message: 'theirs' }, author: { login: LR_BOT }, committer: { login: LR_BOT } }];
    assert.deepEqual((await approve(h)).body.result, { reason: 'self_review' });
    assert.equal(h.github.count('GET', '/pulls/48/commits'), 0, 'the live listing is never read');
    assert.ok(h.github.comparePaths.every((path) => path.includes(`/compare/${BASE}...${HEAD}?`)), 'pinned to the signed base and head');
  });

  test('the range is paged in full: a reviewer commit on page 2 is found', async () => {
    const h = harness();
    h.github.prCommits = Array.from({ length: 150 }, (_, i) => ({ sha: (i + 1).toString(16).padStart(40, '0'), commit: { message: 'x' }, author: { login: LR_BOT }, committer: { login: LR_BOT } }));
    h.github.prCommits[120].author = { login: LCC_BOT };
    assert.deepEqual((await approve(h)).body.result, { reason: 'self_review' });
    assert.equal(h.github.comparePaths.length, 2);
  });

  test('pages that do not account for exactly total_commits are incomplete and refused', async () => {
    const h = harness();
    h.github.totalOverride = 5;
    assert.deepEqual((await approve(h)).body.result, { reason: 'origin_incomplete' });
  });

  test('an uncertain review reconciles from its marker with the full tuple', async () => {
    const h = harness();
    h.github.failAfterApply = true;
    const first = await approve(h);
    assert.equal(first.body.decision, 'uncertain');
    h.clock.now += EXECUTION_DEADLINE_MS;
    const later = await first.replay();
    assert.equal(later.body.status, 'applied');
    assert.deepEqual(later.body.result, { reviewId: 900, event: 'APPROVE', pr: 48, headSha: HEAD, baseSha: BASE, headTreeSha: HEAD_TREE });
  });
});

describe('pr.enqueue: only the exact approved head, behind a recorded review', () => {
  const enqueue = (h: H, reviewOperationId: string, reviewActor = 'luca-claude-code', liveBaseSha = h.github.pull.base.sha) =>
    run(h, 'pr.enqueue', { reviewActor, reviewOperationId, liveBaseSha });

  test('a recorded approving review at the exact head and base enqueues once, pinned to the head', async () => {
    const h = harness();
    const review = await approve(h);
    const queued = await enqueue(h, review.operationId);
    assert.equal(queued.body.status, 'succeeded');
    assert.deepEqual(queued.body.result, { pr: 48, headSha: HEAD, reviewedBase: BASE, liveBase: BASE, reviewActor: 'luca-claude-code', reviewOperationId: review.operationId });
    assert.equal(h.github.count('POST', 'enqueuePullRequest'), 1);
  });

  test('a base that advanced past the reviewed base is allowed; both bases are recorded', async () => {
    const h = harness();
    const review = await approve(h);
    h.github.pull.base.sha = NEWER_BASE;
    const queued = await enqueue(h, review.operationId);
    assert.equal(queued.body.status, 'succeeded');
    assert.equal(queued.body.result.reviewedBase, BASE);
    assert.equal(queued.body.result.liveBase, NEWER_BASE);
  });

  test('a rewritten (non-ancestor) base needs a fresh review', async () => {
    const h = harness();
    const review = await approve(h);
    h.github.pull.base.sha = NEWER_BASE;
    h.github.compareStatus = 'diverged';
    assert.deepEqual((await enqueue(h, review.operationId)).body.result, { reason: 'base_rewritten' });
    assert.equal(h.github.count('POST', 'enqueuePullRequest'), 0);
  });

  test('no recorded approving review for this exact PR and head, no enqueue', async () => {
    const h = harness();
    assert.deepEqual((await enqueue(h, 'op-never-reviewed-000001')).body.result, { reason: 'review_not_recorded' });
    const comment = await run(h, 'pr.review', { event: 'COMMENT', body: 'looks fine', ...TUPLE });
    assert.deepEqual((await enqueue(h, comment.operationId)).body.result, { reason: 'review_not_recorded' }, 'a comment review is not approval');
    await h.ledger.forge('luca-replit', 'op-other-head-0000000001', 'pr.review', 'succeeded', { reviewId: 1, event: 'APPROVE', pr: 48, headSha: 'b'.repeat(40), baseSha: BASE });
    assert.deepEqual((await enqueue(h, 'op-other-head-0000000001', 'luca-replit')).body.result, { reason: 'review_not_recorded' }, 'another head');
    await h.ledger.forge('luca-replit', 'op-other-pr-000000000001', 'pr.review', 'succeeded', { reviewId: 1, event: 'APPROVE', pr: 49, headSha: HEAD, baseSha: BASE });
    assert.deepEqual((await enqueue(h, 'op-other-pr-000000000001', 'luca-replit')).body.result, { reason: 'review_not_recorded' }, 'another PR at the same head');
    await h.ledger.forge('luca-replit', 'op-a-comment-000000000001', 'pr.comment', 'succeeded', { reviewId: 1, event: 'APPROVE', pr: 48, headSha: HEAD, baseSha: BASE });
    assert.deepEqual((await enqueue(h, 'op-a-comment-000000000001', 'luca-replit')).body.result, { reason: 'review_not_recorded' }, 'another operation');
    await h.ledger.forge('luca-replit', 'op-failed-rev-00000000001', 'pr.review', 'failed', { reviewId: 1, event: 'APPROVE', pr: 48, headSha: HEAD, baseSha: BASE });
    assert.deepEqual((await enqueue(h, 'op-failed-rev-00000000001', 'luca-replit')).body.result, { reason: 'review_not_recorded' }, 'a failed review');
    assert.equal(h.github.count('POST', 'enqueuePullRequest'), 0);
  });

  test('a recorded review that no longer stands on GitHub (dismissed) does not authorize', async () => {
    const h = harness();
    const review = await approve(h);
    h.github.reviews[0].state = 'DISMISSED';
    assert.deepEqual((await enqueue(h, review.operationId)).body.result, { reason: 'review_not_standing' });
  });

  test('a GraphQL response with errors stays uncertain, is not resent, and settles only from the live queue state', async () => {
    const h = harness();
    const review = await approve(h);
    h.github.enqueueResponse = { data: { enqueuePullRequest: { mergeQueueEntry: { id: 'MQE_1' } } }, errors: [{ type: 'INTERNAL', message: 'partial' }] };
    const queued = await enqueue(h, review.operationId);
    assert.equal(queued.body.decision, 'uncertain');
    h.clock.now += EXECUTION_DEADLINE_MS;
    const settled = await queued.replay();
    assert.equal(settled.body.status, 'applied');
    // C-ENQUEUE-RECOVERY-BASES: both bases survive recovery, from durable sources.
    assert.deepEqual(settled.body.result, { pr: 48, headSha: HEAD, reviewedBase: BASE, liveBase: BASE, reviewActor: 'luca-claude-code', reviewOperationId: review.operationId });
    assert.equal(h.github.count('POST', 'enqueuePullRequest'), 1);
  });

  test('recovery records the signed live base, never a later snapshot of the PR', async () => {
    const h = harness();
    const review = await approve(h);
    h.github.pull.base.sha = NEWER_BASE;
    h.github.enqueueResponse = { data: { enqueuePullRequest: { mergeQueueEntry: { id: 'MQE_1' } } }, errors: [{ type: 'INTERNAL', message: 'partial' }] };
    const queued = await enqueue(h, review.operationId);
    assert.equal(queued.body.decision, 'uncertain');
    h.github.pull.base.sha = '7'.repeat(40);
    h.clock.now += EXECUTION_DEADLINE_MS;
    const settled = await queued.replay();
    assert.equal(settled.body.status, 'applied');
    assert.equal(settled.body.result.reviewedBase, BASE);
    assert.equal(settled.body.result.liveBase, NEWER_BASE, 'the base preflight verified, not the base read during recovery');
  });

  test('a signed live base that is not the live base refuses', async () => {
    const h = harness();
    const review = await approve(h);
    assert.deepEqual((await enqueue(h, review.operationId, 'luca-claude-code', NEWER_BASE)).body.result, { reason: 'base_moved' });
    assert.equal(h.github.count('POST', 'enqueuePullRequest'), 0);
  });

  test('an uncertain enqueue is not settled when the queue holds a different head', async () => {
    const h = harness();
    const review = await approve(h);
    h.github.enqueueResponse = { data: null, errors: [{ type: 'INTERNAL', message: 'boom' }] };
    const queued = await enqueue(h, review.operationId);
    assert.equal(queued.body.decision, 'uncertain');
    h.github.pull.head.sha = 'b'.repeat(40);
    h.clock.now += EXECUTION_DEADLINE_MS;
    assert.equal((await queued.replay()).body.decision, 'uncertain');
  });

  test('payload shape: named reviewer and operation, with an envelope PR and head', () => {
    const env = { operation: 'pr.enqueue', pr: 48, headSha: HEAD } as Envelope;
    const p = { reviewActor: 'luca-replit', reviewOperationId: 'op-review-000000000001', liveBaseSha: BASE };
    assert.ok(validatePayload(env, p));
    assert.equal(validatePayload({ ...env, pr: null } as Envelope, p), null);
    assert.equal(validatePayload(env, { ...p, reviewActor: 'Luca' }), null);
    assert.equal(validatePayload(env, { ...p, reviewOperationId: 'short' }), null);
    assert.equal(validatePayload(env, { reviewActor: 'luca-replit', reviewOperationId: 'op-review-000000000001' }), null, 'the live base is required');
    assert.equal(validatePayload(env, { ...p, liveBaseSha: 'main' }), null);
  });

  test('qualification: enqueue is allowed only for the listed PR at its pinned head', async () => {
    const h = harness('qualification');
    const review = await approve(h);
    assert.equal(review.body.status, 'succeeded');
    assert.equal((await enqueue(h, review.operationId)).body.status, 'succeeded');
  });
});

describe('compareCommits: the one exception to the path guard', () => {
  test('only exact shas and a fixed repository path; rest() still refuses any ".."', async () => {
    const seen: string[] = [];
    const api = new GitHubApi(async (url) => { seen.push(url); return new Response(JSON.stringify({ status: 'ahead' })); });
    assert.deepEqual(await api.compareCommits('t', '/repos/HolaHolaOrganization/HolaHola', BASE, NEWER_BASE), { status: 'ahead' });
    assert.equal(seen[0], `https://api.github.com/repos/HolaHolaOrganization/HolaHola/compare/${BASE}...${NEWER_BASE}?per_page=100&page=1`);
    for (const page of [0, 11, 1.5, -1]) {
      await assert.rejects(api.compareCommits('t', '/repos/HolaHolaOrganization/HolaHola', BASE, NEWER_BASE, page), TypeError, `page ${page}`);
    }
    for (const [path, base, head] of [
      ['/repos/HolaHolaOrganization/HolaHola', 'main', NEWER_BASE],
      ['/repos/HolaHolaOrganization/HolaHola', BASE, `${NEWER_BASE}/../x`],
      ['/repos/../HolaHola', BASE, NEWER_BASE],
      ['/repos/HolaHolaOrganization/HolaHola/extra', BASE, NEWER_BASE],
    ]) {
      await assert.rejects(api.compareCommits('t', path, base, head), TypeError, `${path} ${base} ${head}`);
    }
    await assert.rejects(api.rest('t', 'GET', `/repos/o/r/compare/${BASE}...${NEWER_BASE}`), TypeError);
    assert.equal(seen.length, 1);
  });
});
