// Broker entry point (phase 2b wiring; deployed only in phase 4, separately gated).
//
// All identity and binding configuration is trusted server configuration from
// the broker service's OWN environment (luca-replit 2b design point 7): which
// actors exist, their App and installation, their bot login, and the audit
// repository. Nothing here is taken from a request. Configuration errors stop
// the process with a fixed message that names the variable, never its value.

import { createPrivateKey, type KeyObject } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { type LoaderFor } from './authorize.ts';
import { Gateway, type ActorBinding } from './gateway.ts';
import { GitHubApi, GitHubLedger, GitHubPolicySource, InstallationToken, type PolicyPath } from './github.ts';
import { PolicyLoader, REPOSITORY_ID } from './policy.ts';
import { createBrokerServer } from './server.ts';

export const MAIN_REPOSITORY = { owner: 'HolaHolaOrganization', name: 'HolaHola', id: REPOSITORY_ID } as const;
/**
 * The account HolaHola lives under: the organization, since the move from the
 * personal account on 2026-10-22. Requests refuse redirects, so the broker must
 * name the current owner; BROKER_MAIN_REPO_OWNER may only select this account
 * (default: MAIN_REPOSITORY.owner). The repository id never changes.
 */
export const MAIN_REPOSITORY_OWNERS: readonly string[] = ['HolaHolaOrganization'];
/** Former owners. Their HolaHola path still redirects to the main repository, so it can never be the audit repo. */
export const FORMER_MAIN_REPOSITORY_OWNERS: readonly string[] = ['davidwmcintosh'];

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

const ACTOR = /^[a-z][a-z0-9-]{1,62}$/;
const BOT_LOGIN = /^[a-z0-9-]{1,80}\[bot\]$/;
const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`missing ${name}`);
  return value;
}

function positiveInt(env: Env, name: string): number {
  const value = Number(required(env, name));
  if (!Number.isSafeInteger(value) || value <= 0) throw new ConfigError(`invalid ${name}`);
  return value;
}

/** PEM, PEM with literal \n, or base64-encoded PEM. Must be an RSA private key (GitHub App keys). */
function appKey(env: Env, name: string): KeyObject {
  const raw = required(env, name);
  const pem = raw.startsWith('-----BEGIN') ? raw.replace(/\\n/g, '\n') : Buffer.from(raw, 'base64').toString('utf8');
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new ConfigError(`invalid ${name}`);
  }
  if (key.asymmetricKeyType !== 'rsa') throw new ConfigError(`invalid ${name}`);
  return key;
}

export type BrokerConfig = {
  actors: Map<string, ActorBinding>;
  /** Control repository: where the founder-owned policy file is read from (always HolaHola main). */
  mainRepository: { owner: string; name: string; id: number };
  /**
   * The ONE repository this instance acts on. Production: the main repository.
   * The F4-a sandbox instance: its immutable configured sandbox repository.
   * Fixed for the life of the process; never taken from a request.
   */
  target: { owner: string; name: string; id: number };
  policyPath: PolicyPath;
  audit: { repo: { owner: string; name: string }; repositoryId: number; appId: number; installationId: number; privateKey: KeyObject };
  port: number;
};

/**
 * BROKER_ACTORS: JSON array of { actor, appId, installationId, botLogin }.
 * BROKER_APP_PRIVATE_KEY_<appId>: each actor App's private key.
 * BROKER_AUDIT_REPO (owner/name), BROKER_AUDIT_REPO_ID, BROKER_AUDIT_APP_ID,
 * BROKER_AUDIT_INSTALLATION_ID, BROKER_AUDIT_APP_PRIVATE_KEY: the audit App.
 * BROKER_MAIN_REPO_OWNER (optional): one of MAIN_REPOSITORY_OWNERS.
 * BROKER_TARGET (optional): 'main' (default) or 'sandbox'. A sandbox instance
 *   also needs BROKER_TARGET_REPO (owner/name) and BROKER_TARGET_REPO_ID, and
 *   reads broker/policy.sandbox.json from main instead of broker/policy.json.
 * PORT: listen port (default 10000).
 */
