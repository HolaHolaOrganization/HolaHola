// Stage 1 publication pipeline (design dc6f8927 revision 4, section 4), run
// offline against a fake Git data API: blob.put -> tree.create ->
// commit.create -> ref.update, and ref.create at the exact live base. Covers
// the design's publication negative cases through BOTH ref routes.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, test } from 'node:test';
import { decide } from '../src/authorize.ts';
import { canonicalJson } from '../src/canonical.ts';
import { claimPath, EXECUTION_DEADLINE_MS, type Ledger, outcomePath } from '../src/claims.ts';
import { AUDIENCE, type Envelope, payloadDigest, PROTOCOL } from '../src/envelope.ts';
import { Gateway, validatePayload } from '../src/gateway.ts';
import { type Fetch, GitHubApi } from '../src/github.ts';
import { gitBlobSha, PolicyLoader, REPOSITORY_ID } from '../src/policy.ts';
import { decodeCanonicalBase64, treePath, withTrailer, ZERO_OID } from '../src/publication.ts';

const NOW = 1_800_000_000_000;
const BOT = 'holahola-luca-claude-code[bot]';
const BOT_EMAIL = `41898282+${BOT}@users.noreply.github.com`;
const REPO = { owner: 'HolaHolaOrganization', name: 'HolaHola', id: REPOSITORY_ID };
const NODE_ID = 'R_kgDOtest';
const BASE = '1'.repeat(40);
const BASE_TREE = '2'.repeat(40);
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const signer = generateKeyPairSync('ed25519');

function policyBytes(state = 'routine'): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    version: 1, state, repositoryId: REPOSITORY_ID, qualification: state === 'qualification' ? [{ pr: 48, headSha: 'a'.repeat(40) }] : [],
    actors: { 'luca-claude-code': { appId: 5350010, installationId: 172194780, host: 'LITTLENEMO', signingKeys: [{ id: 'lcc-1', publicKeyPem: signer.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] } },
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

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');
/** The fake's deterministic tree id for a base tree and entry list (stands in for git's tree hashing). */
const fakeTreeSha = (baseTree: string, tree: unknown) => sha1(`tree ${baseTree} ${JSON.stringify(tree)}`);
const asTree = (entries: Entry[]) => entries.map((e) => ({ path: e.path, mode: e.mode, type: 'blob', sha: e.blobSha }));
type Entry = { path: string; mode: string; blobSha: string | null };

/** A fake Git data API for one repository. */
class FakeGit {
  calls: Array<{ method: string; path: string; body?: unknown }> = [];
  refs = new Map<string, string>([['main', BASE]]);
  objects = new Map<string, { type: string; byteSize: number | null }>([[BASE, { type: 'Commit', byteSize: null }], [BASE_TREE, { type: 'Tree', byteSize: null }]]);
  commits = new Map<string, { tree: string; parents: string[] }>([[BASE, { tree: BASE_TREE, parents: [] }]]);
  rules = new Map<string, unknown[]>();
  pulls = new Map<number, { number: number; state: string; head: { sha: string; ref: string; repo: { id: number } }; base: { ref: string; repo: { id: number } }; user: { login: string } }>();
  /** Applies the next mutation, then answers 502 (an unknown result). */
  failAfterApply = false;
  /** Answers the next tree POST with 502 WITHOUT creating anything. */
  failTreeBeforeApply = false;
  graphqlErrors = false;
  /** Rewrites a commit response before it is returned (postcondition tests). */
  commitResponse: (r: Record<string, unknown>) => Record<string, unknown> = (r) => r;
  updateRefsOverride: unknown = null;

  private json(status: number, body: unknown) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
  private applied(status: number, body: unknown) {
    if (this.failAfterApply) { this.failAfterApply = false; return this.json(502, { message: 'upstream' }); }
    return this.json(status, body);
  }

  readonly fetch: Fetch = async (url, init) => {
    await new Promise((resolve) => setImmediate(resolve));
    const { pathname } = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path: pathname, body });
    if (pathname.endsWith('/access_tokens')) return this.json(201, { token: 'ghs_test_token', expires_at: new Date(NOW + 3_600_000).toISOString() });
    const base = `/repos/${REPO.owner}/${REPO.name}`;
    const ref = pathname.match(new RegExp(`^${base}/git/ref/heads/(.+)$`));
    if (ref) { const sha = this.refs.get(decodeURIComponent(ref[1])); return sha ? this.json(200, { object: { sha } }) : this.json(404, {}); }
    const rules = pathname.match(new RegExp(`^${base}/rules/branches/(.+)$`));
    if (rules) return this.json(200, this.rules.get(decodeURIComponent(rules[1])) ?? []);
    const commit = pathname.match(new RegExp(`^${base}/git/commits/([0-9a-f]{40})$`));
    if (commit && method === 'GET') { const c = this.commits.get(commit[1]); return c ? this.json(200, { sha: commit[1], tree: { sha: c.tree } }) : this.json(404, {}); }
    const pull = pathname.match(new RegExp(`^${base}/pulls/(\\d+)$`));
    if (pull) { const p = this.pulls.get(Number(pull[1])); return p ? this.json(200, p) : this.json(404, {}); }
    if (pathname === `${base}/git/blobs` && method === 'POST') {
      const bytes = Buffer.from(body.content, 'base64');
      const sha = gitBlobSha(bytes);
      this.objects.set(sha, { type: 'Blob', byteSize: bytes.length });
      return this.applied(201, { sha });
    }
    if (pathname === `${base}/git/trees` && method === 'POST') {
      if (this.failTreeBeforeApply) { this.failTreeBeforeApply = false; return this.json(502, { message: 'upstream' }); }
      const sha = fakeTreeSha(body.base_tree, body.tree);
      this.objects.set(sha, { type: 'Tree', byteSize: null });
      return this.applied(201, { sha });
    }
    if (pathname === `${base}/git/commits` && method === 'POST') {
      const sha = sha1(`commit ${JSON.stringify(body)}`);
      this.objects.set(sha, { type: 'Commit', byteSize: null });
      this.commits.set(sha, { tree: body.tree, parents: body.parents });
      // As GitHub does for an App: the bot as author, GitHub itself as committer.
      const author = { name: BOT, email: BOT_EMAIL, date: '2027-01-15T08:00:00Z' };
      const committer = { name: 'GitHub', email: 'noreply@github.com', date: '2027-01-15T08:00:00Z' };
      return this.applied(201, this.commitResponse({ sha, message: body.message, tree: { sha: body.tree }, parents: body.parents.map((p: string) => ({ sha: p })), author, committer }));
    }
    if (pathname === '/graphql') {
      const { query, variables } = body as { query: string; variables: Record<string, unknown> };
      if (this.graphqlErrors) return this.json(200, { data: null, errors: [{ type: 'INTERNAL', message: 'boom' }] });
      if (query.includes('updateRefs')) {
        const input = variables.input as { repositoryId: string; refUpdates: Array<{ name: string; beforeOid: string; afterOid: string; force: boolean }> };
        const [u] = input.refUpdates;
        const branch = u.name.replace('refs/heads/', '');
        const current = this.refs.get(branch);
        const ok = input.repositoryId === NODE_ID && input.refUpdates.length === 1 && u.force === false && this.commits.has(u.afterOid)
          && (u.beforeOid === ZERO_OID ? current === undefined : current === u.beforeOid);
        if (!ok) return this.json(200, { data: { updateRefs: null }, errors: [{ type: 'STALE_DATA', message: 'ref moved' }] });
        this.refs.set(branch, u.afterOid);
        return this.applied(200, this.updateRefsOverride ?? { data: { updateRefs: { clientMutationId: null } } });
      }
      if (query.includes('id databaseId')) return this.json(200, { data: { repository: { id: NODE_ID, databaseId: REPOSITORY_ID } } });
      const repository: Record<string, unknown> = { databaseId: REPOSITORY_ID };
      for (const [key, oid] of Object.entries(variables)) {
        if (!/^o\d+$/.test(key)) continue;
        const o = this.objects.get(oid as string);
        repository[key] = o ? { __typename: o.type, ...(o.type === 'Blob' ? { byteSize: o.byteSize } : {}) } : null;
      }
      return this.json(200, { data: { repository } });
    }
    return this.json(500, { message: `unhandled ${method} ${pathname}` });
  };

  count(method: string, suffix: string) { return this.calls.filter((c) => c.method === method && c.path.endsWith(suffix)).length; }
  graphqlCount(fragment: string) { return this.calls.filter((c) => c.path === '/graphql' && (c.body as { query: string }).query.includes(fragment)).length; }
}

