/**
 * Portable Gate 3 operator driver.  This file deliberately has no provider,
 * database, shell, or fixed-token implementation: the coordinator is the
 * authority and Antigravity is only the bounded local executor.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { spawn as nodeSpawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, relative, sep } from 'node:path';
import {
  COORDINATION_GATE3_FIXED_TARGET,
  digestCanonical,
  isFixedTargetReadArguments,
  isPlainRecord,
} from '../services/coordination-runtime';
import { TaskOwnershipHttpClient, proveTaskOwnership, type OwnershipProofResult } from '../services/task-ownership-client';
import type { HostOperationAdapter } from '../services/coordination-host-operation-service';

export const TARGET = COORDINATION_GATE3_FIXED_TARGET;
const ALLOWED = {
  root: ['git', 'rev-parse', '--show-toplevel'],
  branch: ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
  head: ['git', 'rev-parse', 'HEAD'],
  status: ['git', 'status', '--short'],
  diff: ['git', 'diff', '--', TARGET],
  test: ['npx', 'tsx', TARGET],
} as const;
const LIMITS = { bytes: 40960, turns: 4, attempts: 8, elapsed: 600000, command: 600000 };
const WINDOWS_COMMAND_PROCESSOR = 'C:\\Windows\\System32\\cmd.exe';

export type Http = (input: { method: string; path: string; headers: Record<string, string>; body?: unknown }) =>
  Promise<{ status: number; body: unknown }>;
export type Spawn = (argv: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number }) =>
  Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }>;
export type Fs = {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<{ isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean; isReparsePoint?: () => boolean; fileAttributes?: number }>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: string): Promise<void>;
};
/** Provider-neutral boundary consumed by the Coordinator host protocol. */
export type LogicalOperationRequest = {
  operation: string;
  operationDigest: string;
  input: Record<string, unknown>;
};
export type LogicalOperationResult = Record<string, unknown>;
export type DriverOptions = {
  baseUrl: string; runtimeId: string; worktree: string; windowId: string;
  assignmentEventId?: string; bootstrap?: string; ownershipReceiptId?: string; ownershipArtifactSha256?: string; receiptFile?: string;
  http?: Http; spawn?: Spawn; fs?: Fs; env?: Record<string, string>;
  platform?: NodeJS.Platform;
  ownershipClient?: TaskOwnershipHttpClient;
  proveOwnership?: (client: TaskOwnershipHttpClient | undefined, taskRef: string, actor: string, receiptId: string) => Promise<unknown>;
  now?: () => number; sleep?: (milliseconds: number) => Promise<void>;
};

const realFs: Fs = { realpath, lstat, readFile, writeFile };
const spawn: Spawn = (argv, options) => new Promise((resolvePromise, reject) => {
  const child = nodeSpawn(argv[0], argv.slice(1), { cwd: options.cwd, env: options.env, shell: false });
  let stdout = '', stderr = '';
  child.stdout.on('data', (value) => { stdout += value; });
  child.stderr.on('data', (value) => { stderr += value; });
  const timer = setTimeout(() => { child.kill(); resolvePromise({ code: -1, stdout, stderr, timedOut: true }); }, options.timeoutMs);
  child.on('error', reject);
  child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code: code ?? -1, stdout, stderr }); });
});

