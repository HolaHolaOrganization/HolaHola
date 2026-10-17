#!/usr/bin/env bash
# Launch gate for standalone writers and DB-writing validation runs
# (standard-controls plan efb1e3d1 rev 13, step 1: O2/O3 containment).
#
#   bash scripts/launch-gate.sh <id> -- <command> [args...]
#
# Decides BEFORE the command (and therefore before any of its imports or side
# effects) whether it may run. Every registered id writes shared state, so it
# may run ONLY against a verified disposable CI database:
#   CI=true, CI_DATABASE_URL on 127.0.0.1/localhost, and
#   NEON_SHARED_DATABASE_URL exactly equal to CI_DATABASE_URL
# (the same rule as getVerifiedCiDatabaseUrl in server/ci-database.ts).
# Anywhere else, including a Replit workspace or any live database, the command
# is HELD: it does not run, a NOT RUN line is printed, and the gate exits 0 so a
# platform restart loop does not treat the hold as a crash.
#
# Unknown ids, a missing "--", or a missing command refuse with exit 2.
# Lifting a hold for live data is a reviewed change to this registry, never an
# environment flag.
set -Eeuo pipefail

REGISTERED_IDS=(
  capture-watchdog          # canonical capture drains (held: capture/incident hold)
  rolling-episode-restore   # restore-rolling-episodes-from-db.ts (UPDATEs conversation_memories)
  validation-suite          # server/scripts/run-validation-suite.sh (contains DB-writing checks)
  consolidated-ci           # server/scripts/test-all-consolidated-ci.sh
  luca-chat-canonical-save  # inserts and deletes rows through the live route
)

id="${1:-}"
if [[ -z "$id" || "${2:-}" != "--" || $# -lt 3 ]]; then
  echo "[launch-gate] usage: launch-gate.sh <id> -- <command> [args...]" >&2
  exit 2
fi
shift 2

registered=false
for known in "${REGISTERED_IDS[@]}"; do
  [[ "$known" == "$id" ]] && registered=true
done
if [[ "$registered" != true ]]; then
  echo "[launch-gate] REFUSED: unknown id '${id}' (not in the registry)" >&2
  exit 2
fi

disposable_target() {
  [[ "${CI:-}" == "true" ]] || return 1
  local url="${CI_DATABASE_URL:-}"
  [[ -n "$url" ]] || return 1
  [[ "${NEON_SHARED_DATABASE_URL:-}" == "$url" ]] || return 1
  [[ "$url" =~ ^postgres(ql)?://([^@/]*@)?(127\.0\.0\.1|localhost)(:[0-9]+)?/ ]] || return 1
  return 0
}

if disposable_target; then
  exec "$@"
fi

echo "[launch-gate] NOT RUN: '${id}' is HELD — it writes shared state and may run only against a verified disposable CI database (instance role: ${HOLAHOLA_INSTANCE_ROLE:-unset})."
exit 0
