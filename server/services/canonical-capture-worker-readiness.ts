export type CanonicalCaptureWorkerReadiness = {
  phase: 'stopped' | 'arming' | 'armed';
  armed: boolean;
  startedAt: number | null;
  armedAt: number | null;
};

let readiness: CanonicalCaptureWorkerReadiness = {
  phase: 'stopped',
  armed: false,
  startedAt: null,
  armedAt: null,
};

export function beginCanonicalCaptureWorkerStartup(now = Date.now()): boolean {
  if (readiness.phase !== 'stopped') return false;
  readiness = {
    phase: 'arming',
    armed: false,
    startedAt: now,
    armedAt: null,
  };
  return true;
}

export function markCanonicalCaptureWorkerArmed(now = Date.now()): void {
  readiness = {
    ...readiness,
    phase: 'armed',
    armed: true,
    startedAt: readiness.startedAt ?? now,
    armedAt: now,
  };
}

export function getCanonicalCaptureWorkerReadiness(): CanonicalCaptureWorkerReadiness {
  return { ...readiness };
}

export function isCanonicalCaptureAvailable(
  workspaceReady: boolean,
  worker: CanonicalCaptureWorkerReadiness = readiness,
): boolean {
  return workspaceReady && worker.armed;
}

export function evaluateCanonicalCaptureHealth(
  workspaceReady: boolean,
  worker: CanonicalCaptureWorkerReadiness = readiness,
): { status: 200 | 503; ok: boolean } {
  const ok = isCanonicalCaptureAvailable(workspaceReady, worker);
  return { status: ok ? 200 : 503, ok };
}

export function resetCanonicalCaptureWorkerReadinessForTest(): void {
  readiness = {
    phase: 'stopped',
    armed: false,
    startedAt: null,
    armedAt: null,
  };
}

export type CanonicalEpisodeProjectionGates = {
  liveModeRequested: boolean;
  episodeWritesEnabled: boolean;
  routingValidated: boolean;
};

export type CanonicalEpisodeProjectionTarget = {
  resolution: 'blocked' | 'resolved' | 'unresolved';
  filename: string | null;
  pinnedTargetSet: boolean;
  misrouteAlertActive: boolean;
};

/**
 * Configuration and queue evidence only. An empty queue (or an acknowledged
 * source cursor) cannot prove that an exchange was ever queued for an episode.
 * Null means the queue could not be inspected, not that it was empty.
 */
export function evaluateCanonicalEpisodeProjectionHealth(
  gates: CanonicalEpisodeProjectionGates,
  pendingMirrors: number | null,
  details: {
    outboxDirectoryPresent: boolean | null;
    target: CanonicalEpisodeProjectionTarget | null;
  } = { outboxDirectoryPresent: null, target: null },
) {
  const reasons: string[] = [];
  if (!gates.liveModeRequested) reasons.push('live-mode-not-requested');
  if (!gates.episodeWritesEnabled) reasons.push('episode-writes-disabled');
  if (!gates.routingValidated) reasons.push('rolling-episode-routing-unvalidated');
  const queueAvailable = pendingMirrors !== null &&
    Number.isSafeInteger(pendingMirrors) && pendingMirrors >= 0;
  if (!queueAvailable) reasons.push('mirror-queue-unavailable');
  const state = !gates.liveModeRequested || !gates.episodeWritesEnabled
    ? 'disabled'
    : !gates.routingValidated || !queueAvailable
      ? 'blocked'
      : pendingMirrors! > 0 ? 'pending' : 'unverified';
  return {
    state,
    reasons,
    gates: { ...gates },
    queue: {
      available: queueAvailable,
      pendingMirrors: queueAvailable ? pendingMirrors : null,
      directoryPresent: details.outboxDirectoryPresent,
    },
    target: details.target ? { ...details.target } : null,
    evidenceScope: 'runtime-gates-and-queue-only',
    episodeCompletionProven: false,
  };
}
