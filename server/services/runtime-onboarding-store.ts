import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export type RuntimeOnboardingActor = string;
/**
 * 'broker-signing-key' holds a hat's own Ed25519 key for the isolated broker
 * (costed plan ff04f70e): the same host store and scope rules, a separate
 * purpose, so it never collides with onboarding material.
 */
export type RuntimeOnboardingPurpose = 'proof-key' | 'attempt-state' | 'access-credential' | 'broker-signing-key';

export type RuntimeOnboardingScope = {
  endpoint: string;
  actor: RuntimeOnboardingActor;
  runtimeId: string;
};

export interface RuntimeOnboardingStore {
  get(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose): Promise<string | null>;
  set(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose, value: string): Promise<void>;
  /** Atomically persist once, returning the value that won across processes. */
  setIfAbsent(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose, value: string): Promise<string>;
  delete(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose): Promise<void>;
}

function scopeDigest(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose): string {
  return createHash('sha256')
    .update(JSON.stringify([scope.endpoint, scope.actor, scope.runtimeId, purpose]))
    .digest('hex');
}

type StoreCommand = {
  operation: 'get' | 'set' | 'set-if-absent' | 'delete';
  account: string;
  value?: string;
};

type CommandResult = { code: number | null; stdout: string; stderr: string };

export type SecureStoreDiagnosticCategory =
  | 'execution_policy_blocked'
  | 'signature_rejected'
  | 'executable_unavailable'
  | 'invalid_helper_response'
  | 'unknown';

/** Contains only fixed codes: never retain child output, input, or a cause. */
export class SecureStoreDiagnosticError extends Error {
  constructor(
    message: 'dpapi_secure_store_failed' | 'secure_store_operation_failed'
      | 'secure_store_response_invalid' | 'secure_store_response_too_large',
    readonly diagnosticCategory: SecureStoreDiagnosticCategory,
  ) {
    super(message);
    this.name = 'SecureStoreDiagnosticError';
  }
}

export function secureStoreDiagnosticCategory(error: unknown): SecureStoreDiagnosticCategory | undefined {
  if (!(error instanceof SecureStoreDiagnosticError)) return undefined;
  // Also validate at the serialization boundary; JS callers can mutate fields.
  switch (error.diagnosticCategory) {
    case 'execution_policy_blocked':
    case 'signature_rejected':
    case 'executable_unavailable':
    case 'invalid_helper_response':
    case 'unknown':
      return error.diagnosticCategory;
    default:
      return 'unknown';
  }
}

/** Recognize PowerShell's wrapped security error, not arbitrary keyword matches. */
export function classifyWindowsHelperFailure(stderr: string): SecureStoreDiagnosticCategory {
  const text = stderr.slice(0, 8192).replace(/\s+/g, ' ');
  const securityError = /CategoryInfo\s*:\s*SecurityError\b.*\b(?:PSSecurityException|ParentContainsErrorRecordException)\b/i.test(text)
    && /FullyQualifiedErrorId\s*:\s*UnauthorizedAccess\b/i.test(text);
  if (!securityError) return 'unknown';
  if (/\bis not digitally signed\b/i.test(text)) return 'signature_rejected';
  if (/\brunning scripts is disabled on this system\b/i.test(text)) return 'execution_policy_blocked';
  return 'unknown';
}