export function loadConfig(env: Env): BrokerConfig {
  let list: unknown;
  try {
    list = JSON.parse(required(env, 'BROKER_ACTORS'));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('invalid BROKER_ACTORS');
  }
  if (!Array.isArray(list) || list.length === 0) throw new ConfigError('invalid BROKER_ACTORS');
  const actors = new Map<string, ActorBinding>();
  const installations = new Set<number>();
  // Isolation contract: every actor is its own App (distinct App id, installation
  // and bot login), and the audit App is none of them.
  const appIds = new Set<number>();
  const botLogins = new Set<string>();
  for (const item of list) {
    const entry = item as Record<string, unknown>;
    const keys = typeof item === 'object' && item !== null ? Object.keys(item).sort().join(',') : '';
    if (keys !== 'actor,appId,botLogin,installationId') throw new ConfigError('invalid BROKER_ACTORS');
    const { actor, appId, installationId, botLogin } = entry;
    if (typeof actor !== 'string' || !ACTOR.test(actor) || actors.has(actor)) throw new ConfigError('invalid BROKER_ACTORS');
    if (!Number.isSafeInteger(appId) || (appId as number) <= 0 || !Number.isSafeInteger(installationId) || (installationId as number) <= 0) throw new ConfigError('invalid BROKER_ACTORS');
    if (typeof botLogin !== 'string' || !BOT_LOGIN.test(botLogin)) throw new ConfigError('invalid BROKER_ACTORS');
    if (installations.has(installationId as number) || appIds.has(appId as number) || botLogins.has(botLogin)) throw new ConfigError('invalid BROKER_ACTORS');
    installations.add(installationId as number);
    appIds.add(appId as number);
    botLogins.add(botLogin);
    actors.set(actor, {
      appId: appId as number, installationId: installationId as number, botLogin,
      privateKey: appKey(env, `BROKER_APP_PRIVATE_KEY_${appId}`),
    });
  }
  const mainOwner = env.BROKER_MAIN_REPO_OWNER?.trim() || MAIN_REPOSITORY.owner;
  if (!MAIN_REPOSITORY_OWNERS.includes(mainOwner)) throw new ConfigError('invalid BROKER_MAIN_REPO_OWNER');
  const mainRepository = { owner: mainOwner, name: MAIN_REPOSITORY.name, id: MAIN_REPOSITORY.id };
  const auditRepo = required(env, 'BROKER_AUDIT_REPO');
  // The audit repo is never HolaHola itself, under its current or any former owner.
  if (!REPO_NAME.test(auditRepo) || [...MAIN_REPOSITORY_OWNERS, ...FORMER_MAIN_REPOSITORY_OWNERS].some((o) => auditRepo.toLowerCase() === `${o}/${MAIN_REPOSITORY.name}`.toLowerCase())) {
    throw new ConfigError('invalid BROKER_AUDIT_REPO');
  }
  const [owner, name] = auditRepo.split('/');
  const auditInstallation = positiveInt(env, 'BROKER_AUDIT_INSTALLATION_ID');
  if (installations.has(auditInstallation)) throw new ConfigError('invalid BROKER_AUDIT_INSTALLATION_ID');
  const auditAppId = positiveInt(env, 'BROKER_AUDIT_APP_ID');
  if (appIds.has(auditAppId)) throw new ConfigError('invalid BROKER_AUDIT_APP_ID');
  const auditRepositoryId = positiveInt(env, 'BROKER_AUDIT_REPO_ID');
  const targetKind = env.BROKER_TARGET?.trim() || 'main';
  let target: { owner: string; name: string; id: number } = mainRepository;
  let policyPath: PolicyPath = 'broker/policy.json';
  if (targetKind === 'sandbox') {
    const targetRepo = required(env, 'BROKER_TARGET_REPO');
    const targetId = positiveInt(env, 'BROKER_TARGET_REPO_ID');
    const lower = targetRepo.toLowerCase();
    // A sandbox target is never HolaHola (under any owner, or by id) and never the audit repository.
    if (!REPO_NAME.test(targetRepo)
      || [...MAIN_REPOSITORY_OWNERS, ...FORMER_MAIN_REPOSITORY_OWNERS].some((o) => lower === `${o}/${MAIN_REPOSITORY.name}`.toLowerCase())
      || lower === auditRepo.toLowerCase()) {
      throw new ConfigError('invalid BROKER_TARGET_REPO');
    }
    if (targetId === MAIN_REPOSITORY.id || targetId === auditRepositoryId) throw new ConfigError('invalid BROKER_TARGET_REPO_ID');
    const [targetOwner, targetName] = targetRepo.split('/');
    target = { owner: targetOwner, name: targetName, id: targetId };
    policyPath = 'broker/policy.sandbox.json';
  } else if (targetKind !== 'main') {
    throw new ConfigError('invalid BROKER_TARGET');
  } else if (env.BROKER_TARGET_REPO !== undefined || env.BROKER_TARGET_REPO_ID !== undefined) {
    // A sandbox setting without the sandbox target is a misconfiguration, never silently ignored.
    throw new ConfigError('invalid BROKER_TARGET');
  }
  const port = env.PORT === undefined ? 10_000 : Number(env.PORT);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw new ConfigError('invalid PORT');
  return {
    actors,
    mainRepository,
    target,
    policyPath,
    audit: {
      repo: { owner, name }, repositoryId: auditRepositoryId,
      appId: auditAppId, installationId: auditInstallation, privateKey: appKey(env, 'BROKER_AUDIT_APP_PRIVATE_KEY'),
    },
    port,
  };
}

