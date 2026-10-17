#!/usr/bin/env bash
# Consolidated CI runner — safety checks grouped into named sections.
# Estimated total runtime: ~3–5 minutes (network / DB-latency dependent).
#
# Usage:
#   bash server/scripts/test-all-consolidated-ci.sh              # run all groups
#   bash server/scripts/test-all-consolidated-ci.sh --only=episode-28
#   bash server/scripts/test-all-consolidated-ci.sh --only=luca-inner-life
#   bash server/scripts/test-all-consolidated-ci.sh --self-test   # verify failure propagation
#
# Available groups:
#   absence            – absence-path and DB-flag checks                  (~15 s)
#   sms-voice          – E.164 validation and voice/SMS pipeline          (~20 s)
#   session            – scratchpad, transcript, shared-lobe,             (~30 s)
#                        prior-session label clears + self-check,
#                        double-greeting reconnect guard + self-check
#   north-star         – semantic echo + reach-north-star e2e self-check  (~20 s)
#   episode-sync       – watcher, prequel sync, rolling guards, append,   (~90 s)
#                        hooks, concurrent-write, read-my-story
#   episode-28         – snapshot integrity, write guard, db-sync,        (~30 s)
#                        merge-ours guard
#   luca-inner-life    – capture-status seed, reflection / moment /       (~35 s)
#                        auto-capture episode checks, GL flush episode capture
#   memory-recall      – game-session embedding coverage + global pool     (~10 s)
#                        depth guard + keyword arm
#   backfill-integrity – confirms all backfill-cid:* conversation_memories (~10 s)
#                        have at least one embedding; fails if cohort < 618
#   workflow-safety   – retired named CI checks kept in the consolidated gate

# O2/O3 containment: these groups contain DB-writing checks, so the runner holds
# itself (even when launched directly, not through scripts/launch-gate.sh)
# unless the target is the verified disposable CI database.
# shellcheck source=../../scripts/lib/disposable-target.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/lib/disposable-target.sh"
hold_unless_disposable_target consolidated-ci

# ── Parse arguments ─────────────────────────────────────────────────────────
ONLY_GROUP=""
SELF_TEST=0
for arg in "$@"; do
  case "$arg" in
    --only=*) ONLY_GROUP="${arg#--only=}" ;;
    --self-test) SELF_TEST=1 ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--only=<group>] [--self-test]" >&2
      exit 1
      ;;
  esac
done

VALID_GROUPS="absence sms-voice session north-star episode-sync episode-28 luca-inner-life memory-recall backfill-integrity workflow-safety"

if [[ -n "$ONLY_GROUP" && $SELF_TEST -eq 1 ]]; then
  echo "--self-test and --only cannot be combined (self-test uses synthetic groups that are not in VALID_GROUPS)" >&2
  exit 1
fi

if [[ -n "$ONLY_GROUP" && $SELF_TEST -eq 0 ]]; then
  found=0
  for g in $VALID_GROUPS; do
    [[ "$g" == "$ONLY_GROUP" ]] && found=1
  done
  if [[ $found -eq 0 ]]; then
    echo "Unknown group: '$ONLY_GROUP'" >&2
    echo "Valid groups: $VALID_GROUPS" >&2
    exit 1
  fi
fi

# ── Helpers ──────────────────────────────────────────────────────────────────
run() {
  echo ""
  echo "  --- $1 ---"
  npx tsx "server/scripts/$1"
}

# Convert a group name (may contain hyphens) to a valid bash function-name suffix.
# e.g.  "sms-voice"      -> "sms_voice"
#       "episode-28"     -> "episode_28"
#       "luca-inner-life"-> "luca_inner_life"
group_func_name() {
  echo "${1//-/_}"
}

