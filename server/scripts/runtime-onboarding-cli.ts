#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeOnboardingClient } from '../services/runtime-onboarding-client';
import {
  createNativeRuntimeOnboardingStore,
  secureStoreDiagnosticCategory,
} from '../services/runtime-onboarding-store';
import {
  createRuntimeOpenAITransport,
  generateRuntimeMcpClientConfig,
  runRuntimeMcpStdioBridge,
  runRuntimeOnboardingListener,
} from '../services/runtime-onboarding-transports';

type CliAction = 'setup' | 'status' | 'mcp' | 'sdk' | 'listen';
type ParsedArguments = {
  action: CliAction;
  endpoint: string;
  actor: string;
  runtimeId: string;
  invitationId?: string;
  printConfig: boolean;
  waitForApproval: boolean;
  parentPid?: number;
  stateDir?: string;
  mode?: 'continuous' | 'once';
  after?: number;
  resume?: boolean;
};

const CLI_HELP = [
  'Usage:',
  '  node holahola-onboarding.mjs setup --endpoint https://host --actor <actor> --runtime-id <id> --invitation-id <reference> [--wait]',
  '  node holahola-onboarding.mjs status --endpoint https://host --actor <actor> --runtime-id <id>',
  '  node holahola-onboarding.mjs mcp --endpoint https://host --actor <actor> --runtime-id <id>',
  '  node holahola-onboarding.mjs mcp --print-config --endpoint https://host --actor <actor> --runtime-id <id>',
  '  node holahola-onboarding.mjs listen --endpoint https://host --actor <actor> --runtime-id <id> [--parent-pid <pid>] [--mode continuous|once] [--state-dir <dir>] [--after <cursor>] [--resume]',
  '',
  'setup prints the approval reference and can be rerun with the same scope after approval.',
  '--wait opens the founder approval page and polls for up to ten minutes.',
  'listen runs an enrolled, authenticated coordination message listener using the native secure store.',
  '--after <cursor> is required on fresh state initialization to set the starting global sequence.',
  '--resume explicitly clears a previous operator stop marker.',
].join('\n');

function parseArguments(argv: string[]): ParsedArguments {
  const action = argv[0];
  if (action !== 'setup' && action !== 'status' && action !== 'mcp' && action !== 'sdk' && action !== 'listen') {
    throw new Error('usage');
  }
  const values = new Map<string, string>();
  let printConfig = false;
  let waitForApproval = false;
  let resume = false;
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--print-config' && action === 'mcp') {
      printConfig = true;
      continue;
    }
    if (flag === '--wait' && action === 'setup' && !waitForApproval) {
      waitForApproval = true;
      continue;
    }
    if (flag === '--resume' && action === 'listen' && !resume) {
      resume = true;
      continue;
    }
    const allowedFlags = ['--endpoint', '--actor', '--runtime-id', '--invitation-id'];
    if (action === 'listen') {
      allowedFlags.push('--parent-pid', '--state-dir', '--mode', '--after');
    }
    if (!allowedFlags.includes(flag)) {
      throw new Error('usage');
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--') || values.has(flag)) throw new Error('usage');
    values.set(flag, value);
    index += 1;
  }
  const endpoint = values.get('--endpoint');
  const actor = values.get('--actor');
  const runtimeId = values.get('--runtime-id');
  if (!endpoint || !actor || !runtimeId) throw new Error('usage');
  const invitationId = values.get('--invitation-id');
  if ((action === 'setup') !== Boolean(invitationId)) throw new Error('usage');

  let parentPid: number | undefined;
  if (values.has('--parent-pid')) {
    const raw = values.get('--parent-pid')!;
    if (!/^\d+$/.test(raw)) throw new Error('usage');
    parentPid = Number(raw);
    if (!Number.isSafeInteger(parentPid) || parentPid <= 0) throw new Error('usage');
  }

  let mode: 'continuous' | 'once' | undefined;
  if (values.has('--mode')) {
    const raw = values.get('--mode')!;
    if (raw !== 'continuous' && raw !== 'once') throw new Error('usage');
    mode = raw;
  }

  let after: number | undefined;
  if (values.has('--after')) {
    const raw = values.get('--after')!;
    if (!/^\d+$/.test(raw)) throw new Error('usage');
    after = Number(raw);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('usage');
  }

  const stateDir = values.get('--state-dir');

  return {
    action, endpoint, actor, runtimeId,
    ...(invitationId ? { invitationId } : {}),
    printConfig, waitForApproval,
    ...(parentPid !== undefined ? { parentPid } : {}),
    ...(stateDir ? { stateDir } : {}),
    ...(mode ? { mode } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(resume ? { resume } : {}),
  };
}

function sourceCliTsxPath(cliEntry: string): string {
  return resolve(dirname(cliEntry), '../../node_modules/tsx/dist/cli.mjs');
}

