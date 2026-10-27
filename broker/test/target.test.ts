// Stage 1, decision F4-a: an isolated sandbox instance with an immutable target.
// Production keeps its fixed main repository and broker/policy.json. A sandbox
// instance acts on exactly one configured repository and reads
// broker/policy.sandbox.json from MAIN of the control repository.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, test } from 'node:test';
import { canonicalJson } from '../src/canonical.ts';
import { signRequest, signStatus, type Signer } from '../src/client.ts';
import { AUDIENCE, type Envelope, payloadDigest, PROTOCOL, verifyOriginalSignature, verifySignedRequest } from '../src/envelope.ts';
import { GitHubApi, GitHubPolicySource } from '../src/github.ts';
import { assemble, ConfigError, loadConfig, MAIN_REPOSITORY } from '../src/main.ts';
import { gitBlobSha, parsePolicy, PolicyError, PolicyLoader, REPOSITORY_ID } from '../src/policy.ts';

const SANDBOX_ID = 2_000_000_001;
const NOW = 1_800_000_000_000;
const rsa = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const lccRsa = rsa();
const auditRsa = rsa();
const lcc = generateKeyPairSync('ed25519');
const lccPublicPem = lcc.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    BROKER_ACTORS: JSON.stringify([{ actor: 'luca-claude-code', appId: 5350010, installationId: 172194780, botLogin: 'holahola-luca-claude-code[bot]' }]),
    BROKER_APP_PRIVATE_KEY_5350010: lccRsa,
    BROKER_AUDIT_REPO: 'HolaHolaOrganization/broker-sandbox-audit',
    BROKER_AUDIT_REPO_ID: '42',
    BROKER_AUDIT_APP_ID: '777',
    BROKER_AUDIT_INSTALLATION_ID: '888',
    BROKER_AUDIT_APP_PRIVATE_KEY: auditRsa,
    ...overrides,
  };
}

const sandbox = { BROKER_TARGET: 'sandbox', BROKER_TARGET_REPO: 'HolaHolaOrganization/broker-sandbox', BROKER_TARGET_REPO_ID: String(SANDBOX_ID) };

function policyBytes(repositoryId: number): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    version: 1, state: 'routine', repositoryId, qualification: [],
    actors: { 'luca-claude-code': { appId: 5350010, installationId: 172194780, host: 'LITTLENEMO', signingKeys: [{ id: 'lcc-1', publicKeyPem: lccPublicPem }] } },
  }));
}

function envelopeFor(repositoryId: number, epoch: string, overrides: Partial<Envelope> = {}) {
  const payload = { body: 'hello' };
  const envelope: Envelope = {
    audience: AUDIENCE, protocol: PROTOCOL, repositoryId, actor: 'luca-claude-code', keyId: 'lcc-1',
    operation: 'pr.comment', pr: 48, headSha: 'a'.repeat(40), payloadSha256: payloadDigest(payload),
    policyEpoch: epoch, issuedAt: NOW, expiresAt: NOW + 30_000, operationId: `op-${'0'.repeat(24)}`, ...overrides,
  };
  return { envelope, signature: sign(null, Buffer.from(canonicalJson(envelope), 'utf8'), lcc.privateKey).toString('base64'), payload };
}

