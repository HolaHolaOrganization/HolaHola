import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { InboxPage, ListenerScope } from './coordination-listener';

/** Runs only the existing trusted inbox CLI; no shell, message execution, or model launch. */
export function fetchListenerInbox(scope: ListenerScope, after: number, token: string | undefined,
  signal: AbortSignal, options: { spawnImpl?: typeof spawn; timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<InboxPage> {
  return new Promise((resolvePage, reject) => {
    if (signal.aborted) return reject(new Error('inbox_aborted'));
    const child = (options.spawnImpl ?? spawn)(process.execPath, ['--import', 'tsx',
      resolve('server/scripts/coordination-cli.ts'), 'inbox', '--url', scope.apiUrl, '--limit', '50',
      ...(token ? ['--token', token] : ['--after', String(after)])],
    { cwd: process.cwd(), env: { ...process.env, COORDINATION_ACTOR: scope.actor },
      stdio: ['ignore', 'pipe', 'ignore'], shell: false, windowsHide: true });
    let output = '';
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error, page?: InboxPage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      child.kill(); // Own direct Node subprocess only; it launches no descendants.
      error ? reject(error) : resolvePage(page!);
    };
    const abort = () => finish(new Error('inbox_aborted'));
    const timer = setTimeout(() => finish(new Error('inbox_timeout')), options.timeoutMs ?? 45_000);
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > (options.maxOutputBytes ?? 4 * 1024 * 1024)) return finish(new Error('inbox_output_limit'));
      output += chunk;
    });
    child.on('error', () => finish(new Error('inbox_spawn_failed')));
    child.on('close', code => {
      if (code !== 0) return finish(new Error('inbox_request_failed'));
      try { finish(undefined, JSON.parse(output)); } catch { finish(new Error('inbox_invalid_json')); }
    });
  });
}
