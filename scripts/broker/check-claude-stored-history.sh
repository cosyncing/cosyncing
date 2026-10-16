#!/usr/bin/env bash
# Standalone acceptance; not registered with package scripts or CI.
set -euo pipefail

run_wire=0
run_client=0
for argument in "$@"; do
  case "$argument" in
    --wire) run_wire=1 ;;
    --client) run_client=1 ;;
    --help)
      echo 'Run from the repository root: scripts/broker/check-claude-stored-history.sh [--wire] [--client]'
      echo 'Optional COSYNCING_TEST_CLAUDE_TRANSCRIPT=/absolute/path enables a read-only local transcript check.'
      exit 0 ;;
    *) echo "Unknown argument: $argument" >&2; exit 2 ;;
  esac
done

if [[ ! -f packages/typescript/broker/test/broker/test-claude-stored-history.ts ]]; then
  echo 'Run this script from the repository root.' >&2
  exit 2
fi

bun run packages/typescript/broker/test/broker/test-claude-stored-history.ts
if [[ "$run_wire" == 1 ]]; then
  bun run packages/typescript/broker/test/broker/test-claude-stored-history-wire.ts
fi
if [[ "$run_client" == 1 ]]; then
  bun run scripts/client/run-client-command.ts flutter test \
    test/src/features/sessions/transcript/session_detail_transcript_scroll_test.dart \
    --reporter expanded
fi