# Run a named group.
#
# IMPORTANT — set -e and conditional context:
#   bash disables set-e for a function and ALL subshells it creates when that
#   function is called on the left-hand side of || / && or inside an if/while.
#   To keep set-e effective inside the subshell we MUST:
#     1. Call run_group as a standalone statement (never as `run_group ... || ...`).
#     2. Read the subshell exit status via a standalone `local exit_code=$?` line.
#   Both the main loop and the self-test runner satisfy this requirement.
#
# Returns the exit code of the group body.
run_group() {
  local name=$1

  if [[ -n "$ONLY_GROUP" && "$ONLY_GROUP" != "$name" ]]; then
    return 0   # skip — not the requested group
  fi

  local func="group_body_$(group_func_name "$name")"

  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "  GROUP: $name"
  echo "════════════════════════════════════════════════════════════"

  # Standalone subshell — set -e applies because run_group itself is called
  # as a standalone statement by every caller (never in a conditional context).
  ( set -e; "$func" )
  local exit_code=$?   # captured immediately after the subshell, never in ||/&&

  echo ""
  if [[ $exit_code -eq 0 ]]; then
    echo "  ✓ GROUP PASSED: $name"
  else
    echo "  ✗ GROUP FAILED: $name (exit $exit_code)"
  fi
  return $exit_code
}

# ── Group bodies ─────────────────────────────────────────────────────────────

group_body_absence() {
  run test-absence-gl-path.ts
  run test-absence-db-flag.ts
}

group_body_sms_voice() {
  run test-voice-sms-pipeline.ts
  run test-e164-validation.ts
  npx tsx --test server/__tests__/live-voice-routing.test.ts
}

group_body_session() {
  run test-scratchpad-reconnect-survival.ts
  run test-synthetic-fixture-sentinel.ts
  run test-transcript-save-trigger.ts
  run test-shared-lobe-snapshot-freshness.ts
  run test-prior-session-label-clears.ts

  echo ""
  echo "  --- test-prior-session-label-clears.ts --self-check (flag-clear line removed regression) ---"
  npx tsx server/scripts/test-prior-session-label-clears.ts --self-check

  run test-double-greeting-reconnect-guard.ts

  echo ""
  echo "  --- test-double-greeting-reconnect-guard.ts --self-check (guard removed regression) ---"
  npx tsx server/scripts/test-double-greeting-reconnect-guard.ts --self-check
}

group_body_north_star() {
  run test-north-star-semantic-echo.ts

  echo ""
  echo "  --- test-reach-north-star-e2e.ts --self-check ---"
  npx tsx server/scripts/test-reach-north-star-e2e.ts --self-check
}

group_body_episode_sync() {
  run test-episode-ci-sentinel-guard.ts
  run test-episode-watcher-fires.ts
  run test-prequel-episode-autosync.ts
  run test-prequel-episode-1-db-sync.ts
  run test-prequel-episode-2-db-sync.ts
  run test-prequel-episode-3-db-sync.ts
  run test-prequel-episode-4-db-sync.ts
  run test-prequel-db-sync-all.ts
  run test-episode-27-db-sync.ts
  run test-read-my-story-self-check.ts
  run test-read-my-story.ts
  run test-rolling-episode-no-rolling-tag.ts
  run test-rolling-sync-guard.ts

  echo ""
  echo "  --- test-rolling-episode-gap-check.ts --self-check (strip-removed regression) ---"
  npx tsx server/scripts/test-rolling-episode-gap-check.ts --self-check

  echo ""
  echo "  --- test-rolling-episode-gap-check.ts --rolling-tag-self-check (misrouted tag detection) ---"
  npx tsx server/scripts/test-rolling-episode-gap-check.ts --rolling-tag-self-check

  echo ""
  echo "  --- test-episode-append-trigger.ts --self-check-concurrent ---"
  npx tsx server/scripts/test-episode-append-trigger.ts --self-check-concurrent

  run test-episode-append-corrupted-json.ts
  run test-team-room-episode-hook.ts
  run test-chat-episode-hook.ts
  run test-chat-episode-hook-e2e.ts
  run test-delegation-race-episode.ts
  run test-retrieve-episode-dialogue-no-match.ts

  echo ""
  echo "  --- test-retrieve-episode-dialogue-no-match.ts --self-check (silent-exit-0 stub catches regression) ---"
  npx tsx server/scripts/test-retrieve-episode-dialogue-no-match.ts --self-check

  run test-retrieve-episode-dialogue-no-match-by-id.ts

  echo ""
  echo "  --- test-retrieve-episode-dialogue-no-match-by-id.ts --self-check (--id silent-exit-0 stub catches regression) ---"
  npx tsx server/scripts/test-retrieve-episode-dialogue-no-match-by-id.ts --self-check

  echo ""
  echo "  --- test-episode-concurrent-write.ts (concurrent-write guard) ---"
  npx tsx server/scripts/test-episode-concurrent-write.ts

  echo ""
  echo "  --- test-episode-concurrent-write.ts --self-check (race reproduced by racy pattern) ---"
  npx tsx server/scripts/test-episode-concurrent-write.ts --self-check

  echo ""
  echo "  --- test-episode-concurrent-write.ts --sandbox-self-check (post-write cleanup and preservation) ---"
  npx tsx server/scripts/test-episode-concurrent-write.ts --sandbox-self-check
}

