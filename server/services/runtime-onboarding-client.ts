import { createHash, createSign, generateKeyPairSync, createPublicKey, randomUUID } from 'node:crypto';
import type OpenAI from 'openai';
import type {
  Response as OpenAIResponse,
  ResponseCreateParamsBase,
  ResponseStreamEvent,
  Tool as OpenAIResponsesTool,
} from 'openai/resources/responses/responses';
import type { Stream } from 'openai/streaming';
import type {
  RuntimeOnboardingPurpose,
  RuntimeOnboardingScope,
  RuntimeOnboardingStore,
} from './runtime-onboarding-store';

export type RuntimeOnboardingFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type RuntimeOnboardingState =
  | 'prepared' | 'requested' | 'approved' | 'denied' | 'cancelled'
  | 'expired' | 'enrolled' | 'revoked';

export type OnboardingSafeRequest = {
  requestId: string;
  actor: string;
  runtimeId: string;
  verificationCode: string;
  fingerprint: string;
  approvalPath: string;
  state: RuntimeOnboardingState;
  expiresAt: string;
  capabilities?: string[];
};

type AttemptState = {
  version: 1;
  invitationId: string;
  requestId: string | null;
  fingerprint: string;
  publicKey: string;
  /** Present only during crash-safe atomic first-write initialization. */
  privateKey?: string;
  proofPending: boolean;
};

type StoredCredential = {
  endpoint: string;
  actor: string;
  runtimeId: string;
  accessToken: string;
  expiresAt: string;
  capabilities: string[];
};

type ClientOptions = {
  endpoint: string;
  actor: string;
  runtimeId: string;
  invitationId?: string;
  store: RuntimeOnboardingStore;
  fetchImpl?: RuntimeOnboardingFetch;
  /** Only test harnesses should set this, never CLI-derived user input. */
  allowInsecureHttpForTests?: boolean;
};

export type RuntimeOpenAIResponsesPolicy = {
  /** Optional safe narrowing of the remote tool set; approval remains mandatory. */
  allowedTools?: readonly string[];
};

export type RuntimeOpenAIResponsesResult = OpenAIResponse | Stream<ResponseStreamEvent>;

const RUNTIME_OPENAI_MCP_SERVER_LABEL = 'holahola-coordination';

function requireString(value: unknown, name: string, maxLength = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`onboarding_invalid_${name}`);
  }
  return value;
}

function parseObject(raw: string, name: string): Record<string, unknown> {
  if (raw.length > 64 * 1024) throw new Error(`onboarding_${name}_response_too_large`);
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`onboarding_${name}_response_invalid`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`onboarding_${name}_response_invalid`);
  }
  return value as Record<string, unknown>;
}

function safeState(value: unknown): RuntimeOnboardingState {
  const states: RuntimeOnboardingState[] = [
    'prepared', 'requested', 'approved', 'denied', 'cancelled', 'expired', 'enrolled', 'revoked',
  ];
  if (typeof value !== 'string' || !states.includes(value as RuntimeOnboardingState)) {
    throw new Error('onboarding_invalid_state');
  }
  return value as RuntimeOnboardingState;
}

function validateScopeIdentity(value: Record<string, unknown>, actor: string, runtimeId: string): void {
  if (value.actor !== actor || value.runtimeId !== runtimeId) {
    throw new Error('onboarding_server_returned_cross_scope_identity');
  }
}

function normalizedEndpoint(endpoint: string, allowHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('onboarding_endpoint_invalid');
  }
  if (
    (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:'))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/'
  ) {
    throw new Error('onboarding_endpoint_must_be_trusted_https_origin');
  }
  return url.origin;
}

function canonicalPathname(pathname: string): string {
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    throw new Error('onboarding_auth_header_target_not_allowed');
  }

  // Treat encoded separators and dot segments conservatively for the security
  // decision, without changing the URL that is ultimately sent to the server.
  const segments: string[] = [];
  for (const segment of decodedPathname.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  const trailingSlash = decodedPathname.endsWith('/') || /(?:^|\/)\.{1,2}$/.test(decodedPathname);
  return `/${segments.join('/')}${trailingSlash && segments.length > 0 ? '/' : ''}`.toLowerCase();
}

function publicKeyFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return `SHA256:${createHash('sha256').update(der).digest('base64').replace(/=+$/, '')}`;
}

