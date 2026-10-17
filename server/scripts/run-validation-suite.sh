#!/usr/bin/env bash
#
# Single validation entry point for the Project workflow.
#
# The individual checks remain directly runnable, but are no longer registered
# as separate Replit workflows. Keep running after a failure so one suite run
# reports the complete health picture.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# O2/O3 containment: this suite contains DB-writing checks, so it holds itself
# (even when launched directly, not through scripts/launch-gate.sh) unless the
# target is the verified disposable CI database.
# shellcheck source=../../scripts/lib/disposable-target.sh
source "$ROOT/scripts/lib/disposable-target.sh"
hold_unless_disposable_target validation-suite

FAILED=()

run_check() {
  local label="$1"
  shift

  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "  CHECK: ${label}"
  echo "════════════════════════════════════════════════════════════"

  "$@"
  local rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "  ✓ PASSED: ${label}"
  else
    echo "  ✗ FAILED: ${label} (exit ${rc})" >&2
    FAILED+=("${label}")
  fi
}

# Fast project checks. Full consolidated CI is intentionally a separate named
# validation workflow so neither command can exceed Replit's validation timeout.
run_check "TypeScript typecheck" npm run typecheck
run_check "Provider-neutral release identity" npx tsx server/scripts/test-release-identity.ts
run_check "Required committed runtime sources" bash -c 'npx tsx server/scripts/check-required-runtime-sources.ts && npx tsx server/scripts/check-required-runtime-sources.ts --self-check'
# Use the same command-by-command runner as GitHub CI so validation exercises
# the precise test execution path and identifies the failing command.
run_check "Application test suite" npm run test:ci

# Source-bridge and GitHub transport safety.
run_check "Source bridge safety" npm run test:source-bridge
run_check "Source reconciliation safety" npm run test:source-reconciliation
run_check "Agent-note coordination ingress" npx tsx --test server/scripts/test-agent-note-coordination-ingress.test.ts
run_check "Standalone ownership proof and strict runtime-grant boundary" npx tsx --test server/services/task-ownership-client.test.ts
run_check "Team Room speaker attribution" npx tsx --test server/scripts/test-team-room-attribution-route.test.ts
run_check "GitHub release safety" npm run test:github-release-safety
run_check "GitHub sync shell guards" bash scripts/test-github-sync-guards.sh
run_check "GitHub main-branch bypass surface guard" bash -c 'npx tsx server/scripts/test-github-branch-bypass-guard.ts && npx tsx server/scripts/test-github-branch-bypass-guard.ts --self-check'
run_check "Cross-tool-promote push-auth guard" bash -c 'npx tsx server/scripts/test-cross-tool-promote-push-auth-guard.ts && npx tsx server/scripts/test-cross-tool-promote-push-auth-guard.ts --self-check'
run_check "Cross-tool-promote episode content-loss guard" bash -c 'npx tsx server/scripts/test-cross-tool-promote-content-loss-guard.ts && npx tsx server/scripts/test-cross-tool-promote-content-loss-guard.ts --self-check'
run_check "Cross-tool-promote stale-main guard" bash -c 'npx tsx server/scripts/test-cross-tool-promote-stale-main-guard.ts && npx tsx server/scripts/test-cross-tool-promote-stale-main-guard.ts --self-check'
run_check "Agent skills cross-hat symlink guard" bash -c 'npx tsx server/scripts/test-agent-skills-symlink.ts && npx tsx server/scripts/test-agent-skills-symlink.ts --self-check'
run_check "CLI entrypoint guard regression scan" bash -c 'npx tsx server/scripts/test-cli-entrypoint-guard-pattern.ts && npx tsx server/scripts/test-cli-entrypoint-guard-pattern.ts --self-check'
run_check "Antigravity Windows DPAPI source boundary" npx tsx --test server/scripts/test-antigravity-windows-dpapi.test.ts
run_check "Coordinator V2 first-host bootstrap boundary" npx tsx --test server/scripts/test-coordination-v2-first-host-bootstrap.test.ts
run_check "Coordinator V2 lifecycle diagnostics cleanup fault fallback and evidence suites" npx tsx --test \
  server/scripts/test-coordination-lifecycle-facade.test.ts \
  server/scripts/test-coordination-windows-host.test.ts \
  server/scripts/test-coordination-v2-cli.test.ts \
  server/scripts/test-coordination-errors.test.ts \
  server/scripts/test-coordination-session-status.test.ts \
  server/scripts/test-coordination-cleanup.test.ts \
  server/scripts/test-coordination-v2-e2e.test.ts \
  server/scripts/test-coordination-v2-fault-injection.test.ts \
  server/scripts/test-coordination-v2-provider-fallback.test.ts \
  server/scripts/test-coordination-gemini-provider-driver.test.ts \
  server/scripts/test-coordination-v2-evidence-integrity.test.ts \
  server/scripts/test-coordination-v2-host-completion-boundary.test.ts \
  server/scripts/test-coordination-v2-host-factory-route.test.ts \
  server/scripts/test-coordination-v2-dpapi-contract.test.ts \
  server/scripts/test-coordination-v2-authority-seams.test.ts \
  server/scripts/test-coordination-v2-public-material-digest.test.ts \
  server/scripts/test-coordination-v2-deferred-session.test.ts \
  server/scripts/test-coordinator-v2-schema.test.ts