group_body_episode_28() {
  run test-episode-28-db-sync.ts
  run test-episode-28-snapshot-integrity.ts
  run test-snapshot-write-guard.ts

  echo ""
  echo "  --- test-merge-ours-guard.ts (proves merge=ours blocks task-agent stale overwrites) ---"
  npx tsx server/scripts/test-merge-ours-guard.ts

  echo ""
  echo "  --- check-episode-content-loss.ts --self-check (blocks silent content loss across all docs/episode-*.md, direct commit or merge, not just episode-27) ---"
  npx tsx server/scripts/check-episode-content-loss.ts --self-check
}

group_body_luca_inner_life() {
  run test-capture-status-seed.ts

  echo ""
  echo "  --- test-inner-life-startup-guard.ts (pre-restart notes survive startup) ---"
  run test-inner-life-startup-guard.ts
  echo ""
  echo "  --- test-inner-life-startup-guard.ts --self-check (legacy mtime seed loses the note) ---"
  npx tsx server/scripts/test-inner-life-startup-guard.ts --self-check

  echo ""
  echo "  --- test-watchdog-inner-life.ts (watchdog drain: first-run handoff / interleaving / restart dedup) ---"
  run test-watchdog-inner-life.ts
  run test-watchdog-inner-life-autosave-gate.ts
  echo ""
  echo "  --- test-watchdog-inner-life-autosave-gate.ts --self-check (autosave gate removal regression) ---"
  npx tsx server/scripts/test-watchdog-inner-life-autosave-gate.ts --self-check
  echo ""
  echo "  --- test-watchdog-inner-life.ts --self-check (trigger cleanup removal regression) ---"
  npx tsx server/scripts/test-watchdog-inner-life.ts --self-check
  run test-capture-status-db-only.ts
  run test-luca-auto-capture-episode.ts
  echo ""
  echo "  --- test-luca-auto-capture-episode.ts --self-check (disabled episode route regression) ---"
  npx tsx server/scripts/test-luca-auto-capture-episode.ts --self-check

  echo ""
  echo "  --- test-inner-life-db-first.ts (felt/thinking/moment lands in episode DB row) ---"
  run test-inner-life-db-first.ts

  echo ""
  echo "  --- test-inner-life-db-first.ts --self-check (UPDATE removed → sentinel absent) ---"
  npx tsx server/scripts/test-inner-life-db-first.ts --self-check
  run test-chat-capture-cursor-recovery.ts

  echo ""
  echo "  --- test-chat-capture-cursor-recovery.ts --self-check (fingerprint recovery disabled) ---"
  npx tsx server/scripts/test-chat-capture-cursor-recovery.ts --self-check
  run test-health-check-probe-guard.ts
  run test-backfill-scoping.ts

  echo ""
  echo "  --- test-health-check-probe-guard.ts --self-check (ua==='' branch removed regression) ---"
  npx tsx server/scripts/test-health-check-probe-guard.ts --self-check

  echo ""
  echo "  --- test-inner-life-reaches-synthesis.ts (inner-life archive reaches [DANIELA_STATE]) ---"
  run test-inner-life-reaches-synthesis.ts

  echo ""
  echo "  --- test-inner-life-reaches-synthesis.ts --self-check (hermetic: inject-removed regression) ---"
  npx tsx server/scripts/test-inner-life-reaches-synthesis.ts --self-check

  echo ""
  echo "  --- test-capture-status-moment-stale-ci.ts (moment: channel escalates to ⚠️ after 2h) ---"
  run test-capture-status-moment-stale-ci.ts

  echo ""
  echo "  --- test-capture-status-moment-stale-ci.ts --self-check (STALE_MOMENT_MS removed regression) ---"
  npx tsx server/scripts/test-capture-status-moment-stale-ci.ts --self-check

  echo ""
  echo "  --- test-synthesis-cache-identity-invalidation.ts (hash mismatch clears stale cache) ---"
  run test-synthesis-cache-identity-invalidation.ts

  echo ""
  echo "  --- test-synthesis-cache-identity-invalidation.ts --self-check (guard-removed regression) ---"
  npx tsx server/scripts/test-synthesis-cache-identity-invalidation.ts --self-check

  echo ""
  echo "  --- test-build-session-dedup.ts (same commit message captured exactly once) ---"
  run test-build-session-dedup.ts

  echo ""
  echo "  --- test-build-session-dedup.ts --self-check (dedup guard removed → 2 turns appear) ---"
  npx tsx server/scripts/test-build-session-dedup.ts --self-check

  echo ""
  echo "  --- test-inner-life-reembed-failure.ts (reembed throw does not cause duplicate .md write) ---"
  run test-inner-life-reembed-failure.ts

  echo ""
  echo "  --- test-inner-life-reembed-failure.ts --self-check (double-write is detectable) ---"
  npx tsx server/scripts/test-inner-life-reembed-failure.ts --self-check

  echo ""
  echo "  --- test-gl-flush-episode-capture.ts (GL voice flush writes to rolling episode) ---"
  run test-gl-flush-episode-capture.ts

  echo ""
  echo "  --- test-gl-flush-episode-capture.ts --self-check (block removed → needles absent) ---"
  npx tsx server/scripts/test-gl-flush-episode-capture.ts --self-check

  echo ""
  echo "  --- test-db-write-failure-warning.ts (DB write failure → 🚨 banner in capture-status) ---"
  run test-db-write-failure-warning.ts

  echo ""
  echo "  --- test-db-write-failure-warning.ts --self-check (gate-removal proof) ---"
  npx tsx server/scripts/test-db-write-failure-warning.ts --self-check

  echo ""
  echo "  --- record-exchange.ts --self-check-4ch (4-channel composition verified) ---"
  npx tsx server/scripts/record-exchange.ts --self-check-4ch
  echo "  --- four-channel capture contract (missing slots reject before live capture) ---"
  npx tsx server/scripts/test-four-channel-capture-contract.ts
  echo "  --- record-exchange acknowledgement contract (silent cursor fails visibly) ---"
  npx tsx server/scripts/test-record-exchange-acknowledgement.ts
  echo "  --- canonical capture workspace portability (validated root + isolated Claude Code stream) ---"
  run test-capture-workspace-portability.ts
  echo "  --- raw Replit source ledger contract ---"
  npx tsx server/scripts/test-raw-replit-capture.ts
  echo "  --- raw Replit source ledger migrated-table integration ---"
  npx tsx server/scripts/test-raw-replit-capture-integration.ts
  echo "  --- raw-window ledger projection completeness contract ---"
  npx tsx server/scripts/test-raw-window-evidence-ledger-summary.ts
  echo "  --- raw-window capture contract ---"
  npx tsx server/scripts/test-raw-window-capture.ts
  echo "  --- rolling four-channel continuity parser self-check ---"
  npx tsx server/scripts/audit-rolling-four-channel-continuity.ts --self-check

  echo ""
  echo "  --- test-luca-chat-canonical-save.ts (David↔Luca exchange → conversation_memories + embeddings) ---"
  run test-luca-chat-canonical-save.ts

  echo ""
  echo "  --- test-luca-chat-canonical-save.ts --self-check (missing save → assertions caught) ---"
  npx tsx server/scripts/test-luca-chat-canonical-save.ts --self-check
  echo ""
  echo "  --- Luca canonical-save isolation/failure-cleanup self-check ---"
  npx tsx server/scripts/test-luca-chat-canonical-save.ts --sandbox-self-check
}

