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

export function buildActorBriefing(
  operations: readonly BriefingOperation[],
  activeRegistrations: readonly BriefingRegistration[],
): string {
  const registrationLines = activeRegistrations.length === 0
    ? ['- None. This actor has no enabled, unrevoked runtime registration, so it cannot authenticate yet.']
    : activeRegistrations.map((registration) =>
      `- ${registration.runtimeId}: ${[...registration.capabilities].sort().join(', ') || '(no capabilities)'}`);
  return [
    'You already have access to the following, verified against the shared operations catalog:',
    '',
    ...operations.map((operation) => `- ${operation.title} (${operation.id}): ${operation.purpose}`),
    '',
    'Registered runtime capabilities, read from your enabled runtime registrations (what the credential broker grants each runtime):',
    '',
    ...registrationLines,
    '',
    'Canonical references:',
    '- docs/coordination-clients.md — coordination runtime placement, scope, and the full-feed/inbox split.',
    '- docs/coordination-new-actor-onboarding.md — how new capabilities and actors get added to this system.',
  ].join('\n');
}
