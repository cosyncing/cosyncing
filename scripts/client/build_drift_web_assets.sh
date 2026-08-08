#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLIENT_ROOT="$(cd "${SCRIPT_DIR}/../../apps/client" && pwd)"

drift_version=$(awk '
  /^  drift:$/ { in_drift = 1; next }
  in_drift && /^  [^ ]/ { in_drift = 0 }
  in_drift && /version:/ {
    gsub(/"/, "", $2)
    print $2
    exit
  }
' "${CLIENT_ROOT}/pubspec.lock")

sqlite_wasm="${CLIENT_ROOT}/.dart_tool/sqlite3.wasm"

if [ ! -f "$sqlite_wasm" ]; then
  sqlite_wasm="$HOME/.pub-cache/hosted/pub.dev/drift-$drift_version/extension/devtools/build/sqlite3.wasm"
fi

if [ ! -f "$sqlite_wasm" ]; then
  echo "sqlite3.wasm not found. Run 'bun run client:pub-get' from the monorepo root, then rerun this script."
  exit 1
fi

mkdir -p "${CLIENT_ROOT}/web"
cp "$sqlite_wasm" "${CLIENT_ROOT}/web/sqlite3.wasm"
(
  cd "$CLIENT_ROOT"
  dart compile js web/drift_worker.dart -O4 -o web/drift_worker.js
)