run_check "Coordinator V2 PowerShell enrollment object contract" npx tsx --test server/scripts/test-coordination-v2-powershell-contract.test.ts
run_check "Coordinator V2 staged first-host enrollment contract" npx tsx --test server/scripts/test-coordination-v2-staged-enrollment-contract.test.ts
run_check "Coordinator V2 authenticated runtime bootstrap" npx tsx --test \
  server/services/coordination-v2-runtime-bootstrap-service.test.ts \
  server/scripts/test-coordination-v2-runtime-bootstrap-http.test.ts \
  server/scripts/test-coordination-v2-windows-runtime-bootstrap-static.test.ts
run_check "Coordinator V2 host credential reauthorization" npx tsx --test \
  server/services/coordination-v2-host-reauthorization-contract.test.ts \
  server/services/coordination-v2-host-reauthorization-validation.test.ts \
  server/scripts/test-coordination-v2-host-reauthorization-static.test.ts
run_check "Release cutover attestation service" npx tsx --test server/services/release-cutover-attestation-service.test.ts
run_check "Shared-spec live-instruction-document PostgreSQL integration" npx tsx --test server/scripts/test-shared-spec-live-instruction-document-postgres.test.ts
run_check "Alden review-discovery tool (list_shared_spec_reviews) against a real Postgres database" npx tsx --test server/scripts/test-alden-shared-spec-review-discovery.test.ts
run_check "Shared-spec review-claim race: two reviewers cannot both win claiming the same open review" npx tsx --test server/scripts/test-shared-spec-review-claim-race-postgres.test.ts
run_check "Shared-spec review-assign/decision race: reassignment and approve/reject cannot silently overwrite each other" npx tsx --test server/scripts/test-shared-spec-review-assign-decision-race-postgres.test.ts
run_check "Shared-spec review-decision effects (working-tree write/commit + review_decided notification)" npx tsx --test server/services/shared-spec-review-decision.test.ts
run_check "Shared-spec review-decision bypass guard (no direct core.approveReview/rejectReview outside the wrapper)" bash -c 'npx tsx server/scripts/test-shared-spec-review-decision-bypass-guard.ts && npx tsx server/scripts/test-shared-spec-review-decision-bypass-guard.ts --self-check'
run_check "Alden's own shared-spec review-decision entry point (real singleton wiring) PostgreSQL integration" npx tsx --test server/scripts/test-alden-shared-spec-review-postgres.test.ts
run_check "Coordination runtime Gate3 claim/execute/complete/verify lifecycle" npx tsx --test server/scripts/test-coordination-runtime.test.ts
run_check "Coordination runtime envelope-violation-recovery self-check" npx tsx server/scripts/test-coordination-runtime-envelope-violation-selfcheck.ts
run_check "Coordination runtime standing-verifier self-check" npx tsx server/scripts/test-coordination-runtime-verifier-standing-selfcheck.ts
run_check "Coordination actor completeness self-check (ALL_COORDINATION_ACTORS)" npx tsx server/scripts/test-coordination-actor-completeness-selfcheck.ts
run_check "Coordination runtime live HTTP /verify route (standing verifier, no fabricated profile)" npx tsx --test server/scripts/test-coordination-runtime-http.test.ts
run_check "Coordination runtime Antigravity e2e (real Express Gate3 lifecycle)" npx tsx --test server/scripts/coordination-runtime-antigravity-e2e.test.ts

