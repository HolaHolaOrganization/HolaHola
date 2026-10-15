import { createHash, randomUUID } from 'node:crypto';
import type { RawArgumentsEvidence } from './coordination-provider-adapters/types';

export type RuntimeActor =
  | 'luca-gemini'
  | 'luca-replit'
  | 'luca-claude-code'
  | 'alden'
  | 'daniela';

export type NormalizedOutcome =
  | 'consumed'
  | 'safety_blocked'
  | 'refused'
  | 'context_limit'
  | 'interrupted'
  | 'empty_response'
  | 'malformed_function_call'
  | 'unsupported_provider_outcome'
  | 'retryable_provider_error'
  | 'terminal_provider_error';

export type RuntimePrincipal = {
  actor: RuntimeActor;
  runtimeRegistrationId: string;
  credentialId: string;
  profileId: string;
  capabilities: readonly string[];
  credentialExpiresAt: number;
  runtimeEnabled: boolean;
  revoked: boolean;
  // True only for a registration explicitly designated via
  // designateStandingCoordinationVerifier (operator action, never per-task
  // provisioning). verify() below rejects any verifier lacking this flag.
  standingVerifier: boolean;
};
export type CodingRuntimeProfile = {
  id: string;
  runtimeRegistrationId: string;
  actor: RuntimeActor;
  capabilities: string[];
  provider: string;
  model: string;
  adapterVersion: string;
  status: 'active' | 'superseded' | 'closed';
  startingCommit?: string;
  timeoutMs?: 600000;
  repositoryLabel?: string;
  branch?: string;
  worktreeLabel?: string;
  worktreeRealpathDigest?: string;
};
export type AttestedLocalState = {
  startingCommit: string;
  resultingHead: string;
  changedPaths: string[];
  patchDigest: string | null;
  commandResults: Array<{ argv: string[]; exitCode: number; stdoutDigest: string; stderrDigest: string; truncated: boolean }>;
  elapsedMs: number;
  modelTurns: number;
  apiAttempts: number;
};
export type DerivedToolEvidence = Array<{
  priorInteractionId: string;
  normalizedResponseDigest: string;
  callIds: string[];
  results: unknown[];
}>;
export type ToolResultOutcome = 'succeeded' | 'rejected';
export type ToolResultEolMetadata = {
  source: 'none' | 'lf' | 'crlf';
  oldText: 'none' | 'lf' | 'crlf';
  newText: 'none' | 'lf' | 'crlf';
  canonicalized: boolean;
  output: 'none' | 'lf' | 'crlf';
};
/** Canonical wire payload shared by the HTTP route, service and portable driver. */
export type NormalizedToolResultPayload = {
  ok: boolean;
  output?: string;
  error?: string;
  exitCode?: number;
  stdoutDigest?: string;
  stderrDigest?: string;
  changedPaths?: string[];
  argv?: string[];
  truncated?: boolean;
  bytes?: number;
  eol?: ToolResultEolMetadata;
};
export type NormalizedToolResult = {
  interactionId: string;
  callId: string;
  toolName: string;
  validatedIntentDigest: string;
  outcome: ToolResultOutcome;
  payload: NormalizedToolResultPayload;
};
export type ToolResultRecord = {
  id: string; claimId: string; claimEpoch: number; interactionId: string; callId: string;
  claimEventId: string;
  runtimeRegistrationId: string; profileId: string; credentialId: string;
  validatedIntentDigest: string; toolName: string; outcome: ToolResultOutcome;
  canonicalPayload: NormalizedToolResultPayload; resultDigest: string; createdAt: number;
};

export class RuntimeProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RuntimeProtocolError';
  }
}