function validatedRequest(
  value: Record<string, unknown>,
  scope: RuntimeOnboardingScope,
  expectedFingerprint?: string,
): OnboardingSafeRequest {
  validateScopeIdentity(value, scope.actor, scope.runtimeId);
  const requestId = requireString(value.requestId, 'request_id', 256);
  const fingerprint = requireString(value.fingerprint, 'fingerprint', 256);
  if (expectedFingerprint && fingerprint !== expectedFingerprint) {
    throw new Error('onboarding_server_returned_wrong_public_key_fingerprint');
  }
  const approvalPath = requireString(value.approvalPath, 'approval_path', 512);
  if (approvalPath !== `/admin/runtime-onboarding?request=${encodeURIComponent(requestId)}`) {
    throw new Error('onboarding_server_returned_unsafe_approval_path');
  }
  const expiresAt = requireString(value.expiresAt, 'expires_at', 128);
  if (!Number.isFinite(Date.parse(expiresAt))) throw new Error('onboarding_invalid_expiry');
  if (value.capabilities !== undefined && (!Array.isArray(value.capabilities) || value.capabilities.length > 64
    || value.capabilities.some((item) => typeof item !== 'string' || item.length > 128))) {
    throw new Error('onboarding_invalid_capabilities');
  }
  const request: OnboardingSafeRequest = {
    requestId,
    actor: scope.actor,
    runtimeId: scope.runtimeId,
    verificationCode: requireString(value.verificationCode, 'verification_code', 128),
    fingerprint,
    approvalPath,
    state: safeState(value.state),
    expiresAt,
    ...(Array.isArray(value.capabilities) ? { capabilities: value.capabilities as string[] } : {}),
  };
  return request;
}

function validatedChallenge(
  value: Record<string, unknown>,
  purpose: 'enroll' | 'recover',
  scope: RuntimeOnboardingScope,
  attempt: AttemptState,
): { challengeId: string; payload: string } {
  const challengeId = requireString(value.challengeId, 'challenge_id', 256);
  const nonce = requireString(value.nonce, 'nonce', 2048);
  const payload = requireString(value.payload, 'challenge_payload', 16 * 1024);
  if (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))) {
    throw new Error('onboarding_invalid_challenge_expiry');
  }
  let signed: unknown;
  try {
    signed = JSON.parse(payload) as unknown;
  } catch {
    throw new Error('onboarding_challenge_payload_invalid');
  }
  if (typeof signed !== 'object' || signed === null || Array.isArray(signed)) {
    throw new Error('onboarding_challenge_payload_invalid');
  }
  const binding = signed as Record<string, unknown>;
  if (
    binding.version !== 1
    || binding.domain !== 'holahola-coordination-runtime-onboarding'
    || binding.endpoint !== scope.endpoint
    || binding.actor !== scope.actor
    || binding.runtimeId !== scope.runtimeId
    || binding.requestId !== attempt.requestId
    || binding.invitationId !== attempt.invitationId
    || binding.fingerprint !== attempt.fingerprint
    || binding.nonce !== nonce
    || binding.purpose !== purpose
  ) {
    throw new Error('onboarding_challenge_cross_scope_or_invalid_binding');
  }
  return { challengeId, payload };
}

function validCredential(
  value: Record<string, unknown>,
  scope: RuntimeOnboardingScope,
): StoredCredential {
  validateScopeIdentity(value, scope.actor, scope.runtimeId);
  const accessToken = requireString(value.accessToken, 'access_token', 8192);
  const expiresAt = requireString(value.expiresAt, 'credential_expiry', 128);
  if (!Number.isFinite(Date.parse(expiresAt))) throw new Error('onboarding_invalid_credential_expiry');
  const capabilities = Array.isArray(value.capabilities)
    ? value.capabilities.filter((item): item is string => typeof item === 'string').slice(0, 64)
    : [];
  return { endpoint: scope.endpoint, actor: scope.actor, runtimeId: scope.runtimeId, accessToken, expiresAt, capabilities };
}

export class RuntimeOnboardingClient {
  readonly scope: RuntimeOnboardingScope;
  private readonly store: RuntimeOnboardingStore;
  private readonly fetchImpl: RuntimeOnboardingFetch;
  private readonly invitationId: string | undefined;
  private readonly credentialRenewalSkewMs = 60_000;

