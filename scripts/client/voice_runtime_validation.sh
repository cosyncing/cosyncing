#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLIENT_ROOT="$(cd "${SCRIPT_DIR}/../../apps/client" && pwd)"

if [ ! -f "${CLIENT_ROOT}/pubspec.yaml" ]; then
  echo "ERROR: apps/client/pubspec.yaml is missing from the cosyncing monorepo."
  exit 2
fi

if ! command -v dart >/dev/null 2>&1; then
  echo "ERROR: dart command not found in PATH."
  exit 2
fi

cd "$CLIENT_ROOT"
exec dart tool/voice_runtime_validation.dart "$@"