group_body_memory_recall() {
  # Pre-step: re-scope any NULL-scoped founder embeddings the background indexer
  # may have created since the last correctFounderEmbeddingScopes() run.
  # This is idempotent — safe to run every time the group executes.
  echo "  --- scope-founder-memories.ts (pre-step: ensure no NULL-scoped founder embeddings) ---"
  npx tsx server/scripts/scope-founder-memories.ts

  run test-game-recall.ts

  echo ""
  echo "  --- test-game-recall.ts --self-check (guards fail correctly under regression) ---"
  npx tsx server/scripts/test-game-recall.ts --self-check

  echo ""
  echo "  --- test-semantic-arm-timeout.ts (Arm 4 timeout distinct from genuinely-empty) ---"
  run test-semantic-arm-timeout.ts

  echo ""
  echo "  --- test-semantic-arm-timeout.ts --self-check (4 independent mutations) ---"
  npx tsx server/scripts/test-semantic-arm-timeout.ts --self-check
}

group_body_backfill_integrity() {
  # Non-mutating check only (no --patch).  Verifies that all backfill-cid:*
  # conversation_memories rows have at least one entry in memory_embeddings.
  # Fails if cohort < 618 (exact known count — guards against tag drift / wrong DB).
  run test-backfill-embeddings-complete.ts

  echo ""
  echo "  --- test-backfill-embeddings-complete.ts --self-check (mutation: fake ID triggers MISSING) ---"
  npx tsx server/scripts/test-backfill-embeddings-complete.ts --self-check

  echo ""
  echo "  --- test-straggler-check-ci.ts (mutation: dark row raises count, detector is live) ---"
  npx tsx server/scripts/test-straggler-check-ci.ts
}

