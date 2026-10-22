#!/usr/bin/env bash

# Shared SSH setup for the guarded GitHub synchronization scripts.
# This file is sourced by scripts/sync-{to,from}-github.sh.

readonly HOLAHOLA_GITHUB_REPO_SSH="git@github.com:HolaHolaOrganization/HolaHola.git"

github_ssh_key_file=""
github_ssh_known_hosts_file=""

github_ssh_cleanup() {
  if [[ -n "${github_ssh_key_file:-}" ]]; then
    rm -f -- "$github_ssh_key_file"
  fi
  if [[ -n "${github_ssh_known_hosts_file:-}" ]]; then
    rm -f -- "$github_ssh_known_hosts_file"
  fi
}

github_ssh_setup() {
  if [[ -z "${HOLAHOLA_GITHUB_DEPLOY_KEY:-}" ]]; then
    echo "ERROR: HOLAHOLA_GITHUB_DEPLOY_KEY is not set." >&2
    return 1
  fi

  github_ssh_key_file="$(mktemp "${TMPDIR:-/tmp}/holahola-github-key.XXXXXX")"
  chmod 600 "$github_ssh_key_file"

  # Replit Secrets may collapse a pasted armored key to one line. Rebuild the
  # standard armored representation without ever printing the key material.
  if ! KEY_FILE="$github_ssh_key_file" python3 - <<'PY'
import os
import re
import textwrap

raw = os.environ["HOLAHOLA_GITHUB_DEPLOY_KEY"].strip().replace("\r", "")
match = re.fullmatch(
    r"(-----BEGIN [^-]+ PRIVATE KEY-----)\s*(.*?)\s*"
    r"(-----END [^-]+ PRIVATE KEY-----)",
    raw,
    flags=re.DOTALL,
)
if not match:
    raise SystemExit("private key header/footer are invalid")

header, body, footer = match.groups()
expected_footer = header.replace("BEGIN", "END", 1)
if footer != expected_footer:
    raise SystemExit("private key header/footer do not match")

body = re.sub(r"\s+", "", body)
if not body or not re.fullmatch(r"[A-Za-z0-9+/=]+", body):
    raise SystemExit("private key body is not valid base64 text")

with open(os.environ["KEY_FILE"], "w", encoding="ascii") as key:
    key.write(header + "\n")
    key.write("\n".join(textwrap.wrap(body, 70)))
    key.write("\n" + footer + "\n")
PY
  then
    echo "ERROR: HOLAHOLA_GITHUB_DEPLOY_KEY is not a valid armored private key." >&2
    github_ssh_cleanup
    return 1
  fi

  # Automated sync cannot unlock an interactive passphrase-protected key.
  if ! ssh-keygen -y -P "" -f "$github_ssh_key_file" >/dev/null 2>&1; then
    echo "ERROR: HOLAHOLA_GITHUB_DEPLOY_KEY is encrypted, malformed, or unreadable." >&2
    github_ssh_cleanup
    return 1
  fi

  local persistent_known_hosts="${HOME:-}/.ssh/known_hosts"
  if [[ -f "$persistent_known_hosts" ]]; then
    github_ssh_known_hosts_file=""
    persistent_known_hosts="${persistent_known_hosts}"
  else
    github_ssh_known_hosts_file="$(mktemp "${TMPDIR:-/tmp}/holahola-github-known-hosts.XXXXXX")"
    chmod 600 "$github_ssh_known_hosts_file"
    persistent_known_hosts="$github_ssh_known_hosts_file"
  fi

  export GIT_SSH_COMMAND="ssh -i $github_ssh_key_file -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$persistent_known_hosts"
}