// Stage-1 design sections 5 and 7: bounded object reads (R1 repository
// identity with the default branch head, a branch-head read, R4 commit, R5
// tree). Read-only token, fixed fields, no claim or ledger write, and full
// re-authorization after the GitHub awaits.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, test } from 'node:test';
import { decide } from '../src/authorize.ts';
import { canonicalJson } from '../src/canonical.ts';
import { type Ledger } from '../src/claims.ts';
import { AUDIENCE, type Envelope, payloadDigest, PROTOCOL } from '../src/envelope.ts';
import { Gateway, validatePayload } from '../src/gateway.ts';
import { type Fetch, GitHubApi } from '../src/github.ts';
import { gitBlobSha, PolicyLoader, REPOSITORY_ID } from '../src/policy.ts';

const NOW = 1_800_000_000_000;
const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const PARENT = 'c'.repeat(40);
const BOT = 'holahola-luca-claude-code[bot]';
const REPO = { owner: 'HolaHolaOrganization', name: 'HolaHola', id: REPOSITORY_ID };
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const signer = generateKeyPairSync('ed25519');

const policyBytes = (state = 'routine') => new TextEncoder().encode(JSON.stringify({
  version: 1, state, repositoryId: REPOSITORY_ID, qualification: state === 'qualification' ? [{ pr: 48, headSha: HEAD }] : [],
  actors: { 'luca-claude-code': { appId: 5350010, installationId: 172194780, host: 'LITTLENEMO', signingKeys: [{ id: 'lcc-1', publicKeyPem: signer.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] } },
}));

/** Any write to this ledger fails the test: reads never touch it. */
class NoLedger implements Ledger {
  async head(): Promise<string> { throw new Error('reads must not touch the ledger'); }
  async read(): Promise<string | null> { throw new Error('reads must not touch the ledger'); }
  async commit(): Promise<{ ok: false }> { throw new Error('reads must not touch the ledger'); }
}

class FakeGitHub {
  calls: Array<{ method: string; path: string; search: string }> = [];
  mints: Array<Record<string, unknown>> = [];
  repoId = REPOSITORY_ID;
  refs = new Map<string, string>([['main', HEAD]]);
  truncated = false;
  treeEntries = 3;
  commitShaOverride: string | null = null;
  treeShaOverride: string | null = null;
  onRead: () => void = () => {};
  fail = false;
  failMint = false;
  networkError = false;

  private json(status: number, body: unknown) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }

  readonly fetch: Fetch = async (url, init) => {
    await new Promise((resolve) => setImmediate(resolve));
    const { pathname, search } = new URL(url);
    const method = init.method ?? 'GET';
    this.calls.push({ method, path: pathname, search });
    if (pathname.endsWith('/access_tokens')) {
      if (this.failMint) return this.json(503, {});
      this.mints.push(JSON.parse(String(init.body)).permissions);
      return this.json(201, { token: 'ghs_t', expires_at: new Date(NOW + 3_600_000).toISOString() });
    }
    this.onRead();
    if (this.networkError) throw new TypeError('fetch failed');
    if (this.fail) return this.json(503, {});
    const base = `/repos/${REPO.owner}/${REPO.name}`;
    if (pathname === base) return this.json(200, { id: this.repoId, full_name: 'HolaHolaOrganization/HolaHola', default_branch: 'main', private: true });
    const ref = pathname.match(new RegExp(`^${base}/git/ref/heads/(.+)$`));
    if (ref) { const sha = this.refs.get(decodeURIComponent(ref[1])); return sha ? this.json(200, { object: { sha } }) : this.json(404, {}); }
    const commit = pathname.match(new RegExp(`^${base}/git/commits/([0-9a-f]{40})$`));
    if (commit) {
      if (commit[1] !== HEAD) return this.json(404, {});
      return this.json(200, {
        sha: this.commitShaOverride ?? HEAD, tree: { sha: TREE }, parents: [{ sha: PARENT }], message: 'Initial\n',
        author: { name: 'A', email: 'a@x', date: '2026-10-28T00:00:00Z' }, committer: { name: 'C', email: 'c@x', date: '2026-10-28T00:00:01Z' },
        verification: { verified: true }, html_url: 'https://github.com/x', node_id: 'C_x',
      });
    }
    const tree = pathname.match(new RegExp(`^${base}/git/trees/([0-9a-f]{40})$`));
    if (tree) {
      if (tree[1] !== TREE) return this.json(404, {});
      return this.json(200, {
        sha: this.treeShaOverride ?? TREE, truncated: this.truncated, url: 'https://api.github.com/x',
        tree: Array.from({ length: this.treeEntries }, (_, i) => ({ path: `f${i}`, mode: '100644', type: 'blob', sha: i.toString(16).padStart(40, '0'), size: i, url: 'https://api.github.com/y' })),
      });
    }
    return this.json(500, { message: `unhandled ${method} ${pathname}` });
  };
}