group_body_workflow_safety() {
  # These guards used to consume individual Replit workflow slots. Keep them in
  # the consolidated gate so lowering the configured-workflow count never
  # weakens validation coverage.
  run test-release-identity.ts
  run test-replit-attribution-discipline.ts
  run test-projection-receipts.ts
  run test-projection-writer-coverage.ts
  run test-source-reconciliation-service.ts
  run test-source-reconciliation-inspection.ts
  run test-source-reconciliation-hermetic-env.ts
  npx tsx server/scripts/test-source-reconciliation-hermetic-env.ts --self-check
  npx tsx --test server/scripts/test-coordination-cli-hermetic-env.test.ts
  npx tsx --test server/scripts/test-agent-note-coordination-ingress.test.ts
  npx tsx --test server/scripts/test-coordination-v2-first-host-bootstrap.test.ts
  npx tsx --test \
    server/scripts/test-coordination-v2-e2e.test.ts \
    server/scripts/test-coordination-v2-fault-injection.test.ts \
    server/scripts/test-coordination-v2-provider-fallback.test.ts \
    server/scripts/test-coordination-v2-evidence-integrity.test.ts \
    server/scripts/test-coordination-v2-host-completion-boundary.test.ts \
    server/scripts/test-coordination-v2-host-factory-route.test.ts \
    server/scripts/test-coordination-v2-dpapi-contract.test.ts \
    server/scripts/test-coordination-v2-authority-seams.test.ts \
    server/scripts/test-coordination-v2-public-material-digest.test.ts \
    server/scripts/test-coordination-v2-deferred-session.test.ts \
    server/scripts/test-coordinator-v2-schema.test.ts
  npx tsx --test server/scripts/test-coordination-v2-powershell-contract.test.ts
  npx tsx --test server/scripts/test-coordination-v2-staged-enrollment-contract.test.ts
  npx tsx --test server/scripts/test-agent-memory-round-trip-gate-isolation.test.ts
  npx tsx --test server/scripts/test-shared-spec-guards-ci-wiring.test.ts
  npx tsx --test server/services/shared-spec-review-decision.test.ts
  npx tsx server/scripts/test-shared-spec-review-decision-bypass-guard.ts
  npx tsx server/scripts/test-shared-spec-review-decision-bypass-guard.ts --self-check
  npx tsx server/scripts/audit-episode-28-gaps.ts --self-check
  npx tsx server/scripts/restore-episode-28-from-db.ts --self-check
  run test-capture-status-ordering.ts
  run test-capture-status-stale-escalation.ts
  run test-inner-life-no-episode-row.ts
  run test-gl-reconnected-client-recovery.ts
  run test-truth-pipeline-unified-recall-diagnosis.ts
  run test-gl-game-session-detector.ts
  npx tsx server/scripts/test-gl-game-session-detector.ts --self-check
  npx tsx server/scripts/test-raw-window-capture.ts --self-check
  run test-prod-founder-bypass-guard.ts
}