function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function normalizedWindowsPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}
function safeError(error: unknown): Error {
  const text = error instanceof Error ? error.message : String(error);
  return new Error(text.replace(/(?:cb|ct)_[A-Za-z0-9_-]{12,}/g, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]'));
}
function idempotency(prefix: string): string { return `antigravity-${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`; }

/** Strict parser shared by the HTTP proof contract and the portable driver. */
export function parseOwnershipProof(value: unknown, receiptId: string, artifactSha256: string): OwnershipProofResult {
  const proof = value as Record<string, unknown> | null;
  const keys = proof ? Object.keys(proof).sort().join(',') : '';
  const grant = proof?.grant as Record<string, unknown> | undefined;
  const grantKeys = grant ? Object.keys(grant).sort().join(',') : '';
  if (!proof || keys !== 'artifactSha256,contextDigest,grant,intendedActor,ok,proofPayloadDigest,receiptId,taskRef,verified' ||
      !grant || grantKeys !== 'artifactSha256,contextDigest,expiresAt,id,startingCommit,taskRef' ||
      proof.ok !== true || proof.verified !== true || proof.receiptId !== receiptId ||
      proof.taskRef !== '1448' || proof.intendedActor !== 'luca-gemini' ||
      proof.artifactSha256 !== artifactSha256 || typeof proof.contextDigest !== 'string' ||
      typeof proof.proofPayloadDigest !== 'string' || !/^[0-9a-f]{64}$/.test(proof.proofPayloadDigest) ||
      typeof grant.id !== 'string' || grant.id === '' || grant.taskRef !== '1448' || grant.artifactSha256 !== artifactSha256 ||
      grant.contextDigest !== proof.contextDigest || typeof grant.startingCommit !== 'string' ||
      typeof grant.expiresAt !== 'string' || !Number.isFinite(Date.parse(grant.expiresAt))) {
    throw new Error('ownership_proof_rejected');
  }
  return proof as OwnershipProofResult;
}

export function validateArgv(argv: string[]): void {
  const key = argv.join('\0');
  if (Object.values(ALLOWED).some((allowed) => key === allowed.join('\0'))) return;
  throw new Error('command_not_allowed');
}

function targetPath(root: string): string {
  const path = resolve(root, TARGET);
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..' + sep) || resolve(root, rel) !== path) throw new Error('path_not_allowed');
  return path;
}

async function assertSafePath(fs: Fs, root: string, path: string): Promise<void> {
  const rootReal = await fs.realpath(root);
  const target = targetPath(rootReal);
  const normalize = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  const rootKey = normalize(rootReal);
  const targetKey = normalize(path);
  if (targetKey !== normalize(target) && targetKey !== rootKey) throw new Error('path_not_allowed');
  if (!(targetKey === rootKey || targetKey.startsWith(rootKey + '/'))) throw new Error('path_not_allowed');
  const rootStat = await fs.lstat(rootReal);
  if (rootStat.isSymbolicLink() || rootStat.isReparsePoint?.() ||
      (rootStat.fileAttributes !== undefined && (rootStat.fileAttributes & 0x400) !== 0)) throw new Error('symlink_not_allowed');
  if (!rootStat.isDirectory()) throw new Error('path_not_allowed');
  const parts = relative(rootReal, path).split(sep).filter(Boolean);
  let current = rootReal;
  for (const part of parts) {
    current = resolve(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('symlink_not_allowed');
      if (stat.isReparsePoint?.() || (stat.fileAttributes !== undefined && (stat.fileAttributes & 0x400) !== 0)) {
        throw new Error('symlink_not_allowed');
      }
      if (current !== path && !stat.isDirectory()) throw new Error('path_not_allowed');
      if (current === path && !stat.isFile()) throw new Error('path_not_allowed');
      const resolved = await fs.realpath(current);
      const resolvedKey = normalize(resolved);
      if (!(resolvedKey === rootKey || resolvedKey.startsWith(rootKey + '/'))) throw new Error('path_not_allowed');
    } catch (error) {
      // The declared target may be the one new file in Gate 3. Its parent
      // must still have been resolved and checked above.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || current !== path) throw error;
    }
  }
}

async function readApprovedArtifact(fs: Fs, root: string): Promise<Buffer> {
  const artifact = resolve(root, '.local', 'tasks', 'task-1448.md');
  const rootKey = normalizedWindowsPath(root);
  const artifactKey = normalizedWindowsPath(artifact);
  if (!artifactKey.startsWith(rootKey + '/')) throw new Error('path_not_allowed');
  let current = root;
  for (const part of relative(root, artifact).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || stat.isReparsePoint?.() ||
        (stat.fileAttributes !== undefined && (stat.fileAttributes & 0x400) !== 0)) throw new Error('symlink_not_allowed');
    if (current !== artifact && !stat.isDirectory()) throw new Error('path_not_allowed');
    if (current === artifact && !stat.isFile()) throw new Error('path_not_allowed');
    const resolved = normalizedWindowsPath(await fs.realpath(current));
    if (!(resolved === rootKey || resolved.startsWith(rootKey + '/'))) throw new Error('path_not_allowed');
  }
  return fs.readFile(artifact);
}

