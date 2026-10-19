import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectCliInvocation } from './lib/cli-entrypoint';
import { launchBootSupervisor, superviseBootListener, workspaceBootConfig, writeBootFailure } from './lib/coordination-listener-boot';
import { closeProcessIdentityReader } from './lib/coordination-listener-identity';
import { recordBootDiagnosticEntry } from './lib/coordination-listener-boot-diagnostic';

const entry = fileURLToPath(import.meta.url);
const config = workspaceBootConfig(resolve(dirname(entry), '../..'));

export async function listenerBootCli(args = process.argv.slice(2)) {
  const command = args[0] ?? 'launch';
  if (args.length > 1 || !['launch', 'supervise', 'status'].includes(command)) throw new Error('invalid_boot_command');
  if (command === 'status') {
    console.log(await readFile(join(config.stateDir, 'boot/status.json'), 'utf8'));
    return;
  }
  if (process.platform !== 'linux' || process.env.NODE_ENV === 'production'
      || ['prod', 'production'].includes(process.env.HOLAHOLA_INSTANCE_ROLE ?? '')
      || (process.env.COORDINATION_RUNTIME_ID && process.env.COORDINATION_RUNTIME_ID !== config.runtimeId)
      || (process.env.COORDINATION_CLI_CREDENTIAL_CACHE_DIR
        && resolve(process.env.COORDINATION_CLI_CREDENTIAL_CACHE_DIR) !== config.cacheDir)) {
    throw new Error('boot_workspace_configuration_mismatch');
  }
  await readFile(join(config.root, '.replit')); // No launch outside the expected workspace checkout.
  if (command === 'supervise') await superviseBootListener(config);
  else await launchBootSupervisor(config, entry);
}

if (isDirectCliInvocation('coordination-listener-boot.ts')) {
  (async () => {
    // Status/import remain read-only. No wrapper tag means no diagnostic write.
    if (!process.argv[2] || process.argv[2] === 'launch') await recordBootDiagnosticEntry(config.root);
    await listenerBootCli();
  })().catch(async () => {
    // No underlying error, environment, cache body, or remote response is printable.
    console.error('LUCABOOT failed-closed recovery-required');
    if (process.argv[2] === 'status') { process.exitCode = 1; return; }
    // An unsuccessful duplicate launcher must not overwrite a live supervisor's health.
    await writeBootFailure(config).catch(() => {});
    process.exitCode = 1;
  }).finally(closeProcessIdentityReader);
}