function openApprovalPage(url: string): void {
  const platform = process.platform;
  const executable = platform === 'win32' ? 'rundll32.exe' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  try {
    const browser = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true });
    browser.on('error', () => undefined);
    browser.unref();
  } catch {
    // Approval URL remains printed for a manual open on minimal/headless hosts.
  }
}

const SAFE_FAILURE_CODES = new Set([
  'onboarding_invalid_state',
  'onboarding_server_returned_cross_scope_identity',
  'onboarding_endpoint_invalid',
  'onboarding_endpoint_must_be_trusted_https_origin',
  'onboarding_server_returned_wrong_public_key_fingerprint',
  'onboarding_server_returned_unsafe_approval_path',
  'onboarding_invalid_expiry',
  'onboarding_invalid_capabilities',
  'onboarding_invalid_challenge_expiry',
  'onboarding_challenge_payload_invalid',
  'onboarding_challenge_cross_scope_or_invalid_binding',
  'onboarding_invalid_credential_expiry',
  'onboarding_actor_invalid',
  'onboarding_runtime_id_invalid',
  'onboarding_local_attempt_state_corrupt',
  'onboarding_local_public_key_fingerprint_mismatch',
  'onboarding_proof_key_missing_reauthorize',
  'onboarding_local_proof_key_invalid',
  'onboarding_local_proof_key_does_not_match_attempt',
  'onboarding_request_not_recorded',
  'onboarding_invitation_id_required',
  'onboarding_orphaned_proof_key_requires_operator_recovery',
  'onboarding_existing_credential_without_attempt_requires_operator_recovery',
  'onboarding_request_not_approved',
  'onboarding_local_credential_corrupt',
  'onboarding_local_credential_cross_scope_or_corrupt',
  'onboarding_credential_unavailable_run_setup',
  'onboarding_recovery_did_not_persist_credential',
  'onboarding_auth_header_target_not_allowed',
  'onboarding_sdk_authenticated_actor_mismatch',
  'onboarding_sdk_response_too_large',
  'onboarding_sdk_protocol_response_invalid',
  'onboarding_sdk_tool_list_invalid',
  'onboarding_sdk_ledger_read_tool_unavailable',
  'onboarding_sdk_ledger_read_tool_failed',
  'onboarding_sdk_ledger_read_result_invalid',
  'secure_store_response_too_large',
  'secure_store_operation_failed',
  'secure_store_response_invalid',
  'secure_store_value_required',
  'keychain_secure_store_failed',
  'secret_service_unavailable_or_lookup_failed',
  'secret_service_entry_invalid',
  'secret_service_store_failed',
  'secret_service_delete_failed',
  'hosted_secure_store_must_be_runtime_restricted',
  'onboarding_mcp_config_scope_invalid',
  'tsx_dependency_not_found_use_verified_distribution',
  'onboarding_input_invalid',
  'onboarding_response_invalid',
  'onboarding_response_too_large',
  'onboarding_request_failed',
  'onboarding_sdk_ledger_read_failed',
  'onboarding_sdk_mcp_failed',
  'onboarding_recovery_not_available',
  'onboarding_listener_parent_invalid',
  'onboarding_listener_failed',
  'secure_store_unsupported_platform',
]);

export function safeFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return 'runtime_onboarding_operation_failed';
  const message = error.message;
  if (SAFE_FAILURE_CODES.has(message)) return message;
  if (/^onboarding_(?:request_failed|sdk_ledger_read_failed|sdk_mcp_failed):[1-5]\d\d$/.test(message)) {
    return message.split(':')[0];
  }
  if (/^onboarding_recovery_not_available:(?:prepared|requested|approved|denied|cancelled|expired|revoked)$/.test(message)) {
    return 'onboarding_recovery_not_available';
  }
  if (/^secure_store_unsupported_platform:(?:win32|darwin|linux|freebsd|openbsd|sunos|aix)$/.test(message)) {
    return 'secure_store_unsupported_platform';
  }
  if (/^onboarding_invalid_[a-z0-9_]+$/.test(message)) {
    return 'onboarding_input_invalid';
  }
  if (/^onboarding_(?:request|sdk|sdk_ledger|sdk_ledger_tool)_response_invalid$/.test(message)) {
    return 'onboarding_response_invalid';
  }
  if (/^onboarding_(?:request|sdk|sdk_ledger|sdk_ledger_tool)_response_too_large$/.test(message)) {
    return 'onboarding_response_too_large';
  }
  if (message === 'dpapi_secure_store_failed'
    || /^dpapi_secure_store_failed:/.test(message) || /^secure_store_unavailable:/.test(message)) {
    return 'secure_store_operation_failed';
  }
  return 'runtime_onboarding_operation_failed';
}

