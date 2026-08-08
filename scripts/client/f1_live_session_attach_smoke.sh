#!/usr/bin/env bash

if [ -z "${COSYNCING_BROKER_URL:-}" ]; then
  echo "Skipping F1 live session attach smoke: COSYNCING_BROKER_URL is not set."
  echo "To run, set COSYNCING_BROKER_URL (and COSYNCING_TOKEN for non-loopback brokers)."
  echo "Optional selectors:"
  echo "- COSYNCING_SMOKE_TOOL"
  echo "- COSYNCING_SMOKE_SESSION_ID"
  echo "- COSYNCING_ATTACH_SMOKE_TIMEOUT_SECONDS (default 10)"
  exit 0
fi

echo "Running F1 live session attach smoke against ${COSYNCING_BROKER_URL}"
bun run scripts/client/run-client-command.ts flutter test test/src/smoke/f1_live_session_attach_smoke_test.dart --reporter=compact