function harness(state = 'routine') {
  const github = new FakeGitHub();
  const logs: string[] = [];
  const clock = { now: NOW };
  const policy = { bytes: policyBytes(state) };
  const loader = new PolicyLoader({ fetch: async () => ({ bytes: policy.bytes, blobSha: gitBlobSha(policy.bytes) }) }, () => clock.now, 1);
  const gateway = new Gateway({
    repo: REPO,
    actors: new Map([['luca-claude-code', { appId: 5350010, installationId: 172194780, privateKey: rsa.privateKey, botLogin: BOT }]]),
    api: new GitHubApi(github.fetch), ledger: new NoLedger(), loaderFor: () => loader, now: () => clock.now, log: (line) => logs.push(line),
  });
  return { github, clock, policy, loader, gateway, logs };
}
type H = ReturnType<typeof harness>;

let counter = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function read(h: H, operation: Envelope['operation'], payload: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const envelope: Envelope = {
    audience: AUDIENCE, protocol: PROTOCOL, repositoryId: REPOSITORY_ID, actor: 'luca-claude-code', keyId: 'lcc-1',
    operation, pr: null, headSha: null, payloadSha256: payloadDigest(payload), policyEpoch: gitBlobSha(h.policy.bytes),
    issuedAt: h.clock.now - 1_000, expiresAt: h.clock.now + 30_000, operationId: `op-read-${String(++counter).padStart(14, '0')}`,
  };
  const signed = { envelope, signature: sign(null, Buffer.from(canonicalJson(envelope), 'utf8'), signer.privateKey).toString('base64'), payload };
  const decision = await decide(signed, () => h.loader, () => h.clock.now);
  if (decision.decision !== 'allow') return { status: 403, body: decision as unknown as Record<string, unknown> };
  const { envelope: e, digest, payload: p, policy } = decision.authorized;
  return await h.gateway.execute(signed, e, digest, p, policy.epoch) as { status: number; body: Record<string, unknown> };
}