/** Preserve the original failure line; additive diagnostics stay on stderr. */
export function safeFailureDiagnostics(error: unknown): string {
  const category = secureStoreDiagnosticCategory(error);
  return `runtime_onboarding_failed: ${safeFailureCode(error)}\n`
    + (category ? `runtime_onboarding_store_diagnostic: ${category}\n` : '');
}

export async function runRuntimeOnboardingCli(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    console.log(CLI_HELP);
    return;
  }
  const parsed = parseArguments(argv);
  const store = createNativeRuntimeOnboardingStore();
  const common = {
    endpoint: parsed.endpoint,
    actor: parsed.actor,
    runtimeId: parsed.runtimeId,
    store,
  };
  const client = new RuntimeOnboardingClient({
    ...common,
    ...(parsed.invitationId ? { invitationId: parsed.invitationId } : {}),
  });

  if (parsed.action === 'setup') {
    let request = await client.setup();
    if (parsed.waitForApproval && request.state === 'requested') {
      console.log(JSON.stringify({
        action: 'setup',
        phase: 'pending-approval',
        requestId: request.requestId,
        actor: request.actor,
        runtimeId: request.runtimeId,
        state: request.state,
        verificationCode: request.verificationCode,
        fingerprint: request.fingerprint,
        approvalPath: request.approvalPath,
        expiresAt: request.expiresAt,
        connected: false,
        credentialStored: await client.hasCredential(),
      }, null, 2));
      openApprovalPage(new URL(request.approvalPath, `${client.scope.endpoint}/`).toString());
      request = await client.waitForApproval((state) => {
        console.error(`runtime_onboarding_state:${state}`);
      });
      if (request.state === 'approved' || request.state === 'enrolled') {
        request = await client.setup();
      }
    }
    const credentialStored = await client.hasCredential();
    const connection = credentialStored ? await client.sdkCheck() : undefined;
    console.log(JSON.stringify({
      action: 'setup',
      phase: 'finished',
      requestId: request.requestId,
      actor: request.actor,
      runtimeId: request.runtimeId,
      state: request.state,
      ...(request.verificationCode ? { verificationCode: request.verificationCode } : {}),
      fingerprint: request.fingerprint,
      approvalPath: request.approvalPath,
      expiresAt: request.expiresAt,
      ...(request.capabilities ? { capabilities: request.capabilities } : {}),
      credentialStored,
      connected: connection?.connected === true,
      ...(connection ? { ledgerRead: connection.ledgerRead, mcpReadTool: connection.mcpReadTool } : {}),
      ...(parsed.waitForApproval && request.state === 'requested' ? { pendingApproval: true } : {}),
    }, null, 2));
    return;
  }

  if (parsed.action === 'status') {
    console.log(JSON.stringify(await client.localStatus(), null, 2));
    return;
  }

  const cliEntry = fileURLToPath(import.meta.url);
  if (parsed.action === 'mcp' && parsed.printConfig) {
    const sourceMode = cliEntry.endsWith('.ts');
    const tsxCli = sourceMode ? sourceCliTsxPath(cliEntry) : '';
    if (sourceMode && !existsSync(tsxCli)) throw new Error('tsx_dependency_not_found_use_verified_distribution');
    const config = generateRuntimeMcpClientConfig({
      executable: process.execPath,
      cliEntryPath: cliEntry,
      endpoint: client.scope.endpoint,
      actor: client.scope.actor,
      runtimeId: client.scope.runtimeId,
      ...(sourceMode ? { entryArguments: [tsxCli, cliEntry] } : {}),
    });
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  if (parsed.action === 'mcp') {
    await runRuntimeMcpStdioBridge({
      ...common,
      input: process.stdin,
      output: process.stdout,
      diagnostics: process.stderr,
    });
    return;
  }

  if (parsed.action === 'listen') {
    const exitCode = await runRuntimeOnboardingListener({
      ...common,
      ...(parsed.parentPid !== undefined ? { parentPid: parsed.parentPid } : {}),
      ...(parsed.stateDir ? { stateDir: parsed.stateDir } : {}),
      ...(parsed.mode ? { mode: parsed.mode } : {}),
      ...(parsed.after !== undefined ? { initialAfter: parsed.after } : {}),
      resume: parsed.resume === true,
    });
    process.exitCode = exitCode;
    return;
  }

  const transport = createRuntimeOpenAITransport(common);
  const result = await transport.client.sdkCheck();
  console.log(JSON.stringify({
    action: 'sdk',
    ...result,
    transport: 'authenticated Streamable HTTP MCP',
    credentialSource: 'native secure store',
  }, null, 2));
}

async function main(): Promise<void> {
  try {
    await runRuntimeOnboardingCli();
  } catch (error) {
    if (error instanceof Error && error.message === 'usage') {
      console.error(CLI_HELP);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(safeFailureDiagnostics(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main();
}