/** Builds the per-actor policy loaders, the audit ledger and the gateway from trusted config. */
export function assemble(config: BrokerConfig, api: GitHubApi, now: () => number = Date.now) {
  const loaders = new Map<string, PolicyLoader>();
  for (const [actor, binding] of config.actors) {
    // Each actor's own App reads policy, downscoped to contents:read on HolaHola
    // (the control repository) only, even for a sandbox instance. The parsed
    // policy must name this instance's target repository.
    const read = new InstallationToken(api, {
      appId: binding.appId, installationId: binding.installationId, privateKey: binding.privateKey,
      repositoryId: config.mainRepository.id, permissions: { contents: 'read' },
    }, now);
    const source = new GitHubPolicySource(api, config.mainRepository, () => read.get(), config.policyPath);
    loaders.set(actor, new PolicyLoader(source, now, undefined, undefined, config.target.id));
  }
  const auditToken = new InstallationToken(api, {
    appId: config.audit.appId, installationId: config.audit.installationId, privateKey: config.audit.privateKey,
    repositoryId: config.audit.repositoryId, permissions: { contents: 'write' },
  }, now);
  const ledger = new GitHubLedger(api, config.audit.repo, () => auditToken.get());
  const loaderFor: LoaderFor = (actor) => loaders.get(actor);
  const gateway = new Gateway({ repo: config.target, actors: config.actors, api, ledger, loaderFor, now });
  return { loaderFor, healthLoader: loaders.values().next().value as PolicyLoader, gateway };
}

export function main(env: Env = process.env): void {
  let config: BrokerConfig;
  try {
    config = loadConfig(env);
  } catch (error) {
    console.error(`broker: configuration error: ${error instanceof ConfigError ? error.message : 'invalid configuration'}`);
    process.exit(78);
  }
  const { loaderFor, healthLoader, gateway } = assemble(config, new GitHubApi(fetch));
  createBrokerServer({ loaderFor, healthLoader, gateway }).listen(config.port, () => {
    console.log(`broker: listening on ${config.port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
