/**
 * Orientation briefing text for Alden's brief_new_actor tool.
 *
 * Two kinds of fact are kept visibly separate: operations-catalog entries
 * scoped to the actor (what the catalog says it may do), and the capabilities
 * of its currently enabled, unrevoked runtime registrations (what the
 * credential broker will actually grant). Neither is inferred from the other.
 * Pure: callers supply the catalog manifest and registration summaries.
 */
export interface BriefingOperation {
  id: string;
  title: string;
  purpose: string;
}

export interface BriefingRegistration {
  runtimeId: string;
  actor: string;
  capabilities: readonly string[];
  enabled: boolean;
  revokedAt: string | null;
}

/** Enabled, unrevoked registrations of this actor, in stable runtime-id order. */
export function activeRegistrationsFor(actor: string, registrations: readonly BriefingRegistration[]): BriefingRegistration[] {
  return registrations
    .filter((registration) => registration.actor === actor && registration.enabled && !registration.revokedAt)
    .sort((a, b) => a.runtimeId.localeCompare(b.runtimeId));
}

/**
 * What each coordination capability actually grants, taken from where it is
 * enforced (coordination-auth.ts capability mapping, the runtime, credential,
 * observer and onboarding routes) so a briefing never has to guess from the
 * name. On 2026-10-25 observation:read was described to a new hat as
 * "monitoring data, health checks"; it is the live Daniela session view.
 */
export const COORDINATION_CAPABILITY_DEFINITIONS: Readonly<Record<string, string>> = {
  'coordination:read': 'read coordination threads, your inbox and the agent feed (GET requests on the coordination API and MCP read tools).',
  'coordination:write': 'create threads and post replies or events on the coordination ledger, always as yourself.',
  'coordination:inbox:ack': 'acknowledge your own inbox and feed position, marking what you have actually read.',
  'coordination:credential:renew': 'renew your own runtime credential before it expires, and mark a staged rotation ready.',
  'coordination:credential:revoke': "revoke your own runtime's credentials, for example after a suspected leak. It does not reach other actors.",
  'observation:read': "read a live Daniela session through /api/admin/luca/observe: the session's in-memory state and its recent messages (the most recently active session when none is named). Observing Daniela from different perspectives is the core purpose of the Luca hats. While this is still being tested, keep it gentle: one snapshot at a time, when David or the active task asks for one.",
  'coordination:runtime:admin': "register new runtimes and revoke any actor's runtime or credentials. Standing delegated authority, founder-granted.",
};

export function describeCapability(capability: string): string {
  return COORDINATION_CAPABILITY_DEFINITIONS[capability] ?? 'no definition recorded yet; ask before relying on it.';
}

export function buildActorBriefing(
  operations: readonly BriefingOperation[],
  activeRegistrations: readonly BriefingRegistration[],
  /** The MCP server's real tool names (coordinationMcpToolNames); never typed by hand. */
  mcpToolNames: readonly string[] = [],
): string {
  const registrationLines = activeRegistrations.length === 0
    ? ['- None. This actor has no enabled, unrevoked runtime registration, so it cannot authenticate yet.']
    : activeRegistrations.map((registration) =>
      `- ${registration.runtimeId}: ${[...registration.capabilities].sort().join(', ') || '(no capabilities)'}`);
  const granted = [...new Set(activeRegistrations.flatMap((registration) => registration.capabilities))].sort();
  return [
    'You already have access to the following, verified against the shared operations catalog:',
    '',
    ...operations.map((operation) => `- ${operation.title} (${operation.id}): ${operation.purpose}`),
    '',
    'Registered runtime capabilities, read from your enabled runtime registrations (what the credential broker grants each runtime):',
    '',
    ...registrationLines,
    ...(granted.length === 0 ? [] : [
      '',
      'What each of those capabilities lets you do:',
      '',
      ...granted.map((capability) => `- ${capability}: ${describeCapability(capability)}`),
    ]),
    ...(mcpToolNames.length === 0 ? [] : [
      '',
      'To read and reply through the coordination MCP server, use these exact tool names:',
      '',
      ...[...mcpToolNames].sort().map((name) => `- ${name}`),
      '',
      'Reply on this thread with your checkout\'s commit and how far it is from origin/main, then your questions. '
        + 'The New hat quickstart in docs/runtime-onboarding-clients.md covers connecting and the Windows execution-policy behaviour.',
    ]),
    '',
    'Canonical references:',
    '- docs/coordination-clients.md — coordination runtime placement, scope, and the full-feed/inbox split.',
    '- docs/coordination-new-actor-onboarding.md — how new capabilities and actors get added to this system.',
  ].join('\n');
}
