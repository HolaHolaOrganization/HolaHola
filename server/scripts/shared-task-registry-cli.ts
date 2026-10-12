import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { materializeRegistryArtifact } from '../services/shared-task-registry-materialize';
import { ownershipEndpoint } from '../services/task-ownership-attempt';
import { normalizeCoordinationRepositoryIdentity } from '../services/coordination-repository-identity';
import { taskReference, TaskRegistryError } from '../services/shared-task-registry-contract';

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  const options: Record<string, string> = {};
  while (args.length) {
    const key = args.shift()!;
    const value = args.shift();
    if (!/^--(?:url|actor|input|idempotency-key|ref|after|limit)$/.test(key) || !value || value.startsWith('--') || key in options) throw new TaskRegistryError('INVALID_OPTIONS');
    options[key] = value;
  }
  const endpoint = ownershipEndpoint(options['--url'] || '');
  const actor = options['--actor'];
  const tokenKey: Record<string, string> = {
    'luca-replit': 'COORDINATION_LUCA_REPLIT_TOKEN', 'luca-claude-code': 'COORDINATION_LUCA_CLAUDE_CODE_TOKEN',
    'luca-gemini': 'COORDINATION_LUCA_GEMINI_TOKEN', 'luca-antigravity': 'COORDINATION_LUCA_ANTIGRAVITY_TOKEN',
    'luca-holahola': 'COORDINATION_LUCA_HOLAHOLA_TOKEN', 'luca-cursor': 'COORDINATION_LUCA_CURSOR_TOKEN',
    'luca-openai-agents': 'COORDINATION_LUCA_OPENAI_AGENTS_TOKEN',
  };
  const token = process.env[tokenKey[actor]];
  if (!token) throw new TaskRegistryError('ACTOR_CREDENTIAL_REQUIRED');
  let path = '/api/task-registry/tasks', method = 'GET', body: string | undefined;
  if (['create', 'import', 'transition'].includes(command!)) {
    if (!options['--input']) throw new TaskRegistryError('INPUT_FILE_REQUIRED');
    body = await readFile(options['--input'], 'utf8');
    JSON.parse(body);
    method = 'POST';
    if (command === 'import') path = '/api/task-registry/imports';
    if (command === 'transition') path += `/${taskReference(options['--ref'])}/transitions`;
    else if (!options['--idempotency-key']) throw new TaskRegistryError('IDEMPOTENCY_KEY_REQUIRED');
  } else if (command === 'list') {
    const params = new URLSearchParams();
    if (options['--after']) params.set('after', options['--after']);
    if (options['--limit']) params.set('limit', options['--limit']);
    path += `?${params}`;
  } else if (['show', 'materialize'].includes(command!)) {
    path += `/${taskReference(options['--ref'])}${command === 'materialize' ? '/artifact' : ''}`;
  } else throw new TaskRegistryError('COMMAND_REQUIRED');
  const response = await fetch(endpoint + path, { method, body, headers: {
    'content-type': 'application/json', 'x-coordination-token': token,
    ...(options['--idempotency-key'] ? { 'idempotency-key': options['--idempotency-key'] } : {}),
  }, signal: AbortSignal.timeout(20_000) });
  const result = await response.json();
  if (!response.ok) throw new TaskRegistryError(
    typeof result.error?.code === 'string' && /^[A-Z_]{1,80}$/.test(result.error.code)
      ? result.error.code : 'REGISTRY_REQUEST_FAILED');
  if (command === 'materialize') {
    const { stdout } = await promisify(execFile)('git', ['remote', 'get-url', 'origin'], { cwd: process.cwd() });
    const repository = normalizeCoordinationRepositoryIdentity(stdout.trim());
    console.log(JSON.stringify(await materializeRegistryArtifact(process.cwd(), repository, result)));
  } else console.log(JSON.stringify(result));
}
main().catch(err => { console.error(err instanceof TaskRegistryError ? err.code : 'REGISTRY_REQUEST_FAILED'); process.exitCode = 1; });
