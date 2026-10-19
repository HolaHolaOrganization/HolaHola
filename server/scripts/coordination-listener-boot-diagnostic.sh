#!/bin/sh
# Prepared diagnostic hook, not a replacement for listener readiness evidence.
# No arguments, arbitrary commands, output capture, credential access or retries.
set -eu
umask 077

fail() {
  printf '%s\n' 'LUCABOOT diagnostic-wrapper-unavailable' >&2
  exit 1
}

[ "$#" -eq 0 ] || fail
root=$(CDPATH= cd -P -- "${0%/*}/../.." && pwd -P) || fail
cd "$root" || fail

# Refuse symlink/non-directory ancestors rather than redirect local writes.
for directory in \
  .local \
  .local/coordination-listeners \
  .local/coordination-listeners/luca-replit \
  .local/coordination-listeners/luca-replit/boot \
  .local/coordination-listeners/luca-replit/boot/diagnostics
do
  [ ! -L "$directory" ] || fail
  if [ -e "$directory" ] && [ ! -d "$directory" ]; then fail; fi
  mkdir -p "$directory" || fail
done

invocation=$(mktemp -d .local/coordination-listeners/luca-replit/boot/diagnostics/invocation.XXXXXXXXXX) || fail
events="$invocation/events.log"
# The invocation directory is new/private. Never truncate an existing target.
(set -C; : > "$events") || fail
record() {
  at=$(date -u +%Y-%m-%dT%H:%M:%SZ) || fail
  printf '%s phase=%s pid=%s\n' "$at" "$1" "$$" >> "$events" || fail
}

record shell-invoked
if ! command -v node >/dev/null 2>&1; then
  record node-unavailable
  exit 127
fi
record node-exec-attempt
HOLAHOLA_LISTENER_BOOT_DIAGNOSTIC_RUN=${invocation##*/}
export HOLAHOLA_LISTENER_BOOT_DIAGNOSTIC_RUN
# Preserve the existing launcher PID/argv/lifetime and its original output.
# Do not wait for a child, pipe output, capture raw errors, or start supervise.
exec node --import tsx "$root/server/scripts/coordination-listener-boot.ts"
