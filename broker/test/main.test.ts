import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, test } from 'node:test';
import { assemble, ConfigError, loadConfig, MAIN_REPOSITORY } from '../src/main.ts';
import { GitHubApi } from '../src/github.ts';

const pem = (key: ReturnType<typeof generateKeyPairSync>['privateKey']) => key.export({ type: 'pkcs1', format: 'pem' }).toString();
const lccKey = pem(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey);
const auditKey = pem(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey);

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    BROKER_ACTORS: JSON.stringify([{ actor: 'luca-claude-code', appId: 5350010, installationId: 172194780, botLogin: 'holahola-luca-claude-code[bot]' }]),
    BROKER_APP_PRIVATE_KEY_5350010: lccKey,
    BROKER_AUDIT_REPO: 'davidwmcintosh/holahola-broker-audit',
    BROKER_AUDIT_REPO_ID: '42',
    BROKER_AUDIT_APP_ID: '777',
    BROKER_AUDIT_INSTALLATION_ID: '888',
    BROKER_AUDIT_APP_PRIVATE_KEY: Buffer.from(auditKey).toString('base64'),
    ...overrides,
  };
}

describe('broker configuration', () => {
  test('loads actors, keys (PEM or base64) and the audit App', () => {
    const config = loadConfig(env());
    assert.equal(config.actors.get('luca-claude-code')?.installationId, 172194780);
    assert.equal(config.audit.repo.name, 'holahola-broker-audit');
    assert.equal(config.port, 10_000);
    assert.deepEqual(config.mainRepository, { owner: 'HolaHolaOrganization', name: 'HolaHola', id: 1170208766 });
  });

  test('the main repository is the organization by default and by BROKER_MAIN_REPO_OWNER; name and id stay fixed', () => {
    assert.deepEqual(loadConfig(env({ BROKER_MAIN_REPO_OWNER: 'HolaHolaOrganization' })).mainRepository,
      { owner: 'HolaHolaOrganization', name: 'HolaHola', id: 1170208766 });
    assert.equal(loadConfig(env({ BROKER_MAIN_REPO_OWNER: '  ' })).mainRepository.owner, 'HolaHolaOrganization');
  });

  const invalid: Array<[string, Record<string, string | undefined>, string]> = [
    ['missing actors', { BROKER_ACTORS: undefined }, 'missing BROKER_ACTORS'],
    ['actors not JSON', { BROKER_ACTORS: '{' }, 'invalid BROKER_ACTORS'],
    ['empty actors', { BROKER_ACTORS: '[]' }, 'invalid BROKER_ACTORS'],
    ['unknown actor field', { BROKER_ACTORS: JSON.stringify([{ actor: 'luca-claude-code', appId: 1, installationId: 2, botLogin: 'x[bot]', role: 'admin' }]) }, 'invalid BROKER_ACTORS'],
    ['bot login not a bot', { BROKER_ACTORS: JSON.stringify([{ actor: 'luca-claude-code', appId: 5350010, installationId: 2, botLogin: 'davidwmcintosh' }]) }, 'invalid BROKER_ACTORS'],
    ['shared installation', { BROKER_ACTORS: JSON.stringify([
      { actor: 'a1', appId: 5350010, installationId: 2, botLogin: 'a[bot]' }, { actor: 'a2', appId: 5350011, installationId: 2, botLogin: 'b[bot]' }]), BROKER_APP_PRIVATE_KEY_5350011: lccKey }, 'invalid BROKER_ACTORS'],
    ['missing actor key', { BROKER_APP_PRIVATE_KEY_5350010: undefined }, 'missing BROKER_APP_PRIVATE_KEY_5350010'],
    ['garbage actor key', { BROKER_APP_PRIVATE_KEY_5350010: 'not a key' }, 'invalid BROKER_APP_PRIVATE_KEY_5350010'],
    ['audit repo is the main repo', { BROKER_AUDIT_REPO: 'davidwmcintosh/HolaHola' }, 'invalid BROKER_AUDIT_REPO'],
    ['audit repo is the main repo under the organization', { BROKER_AUDIT_REPO: 'holaholaorganization/holahola' }, 'invalid BROKER_AUDIT_REPO'],
    ['main repo owner outside the founder accounts', { BROKER_MAIN_REPO_OWNER: 'mallory' }, 'invalid BROKER_MAIN_REPO_OWNER'],
    ['main repo owner is the former personal account', { BROKER_MAIN_REPO_OWNER: 'davidwmcintosh' }, 'invalid BROKER_MAIN_REPO_OWNER'],
    ['main repo owner given as owner/name', { BROKER_MAIN_REPO_OWNER: 'HolaHolaOrganization/HolaHola' }, 'invalid BROKER_MAIN_REPO_OWNER'],
    ['audit installation reused by an actor', { BROKER_AUDIT_INSTALLATION_ID: '172194780' }, 'invalid BROKER_AUDIT_INSTALLATION_ID'],
    ['bad port', { PORT: '99999' }, 'invalid PORT'],
    ['duplicate bot login', { BROKER_ACTORS: JSON.stringify([
      { actor: 'a1', appId: 5350010, installationId: 2, botLogin: 'same[bot]' }, { actor: 'a2', appId: 5350011, installationId: 3, botLogin: 'same[bot]' }]),
      BROKER_APP_PRIVATE_KEY_5350011: lccKey }, 'invalid BROKER_ACTORS'],
    ['shared App id across actors', { BROKER_ACTORS: JSON.stringify([
      { actor: 'a1', appId: 5350010, installationId: 2, botLogin: 'a[bot]' }, { actor: 'a2', appId: 5350010, installationId: 3, botLogin: 'b[bot]' }]) }, 'invalid BROKER_ACTORS'],
    ['audit App id equal to an actor App', { BROKER_AUDIT_APP_ID: '5350010' }, 'invalid BROKER_AUDIT_APP_ID'],
  ];
  for (const [name, overrides, message] of invalid) {
    test(`rejects: ${name}`, () => {
      assert.throws(() => loadConfig(env(overrides)), (error: unknown) => error instanceof ConfigError && error.message === message);
    });
  }

  test('a non-RSA key is rejected and no error ever contains key material', () => {
    const ed = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const error = (() => { try { loadConfig(env({ BROKER_APP_PRIVATE_KEY_5350010: ed })); } catch (caught) { return caught as Error; } })();
    assert.ok(error instanceof ConfigError);
    assert.doesNotMatch(error.message, /PRIVATE KEY|MII/);
  });
});

describe('assembly', () => {
  test('per-actor loaders only for configured actors; the gateway targets the fixed main repository', () => {
    const { loaderFor, healthLoader, gateway } = assemble(loadConfig(env()), new GitHubApi(async () => new Response('{}')));
    assert.ok(loaderFor('luca-claude-code'));
    assert.equal(loaderFor('mallory'), undefined);
    assert.equal(healthLoader, loaderFor('luca-claude-code'));
    assert.ok(gateway);
    assert.equal(MAIN_REPOSITORY.id, 1170208766);
  });

  test('the policy source and the gateway both target the configured owner (private fields read at runtime)', () => {
    type Inner = { source: { repo: unknown } };
    for (const owner of ['HolaHolaOrganization']) {
      const { healthLoader, gateway } = assemble(loadConfig(env({ BROKER_MAIN_REPO_OWNER: owner })), new GitHubApi(async () => new Response('{}')));
      const expected = { owner, name: 'HolaHola', id: 1170208766 };
      assert.deepEqual((healthLoader as unknown as Inner).source.repo, expected);
      assert.deepEqual((gateway as unknown as { config: { repo: unknown } }).config.repo, expected);
    }
  });
});
