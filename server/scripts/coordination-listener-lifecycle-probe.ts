import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { ListenerStore } from './lib/coordination-listener';
import { observeListenerLifecycle } from './lib/coordination-listener-lifecycle';
import { closeProcessIdentityReader } from './lib/coordination-listener-identity';
import { isDirectCliInvocation } from './lib/cli-entrypoint';

function localPath(value: string) {
  const path = resolve(value), rel = relative(resolve('.local'), path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('evidence_path_must_be_under_local');
  return path;
}
export async function lifecycleProbeCli(argv = process.argv.slice(2)) {
  const command = argv.shift();
  if (!['observe', 'mark'].includes(command ?? '')) throw Error('invalid_command');
  const options: Record<string, string> = {};
  const allowed = new Set(command === 'mark' ? ['action', 'action-file']
    : ['actor', 'url', 'state-dir', 'action-file', 'output', 'timeout-ms']);
  while (argv.length) {
    const key = argv.shift()!;
    const value = argv.shift();
    if (!key.startsWith('--') || !allowed.has(key.slice(2)) || key.slice(2) in options ||
        !value || value.startsWith('--')) throw Error('invalid_option');
    options[key.slice(2)] = value;
  }
  const required = (key: string) => { if (!options[key]) throw Error(`required_${key}`); return options[key]; };
  const actionFile = localPath(required('action-file'));
  if (command === 'mark') {
    const action = required('action');
    if (!['closed', 'archived'].includes(action)) throw Error('invalid_action');
    await mkdir(dirname(actionFile), { recursive: true, mode: 0o700 });
    const temporary = `${actionFile}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ action, at: new Date().toISOString(), provenance: 'operator-reported' }),
        { flag: 'wx', mode: 0o600 });
      // Publish a complete action atomically, without overwriting/replaying an old one.
      await link(temporary, actionFile);
    } finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
    console.log('LUCAMSG_LIFECYCLE_ACTION_REPORTED not_independently_verified=true');
    return;
  }
  const output = localPath(required('output'));
  if (output === actionFile || !output.endsWith('.json')) throw Error('invalid_output');
  const timeoutMs = options['timeout-ms'] === undefined ? 120_000 : Number(options['timeout-ms']);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 300_000) throw Error('invalid_timeout');
  const hashes: Record<string, string> = {};
  for (const path of ['server/scripts/lib/coordination-listener.ts', 'server/scripts/lib/coordination-listener-identity.ts',
    'server/scripts/lib/coordination-listener-windows-reader.ts', 'server/scripts/lib/coordination-listener-lifecycle.ts',
    'server/scripts/coordination-listener-lifecycle-probe.ts', 'server/scripts/coordination-listener.ts',
    'server/scripts/lib/coordination-listener-ownership.ts']) {
    hashes[path] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  const evidence = await observeListenerLifecycle({
    store: new ListenerStore(resolve(required('state-dir')), { actor: required('actor'), apiUrl: required('url') }),
    actionFile, timeoutMs,
    ready: () => console.log('LUCAMSG_LIFECYCLE_READY baseline=live action=not-yet-reported'),
  });
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify({ ...evidence, hashes,
    hashProvenance: 'observer-checkout-not-listener-runtime-attestation' }, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(`LUCAMSG_LIFECYCLE_RESULT outcome=${evidence.outcome} platform=${evidence.platform} action=operator-reported`);
  process.exitCode = evidence.outcome === 'parent-gone-listener-clean' ? 0 : 2;
}
if (isDirectCliInvocation('coordination-listener-lifecycle-probe.ts')) {
  lifecycleProbeCli().catch(() => {
    console.error('LUCAMSG_LIFECYCLE_INVALID evidence_not_established=true');
    process.exitCode = 64;
  }).finally(closeProcessIdentityReader);
}
