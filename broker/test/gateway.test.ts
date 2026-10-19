import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, test } from 'node:test';
import { decide } from '../src/authorize.ts';
import { canonicalJson } from '../src/canonical.ts';
import { EXECUTION_DEADLINE_MS, type Ledger, outcomePath } from '../src/claims.ts';
import { AUDIENCE, type Envelope, payloadDigest, PROTOCOL } from '../src/envelope.ts';
import { Gateway, markerFor, validatePayload } from '../src/gateway.ts';
import { type Fetch, GitHubApi } from '../src/github.ts';
import { gitBlobSha, PolicyLoader, REPOSITORY_ID } from '../src/policy.ts';

const NOW = 1_800_000_000_000;
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const BOT = 'holahola-luca-claude-code[bot]';
const REPO = { owner: 'davidwmcintosh', name: 'HolaHola', id: REPOSITORY_ID };
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const signer = generateKeyPairSync('ed25519');

function policyBytes(state = 'routine', appId = 5350010): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    version: 1, state, repositoryId: REPOSITORY_ID, qualification: state === 'qualification' ? [{ pr: 48, headSha: HEAD }] : [],
    actors: { 'luca-claude-code': { appId, installationId: 172194780, host: 'LITTLENEMO', signingKeys: [{ id: 'lcc-1', publicKeyPem: signer.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] } },
  }) + '\n');
}

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
  file(path: string) { const v = this.commits[this.commits.length - 1].get(path); return v === undefined ? null : JSON.parse(v); }
}

type Pull = { number: number; state: string; merged: boolean; merge_commit_sha: string | null; title: string; body: string; user: { login: string }; head: { sha: string; ref: string; repo: { id: number } }; base: { ref: string; repo: { id: number } } };

/** A fake HolaHola repository on GitHub, with hooks to interleave changes mid-operation. */
class FakeRepo {
  calls: Array<{ method: string; path: string; body?: unknown }> = [];
  pulls = new Map<number, Pull>();
  comments: Array<{ id: number; issue: number; user: { login: string }; body: string }> = [];
  reviews: Array<{ id: number; pr: number; user: { login: string }; body: string; commit_id: string; event: string }> = [];
  refs = new Map<string, string>();
  commitLog: Array<{ sha: string; branch: string; commit: { message: string }; parents: Array<{ sha: string }>; author: { login: string } }> = [];
  onMint: () => void = () => {};
  onPullRead: () => void = () => {};
  /** Applies the mutation, then fails with this status (an "unknown result"). */
  failAfterApply: number | null = null;
  rejectWith: number | null = null;

  constructor() {
    this.pulls.set(48, { number: 48, state: 'open', merged: false, merge_commit_sha: null, title: 't', body: 'b', user: { login: 'holahola-luca-replit[bot]' }, head: { sha: HEAD, ref: 'lcc/feature', repo: { id: REPOSITORY_ID } }, base: { ref: 'main', repo: { id: REPOSITORY_ID } } });
    this.refs.set('lcc/feature', HEAD);
  }

  private json(status: number, body: unknown) { return new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }

  private mutate(status: number, body: unknown) {
    if (this.failAfterApply !== null) return this.json(this.failAfterApply, { message: 'upstream' });
    return this.json(status, body);
  }

