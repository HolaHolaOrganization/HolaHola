#!/usr/bin/env bash
# Start the development application without ever competing for its port.
#
# Project starts this command through the Start application child workflow, but
# that child can also be started directly. The lock closes the startup race
# between those two paths; the port check also recognizes servers started by an
# older command that did not take this lock.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-5000}"
LOCK_FILE="${START_APPLICATION_LOCK_FILE:-.local/start-application.lock}"

mkdir -p -- "$(dirname -- "$LOCK_FILE")"

port_is_listening() {
  # lsof is available in the Replit runtime and gives the most reliable
  # listener check. Keep a bash-only fallback for environments where it is not
  # installed.
  if command -v lsof >/dev/null 2>&1 &&
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
    return 0
  fi
  (exec 3<>"/dev/tcp/127.0.0.1/$PORT") >/dev/null 2>&1
}

wait_for_existing_server() {
  echo "[start-application] reusing the existing server on port ${PORT}; this workflow will not start another one."
  while port_is_listening; do
    sleep 5
  done
  echo "[start-application] existing server on port ${PORT} stopped; ending the reused workflow."
}

exec 9>"$LOCK_FILE"

# A second launcher may arrive while the first is still running migrations
# before it binds the port. Wait for either the first server to become visible
# or the lock to be released by a failed startup. In the latter case this
# invocation safely becomes the one that starts the server.
if ! flock -n 9; then
  echo "[start-application] another startup owns ${LOCK_FILE}; waiting for it to bind port ${PORT}."
  while true; do
    if port_is_listening; then
      wait_for_existing_server
      exit 0
    fi
    if flock -n 9; then
      break
    fi
    sleep 1
  done
fi

# This covers a server started directly before the singleton launcher was
# introduced, as well as a server whose startup lock is not shared with us.
if port_is_listening; then
  wait_for_existing_server
  exit 0
fi

# GitHub's SSH host key is not pre-trusted in a fresh container, so the first
# SSH-transport git operation against github.com — ours or a background one
# (Replit's own git integration, `git maintenance`, etc.) — hangs forever on
# an interactive "authenticity of host ... can't be established" prompt
# instead of failing fast. That has repeatedly wedged this repo's
# .git/index.lock for 20-100+ minutes, starving out any other git operation
# against this repo, including platform task-agent merges. See
# .agents/memory/ssh-git-hang-pitfalls.md. Pre-trusting the key here — pinned
# and verified, not blindly accepted — closes that hang at its source on
# every startup. Keep the pinned key in sync with scripts/github-release-ssh.sh.
trust_github_ssh_host_key() {
  local pinned="github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
  local known_hosts="${HOME:-/root}/.ssh/known_hosts"
  if [[ -f "$known_hosts" ]] && grep -qF "$pinned" "$known_hosts" 2>/dev/null; then
    return 0
  fi
  mkdir -p -- "$(dirname -- "$known_hosts")"
  local scanned
  scanned="$(timeout 5 ssh-keyscan -t ed25519 github.com 2>/dev/null | grep -v '^#')" || true
  if [[ "$scanned" == "$pinned" ]]; then
    printf '%s\n' "$scanned" >>"$known_hosts"
    echo '[start-application] pre-trusted github.com SSH host key (prevents SSH hang on background git fetches)'
  else
    echo '[start-application] WARNING: could not verify github.com SSH host key (network unavailable or key mismatch) — continuing without pre-trust, a background SSH git fetch may hang' >&2
  fi
}
trust_github_ssh_host_key

git config merge.ours.driver true ||
  echo '[merge.ours] WARNING: git config failed — merge=ours will not protect rolling episodes' >&2

# O2/O3 containment: this restore writes conversation_memories, so it runs only
# through the launch gate (held except against a verified disposable CI DB).
bash scripts/launch-gate.sh rolling-episode-restore -- \
  npx tsx server/scripts/restore-rolling-episodes-from-db.ts --check-shrinkage ||
  echo '[rolling-restore] WARNING: shrinkage check failed — continuing' >&2

# Keep the lock descriptor open in the server process so another launcher
# cannot race this one after the port check.
exec npm run dev