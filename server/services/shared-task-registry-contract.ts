import { createHash } from 'node:crypto';
import { canonicalJson } from './task-ownership-service';
import { normalizeCoordinationRepositoryIdentity } from './coordination-repository-identity';

// Existing publication/preparation validators both cap artifacts at 256 KiB.
export const TASK_ARTIFACT_LIMIT = 256 * 1024;
export const TASK_ALLOCATION_FLOOR = '1000000';
export const TASK_ACTOR_DAILY_LIMIT = 20;
export const TASK_ACTOR_OUTSTANDING_LIMIT = 10;
export const TASK_STATES = ['proposed', 'active', 'blocked', 'completed', 'cancelled'] as const;
export class TaskRegistryError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export function fail(code: string): never { throw new TaskRegistryError(code); }
export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function taskReference(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,31}$/.test(value)) fail('INVALID_REFERENCE');
  return value;
}
export function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail('INVALID_DEFINITION');
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) fail('INVALID_DEFINITION');
  return value.map(v => text(v, 4000));
}
export type TaskInput = {
  repositoryIdentity: string; startingCommit: string; title: string; purpose: string;
  scope: string[]; exclusions: string[]; sourceThread: string; supersedes: string | null;
};
export function taskInput(raw: Record<string, unknown>): TaskInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_DEFINITION');
  let repositoryIdentity: string;
  try { repositoryIdentity = normalizeCoordinationRepositoryIdentity(raw.repositoryIdentity); }
  catch { return fail('INVALID_REPOSITORY'); }
  if (repositoryIdentity.length > 255 || typeof raw.startingCommit !== 'string' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(raw.startingCommit)) fail('INVALID_DEFINITION');
  const sourceThread = text(raw.sourceThread, 255);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(sourceThread)) fail('INVALID_SOURCE_THREAD');
  return {
    repositoryIdentity, startingCommit: raw.startingCommit,
    title: text(raw.title, 200), purpose: text(raw.purpose, 8000),
    scope: strings(raw.scope), exclusions: strings(raw.exclusions), sourceThread,
    supersedes: raw.supersedes == null ? null : taskReference(raw.supersedes),
  };
}
export function artifactBytes(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(TASK_ARTIFACT_LIMIT / 3) * 4) fail('INVALID_ARTIFACT');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > TASK_ARTIFACT_LIMIT || bytes.toString('base64') !== value ||
      Buffer.from(bytes.toString('utf8'), 'utf8').compare(bytes) !== 0) fail('INVALID_ARTIFACT');
  return bytes;
}
export function renderTaskArtifact(ref: string, actor: string, input: TaskInput): Buffer {
  return Buffer.from(`# Task ${ref}: ${input.title}\n\n${canonicalJson({
    taskRef: ref, creator: actor, sourceKind: 'hat', ...input,
    authority: 'Registry allocation and lifecycle labels do not grant ownership, approval, execution or publication.',
  })}\n`, 'utf8');
}