# Checks intentionally kept outside consolidated-ci because they are
# independent growth-cap or workflow-boundary checks.
run_check "Replit attribution discipline" npx tsx server/scripts/test-replit-attribution-discipline.ts
run_check "Episode 28 gap audit self-check" npx tsx server/scripts/audit-episode-28-gaps.ts --self-check
# Replit-only: this self-check reads the real canonical Episode 28 row
# (conversation_memories WHERE id = EPISODE_ID) from NEON_SHARED_DATABASE_URL
# and calls process.exit(1) if that specific row is missing. GitHub Actions'
# job-local disposable Postgres never has this row, so this would be a false
# failure there, not a caught regression -- keep it out of run-ci-test-steps.mjs.
run_check "Episode 28 startup shrinkage self-check" npx tsx server/scripts/restore-episode-28-from-db.ts --self-check
run_check "Episode content-loss guard self-check (all docs/episode-*.md, direct commit or merge)" npx tsx server/scripts/check-episode-content-loss.ts --self-check
run_check "Episode dialogue-loss detector self-check" npx tsx server/scripts/detect-episode-dialogue-loss.ts --self-check
run_check "Episode dialogue-loss detector (live, recency-gated scan)" npx tsx server/scripts/detect-episode-dialogue-loss.ts
run_check "Capture status ordering" npx tsx server/scripts/test-capture-status-ordering.ts
run_check "Truth-pipeline unified recall diagnosis" npx tsx server/scripts/test-truth-pipeline-unified-recall-diagnosis.ts
run_check "Capture status stale escalation" npx tsx server/scripts/test-capture-status-stale-escalation.ts
run_check "Canonical Claude Code/Replit conversation capture" npx tsx server/scripts/test-canonical-conversation-capture.ts
run_check "Canonical capture worker readiness" npx tsx server/scripts/test-canonical-capture-worker-readiness.ts
# Replit-only: this check calls a running local application server's health
# route and needs COORDINATION_LUCA_REPLIT_TOKEN. GitHub Actions never starts
# the app server before running tests, so this cannot execute there --
# keep it out of run-ci-test-steps.mjs.
run_check "Live canonical capture health route" npx tsx server/scripts/test-canonical-capture-health-route.ts
run_check "Chat capture episode mirror outbox" npx tsx server/scripts/test-chat-capture-episode-outbox.ts
run_check "Episode lifecycle createEpisode() reuse-not-duplicate guard" npx tsx server/scripts/test-episode-lifecycle-create-dedup.ts
# NOT run automatically here or from scripts/run-ci-test-steps.mjs: this test
# briefly flips the shared DB's live 'rolling' tag to a disposable row. The
# Team Room/chat hook's 60s rolling-name cache (server/services/team-room-episode-hook.ts)
# means a real chat write can keep resolving to the disposable filename for up
# to a minute after the flip, well past the test's own back-to-back promote/
# restore window and its own tag-based restoration check -- so a real
# conversation turn can land on the disposable row and be permanently deleted
# with it even when the test reports full success. Run it manually and
# deliberately (during a quiet period, watching for concurrent activity)
# before changing promoteRollingEpisode() itself. See
# .agents/memory/episode-lifecycle-service-guards.md.
# run_check "Episode lifecycle promoteRollingEpisode() success-path guard" npx tsx server/scripts/test-episode-lifecycle-promote-success.ts
run_check "set-rolling-episode bad-name exit-code guard" npx tsx server/scripts/test-set-rolling-episode-bad-name.ts
run_check "set-rolling-episode self-check (not-found lookup + transaction rollback atomicity)" npx tsx server/scripts/set-rolling-episode.ts --self-check
run_check "set-rolling-episode --self-check hang guard (fails fast instead of silently hanging on an open DB pool)" bash -c 'npx tsx server/scripts/test-set-rolling-episode-selfcheck-hang.ts && npx tsx server/scripts/test-set-rolling-episode-selfcheck-hang.ts --self-check'
run_check "Legacy watchdog source-identity repair fixtures" npx tsx --test server/scripts/repair-preincident-watchdog-source-identity.test.ts
run_check "Claude Code/Replit agent inbox lifecycle" npx tsx server/scripts/test-agent-notes-inbox.ts
run_check "Alden provider tool and consult-auth contract" npx tsx server/scripts/test-alden-provider-tool-projection.ts
run_check "Alden lossless coordination paging and message chunks" npx tsx --test server/scripts/test-alden-coordination-read.test.ts
run_check "Alden workspace-root portability guard" bash -c 'npx tsx server/scripts/test-alden-workspace-root-portability.ts && npx tsx server/scripts/test-alden-workspace-root-portability.ts --self-check'
run_check "Alden dual-engine self-report guard" bash -c 'npx tsx server/scripts/test-alden-dual-engine-self-report.ts && npx tsx server/scripts/test-alden-dual-engine-self-report.ts --self-check'
run_check "Linked-outcome messaging architecture" npx tsx server/scripts/test-linked-outcome-static-guard.ts
run_check "Failed lookup felt-history boundary" npx tsx --test server/__tests__/daniela-memory-boundary.test.ts
run_check "Live exchange accounting lifecycle" npx tsx --test server/__tests__/voice-exchange-accounting.test.ts
run_check "Live voice provider routing" npx tsx --test server/__tests__/live-voice-routing.test.ts
run_check "Inner-life no-episode-row guard" npx tsx server/scripts/test-inner-life-no-episode-row.ts
run_check "Agent-memory round-trip gate isolation" npx tsx --test server/scripts/test-agent-memory-round-trip-gate-isolation.test.ts
run_check "Agent-memory drift guard self-check" npx tsx server/scripts/test-agent-memory-drift-guard.ts --self-check
run_check "Shared-spec mutation-guard scripts' CI wiring (package.json + neon-branch.ts cmdGate)" npx tsx --test server/scripts/test-shared-spec-guards-ci-wiring.test.ts
# Replit-only: normal mode scopes its findings to the .agents/memory/*.md
# paths THIS checkout's own git working tree shows as locally modified,
# deleted, or untracked, so it only has real signal in a long-running
# interactive checkout where a hand-edit could actually happen between
# commits. A fresh GitHub Actions checkout has nothing locally modified
# relative to the single commit it just cloned -- there is no interactive
# session in which a hand-edit could occur -- so this would always
# trivially report zero findings there and add nothing but runtime. Keep
# it out of run-ci-test-steps.mjs.
run_check "Agent-memory drift guard (live, working-tree scoped)" npx tsx server/scripts/test-agent-memory-drift-guard.ts
run_check "Live-instruction-document drift guard self-check" npx tsx server/scripts/check-live-instruction-document-drift.ts --self-check
# Replit-only: normal mode queries the real shared-spec database for every
# liveInstructionDocument: true document and reads this checkout's real
# git-tracked files for each. GitHub Actions' disposable, job-local database
# is schema-only -- it never has docs/shared-agent-instructions.md or
# docs/coordination-clients.md seeded (see seed-live-instruction-
# documents.ts) -- so this could never observe a real drift there, only ever
# report "no liveInstructionDocument: true documents are recorded yet" and
# add nothing but runtime. Keep it out of run-ci-test-steps.mjs.
run_check "Live-instruction-document drift guard (live)" npx tsx server/scripts/check-live-instruction-document-drift.ts
run_check "GL reconnected client recovery" npx tsx server/scripts/test-gl-reconnected-client-recovery.ts
run_check "GL game-session detector" bash -c 'npx tsx server/scripts/test-gl-game-session-detector.ts && npx tsx server/scripts/test-gl-game-session-detector.ts --self-check'
run_check "Raw-window capture alignment" npx tsx server/scripts/test-raw-window-capture.ts --self-check
run_check "Memory-decay startup schema guard" bash -c 'npx tsx server/scripts/test-memory-decay-startup-schema-guard.ts && npx tsx server/scripts/test-memory-decay-startup-schema-guard.ts --self-check'
run_check "Application startup recovery" bash server/scripts/test-start-application-recovery.sh
run_check "Application startup recovery self-check" bash server/scripts/test-start-application-recovery.sh --self-check
run_check "Infra-mutation ownership guard (Cloudflare DNS, GitHub spec publish)" npx tsx --test server/scripts/test-infra-mutation-ownership-guard.test.ts
run_check "Infra-mutation ownership guard (Neon branch create/delete)" npx tsx --test scripts/neon-branch.test.ts
run_check "Infra-mutation ownership guard (cross-tool-promote dispatch)" npx tsx --test scripts/cross-tool-promote.test.ts
run_check "Infra-mutation ownership guard (reconciliation archive upload/replicate)" npx tsx --test scripts/reconciliation-history-object-storage.test.ts
run_check "Infra-mutation ownership guard (reconciliation archive wrapper script)" npx tsx --test scripts/archive-reconciliation-history.test.ts
run_check "Infra-mutation ownership guard (source-control-cli sync)" npx tsx --test server/scripts/test-source-control-cli-sync-ownership-guard.test.ts
run_check "Infra-mutation ownership guard (source-promotion sync)" npx tsx --test server/scripts/test-source-promotion-sync-ownership-guard.test.ts
run_check "Source-mutation write guard (server/scripts writes stay out of client/src, server/, shared/)" npx tsx --test server/scripts/scan-source-mutation-writes.test.ts
run_check "Cross-hat skill discovery symlink" bash -c 'npx tsx server/scripts/test-agent-skills-symlink.ts && npx tsx server/scripts/test-agent-skills-symlink.ts --self-check'
# Meta-guard: every run_check line above must also be reachable from
# scripts/run-ci-test-steps.mjs, or a regression here would only ever be
# caught by a manual/task-completion validation run, not by GitHub CI on a
# PR. See server/scripts/test-validation-suite-ci-parity.ts for the
# documented Replit-only allowlist (currently: the Episode 28 self-check
# above, which reads the real Neon row, and the live capture health-route
# check, which needs a running app server -- neither exists in GitHub's
# disposable CI environment).
run_check "Validation-suite to CI parity guard" bash -c 'npx tsx server/scripts/test-validation-suite-ci-parity.ts && npx tsx server/scripts/test-validation-suite-ci-parity.ts --self-check'
echo ""
echo "════════════════════════════════════════════════════════════"
if [[ ${#FAILED[@]} -eq 0 ]]; then
  echo "  ALL VALIDATION SUITE CHECKS PASSED"
  echo "════════════════════════════════════════════════════════════"
  exit 0
fi

echo "  FAILED CHECKS: ${FAILED[*]}" >&2
echo "════════════════════════════════════════════════════════════" >&2
exit 1