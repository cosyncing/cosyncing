#!/usr/bin/env bash
set -euo pipefail

failed=0

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  failed=1
}

reject_match() {
  local pattern="$1"
  shift
  if rg -n "$pattern" "$@"; then
    fail "forbidden match: $pattern"
  fi
}

check_max_lines() {
  local limit="$1"
  shift
  local path lines
  for path in "$@"; do
    lines="$(wc -l < "$path")"
    if (( lines > limit )); then
      fail "$path has $lines lines; ceiling is $limit"
    fi
  done
}

for path in packages/typescript/core packages/typescript/wire; do
  [[ ! -e "$path" ]] || fail "legacy package remains: $path"
done

reject_match '@cosyncing/(core|wire)' \
  packages scripts apps/client/lib apps/client/test --glob '!contracts/generated/**' \
  --glob '!scripts/ci/check-boundaries.sh'
reject_match 'packages/typescript/(core|wire)' \
  packages scripts apps/client/lib apps/client/test --glob '!contracts/generated/**' \
  --glob '!scripts/ci/check-boundaries.sh'
reject_match "from ['\"]\.\./\.\./[^'\"]+/src" packages/typescript
reject_match "from ['\"](@cosyncing/adapter-api|bun|node:(fs|process|child_process))" \
  packages/typescript/protocol
reject_match '\b(Bun|process)\.' packages/typescript/protocol
reject_match '@cosyncing/adapter-(claude|codex|opencode|pi)' \
  packages/typescript/adapter-api
reject_match "(package:dio|dart:io.*WebSocket|web_socket_channel)" \
  apps/client/lib/src/features --glob '**/view/*.dart'

for package in packages/typescript/adapters/*/package.json; do
  rg -q '"@cosyncing/adapter-api": "workspace:\*"' "$package" \
    || fail "$package does not depend on adapter-api"
done

for dependency in crypto transport transport-wire; do
  rg -q "\"@cosyncing/$dependency\": \"workspace:\*\"" packages/typescript/broker/package.json \
    || fail "broker package does not declare @cosyncing/$dependency"
done

check_max_lines 800 packages/typescript/broker/src/main.ts
check_max_lines 300 packages/typescript/adapters/*/src/index.ts
check_max_lines 3000 apps/client/lib/src/features/sessions/view/session_detail_page.dart
check_max_lines 3000 apps/client/lib/src/features/sessions/view/session_detail_*.dart
check_max_lines 3000 apps/client/lib/src/features/sessions/data/session_detail_controller.dart
check_max_lines 3000 apps/client/lib/src/features/sessions/data/session_detail_*coordinator.dart
check_max_lines 700 \
  apps/client/lib/src/features/sessions/renderers/message_renderer_registry.dart \
  apps/client/lib/src/features/sessions/renderers/message_*renderers.dart \
  apps/client/lib/src/features/sessions/renderers/message_renderer_formatting.dart \
  apps/client/lib/src/features/sessions/renderers/tool_message_cards.dart \
  apps/client/lib/src/features/sessions/renderers/transcript_message_widgets.dart
if (( failed != 0 )); then
  exit 1
fi

printf 'PASS: package directions and pre-v1 hotspot ceilings hold.\n'
