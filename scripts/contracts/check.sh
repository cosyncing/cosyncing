#!/usr/bin/env bash
set -euo pipefail

readonly SNAPSHOT="contracts/generated/broker-client.snapshot.ts"
readonly DART_IDENTITY="packages/dart/broker_contract/lib/src/models/generated_contract_identity.dart"

if [ "${1:-}" = "--write" ]; then
  if [ "$#" -ne 1 ]; then
    echo "Usage: bash scripts/contracts/check.sh [--write]" >&2
    exit 2
  fi
  bun run scripts/broker/export-client-contract.ts \
    --output "$SNAPSHOT" --dart-output "$DART_IDENTITY"
  bun run scripts/contracts/generate-usage-report-sample.ts
  exit 0
fi
if [ "$#" -ne 0 ]; then
  echo "Usage: bash scripts/contracts/check.sh [--write]" >&2
  exit 2
fi

temporary_snapshot="$(mktemp)"
temporary_dart="$(mktemp)"
trap 'rm -f "$temporary_snapshot" "$temporary_dart"' EXIT
bun run scripts/broker/export-client-contract.ts \
  --output "$temporary_snapshot" --dart-output "$temporary_dart" >/dev/null
if ! cmp --silent "$temporary_snapshot" "$SNAPSHOT"; then
  echo "ERROR: $SNAPSHOT is stale." >&2
  echo "Run: bash scripts/contracts/check.sh --write" >&2
  diff --unified "$SNAPSHOT" "$temporary_snapshot" || true
  exit 1
fi
if ! cmp --silent "$temporary_dart" "$DART_IDENTITY"; then
  echo "ERROR: $DART_IDENTITY is stale." >&2
  echo "Run: bash scripts/contracts/check.sh --write" >&2
  diff --unified "$DART_IDENTITY" "$temporary_dart" || true
  exit 1
fi
bun run scripts/contracts/check-revision-history.ts
bun run scripts/contracts/generate-usage-report-sample.ts --check
echo "PASS: broker-owned flattened client contract is current."