describe('object reads: fixed fields from the target repository only', () => {
  test('read.repository returns the identity and the default branch head', async () => {
    const h = harness();
    const r = await read(h, 'read.repository', {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.repository, { id: REPOSITORY_ID, fullName: 'HolaHolaOrganization/HolaHola', defaultBranch: 'main', defaultBranchHead: HEAD });
  });

  test('read.repository refuses a repository whose id is not the configured target', async () => {
    const h = harness();
    h.github.repoId = 1;
    assert.equal((await read(h, 'read.repository', {})).body.reason, 'wrong_repository');
  });

  test('read.ref returns a branch head, or null when the branch is absent; the default branch is readable', async () => {
    const h = harness();
    assert.deepEqual((await read(h, 'read.ref', { branch: 'main' })).body.ref, { branch: 'main', sha: HEAD });
    assert.deepEqual((await read(h, 'read.ref', { branch: 'lcc/none' })).body.ref, { branch: 'lcc/none', sha: null });
  });

  test('read.commit returns only the fixed fields, and refuses a response for another sha', async () => {
    const h = harness();
    const r = await read(h, 'read.commit', { sha: HEAD });
    assert.deepEqual(r.body.commit, {
      sha: HEAD, tree: TREE, parents: [PARENT], message: 'Initial\n',
      author: { name: 'A', email: 'a@x', date: '2026-10-28T00:00:00Z' }, committer: { name: 'C', email: 'c@x', date: '2026-10-28T00:00:01Z' },
    });
    assert.deepEqual((await read(h, 'read.commit', { sha: 'd'.repeat(40) })).body.commit, null, 'absent');
    h.github.commitShaOverride = 'e'.repeat(40);
    assert.equal((await read(h, 'read.commit', { sha: HEAD })).body.reason, 'read_unverifiable');
  });

  test('read.tree carries GitHub\'s truncation as complete:false, and refuses rather than clips an oversized tree', async () => {
    const h = harness();
    const r = await read(h, 'read.tree', { sha: TREE, recursive: true });
    assert.equal(r.body.tree.complete, true);
    assert.deepEqual(r.body.tree.entries[1], { path: 'f1', mode: '100644', type: 'blob', sha: '1'.padStart(40, '0'), size: 1 });
    assert.equal(h.github.calls.find((c) => c.path.includes('/git/trees/'))?.search, '?recursive=1');
    h.github.truncated = true;
    assert.equal((await read(h, 'read.tree', { sha: TREE, recursive: false })).body.tree.complete, false);
    assert.equal(h.github.calls.filter((c) => c.path.includes('/git/trees/')).at(-1)?.search, '');
    h.github.truncated = false;
    h.github.treeEntries = 10_001;
    assert.equal((await read(h, 'read.tree', { sha: TREE, recursive: true })).body.reason, 'too_large');
    h.github.treeEntries = 3;
    h.github.treeShaOverride = 'e'.repeat(40);
    assert.equal((await read(h, 'read.tree', { sha: TREE, recursive: false })).body.reason, 'read_unverifiable', 'a response for another tree');
  });
});

describe('object reads: authority and side effects', () => {
  test('only the read-only token is minted, and the ledger is never touched', async () => {
    const h = harness();
    for (const [op, payload] of [['read.repository', {}], ['read.ref', { branch: 'main' }], ['read.commit', { sha: HEAD }], ['read.tree', { sha: TREE, recursive: false }]] as const) {
      assert.equal((await read(h, op, payload)).status, 200, op);
    }
    assert.deepEqual(h.github.mints, [{ contents: 'read', pull_requests: 'read' }]);
    assert.ok(h.github.calls.every((c) => c.method === 'GET' || c.path.endsWith('/access_tokens')));
  });

  test('a policy change during the GitHub read discloses nothing', async () => {
    const h = harness();
    h.github.onRead = () => { h.policy.bytes = policyBytes('closed'); h.clock.now += 2; };
    const r = await read(h, 'read.repository', {});
    assert.equal(r.status, 403);
    assert.equal(r.body.repository, undefined);
  });

  test('every upstream failure is a 502 without content: an HTTP error, a failed token mint, a network error', async () => {
    const h = harness();
    h.github.fail = true;
    const r = await read(h, 'read.ref', { branch: 'main' });
    assert.deepEqual([r.status, r.body.reason], [502, 'github_unavailable']);
    // C-READ-UPSTREAM-FAILURE: the token mint and network errors are inside the same boundary.
    const mint = harness();
    mint.github.failMint = true;
    const m = await read(mint, 'read.repository', {});
    assert.deepEqual([m.status, m.body.reason, m.body.repository], [502, 'github_unavailable', undefined]);
    const net = harness();
    net.github.networkError = true;
    const n = await read(net, 'read.commit', { sha: HEAD });
    assert.deepEqual([n.status, n.body.reason, n.body.commit], [502, 'github_unavailable', undefined]);
  });

  test('each read writes one bounded service-log line, never a token, signature or content', async () => {
    const h = harness();
    await read(h, 'read.commit', { sha: HEAD });
    h.github.fail = true;
    await read(h, 'read.ref', { branch: 'main' });
    assert.equal(h.logs.length, 2);
    assert.match(h.logs[0], /^broker: read read\.commit actor=luca-claude-code op=op-read-\d+ status=200 outcome=ok$/);
    assert.match(h.logs[1], /^broker: read read\.ref actor=luca-claude-code op=op-read-\d+ status=502 outcome=deny:github_unavailable$/);
    for (const line of h.logs) {
      assert.doesNotMatch(line, /ghs_|Initial|signature|BEGIN/);
    }
  });

  test('closed denies reads; qualification denies these PR-less reads', async () => {
    assert.equal((await read(harness('closed'), 'read.repository', {})).body.reason, 'policy_closed');
    assert.equal((await read(harness('qualification'), 'read.repository', {})).body.reason, 'not_qualified');
  });

  test('payloads are strict: no envelope PR or head, exact fields, well-formed values', () => {
    const env = (operation: string, pr: number | null = null) => ({ operation, pr, headSha: pr ? HEAD : null }) as unknown as Envelope;
    assert.ok(validatePayload(env('read.repository'), {}));
    assert.equal(validatePayload(env('read.repository', 48), {}), null);
    assert.equal(validatePayload(env('read.repository'), { extra: 1 }), null);
    assert.ok(validatePayload(env('read.ref'), { branch: 'lcc/x' }));
    for (const branch of ['../x', 'refs/heads/main', '/x', 'x/', '']) assert.equal(validatePayload(env('read.ref'), { branch }), null, branch);
    assert.equal(validatePayload(env('read.commit'), { sha: 'main' }), null);
    assert.equal(validatePayload(env('read.tree'), { sha: TREE }), null, 'recursive is required');
    assert.equal(validatePayload(env('read.tree'), { sha: TREE, recursive: 'yes' }), null);
  });
});