describe('instance target configuration', () => {
  test('production default: target is the fixed main repository and the policy file is broker/policy.json', () => {
    const config = loadConfig(env());
    assert.deepEqual(config.target, { owner: 'HolaHolaOrganization', name: 'HolaHola', id: REPOSITORY_ID });
    assert.deepEqual(config.target, config.mainRepository);
    assert.equal(config.policyPath, 'broker/policy.json');
    assert.equal(loadConfig(env({ BROKER_TARGET: 'main' })).policyPath, 'broker/policy.json');
  });

  test('sandbox: an immutable target from the environment, and the sandbox policy file read from main', () => {
    const config = loadConfig(env(sandbox));
    assert.deepEqual(config.target, { owner: 'HolaHolaOrganization', name: 'broker-sandbox', id: SANDBOX_ID });
    assert.deepEqual(config.mainRepository, { owner: 'HolaHolaOrganization', name: 'HolaHola', id: REPOSITORY_ID });
    assert.equal(config.policyPath, 'broker/policy.sandbox.json');
  });

  const invalid: Array<[string, Record<string, string | undefined>, string]> = [
    ['unknown target kind', { BROKER_TARGET: 'production' }, 'invalid BROKER_TARGET'],
    ['sandbox repo setting without sandbox target', { BROKER_TARGET_REPO: 'HolaHolaOrganization/broker-sandbox' }, 'invalid BROKER_TARGET'],
    ['sandbox id setting without sandbox target', { BROKER_TARGET_REPO_ID: String(SANDBOX_ID) }, 'invalid BROKER_TARGET'],
    ['sandbox without repo', { ...sandbox, BROKER_TARGET_REPO: undefined }, 'missing BROKER_TARGET_REPO'],
    ['sandbox without id', { ...sandbox, BROKER_TARGET_REPO_ID: undefined }, 'missing BROKER_TARGET_REPO_ID'],
    ['sandbox target is HolaHola (organization)', { ...sandbox, BROKER_TARGET_REPO: 'HolaHolaOrganization/HolaHola' }, 'invalid BROKER_TARGET_REPO'],
    ['sandbox target is HolaHola (former owner, any case)', { ...sandbox, BROKER_TARGET_REPO: 'DavidWMcIntosh/holahola' }, 'invalid BROKER_TARGET_REPO'],
    ['sandbox target is the audit repository', { ...sandbox, BROKER_TARGET_REPO: 'holaholaorganization/broker-sandbox-audit' }, 'invalid BROKER_TARGET_REPO'],
    ['sandbox target id is the main repository id', { ...sandbox, BROKER_TARGET_REPO_ID: String(REPOSITORY_ID) }, 'invalid BROKER_TARGET_REPO_ID'],
    ['sandbox target id is the audit repository id', { ...sandbox, BROKER_TARGET_REPO_ID: '42' }, 'invalid BROKER_TARGET_REPO_ID'],
    ['sandbox target malformed', { ...sandbox, BROKER_TARGET_REPO: 'not a repo' }, 'invalid BROKER_TARGET_REPO'],
  ];
  for (const [name, overrides, message] of invalid) {
    test(`rejects: ${name}`, () => {
      assert.throws(() => loadConfig(env(overrides)), (error: unknown) => error instanceof ConfigError && error.message === message);
    });
  }

  test('assembly: the gateway acts on the target; policy is read from main of the control repository at the sandbox path', async () => {
    const requests: string[] = [];
    const api = new GitHubApi(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes('/access_tokens')) return new Response(JSON.stringify({ token: 't', expires_at: new Date(NOW + 3_600_000).toISOString() }), { status: 201 });
      const bytes = policyBytes(SANDBOX_ID);
      return new Response(JSON.stringify({ type: 'file', encoding: 'base64', content: Buffer.from(bytes).toString('base64'), sha: gitBlobSha(bytes) }));
    });
    const { healthLoader, gateway } = assemble(loadConfig(env(sandbox)), api, () => NOW);
    assert.deepEqual((gateway as unknown as { config: { repo: unknown } }).config.repo, { owner: 'HolaHolaOrganization', name: 'broker-sandbox', id: SANDBOX_ID });
    const policy = await healthLoader.current();
    assert.equal(policy?.repositoryId, SANDBOX_ID);
    const policyRead = requests.find((url) => url.includes('/contents/'));
    assert.match(policyRead!, /\/repos\/HolaHolaOrganization\/HolaHola\/contents\/broker\/policy\.sandbox\.json\?ref=main$/);
    assert.ok(!requests.some((url) => url.includes('/repos/HolaHolaOrganization/broker-sandbox/contents/')), 'policy never comes from the sandbox repository');
    assert.equal(MAIN_REPOSITORY.id, REPOSITORY_ID);
  });
});