function runCommand(
  executable: string,
  args: string[],
  input: string,
  maxOutputBytes = 1024 * 1024,
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      reject(new SecureStoreDiagnosticError('secure_store_operation_failed', 'unknown'));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    child.stdout!.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill();
        reject(new SecureStoreDiagnosticError('secure_store_response_too_large', 'invalid_helper_response'));
        return;
      }
      stdout.push(chunk);
    });
    let stderrBytes = 0;
    child.stderr!.on('data', (chunk: Buffer) => {
      const bounded = chunk.subarray(0, Math.max(0, 8192 - stderrBytes));
      stderrBytes += bounded.length;
      if (bounded.length) stderr.push(bounded);
    });
    child.once('error', (error) => {
      reject(new SecureStoreDiagnosticError('secure_store_operation_failed',
        (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'executable_unavailable' : 'unknown'));
    });
    // A failed launch can close stdin before the command is written. Never
    // expose EPIPE text or let it become an uncaught stream error.
    child.stdin!.on('error', () => undefined);
    child.once('close', (code) => {
      resolvePromise({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin!.end(input, 'utf8');
  });
}

function storeCommand(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose, operation: StoreCommand['operation'], value?: string): StoreCommand {
  return {
    operation,
    account: scopeDigest(scope, purpose),
    ...(value === undefined ? {} : { value }),
  };
}

function parseStoreValue(result: CommandResult): string | null {
  if (result.code !== 0) throw new Error('secure_store_operation_failed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new SecureStoreDiagnosticError('secure_store_response_invalid', 'invalid_helper_response');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new SecureStoreDiagnosticError('secure_store_response_invalid', 'invalid_helper_response');
  const value = (parsed as Record<string, unknown>).value;
  if (value === null) return null;
  if (typeof value !== 'string') throw new SecureStoreDiagnosticError('secure_store_response_invalid', 'invalid_helper_response');
  return value;
}

function parseSetIfAbsentValue(result: CommandResult): { value: string; created: boolean } {
  if (result.code !== 0) throw new Error('secure_store_operation_failed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new SecureStoreDiagnosticError('secure_store_response_invalid', 'invalid_helper_response');
  }
  if (typeof parsed !== 'object' || parsed === null
    || typeof (parsed as Record<string, unknown>).value !== 'string'
    || typeof (parsed as Record<string, unknown>).created !== 'boolean') {
    throw new SecureStoreDiagnosticError('secure_store_response_invalid', 'invalid_helper_response');
  }
  return {
    value: (parsed as Record<string, unknown>).value as string,
    created: (parsed as Record<string, unknown>).created as boolean,
  };
}

function linuxAtomicLockPath(account: string): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  if (uid < 0) throw new Error('secure_store_operation_failed');
  // One OS-user namespace regardless of IDE/headless launch environment.
  // XDG_RUNTIME_DIR and TMPDIR can differ between simultaneous consumers.
  // This directory contains only empty flock files, never credential material.
  const lockDirectory = resolve('/tmp', `holahola-runtime-onboarding-${uid}`);
  try {
    mkdirSync(lockDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('secure_store_operation_failed');
  }
  let directoryStat;
  try {
    const linkStat = lstatSync(lockDirectory);
    directoryStat = linkStat;
    if (linkStat.isSymbolicLink() || !linkStat.isDirectory()) throw new Error('unsafe');
  } catch {
    throw new Error('secure_store_operation_failed');
  }
  if (directoryStat.uid !== uid || (directoryStat.mode & 0o077) !== 0) {
    throw new Error('secure_store_operation_failed');
  }
  const path = resolve(lockDirectory, `holahola-runtime-onboarding-${account}.lock`);
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, 0o600);
    const fileStat = fstatSync(fd);
    if (!fileStat.isFile() || fileStat.uid !== uid) throw new Error('unsafe');
    chmodSync(path, 0o600);
  } catch {
    throw new Error('secure_store_operation_failed');
  } finally {
    if (typeof fd === 'number') closeSync(fd);
  }
  return path;
}

const LINUX_ATOMIC_SET_IF_ABSENT_SCRIPT = String.raw`
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const service = 'holahola-runtime-onboarding-v1';
const attrs = ['service', service, 'scope', input.account];
function run(args, stdin = '') {
  const result = spawnSync('secret-tool', args, {
    input: stdin,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.error) return { status: null, stdout: '', stderr: '' };
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}
function fail() {
  process.stderr.write('secret_service_atomic_store_failed');
  process.exit(1);
}
const current = run(['lookup', ...attrs]);
if (current.status === 0) {
  process.stdout.write(JSON.stringify({
    value: current.stdout.replace(/\r?\n$/, ''),
    created: false,
  }));
  process.exit(0);
}
const currentError = current.stderr.toLowerCase();
const missing = current.status === 1 && (
  current.stderr.trim() === ''
  || /no such secret|secret not found|no matching secret/.test(currentError)
);
if (!missing) fail();

// A missing-item response is ambiguous on Secret Service: verify the session
// with a unique store/lookup/clear round trip before treating it as an empty key.
const probeScope = 'probe-' + randomUUID();
const probeValue = randomUUID();
const probeAttrs = ['service', service, 'scope', probeScope];
const probeStore = run(['store', '--label=HolaHola onboarding health check', ...probeAttrs], probeValue);
if (probeStore.status !== 0) fail();
const probeRead = run(['lookup', ...probeAttrs]);
const probeClear = run(['clear', ...probeAttrs]);
if (probeRead.status !== 0 || probeRead.stdout.replace(/\r?\n$/, '') !== probeValue
  || probeClear.status !== 0) fail();

const stored = run(
  ['store', '--label=HolaHola coordination runtime', ...attrs],
  input.value,
);
if (stored.status !== 0) fail();
process.stdout.write(JSON.stringify({ value: input.value, created: true }));
`;

/**
 * Windows DPAPI CurrentUser adapter. The value is sent only on the child
 * process's stdin; arguments contain the fixed script path and operation.
 * The PowerShell adapter applies a separate coordination-only namespace,
 * CurrentUser DPAPI, restrictive ACLs, and reparse-point validation.
 */
export class WindowsDpapiRuntimeOnboardingStore implements RuntimeOnboardingStore {
  private readonly scriptPath: string;

  constructor(scriptPath?: string) {
    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    const sourceTreeScript = resolve(moduleDirectory, '../scripts/runtime-onboarding-native-store.ps1');
    const adjacentDistributionScript = resolve(moduleDirectory, 'runtime-onboarding-native-store.ps1');
    scriptPath ??= existsSync(sourceTreeScript) ? sourceTreeScript : adjacentDistributionScript;
    this.scriptPath = scriptPath;
  }

  private async run(command: StoreCommand): Promise<CommandResult> {
    const powershell = process.env.SystemRoot
      ? resolve(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    const result = await runCommand(
      powershell,
      // Child-session policy only: no registry change, and MachinePolicy /
      // UserPolicy still take precedence. Never retry with Bypass or unblock.
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', this.scriptPath, command.operation],
      JSON.stringify(command),
    );
    if (result.code !== 0) {
      throw new SecureStoreDiagnosticError('dpapi_secure_store_failed', classifyWindowsHelperFailure(result.stderr));
    }
    if (command.operation === 'set' || command.operation === 'delete') {
      let parsed: unknown;
      try { parsed = JSON.parse(result.stdout); } catch {
        throw new SecureStoreDiagnosticError('secure_store_response_invalid', 'invalid_helper_response');
      }
      if (typeof parsed !== 'object' || parsed === null
        || (parsed as Record<string, unknown>).ok !== true) {
        throw new SecureStoreDiagnosticError('secure_store_response_invalid', 'invalid_helper_response');
      }
    }
    return result;
  }

  async get(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose): Promise<string | null> {
    return parseStoreValue(await this.run(storeCommand(scope, purpose, 'get')));
  }

  async set(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose, value: string): Promise<void> {
    await this.run(storeCommand(scope, purpose, 'set', value));
  }

  async setIfAbsent(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose, value: string): Promise<string> {
    return (await parseSetIfAbsentValue(await this.run(storeCommand(scope, purpose, 'set-if-absent', value)))).value;
  }

  async delete(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose): Promise<void> {
    await this.run(storeCommand(scope, purpose, 'delete'));
  }
}

const KEYCHAIN_SCRIPT = String.raw`
import Foundation
import Security

let raw = FileHandle.standardInput.readDataToEndOfFile()
guard let input = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
      let operation = input["operation"] as? String,
      let account = input["account"] as? String else { exit(20) }
let service = "com.holahola.coordination.runtime-onboarding.v1"
let base: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: service,
  kSecAttrAccount as String: account
]
func write(_ object: [String: Any]) {
  guard let bytes = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { exit(21) }
  FileHandle.standardOutput.write(bytes)
}
if operation == "get" {
  var query = base
  query[kSecReturnData as String] = true
  query[kSecMatchLimit as String] = kSecMatchLimitOne
  var item: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &item)
  if status == errSecItemNotFound { write(["value": NSNull()]); exit(0) }
  guard status == errSecSuccess, let data = item as? Data,
        let value = String(data: data, encoding: .utf8) else { exit(22) }
  write(["value": value])
} else if operation == "set-if-absent" {
  guard let value = input["value"] as? String,
        let data = value.data(using: .utf8) else { exit(23) }
  var item = base
  item[kSecValueData as String] = data
  let status = SecItemAdd(item as CFDictionary, nil)
  if status == errSecSuccess {
    write(["value": value, "created": true])
  } else if status == errSecDuplicateItem {
    var query = base
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var existing: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &existing) == errSecSuccess,
          let bytes = existing as? Data,
          let stored = String(data: bytes, encoding: .utf8) else { exit(28) }
    write(["value": stored, "created": false])
  } else { exit(29) }
} else if operation == "set" {
  guard let value = input["value"] as? String,
        let data = value.data(using: .utf8) else { exit(23) }
  let status = SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
  if status == errSecItemNotFound {
    var item = base
    item[kSecValueData as String] = data
    guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { exit(24) }
  } else if status != errSecSuccess { exit(25) }
  write(["ok": true])
} else if operation == "delete" {
  let status = SecItemDelete(base as CFDictionary)
  guard status == errSecSuccess || status == errSecItemNotFound else { exit(26) }
  write(["ok": true])
} else { exit(27) }
`;

/** macOS Keychain adapter. Swift receives secret values through stdin only. */
export class MacOsKeychainRuntimeOnboardingStore implements RuntimeOnboardingStore {
  private async run(command: StoreCommand): Promise<CommandResult> {
    const result = await runCommand('swift', ['-e', KEYCHAIN_SCRIPT], JSON.stringify(command));
    if (result.code !== 0) throw new Error('keychain_secure_store_failed');
    return result;
  }

  async get(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose): Promise<string | null> {
    return parseStoreValue(await this.run(storeCommand(scope, purpose, 'get')));
  }

  async set(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose, value: string): Promise<void> {
    await this.run(storeCommand(scope, purpose, 'set', value));
  }

  async setIfAbsent(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose, value: string): Promise<string> {
    return (await parseSetIfAbsentValue(await this.run(storeCommand(scope, purpose, 'set-if-absent', value)))).value;
  }

  async delete(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose): Promise<void> {
    await this.run(storeCommand(scope, purpose, 'delete'));
  }
}

/** Linux Secret Service adapter. `secret-tool` consumes values on stdin. */
export class LinuxSecretServiceRuntimeOnboardingStore implements RuntimeOnboardingStore {
  private async runProbe(): Promise<void> {
    const service = 'holahola-runtime-onboarding-v1';
    const probeScope = `probe-${randomUUID()}`;
    const probeValue = randomUUID();
    const attributes = ['service', service, 'scope', probeScope];
    const stored = await runCommand(
      'secret-tool',
      ['store', '--label=HolaHola onboarding health check', ...attributes],
      probeValue,
    );
    if (stored.code !== 0) throw new Error('secret_service_unavailable_or_lookup_failed');
    const read = await runCommand('secret-tool', ['lookup', ...attributes], '');
    const clear = await runCommand('secret-tool', ['clear', ...attributes], '');
    if (read.code !== 0 || read.stdout.replace(/\r?\n$/, '') !== probeValue || clear.code !== 0) {
      throw new Error('secret_service_unavailable_or_lookup_failed');
    }
  }

  private decodeSecret(encodedValue: string): string {
    const bytes = Buffer.from(encodedValue, 'base64');
    if (bytes.toString('base64') !== encodedValue) throw new Error('secret_service_entry_invalid');
    const value = bytes.toString('utf8');
    if (!Buffer.from(value, 'utf8').equals(bytes)) throw new Error('secret_service_entry_invalid');
    return value;
  }

  private async run(command: StoreCommand): Promise<CommandResult> {
    const attributes = ['service', 'holahola-runtime-onboarding-v1', 'scope', command.account];
    if (command.operation === 'get') {
      const result = await runCommand('secret-tool', ['lookup', ...attributes], '');
      if (result.code !== 0) {
        const reason = result.stderr.toLowerCase();
        const missing = result.code === 1 && (
          result.stderr.trim() === ''
          || /no such secret|secret not found|no matching secret/.test(reason)
        );
        if (!missing) throw new Error('secret_service_unavailable_or_lookup_failed');
        await this.runProbe();
        return { ...result, code: 0, stdout: JSON.stringify({ value: null }) };
      }
      const encoded = result.stdout.replace(/\r?\n$/, '');
      const value = this.decodeSecret(encoded);
      return { ...result, stdout: JSON.stringify({ value }) };
    }
    if (command.operation === 'set-if-absent') {
      if (command.value === undefined) throw new Error('secure_store_value_required');
      const lockPath = linuxAtomicLockPath(command.account);
      const result = await runCommand(
        'flock',
        ['--exclusive', lockPath, process.execPath, '--input-type=commonjs', '-e', LINUX_ATOMIC_SET_IF_ABSENT_SCRIPT],
        JSON.stringify({ account: command.account, value: Buffer.from(command.value, 'utf8').toString('base64') }),
      );
      const stored = parseSetIfAbsentValue(result);
      return {
        ...result,
        stdout: JSON.stringify({ value: this.decodeSecret(stored.value), created: stored.created }),
      };
    }
    if (command.operation === 'set') {
      if (command.value === undefined) throw new Error('secure_store_value_required');
      const encoded = Buffer.from(command.value, 'utf8').toString('base64');
      const result = await runCommand('secret-tool', ['store', '--label=HolaHola coordination runtime', ...attributes], encoded);
      if (result.code !== 0) throw new Error('secret_service_store_failed');
      return { ...result, stdout: JSON.stringify({ ok: true }) };
    }
    const result = await runCommand('secret-tool', ['clear', ...attributes], '');
    if (result.code !== 0) throw new Error('secret_service_delete_failed');
    return { ...result, stdout: JSON.stringify({ ok: true }) };
  }

  async get(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose): Promise<string | null> {
    return parseStoreValue(await this.run(storeCommand(scope, purpose, 'get')));
  }

  async set(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose, value: string): Promise<void> {
    await this.run(storeCommand(scope, purpose, 'set', value));
  }

  async setIfAbsent(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose, value: string): Promise<string> {
    const result = await this.run(storeCommand(scope, purpose, 'set-if-absent', value));
    return parseSetIfAbsentValue(result).value;
  }

  async delete(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose): Promise<void> {
    await this.run(storeCommand(scope, purpose, 'delete'));
  }
}

export type HostedSecretStoreAdapter = {
  /** Must be asserted by the host integration, not inferred by this helper. */
  runtimeRestricted: true;
  get(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose): Promise<string | null>;
  set(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose, value: string): Promise<void>;
  setIfAbsent(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose, value: string): Promise<string>;
  delete(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose): Promise<void>;
};

/** Explicit, injected hosted-store adapter; never uses files or environment tokens. */
export class HostedRuntimeOnboardingStore implements RuntimeOnboardingStore {
  constructor(private readonly adapter: HostedSecretStoreAdapter) {
    if (adapter.runtimeRestricted !== true) {
      throw new Error('hosted_secure_store_must_be_runtime_restricted');
    }
  }

  get(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose): Promise<string | null> {
    return this.adapter.get(scope, purpose);
  }

  set(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose, value: string): Promise<void> {
    return this.adapter.set(scope, purpose, value);
  }

  setIfAbsent(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose, value: string): Promise<string> {
    return this.adapter.setIfAbsent(scope, purpose, value);
  }

  delete(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose): Promise<void> {
    return this.adapter.delete(scope, purpose);
  }
}

/** Select a native adapter, failing explicitly rather than downgrading to disk. */
export function createNativeRuntimeOnboardingStore(platform = process.platform): RuntimeOnboardingStore {
  if (platform === 'win32') return new WindowsDpapiRuntimeOnboardingStore();
  if (platform === 'darwin') return new MacOsKeychainRuntimeOnboardingStore();
  if (platform === 'linux') return new LinuxSecretServiceRuntimeOnboardingStore();
  throw new Error(`secure_store_unsupported_platform:${platform}`);
}