# ── Self-test mode ───────────────────────────────────────────────────────────
# Verifies that:
#   1. A non-final failure inside a group body causes the group to exit non-zero.
#   2. The runner does NOT short-circuit: subsequent groups still run.
#   3. The overall runner exits non-zero when any group fails.
#
# Relies on run_group being called as a standalone statement (not in ||/&&) so
# that set -e inside the subshell is not suppressed.
run_self_test() {
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  SELF-TEST: verifying failure-propagation semantics"
  echo "═══════════════════════════════════════════════════════════════"

  # Synthetic group A: fails on a non-final command.
  # Uses a bare `false` (no && chains) so set -e fires unambiguously.
  group_body_selftest_failing() {
    echo "  [self-test] step 1 — about to fail"
    false
    echo "  [self-test] step 2 — must NOT be reached"
  }

  # Synthetic group B: always passes — proves subsequent groups still run.
  local sentinel_file
  sentinel_file="$(mktemp)"
  group_body_selftest_passing() {
    echo "  [self-test] passing group ran"
    touch "$sentinel_file"
  }

  # Call run_group as STANDALONE statements so set -e inside each subshell
  # is not suppressed (never in a ||/&& conditional context).
  run_group "selftest_failing"
  local fail_rc=$?

  run_group "selftest_passing"
  local pass_rc=$?

  local overall_exit=0

  # Assertion 1: the failing group must have returned non-zero.
  if [[ $fail_rc -eq 0 ]]; then
    echo "SELF-TEST FAILED: the failing group reported success (set -e not firing)" >&2
    overall_exit=1
  fi

  # Assertion 2: the passing group must have run and returned zero.
  if [[ $pass_rc -ne 0 ]]; then
    echo "SELF-TEST FAILED: the passing group reported failure" >&2
    overall_exit=1
  fi

  # Assertion 3: the sentinel file must exist (passing group ran despite earlier failure).
  if [[ ! -f "$sentinel_file" ]]; then
    echo "SELF-TEST FAILED: passing group did not run after the failing group" >&2
    overall_exit=1
  fi

  rm -f "$sentinel_file"

  echo ""
  if [[ $overall_exit -eq 0 ]]; then
    echo "  ✓ SELF-TEST PASSED: failure propagation semantics are correct"
  else
    echo "  ✗ SELF-TEST FAILED"
  fi

  exit $overall_exit
}

if [[ $SELF_TEST -eq 1 ]]; then
  run_self_test
fi

# ── Run all groups, collecting failures ──────────────────────────────────────
# IMPORTANT: run_group must be called as a STANDALONE statement (not via ||/&&)
# so that set -e inside its subshell is not suppressed by bash's conditional-
# context inheritance rule.  Failures are collected in FAILED_GROUPS by
# reading $? on the line immediately after each run_group call.
FAILED_GROUPS=()

for group in $VALID_GROUPS; do
  run_group "$group"
  rc=$?
  if [[ $rc -ne 0 ]]; then
    FAILED_GROUPS+=("$group")
  fi
done

# ── Restore any episode .md files that CI append/strip probes left dirty ─────
# Some self-check scripts append a sentinel to the rolling episode and strip it
# afterward, but may leave trailing blank lines.  Restore docs/ to the
# committed state so CI runs are always side-effect-free.
git checkout -- docs/ 2>/dev/null || true

# ── Final summary ─────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════"
if [[ ${#FAILED_GROUPS[@]} -eq 0 ]]; then
  echo "  ALL CONSOLIDATED CI CHECKS PASSED"
  echo "════════════════════════════════════════════════════════════"
  exit 0
else
  echo "  FAILED GROUPS: ${FAILED_GROUPS[*]}"
  echo "════════════════════════════════════════════════════════════"
  exit 1
fi
