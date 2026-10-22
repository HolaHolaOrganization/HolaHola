#!/usr/bin/env bash

# Shared, ephemeral SSH setup for the GitHub release scripts.
# The private key is never placed in a command argument or printed to output.
#
# Host-key refresh workflow (run manually, never from a release):
#   bash scripts/github-release-ssh.sh --check-host-keys
#
# This fetches GitHub's published SSH host-key set from api.github.com/meta and
# compares it with the pinned set below. A mismatch prints a reviewable diff
# and fails. After confirming the official metadata, update only the pinned
# block below and rerun the check. Release commands never perform this lookup.

GITHUB_REPO_URL="git@github.com:HolaHolaOrganization/HolaHola.git"
GITHUB_HOST_KEYS_META_URL="https://api.github.com/meta"
GITHUB_SUPPORTED_HOST_KEY_TYPES=(
  "ssh-ed25519"
  "ecdsa-sha2-nistp256"
  "ssh-rsa"
)

github_pinned_host_keys() {
  # Keep this list in the same "key type base64 key" shape returned by the
  # official metadata endpoint. The release known_hosts file adds github.com.
  cat <<'EOF'
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=
ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=
EOF
}

github_pinned_known_hosts() {
  while read -r key_type key_data; do
    printf 'github.com %s %s\n' "$key_type" "$key_data"
  done < <(github_pinned_host_keys)
}

check_github_host_keys() (
  set -Eeuo pipefail

  local temp_dir metadata_file pinned_file official_file
  temp_dir="$(mktemp -d /tmp/holahola-github-host-key-check.XXXXXX)"
  trap 'rm -rf -- "$temp_dir"' EXIT
  metadata_file="$temp_dir/meta.json"
  pinned_file="$temp_dir/pinned.txt"
  official_file="$temp_dir/official.txt"

  for key_type in "${GITHUB_SUPPORTED_HOST_KEY_TYPES[@]}"; do
    if ! github_pinned_host_keys | grep -Fq -- "$key_type "; then
      echo "ERROR: pinned GitHub host-key set is missing supported type ${key_type}." >&2
      return 1
    fi
  done

  echo "Checking pinned GitHub host keys against ${GITHUB_HOST_KEYS_META_URL}..."
  if ! curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --max-time 15 "$GITHUB_HOST_KEYS_META_URL" > "$metadata_file"; then
    echo "ERROR: could not fetch GitHub's official host-key metadata; keeping the existing pins." >&2
    return 1
  fi

  if ! jq -e '(.ssh_keys | type == "array" and length > 0) and all(.ssh_keys[]; type == "string" and test("^[^[:space:]]+[[:space:]]+[^[:space:]]+$"))' "$metadata_file" >/dev/null; then
    echo "ERROR: GitHub host-key metadata had an unexpected shape; keeping the existing pins." >&2
    return 1
  fi

  github_pinned_host_keys | awk 'NF == 2 { print $1 "\t" $2 }' | sort -u > "$pinned_file"
  jq -r '.ssh_keys[]' "$metadata_file" |
    awk 'NF == 2 { print $1 "\t" $2 }' |
    sort -u > "$official_file"

  if ! diff -u "$pinned_file" "$official_file"; then
    echo >&2
    echo "ERROR: pinned GitHub host keys differ from the official metadata." >&2
    echo "Review the diff above, update github_pinned_host_keys only after deliberate verification, and rerun:" >&2
    echo "  bash scripts/github-release-ssh.sh --check-host-keys" >&2
    return 1
  fi

  echo "Pinned GitHub host keys match the official metadata."
)