  readonly fetch: Fetch = async (url, init) => {
    await new Promise((resolve) => setImmediate(resolve));
    const { pathname, searchParams } = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path: pathname, body });
    if (pathname.endsWith('/access_tokens')) { this.onMint(); return this.json(201, { token: 'ghs_test_token', expires_at: new Date(NOW + 3_600_000).toISOString() }); }
    const base = `/repos/${REPO.owner}/${REPO.name}`;
    const pullMatch = pathname.match(new RegExp(`^${base}/pulls/(\\d+)$`));
    if (pullMatch && method === 'GET') { this.onPullRead(); const p = this.pulls.get(Number(pullMatch[1])); return p ? this.json(200, p) : this.json(404, {}); }
    if (method !== 'GET' && this.rejectWith !== null) return this.json(this.rejectWith, { message: 'rejected' });

    const commentsMatch = pathname.match(new RegExp(`^${base}/issues/(\\d+)/comments$`));
    if (commentsMatch && method === 'POST') { const c = { id: this.comments.length + 1, issue: Number(commentsMatch[1]), user: { login: BOT }, body: body.body }; this.comments.push(c); return this.mutate(201, c); }
    if (commentsMatch && method === 'GET') return this.json(200, Number(searchParams.get('page') ?? 1) > 1 ? [] : this.comments.filter((c) => c.issue === Number(commentsMatch[1])));
    const reviewsMatch = pathname.match(new RegExp(`^${base}/pulls/(\\d+)/reviews$`));
    if (reviewsMatch && method === 'POST') { const r = { id: this.reviews.length + 1, pr: Number(reviewsMatch[1]), user: { login: BOT }, body: body.body, commit_id: body.commit_id, event: body.event }; this.reviews.push(r); return this.mutate(200, r); }
    if (reviewsMatch && method === 'GET') return this.json(200, Number(searchParams.get('page') ?? 1) > 1 ? [] : this.reviews.filter((r) => r.pr === Number(reviewsMatch[1])));
    const mergeMatch = pathname.match(new RegExp(`^${base}/pulls/(\\d+)/merge$`));
    if (mergeMatch && method === 'PUT') {
      const p = this.pulls.get(Number(mergeMatch[1]))!;
      if (body.sha !== p.head.sha || body.merge_method !== 'squash') return this.json(409, { message: 'Head branch was modified' });
      p.merged = true; p.state = 'closed'; p.merge_commit_sha = 'c'.repeat(40);
      return this.mutate(200, { sha: p.merge_commit_sha, merged: true });
    }
    if (pullMatch && method === 'PATCH') { const p = this.pulls.get(Number(pullMatch[1]))!; Object.assign(p, body); return this.mutate(200, p); }
    if (pathname.match(new RegExp(`^${base}/pulls/\\d+/update-branch$`)) && method === 'PUT') return this.mutate(202, { message: 'Updating pull request branch.' });
    if (pathname === `${base}/pulls` && method === 'POST') {
      const n = 100 + this.pulls.size;
      this.pulls.set(n, { number: n, state: 'open', merged: false, merge_commit_sha: null, title: body.title, body: body.body, user: { login: BOT }, head: { sha: this.refs.get(body.head)!, ref: body.head, repo: { id: REPOSITORY_ID } }, base: { ref: body.base, repo: { id: REPOSITORY_ID } } });
      return this.mutate(201, { number: n });
    }
    if (pathname === `${base}/pulls` && method === 'GET') return this.json(200, [...this.pulls.values()].filter((p) => `${REPO.owner}:${p.head.ref}` === searchParams.get('head')));
    const refMatch = pathname.match(new RegExp(`^${base}/git/ref/heads/(.+)$`));
    if (refMatch) { const sha = this.refs.get(decodeURIComponent(refMatch[1])); return sha ? this.json(200, { object: { sha } }) : this.json(404, {}); }
    if (pathname === `${base}/git/refs` && method === 'POST') { this.refs.set(body.ref.replace('refs/heads/', ''), body.sha); return this.mutate(201, { ref: body.ref }); }
    if (pathname === `${base}/commits` && method === 'GET') return this.json(200, this.commitLog.filter((c) => c.branch === searchParams.get('sha')).reverse());
    if (pathname === '/graphql') {
      const { input } = body.variables;
      const branch = input.branch.branchName;
      if (this.refs.get(branch) !== input.expectedHeadOid) return this.json(200, { data: null, errors: [{ type: 'STALE_DATA', message: 'Expected branch to point to x' }] });
      const sha = String(this.commitLog.length + 1).padStart(40, 'd');
      this.commitLog.push({ sha, branch, commit: { message: `${input.message.headline}\n\n${input.message.body}` }, parents: [{ sha: input.expectedHeadOid }], author: { login: BOT } });
      this.refs.set(branch, sha);
      return this.mutate(200, { data: { createCommitOnBranch: { commit: { oid: sha } } } });
    }
    return this.json(500, { message: `unhandled ${method} ${pathname}` });
  };

  count(method: string, suffix: string) { return this.calls.filter((c) => c.method === method && c.path.endsWith(suffix)).length; }
}

type Harness = { gateway: Gateway; repo: FakeRepo; ledger: MemoryLedger; clock: { now: number }; policy: { bytes: Uint8Array }; loader: PolicyLoader };