describe('policy and envelope are bound to the instance target', () => {
  test('a policy naming another repository is invalid for this instance, in both directions', () => {
    assert.equal(parsePolicy(policyBytes(SANDBOX_ID), SANDBOX_ID).repositoryId, SANDBOX_ID);
    assert.throws(() => parsePolicy(policyBytes(REPOSITORY_ID), SANDBOX_ID), PolicyError);
    assert.throws(() => parsePolicy(policyBytes(SANDBOX_ID)), PolicyError);
    assert.equal(parsePolicy(policyBytes(REPOSITORY_ID)).repositoryId, REPOSITORY_ID);
  });

  test('a sandbox loader fails closed on the production policy', async () => {
    const bytes = policyBytes(REPOSITORY_ID);
    const loader = new PolicyLoader({ fetch: async () => ({ bytes, blobSha: gitBlobSha(bytes) }) }, () => NOW, undefined, () => {}, SANDBOX_ID);
    assert.equal(await loader.current(), null);
    assert.throws(() => new PolicyLoader({ fetch: async () => ({ bytes, blobSha: '' }) }, () => NOW, undefined, () => {}, 0), RangeError);
  });

  test('requests and status originals must name the instance target repository', () => {
    const sandboxPolicy = parsePolicy(policyBytes(SANDBOX_ID), SANDBOX_ID);
    const mainPolicy = parsePolicy(policyBytes(REPOSITORY_ID));
    assert.equal(verifySignedRequest(envelopeFor(SANDBOX_ID, sandboxPolicy.epoch), sandboxPolicy, NOW).ok, true);
    assert.deepEqual(verifySignedRequest(envelopeFor(REPOSITORY_ID, sandboxPolicy.epoch), sandboxPolicy, NOW), { ok: false, reason: 'wrong_repository' });
    assert.deepEqual(verifySignedRequest(envelopeFor(SANDBOX_ID, mainPolicy.epoch), mainPolicy, NOW), { ok: false, reason: 'wrong_repository' });
    assert.deepEqual(verifyOriginalSignature(envelopeFor(REPOSITORY_ID, sandboxPolicy.epoch), sandboxPolicy), { ok: false, reason: 'wrong_repository' });
    assert.equal(verifyOriginalSignature(envelopeFor(SANDBOX_ID, sandboxPolicy.epoch), sandboxPolicy).ok, true);
  });

  test('the client signs for its configured target, and a status names the same repository as its original', () => {
    const signer: Signer = { actor: 'luca-claude-code', keyId: 'lcc-1', privateKey: lcc.privateKey };
    const original = signRequest(signer, { operation: 'pr.comment', pr: 48, headSha: 'a'.repeat(40), payload: { body: 'x' }, policyEpoch: 'e', repositoryId: SANDBOX_ID }, NOW);
    assert.equal(original.envelope.repositoryId, SANDBOX_ID);
    assert.equal(signStatus(signer, original, 'e', NOW).envelope.repositoryId, SANDBOX_ID);
    assert.equal(signRequest(signer, { operation: 'pr.comment', pr: 48, headSha: 'a'.repeat(40), payload: {}, policyEpoch: 'e' }, NOW).envelope.repositoryId, REPOSITORY_ID);
  });

  test('the policy source reads only the two allowlisted policy files', () => {
    const api = new GitHubApi(async () => new Response('{}'));
    assert.doesNotThrow(() => new GitHubPolicySource(api, MAIN_REPOSITORY, async () => 't', 'broker/policy.sandbox.json'));
    assert.throws(() => new GitHubPolicySource(api, MAIN_REPOSITORY, async () => 't', 'broker/other.json' as never), RangeError);
  });
});
