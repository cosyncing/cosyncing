#!/usr/bin/env bash
# Run from the repository root. Use the pinned Flutter toolchain on PATH.
set -euo pipefail

repeats="${NAMING_REPEAT:-10}"
lane="${1:-all}"
if [[ ! "$repeats" =~ ^[1-9][0-9]*$ ]] || (( repeats > 50 )); then
  echo 'NAMING_REPEAT must be between 1 and 50' >&2
  exit 2
fi
if [[ "$lane" != all && "$lane" != adapters && "$lane" != client ]]; then
  echo 'Usage: scripts/dev/check-session-naming.sh [all|adapters|client]' >&2
  exit 2
fi
mkdir -p output/session-naming
if [[ "$lane" == all || "$lane" == adapters ]]; then
  bun run check broker adapters --only conformance/pi,conformance/omp,conformance/claude,conformance/codex,conformance/grok,conformance/kimi,conformance/cline,conformance/agy,conformance/opencode,dsh-observe,dsh-attach-priming,omp-discovery,pi-family-bridge,claude-recency,claude-runtime,codex-fork,acp-client,publication-races,store-file --repeat "$repeats" --no-retry
  mkdir -p output/session-naming/stability
  cp -a output/check/. output/session-naming/stability/
fi
if [[ "$lane" == all || "$lane" == client ]]; then
  mkdir -p output/session-naming/client-stability
  for (( iteration=1; iteration<=repeats; iteration++ )); do
    log="output/session-naming/client-stability/$iteration.log"
    if ! bun run scripts/client/run-client-command.ts flutter test --no-pub \
      test/features/open_session_tabs_test.dart test/features/session_open_test.dart \
      test/src/features/sessions/roster/roster_snapshot_store_test.dart \
      --name 'a tab is named by its session|offline legacy ID placeholders|renaming from the session sends|older pending save' > "$log" 2>&1; then
      cat "$log"
      exit 1
    fi
    echo "PASS client naming $iteration/$repeats ($log)"
  done
fi