type EolStyle = 'none' | 'lf' | 'crlf';

function classifyEol(text: string, invalidCode: string): EolStyle {
  let sawLf = false;
  let sawCrlf = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\r') {
      if (text[index + 1] !== '\n') throw new Error(invalidCode);
      sawCrlf = true;
      index += 1;
    } else if (text[index] === '\n') {
      sawLf = true;
    }
    if (sawLf && sawCrlf) throw new Error(invalidCode);
  }
  return sawCrlf ? 'crlf' : sawLf ? 'lf' : 'none';
}

function canonicalLf(text: string, style: EolStyle): string {
  return style === 'crlf' ? text.replace(/\r\n/g, '\n') : text;
}

function restoreEol(text: string, style: EolStyle): string {
  return style === 'crlf' ? text.replace(/\n/g, '\r\n') : text;
}

export class Gate3Executor {
  constructor(private readonly root: string, private readonly fs: Fs = realFs, private readonly run: Spawn = spawn,
    private readonly childEnv: Record<string, string> = {}, private readonly platform: NodeJS.Platform = process.platform) {}
  private async command(argv: string[]) {
    validateArgv(argv);
    // Windows cannot execute npm's .cmd shim directly through CreateProcess.
    // The logical argv has already passed the exact allowlist above; this is
    // only a fixed host adapter and never accepts a constructed command string.
    const spawnArgv = this.platform === 'win32' && argv[0] === 'npx'
      ? [WINDOWS_COMMAND_PROCESSOR, '/d', '/s', '/c', 'npx.cmd', ...argv.slice(1)]
      : argv;
    return this.run(spawnArgv, { cwd: this.root, env: { PATH: this.childEnv.PATH ?? process.env.PATH ?? '', ...this.childEnv }, timeoutMs: LIMITS.command });
  }
  async measure(argv: string[]) { return this.command(argv); }
  async execute(intent: { name: string; arguments: unknown }): Promise<Record<string, unknown>> {
    const path = targetPath(await this.fs.realpath(this.root));
    if (!['git_status', 'git_diff', 'run_test', 'read_file', 'replace_once'].includes(intent.name)) throw new Error('command_not_allowed');
    if (intent.name === 'replace_once') {
      if (!isPlainRecord(intent.arguments)) throw new Error('argument_not_allowed');
      const keys = Object.keys(intent.arguments).sort();
      const oldText = intent.arguments.oldText;
      const newText = intent.arguments.newText;
      if (keys.join(',') !== 'newText,oldText' || typeof oldText !== 'string' || typeof newText !== 'string' ||
          !oldText || oldText === newText) {
        throw new Error('argument_not_allowed');
      }
      if (Buffer.byteLength(oldText, 'utf8') + Buffer.byteLength(newText, 'utf8') > LIMITS.bytes) {
        throw new Error('output_limit_exceeded');
      }
      await assertSafePath(this.fs, await this.fs.realpath(this.root), path);
      const sourceBytes = await this.fs.readFile(path);
      let source: string;
      try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes);
      } catch {
        throw new Error('source_not_utf8');
      }
      const sourceEol = classifyEol(source, 'source_invalid_eol');
      const oldTextEol = classifyEol(oldText, 'old_text_invalid_eol');
      const newTextEol = classifyEol(newText, 'new_text_invalid_eol');
      const canonicalSource = canonicalLf(source, sourceEol);
      const canonicalOldText = canonicalLf(oldText, oldTextEol);
      const canonicalNewText = canonicalLf(newText, newTextEol);
      if (canonicalOldText === canonicalNewText) throw new Error('argument_not_allowed');
      let matches = 0;
      let matchAt = -1;
      for (let cursor = 0; cursor <= canonicalSource.length - canonicalOldText.length;) {
        const found = canonicalSource.indexOf(canonicalOldText, cursor);
        if (found < 0) break;
        matches += 1;
        matchAt = found;
        if (matches > 1) break;
        cursor = found + 1;
      }
      if (matches !== 1) throw new Error(matches === 0 ? 'replace_text_not_found' : 'replace_text_not_unique');
      const canonicalUpdated = canonicalSource.slice(0, matchAt) + canonicalNewText
        + canonicalSource.slice(matchAt + canonicalOldText.length);
      const updated = restoreEol(canonicalUpdated, sourceEol);
      if (Buffer.byteLength(updated, 'utf8') > LIMITS.bytes) throw new Error('output_limit_exceeded');
      const outputEol = classifyEol(updated, 'output_invalid_eol');
      await this.fs.writeFile(path, updated);
      return {
        ok: true,
        output: 'replaced',
        bytes: Buffer.byteLength(updated, 'utf8'),
        stdoutDigest: digest(updated),
        argv: ['replace_once', TARGET],
        truncated: false,
        eol: {
          source: sourceEol,
          oldText: oldTextEol,
          newText: newTextEol,
          canonicalized: sourceEol === 'crlf' || oldTextEol === 'crlf' || newTextEol === 'crlf',
          output: outputEol,
        },
      };
    }
    if (intent.name === 'read_file') {
      if (!isFixedTargetReadArguments(intent.arguments)) throw new Error('argument_not_allowed');
      await assertSafePath(this.fs, await this.fs.realpath(this.root), path);
      const content = await this.fs.readFile(path);
      return { ok: true, output: content.toString('utf8'), stdoutDigest: digest(content),
        argv: ['read_file', TARGET], truncated: false };
    }
    if (!isPlainRecord(intent.arguments) || Object.keys(intent.arguments).length !== 0) throw new Error('argument_not_allowed');
    const argv = intent.name === 'git_status' ? [...ALLOWED.status] : intent.name === 'git_diff' ? [...ALLOWED.diff] : [...ALLOWED.test];
    const result = await this.command(argv);
    return { ok: result.code === 0, output: result.stdout, error: result.stderr, exitCode: result.code,
      stdoutDigest: digest(result.stdout), stderrDigest: digest(result.stderr), argv, truncated: Boolean(result.timedOut) };
  }
}