function fail(code: string, message: string): never {
  throw new RuntimeProtocolError(code, message);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function canonicalize(value: unknown, active: Set<object>): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    if (hasUnpairedSurrogate(value)) fail('invalid_json', 'Unpaired Unicode surrogate');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid_json', 'Non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') fail('invalid_json', 'Unsupported JSON value');
  if (active.has(value)) fail('invalid_json', 'Cyclic JSON value');

  active.add(value);
  let result: string;
  if (Array.isArray(value)) {
    result = `[${value.map((item) => canonicalize(item, active)).join(',')}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail('invalid_json', 'Only plain objects are supported');
    }
    const object = value as Record<string, unknown>;
    result = `{${Object.keys(object)
      .sort()
      .map((key) => `${canonicalize(key, active)}:${canonicalize(object[key], active)}`)
      .join(',')}}`;
  }
  active.delete(value);
  return result;
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set());
}

export function digestCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export const COORDINATION_GATE3_FIXED_TARGET = 'server/scripts/test-coordination-runtime.test.ts';
const MAX_NORMALIZED_EVIDENCE_BYTES = 128_000;
const MAX_NORMALIZED_ARGUMENT_BYTES = 40_960;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

export function isFixedTargetReadArguments(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 0 || (
    keys.length === 1
    && keys[0] === 'path'
    && value.path === COORDINATION_GATE3_FIXED_TARGET
  );
}

/** The single policy boundary used before an interaction can expose a call. */
export function validateToolIntent(intent: { name: string; arguments: unknown; callId: string }): { name: string; operation: string; digest: string } {
  if (!isPlainRecord(intent.arguments)) {
    fail('malformed_function_call', 'Tool intent violates execution policy');
  }
  const keys = Object.keys(intent.arguments).sort();
  const zeroArgument = intent.name === 'git_status' || intent.name === 'git_diff' ||
    intent.name === 'run_test';
  const valid = (zeroArgument && keys.length === 0) ||
    (intent.name === 'read_file' && isFixedTargetReadArguments(intent.arguments)) ||
    (intent.name === 'replace_once' && keys.join(',') === 'newText,oldText' &&
      typeof intent.arguments.oldText === 'string' &&
      typeof intent.arguments.newText === 'string' &&
      intent.arguments.oldText.length > 0 &&
      intent.arguments.oldText !== intent.arguments.newText &&
      Buffer.byteLength(intent.arguments.oldText, 'utf8') +
        Buffer.byteLength(intent.arguments.newText, 'utf8') <= 40960);
  if (!valid || !intent.callId) fail('malformed_function_call', 'Tool intent violates execution policy');
  return {
    name: intent.name,
    operation: intent.name === 'git_diff' || intent.name === 'read_file' ? 'fixed-target' :
      intent.name === 'run_test' ? 'fixed-test' :
        intent.name === 'replace_once' ? 'fixed-target-replace-once' : intent.name,
    digest: digestCanonical(intent),
  };
}

function validateToolResultPayload(toolName: string, outcome: ToolResultOutcome, payload: unknown): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('invalid_request', 'Tool result payload must be an object');
  }
  const value = payload as Record<string, unknown>;
  const keys = Object.keys(value);
  const allowed = new Set(['ok', 'output', 'error', 'exitCode', 'stdoutDigest', 'stderrDigest', 'changedPaths', 'argv', 'truncated', 'bytes', 'eol']);
  if (keys.some((key) => !allowed.has(key)) || typeof value.ok !== 'boolean') {
    fail('invalid_request', 'Tool result payload does not match the normalized schema');
  }
  if (outcome === 'succeeded' && value.ok !== true) fail('invalid_request', 'Successful result must have ok=true');
  if (outcome === 'rejected' && (value.ok !== false || typeof value.error !== 'string')) {
    fail('invalid_request', 'Rejected result must include an error');
  }
  if (toolName === 'run_test' && value.ok === true && typeof value.exitCode !== 'number') {
    fail('invalid_request', 'run_test result requires exitCode');
  }
  if (value.argv !== undefined && (!Array.isArray(value.argv) || value.argv.some((part) => typeof part !== 'string'))) {
    fail('invalid_request', 'argv is invalid');
  }
  if (value.truncated !== undefined && typeof value.truncated !== 'boolean') fail('invalid_request', 'truncated is invalid');
  if (value.bytes !== undefined && (typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 0)) fail('invalid_request', 'bytes is invalid');
  if (value.eol !== undefined) {
    if (toolName !== 'replace_once' || outcome !== 'succeeded' || !isPlainRecord(value.eol)) {
      fail('invalid_request', 'eol metadata is not allowed');
    }
    const eol = value.eol;
    const eolKeys = Object.keys(eol).sort();
    const styles = new Set(['none', 'lf', 'crlf']);
    if (
      eolKeys.join(',') !== 'canonicalized,newText,oldText,output,source'
      || !styles.has(eol.source as string)
      || !styles.has(eol.oldText as string)
      || !styles.has(eol.newText as string)
      || !styles.has(eol.output as string)
      || typeof eol.canonicalized !== 'boolean'
    ) {
      fail('invalid_request', 'eol metadata is invalid');
    }
  } else if (toolName === 'replace_once' && outcome === 'succeeded') {
    fail('invalid_request', 'replace_once result requires eol metadata');
  }
}

function deepClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as object)) deepFreeze(child);
  }
  return value;
}

function immutable<T>(value: T): T {
  return deepFreeze(deepClone(value));
}

export type InboxItem = {
  id: string;
  eventId: string;
  threadId: string;
  taskId: string;
  sequence: number;
  payload: { content: Record<string, unknown> };
};

export type Assignment = {
  assignmentEventId: string;
  assignmentAuthor: RuntimeActor;
  taskId: string;
  threadId: string;
  expectedSequence: number;
};

export type ExecutionEnvelope = {
  worktreeLabel: string;
  worktreePath: string;
  argv: readonly string[];
  patchDigest: string | null;
  repositoryLabel?: 'HolaHola';
  worktreeRealpathDigest?: string;
  branch?: string;
  targetPath?: 'server/scripts/test-coordination-runtime.test.ts';
  maxChangedFiles?: 1;
  maxPatchBytes?: 40960;
  maxElapsedMs?: 600000;
  maxModelTurns?: 4;
  maxApiAttempts?: 8;
  startingCommit?: string;
  timeoutMs?: 600000;
  grantId?: string;
  taskRef?: string;
  artifactSha256?: string;
  contextDigest?: string;
};
export type Gate3ExecutionEnvelope = ExecutionEnvelope & {
  repositoryLabel: 'HolaHola';
  worktreeRealpathDigest: string;
  branch: string;
  startingCommit: string;
  targetPath: 'server/scripts/test-coordination-runtime.test.ts';
  maxChangedFiles: 1;
  maxPatchBytes: 40960;
  maxElapsedMs: 600000;
  maxModelTurns: 4;
  maxApiAttempts: 8;
};

export type InboxWindow = {
  id: string;
  threadId: string;
  afterExclusive: number;
  throughInclusive: number;
  boundaryToken: string;
  orderedItemIds: string[];
  boundaryDigest: string;
};

export type InheritancePacket = {
  id: string;
  version: number;
  actor: 'luca-gemini';
  runtimeRegistrationId: string;
  profileId: string;
  createdAt: number;
  supersedesClaimId: string | null;
  windowId: string;
  windowDigest: string;
  orderedInboxItemIds: string[];
  orderedEventIds: string[];
  orderedThreadIds: string[];
  assignment: Assignment;
  inherited: InboxItem['payload'][];
  envelope: ExecutionEnvelope;
  digest: string;
};

export type ModelInteraction = {
  id: string;
  packetId: string;
  principal: Pick<RuntimePrincipal, 'actor' | 'runtimeRegistrationId' | 'credentialId' | 'profileId'>;
  turn: number;
  attempt: number;
  requestDigest: string;
  responseDigest?: string;
  outcome: NormalizedOutcome;
  retryLineage: string | null;
  normalizedEvidence?: NormalizedInteractionEvidence;
  createdAt: number;
};

export type NormalizedInteractionEvidence = {
  textParts: string[];
  intents: Array<{
    name: string;
    arguments: unknown;
    callId: string;
    candidateIndex: 0;
    /** Optional raw evidence is tolerated for pre-Milestone-6 replays. */
    rawArguments?: RawArgumentsEvidence;
    operation?: string;
    executionEligible: boolean;
  }>;
  additionalCandidateHashes: string[];
  providerDetails: Record<string, unknown>;
  usage?: Record<string, unknown>;
  normalizedResponseDigest: string;
  validatedIntents?: Array<{ name: string; operation: string; digest: string }>;
  toolResults?: unknown[];
};

export type OutcomeReceipt = {
  id: string;
  packetId: string;
  packetDigest: string;
  interactionId: string;
  runtimeRegistrationId: string;
  profileId: string;
  outcome: NormalizedOutcome;
  createdAt: number;
};

export type ExecutionClaim = {
  id: string;
  threadId: string;
  packetId: string;
  runtimeRegistrationId: string;
  profileId: string;
  credentialId: string;
  priorClaimId: string | null;
  epoch: number;
  expiresAt: number;
  status: 'active' | 'expired' | 'completed' | 'violated';
  terminalAt: number | null;
};

export type ClaimEvent = {
  id: string;
  claimId: string;
  epoch: number;
  kind: 'acquired' | 'renewed' | 'expired' | 'violated';
  reason: string | null;
  priorClaimId: string | null;
  occurredAt: number;
};

export type ExecutionRecord = {
  id: string;
  claimId: string;
  claimEpoch: number;
  runtimeRegistrationId: string;
  profileId: string;
  credentialId: string;
  envelope: ExecutionEnvelope;
  derivedToolEvidence: DerivedToolEvidence;
  attestedLocalState: AttestedLocalState;
  executionDigest: string;
};

export type CompletionRecord = {
  id: string;
  executionId: string;
  claimId: string;
  claimEpoch: number;
  evidenceDigest: string;
};

export type VerificationDecision = {
  id: string;
  completionId: string;
  verifierActor: 'luca-replit' | 'luca-claude-code';
  verifierRuntimeRegistrationId: string;
  evidenceDigest: string;
  patchDigest: string | null;
  decision: 'approved' | 'rejected';
  rationale?: string;
  rerunEvidence?: unknown;
};

export type IdempotencyRecord = { payloadDigest: string; resultKind: string; resultId: string };
/**
 * Persistence port for the coordination protocol.  Implementations must make
 * transaction the unit of atomicity; evidence writers are append-oriented,
 * while claims are the sole mutable protocol entity.
 */
export type CoordinationRuntimeRepository = {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  withAttemptLock<T>(key: string, operation: () => Promise<T>): Promise<T>;
  addInboxItem(item: InboxItem): Promise<InboxItem>;
  freezeInboxWindow(threadId: string, afterExclusive: number, throughInclusive: number, boundaryToken: string): Promise<InboxWindow>;
  validateWindow(windowId: string): Promise<{ window: InboxWindow; items: InboxItem[] }>;
  getThreadSequence(threadId: string): Promise<number | undefined>;
  getPacket(id: string): Promise<InheritancePacket | undefined>;
  getInteraction(id: string): Promise<ModelInteraction | undefined>;
  getReceipt(id: string): Promise<OutcomeReceipt | undefined>;
  getClaim(id: string): Promise<ExecutionClaim | undefined>;
  getExecution(id: string): Promise<ExecutionRecord | undefined>;
  executionForClaim(claimId: string): Promise<ExecutionRecord | undefined>;
  getCompletion(id: string): Promise<CompletionRecord | undefined>;
  getVerification(id: string): Promise<VerificationDecision | undefined>;
  getToolResult(id: string): Promise<ToolResultRecord | undefined>;
  toolResultsForClaim(claimId: string, claimEpoch: number): Promise<ToolResultRecord[]>;
  toolResultsForClaimAllEpochs(claimId: string): Promise<ToolResultRecord[]>;
  getResult(kind: string, id: string): Promise<unknown>;
  idempotency(scope: string, key: string): Promise<IdempotencyRecord | undefined>;
  saveIdempotency(scope: string, key: string, record: IdempotencyRecord): Promise<void>;
  savePacket(value: InheritancePacket): Promise<void>;
  saveInteraction(value: ModelInteraction): Promise<void>;
  saveReceipt(value: OutcomeReceipt): Promise<void>;
  saveClaim(value: ExecutionClaim): Promise<void>;
  addClaimEvent(value: ClaimEvent): Promise<void>;
  saveExecution(value: ExecutionRecord): Promise<void>;
  saveCompletion(value: CompletionRecord): Promise<void>;
  saveVerification(value: VerificationDecision): Promise<void>;
  saveToolResult(value: ToolResultRecord): Promise<void>;
  activeClaimForThread(threadId: string): Promise<ExecutionClaim | undefined>;
  interactionForSlot(packetId: string, turn: number, attempt: number): Promise<ModelInteraction | undefined>;
  interactionsForPacket(packetId: string): Promise<ModelInteraction[]>;
  interactionsForAssignment(packet: InheritancePacket): Promise<ModelInteraction[]>;
  interactionForAssignmentSlot(packet: InheritancePacket, turn: number, attempt: number): Promise<ModelInteraction | undefined>;
  maxClaimEpoch(threadId: string): Promise<number>;
  packetForAssignmentVersion(assignmentEventId: string, version: number): Promise<InheritancePacket | undefined>;
  claimsForPacket(packetId: string): Promise<ExecutionClaim[]>;
  latestClaimForThread(threadId: string): Promise<ExecutionClaim | undefined>;
  claimEventForEpoch(claimId: string, epoch: number): Promise<ClaimEvent | undefined>;
  getActiveProfile(runtimeRegistrationId: string): Promise<CodingRuntimeProfile | undefined>;
};
type RepositoryState = {
  inbox: Map<string, InboxItem>;
  threadSequences: Map<string, number>;
  windows: Map<string, InboxWindow>;
  packets: Map<string, InheritancePacket>;
  interactions: Map<string, ModelInteraction>;
  receipts: Map<string, OutcomeReceipt>;
  claims: Map<string, ExecutionClaim>;
  claimEvents: ClaimEvent[];
  executions: Map<string, ExecutionRecord>;
  completions: Map<string, CompletionRecord>;
  verifications: Map<string, VerificationDecision>;
  toolResults: Map<string, ToolResultRecord>;
  idempotency: Map<string, IdempotencyRecord>;
  profiles: Map<string, CodingRuntimeProfile>;
};

function emptyState(): RepositoryState {
  return {
    inbox: new Map(),
    threadSequences: new Map(),
    windows: new Map(),
    packets: new Map(),
    interactions: new Map(),
    receipts: new Map(),
    claims: new Map(),
    claimEvents: [],
    executions: new Map(),
    completions: new Map(),
    verifications: new Map(),
    toolResults: new Map(),
    idempotency: new Map(),
    profiles: new Map(),
  };
}

function cloneMap<T>(source: Map<string, T>): Map<string, T> {
  return new Map([...source].map(([key, value]) => [key, immutable(value)]));
}

function cloneState(source: RepositoryState): RepositoryState {
  return {
    inbox: cloneMap(source.inbox),
    threadSequences: new Map(source.threadSequences),
    windows: cloneMap(source.windows),
    packets: cloneMap(source.packets),
    interactions: cloneMap(source.interactions),
    receipts: cloneMap(source.receipts),
    claims: cloneMap(source.claims),
    claimEvents: source.claimEvents.map(immutable),
    executions: cloneMap(source.executions),
    completions: cloneMap(source.completions),
    verifications: cloneMap(source.verifications),
    toolResults: cloneMap(source.toolResults),
    idempotency: cloneMap(source.idempotency),
    profiles: cloneMap(source.profiles),
  };
}

export class InMemoryCoordinationRepository implements CoordinationRuntimeRepository {
  private state = emptyState();
  private inTransaction = false;
  private readonly attemptQueues = new Map<string, Promise<void>>();

  async withAttemptLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.attemptQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chain = prior.then(() => current);
    this.attemptQueues.set(key, chain);
    await prior;
    try { return await operation(); }
    finally {
      release();
      if (this.attemptQueues.get(key) === chain) this.attemptQueues.delete(key);
    }
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    if (this.inTransaction) fail('transaction_reentrant', 'Nested transaction');
    const prior = this.state;
    this.state = cloneState(prior);
    this.inTransaction = true;
    try {
      const result = await operation();
      this.inTransaction = false;
      return result;
    } catch (error) {
      this.state = prior;
      this.inTransaction = false;
      throw error;
    }
  }

  async addInboxItem(item: InboxItem): Promise<InboxItem> {
    return this.transaction(async () => {
      if (this.state.inbox.has(item.id)) fail('duplicate_inbox_id', 'Inbox ID already exists');
      const prior = this.state.threadSequences.get(item.threadId) ?? 0;
      if (!Number.isInteger(item.sequence) || item.sequence <= prior) {
        fail('inbox_sequence_conflict', 'Thread sequence must increase');
      }
      const stored = immutable(item);
      this.state.inbox.set(item.id, stored);
      this.state.threadSequences.set(item.threadId, item.sequence);
      return immutable(stored);
    });
  }

  async freezeInboxWindow(
    threadId: string,
    afterExclusive: number,
    throughInclusive: number,
    boundaryToken: string,
  ): Promise<InboxWindow> {
    return this.transaction(async () => {
      if (!boundaryToken || throughInclusive <= afterExclusive) {
        fail('inbox_window_invalid', 'Window boundary is invalid');
      }
      if (this.state.threadSequences.get(threadId) !== throughInclusive) {
        fail('inbox_window_unstable', 'Through boundary is not current');
      }
      const items = this.inboxItemsForWindow(threadId, afterExclusive, throughInclusive);
      if (items.length === 0) fail('inbox_window_incomplete', 'Window is empty');
      const base = {
        threadId,
        afterExclusive,
        throughInclusive,
        boundaryToken,
        orderedItemIds: items.map((item) => item.id),
        itemDigests: items.map((item) => digestCanonical(item)),
      };
      const window: InboxWindow = {
        id: `window-${digestCanonical(base)}`,
        threadId,
        afterExclusive,
        throughInclusive,
        boundaryToken,
        orderedItemIds: base.orderedItemIds,
        boundaryDigest: digestCanonical(base),
      };
      this.state.windows.set(window.id, immutable(window));
      return immutable(window);
    });
  }

  private inboxItemsForWindow(threadId: string, afterExclusive: number, throughInclusive: number): InboxItem[] {
    return [...this.state.inbox.values()]
      .filter(
        (item) =>
          item.threadId === threadId &&
          item.sequence > afterExclusive &&
          item.sequence <= throughInclusive,
      )
      .sort((left, right) => left.sequence - right.sequence)
      .map(immutable);
  }

  async validateWindow(windowId: string): Promise<{ window: InboxWindow; items: InboxItem[] }> {
    const window = this.state.windows.get(windowId);
    if (!window) fail('inbox_window_incomplete', 'Frozen window is required');
    const items = this.inboxItemsForWindow(
      window.threadId,
      window.afterExclusive,
      window.throughInclusive,
    );
    const base = {
      threadId: window.threadId,
      afterExclusive: window.afterExclusive,
      throughInclusive: window.throughInclusive,
      boundaryToken: window.boundaryToken,
      orderedItemIds: items.map((item) => item.id),
      itemDigests: items.map((item) => digestCanonical(item)),
    };
    if (
      this.state.threadSequences.get(window.threadId) !== window.throughInclusive ||
      canonicalJson(window.orderedItemIds) !== canonicalJson(base.orderedItemIds) ||
      window.boundaryDigest !== digestCanonical(base)
    ) {
      fail('inbox_window_unstable', 'Frozen window no longer matches source records');
    }
    return { window: immutable(window), items };
  }

  async getThreadSequence(threadId: string): Promise<number | undefined> {
    return this.state.threadSequences.get(threadId);
  }

  async getPacket(id: string): Promise<InheritancePacket | undefined> {
    const value = this.state.packets.get(id);
    return value && immutable(value);
  }

  async getInteraction(id: string): Promise<ModelInteraction | undefined> {
    const value = this.state.interactions.get(id);
    return value && immutable(value);
  }

  async getReceipt(id: string): Promise<OutcomeReceipt | undefined> {
    const value = this.state.receipts.get(id);
    return value && immutable(value);
  }

  async getClaim(id: string): Promise<ExecutionClaim | undefined> {
    const value = this.state.claims.get(id);
    return value && immutable(value);
  }

  async getExecution(id: string): Promise<ExecutionRecord | undefined> {
    const value = this.state.executions.get(id);
    return value && immutable(value);
  }
  async executionForClaim(claimId: string): Promise<ExecutionRecord | undefined> {
    const value = [...this.state.executions.values()].find((execution) => execution.claimId === claimId);
    return value && immutable(value);
  }

  async getCompletion(id: string): Promise<CompletionRecord | undefined> {
    const value = this.state.completions.get(id);
    return value && immutable(value);
  }

  async getVerification(id: string): Promise<VerificationDecision | undefined> {
    const value = this.state.verifications.get(id);
    return value && immutable(value);
  }
  async getToolResult(id: string) { const value = this.state.toolResults.get(id); return value && immutable(value); }
  async toolResultsForClaim(claimId: string, claimEpoch: number) {
    return [...this.state.toolResults.values()].filter((r) => r.claimId === claimId && r.claimEpoch === claimEpoch).map(immutable);
  }
  async toolResultsForClaimAllEpochs(claimId: string) {
    return [...this.state.toolResults.values()].filter((r) => r.claimId === claimId).map(immutable);
  }

  async getResult(kind: string, id: string): Promise<unknown> {
    const collections: Record<string, Map<string, unknown>> = {
      packet: this.state.packets,
      interaction: this.state.interactions,
      receipt: this.state.receipts,
      claim: this.state.claims,
      renewal: this.state.claims,
      execution: this.state.executions,
      completion: this.state.completions,
      verification: this.state.verifications,
      toolResult: this.state.toolResults,
    };
    const value = collections[kind]?.get(id);
    return value && immutable(value);
  }

  async idempotency(scope: string, key: string): Promise<IdempotencyRecord | undefined> {
    const value = this.state.idempotency.get(digestCanonical([scope, key]));
    return value && immutable(value);
  }

  async saveIdempotency(scope: string, key: string, record: IdempotencyRecord): Promise<void> {
    this.state.idempotency.set(digestCanonical([scope, key]), immutable(record));
  }

  async savePacket(value: InheritancePacket): Promise<void> { this.state.packets.set(value.id, immutable(value)); }
  async saveInteraction(value: ModelInteraction): Promise<void> { this.state.interactions.set(value.id, immutable(value)); }
  async saveReceipt(value: OutcomeReceipt): Promise<void> { this.state.receipts.set(value.id, immutable(value)); }
  async saveExecution(value: ExecutionRecord): Promise<void> { this.state.executions.set(value.id, immutable(value)); }
  async saveCompletion(value: CompletionRecord): Promise<void> { this.state.completions.set(value.id, immutable(value)); }
  async saveVerification(value: VerificationDecision): Promise<void> { this.state.verifications.set(value.id, immutable(value)); }
  async saveToolResult(value: ToolResultRecord): Promise<void> {
    const duplicate = [...this.state.toolResults.values()].find((r) =>
      r.claimId === value.claimId && r.claimEpoch === value.claimEpoch &&
      r.interactionId === value.interactionId && r.callId === value.callId);
    if (duplicate && digestCanonical(duplicate) !== digestCanonical(value)) fail('tool_result_conflict', 'Tool result is immutable');
    if (!duplicate) this.state.toolResults.set(value.id, immutable(value));
  }

  async saveClaim(value: ExecutionClaim): Promise<void> {
    if (
      value.status === 'active' &&
      [...this.state.claims.values()].some(
        (claim) =>
          claim.id !== value.id &&
          claim.threadId === value.threadId &&
          claim.status === 'active',
      )
    ) {
      fail('claim_active_conflict', 'Thread already has an active claim');
    }
    this.state.claims.set(value.id, immutable(value));
  }

  async addClaimEvent(value: ClaimEvent): Promise<void> {
    this.state.claimEvents.push(immutable(value));
  }

  async activeClaimForThread(threadId: string): Promise<ExecutionClaim | undefined> {
    const value = [...this.state.claims.values()].find(
      (claim) => claim.threadId === threadId && claim.status === 'active',
    );
    return value && immutable(value);
  }

  async interactionForSlot(packetId: string, turn: number, attempt: number): Promise<ModelInteraction | undefined> {
    const value = [...this.state.interactions.values()].find(
      (interaction) =>
        interaction.packetId === packetId &&
        interaction.turn === turn &&
        interaction.attempt === attempt,
    );
    return value && immutable(value);
  }

  async interactionsForPacket(packetId: string): Promise<ModelInteraction[]> {
    return [...this.state.interactions.values()]
      .filter((interaction) => interaction.packetId === packetId)
      .map(immutable);
  }

  async interactionsForAssignment(packet: InheritancePacket): Promise<ModelInteraction[]> {
    return [...this.state.interactions.values()]
      .filter((interaction) => {
        const source = this.state.packets.get(interaction.packetId);
        return source?.assignment.taskId === packet.assignment.taskId &&
          source.assignment.assignmentEventId === packet.assignment.assignmentEventId;
      })
      .map(immutable);
  }

  async interactionForAssignmentSlot(
    packet: InheritancePacket,
    turn: number,
    attempt: number,
  ): Promise<ModelInteraction | undefined> {
    return (await this.interactionsForAssignment(packet)).find(
      (interaction) => interaction.turn === turn && interaction.attempt === attempt,
    );
  }

  async maxClaimEpoch(threadId: string): Promise<number> {
    return Math.max(
      0,
      ...[...this.state.claims.values()]
        .filter((claim) => claim.threadId === threadId)
        .map((claim) => claim.epoch),
    );
  }

  async packetForAssignmentVersion(
    assignmentEventId: string,
    version: number,
  ): Promise<InheritancePacket | undefined> {
    const value = [...this.state.packets.values()].find(
      (packet) =>
        packet.assignment.assignmentEventId === assignmentEventId &&
        packet.version === version,
    );
    return value && immutable(value);
  }

  async claimsForPacket(packetId: string): Promise<ExecutionClaim[]> {
    return [...this.state.claims.values()]
      .filter((claim) => claim.packetId === packetId)
      .map(immutable);
  }

  async latestClaimForThread(threadId: string): Promise<ExecutionClaim | undefined> {
    const value = [...this.state.claims.values()]
      .filter((claim) => claim.threadId === threadId)
      .sort((left, right) => right.epoch - left.epoch)[0];
    return value && immutable(value);
  }
  async claimEventForEpoch(claimId: string, epoch: number): Promise<ClaimEvent | undefined> {
    const event = this.state.claimEvents.find((candidate) => candidate.claimId === claimId && candidate.epoch === epoch &&
      (candidate.kind === 'acquired' || candidate.kind === 'renewed'));
    return event && immutable(event);
  }

  async getActiveProfile(runtimeRegistrationId: string): Promise<CodingRuntimeProfile | undefined> {
    const profile = [...this.state.profiles.values()].find(
      (candidate) => candidate.runtimeRegistrationId === runtimeRegistrationId && candidate.status === 'active',
    );
    return profile && immutable(profile);
  }

  async saveProfile(profile: CodingRuntimeProfile): Promise<void> {
    this.state.profiles.set(profile.id, immutable(profile));
  }

  snapshots() {
    return immutable({
      packets: [...this.state.packets.values()],
      interactions: [...this.state.interactions.values()],
      receipts: [...this.state.receipts.values()],
      claims: [...this.state.claims.values()],
      claimEvents: this.state.claimEvents,
      executions: [...this.state.executions.values()],
      completions: [...this.state.completions.values()],
      verifications: [...this.state.verifications.values()],
      toolResults: [...this.state.toolResults.values()],
    });
  }
}

type MutationResult<T> = { value: T } | { error: RuntimeProtocolError };

export class CoordinationRuntimeService {
  constructor(
    private readonly repository: CoordinationRuntimeRepository,
    private readonly now: () => number = () => Date.now(),
    private readonly newId: () => string = () => randomUUID(),
    configuredEnvelope: ExecutionEnvelope = {
      worktreeLabel: 'gate-1',
      worktreePath: '/work',
      argv: ['true'],
      patchDigest: null,
    },
    private readonly maxClaimTtlMs = 300_000,
  ) {
    this.envelope = immutable(configuredEnvelope);
  }

  private readonly envelope: ExecutionEnvelope;

  private authorize(
    principal: RuntimePrincipal,
    actor: RuntimeActor,
    capability: string,
  ): void {
    if (principal.actor !== actor) fail('actor_mismatch', 'Principal actor does not match');
    if (!principal.capabilities.includes(capability)) {
      fail('capability_required', `Capability ${capability} is required`);
    }
    if (!principal.runtimeEnabled) fail('runtime_disabled', 'Runtime is disabled');
    if (principal.revoked) fail('runtime_revoked', 'Runtime is revoked');
    if (
      !Number.isFinite(principal.credentialExpiresAt) ||
      principal.credentialExpiresAt <= this.now()
    ) {
      fail('credential_expired', 'Runtime credential has expired');
    }
  }

  private async mutate<T extends { id: string }>(
    scope: string,
    idempotencyKey: string,
    payload: unknown,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.repository.transaction(async () => {
      const payloadDigest = digestCanonical(payload);
      const prior = await this.repository.idempotency(scope, idempotencyKey);
      if (prior) {
        if (prior.payloadDigest !== payloadDigest) {
          fail('idempotency_payload_mismatch', 'Changed payload reused idempotency key');
        }
        const result = await this.repository.getResult(prior.resultKind, prior.resultId);
        if (!result) fail('repository_corrupt', 'Idempotency result is missing');
        return result as T;
      }
      const result = await operation();
      await this.repository.saveIdempotency(scope, idempotencyKey, {
        payloadDigest,
        resultKind: scope,
        resultId: result.id,
      });
      return immutable(result);
    });
  }

  async createPacket(
    principal: RuntimePrincipal,
    windowId: string,
    assignment: Assignment,
    idempotencyKey: string,
    version = 1,
    supersedesClaimId: string | null = null,
    envelopeOverride?: ExecutionEnvelope,
  ): Promise<InheritancePacket> {
    this.authorize(principal, 'luca-gemini', 'execute');
    if (!Number.isInteger(version) || version < 1) {
      fail('packet_version_invalid', 'Packet version must be a positive integer');
    }
    return this.mutate('packet', idempotencyKey, {
      runtimeRegistrationId: principal.runtimeRegistrationId,
      profileId: principal.profileId,
      windowId,
      assignment,
      version,
      supersedesClaimId,
    }, async () => {
      const { window, items } = await this.repository.validateWindow(windowId);
      if (
        await this.repository.packetForAssignmentVersion(
          assignment.assignmentEventId,
          version,
        )
      ) {
        fail('packet_version_conflict', 'Assignment packet version already exists');
      }
      const latestClaim = await this.repository.latestClaimForThread(assignment.threadId);
      if (version === 1 && (supersedesClaimId !== null || latestClaim)) {
        fail('takeover_reference_invalid', 'Initial packet cannot replace prior work');
      }
      if (version > 1) {
        if (!latestClaim || latestClaim.id !== supersedesClaimId) {
          fail('takeover_reference_invalid', 'Replacement packet must name latest claim');
        }
        if (latestClaim.status === 'completed') {
          fail('claim_not_active', 'Completed work cannot be replaced');
        }
        if (latestClaim.status === 'active' && latestClaim.expiresAt > this.now()) {
          fail('takeover_not_ready', 'Prior claim is still active');
        }
        if (
          latestClaim.status === 'active' ||
          latestClaim.terminalAt === null
        ) {
          const expired = {
            ...latestClaim,
            status: 'expired' as const,
            terminalAt: this.now(),
          };
          await this.repository.saveClaim(expired);
          await this.repository.addClaimEvent({
            id: this.newId(),
            claimId: expired.id,
            epoch: expired.epoch,
            kind: 'expired',
            reason: null,
            priorClaimId: expired.priorClaimId,
            occurredAt: this.now(),
          });
        }
      }
      const assignmentItem = items.find(
        (item) => item.eventId === assignment.assignmentEventId,
      );
      if (
        !assignmentItem ||
        assignmentItem.taskId !== assignment.taskId ||
        assignmentItem.threadId !== assignment.threadId ||
        assignmentItem.sequence !== assignment.expectedSequence ||
        window.threadId !== assignment.threadId ||
        await this.repository.getThreadSequence(assignment.threadId) !== assignment.expectedSequence
      ) {
        fail('packet_assignment_mismatch', 'Assignment does not match frozen inbox');
      }
      const base = {
        id: this.newId(),
        version,
        actor: 'luca-gemini' as const,
        runtimeRegistrationId: principal.runtimeRegistrationId,
        profileId: principal.profileId,
        createdAt: this.now(),
        supersedesClaimId,
        windowId,
        windowDigest: window.boundaryDigest,
        orderedInboxItemIds: items.map((item) => item.id),
        orderedEventIds: items.map((item) => item.eventId),
        orderedThreadIds: items.map((item) => item.threadId),
        assignment,
        inherited: items.map((item) => item.payload),
        envelope: envelopeOverride ? immutable(envelopeOverride) : this.envelope,
      };
      const packet = {
        ...base,
        digest: digestCanonical(base),
      };
      await this.repository.savePacket(packet);
      return packet;
    });
  }

  async createGate3Packet(
    principal: RuntimePrincipal,
    windowId: string,
    assignment: Assignment,
    idempotencyKey: string,
    envelope: Gate3ExecutionEnvelope,
    version = 1,
    supersedesClaimId: string | null = null,
  ): Promise<InheritancePacket> {
    return this.createPacket(principal, windowId, assignment, idempotencyKey, version, supersedesClaimId, envelope);
  }

  async recordInteraction(
    principal: RuntimePrincipal,
    input: {
      packetId: string;
      turn: number;
      attempt: number;
      requestDigest: string;
      responseDigest?: string;
      outcome: NormalizedOutcome;
      retryLineage?: string | null;
      normalizedEvidence?: NormalizedInteractionEvidence;
      idempotencyKey: string;
    },
  ): Promise<ModelInteraction> {
    this.authorize(principal, 'luca-gemini', 'model');
    const packet = await this.repository.getPacket(input.packetId);
    if (
      !packet ||
      packet.runtimeRegistrationId !== principal.runtimeRegistrationId ||
      packet.profileId !== principal.profileId
    ) {
      fail('packet_assignment_mismatch', 'Packet is not owned by this runtime');
    }
    if (input.normalizedEvidence) {
      let evidenceBytes: number;
      try {
        evidenceBytes = Buffer.byteLength(canonicalJson(input.normalizedEvidence), 'utf8');
        for (const intent of input.normalizedEvidence.intents) {
          const argumentBytes = Buffer.byteLength(canonicalJson(intent.arguments), 'utf8');
          const rawBytes = intent.rawArguments
            ? Buffer.byteLength(intent.rawArguments.canonicalUtf8, 'utf8') : 0;
          if (argumentBytes > MAX_NORMALIZED_ARGUMENT_BYTES || rawBytes > MAX_NORMALIZED_ARGUMENT_BYTES) {
            fail('output_limit_exceeded', 'Tool argument evidence exceeds the approved bound');
          }
        }
      } catch (error) {
        if (error instanceof RuntimeProtocolError) throw error;
        fail('invalid_request', 'Normalized evidence is not canonical JSON');
      }
      if (evidenceBytes > MAX_NORMALIZED_EVIDENCE_BYTES) {
        fail('output_limit_exceeded', 'Normalized interaction evidence exceeds the approved bound');
      }
    }

    const result = await this.repository.transaction<MutationResult<ModelInteraction>>(async () => {
      const payload = {
        ...input,
        retryLineage: input.retryLineage ?? null,
        runtimeRegistrationId: principal.runtimeRegistrationId,
        profileId: principal.profileId,
        credentialId: principal.credentialId,
      };
      const payloadDigest = digestCanonical(payload);
      const priorReplay = await this.repository.idempotency('interaction', input.idempotencyKey);
      if (priorReplay) {
        if (priorReplay.payloadDigest !== payloadDigest) {
          fail('idempotency_payload_mismatch', 'Changed interaction replay');
        }
        return {
          value: await this.repository.getResult(
            priorReplay.resultKind,
            priorReplay.resultId,
          ) as ModelInteraction,
        };
      }

      const violate = async (reason: string, code = 'model_call_limit_exceeded', rejectedIntents: unknown[] = []): Promise<MutationResult<ModelInteraction>> => {
        const claim = await this.repository.activeClaimForThread(packet.assignment.threadId);
        if (claim?.packetId === packet.id) {
          await this.repository.saveClaim({
            ...claim,
            status: 'violated',
            terminalAt: this.now(),
          });
          await this.repository.addClaimEvent({
            id: this.newId(),
            claimId: claim.id,
            epoch: claim.epoch,
            kind: 'violated',
            reason,
            priorClaimId: claim.priorClaimId,
            occurredAt: this.now(),
          });
        }
        // Rejection evidence is itself immutable protocol evidence.  It must
        // survive the rejected operation so auditors can distinguish a
        // provider-policy violation from a missing/failed host tool result.
        const rejected: ModelInteraction = {
          id: this.newId(),
          packetId: packet.id,
          principal: {
            actor: principal.actor,
            runtimeRegistrationId: principal.runtimeRegistrationId,
            credentialId: principal.credentialId,
            profileId: principal.profileId,
          },
          turn: input.turn,
          attempt: input.attempt,
          requestDigest: input.requestDigest,
          responseDigest: input.responseDigest ?? digestCanonical({ rejected: reason }),
          outcome: 'malformed_function_call',
          retryLineage: input.retryLineage ?? null,
          normalizedEvidence: immutable({
            textParts: [],
            intents: [],
            validatedIntents: [],
            ...(rejectedIntents.length ? { rejectedIntents: immutable(rejectedIntents) } : {}),
            additionalCandidateHashes: [],
            providerDetails: { rejected: true, reason },
            normalizedResponseDigest: input.responseDigest ?? digestCanonical({ rejected: reason }),
          }),
          createdAt: this.now(),
        };
        await this.repository.saveInteraction(rejected);
        await this.repository.saveIdempotency('interaction', input.idempotencyKey, {
          payloadDigest,
          resultKind: 'interaction',
          resultId: rejected.id,
        });
        return { error: new RuntimeProtocolError(code, reason) };
      };

      if (
        !Number.isInteger(input.turn) ||
        input.turn < 1 ||
        input.turn > 4 ||
        !Number.isInteger(input.attempt) ||
        input.attempt < 1 ||
        input.attempt > 2
      ) {
        return await violate('Model turn or attempt is outside the approved limit');
      }
      if (await this.repository.interactionForAssignmentSlot(packet, input.turn, input.attempt)) {
        fail('duplicate_model_attempt', 'Model turn and attempt already exist');
      }
      if (
        input.turn > 1 &&
        !await this.repository.interactionForAssignmentSlot(packet, input.turn - 1, 1)
      ) {
        return await violate('Logical model turn was skipped');
      }
      if (input.attempt === 2) {
        const first = await this.repository.interactionForAssignmentSlot(packet, input.turn, 1);
        if (
          !first ||
          first.outcome !== 'retryable_provider_error' ||
          input.retryLineage !== first.id
        ) {
          return await violate('Retry lineage is not authorized');
        }
      }
      if ((await this.repository.interactionsForAssignment(packet)).length >= 8) {
        return await violate('Gemini API attempt limit exceeded');
      }
      if (!input.responseDigest) {
        fail('interaction_digest_mismatch', 'Every interaction requires a response digest');
      }

       if (input.outcome === 'malformed_function_call') {
         const activeClaim = await this.repository.activeClaimForThread(packet.assignment.threadId);
         if (activeClaim?.packetId === packet.id) {
           const rejectedIntents = (input.normalizedEvidence?.intents ?? []).map((intent) => ({
             name: intent.name,
             callId: intent.callId,
             digest: digestCanonical(intent),
             reason: 'provider returned a malformed or unauthorized function call',
           }));
           return await violate(
             'Provider returned a malformed or unauthorized function call',
             'malformed_function_call',
             rejectedIntents,
           );
         }
       }

       if (input.outcome !== 'malformed_function_call' && input.normalizedEvidence) {
         const evidence = input.normalizedEvidence;
          // Ineligible provider evidence is retained for auditability, but it
          // is never policy-validated or granted execution authority.
          const executableIntents = evidence.intents.filter((intent) => intent.executionEligible !== false);
          let validated: Array<{ name: string; operation: string; digest: string }>;
         try {
            validated = executableIntents.map((intent) => validateToolIntent(intent));
         } catch (error) {
            const rejectedIntents = executableIntents.map((intent) => ({
             name: intent.name, callId: intent.callId, digest: digestCanonical(intent),
             reason: error instanceof RuntimeProtocolError ? error.message : 'policy validation failed',
           }));
           return await violate('Provider intent failed the execution policy', 'malformed_function_call', rejectedIntents);
         }
          if (evidence.validatedIntents &&
              (validated.length !== evidence.validatedIntents.length ||
             validated.some((v, i) => v.name !== evidence.validatedIntents![i].name ||
               v.operation !== evidence.validatedIntents![i].operation ||
               v.digest !== evidence.validatedIntents![i].digest))) {
           return await violate('Provider intent failed the execution policy', 'malformed_function_call');
         }
       }
       const interaction: ModelInteraction = {
        id: this.newId(),
        packetId: packet.id,
        principal: {
          actor: principal.actor,
          runtimeRegistrationId: principal.runtimeRegistrationId,
          credentialId: principal.credentialId,
          profileId: principal.profileId,
        },
        turn: input.turn,
        attempt: input.attempt,
        requestDigest: input.requestDigest,
        ...(input.responseDigest ? { responseDigest: input.responseDigest } : {}),
        outcome: input.outcome,
        retryLineage: input.retryLineage ?? null,
        ...(input.normalizedEvidence ? { normalizedEvidence: immutable(input.normalizedEvidence) } : {}),
        createdAt: this.now(),
      };
      await this.repository.saveInteraction(interaction);
      await this.repository.saveIdempotency('interaction', input.idempotencyKey, {
        payloadDigest,
        resultKind: 'interaction',
        resultId: interaction.id,
      });
      return { value: immutable(interaction) };
    });

    if ('error' in result) throw result.error;
    return result.value;
  }

  async appendToolResultBatch(
    principal: RuntimePrincipal,
    claimId: string,
    claimEpoch: number,
    answeredInteractionId: string,
    results: Array<{
      interactionId: string; callId: string; toolName: string; validatedIntentDigest: string;
      outcome: ToolResultOutcome; payload: unknown;
    }>,
    idempotencyKey: string,
  ): Promise<ToolResultRecord[]> {
    this.authorize(principal, 'luca-gemini', 'execute');
    return this.repository.transaction(async () => {
      const payloadDigest = digestCanonical({ claimId, claimEpoch, results, runtimeRegistrationId: principal.runtimeRegistrationId, profileId: principal.profileId });
      const prior = await this.repository.idempotency('tool_result_batch', idempotencyKey);
      if (prior) {
        if (prior.payloadDigest !== payloadDigest) fail('idempotency_payload_mismatch', 'Changed tool result replay');
        return this.repository.toolResultsForClaim(claimId, claimEpoch);
      }
      const claim = await this.repository.getClaim(claimId);
      if (!claim || claim.status !== 'active' || claim.epoch !== claimEpoch ||
          claim.runtimeRegistrationId !== principal.runtimeRegistrationId || claim.profileId !== principal.profileId) {
        fail('claim_not_owned', 'Claim identity is not active');
      }
      const interactions = await this.repository.interactionsForPacket(claim.packetId);
      const answered = interactions.find((interaction) => interaction.id === answeredInteractionId);
      if (!answered) fail('interaction_not_found', 'Answered interaction does not exist');
      const earlier = interactions.filter((interaction) => interaction.createdAt < answered.createdAt);
       const earlierExpected = earlier.flatMap((interaction) => (interaction.normalizedEvidence?.intents ?? [])
         .filter((intent) => intent.executionEligible !== false)
        .map((intent) => ({ interactionId: interaction.id, callId: intent.callId })));
      const existing = await this.repository.toolResultsForClaimAllEpochs(claim.id);
      if (earlierExpected.some((item) => !existing.some((row) => row.interactionId === item.interactionId && row.callId === item.callId))) {
        fail('consumption_conflict', 'Earlier interaction tool results are incomplete');
      }
      const expected = (answered.normalizedEvidence?.intents ?? [])
        .filter((intent) => intent.executionEligible !== false)
        .map((intent) => ({ interactionId: answered.id, ...intent, validated: validateToolIntent(intent) }))
        .filter((item) => item.validated);
      if (results.length !== expected.length) fail('consumption_conflict', 'Exactly one result is required for every validated intent');
      const seen = new Set<string>();
      const records: ToolResultRecord[] = [];
      const authorityEvent = await this.repository.claimEventForEpoch(claim.id, claimEpoch);
      if (!authorityEvent || !['acquired', 'renewed'].includes(authorityEvent.kind)) {
        fail('claim_not_active', 'Claim authority event is missing');
      }
      for (const result of results) {
        const match = expected.find((item) => item.interactionId === result.interactionId && item.callId === result.callId);
        if (!match || seen.has(`${result.interactionId}:${result.callId}`) ||
            match.name !== result.toolName || match.validated.digest !== result.validatedIntentDigest) {
          fail('consumption_conflict', 'Tool result is not bound to a validated intent');
        }
        if (!['succeeded', 'rejected'].includes(result.outcome)) fail('invalid_request', 'Tool result outcome is invalid');
        validateToolResultPayload(result.toolName, result.outcome, result.payload);
        seen.add(`${result.interactionId}:${result.callId}`);
        records.push({
          id: this.newId(), claimId, claimEpoch, claimEventId: authorityEvent.id, interactionId: result.interactionId, callId: result.callId,
          runtimeRegistrationId: principal.runtimeRegistrationId, profileId: principal.profileId,
          credentialId: principal.credentialId, validatedIntentDigest: result.validatedIntentDigest,
          toolName: result.toolName, outcome: result.outcome, canonicalPayload: immutable(result.payload as NormalizedToolResultPayload),
          resultDigest: digestCanonical(result.payload), createdAt: this.now(),
        });
      }
      for (const record of records) await this.repository.saveToolResult(record);
      if (records.some((record) => record.outcome === 'rejected')) {
        const violated = { ...claim, status: 'violated' as const, terminalAt: this.now() };
        await this.repository.saveClaim(violated);
        await this.repository.addClaimEvent({
          id: this.newId(), claimId: claim.id, epoch: claim.epoch, kind: 'violated',
          reason: 'rejected_tool_result', priorClaimId: claim.priorClaimId, occurredAt: this.now(),
        });
      }
      await this.repository.saveIdempotency('tool_result_batch', idempotencyKey, {
        payloadDigest, resultKind: 'tool_result_batch', resultId: records[0]?.id ?? `empty-${claimId}-${claimEpoch}`,
      });
      return records;
    });
  }

  async recordOutcomeReceipt(
    principal: RuntimePrincipal,
    packetId: string,
    packetDigest: string,
    interactionId: string,
    idempotencyKey: string,
  ): Promise<OutcomeReceipt> {
    this.authorize(principal, 'luca-gemini', 'model');
    return this.mutate('receipt', idempotencyKey, {
      packetId,
      packetDigest,
      interactionId,
      runtimeRegistrationId: principal.runtimeRegistrationId,
      profileId: principal.profileId,
    }, async () => {
      const packet = await this.repository.getPacket(packetId);
      const interaction = await this.repository.getInteraction(interactionId);
      if (
        !packet ||
        packet.digest !== packetDigest ||
        packet.runtimeRegistrationId !== principal.runtimeRegistrationId ||
        packet.profileId !== principal.profileId ||
        !interaction ||
        interaction.packetId !== packet.id ||
        interaction.principal.runtimeRegistrationId !== principal.runtimeRegistrationId ||
        interaction.principal.profileId !== principal.profileId
      ) {
        fail('consumption_not_authorized', 'Interaction and packet chain do not match');
      }
      const receipt: OutcomeReceipt = {
        id: this.newId(),
        packetId,
        packetDigest,
        interactionId,
        runtimeRegistrationId: principal.runtimeRegistrationId,
        profileId: principal.profileId,
        outcome: interaction.outcome,
        createdAt: this.now(),
      };
      await this.repository.saveReceipt(receipt);
      return receipt;
    });
  }

  private validateTtl(ttlMs: number): void {
    if (
      !Number.isFinite(ttlMs) ||
      !Number.isInteger(ttlMs) ||
      ttlMs <= 0 ||
      ttlMs > this.maxClaimTtlMs
    ) {
      fail('claim_ttl_invalid', 'Claim TTL is invalid');
    }
  }

  async claim(
    principal: RuntimePrincipal,
    packetId: string,
    packetDigest: string,
    receiptId: string,
    ttlMs: number,
    idempotencyKey: string,
  ): Promise<ExecutionClaim> {
    this.authorize(principal, 'luca-gemini', 'execute');
    this.validateTtl(ttlMs);
    return this.mutate('claim', idempotencyKey, {
      packetId,
      packetDigest,
      receiptId,
      ttlMs,
      runtimeRegistrationId: principal.runtimeRegistrationId,
      profileId: principal.profileId,
    }, async () => {
      const packet = await this.repository.getPacket(packetId);
      const receipt = await this.repository.getReceipt(receiptId);
      if (
        !packet ||
        packet.digest !== packetDigest ||
        packet.runtimeRegistrationId !== principal.runtimeRegistrationId ||
        packet.profileId !== principal.profileId ||
        !receipt ||
        receipt.packetId !== packet.id ||
        receipt.packetDigest !== packet.digest ||
        receipt.runtimeRegistrationId !== principal.runtimeRegistrationId ||
        receipt.profileId !== principal.profileId ||
        receipt.outcome !== 'consumed'
      ) {
        fail('consumption_not_authorized', 'Consumed receipt does not authorize claim');
      }
      const priorPacketClaims = await this.repository.claimsForPacket(packet.id);
      if (
        priorPacketClaims.some(
          (claim) => claim.status === 'active' && claim.expiresAt > this.now(),
        )
      ) {
        fail('claim_active_conflict', 'Packet already has an active claim');
      }
      if (priorPacketClaims.length > 0) {
        fail('fresh_consumption_required', 'A terminal or expired claim requires a fresh packet');
      }
      if (
        await this.repository.getThreadSequence(packet.assignment.threadId) !==
        packet.assignment.expectedSequence
      ) {
        fail('thread_sequence_stale', 'Coordinator sequence changed');
      }
      const latestPriorClaim = await this.repository.latestClaimForThread(
        packet.assignment.threadId,
      );
      if (latestPriorClaim?.status === 'completed') {
        fail('claim_not_active', 'Completed work cannot be claimed again');
      }
      if (
        latestPriorClaim &&
        (
          packet.supersedesClaimId !== latestPriorClaim.id ||
          latestPriorClaim.terminalAt === null ||
          packet.createdAt < latestPriorClaim.terminalAt ||
          receipt.createdAt < packet.createdAt
        )
      ) {
        fail('fresh_consumption_required', 'Replacement evidence predates terminal claim');
      }
      const active = await this.repository.activeClaimForThread(packet.assignment.threadId);
      if (active) {
        if (active.expiresAt > this.now()) {
          fail('claim_active_conflict', 'Thread has an active claim');
        }
        await this.repository.saveClaim({
          ...active,
          status: 'expired',
          terminalAt: this.now(),
        });
        await this.repository.addClaimEvent({
          id: this.newId(),
          claimId: active.id,
          epoch: active.epoch,
          kind: 'expired',
          reason: null,
          priorClaimId: active.priorClaimId,
          occurredAt: this.now(),
        });
      }
      const claim: ExecutionClaim = {
        id: this.newId(),
        threadId: packet.assignment.threadId,
        packetId,
        runtimeRegistrationId: principal.runtimeRegistrationId,
        profileId: principal.profileId,
        credentialId: principal.credentialId,
        priorClaimId: latestPriorClaim?.id ?? null,
        epoch: await this.repository.maxClaimEpoch(packet.assignment.threadId) + 1,
        expiresAt: this.now() + ttlMs,
        status: 'active',
        terminalAt: null,
      };
      await this.repository.saveClaim(claim);
      await this.repository.addClaimEvent({
        id: this.newId(),
        claimId: claim.id,
        epoch: claim.epoch,
        kind: 'acquired',
        reason: null,
        priorClaimId: latestPriorClaim?.id ?? null,
        occurredAt: this.now(),
      });
      return claim;
    });
  }

  async renew(
    principal: RuntimePrincipal,
    claimId: string,
    epoch: number,
    ttlMs: number,
    idempotencyKey: string,
  ): Promise<ExecutionClaim> {
    this.authorize(principal, 'luca-gemini', 'execute');
    this.validateTtl(ttlMs);
    return this.mutate('renewal', idempotencyKey, {
      claimId,
      epoch,
      ttlMs,
      runtimeRegistrationId: principal.runtimeRegistrationId,
      profileId: principal.profileId,
    }, async () => {
      const claim = await this.repository.getClaim(claimId);
      if (!claim) fail('claim_not_active', 'Claim does not exist');
      if (
        claim.runtimeRegistrationId !== principal.runtimeRegistrationId ||
        claim.profileId !== principal.profileId
      ) fail('claim_not_owned', 'Claim belongs to another runtime');
      if (claim.epoch !== epoch) fail('claim_epoch_stale', 'Claim epoch is stale');
      if (claim.status !== 'active' || claim.expiresAt <= this.now()) {
        fail('claim_expired', 'Claim is not active');
      }
      if (await this.repository.executionForClaim(claimId)) {
        fail('execution_already_recorded', 'Claim cannot renew after execution');
      }
      const renewed = {
        ...claim,
        credentialId: principal.credentialId,
        epoch: claim.epoch + 1,
        expiresAt: this.now() + ttlMs,
      };
      await this.repository.saveClaim(renewed);
      await this.repository.addClaimEvent({
        id: this.newId(),
        claimId,
        epoch: renewed.epoch,
        kind: 'renewed',
        reason: null,
        priorClaimId: claim.priorClaimId,
        occurredAt: this.now(),
      });
      return renewed;
    });
  }

  async execute(
    principal: RuntimePrincipal,
    claimId: string,
    command: ExecutionEnvelope,
    idempotencyKey: string,
    attestedLocalState: AttestedLocalState = {
      startingCommit: '',
      resultingHead: '',
      changedPaths: [],
      patchDigest: null,
      commandResults: [],
      elapsedMs: 0,
      modelTurns: 0,
      apiAttempts: 0,
    },
  ): Promise<ExecutionRecord> {
    this.authorize(principal, 'luca-gemini', 'execute');
    const payload = {
      claimId,
      command,
      runtimeRegistrationId: principal.runtimeRegistrationId,
      profileId: principal.profileId,
      attestedLocalState,
    };
    const result = await this.repository.transaction<MutationResult<ExecutionRecord>>(async () => {
      const payloadDigest = digestCanonical(payload);
      const prior = await this.repository.idempotency('execution', idempotencyKey);
      if (prior) {
        if (prior.payloadDigest !== payloadDigest) {
          fail('idempotency_payload_mismatch', 'Changed execution replay');
        }
        return {
          value: await this.repository.getResult(
            prior.resultKind,
            prior.resultId,
          ) as ExecutionRecord,
        };
      }
      const claim = await this.repository.getClaim(claimId);
      const packet = claim && await this.repository.getPacket(claim.packetId);
      if (!claim || !packet) fail('claim_not_active', 'Claim does not exist');
      if (
        claim.runtimeRegistrationId !== principal.runtimeRegistrationId ||
        claim.profileId !== principal.profileId
      ) fail('claim_not_owned', 'Claim belongs to another runtime');
      if (claim.expiresAt <= this.now()) fail('claim_expired', 'Claim has expired');
      if (claim.status !== 'active') fail('claim_not_active', 'Claim is not active');
      if (canonicalJson(command) !== canonicalJson(packet.envelope)) {
        await this.repository.saveClaim({
          ...claim,
          status: 'violated',
          terminalAt: this.now(),
        });
        await this.repository.addClaimEvent({
          id: this.newId(),
          claimId,
          epoch: claim.epoch,
          kind: 'violated',
          reason: 'execution_envelope_mismatch',
          priorClaimId: claim.priorClaimId,
          occurredAt: this.now(),
        });
        return {
          error: new RuntimeProtocolError(
            'execution_envelope_mismatch',
            'Command exceeds configured envelope',
          ),
        };
      }
      const derivedToolEvidence: DerivedToolEvidence = (await this.repository.interactionsForPacket(packet.id))
        .filter((interaction) => interaction.normalizedEvidence)
        .sort((a, b) => a.turn - b.turn || a.attempt - b.attempt)
        .map((interaction) => {
          const evidence = interaction.normalizedEvidence!;
          const details = evidence.providerDetails as Record<string, unknown>;
          const binding = details.toolEvidenceBinding as Record<string, unknown> | undefined;
          return {
            priorInteractionId: typeof binding?.priorInteractionId === 'string' ? binding.priorInteractionId : interaction.id,
            normalizedResponseDigest: typeof binding?.normalizedResponseDigest === 'string'
              ? binding.normalizedResponseDigest : evidence.normalizedResponseDigest,
           callIds: Array.isArray(binding?.callIds) ? binding.callIds.filter((id): id is string => typeof id === 'string') : evidence.intents
             .filter((intent) => intent.executionEligible !== false).map((intent) => intent.callId),
            results: Array.isArray(details.toolResults) ? details.toolResults : [],
          };
        });
      const allResults = await this.repository.toolResultsForClaimAllEpochs(claim.id);
      const expected = (await this.repository.interactionsForPacket(packet.id)).flatMap((interaction) =>
        (interaction.normalizedEvidence?.intents ?? []).filter((intent) => intent.executionEligible !== false).map((intent) => ({
          interactionId: interaction.id, callId: intent.callId,
          digest: digestCanonical(intent),
        })));
      const resultKeys = allResults.map((result) => `${result.interactionId}:${result.callId}:${result.validatedIntentDigest}`);
      const expectedKeys = expected.map((item) => `${item.interactionId}:${item.callId}:${item.digest}`);
      if (allResults.length !== expected.length || new Set(resultKeys).size !== resultKeys.length ||
          new Set(resultKeys).size !== new Set(expectedKeys).size ||
          allResults.some((result) => result.outcome !== 'succeeded' ||
            !expected.some((item) => item.interactionId === result.interactionId &&
              item.callId === result.callId && item.digest === result.validatedIntentDigest))) {
        fail('completion_evidence_missing', 'Every validated intent requires one succeeded result');
      }
      const execution: ExecutionRecord = {
        id: this.newId(),
        claimId,
        claimEpoch: claim.epoch,
        runtimeRegistrationId: principal.runtimeRegistrationId,
        profileId: principal.profileId,
        credentialId: principal.credentialId,
        envelope: command,
        derivedToolEvidence: immutable(derivedToolEvidence),
        attestedLocalState: immutable(attestedLocalState),
        executionDigest: digestCanonical({
          claimId,
          claimEpoch: claim.epoch,
          packetDigest: packet.digest,
          envelope: command,
          derivedToolEvidence,
          attestedLocalState,
          toolLedger: allResults.sort((a, b) => a.id.localeCompare(b.id))
            .map((result) => ({ id: result.id, claimEventId: result.claimEventId, resultDigest: result.resultDigest })),
        }),
      };
      await this.repository.saveExecution(execution);
      await this.repository.saveIdempotency('execution', idempotencyKey, {
        payloadDigest,
        resultKind: 'execution',
        resultId: execution.id,
      });
      return { value: immutable(execution) };
    });
    if ('error' in result) throw result.error;
    return result.value;
  }

  async complete(
    principal: RuntimePrincipal,
    executionId: string,
    evidenceDigest: string,
    idempotencyKey: string,
  ): Promise<CompletionRecord> {
    this.authorize(principal, 'luca-gemini', 'execute');
    return this.mutate('completion', idempotencyKey, {
      executionId,
      evidenceDigest,
      runtimeRegistrationId: principal.runtimeRegistrationId,
      profileId: principal.profileId,
    }, async () => {
      const execution = await this.repository.getExecution(executionId);
      const claim = execution && await this.repository.getClaim(execution.claimId);
      if (!execution || !claim) fail('completion_mismatch', 'Execution does not exist');
      if (execution.claimEpoch !== claim.epoch) {
        fail('claim_epoch_stale', 'Execution belongs to a stale claim epoch');
      }
      if (
        execution.runtimeRegistrationId !== principal.runtimeRegistrationId ||
        execution.profileId !== principal.profileId
      ) fail('claim_not_owned', 'Execution belongs to another runtime');
      if (claim.expiresAt <= this.now()) fail('claim_expired', 'Claim has expired');
      if (claim.status !== 'active') fail('claim_not_active', 'Claim is not active');
      if (evidenceDigest !== digestCanonical(execution)) {
        fail('evidence_mismatch', 'Completion evidence digest is invalid');
      }
       const interactions = (await this.repository.interactionsForPacket(claim.packetId))
         .filter((item) => item.normalizedEvidence)
         .sort((a, b) => a.turn - b.turn || a.attempt - b.attempt);
       const finalInteraction = interactions[interactions.length - 1];
        if (!finalInteraction || finalInteraction.outcome !== 'consumed' ||
            (finalInteraction.normalizedEvidence?.intents?.filter((intent) => intent.executionEligible !== false).length ?? 0) !== 0) {
         fail('consumption_conflict', 'Completion requires a consumed final interaction with no tool intents');
       }
        const expected = interactions.flatMap((interaction) =>
          (interaction.normalizedEvidence?.intents ?? []).filter((intent) => intent.executionEligible !== false).map((intent) => ({
           interactionId: interaction.id, callId: intent.callId, digest: digestCanonical(intent),
         })));
       const results = await this.repository.toolResultsForClaimAllEpochs(claim.id);
       const resultKeys = results.map((result) => `${result.interactionId}:${result.callId}:${result.validatedIntentDigest}`);
       const expectedKeys = expected.map((item) => `${item.interactionId}:${item.callId}:${item.digest}`);
       if (results.length !== expected.length || new Set(resultKeys).size !== resultKeys.length ||
           new Set(resultKeys).size !== new Set(expectedKeys).size ||
           results.some((result) => result.outcome !== 'succeeded' ||
             !expected.some((item) => item.interactionId === result.interactionId &&
               item.callId === result.callId && item.digest === result.validatedIntentDigest))) {
         fail('consumption_conflict', 'Tool-result chain is incomplete');
       }
      const completion: CompletionRecord = {
        id: this.newId(),
        executionId,
        claimId: claim.id,
        claimEpoch: claim.epoch,
        evidenceDigest,
      };
      await this.repository.saveClaim({
        ...claim,
        status: 'completed',
        terminalAt: this.now(),
      });
      await this.repository.saveCompletion(completion);
      return completion;
    });
  }

  async verify(
    principal: RuntimePrincipal,
    completionId: string,
    evidenceDigest: string,
    patchDigest: string | null,
    idempotencyKey: string,
    decision: 'approved' | 'rejected' = 'approved',
    rationale?: string,
    rerunEvidence?: unknown,
  ): Promise<VerificationDecision> {
    if (principal.actor !== 'luca-replit' && principal.actor !== 'luca-claude-code') {
      fail('verifier_not_allowed', 'Verifier actor is not approved');
    }
    this.authorize(principal, principal.actor, 'verify');
    if (!principal.standingVerifier) {
      fail('verifier_registration_not_standing', 'Verifier registration is not designated as a standing verifier');
    }
    const verifierActor = principal.actor;
    return this.mutate('verification', idempotencyKey, {
      completionId,
      evidenceDigest,
      patchDigest,
      verifierActor,
      verifierRuntimeRegistrationId: principal.runtimeRegistrationId,
      decision,
      rationale: rationale ?? null,
      rerunEvidence: rerunEvidence ?? null,
    }, async () => {
      const completion = await this.repository.getCompletion(completionId);
      const claim = completion && await this.repository.getClaim(completion.claimId);
      const packet = claim && await this.repository.getPacket(claim.packetId);
      if (!completion || !claim || !packet) {
        fail('verification_chain_missing', 'Completion evidence chain is missing');
      }
      if (packet.assignment.assignmentAuthor === verifierActor) {
        fail('assigner_verification_denied', 'Assignment author cannot verify');
      }
      if (claim.runtimeRegistrationId === principal.runtimeRegistrationId) {
        fail('self_verification_denied', 'Executing runtime cannot verify');
      }
      if (
        completion.evidenceDigest !== evidenceDigest ||
        (await this.repository.getExecution(completion.executionId))?.attestedLocalState.patchDigest !== patchDigest
      ) {
        fail('verification_digest_mismatch', 'Verification evidence does not match');
      }
      const verification: VerificationDecision = {
        id: this.newId(),
        completionId,
        verifierActor,
        verifierRuntimeRegistrationId: principal.runtimeRegistrationId,
        evidenceDigest,
        patchDigest,
        decision,
        ...(rationale ? { rationale } : {}),
        ...(rerunEvidence !== undefined ? { rerunEvidence: immutable(rerunEvidence) } : {}),
      };
      await this.repository.saveVerification(verification);
      return verification;
    });
  }
}