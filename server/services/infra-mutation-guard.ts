import { TaskOwnershipService, type TaskOwnershipResult } from './task-ownership-service';

/**
 * Scope note: cross-tool-promote supplies a fresh server-backed proof probe at
 * both mutation boundaries. Other callers must supply their own verified probe;
 * the default deliberately denies rather than inferring authority from files.
 */

/**
 * Thrown when an infra-mutating call is refused because task ownership
 * cannot be proven (`unknown_stop`). Callers should treat this the same way
 * the task-ownership CLI's exit code 75 is treated for file edits: stop,
 * don't retry, surface it.
 */
export class InfraMutationBlockedError extends Error {
  readonly code = 'INFRA_MUTATION_BLOCKED';

  constructor(
    readonly action: string,
    readonly taskRef: string,
    readonly state: TaskOwnershipResult['state'],
    readonly explanation: string,
  ) {
    super(
      `Refusing infra mutation "${action}" for task ${taskRef}: ownership state is "${state}" (${explanation})`,
    );
    this.name = 'InfraMutationBlockedError';
  }
}

/**
 * `actorId` is optional so existing probes (e.g. Cloudflare's) that only
 * care about `taskRef` keep working unchanged. A probe that can bind
 * evidence to a specific authenticated actor -- not just a bare task
 * reference -- should use it; see createGitHubPublishOwnershipProbe in
 * shared-spec-github-publish-guard.ts for why that binding matters.
 */
export type OwnershipProbe = (taskRef: string, actorId?: string) => Promise<TaskOwnershipResult>;

const defaultProbe: OwnershipProbe = (taskRef) => new TaskOwnershipService().probe(taskRef);

/**
 * Gate for any code path that mutates external, credentialed infrastructure
 * (DNS providers, deploy/release APIs, and similar) on behalf of a task.
 *
 * Context: `TaskOwnershipService` + the CLI already fail closed (exit code
 * 75) on `unknown_stop` for file edits in the checkout. That gate never
 * covered a task's own code calling an external API directly -- task #1453's
 * Cloudflare DNS cutover for getholahola.com went live in production while
 * the task itself was sitting at `unknown_stop`, because nothing stood
 * between the task and the Cloudflare API (see
 * .agents/memory/task-ownership-guard-scope.md). This closes that gap: call
 * it before any mutating external call and let it throw instead of
 * proceeding. Read-only calls carry no external-state risk and should not be
 * gated by this.
 */
export async function assertOwnershipForInfraMutation(
  taskRef: string,
  action: string,
  probe: OwnershipProbe = defaultProbe,
  actorId?: string,
): Promise<TaskOwnershipResult> {
  const result = await probe(taskRef, actorId);
  if (result.state === 'unknown_stop') {
    throw new InfraMutationBlockedError(action, taskRef, result.state, result.explanation);
  }
  return result;
}
