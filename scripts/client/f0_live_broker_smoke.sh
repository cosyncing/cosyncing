#!/usr/bin/env bash

if [ -z "${COSYNCING_BROKER_URL:-}" ]; then
  echo "Skipping live broker smoke: COSYNCING_BROKER_URL is not set."
  echo "Set COSYNCING_BROKER_URL (and COSYNCING_TOKEN for remote brokers) and rerun."
  exit 0
fi

echo "Running F0.1 live broker smoke against ${COSYNCING_BROKER_URL}"
bun run scripts/client/run-client-command.ts flutter test test/src/smoke/f0_live_broker_smoke_test.dart
