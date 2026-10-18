#!/usr/bin/env bash
# Sourced policy for O2/O3 containment (plan efb1e3d1 rev 13, step 1), shared by
# scripts/launch-gate.sh and by shell entrypoints that must hold even when they
# are launched directly rather than through the gate.
#
# A held entrypoint may run ONLY against a verified disposable CI database:
#   CI=true, CI_DATABASE_URL on 127.0.0.1/localhost, and
#   NEON_SHARED_DATABASE_URL exactly equal to CI_DATABASE_URL
# (the same rule as getVerifiedCiDatabaseUrl in server/ci-database.ts).

disposable_target() {
  [[ "${CI:-}" == "true" ]] || return 1
  local url="${CI_DATABASE_URL:-}"
  [[ -n "$url" ]] || return 1
  [[ "${NEON_SHARED_DATABASE_URL:-}" == "$url" ]] || return 1
  [[ "$url" =~ ^postgres(ql)?://([^@/]*@)?(127\.0\.0\.1|localhost)(:[0-9]+)?/ ]] || return 1
  return 0
}

# Returns when the target is disposable; otherwise prints NOT RUN and exits 0
# so a platform restart loop does not treat the hold as a crash. A clean hold
# exit is NOT a passing run.
hold_unless_disposable_target() {
  local id="$1"
  disposable_target && return 0
  echo "[launch-gate] NOT RUN: '${id}' is HELD — it writes shared state and may run only against a verified disposable CI database (instance role: ${HOLAHOLA_INSTANCE_ROLE:-unset}). This is a hold, not a passing run."
  exit 0
}