prepare_github_ssh() {
  local raw_key="${1:-}"
  local compact_key decoded_key key_label compact_label compact_header compact_footer payload
  local normalized_key=""

  if [[ -z "$raw_key" ]]; then
    echo "ERROR: HOLAHOLA_GITHUB_DEPLOY_KEY secret is not set. Add it in Replit Secrets." >&2
    return 1
  fi

  # Secret stores may preserve an armored key with literal newline escapes.
  # Decode those escapes without logging the secret.
  raw_key="${raw_key//$'\r'/}"
  raw_key="${raw_key//\\n/$'\n'}"
  raw_key="${raw_key//\\r/}"

  # Some stores base64-encode the entire armored file. Accept that form only
  # when strict decoding produces a supported private-key armor marker.
  if [[ "$raw_key" != *"PRIVATE KEY"* ]]; then
    compact_key="$(printf '%s' "$raw_key" | tr -d '[:space:]')"
    decoded_key="$(printf '%s' "$compact_key" | base64 --decode 2>/dev/null || true)"
    if [[ "$decoded_key" == *"PRIVATE KEY"* ]]; then
      raw_key="$decoded_key"
    fi
  fi

  # Canonicalize known armor types. Removing whitespace from the complete
  # serialized form safely handles multiline, literal-newline, and flattened
  # secrets; only a validated base64 payload is then rewrapped.
  compact_key="$(printf '%s' "$raw_key" | tr -d '[:space:]')"
  for key_label in "OPENSSH PRIVATE KEY" "RSA PRIVATE KEY" "EC PRIVATE KEY" "DSA PRIVATE KEY" "PRIVATE KEY"; do
    compact_label="${key_label// /}"
    compact_header="-----BEGIN${compact_label}-----"
    compact_footer="-----END${compact_label}-----"
    if [[ "$compact_key" == "$compact_header"*"$compact_footer" ]]; then
      payload="${compact_key#"$compact_header"}"
      payload="${payload%"$compact_footer"}"
      if [[ -z "$payload" || ! "$payload" =~ ^[A-Za-z0-9+/]+=*$ || $(( ${#payload} % 4 )) -ne 0 ]]; then
        echo "ERROR: HOLAHOLA_GITHUB_DEPLOY_KEY has an invalid armored payload." >&2
        return 1
      fi
      normalized_key="$(printf -- '-----BEGIN %s-----\n%s\n-----END %s-----' \
        "$key_label" "$(printf '%s' "$payload" | fold -w 70)" "$key_label")"
      break
    fi
  done

  if [[ -z "$normalized_key" ]]; then
    echo "ERROR: HOLAHOLA_GITHUB_DEPLOY_KEY does not contain a supported armored private key." >&2
    return 1
  fi

  # Use a fixed, trusted directory rather than caller-provided TMPDIR because
  # Git evaluates GIT_SSH_COMMAND through a shell.
  GITHUB_SSH_KEY_FILE="$(mktemp /tmp/holahola-github-key.XXXXXX)"
  GITHUB_KNOWN_HOSTS_FILE="$(mktemp /tmp/holahola-github-known-hosts.XXXXXX)"
  chmod 600 "$GITHUB_SSH_KEY_FILE" "$GITHUB_KNOWN_HOSTS_FILE"

  printf '%s\n' "$normalized_key" > "$GITHUB_SSH_KEY_FILE"

  # Fail before any Git command if OpenSSH cannot parse the normalized key.
  # Suppress ssh-keygen output so no derived key material reaches logs.
  if ! ssh-keygen -y -f "$GITHUB_SSH_KEY_FILE" >/dev/null 2>&1; then
    echo "ERROR: HOLAHOLA_GITHUB_DEPLOY_KEY could not be parsed as a private key." >&2
    cleanup_github_ssh
    unset GITHUB_SSH_KEY_FILE GITHUB_KNOWN_HOSTS_FILE
    return 1
  fi

  # GitHub's published SSH host keys, pinned here, prevent a network attacker
  # from redirecting ssh-keyscan and receiving the repository deploy key.
  github_pinned_known_hosts > "$GITHUB_KNOWN_HOSTS_FILE"

  printf -v GIT_SSH_COMMAND 'ssh -i %q -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=%q' "$GITHUB_SSH_KEY_FILE" "$GITHUB_KNOWN_HOSTS_FILE"
  export GIT_SSH_COMMAND
}

cleanup_github_ssh() {
  if [[ -n "${GITHUB_SSH_KEY_FILE:-}" ]]; then
    rm -f -- "$GITHUB_SSH_KEY_FILE"
  fi
  if [[ -n "${GITHUB_KNOWN_HOSTS_FILE:-}" ]]; then
    rm -f -- "$GITHUB_KNOWN_HOSTS_FILE"
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:-}" in
    --check-host-keys)
      check_github_host_keys
      ;;
    *)
      echo "Usage: bash scripts/github-release-ssh.sh --check-host-keys" >&2
      exit 2
      ;;
  esac
fi