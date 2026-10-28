// A thrown preflight is recorded on the ledger only as "preflight_error". The
// service log gets one bounded line naming the stage that threw, with a
// numeric upstream status and a fixed route for the token mints, and nothing
// else from the exception.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, test } from 'node:test';
import { decide } from '../src/authorize.ts';
import { canonicalJson } from '../src/canonical.ts';
import { type Ledger, outcomePath } from '../src/claims.ts';
import { AUDIENCE, type Envelope, payloadDigest, PROTOCOL } from '../src/envelope.ts';
import { Gateway, preflightErrorLine } from '../src/gateway.ts';
import { type Fetch, GitHubApi, GitHubError } from '../src/github.ts';
import { gitBlobSha, PolicyLoader, REPOSITORY_ID } from '../src/policy.ts';

const NOW = 1_800_000_000_000;
const HEAD = 'a'.repeat(40);
const BASE = '1'.repeat(40);
const BOT = 'holahola-luca-claude-code[bot]';
const REPO = { owner: 'davidwmcintosh', name: 'HolaHola', id: REPOSITORY_ID };
/** Planted in every failure; must never reach the log. */
const SENTINEL = 'ghs_SECRET_SENTINEL_9f3';
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const signer = generateKeyPairSync('ed25519');

const policyBytes = new TextEncoder().encode(JSON.stringify({
  version: 1, state: 'routine', repositoryId: REPOSITORY_ID, qualification: [],
  actors: { 'luca-claude-code': { appId: 5350010, installationId: 172194780, host: 'LITTLENEMO', signingKeys: [{ id: 'lcc-1', publicKeyPem: signer.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] } },
}) + '\n');

class MemoryLedger implements Ledger {
  commits: Array<Map<string, string>> = [new Map()];
  async head() { await Promise.resolve(); return String(this.commits.length - 1).padStart(40, '0'); }
  async read(head: string, path: string) { return this.commits[Number(head)]?.get(path) ?? null; }
  async commit(expected: string, files: Record<string, string>) {
    if (Number(expected) !== this.commits.length - 1) return { ok: false as const };
    const next = new Map(this.commits[this.commits.length - 1]);
    for (const [path, content] of Object.entries(files)) next.set(path, content);
    this.commits.push(next);
    return { ok: true as const, head: String(this.commits.length - 1).padStart(40, '0') };
  }
  file(path: string) { const v = this.commits[this.commits.length - 1].get(path); return v === undefined ? null : JSON.parse(v); }
}

type Failure = { kind: 'http'; status: number } | { kind: 'throw' };

class FakeGitHub {
  mints = 0;
  comments = 0;
  /** Fail the Nth token mint (1 = the read token, 2 = the write token). */
  failMint: { n: number; failure: Failure } | null = null;
  failPull: Failure | null = null;
  onMint: (n: number) => void = () => {};

  private json(status: number, body: unknown) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
  private fail(failure: Failure): Response {
    if (failure.kind === 'throw') throw new TypeError(`fetch failed ${SENTINEL} https://api.github.com/secret-path`);
    return this.json(failure.status, { message: SENTINEL, documentation_url: 'https://docs.github.com/x' });
  }

  readonly fetch: Fetch = async (url, init) => {
    await new Promise((resolve) => setImmediate(resolve));
    const { pathname } = new URL(url);
    const method = init.method ?? 'GET';
    if (pathname.endsWith('/access_tokens')) {
      const n = ++this.mints;
      this.onMint(n);
      if (this.failMint?.n === n) return this.fail(this.failMint.failure);
      return this.json(201, { token: SENTINEL, expires_at: new Date(NOW + 3_600_000).toISOString() });
    }
    const base = `/repos/${REPO.owner}/${REPO.name}`;
    if (pathname === `${base}/pulls/48` && method === 'GET') {
      if (this.failPull) return this.fail(this.failPull);
      return this.json(200, { number: 48, state: 'open', merged: false, merge_commit_sha: null, title: 't', body: 'b', user: { login: 'holahola-luca-replit[bot]' }, head: { sha: HEAD, ref: 'lcc/feature', repo: { id: REPOSITORY_ID } }, base: { ref: 'main', sha: BASE, repo: { id: REPOSITORY_ID } } });
    }
    if (pathname === `${base}/issues/48/comments` && method === 'POST') { this.comments++; return this.json(201, { id: 1, user: { login: BOT }, body: 'x' }); }
    if (pathname === `${base}/issues/48/comments` && method === 'GET') return this.json(200, []);
    return this.json(500, { message: `unhandled ${method} ${pathname}` });
  };
}

function harness() {
  const github = new FakeGitHub();
  const ledger = new MemoryLedger();
  const logs: string[] = [];
  const clock = { now: NOW };
  const loader = new PolicyLoader({ fetch: async () => ({ bytes: policyBytes, blobSha: gitBlobSha(policyBytes) }) }, () => clock.now, 1);
  const loaderState = { throwOnLookup: false };
  const loaderFor = (actor: string) => {
    if (loaderState.throwOnLookup) throw new Error(`loader lookup failed ${SENTINEL}`);
    return actor === 'luca-claude-code' ? loader : undefined;
  };
  const gateway = new Gateway({
    repo: REPO,
    actors: new Map([['luca-claude-code', { appId: 5350010, installationId: 172194780, privateKey: rsa.privateKey, botLogin: BOT }]]),
    api: new GitHubApi(github.fetch), ledger, loaderFor, now: () => clock.now, log: (line) => logs.push(line),
  });
  return { github, ledger, logs, clock, loader, loaderState, gateway };
}
type H = ReturnType<typeof harness>;

const OP = 'op-preflight-0000001';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function comment(h: H): Promise<{ status: number; body: Record<string, any> }> {
  const payload = { body: 'hello' };
  const envelope: Envelope = {
    audience: AUDIENCE, protocol: PROTOCOL, repositoryId: REPOSITORY_ID, actor: 'luca-claude-code', keyId: 'lcc-1',
    operation: 'pr.comment', pr: 48, headSha: HEAD, payloadSha256: payloadDigest(payload), policyEpoch: gitBlobSha(policyBytes),
    issuedAt: h.clock.now - 1_000, expiresAt: h.clock.now + 30_000, operationId: OP,
  };
  const signed = { envelope, signature: sign(null, Buffer.from(canonicalJson(envelope), 'utf8'), signer.privateKey).toString('base64'), payload };
  const decision = await decide(signed, () => h.loader, () => h.clock.now);
  assert.equal(decision.decision, 'allow');
  if (decision.decision !== 'allow') throw new Error('unreachable');
  const { envelope: e, digest, payload: p, policy } = decision.authorized;
  return await h.gateway.execute(signed, e, digest, p, policy.epoch) as { status: number; body: Record<string, unknown> };
}

/** The ledger and response are exactly what they were before this change. */
function assertPreflightError(h: H, result: { status: number; body: Record<string, unknown> }) {
  assert.equal(result.body.decision, 'aborted');
  assert.deepEqual(result.body.result, { reason: 'preflight_error' });
  assert.deepEqual(h.ledger.file(outcomePath('luca-claude-code', OP)).result, { reason: 'preflight_error' });
  assert.equal(h.github.comments, 0);
}

function onlyLine(h: H): string {
  const lines = h.logs.filter((l) => l.startsWith('broker: preflight_error'));
  assert.equal(lines.length, 1, `expected one preflight line, got ${JSON.stringify(h.logs)}`);
  for (const line of h.logs) {
    assert.doesNotMatch(line, new RegExp(SENTINEL));
    assert.doesNotMatch(line, /https?:|secret-path|documentation_url|fetch failed|Bearer|eyJ|\/repos\//);
  }
  return lines[0];
}

const PREFIX = `broker: preflight_error`;
const FIELDS = `actor=luca-claude-code operation=pr.comment op=${OP}`;
const MINT = 'route=/app/installations/:id/access_tokens';

describe('preflight diagnostics: the stage that threw, bounded', () => {
  test('a refused read-token mint names the read-token stage, its status and the fixed mint route', async () => {
    const h = harness();
    h.github.failMint = { n: 1, failure: { kind: 'http', status: 422 } };
    const result = await comment(h);
    assertPreflightError(h, result);
    assert.equal(onlyLine(h), `${PREFIX} stage=read-token ${FIELDS} http=422 ${MINT}`);
  });

  test('a refused write-token mint names the write-token stage', async () => {
    const h = harness();
    h.github.failMint = { n: 2, failure: { kind: 'http', status: 403 } };
    const result = await comment(h);
    assertPreflightError(h, result);
    assert.equal(onlyLine(h), `${PREFIX} stage=write-token ${FIELDS} http=403 ${MINT}`);
  });

  test('a network failure during a mint carries no status and none of the exception text', async () => {
    const h = harness();
    h.github.failMint = { n: 1, failure: { kind: 'throw' } };
    const result = await comment(h);
    assertPreflightError(h, result);
    assert.equal(onlyLine(h), `${PREFIX} stage=read-token ${FIELDS} ${MINT}`);
  });

  test('a live-check failure names the live-check stage with its status and no route', async () => {
    const h = harness();
    h.github.failPull = { kind: 'http', status: 503 };
    const result = await comment(h);
    assertPreflightError(h, result);
    assert.equal(onlyLine(h), `${PREFIX} stage=live-check ${FIELDS} http=503`);
  });

  test('a thrown re-authorization names the reauthorize stage with no status and no route', async () => {
    const h = harness();
    h.github.onMint = (n) => { if (n === 2) h.loaderState.throwOnLookup = true; };
    const result = await comment(h);
    assertPreflightError(h, result);
    assert.equal(onlyLine(h), `${PREFIX} stage=reauthorize ${FIELDS}`);
  });

  test('a preflight that does not throw logs nothing and still executes once', async () => {
    const h = harness();
    const result = await comment(h);
    assert.equal(result.body.decision, 'executed');
    assert.equal(h.github.comments, 1);
    assert.deepEqual(h.logs.filter((l) => l.startsWith('broker: preflight_error')), []);
  });

  test('the formatter emits only an in-range integer status', () => {
    const envelope = { actor: 'luca-claude-code', operation: 'pr.comment', operationId: OP } as Envelope;
    const line = (status: number) => preflightErrorLine('live-check', envelope, new GitHubError(status, `/repos/x/${SENTINEL}`));
    assert.equal(line(404), `${PREFIX} stage=live-check ${FIELDS} http=404`);
    for (const bad of [99, 600, 4.5, NaN]) assert.equal(line(bad), `${PREFIX} stage=live-check ${FIELDS}`);
    assert.equal(preflightErrorLine('write-token', envelope, { status: 422 }), `${PREFIX} stage=write-token ${FIELDS} ${MINT}`);
  });
});