  constructor(options: ClientOptions) {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(options.actor)) throw new Error('onboarding_actor_invalid');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(options.runtimeId)) throw new Error('onboarding_runtime_id_invalid');
    this.scope = {
      endpoint: normalizedEndpoint(options.endpoint, options.allowInsecureHttpForTests === true),
      actor: options.actor,
      runtimeId: options.runtimeId,
    };
    this.invitationId = options.invitationId;
    this.store = options.store;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(path: string, body: Record<string, unknown>, bearer?: string): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(new URL(path, `${this.scope.endpoint}/`), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(bearer ? { 'x-coordination-token': bearer } : {}),
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      redirect: 'error',
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`onboarding_request_failed:${response.status}`);
    }
    return parseObject(raw, 'request');
  }

  private async loadAttempt(): Promise<AttemptState | null> {
    const raw = await this.store.get(this.scope, 'attempt-state');
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error('onboarding_local_attempt_state_corrupt');
    }
    if (
      typeof parsed !== 'object' || parsed === null
      || (parsed as Record<string, unknown>).version !== 1
      || typeof (parsed as Record<string, unknown>).invitationId !== 'string'
      || typeof (parsed as Record<string, unknown>).fingerprint !== 'string'
      || typeof (parsed as Record<string, unknown>).publicKey !== 'string'
      || ((parsed as Record<string, unknown>).privateKey !== undefined
        && typeof (parsed as Record<string, unknown>).privateKey !== 'string')
      || typeof (parsed as Record<string, unknown>).proofPending !== 'boolean'
      || !((parsed as Record<string, unknown>).requestId === null || typeof (parsed as Record<string, unknown>).requestId === 'string')
    ) {
      throw new Error('onboarding_local_attempt_state_corrupt');
    }
    const attempt = parsed as AttemptState;
    if (this.invitationId && attempt.invitationId !== this.invitationId) {
      throw new Error('onboarding_existing_attempt_has_different_invitation');
    }
    if (publicKeyFingerprint(attempt.publicKey) !== attempt.fingerprint) {
      throw new Error('onboarding_local_public_key_fingerprint_mismatch');
    }
    return attempt;
  }

  private saveAttempt(attempt: AttemptState): Promise<void> {
    const stableAttempt = { ...attempt };
    delete stableAttempt.privateKey;
    return this.store.set(this.scope, 'attempt-state', JSON.stringify(stableAttempt));
  }

  private async ensureProtectedProofKey(attempt: AttemptState): Promise<AttemptState> {
    let storedKey = await this.store.get(this.scope, 'proof-key');
    if (!storedKey && attempt.privateKey) {
      storedKey = await this.store.setIfAbsent(this.scope, 'proof-key', attempt.privateKey);
    }
    if (!storedKey) throw new Error('onboarding_proof_key_missing_reauthorize');
    await this.loadPrivateKey(attempt);
    if (!attempt.privateKey) return attempt;
    const stableAttempt = { ...attempt };
    delete stableAttempt.privateKey;
    await this.saveAttempt(stableAttempt);
    return stableAttempt;
  }

  private async loadPrivateKey(attempt: AttemptState): Promise<string> {
    const privateKey = await this.store.get(this.scope, 'proof-key');
    if (!privateKey) throw new Error('onboarding_proof_key_missing_reauthorize');
    let derivedPublicKey: string;
    try {
      derivedPublicKey = String(createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }));
    } catch {
      throw new Error('onboarding_local_proof_key_invalid');
    }
    if (derivedPublicKey.trim() !== attempt.publicKey.trim()) {
      throw new Error('onboarding_local_proof_key_does_not_match_attempt');
    }
    return privateKey;
  }

  async status(): Promise<OnboardingSafeRequest> {
    const attempt = await this.loadAttempt();
    if (!attempt?.requestId) throw new Error('onboarding_request_not_recorded');
    const value = await this.request(
      `/api/coordination/onboarding/requests/${encodeURIComponent(attempt.requestId)}/status`,
      {},
    );
    return validatedRequest(value, this.scope, attempt.fingerprint);
  }

  async setup(): Promise<OnboardingSafeRequest> {
    const invitationId = this.invitationId;
    if (!invitationId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,199}$/.test(invitationId)) {
      throw new Error('onboarding_invitation_id_required');
    }
    let attempt = await this.loadAttempt();
    if (attempt) {
      attempt = await this.ensureProtectedProofKey(attempt);
      if (attempt.requestId) {
        const status = await this.status();
        if (status.state === 'approved' || status.state === 'enrolled') {
          if (!await this.loadCredential()) await this.completeApprovedRequest(attempt, status);
          return this.status();
        }
        return status;
      }
      // The first request may have reached the service while its response was
      // lost. Retry only with the exact same durable key/invitation binding.
    } else {
      if (await this.store.get(this.scope, 'proof-key')) {
        throw new Error('onboarding_orphaned_proof_key_requires_operator_recovery');
      }
      if (await this.store.get(this.scope, 'access-credential')) {
        throw new Error('onboarding_existing_credential_without_attempt_requires_operator_recovery');
      }
      const pair = generateKeyPairSync('rsa', {
        modulusLength: 3072,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      const publicKey = pair.publicKey;
      const fingerprint = publicKeyFingerprint(publicKey);
      // Claim the entire initializer atomically. If another process wins, its
      // protected attempt carries the winning private key until proof-key is
      // durably set, so neither process can replace or mismatch that key.
      await this.store.setIfAbsent(this.scope, 'attempt-state', JSON.stringify({
        version: 1,
        invitationId,
        requestId: null,
        fingerprint,
        publicKey,
        privateKey: pair.privateKey,
        proofPending: false,
      } satisfies AttemptState));
      attempt = await this.loadAttempt();
      if (!attempt) throw new Error('onboarding_local_attempt_state_corrupt');
      attempt = await this.ensureProtectedProofKey(attempt);
    }
    const value = await this.request('/api/coordination/onboarding/requests', {
      invitationId: attempt.invitationId,
      publicKey: attempt.publicKey,
    });
    const response = validatedRequest(value, this.scope, attempt.fingerprint);
    attempt.requestId = response.requestId;
    await this.saveAttempt(attempt);
    if (response.state === 'approved' || response.state === 'enrolled') {
      await this.completeApprovedRequest(attempt, response);
      return this.status();
    }
    return response;
  }

  /** Fixed bounded approval wait; callers can resume later with setup again. */
  async waitForApproval(onState?: (state: RuntimeOnboardingState) => void): Promise<OnboardingSafeRequest> {
    const deadline = Date.now() + 10 * 60_000;
    let status = await this.status();
    onState?.(status.state);
    while (status.state === 'requested' && Date.now() < deadline) {
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5_000));
      status = await this.status();
      onState?.(status.state);
    }
    return status;
  }

  private async completeApprovedRequest(
    attempt: AttemptState,
    status: OnboardingSafeRequest,
  ): Promise<void> {
    if (!attempt.requestId) throw new Error('onboarding_request_not_recorded');
    if (status.state !== 'approved' && status.state !== 'enrolled') {
      throw new Error('onboarding_request_not_approved');
    }
    const purpose: 'enroll' | 'recover' = status.state === 'enrolled' ? 'recover' : 'enroll';
    const challenge = await this.request(
      `/api/coordination/onboarding/requests/${encodeURIComponent(attempt.requestId)}/challenge`,
      { purpose },
    );
    const validated = validatedChallenge(challenge, purpose, this.scope, attempt);
    const privateKey = await this.loadPrivateKey(attempt);
    const signer = createSign('RSA-SHA256');
    signer.update(validated.payload, 'utf8');
    signer.end();
    const signature = signer.sign(privateKey, 'base64');
    attempt.proofPending = true;
    await this.saveAttempt(attempt);
    const result = await this.request(
      `/api/coordination/onboarding/requests/${encodeURIComponent(attempt.requestId)}/prove`,
      { challengeId: validated.challengeId, signature },
    );
    const credential = validCredential(result, this.scope);
    await this.store.set(this.scope, 'access-credential', JSON.stringify(credential));
    attempt.proofPending = false;
    await this.saveAttempt(attempt);
  }

  private async loadCredential(): Promise<StoredCredential | null> {
    const raw = await this.store.get(this.scope, 'access-credential');
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error('onboarding_local_credential_corrupt');
    }
    if (typeof parsed !== 'object' || parsed === null) throw new Error('onboarding_local_credential_corrupt');
    const value = parsed as Record<string, unknown>;
    if (
      value.endpoint !== this.scope.endpoint
      || value.actor !== this.scope.actor
      || value.runtimeId !== this.scope.runtimeId
      || typeof value.accessToken !== 'string'
      || typeof value.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(value.expiresAt))
      || !Array.isArray(value.capabilities)
    ) {
      throw new Error('onboarding_local_credential_cross_scope_or_corrupt');
    }
    return value as StoredCredential;
  }

  private async renewCredential(credential: StoredCredential): Promise<StoredCredential> {
    const result = await this.request('/api/coordination/credentials/renew', {}, credential.accessToken);
    const renewed = validCredential(result, this.scope);
    await this.store.set(this.scope, 'access-credential', JSON.stringify(renewed));
    return renewed;
  }

  private async recoverCredential(): Promise<StoredCredential> {
    const attempt = await this.loadAttempt();
    if (!attempt?.requestId) throw new Error('onboarding_credential_unavailable_run_setup');
    const status = await this.status();
    if (status.state !== 'enrolled') throw new Error(`onboarding_recovery_not_available:${status.state}`);
    await this.completeApprovedRequest(attempt, status);
    const credential = await this.loadCredential();
    if (!credential) throw new Error('onboarding_recovery_did_not_persist_credential');
    return credential;
  }

  /**
   * Call the already-authorized OpenAI Responses SDK with this runtime's
   * coordination MCP tool. The coordination credential never leaves this
   * method except as the fixed remote MCP Authorization header.
   */
  async createOpenAIResponse(
    sdk: Pick<OpenAI, 'responses'>,
    request: ResponseCreateParamsBase,
    policy: RuntimeOpenAIResponsesPolicy = {},
  ): Promise<RuntimeOpenAIResponsesResult> {
    if (request.tools?.some((tool) => tool.type === 'mcp')) {
      throw new Error('onboarding_openai_mcp_tool_override_not_allowed');
    }
    const choice = request.tool_choice;
    if (typeof choice === 'object' && choice !== null && 'type' in choice && choice.type === 'mcp'
      && 'server_label' in choice
      && choice.server_label !== RUNTIME_OPENAI_MCP_SERVER_LABEL) {
      throw new Error('onboarding_openai_mcp_tool_choice_not_allowed');
    }
    if (policy.allowedTools !== undefined && (
      !Array.isArray(policy.allowedTools)
      || policy.allowedTools.length === 0
      || policy.allowedTools.length > 64
      || policy.allowedTools.some((name) => typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(name))
      || new Set(policy.allowedTools).size !== policy.allowedTools.length
    )) {
      throw new Error('onboarding_openai_allowed_tools_invalid');
    }

    const credential = await this.getValidCredential();
    if (!/^[A-Za-z0-9._~+/=-]+$/.test(credential.accessToken)) {
      throw new Error('onboarding_local_credential_invalid');
    }

    const tool: OpenAIResponsesTool.Mcp = {
      type: 'mcp',
      server_label: RUNTIME_OPENAI_MCP_SERVER_LABEL,
      server_url: new URL('/api/mcp/coordination', `${this.scope.endpoint}/`).toString(),
      headers: { Authorization: `Bearer ${credential.accessToken}` },
      require_approval: 'always',
      ...(policy.allowedTools ? { allowed_tools: [...policy.allowedTools] } : {}),
    };
    const response = await sdk.responses.create({
      ...request,
      tools: [...(request.tools ?? []), tool],
    });
    return response;
  }

  /**
   * Returns a valid credential, automatically renewing near expiry or
   * recovering via cryptographic proof if expired or missing from local store.
   */
  async getValidCredential(): Promise<StoredCredential> {
    let credential = await this.loadCredential();
    if (!credential) credential = await this.recoverCredential();
    const expiresIn = Date.parse(credential.expiresAt) - Date.now();
    if (expiresIn <= 0) {
      credential = await this.recoverCredential();
    } else if (expiresIn < this.credentialRenewalSkewMs
      && credential.capabilities.includes('coordination:credential:renew')) {
      credential = await this.renewCredential(credential);
    }
    return credential;
  }

  /** Credential stays inside the adapter and is never returned to CLI output. */
  async authenticatedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const baseRequest = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    const target = new URL(baseRequest.url, `${this.scope.endpoint}/`);
    const path = canonicalPathname(target.pathname);
    const allowedPath = path === '/api/mcp/coordination'
      || path.startsWith('/api/coordination/');
    const credentialPath = [
      '/api/coordination/credentials',
      '/api/coordination/onboarding',
      '/api/coordination/runtimes',
    ].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
    if (target.origin !== new URL(this.scope.endpoint).origin || !allowedPath || credentialPath) {
      throw new Error('onboarding_auth_header_target_not_allowed');
    }
    const credential = await this.getValidCredential();
    const headers = new Headers(baseRequest.headers);
    headers.delete('authorization');
    headers.delete('x-coordination-token');
    headers.delete('x-coordination-bootstrap');
    if (path === '/api/mcp/coordination') {
      headers.set('authorization', `Bearer ${credential.accessToken}`);
    } else {
      headers.set('x-coordination-token', credential.accessToken);
    }
    headers.set('accept', headers.get('accept') ?? 'application/json, text/event-stream');
    const authenticatedRequest = new Request(baseRequest, { headers, redirect: 'error' });
    return this.fetchImpl(authenticatedRequest);
  }

  /** Proves actor identity and read-only ledger/MCP capability with live calls. */
  async sdkCheck(): Promise<{
    connected: true;
    actor: string;
    runtimeId: string;
    ledgerRead: true;
    mcpReadTool: 'list_coordination_inbox';
  }> {
    const feedResponse = await this.authenticatedFetch(
      new URL('/api/coordination/threads?limit=1', `${this.scope.endpoint}/`),
      { method: 'GET', headers: { accept: 'application/json' } },
    );
    if (!feedResponse.ok) throw new Error(`onboarding_sdk_ledger_read_failed:${feedResponse.status}`);
    const feed = parseObject(await feedResponse.text(), 'sdk_ledger');
    if (feed.actor !== this.scope.actor) throw new Error('onboarding_sdk_authenticated_actor_mismatch');

    const callMcp = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const response = await this.authenticatedFetch(`${this.scope.endpoint}/api/mcp/coordination`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `onboarding-${randomUUID()}`,
          method,
          params,
        }),
      });
      if (!response.ok) throw new Error(`onboarding_sdk_mcp_failed:${response.status}`);
      const contentType = response.headers.get('content-type') ?? '';
      let text = await response.text();
      if (text.length > 64 * 1024) throw new Error('onboarding_sdk_response_too_large');
      if (contentType.includes('text/event-stream')) {
        text = text.split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
      }
      const result = parseObject(text, 'sdk');
      if (result.jsonrpc !== '2.0' || typeof result.result !== 'object' || result.result === null) {
        throw new Error('onboarding_sdk_protocol_response_invalid');
      }
      return result.result as Record<string, unknown>;
    };

    const initialized = await callMcp('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'holahola-runtime-onboarding-sdk-check', version: '1' },
    });
    if (typeof initialized.serverInfo !== 'object' || initialized.serverInfo === null) {
      throw new Error('onboarding_sdk_protocol_response_invalid');
    }
    const tools = await callMcp('tools/list', {});
    if (!Array.isArray(tools.tools)) throw new Error('onboarding_sdk_tool_list_invalid');
    const toolNames = tools.tools
      .filter((tool): tool is Record<string, unknown> => typeof tool === 'object' && tool !== null)
      .map((tool) => tool.name)
      .filter((name): name is string => typeof name === 'string');
    if (!toolNames.includes('list_coordination_inbox')) {
      throw new Error('onboarding_sdk_ledger_read_tool_unavailable');
    }
    const inbox = await callMcp('tools/call', {
      name: 'list_coordination_inbox',
      arguments: { limit: 1 },
    });
    if (inbox.isError === true || !Array.isArray(inbox.content)) {
      throw new Error('onboarding_sdk_ledger_read_tool_failed');
    }
    const textContent = inbox.content.find((entry) =>
      typeof entry === 'object' && entry !== null
      && (entry as Record<string, unknown>).type === 'text'
      && typeof (entry as Record<string, unknown>).text === 'string',
    ) as Record<string, unknown> | undefined;
    if (!textContent) throw new Error('onboarding_sdk_ledger_read_result_invalid');
    const ledgerResult = parseObject(String(textContent.text), 'sdk_ledger_tool');
    if (!Array.isArray(ledgerResult.items) || typeof ledgerResult.window !== 'object' || ledgerResult.window === null) {
      throw new Error('onboarding_sdk_ledger_read_result_invalid');
    }
    return {
      connected: true,
      actor: this.scope.actor,
      runtimeId: this.scope.runtimeId,
      ledgerRead: true,
      mcpReadTool: 'list_coordination_inbox',
    };
  }

  async hasCredential(): Promise<boolean> {
    return (await this.loadCredential()) !== null;
  }

  /** The fixed local key cannot be reused for another endpoint or identity. */
  async localStatus(): Promise<{ configured: boolean; requestId?: string; state?: string }> {
    const attempt = await this.loadAttempt();
    if (!attempt) return { configured: false };
    if (!attempt.requestId) return { configured: true, state: 'request-pending' };
    return { configured: true, requestId: attempt.requestId, state: (await this.status()).state };
  }
}

export function runtimeOnboardingPurposeNames(): readonly RuntimeOnboardingPurpose[] {
  return ['proof-key', 'attempt-state', 'access-credential'];
}