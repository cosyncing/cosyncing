#!/usr/bin/env bash
set -euo pipefail

input="${1:?usage: extract-android-signer-digest.sh <apksigner-output>}"

mapfile -t digests < <(
  sed -n -E \
    's/^(Signer #[0-9]+|V[0-9]+([.][0-9]+)? Signer:) certificate SHA-256 digest:[[:space:]]*//p' \
    "$input"
)

if test "${#digests[@]}" -ne 1; then
  echo "expected exactly one Android certificate SHA-256 digest; found ${#digests[@]}" >&2
  exit 1
fi

normalized="$(printf '%s' "${digests[0]}" | tr -d '[:space:]:' | tr '[:upper:]' '[:lower:]')"
if ! [[ "$normalized" =~ ^[0-9a-f]{64}$ ]]; then
  echo 'Android certificate SHA-256 digest is malformed' >&2
  exit 1
fi

printf '%s\n' "$normalized"
