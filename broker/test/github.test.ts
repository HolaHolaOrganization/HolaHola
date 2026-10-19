import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { describe, test } from 'node:test';
import { executeOnce } from '../src/claims.ts';
import {
  createAppJwt, type Fetch, GitHubApi, GitHubError, GitHubLedger, GitHubPolicySource, InstallationToken, LedgerOverwriteError, TOKEN_REFRESH_MARGIN_MS,
} from '../src/github.ts';
import { gitBlobSha, PolicyLoader, REPOSITORY_ID } from '../src/policy.ts';

const NOW = 1_800_000_000_000;
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ed = generateKeyPairSync('ed25519');
const AUDIT = { owner: 'davidwmcintosh', name: 'holahola-broker-audit' };
const MAIN_REPO = { owner: 'davidwmcintosh', name: 'HolaHola' };

function decodeJwt(jwt: string): { header: Record<string, unknown>; payload: Record<string, number | string>; signed: string; signature: Buffer } {
  const [h, p, s] = jwt.split('.');
  const json = (part: string) => JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  return { header: json(h), payload: json(p), signed: `${h}.${p}`, signature: Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64') };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fake GitHub: App token minting, the policy file, and an audit repository with real compare-and-swap commits. */
class FakeGitHub {
  requests: Array<{ url: string; init: RequestInit }> = [];
  mints: Array<Record<string, unknown>> = [];
  issued = new Set<string>();
  tokenLifetimeMs = 60 * 60_000;
  clock = () => NOW;
  policyBytes = new TextEncoder().encode('{}\n');
  policyShaOverride: string | null = null;
  commits: Array<{ oid: string; files: Map<string, string> }> = [{ oid: 'a'.repeat(40), files: new Map() }];
  graphqlError: { type?: string; message: string } | null = null;

  private tip() { return this.commits[this.commits.length - 1]; }

  readonly fetch: Fetch = async (url, init) => {
    this.requests.push({ url, init });
    await new Promise((resolve) => setImmediate(resolve));
    const { pathname, searchParams } = new URL(url);
    const auth = String((init.headers as Record<string, string>).Authorization ?? '').replace(/^Bearer /, '');
    const method = init.method ?? 'GET';

    const mint = pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (mint && method === 'POST') {
      const { payload, signed, signature } = decodeJwt(auth);
      if (!verify('RSA-SHA256', Buffer.from(signed), rsa.publicKey, signature)) return jsonResponse(401, { message: 'bad jwt' });
      const body = JSON.parse(String(init.body));
      this.mints.push({ installation: Number(mint[1]), iss: payload.iss, ...body });
      const token = `ghs_fake_${this.mints.length}`;
      this.issued.add(token);
      return jsonResponse(201, { token, expires_at: new Date(this.clock() + this.tokenLifetimeMs).toISOString() });
    }
    if (!this.issued.has(auth)) return jsonResponse(401, { message: 'bad token' });

    if (pathname === `/repos/${MAIN_REPO.owner}/${MAIN_REPO.name}/contents/broker/policy.json` && searchParams.get('ref') === 'main') {
      return jsonResponse(200, { type: 'file', encoding: 'base64', content: Buffer.from(this.policyBytes).toString('base64'), sha: this.policyShaOverride ?? gitBlobSha(this.policyBytes) });
    }
    const auditBase = `/repos/${AUDIT.owner}/${AUDIT.name}`;
    if (pathname === `${auditBase}/git/ref/heads/main`) return jsonResponse(200, { object: { sha: this.tip().oid } });
    if (pathname.startsWith(`${auditBase}/contents/`)) {
      const commit = this.commits.find((candidate) => candidate.oid === searchParams.get('ref'));
      if (!commit) return jsonResponse(404, { message: 'no ref' });
      const content = commit.files.get(decodeURIComponent(pathname.slice(`${auditBase}/contents/`.length)));
      return content === undefined ? jsonResponse(404, { message: 'Not Found' }) : jsonResponse(200, { type: 'file', encoding: 'base64', content: Buffer.from(content).toString('base64') });
    }
    if (pathname === '/graphql' && method === 'POST') {
      if (this.graphqlError) return jsonResponse(200, { data: null, errors: [this.graphqlError] });
      const { input } = JSON.parse(String(init.body)).variables;
      if (input.expectedHeadOid !== this.tip().oid) {
        return jsonResponse(200, { data: null, errors: [{ type: 'STALE_DATA', message: `Expected branch to point to "${input.expectedHeadOid}" but it did not` }] });
      }
      const files = new Map(this.tip().files);
      for (const { path, contents } of input.fileChanges.additions) files.set(path, Buffer.from(contents, 'base64').toString('utf8'));
      const oid = createHash('sha1').update(`${this.commits.length}`).digest('hex');
      this.commits.push({ oid, files });
      return jsonResponse(200, { data: { createCommitOnBranch: { commit: { oid } } } });
    }
    return jsonResponse(500, { message: 'unexpected' });
  };
}

function tokenFor(github: FakeGitHub, permissions: Record<string, 'read' | 'write'> = { contents: 'write' }, repositoryId = 999, now = () => NOW) {
  return new InstallationToken(new GitHubApi(github.fetch), { appId: 4242, installationId: 77, privateKey: rsa.privateKey, repositoryId, permissions }, now);
}

describe('GitHub App JWT', () => {
  test('is RS256, issued by the App, back-dated 60 s, and valid under 10 minutes', () => {
    const jwt = createAppJwt(4242, rsa.privateKey, NOW);
    const { header, payload, signed, signature } = decodeJwt(jwt);
    assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
    assert.equal(payload.iss, '4242');
    assert.equal(payload.iat, Math.floor(NOW / 1000) - 60);
    assert.ok((payload.exp as number) - (payload.iat as number) < 600);
    assert.ok(verify('RSA-SHA256', Buffer.from(signed), rsa.publicKey, signature));
  });
});

describe('GitHubApi request discipline', () => {
  test('fixed base, refused redirects, a timeout, and no unsafe paths', async () => {
    const github = new FakeGitHub();
    const token = await tokenFor(github).get();
    const api = new GitHubApi(github.fetch);
    await api.rest(token, 'GET', `/repos/${AUDIT.owner}/${AUDIT.name}/git/ref/heads/main`);
    const last = github.requests[github.requests.length - 1];
    assert.ok(last.url.startsWith('https://api.github.com/'));
    assert.equal(last.init.redirect, 'error');
    assert.ok(last.init.signal);
    await assert.rejects(api.rest(token, 'GET', 'https://evil.example/x'), TypeError);
    await assert.rejects(api.rest(token, 'GET', '/repos/../../x'), TypeError);
  });

  test('errors carry status and path only, never the token or the query string', async () => {
    const github = new FakeGitHub();
    const api = new GitHubApi(github.fetch);
    const error = await api.rest('ghs_secret_value', 'GET', '/repos/x/y/contents/z?ref=abc').catch((caught) => caught);
    assert.ok(error instanceof GitHubError);
    assert.equal(error.status, 401);
    assert.doesNotMatch(error.message, /ghs_secret_value|ref=abc/);
  });
});

describe('installation tokens', () => {
  test('are minted for exactly one repository with an explicit permission set', async () => {
    const github = new FakeGitHub();
    await tokenFor(github, { contents: 'read' }, REPOSITORY_ID).get();
    assert.deepEqual(github.mints, [{ installation: 77, iss: '4242', repository_ids: [REPOSITORY_ID], permissions: { contents: 'read' } }]);
  });

  test('refuse an empty permission set', () => {
    assert.throws(() => tokenFor(new FakeGitHub(), {}), TypeError);
  });

  test('are cached, shared by concurrent callers, and refreshed before expiry', async () => {
    const github = new FakeGitHub();
    let clock = NOW;
    github.clock = () => clock;
    const token = tokenFor(github, { contents: 'write' }, 999, () => clock);
    const [a, b] = await Promise.all([token.get(), token.get()]);
    assert.equal(a, b);
    assert.equal(github.mints.length, 1);
    clock += github.tokenLifetimeMs - TOKEN_REFRESH_MARGIN_MS - 1;
    assert.equal(await token.get(), a);
    clock += 1;
    assert.notEqual(await token.get(), a);
    assert.equal(github.mints.length, 2);
  });

  test('a malformed mint response fails without caching', async () => {
    const api = new GitHubApi(async () => jsonResponse(201, { token: 'x' }));
    const token = new InstallationToken(api, { appId: 1, installationId: 2, privateKey: rsa.privateKey, repositoryId: 3, permissions: { contents: 'read' } }, () => NOW);
    await assert.rejects(token.get(), GitHubError);
  });
});

describe('policy source', () => {
  function policyBytes(): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({
      version: 1, state: 'closed', repositoryId: REPOSITORY_ID, qualification: [],
      actors: { 'luca-claude-code': { appId: 5350010, installationId: 172194780, host: 'LITTLENEMO', signingKeys: [{ id: 'k1', publicKeyPem: ed.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] } },
    }, null, 2) + '\n');
  }

  test('loads broker/policy.json from main through PolicyLoader', async () => {
    const github = new FakeGitHub();
    github.policyBytes = policyBytes();
    const token = tokenFor(github, { contents: 'read' }, REPOSITORY_ID);
    const loader = new PolicyLoader(new GitHubPolicySource(new GitHubApi(github.fetch), MAIN_REPO, () => token.get()), () => NOW);
    const policy = await loader.current();
    assert.equal(policy?.state, 'closed');
    assert.equal(policy?.epoch, gitBlobSha(github.policyBytes));
  });

  test('a blob sha that does not match the bytes yields no policy', async () => {
    const github = new FakeGitHub();
    github.policyBytes = policyBytes();
    github.policyShaOverride = 'b'.repeat(40);
    const token = tokenFor(github, { contents: 'read' }, REPOSITORY_ID);
    const loader = new PolicyLoader(new GitHubPolicySource(new GitHubApi(github.fetch), MAIN_REPO, () => token.get()), () => NOW);
    assert.equal(await loader.current(), null);
  });
});

describe('audit-repository ledger', () => {
  function ledgerFor(github: FakeGitHub): GitHubLedger {
    const token = tokenFor(github, { contents: 'write' });
    return new GitHubLedger(new GitHubApi(github.fetch), AUDIT, () => token.get());
  }

  test('reads the head, reports absent files as null, and commits with compare-and-swap', async () => {
    const github = new FakeGitHub();
    const ledger = ledgerFor(github);
    const head = await ledger.head();
    assert.equal(await ledger.read(head, 'claims/luca-claude-code/op-1.json'), null);
    const written = await ledger.commit(head, { 'claims/luca-claude-code/op-1.json': '{"a":1}\n' }, 'claim');
    assert.equal(written.ok, true);
    const next = await ledger.head();
    assert.notEqual(next, head);
    assert.equal(await ledger.read(next, 'claims/luca-claude-code/op-1.json'), '{"a":1}\n');
    assert.equal(await ledger.read(head, 'claims/luca-claude-code/op-1.json'), null, 'reads are pinned to the given head');
  });

  test('a moved head is a compare-and-swap loss, not an error', async () => {
    const github = new FakeGitHub();
    const ledger = ledgerFor(github);
    const stale = await ledger.head();
    await ledger.commit(stale, { 'x.json': '1' }, 'first');
    assert.deepEqual(await ledger.commit(stale, { 'y.json': '2' }, 'second'), { ok: false });
  });

  // luca-replit review 5566908783: additions replace content, so the adapter
  // itself must refuse existing destinations at the expected head.
  test('refuses to overwrite an existing claim or outcome at the current head, committing nothing', async () => {
    const github = new FakeGitHub();
    const ledger = ledgerFor(github);
    const first = await ledger.commit(await ledger.head(), { 'outcomes/fixture/op.json': '{"status":"applied"}\n' }, 'outcome');
    assert.equal(first.ok, true);
    const head = await ledger.head();
    const commitsBefore = github.commits.length;
    await assert.rejects(ledger.commit(head, { 'outcomes/fixture/op.json': '{"status":"failed"}\n' }, 'outcome'), LedgerOverwriteError);
    assert.equal(github.commits.length, commitsBefore);
    assert.equal(await ledger.read(await ledger.head(), 'outcomes/fixture/op.json'), '{"status":"applied"}\n');
  });

  test('a mixed batch with one existing destination is rejected atomically', async () => {
    const github = new FakeGitHub();
    const ledger = ledgerFor(github);
    await ledger.commit(await ledger.head(), { 'claims/fixture/op-a.json': 'a\n' }, 'claim');
    const head = await ledger.head();
    const commitsBefore = github.commits.length;
    await assert.rejects(ledger.commit(head, { 'claims/fixture/op-b.json': 'b\n', 'claims/fixture/op-a.json': 'x\n' }, 'claim'), LedgerOverwriteError);
    assert.equal(github.commits.length, commitsBefore);
    assert.equal(await ledger.read(await ledger.head(), 'claims/fixture/op-b.json'), null, 'the new file in the batch was not written either');
  });

  test('absence is checked at the expected head, not the moving tip', async () => {
    const github = new FakeGitHub();
    const ledger = ledgerFor(github);
    const stale = await ledger.head();
    await ledger.commit(stale, { 'x.json': '1' }, 'first');
    // x.json is absent at `stale`, so the absence check passes and the CAS then loses: no overwrite, no error.
    assert.deepEqual(await ledger.commit(stale, { 'x.json': '2' }, 'second'), { ok: false });
    assert.equal(await ledger.read(await ledger.head(), 'x.json'), '1');
  });

  test('any other GraphQL error throws, so the caller denies', async () => {
    const github = new FakeGitHub();
    const ledger = ledgerFor(github);
    const head = await ledger.head();
    github.graphqlError = { type: 'FORBIDDEN', message: 'Resource not accessible by integration' };
    await assert.rejects(ledger.commit(head, { 'x.json': '1' }, 'claim'), GitHubError);
  });

  test('refuses non-sha heads before any request', async () => {
    const github = new FakeGitHub();
    const ledger = ledgerFor(github);
    await assert.rejects(ledger.read('main', 'x.json'), TypeError);
    await assert.rejects(ledger.commit('HEAD', { 'x.json': '1' }, 'claim'), TypeError);
  });

  test('executeOnce over the GitHub ledger: concurrent instances execute exactly once', async () => {
    const github = new FakeGitHub();
    let effects = 0;
    const effect = async () => { effects += 1; return { status: 'succeeded' as const, result: { commentId: 1 } }; };
    const entry = { actor: 'luca-claude-code', operationId: 'op-github-ledger-0001', digest: 'c'.repeat(64), operation: 'pr.comment', pr: 1, headSha: 'd'.repeat(40), policyEpoch: 'e'.repeat(40) };
    const results = await Promise.all([1, 2, 3].map(() => executeOnce(ledgerFor(github), entry, effect, async () => ({ status: 'ambiguous' }), () => NOW)));
    assert.equal(effects, 1);
    assert.equal(results.filter((result) => result.kind === 'executed').length, 1);
    const tip = github.commits[github.commits.length - 1].files;
    assert.ok(tip.has('claims/luca-claude-code/op-github-ledger-0001.json'));
    assert.ok(tip.has('outcomes/luca-claude-code/op-github-ledger-0001.json'));
  });
});