type Harness = { gateway: Gateway; git: FakeGit; ledger: MemoryLedger; clock: { now: number }; policy: { bytes: Uint8Array }; loader: PolicyLoader };

function harness(state = 'routine'): Harness {
  const git = new FakeGit();
  const ledger = new MemoryLedger();
  const clock = { now: NOW };
  const policy = { bytes: policyBytes(state) };
  const loader = new PolicyLoader({ fetch: async () => ({ bytes: policy.bytes, blobSha: gitBlobSha(policy.bytes) }) }, () => clock.now, 1);
  const gateway = new Gateway({
    repo: REPO,
    actors: new Map([['luca-claude-code', { appId: 5350010, installationId: 172194780, privateKey: rsa.privateKey, botLogin: BOT }]]),
    api: new GitHubApi(git.fetch), ledger, loaderFor: (actor) => (actor === 'luca-claude-code' ? loader : undefined), now: () => clock.now,
  });
  return { gateway, git, ledger, clock, policy, loader };
}

let counter = 0;
const nextId = () => `op-publish-${String(++counter).padStart(12, '0')}`;

function request(h: Harness, operation: Envelope['operation'], payload: unknown, operationId: string) {
  const envelope: Envelope = {
    audience: AUDIENCE, protocol: PROTOCOL, repositoryId: REPOSITORY_ID, actor: 'luca-claude-code', keyId: 'lcc-1',
    operation, pr: null, headSha: null, payloadSha256: payloadDigest(payload), policyEpoch: gitBlobSha(h.policy.bytes),
    issuedAt: h.clock.now - 1_000, expiresAt: h.clock.now + 30_000, operationId,
  };
  return { envelope, signature: sign(null, Buffer.from(canonicalJson(envelope), 'utf8'), signer.privateKey).toString('base64'), payload };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Result = { status: number; body: Record<string, any> };

/** Signs, authorizes and executes; returns the result plus the exact signed body for a later replay. */
async function run(h: Harness, operation: Envelope['operation'], payload: unknown, operationId = nextId()): Promise<Result & { operationId: string; signed: unknown; replay: () => Promise<Result> }> {
  const signed = request(h, operation, payload, operationId);
  const decision = await decide(signed, (actor) => (actor === 'luca-claude-code' ? h.loader : undefined), () => h.clock.now);
  if (decision.decision !== 'allow') return { status: 403, body: decision as unknown as Record<string, unknown>, operationId, signed, replay: async () => { throw new Error('denied'); } };
  const { envelope, digest, payload: p, policy } = decision.authorized;
  const replay = async () => await h.gateway.execute(signed, envelope, digest, p, policy.epoch) as Result;
  return { ...(await replay()), operationId, signed, replay };
}

/** A fresh, separately signed status request carrying the exact original. */
const status = (h: Harness, original: unknown) => run(h, 'status', { original });

function blob(text: string) {
  const bytes = Buffer.from(text, 'utf8');
  return { blobSha: gitBlobSha(bytes), rawSize: bytes.length, contentBase64: bytes.toString('base64') };
}

const valid = (operation: Envelope['operation'], payload: unknown, actor = 'luca-claude-code') =>
  validatePayload({ operation, actor, pr: null, headSha: null } as Envelope, payload);

/** Runs blob.put + tree.create + commit.create for one file and returns the ids. */
async function prepareCommit(h: Harness, options: { branch?: string; parent?: string; text?: string; pr?: number | null } = {}) {
  const b = blob(options.text ?? 'hello\n');
  const put = await run(h, 'blob.put', b);
  assert.equal(put.body.status, 'succeeded', JSON.stringify(put.body));
  const entries: Entry[] = [{ path: 'docs/x.md', mode: '100644', blobSha: b.blobSha }];
  const parent = options.parent ?? BASE;
  const baseTree = h.git.commits.get(parent)!.tree;
  const expectedTreeSha = fakeTreeSha(baseTree, asTree(entries));
  const tree = await run(h, 'tree.create', { parentCommitSha: parent, baseTreeSha: baseTree, entries, expectedTreeSha });
  assert.equal(tree.body.status, 'succeeded', JSON.stringify(tree.body));
  const commit = await run(h, 'commit.create', {
    treeOperationId: tree.operationId, treeSha: expectedTreeSha, parentCommitSha: parent, message: 'Add x\n\nCo-Authored-By: Someone <s@example.com>',
    target: { pr: options.pr ?? null, branch: options.branch ?? 'lcc/feature' }, origin: null,
  });
  return { blob: b, tree, commit, expectedTreeSha, parent };
}

describe('publication: the full pipeline', () => {
  test('ref.create at the live base, then blob, tree, commit and ref.update publish exactly the recorded commit', async () => {
    const h = harness();
    const created = await run(h, 'ref.create', { branch: 'lcc/feature', afterOid: BASE, baseRef: 'main' });
    assert.equal(created.body.status, 'succeeded');
    assert.equal(h.git.refs.get('lcc/feature'), BASE);
    const update = h.git.calls.find((c) => c.path === '/graphql' && (c.body as { query: string }).query.includes('updateRefs'))!.body as { variables: { input: { refUpdates: unknown[] } } };
    assert.deepEqual(update.variables.input.refUpdates, [{ name: 'refs/heads/lcc/feature', beforeOid: ZERO_OID, afterOid: BASE, force: false }]);

    const { commit, expectedTreeSha } = await prepareCommit(h);
    assert.equal(commit.body.status, 'succeeded');
    const c = commit.body.result;
    assert.equal(c.treeSha, expectedTreeSha);
    assert.equal(c.parentCommitSha, BASE);
    assert.equal(c.branch, 'lcc/feature');
    assert.equal(c.originActor, 'luca-claude-code', 'self-origin is stored explicitly');
    assert.equal(c.repositoryId, REPOSITORY_ID);
    const sent = h.git.calls.find((x) => x.method === 'POST' && x.path.endsWith('/git/commits'))!.body as Record<string, unknown>;
    assert.equal(sent.author, undefined, 'author is left to GitHub (the App bot) and then verified');
    assert.match(sent.message as string, /\nCo-Authored-By: Someone <s@example.com>\nHolahola-Broker-Op: op-publish-\d+:[0-9a-f]{16}\n$/);

    const published = await run(h, 'ref.update', { branch: 'lcc/feature', beforeOid: BASE, afterOid: c.commitSha, commitOperationId: commit.operationId });
    assert.equal(published.body.status, 'succeeded');
    assert.equal(h.git.refs.get('lcc/feature'), c.commitSha);
    assert.deepEqual(published.body.result, {
      branch: 'lcc/feature', beforeOid: BASE, afterOid: c.commitSha, treeSha: expectedTreeSha, originActor: 'luca-claude-code', pr: null, repositoryId: REPOSITORY_ID,
    });
  });

  test('a commit targeting a PR is bound to that open PR and its head branch', async () => {
    const h = harness();
    h.git.refs.set('lcc/feature', BASE);
    h.git.pulls.set(48, { number: 48, state: 'open', head: { sha: BASE, ref: 'lcc/feature', repo: { id: REPOSITORY_ID } }, base: { ref: 'main', repo: { id: REPOSITORY_ID } }, user: { login: BOT } });
    const { commit } = await prepareCommit(h, { pr: 48 });
    assert.equal(commit.body.status, 'succeeded');
    h.git.pulls.get(48)!.state = 'closed';
    const refused = await run(h, 'ref.update', { branch: 'lcc/feature', beforeOid: BASE, afterOid: commit.body.result.commitSha, commitOperationId: commit.operationId });
    assert.deepEqual(refused.body.result, { reason: 'target_mismatch' });
    const other = harness();
    other.git.pulls.set(48, { number: 48, state: 'open', head: { sha: BASE, ref: 'lcc/other', repo: { id: REPOSITORY_ID } }, base: { ref: 'main', repo: { id: REPOSITORY_ID } }, user: { login: BOT } });
    const mismatched = await prepareCommit(other, { pr: 48 });
    assert.deepEqual(mismatched.commit.body.result, { reason: 'target_mismatch' });
  });

  test('publication operations carry no PR, so qualification denies them', async () => {
    const h = harness('qualification');
    assert.equal((await run(h, 'blob.put', blob('x'))).body.reason, 'not_qualified');
    assert.equal((await run(h, 'ref.create', { branch: 'lcc/feature', afterOid: BASE, baseRef: 'main' })).body.reason, 'not_qualified');
  });
});

describe('publication: blob.put', () => {
  test('an already-present blob is reported as such and never uploaded', async () => {
    const h = harness();
    const b = blob('same');
    assert.equal((await run(h, 'blob.put', b)).body.result.presence, 'uploaded');
    const again = await run(h, 'blob.put', b);
    assert.deepEqual(again.body.result, { blobSha: b.blobSha, presence: 'already_present', repositoryId: REPOSITORY_ID });
    assert.equal(h.git.count('POST', '/git/blobs'), 1);
  });

  test('unknown existence refuses the upload; it is never assumed absent', async () => {
    const h = harness();
    h.git.graphqlErrors = true;
    const result = await run(h, 'blob.put', blob('x'));
    assert.deepEqual(result.body.result, { reason: 'existence_unknown' });
    assert.equal(h.git.count('POST', '/git/blobs'), 0);
  });

  test('an object of another type or size at that sha is a conflict', async () => {
    const h = harness();
    const b = blob('x');
    h.git.objects.set(b.blobSha, { type: 'Tree', byteSize: null });
    assert.deepEqual((await run(h, 'blob.put', b)).body.result, { reason: 'object_conflict' });
  });

  test('content must be canonical base64 that decodes to exactly rawSize bytes with the named git blob sha', () => {
    const b = blob('hello');
    assert.ok(valid('blob.put', b));
    assert.ok(valid('blob.put', blob('')), 'an empty blob is valid');
    assert.equal(valid('blob.put', { ...b, contentBase64: `${b.contentBase64}\n` }), null, 'whitespace');
    assert.equal(valid('blob.put', { ...b, contentBase64: b.contentBase64.replace(/=+$/, '') }), null, 'missing padding');
    assert.equal(decodeCanonicalBase64('YR=='), null, 'non-zero padding bits');
    assert.equal(valid('blob.put', { ...b, rawSize: b.rawSize + 1 }), null, 'size');
    assert.equal(valid('blob.put', { ...b, blobSha: 'f'.repeat(40) }), null, 'sha');
    assert.equal(valid('blob.put', { ...b, extra: 1 }), null, 'unknown field');
  });

  test('an uncertain upload settles by existence, never by a second upload', async () => {
    const h = harness();
    h.git.failAfterApply = true;
    const b = blob('lost response');
    const first = await run(h, 'blob.put', b);
    assert.equal(first.body.decision, 'uncertain');
    h.clock.now += EXECUTION_DEADLINE_MS;
    const later = await first.replay();
    assert.equal(later.body.status, 'applied');
    assert.equal(later.body.result.presence, 'present');
    assert.equal(h.git.count('POST', '/git/blobs'), 1);
  });
});

describe('publication: tree.create', () => {
  async function treeRequest(h: Harness, entries: Entry[], overrides: Record<string, unknown> = {}) {
    return run(h, 'tree.create', { parentCommitSha: BASE, baseTreeSha: BASE_TREE, entries, expectedTreeSha: fakeTreeSha(BASE_TREE, asTree(entries)), ...overrides });
  }

  test('the base tree must be the parent commit\'s tree, and every referenced blob must exist', async () => {
    const h = harness();
    const b = blob('a');
    await run(h, 'blob.put', b);
    assert.deepEqual((await treeRequest(h, [{ path: 'a', mode: '100644', blobSha: b.blobSha }], { baseTreeSha: '3'.repeat(40) })).body.result, { reason: 'base_tree_mismatch' });
    assert.deepEqual((await treeRequest(h, [{ path: 'a', mode: '100644', blobSha: 'e'.repeat(40) }])).body.result, { reason: 'missing_blob' });
    assert.deepEqual((await treeRequest(h, [{ path: 'a', mode: '100644', blobSha: b.blobSha }], { parentCommitSha: '9'.repeat(40) })).body.result, { reason: 'unknown_parent' });
    assert.equal(h.git.count('POST', '/git/trees'), 0);
    const deletion = await treeRequest(h, [{ path: 'gone.md', mode: '100644', blobSha: null }]);
    assert.equal(deletion.body.status, 'succeeded', 'a deletion references no blob');
  });

  // luca-replit PR #124 review, B-TREE: existence of the caller-named tree is not proof.
  test('an uncertain tree.create is never settled by an unrelated tree at expectedTreeSha, through a real status request', async () => {
    const h = harness();
    h.git.refs.set('lcc/feature', BASE);
    const unrelated = '9'.repeat(40);
    h.git.objects.set(unrelated, { type: 'Tree', byteSize: null });
    const b = blob('a different documentation patch\n');
    await run(h, 'blob.put', b);
    h.git.failTreeBeforeApply = true;
    const tree = await run(h, 'tree.create', { parentCommitSha: BASE, baseTreeSha: BASE_TREE, entries: [{ path: 'docs/patch.md', mode: '100644', blobSha: b.blobSha }], expectedTreeSha: unrelated });
    assert.equal(tree.body.decision, 'uncertain');
    h.clock.now += EXECUTION_DEADLINE_MS;
    const settled = await status(h, tree.signed);
    assert.equal(settled.body.decision, 'uncertain', 'the unrelated tree is not evidence');
    assert.equal(h.ledger.file(outcomePath('luca-claude-code', tree.operationId)), null);
    const commit = await run(h, 'commit.create', { treeOperationId: tree.operationId, treeSha: unrelated, parentCommitSha: BASE, message: 'm', target: { pr: null, branch: 'lcc/feature' }, origin: null });
    assert.deepEqual(commit.body.result, { reason: 'tree_not_recorded' });
    assert.equal(h.git.count('POST', '/git/commits'), 0);
    assert.equal(h.git.refs.get('lcc/feature'), BASE, 'nothing was published');
  });

  test('control: a tree that WAS created behind an unknown result also stays uncertain; a fresh attempt proves it and publishes', async () => {
    const h = harness();
    h.git.refs.set('lcc/feature', BASE);
    const b = blob('real patch\n');
    await run(h, 'blob.put', b);
    const entries: Entry[] = [{ path: 'docs/patch.md', mode: '100644', blobSha: b.blobSha }];
    const treeSha = fakeTreeSha(BASE_TREE, asTree(entries));
    h.git.failAfterApply = true;
    const lost = await run(h, 'tree.create', { parentCommitSha: BASE, baseTreeSha: BASE_TREE, entries, expectedTreeSha: treeSha });
    assert.equal(lost.body.decision, 'uncertain');
    h.clock.now += EXECUTION_DEADLINE_MS;
    assert.equal((await status(h, lost.signed)).body.decision, 'uncertain', 'never settled, even when the tree exists');
    const fresh = await run(h, 'tree.create', { parentCommitSha: BASE, baseTreeSha: BASE_TREE, entries, expectedTreeSha: treeSha });
    assert.equal(fresh.body.status, 'succeeded', 'GitHub returns the same content-addressed sha');
    const commit = await run(h, 'commit.create', { treeOperationId: fresh.operationId, treeSha, parentCommitSha: BASE, message: 'm', target: { pr: null, branch: 'lcc/feature' }, origin: null });
    assert.equal(commit.body.status, 'succeeded');
    const published = await run(h, 'ref.update', { branch: 'lcc/feature', beforeOid: BASE, afterOid: commit.body.result.commitSha, commitOperationId: commit.operationId });
    assert.equal(published.body.status, 'succeeded');
    assert.equal(h.git.commits.get(h.git.refs.get('lcc/feature')!)!.tree, treeSha);
  });

  test('a different resulting tree is a definite failure', async () => {
    const h = harness();
    const b = blob('a');
    await run(h, 'blob.put', b);
    const result = await treeRequest(h, [{ path: 'a', mode: '100644', blobSha: b.blobSha }], { expectedTreeSha: '4'.repeat(40) });
    assert.equal(result.body.status, 'failed');
    assert.equal(result.body.result.reason, 'tree_mismatch');
  });

  test('paths are normalized, unique, regular files only, never workflow files, at most 100 entries', () => {
    const ok: Entry = { path: 'docs/a.md', mode: '100644', blobSha: 'e'.repeat(40) };
    const tree = (entries: Entry[]) => valid('tree.create', { parentCommitSha: BASE, baseTreeSha: BASE_TREE, entries, expectedTreeSha: '4'.repeat(40) });
    assert.ok(tree([ok, { ...ok, path: 'bin/run', mode: '100755' }]));
    for (const path of ['', '/a', 'a/', 'a//b', './a', 'a/./b', '../a', 'a/../b', 'a\0b', '.github/workflows/ci.yml', '.GitHub/Workflows/x.yml']) {
      assert.equal(tree([{ ...ok, path }]), null, JSON.stringify(path));
    }
    // B-WORKFLOW: an entry AT an ancestor replaces (file) or removes (null) every workflow beneath it.
    for (const path of ['.github', '.GitHub', '.github/workflows', '.github/Workflows', '.GITHUB/WORKFLOWS']) {
      assert.equal(tree([{ ...ok, path }]), null, `replace ${path}`);
      assert.equal(tree([{ ...ok, path, blobSha: null }]), null, `delete ${path}`);
    }
    for (const path of ['.github/dependabot.yml', '.github/CODEOWNERS', '.githubx', '.github-old/workflows/x.yml', 'docs/.github/workflows/x.yml', '.github/workflowsx']) {
      assert.ok(tree([{ ...ok, path }]), `control ${path}`);
      assert.ok(tree([{ ...ok, path, blobSha: null }]), `control delete ${path}`);
    }
    assert.equal(treePath('.github/dependabot.yml'), true);
    for (const mode of ['120000', '160000', '040000', '100664']) assert.equal(tree([{ ...ok, mode }]), null, mode);
    assert.equal(tree([ok, ok]), null, 'duplicate path');
    assert.equal(tree([{ ...ok, path: 'docs' }, ok]), null, 'file and directory prefix');
    assert.equal(tree([]), null, 'empty');
    assert.equal(tree(Array.from({ length: 101 }, (_, i) => ({ ...ok, path: `f${i}` }))), null, '101 entries');
    assert.equal(tree([{ ...ok, blobSha: 'E'.repeat(40) }]), null, 'uppercase sha');
    assert.equal(valid('tree.create', { parentCommitSha: ZERO_OID, baseTreeSha: BASE_TREE, entries: [ok], expectedTreeSha: '4'.repeat(40) }), null, 'zero parent');
  });
});

describe('publication: commit.create', () => {
  test('the tree must be this actor\'s recorded tree.create success for this parent', async () => {
    const h = harness();
    const base = { treeSha: BASE_TREE, parentCommitSha: BASE, message: 'm', target: { pr: null, branch: 'lcc/feature' }, origin: null };
    assert.deepEqual((await run(h, 'commit.create', { ...base, treeOperationId: 'op-never-recorded-000' })).body.result, { reason: 'tree_not_recorded' });
    const { tree, expectedTreeSha } = await prepareCommit(h);
    const otherParent = await run(h, 'commit.create', { ...base, treeOperationId: tree.operationId, treeSha: expectedTreeSha, parentCommitSha: '5'.repeat(40) });
    assert.deepEqual(otherParent.body.result, { reason: 'tree_not_recorded' });
    const otherTree = await run(h, 'commit.create', { ...base, treeOperationId: tree.operationId, treeSha: '6'.repeat(40) });
    assert.deepEqual(otherTree.body.result, { reason: 'tree_not_recorded' });
    // A blob.put outcome is not a tree.create success, even when ids line up.
    const blobOp = await run(h, 'blob.put', blob('z'));
    assert.deepEqual((await run(h, 'commit.create', { ...base, treeOperationId: blobOp.operationId })).body.result, { reason: 'tree_not_recorded' });
  });

  test('a failed tree.create cannot be committed', async () => {
    const h = harness();
    const b = blob('a');
    await run(h, 'blob.put', b);
    const failed = await run(h, 'tree.create', { parentCommitSha: BASE, baseTreeSha: BASE_TREE, entries: [{ path: 'a', mode: '100644', blobSha: b.blobSha }], expectedTreeSha: '4'.repeat(40) });
    assert.equal(failed.body.status, 'failed');
    const result = await run(h, 'commit.create', { treeOperationId: failed.operationId, treeSha: '4'.repeat(40), parentCommitSha: BASE, message: 'm', target: { pr: null, branch: 'lcc/feature' }, origin: null });
    assert.deepEqual(result.body.result, { reason: 'tree_not_recorded' });
  });

  test('a commit that differs from the request in any bound field is recorded as failed', async () => {
    const mutations: Array<[string, (r: Record<string, unknown>) => Record<string, unknown>]> = [
      ['author name', (r) => ({ ...r, author: { ...(r.author as object), name: 'someone' } })],
      ['author email', (r) => ({ ...r, author: { ...(r.author as object), email: 'x@example.com' } })],
      ['committer name', (r) => ({ ...r, committer: { ...(r.committer as object), name: 'web-flow' } })],
      ['committer email', (r) => ({ ...r, committer: { ...(r.committer as object), email: 'x@example.com' } })],
      ['committer is the bot, not GitHub', (r) => ({ ...r, committer: { ...(r.author as object) } })],
      ['message', (r) => ({ ...r, message: 'other' })],
      ['tree', (r) => ({ ...r, tree: { sha: '7'.repeat(40) } })],
      ['parents', (r) => ({ ...r, parents: [{ sha: BASE }, { sha: BASE }] })],
    ];
    for (const [name, rewrite] of mutations) {
      const h = harness();
      h.git.commitResponse = rewrite;
      const { commit } = await prepareCommit(h);
      assert.equal(commit.body.status, 'failed', name);
      assert.equal(commit.body.result.reason, 'postcondition', name);
      const refused = await run(h, 'ref.update', { branch: 'lcc/feature', beforeOid: BASE, afterOid: commit.body.result.commitSha, commitOperationId: commit.operationId });
      assert.deepEqual(refused.body.result, { reason: 'commit_not_recorded' }, name);
    }
  });

  test('origin attestations are not accepted in stage 1 (F2 trailer-only), and the target branch must be the actor\'s own', () => {
    const p = { treeOperationId: 'op-tree-000000000001', treeSha: BASE_TREE, parentCommitSha: BASE, message: 'm', target: { pr: null, branch: 'lcc/feature' }, origin: null };
    assert.ok(valid('commit.create', p));
    assert.equal(valid('commit.create', { ...p, origin: { actor: 'luca-antigravity', attestationId: 'x' } }), null);
    for (const branch of ['lr/feature', 'main', 'lcc/', 'feature', 'refs/heads/lcc/x', 'lcc/../main']) {
      assert.equal(valid('commit.create', { ...p, target: { pr: null, branch } }), null, branch);
    }
    assert.ok(valid('commit.create', { ...p, target: { pr: null, branch: 'lr/feature' } }, 'luca-replit'), 'each actor has its own prefix');
    assert.equal(valid('commit.create', { ...p, message: 'x holahola-broker-op:forged' }), null, 'callers cannot write broker markers');
    assert.equal(valid('commit.create', { ...p, target: { pr: 0, branch: 'lcc/feature' } }), null);
  });

  test('an uncertain commit is never settled and never publishable', async () => {
    const h = harness();
    h.git.refs.set('lcc/feature', BASE);
    const b = blob('u');
    await run(h, 'blob.put', b);
    const entries: Entry[] = [{ path: 'u', mode: '100644', blobSha: b.blobSha }];
    const treeSha = fakeTreeSha(BASE_TREE, asTree(entries));
    const tree = await run(h, 'tree.create', { parentCommitSha: BASE, baseTreeSha: BASE_TREE, entries, expectedTreeSha: treeSha });
    h.git.failAfterApply = true;
    const commit = await run(h, 'commit.create', { treeOperationId: tree.operationId, treeSha, parentCommitSha: BASE, message: 'U', target: { pr: null, branch: 'lcc/feature' }, origin: null });
    assert.equal(commit.body.decision, 'uncertain');
    const [u] = [...h.git.commits.keys()].filter((sha) => sha !== BASE);
    assert.ok(u, 'the commit object U exists on GitHub');
    h.clock.now += EXECUTION_DEADLINE_MS;
    assert.equal((await commit.replay()).body.decision, 'uncertain', 'reconciliation never settles a commit');
    assert.equal(h.ledger.file(outcomePath('luca-claude-code', commit.operationId)), null);
    // Design negative cases: U through BOTH ref routes.
    assert.deepEqual((await run(h, 'ref.update', { branch: 'lcc/feature', beforeOid: BASE, afterOid: u, commitOperationId: commit.operationId })).body.result, { reason: 'commit_not_recorded' });
    assert.deepEqual((await run(h, 'ref.create', { branch: 'lcc/other', afterOid: u, baseRef: 'main' })).body.result, { reason: 'base_moved' });
    assert.equal(h.git.refs.get('lcc/feature'), BASE);
    assert.equal(h.git.refs.get('lcc/other'), undefined);
  });
});

describe('publication: the recorded-success gates', () => {
  type Forged = { operation: string; status: string; outcomeDigest?: string };
  /** Writes a claim and outcome straight to the ledger, with every result field the gate compares. */
  async function forge(h: Harness, id: string, f: Forged, result: Record<string, unknown>) {
    const digest = 'a'.repeat(64);
    const claim = { actor: 'luca-claude-code', operationId: id, digest, operation: f.operation, pr: null, headSha: null, policyEpoch: 'e'.repeat(40), decision: 'allow', status: 'claimed', claimedAt: NOW };
    const outcome = { actor: 'luca-claude-code', operationId: id, digest: f.outcomeDigest ?? digest, status: f.status, result, reconciled: false, recordedAt: NOW };
    const written = await h.ledger.commit(await h.ledger.head(), { [claimPath('luca-claude-code', id)]: `${canonicalJson(claim)}\n`, [outcomePath('luca-claude-code', id)]: `${canonicalJson(outcome)}\n` });
    assert.ok(written.ok);
  }

  const refused: Array<[string, (operation: string) => Forged]> = [
    ['a failed outcome', (operation) => ({ operation, status: 'failed' })],
    ['an aborted outcome', (operation) => ({ operation, status: 'aborted' })],
    ['another operation\'s success', () => ({ operation: 'blob.put', status: 'succeeded' })],
    ['a claim and outcome with different digests', (operation) => ({ operation, status: 'succeeded', outcomeDigest: 'b'.repeat(64) })],
    ['a reconciled ("applied") outcome', (operation) => ({ operation, status: 'applied' })],
  ];

  test('commit.create needs an executed tree.create success: status, operation and claim pairing, not only matching fields', async () => {
    const tree = { treeSha: BASE_TREE, parentCommitSha: BASE, baseTreeSha: BASE_TREE, repositoryId: REPOSITORY_ID };
    const commit = (h: Harness, id: string) => run(h, 'commit.create', { treeOperationId: id, treeSha: BASE_TREE, parentCommitSha: BASE, message: 'm', target: { pr: null, branch: 'lcc/feature' }, origin: null });
    for (const [name, forged] of refused) {
      const h = harness();
      await forge(h, 'op-forged-tree-00001', forged('tree.create'), tree);
      assert.deepEqual((await commit(h, 'op-forged-tree-00001')).body.result, { reason: 'tree_not_recorded' }, name);
    }
    const control = harness();
    await forge(control, 'op-forged-tree-00001', { operation: 'tree.create', status: 'succeeded' }, tree);
    assert.equal((await commit(control, 'op-forged-tree-00001')).body.status, 'succeeded', 'control: the same fields with a real success pass');
  });

  test('ref.update needs a commit.create success executed by the broker: status, operation and claim pairing', async () => {
    const setup = () => {
      const h = harness();
      const sha = 'c'.repeat(40);
      h.git.commits.set(sha, { tree: BASE_TREE, parents: [BASE] });
      h.git.refs.set('lcc/feature', BASE);
      return { h, sha };
    };
    const result = (sha: string) => ({ commitSha: sha, treeSha: BASE_TREE, parentCommitSha: BASE, branch: 'lcc/feature', pr: null, repositoryId: REPOSITORY_ID, originActor: 'luca-claude-code', authorDate: 'd' });
    for (const [name, forged] of refused) {
      const { h, sha } = setup();
      await forge(h, 'op-forged-commit-001', forged('commit.create'), result(sha));
      const update = await run(h, 'ref.update', { branch: 'lcc/feature', beforeOid: BASE, afterOid: sha, commitOperationId: 'op-forged-commit-001' });
      assert.deepEqual(update.body.result, { reason: 'commit_not_recorded' }, name);
    }
    const { h, sha } = setup();
    await forge(h, 'op-forged-commit-001', { operation: 'commit.create', status: 'succeeded' }, result(sha));
    const update = await run(h, 'ref.update', { branch: 'lcc/feature', beforeOid: BASE, afterOid: sha, commitOperationId: 'op-forged-commit-001' });
    assert.equal(update.body.status, 'succeeded', 'control');
  });

  test('a publication request with an envelope PR or head is malformed', () => {
    const b = blob('x');
    assert.equal(validatePayload({ operation: 'blob.put', actor: 'luca-claude-code', pr: 48, headSha: null } as Envelope, b), null);
    assert.equal(validatePayload({ operation: 'blob.put', actor: 'luca-claude-code', pr: null, headSha: BASE } as Envelope, b), null);
  });
});

describe('publication: ref.create', () => {
  test('only at the live base, only for an absent branch with no matching rules', async () => {
    const h = harness();
    assert.deepEqual((await run(h, 'ref.create', { branch: 'lcc/a', afterOid: '8'.repeat(40), baseRef: 'main' })).body.result, { reason: 'base_moved' });
    h.git.refs.set('lcc/b', BASE);
    assert.deepEqual((await run(h, 'ref.create', { branch: 'lcc/b', afterOid: BASE, baseRef: 'main' })).body.result, { reason: 'branch_exists' });
    h.git.rules.set('lcc/c', [{ type: 'deletion' }]);
    assert.deepEqual((await run(h, 'ref.create', { branch: 'lcc/c', afterOid: BASE, baseRef: 'main' })).body.result, { reason: 'protected_ref' });
    assert.equal(h.git.graphqlCount('updateRefs'), 0);
  });

  test('another actor\'s or target\'s successful commit cannot be a new branch', async () => {
    const h = harness();
    h.git.refs.set('lcc/feature', BASE);
    const { commit } = await prepareCommit(h);
    assert.equal(commit.body.status, 'succeeded');
    const result = await run(h, 'ref.create', { branch: 'lcc/copy', afterOid: commit.body.result.commitSha, baseRef: 'main' });
    assert.deepEqual(result.body.result, { reason: 'base_moved' });
  });

  test('the branch must be the actor\'s own, never main, and never a deletion', () => {
    for (const branch of ['main', 'lr/x', 'lcc/', 'x', 'lcc//x'.replace('//', '/../')]) {
      assert.equal(valid('ref.create', { branch, afterOid: BASE, baseRef: 'main' }), null, branch);
    }
    assert.equal(valid('ref.create', { branch: 'lcc/x', afterOid: ZERO_OID, baseRef: 'main' }), null);
    assert.equal(valid('ref.create', { branch: 'lcc/x', afterOid: BASE, baseRef: 'develop' }), null);
    assert.equal(valid('ref.create', { branch: 'lcc/x', afterOid: BASE, baseRef: 'main' }, 'luca-antigravity'), null, 'no prefix, no branch');
  });
});

describe('publication: ref.update', () => {
  test('another target\'s successful commit is refused, and so is a moved branch', async () => {
    const h = harness();
    h.git.refs.set('lcc/feature', BASE);
    h.git.refs.set('lcc/other', BASE);
    const { commit } = await prepareCommit(h, { branch: 'lcc/other' });
    const sha = commit.body.result.commitSha;
    assert.deepEqual((await run(h, 'ref.update', { branch: 'lcc/feature', beforeOid: BASE, afterOid: sha, commitOperationId: commit.operationId })).body.result, { reason: 'commit_not_recorded' });
    assert.deepEqual((await run(h, 'ref.update', { branch: 'lcc/other', beforeOid: '8'.repeat(40), afterOid: sha, commitOperationId: commit.operationId })).body.result, { reason: 'commit_not_recorded' }, 'parent must be beforeOid');
    h.git.refs.set('lcc/other', '8'.repeat(40));
    assert.deepEqual((await run(h, 'ref.update', { branch: 'lcc/other', beforeOid: BASE, afterOid: sha, commitOperationId: commit.operationId })).body.result, { reason: 'head_moved' });
    assert.equal(h.git.graphqlCount('updateRefs'), 0);
  });

  test('zero oids are refused: no deletion, and creation only through ref.create', () => {
    const p = { branch: 'lcc/x', beforeOid: BASE, afterOid: '9'.repeat(40), commitOperationId: 'op-commit-0000000001' };
    assert.ok(valid('ref.update', p));
    assert.equal(valid('ref.update', { ...p, afterOid: ZERO_OID }), null);
    assert.equal(valid('ref.update', { ...p, beforeOid: ZERO_OID }), null);
    assert.equal(valid('ref.update', { ...p, force: true }), null, 'no force field exists');
  });

  // luca-replit phase 2b review, finding 2, now on updateRefs.
  const unknowns: Array<[string, unknown]> = [
    ['data with errors', { data: { updateRefs: { clientMutationId: null } }, errors: [{ type: 'INTERNAL', message: 'partial' }] }],
    ['null data with STALE_DATA', { data: { updateRefs: null }, errors: [{ type: 'STALE_DATA', message: 'x' }] }],
  ];
  for (const [name, response] of unknowns) {
    test(`a GraphQL response with ${name} stays uncertain, is not resent, and settles only from the live ref`, async () => {
      const h = harness();
      h.git.refs.set('lcc/feature', BASE);
      const { commit } = await prepareCommit(h);
      h.git.updateRefsOverride = response;
      const update = await run(h, 'ref.update', { branch: 'lcc/feature', beforeOid: BASE, afterOid: commit.body.result.commitSha, commitOperationId: commit.operationId });
      assert.equal(update.body.decision, 'uncertain');
      assert.equal(h.git.graphqlCount('updateRefs'), 1);
      h.clock.now += EXECUTION_DEADLINE_MS;
      const settled = await update.replay();
      // The fake applied the update before answering, so the live ref shows it.
      assert.equal(settled.body.status, 'applied');
      assert.equal(settled.body.result.treeSha, commit.body.result.treeSha, 'carry-through survives reconciliation');
      assert.equal(h.git.graphqlCount('updateRefs'), 1);
    });
  }

  test('an unknown ref.update that did not apply stays uncertain', async () => {
    const h = harness();
    h.git.refs.set('lcc/feature', BASE);
    const { commit } = await prepareCommit(h);
    h.git.failAfterApply = true;
    const update = await run(h, 'ref.update', { branch: 'lcc/feature', beforeOid: BASE, afterOid: commit.body.result.commitSha, commitOperationId: commit.operationId });
    assert.equal(update.body.decision, 'uncertain');
    h.git.refs.set('lcc/feature', BASE);
    h.clock.now += EXECUTION_DEADLINE_MS;
    assert.equal((await update.replay()).body.decision, 'uncertain');
  });
});

describe('commit message trailer', () => {
  test('joins an existing trailer block, otherwise starts one', () => {
    assert.equal(withTrailer('Subject', 'T: 1'), 'Subject\n\nT: 1\n');
    assert.equal(withTrailer('Subject\n\nBody text.\n', 'T: 1'), 'Subject\n\nBody text.\n\nT: 1\n');
    assert.equal(withTrailer('Subject\n\nCo-Authored-By: A <a@x>', 'T: 1'), 'Subject\n\nCo-Authored-By: A <a@x>\nT: 1\n');
    assert.equal(withTrailer('Origin-Author: x', 'T: 1'), 'Origin-Author: x\n\nT: 1\n', 'a lone subject line is not a trailer block');
  });
});