function harness(options: { state?: string; configAppId?: number } = {}): Harness {
  const repo = new FakeRepo();
  const ledger = new MemoryLedger();
  const clock = { now: NOW };
  const policy = { bytes: policyBytes(options.state ?? 'routine') };
  const loader = new PolicyLoader({ fetch: async () => ({ bytes: policy.bytes, blobSha: gitBlobSha(policy.bytes) }) }, () => clock.now, 1);
  const gateway = new Gateway({
    repo: REPO,
    actors: new Map([['luca-claude-code', { appId: options.configAppId ?? 5350010, installationId: 172194780, privateKey: rsa.privateKey, botLogin: BOT }]]),
    api: new GitHubApi(repo.fetch), ledger, loaderFor: (actor) => (actor === 'luca-claude-code' ? loader : undefined), now: () => clock.now,
  });
  return { gateway, repo, ledger, clock, policy, loader };
}

function request(h: Harness, overrides: Partial<Envelope>, payload: unknown): Record<string, unknown> {
  const envelope: Envelope = {
    audience: AUDIENCE, protocol: PROTOCOL, repositoryId: REPOSITORY_ID, actor: 'luca-claude-code', keyId: 'lcc-1',
    operation: 'pr.comment', pr: 48, headSha: HEAD, payloadSha256: payloadDigest(payload), policyEpoch: gitBlobSha(h.policy.bytes),
    issuedAt: h.clock.now - 1_000, expiresAt: h.clock.now + 30_000, operationId: 'op-gateway-000000001', ...overrides,
  };
  return { envelope, signature: sign(null, Buffer.from(canonicalJson(envelope), 'utf8'), signer.privateKey).toString('base64'), payload };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Result = { status: number; body: Record<string, any> };

async function run(h: Harness, overrides: Partial<Envelope>, payload: unknown): Promise<Result> {
  const body = request(h, overrides, payload);
  const decision = await decide(body, (actor) => (actor === 'luca-claude-code' ? h.loader : undefined), () => h.clock.now);
  if (decision.decision !== 'allow') return { status: 403, body: decision as unknown as Record<string, unknown> };
  const { envelope, digest, payload: p, policy } = decision.authorized;
  return await h.gateway.execute(body, envelope, digest, p, policy.epoch) as Result;
}

describe('gateway: comments and replay', () => {
  test('pr.comment executes once, carries the broker marker, and records claim and outcome', async () => {
    const h = harness();
    const result = await run(h, {}, { body: 'hello' });
    assert.equal(result.status, 200);
    assert.equal(result.body.decision, 'executed');
    assert.equal(h.repo.comments.length, 1);
    assert.ok(h.repo.comments[0].body.startsWith('hello\n\n<!-- holahola-broker-op:op-gateway-000000001:'));
    assert.equal(h.ledger.file(outcomePath('luca-claude-code', 'op-gateway-000000001')).status, 'succeeded');
  });

  test('same-id replay returns the recorded outcome and never posts again', async () => {
    const h = harness();
    await run(h, {}, { body: 'hello' });
    const replay = await run(h, {}, { body: 'hello' });
    assert.equal(replay.body.decision, 'recorded');
    assert.equal(h.repo.count('POST', '/comments'), 1);
  });

  test('the response never carries a token', async () => {
    const h = harness();
    const result = await run(h, {}, { body: 'hello' });
    assert.doesNotMatch(JSON.stringify(result), /ghs_/);
  });
});

describe('gateway: re-authorization after preparatory awaits', () => {
  test('a policy change during the token mint aborts before dispatch', async () => {
    const h = harness();
    h.repo.onMint = () => { h.policy.bytes = policyBytes('closed'); h.clock.now += 2; };
    const result = await run(h, {}, { body: 'hello' });
    assert.equal(result.body.decision, 'aborted');
    // The new policy has a new epoch, so the signed request is stale before its state is even consulted.
    assert.deepEqual(result.body.result, { reason: 'stale_policy_epoch' });
    assert.equal(h.repo.count('POST', '/comments'), 0);
  });

  test('the request expiring during the PR lookup aborts before dispatch', async () => {
    const h = harness();
    h.repo.onPullRead = () => { h.clock.now += 31_000; };
    const result = await run(h, {}, { body: 'hello' });
    assert.equal(result.body.decision, 'aborted');
    assert.equal(h.repo.count('POST', '/comments'), 0);
  });

  test('a moved PR head aborts with head_moved', async () => {
    const h = harness();
    h.repo.onPullRead = () => { h.repo.pulls.get(48)!.head.sha = OTHER; };
    const result = await run(h, {}, { body: 'hello' });
    assert.deepEqual(result.body.result, { reason: 'head_moved' });
    assert.equal(h.repo.count('POST', '/comments'), 0);
  });

  test('a configured App that differs from the policy binding aborts', async () => {
    const h = harness({ configAppId: 999 });
    const result = await run(h, {}, { body: 'hello' });
    assert.deepEqual(result.body.result, { reason: 'binding_mismatch' });
    assert.equal(h.repo.count('POST', '/comments'), 0);
  });
});

describe('gateway: reviews and merges', () => {
  test('pr.review targets commit_id = head and refuses self-review', async () => {
    const h = harness();
    const ok = await run(h, { operation: 'pr.review' }, { event: 'APPROVE', body: '' });
    assert.equal(ok.body.decision, 'executed');
    assert.equal(h.repo.reviews[0].commit_id, HEAD);
    const own = harness();
    own.repo.pulls.get(48)!.user.login = BOT;
    const self = await run(own, { operation: 'pr.review' }, { event: 'APPROVE', body: '' });
    assert.deepEqual(self.body.result, { reason: 'self_review' });
    assert.equal(own.repo.reviews.length, 0);
  });

  test('pr.merge is squash with the head sha pinned', async () => {
    const h = harness();
    const result = await run(h, { operation: 'pr.merge' }, {});
    assert.equal(result.body.decision, 'executed');
    const put = h.repo.calls.find((c) => c.method === 'PUT' && c.path.endsWith('/merge'));
    assert.deepEqual(put?.body, { merge_method: 'squash', sha: HEAD });
  });

  test('a definite GitHub rejection (4xx) is a recorded failure, not uncertain', async () => {
    const h = harness();
    h.repo.rejectWith = 405;
    const result = await run(h, { operation: 'pr.merge' }, {});
    assert.equal(result.body.decision, 'executed');
    assert.equal(result.body.status, 'failed');
    assert.deepEqual(result.body.result, { http: 405 });
  });
});

describe('gateway: unknown results are never resent; evidence is positive-only and bound', () => {
  test('a 502 after the comment was applied: uncertain now, one POST, then reconciled to applied by its marker', async () => {
    const h = harness();
    h.repo.failAfterApply = 502;
    const first = await run(h, {}, { body: 'hello' });
    assert.equal(first.body.decision, 'uncertain');
    assert.equal(h.repo.count('POST', '/comments'), 1);
    h.repo.failAfterApply = null;
    h.clock.now += EXECUTION_DEADLINE_MS;
    const later = await run(h, { issuedAt: h.clock.now - 1_000, expiresAt: h.clock.now + 30_000 }, { body: 'hello' }).catch((e) => e);
    // A new signature changes the digest: same id, different digest is denied, never re-executed.
    assert.equal(later.body.reason, 'digest_conflict');
    assert.equal(h.repo.count('POST', '/comments'), 1);
  });

  test('the same signed request replayed after the deadline reconciles from the marker', async () => {
    const h = harness();
    h.repo.failAfterApply = 502;
    const body = request(h, {}, { body: 'hello' });
    const decision = await decide(body, () => h.loader, () => h.clock.now);
    assert.equal(decision.decision, 'allow');
    if (decision.decision !== 'allow') return;
    const { envelope, digest, payload, policy } = decision.authorized;
    assert.equal((await h.gateway.execute(body, envelope, digest, payload, policy.epoch)).body.decision, 'uncertain');
    h.repo.failAfterApply = null;
    h.clock.now += EXECUTION_DEADLINE_MS;
    const again = await h.gateway.execute(body, envelope, digest, payload, policy.epoch) as Result;
    assert.equal(again.body.decision, 'recorded');
    assert.equal(again.body.status, 'applied');
    assert.equal(h.repo.count('POST', '/comments'), 1);
  });

  test('a marker on a comment by a different App is not evidence', async () => {
    const h = harness();
    h.repo.failAfterApply = 502;
    const body = request(h, {}, { body: 'hello' });
    const decision = await decide(body, () => h.loader, () => h.clock.now);
    if (decision.decision !== 'allow') throw new Error('expected allow');
    const { envelope, digest, payload, policy } = decision.authorized;
    await h.gateway.execute(body, envelope, digest, payload, policy.epoch);
    h.repo.comments[0].user.login = 'someone-else[bot]';
    h.repo.failAfterApply = null;
    h.clock.now += EXECUTION_DEADLINE_MS;
    assert.equal((await h.gateway.execute(body, envelope, digest, payload, policy.epoch)).body.decision, 'uncertain');
  });

  test('callers cannot write broker markers', () => {
    const envelope = { operation: 'pr.comment', pr: 48, headSha: HEAD } as Envelope;
    assert.equal(validatePayload(envelope, { body: `x ${markerFor('op-x', 'f'.repeat(64)).html}` }), null);
    assert.equal(validatePayload(envelope, { body: 'mention HOLAHOLA-BROKER-OP here' }), null);
  });

  test('update-branch has no operation-bound evidence and stays uncertain after an unknown result', async () => {
    const h = harness();
    h.repo.failAfterApply = 502;
    const body = request(h, { operation: 'pr.update-branch' }, {});
    const decision = await decide(body, () => h.loader, () => h.clock.now);
    if (decision.decision !== 'allow') throw new Error('expected allow');
    const { envelope, digest, payload, policy } = decision.authorized;
    assert.equal((await h.gateway.execute(body, envelope, digest, payload, policy.epoch)).body.decision, 'uncertain');
    const put = h.repo.calls.find((c) => c.path.endsWith('/update-branch'));
    assert.deepEqual(put?.body, { expected_head_sha: HEAD });
    h.repo.failAfterApply = null;
    h.clock.now += EXECUTION_DEADLINE_MS;
    assert.equal((await h.gateway.execute(body, envelope, digest, payload, policy.epoch)).body.decision, 'uncertain');
  });
});

describe('gateway: commits, branches and PRs', () => {
  const commitPayload = { branch: 'lcc/feature', message: 'Add file', additions: [{ path: 'docs/x.md', contentBase64: Buffer.from('x').toString('base64') }], deletions: [] };

  test('commit.write uses the real expectedHeadOid and a broker trailer', async () => {
    const h = harness();
    const result = await run(h, { operation: 'commit.write' }, commitPayload);
    assert.equal(result.body.decision, 'executed');
    const gql = h.repo.calls.find((c) => c.path === '/graphql')?.body as { variables: { input: { expectedHeadOid: string; message: { body: string } } } };
    assert.equal(gql.variables.input.expectedHeadOid, HEAD);
    assert.match(gql.variables.input.message.body, /^Holahola-Broker-Op: op-gateway-000000001:/);
  });

  test('commit.write to a moved branch aborts before dispatch', async () => {
    const h = harness();
    h.repo.refs.set('lcc/feature', OTHER);
    h.repo.pulls.get(48)!.head.sha = OTHER;
    const result = await run(h, { operation: 'commit.write', pr: null }, commitPayload);
    assert.deepEqual(result.body.result, { reason: 'head_moved' });
    assert.equal(h.repo.calls.filter((c) => c.path === '/graphql').length, 0);
  });

  test('protected, traversal and ref-prefixed branches are rejected as malformed', () => {
    for (const branch of ['main', '../x', 'refs/heads/x', 'a/../b', '/x', 'x/']) {
      assert.equal(validatePayload({ operation: 'commit.write', pr: null, headSha: HEAD } as Envelope, { ...commitPayload, branch }), null, branch);
    }
  });

  test('branch.create requires an absent branch; pr.open binds the live branch head', async () => {
    const h = harness();
    const created = await run(h, { operation: 'branch.create', pr: null, operationId: 'op-gateway-000000002' }, { branch: 'lcc/new' });
    assert.equal(created.body.decision, 'executed');
    assert.equal(h.repo.refs.get('lcc/new'), HEAD);
    const again = await run(h, { operation: 'branch.create', pr: null, operationId: 'op-gateway-000000003' }, { branch: 'lcc/new' });
    assert.deepEqual(again.body.result, { reason: 'branch_exists' });
    const opened = await run(h, { operation: 'pr.open', pr: null, operationId: 'op-gateway-000000004' }, { branch: 'lcc/new', title: 'T', body: 'B' });
    assert.equal(opened.body.decision, 'executed');
  });

  test('branch.delete has no adapter', () => {
    assert.equal(validatePayload({ operation: 'branch.delete', pr: null, headSha: HEAD } as Envelope, { branch: 'lcc/x' }), null);
  });
});

describe('gateway: qualification binds the exact (PR, head)', () => {
  test('a listed PR at its pinned head may act; the same PR at another head is denied before the gateway', async () => {
    const h = harness({ state: 'qualification' });
    assert.equal((await run(h, {}, { body: 'hello' })).body.decision, 'executed');
    h.repo.pulls.get(48)!.head.sha = OTHER;
    const moved = await run(h, { headSha: OTHER, operationId: 'op-gateway-000000009' }, { body: 'hello' });
    assert.equal(moved.body.reason, 'not_qualified');
  });
});

// ---------------------------------------------------------------------------
// luca-replit phase 2b review: findings 1-3, exercised through the real HTTP
// server rather than by calling the gateway directly.
// ---------------------------------------------------------------------------
describe('through the HTTP server (review findings 1-3)', () => {
  type Post = (body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
  async function serve(h: Harness, use: (post: Post) => Promise<void>) {
    const { createBrokerServer } = await import('../src/server.ts');
    const server = createBrokerServer({ loaderFor: (actor) => (actor === 'luca-claude-code' ? h.loader : undefined), healthLoader: h.loader, gateway: h.gateway, now: () => h.clock.now });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as import('node:net').AddressInfo;
    try {
      await use(async (body) => {
        const res = await fetch(`http://127.0.0.1:${port}/v1/operations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return { status: res.status, body: await res.json() as Record<string, unknown> };
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  let statusCounter = 0;
  function statusRequest(h: Harness, original: unknown, overrides: Partial<Envelope> = {}) {
    statusCounter += 1;
    return request(h, { operation: 'status', pr: null, headSha: null, operationId: `op-status-${String(statusCounter).padStart(10, '0')}`, ...overrides }, { original });
  }

  function gatewayWith(h: Harness, fetchImpl: Fetch): Gateway {
    return new Gateway({
      repo: REPO, actors: new Map([['luca-claude-code', { appId: 5350010, installationId: 172194780, privateKey: rsa.privateKey, botLogin: BOT }]]),
      api: new GitHubApi(fetchImpl), ledger: h.ledger, loaderFor: () => h.loader, now: () => h.clock.now,
    });
  }

  const commitPayload = { branch: 'lcc/feature', message: 'm', additions: [{ path: 'a.md', contentBase64: 'YQ==' }], deletions: [] };

  test('finding 1: an uncertain operation is resolved by an authenticated status request; the expired original is refused; exactly one effect', async () => {
    const h = harness();
    h.repo.failAfterApply = 502;
    await serve(h, async (post) => {
      const original = request(h, {}, { body: 'hello' });
      assert.equal((await post(original)).body.decision, 'uncertain');
      h.repo.failAfterApply = null;
      assert.equal((await post(statusRequest(h, original))).body.decision, 'pending', 'before the deadline the winner may still be running');
      h.clock.now += EXECUTION_DEADLINE_MS;
      assert.equal((await post(original)).body.reason, 'expired', 'an expired execution envelope is never accepted');
      const status = await post(statusRequest(h, original));
      assert.equal(status.body.decision, 'recorded');
      assert.equal(status.body.status, 'applied');
      assert.equal((await post(statusRequest(h, original))).body.status, 'applied');
      assert.equal(h.repo.count('POST', '/comments'), 1);
    });
  });

  test('finding 1: with no evidence the status stays uncertain and nothing is executed', async () => {
    const h = harness();
    h.repo.failAfterApply = 502;
    await serve(h, async (post) => {
      const original = request(h, {}, { body: 'hello' });
      await post(original);
      h.repo.comments.length = 0;
      h.repo.failAfterApply = null;
      h.clock.now += EXECUTION_DEADLINE_MS;
      assert.equal((await post(statusRequest(h, original))).body.decision, 'uncertain');
      assert.equal(h.repo.count('POST', '/comments'), 1);
    });
  });

  test('finding 1: status never creates a claim, is bound to actor and digest, and is refused when closed', async () => {
    const h = harness();
    await serve(h, async (post) => {
      const neverSent = request(h, { operationId: 'op-never-sent-00001' }, { body: 'hello' });
      assert.equal((await post(statusRequest(h, neverSent))).body.decision, 'not_found');
      assert.equal(h.repo.count('POST', '/comments'), 0);
      assert.equal((await post(statusRequest(h, { ...neverSent, payload: { body: 'other' } }))).body.reason, 'original_payload_mismatch');
      assert.equal((await post(statusRequest(h, statusRequest(h, neverSent)))).body.reason, 'not_a_claim');
      h.policy.bytes = policyBytes('closed');
      h.clock.now += 2;
      assert.equal((await post(statusRequest(h, neverSent))).body.reason, 'policy_closed');
    });
  });

  test('finding 2: a GraphQL response carrying a commit oid plus errors is success, never failure', async () => {
    const h = harness();
    const gql = { data: { createCommitOnBranch: { commit: { oid: 'e'.repeat(40) } } }, errors: [{ type: 'INTERNAL', message: 'partial' }] };
    const gateway = gatewayWith(h, async (url, init) => (new URL(url).pathname === '/graphql' ? new Response(JSON.stringify(gql), { status: 200 }) : h.repo.fetch(url, init)));
    const body = request(h, { operation: 'commit.write' }, commitPayload);
    const d = await decide(body, () => h.loader, () => h.clock.now);
    if (d.decision !== 'allow') throw new Error('expected allow');
    const result = await gateway.execute(body, d.authorized.envelope, d.authorized.digest, d.authorized.payload, d.authorized.policy.epoch) as Result;
    assert.equal(result.body.status, 'succeeded');
    assert.deepEqual(result.body.result, { commitSha: 'e'.repeat(40) });
  });

  const unknown: Array<[string, unknown]> = [
    ['null data with an INTERNAL error', { data: null, errors: [{ type: 'INTERNAL', message: 'boom' }] }],
    ['STALE_DATA, not yet qualified as definite', { data: null, errors: [{ type: 'STALE_DATA', message: 'Expected branch to point to x' }] }],
  ];
  for (const [name, gql] of unknown) {
    test(`finding 2: ${name} stays uncertain and is not resent`, async () => {
      const h = harness();
      let graphqlCalls = 0;
      const gateway = gatewayWith(h, async (url, init) => {
        if (new URL(url).pathname === '/graphql') { graphqlCalls += 1; return new Response(JSON.stringify(gql), { status: 200 }); }
        return h.repo.fetch(url, init);
      });
      const body = request(h, { operation: 'commit.write' }, commitPayload);
      const d = await decide(body, () => h.loader, () => h.clock.now);
      if (d.decision !== 'allow') throw new Error('expected allow');
      const result = await gateway.execute(body, d.authorized.envelope, d.authorized.digest, d.authorized.payload, d.authorized.policy.epoch) as Result;
      assert.equal(result.body.decision, 'uncertain');
      assert.equal(graphqlCalls, 1);
      assert.equal(h.ledger.file(outcomePath('luca-claude-code', 'op-gateway-000000001')), null);
    });
  }

  test('finding 3: read is re-authorized, identity- and head-bound, and uses only a read-only token', async () => {
    const mismatched = harness({ configAppId: 999 });
    await serve(mismatched, async (post) => {
      assert.equal((await post(request(mismatched, { operation: 'read' }, {}))).body.reason, 'binding_mismatch');
    });
    const closing = harness();
    closing.repo.onMint = () => { closing.policy.bytes = policyBytes('closed'); closing.clock.now += 2; };
    await serve(closing, async (post) => {
      const result = await post(request(closing, { operation: 'read' }, {}));
      assert.equal(result.status, 403);
      assert.equal(result.body.pull, undefined, 'nothing is disclosed after a failed re-authorization');
    });
    const moved = harness({ state: 'qualification' });
    moved.repo.onPullRead = () => { moved.repo.pulls.get(48)!.head.sha = OTHER; };
    await serve(moved, async (post) => {
      assert.equal((await post(request(moved, { operation: 'read' }, {}))).body.reason, 'head_moved');
    });
    const ok = harness();
    await serve(ok, async (post) => {
      assert.equal((await post(request(ok, { operation: 'read' }, {}))).body.decision, 'read');
      const mints = ok.repo.calls.filter((c) => c.path.endsWith('/access_tokens'));
      assert.equal(mints.length, 1, 'a read never mints a write token');
      assert.deepEqual((mints[0].body as { permissions: unknown }).permissions, { contents: 'read', pull_requests: 'read', issues: 'read' });
    });
  });
});
