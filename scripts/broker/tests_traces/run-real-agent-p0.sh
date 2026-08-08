#!/usr/bin/env bash
# Manual/scheduled P0 real-agent lane. Every trace is opt-in and must report
# PASS/SKIP/FAIL explicitly; unset env gates are counted as SKIP, not silent green.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT" || exit 1

total=0
passed=0
skipped=0
failed=0
timeout_seconds="${COSYNCING_REAL_AGENT_TRACE_TIMEOUT_SECONDS:-300}"

run_trace() {
  name="$1"
  shift
  total=$((total + 1))
  tmp="$(mktemp "/tmp/cosyncing-p0-${name}.XXXXXX")"
  echo
  echo "== ${name} =="
  timeout "$timeout_seconds" "$@" 2>&1 | tee "$tmp"
  code=${PIPESTATUS[0]}
  if [ "$code" -eq 0 ] && grep -Eq '(^|[[:space:]])SKIP([[:space:]]|$)' "$tmp"; then
    skipped=$((skipped + 1))
    echo "-- ${name}: SKIP"
  elif [ "$code" -eq 0 ]; then
    passed=$((passed + 1))
    echo "-- ${name}: PASS"
  else
    failed=$((failed + 1))
    echo "-- ${name}: FAIL (exit ${code})"
  fi
}

# The app-answer and native-model-change traces are gone from this lane: they drove the retired /poc-ui/
# mount and now refuse to run. See RETIRED_POC_UI_TRACES in trace-manifest.ts.
run_trace codex-broad-real-tui-surface bun run scripts/broker/tests_traces/codex-broad-real-tui-surface-trace.ts
run_trace codex-real-appserver-owner-degrade bun run scripts/broker/tests_traces/codex-real-appserver-owner-degrade-trace.ts
run_trace opencode-broad-real-tui-surface bun run scripts/broker/tests_traces/opencode-broad-real-tui-surface-trace.ts
run_trace opencode-real-serve-owner-degrade bun run scripts/broker/tests_traces/opencode-real-serve-owner-degrade-trace.ts

echo
echo "P0 real-agent summary: ${passed} passed, ${skipped} skipped, ${failed} failed, ${total} total"

if [ "$failed" -gt 0 ]; then
  exit 1
fi