/**
 * OS translation lives at this edge.  The coordinator and generic host
 * protocol deal only in logical operations; this adapter is the sole place
 * that maps one of those operations to the existing bounded Gate3 executor.
 */
export class WindowsHostOperationAdapter implements HostOperationAdapter {
  constructor(private readonly executor: Gate3Executor) {}
  async execute(request: LogicalOperationRequest): Promise<LogicalOperationResult> {
    if (!request.operation || !request.operationDigest || !isPlainRecord(request.input)) {
      throw new Error('operation_request_invalid');
    }
    const allowed = new Set(['git_status', 'git_diff', 'run_test', 'read_file', 'replace_once']);
    if (!allowed.has(request.operation)) throw new Error('operation_not_declared');
    return this.executor.execute({ name: request.operation, arguments: request.input });
  }
}

export class AntigravityDriver {
  private token: string | undefined;
  private ownershipGrantId = '';
  private grantEstablished = false;
  private ownershipGrantExpiry = 0;
  private credentialExpiry = 0;
  private claimId = '';
  private epoch = 0;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private renewing?: Promise<void>;
  private renewalActive = false;
  private renewalFailure!: Promise<never>;
  private rejectRenewalFailure!: (reason?: unknown) => void;
  private renewalLoop?: Promise<void>;
  private readonly http: Http;
  private readonly fs: Fs;
  private readonly ownershipClient?: TaskOwnershipHttpClient;
  constructor(private readonly options: DriverOptions) {
    this.http = options.http ?? (async ({ method, path, headers, body }) => {
      const response = await fetch(new URL(path, options.baseUrl), {
        method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    });
    this.fs = options.fs ?? realFs;
    this.ownershipClient = options.ownershipClient;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolveSleep) => {
      const timer = setTimeout(resolveSleep, milliseconds);
      timer.unref();
    }));
  }
  private async renewClaim(): Promise<void> {
    if (!this.claimId) return;
    if (this.renewing) return this.renewing;
    this.renewing = (async () => {
      await this.ensureCredential();
      const renewed = await this.request(`/api/coordination/runtime/claims/${this.claimId}/renew`, 'POST', { epoch: this.epoch });
      if (!Number.isSafeInteger(renewed.epoch)) throw new Error('claim_epoch_invalid');
      this.epoch = renewed.epoch;
    })();
    try { await this.renewing; } finally { this.renewing = undefined; }
  }
  private startRenewalController(): void {
    this.renewalActive = true;
    this.renewalFailure = new Promise<never>((_, reject) => { this.rejectRenewalFailure = reject; });
    void this.renewalFailure.catch(() => undefined);
    this.renewalLoop = (async () => {
      while (this.renewalActive) {
        await this.sleep(90000);
        if (this.renewalActive) {
          try { await this.renewClaim(); } catch (error) {
            this.renewalActive = false;
            this.rejectRenewalFailure(error);
            return;
          }
        }
      }
    })().catch((error) => {
      if (this.renewalActive) { this.renewalActive = false; this.rejectRenewalFailure(error); }
    });
  }
  private async stopRenewalController(): Promise<void> {
    this.renewalActive = false;
    // The injected/default sleep is cancellable at the controller boundary;
    // do not wait for an already pending timer before terminal HTTP calls.
  }
  private guardAfterClaim<T>(operation: Promise<T>): Promise<T> {
    return this.renewalActive ? Promise.race([operation, this.renewalFailure]) as Promise<T> : operation;
  }
  private async request(path: string, method: string, body?: unknown, key = idempotency(path)): Promise<any> {
    if (this.grantEstablished && (this.now() >= this.credentialExpiry - 30000 ||
        this.now() >= this.ownershipGrantExpiry - 30000)) {
      throw new Error('credential_expired_during_granted_run');
    }
    const result = await this.http({ method, path, body, headers: {
      ...(this.token ? { 'x-coordination-token': this.token } : {}),
      ...(this.ownershipGrantId ? { 'x-coordination-ownership-grant': this.ownershipGrantId } : {}),
      'idempotency-key': key,
    }});
    if (result.status < 200 || result.status >= 300) throw new Error(`server_rejected:${(result.body as any)?.error ?? result.status}`);
    return result.body;
  }
  private async ensureCredential(): Promise<void> {
    if (this.token && this.now() < this.credentialExpiry - 30000) return;
    if (this.token) {
      const renewed = await this.request('/api/coordination/credentials/renew', 'POST', undefined, idempotency('renew'));
      this.token = String(renewed.accessToken); this.credentialExpiry = Date.parse(renewed.expiresAt);
    } else {
      if (!this.options.bootstrap) throw new Error('bootstrap_missing');
      const issued = await this.http({ method: 'POST', path: '/api/coordination/credentials/exchange',
        headers: { 'x-coordination-bootstrap': this.options.bootstrap, 'idempotency-key': idempotency('exchange') },
        body: { runtimeId: this.options.runtimeId } });
      if (issued.status < 200 || issued.status >= 300) throw new Error('authentication_failed');
      this.token = String((issued.body as any).accessToken); this.credentialExpiry = Date.parse((issued.body as any).expiresAt);
      // Do not retain the one-time bootstrap beyond the exchange request.
      (this.options as { bootstrap?: string }).bootstrap = undefined;
    }
  }
  async run(): Promise<void> {
    if (this.options.bootstrap === undefined) throw new Error('bootstrap_missing');
    const hostEnv = this.options.env ?? process.env;
    if (Object.prototype.hasOwnProperty.call(hostEnv, 'COORDINATION_LUCA_GEMINI_CODE_TOKEN') ||
        Object.prototype.hasOwnProperty.call(hostEnv, 'COORDINATION_LUCA_GEMINI_TOKEN')) {
      throw new Error('fixed_actor_token_present');
    }
    if (!this.options.ownershipReceiptId) throw new Error('ownership_receipt_missing');
    if (!this.options.ownershipArtifactSha256 || !/^[0-9a-f]{64}$/.test(this.options.ownershipArtifactSha256)) {
      throw new Error('ownership_artifact_digest_invalid');
    }
    const root = await this.fs.realpath(this.options.worktree);
    const artifact = await readApprovedArtifact(this.fs, root);
    if (digest(artifact) !== this.options.ownershipArtifactSha256) throw new Error('ownership_artifact_mismatch');
    const verifyArtifact = async () => {
      const current = await readApprovedArtifact(this.fs, root);
      if (digest(current) !== this.options.ownershipArtifactSha256) throw new Error('ownership_artifact_mismatch');
    };
    const executor = new Gate3Executor(root, this.fs, this.options.spawn ?? spawn,
      { PATH: this.options.env?.PATH ?? process.env.PATH ?? '', NODE_ENV: 'test' }, this.options.platform);
    const started = this.now();
    await this.ensureCredential();
    if (this.credentialExpiry - this.now() < LIMITS.elapsed + 30000) {
      throw new Error('credential_expiry_insufficient_for_granted_run');
    }
    const prove = this.options.proveOwnership
      ?? ((client, taskRef, actor, receiptId) => proveTaskOwnership(client!, taskRef, actor, receiptId));
    const ownershipClient = this.options.proveOwnership ? this.ownershipClient : (this.ownershipClient ?? new TaskOwnershipHttpClient(
      this.options.baseUrl,
      this.token!,
    ));
    await verifyArtifact();
    const ownership = await prove(ownershipClient, '1448', 'luca-gemini', this.options.ownershipReceiptId);
    const proof = parseOwnershipProof(ownership, this.options.ownershipReceiptId, this.options.ownershipArtifactSha256) as Record<string, unknown>;
    const ownershipGrant = proof.grant as Record<string, unknown>;
    this.ownershipGrantId = ownershipGrant.id as string;
    this.ownershipGrantExpiry = Date.parse(ownershipGrant.expiresAt as string);
    if (!Number.isFinite(this.ownershipGrantExpiry) ||
        this.ownershipGrantExpiry - this.now() < LIMITS.elapsed + 30000 ||
        this.credentialExpiry - this.now() < LIMITS.elapsed + 30000) {
      throw new Error('grant_expiry_insufficient_for_granted_run');
    }
    this.grantEstablished = true;
    await verifyArtifact();
    const packet = await this.request('/api/coordination/runtime/packets', 'POST',
      { windowId: this.options.windowId, ...(this.options.assignmentEventId ? { assignmentEventId: this.options.assignmentEventId } : {}) });
    if (
      packet?.envelope?.grantId !== ownershipGrant.id
      || packet.envelope.taskRef !== ownershipGrant.taskRef
      || packet.envelope.artifactSha256 !== ownershipGrant.artifactSha256
      || packet.envelope.contextDigest !== ownershipGrant.contextDigest
      || packet.envelope.startingCommit !== ownershipGrant.startingCommit
      || proof.contextDigest !== ownershipGrant.contextDigest
    ) {
      throw new Error('ownership_packet_binding_mismatch');
    }
    const measured: Array<{ argv: string[]; exitCode: number; stdoutDigest: string; stderrDigest: string; truncated: boolean; stdout: string }> = [];
    const measure = async (argv: string[]) => {
      const value = await executor.measure(argv);
      const record = { argv, exitCode: value.code, stdoutDigest: digest(value.stdout), stderrDigest: digest(value.stderr),
        truncated: Boolean(value.timedOut), stdout: value.stdout };
      measured.push(record);
      if (value.code !== 0 || value.timedOut) throw new Error('evidence_command_failed');
      return record;
    };
    const top = await measure([...ALLOWED.root]);
    if (normalizedWindowsPath(top.stdout.trim()) !== normalizedWindowsPath(root)) throw new Error('worktree_path_mismatch');
    if (digest(normalizedWindowsPath(root)) !== packet.envelope.worktreeRealpathDigest) throw new Error('worktree_digest_mismatch');
    const branch = await measure([...ALLOWED.branch]);
    const head = await measure([...ALLOWED.head]);
    if (branch.stdout.trim() !== packet.envelope.branch) throw new Error('branch_mismatch');
    if (head.stdout.trim() !== packet.envelope.startingCommit) throw new Error('starting_head_mismatch');
    const startingStatus = await measure([...ALLOWED.status]);
    if (startingStatus.stdout.trim()) throw new Error('unexpected_starting_changes');
    const initial = await this.request(`/api/coordination/runtime/packets/${packet.id}/initial-turn`, 'POST');
    let interactionId = initial.interactionIds?.[initial.interactionIds.length - 1];
    if (!interactionId || !initial.receiptId) throw new Error('consumption_not_authorized');
    const receipt = { id: initial.receiptId };
    const claim = await this.request(`/api/coordination/runtime/packets/${packet.id}/claim`, 'POST',
      { receiptId: receipt.id });
    this.claimId = claim.id; this.epoch = claim.epoch;
    this.startRenewalController();
    let turn = 1; let attempts = initial.interactionIds.length;
    if (attempts > LIMITS.attempts) throw new Error('model_call_limit_exceeded');
    let intents = (await this.guardAfterClaim(this.request(`/api/coordination/runtime/claims/${claim.id}/intents`, 'GET'))).intents ?? [];
    while (intents.length) {
      if (++turn > LIMITS.turns || this.now() - started > LIMITS.elapsed) throw new Error('model_call_limit_exceeded');
      // Renewal is deliberately before result evidence is submitted. The
      // server advances the epoch, preventing results from straddling leases.
      await this.ensureCredential();
      const renewed = await this.request(`/api/coordination/runtime/claims/${claim.id}/renew`, 'POST',
        { epoch: this.epoch });
      if (!Number.isSafeInteger(renewed.epoch)) throw new Error('claim_epoch_invalid');
      this.epoch = renewed.epoch;
      const results = [];
      let rejected = false;
      for (const intent of intents) {
        // The server's validated digest covers the complete normalized intent,
        // including provider-neutral candidate metadata.
        const validatedIntentDigest = typeof intent.validatedIntentDigest === 'string'
          ? intent.validatedIntentDigest : digestCanonical(intent);
        let payload: Record<string, unknown>; let outcome: 'succeeded' | 'rejected' = 'succeeded';
        try { payload = await this.guardAfterClaim(executor.execute(intent)); } catch (error) { outcome = 'rejected'; rejected = true; payload = { ok: false, error: safeError(error).message }; }
        results.push({ interactionId, callId: intent.callId, toolName: intent.name, validatedIntentDigest, outcome, payload });
      }
      await this.ensureCredential();
      const next = await this.guardAfterClaim(this.request(`/api/coordination/runtime/claims/${claim.id}/continuation`, 'POST',
        { epoch: this.epoch, turn, toolResults: results }));
      if (rejected) throw new Error('execution_violated');
      // Continuation returns normalized attempts; intent disclosure remains
      // claim-gated and is fetched through the dedicated reveal route.
      if (!Array.isArray(next)) throw new Error('provider_result_invalid');
      attempts += next.length;
      if (attempts > LIMITS.attempts) throw new Error('model_call_limit_exceeded');
      if (next.length && typeof next[next.length - 1].interactionId === 'string') interactionId = next[next.length - 1].interactionId;
      intents = (await this.guardAfterClaim(this.request(`/api/coordination/runtime/claims/${claim.id}/intents`, 'GET'))).intents ?? [];
    }
    const diff = await this.guardAfterClaim(measure([...ALLOWED.diff]));
    const test = await this.guardAfterClaim(measure([...ALLOWED.test]));
    const after = await this.guardAfterClaim(measure([...ALLOWED.status]));
    const paths = after.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim());
    if (paths.length !== 1 || paths[0] !== TARGET) throw new Error('path_not_allowed');
    const patchBytes = Buffer.byteLength(diff.stdout, 'utf8');
    if (patchBytes < 1 || patchBytes > LIMITS.bytes) throw new Error('patch_limit_exceeded');
    const preCompletionBranch = await this.guardAfterClaim(measure([...ALLOWED.branch]));
    const preCompletionHead = await this.guardAfterClaim(measure([...ALLOWED.head]));
    if (preCompletionBranch.stdout.trim() !== packet.envelope.branch || preCompletionHead.stdout.trim() !== packet.envelope.startingCommit) {
      throw new Error('starting_state_changed');
    }
    const local = { startingCommit: packet.envelope.startingCommit, resultingHead: preCompletionHead.stdout.trim(),
      changedPaths: paths, patchDigest: digest(diff.stdout), commandResults: measured.map(({ stdout, ...record }) => record),
      elapsedMs: this.now() - started, modelTurns: turn, apiAttempts: attempts };
    await verifyArtifact();
    await this.renewClaim();
    await this.stopRenewalController();
    const execution = await this.request(`/api/coordination/runtime/claims/${claim.id}/execute`, 'POST', { attestedLocalState: local });
    await verifyArtifact();
    const finalHead = await this.guardAfterClaim(measure([...ALLOWED.head]));
    if (finalHead.stdout.trim() !== packet.envelope.startingCommit) throw new Error('starting_state_changed');
    await verifyArtifact();
    const completion = await this.request(`/api/coordination/runtime/executions/${execution.id}/complete`, 'POST');
    if (this.options.receiptFile) await this.fs.writeFile(this.options.receiptFile, JSON.stringify({
      packetId: packet.id, receiptId: receipt.id, claimId: claim.id, executionId: execution.id, completionId: completion.id,
      packetDigest: packet.digest, patchDigest: local.patchDigest,
    }) + '\n');
  }
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
export async function main(): Promise<void> {
  const env = process.env;
  const bootstrap = env.COORDINATION_RUNTIME_BOOTSTRAP_TOKEN;
  // The protected interface is a one-shot handoff. Remove its process
  // environment entry before constructing any other request or child env.
  delete env.COORDINATION_RUNTIME_BOOTSTRAP_TOKEN;
  const driver = new AntigravityDriver({
    baseUrl: option('api-base') ?? env.COORDINATION_API_BASE_URL ?? '',
    runtimeId: option('runtime-id') ?? env.COORDINATION_RUNTIME_ID ?? '',
    worktree: option('worktree') ?? env.COORDINATION_WORKTREE ?? '',
    windowId: option('window-id') ?? env.COORDINATION_WINDOW_ID ?? '',
    assignmentEventId: option('assignment-event-id') ?? env.COORDINATION_ASSIGNMENT_EVENT_ID,
    ownershipReceiptId: option('ownership-receipt-id') ?? env.COORDINATION_OWNERSHIP_RECEIPT_ID,
    ownershipArtifactSha256: option('ownership-artifact-sha256') ?? env.COORDINATION_OWNERSHIP_ARTIFACT_SHA256,
    bootstrap,
    receiptFile: option('receipt-file') ?? env.COORDINATION_RECEIPT_FILE,
  });
  await driver.run();
}
if (process.argv[1]?.endsWith('coordination-runtime-antigravity.ts')) main().catch((error) => {
  console.error(safeError(error).message); process.exitCode = 1;
});