#!/usr/bin/env bash
set -euo pipefail
test -f node_modules/playwright-core/cli.js
# playwright-core is pinned by the lockfile. Do not acquire another npm CLI.
bun node_modules/playwright-core/cli.js install chromium-headless-shell
set +e
bun run scripts/ci/probe-browser.ts
probe_status=$?
set -e
if test "$probe_status" = 78; then
  bun node_modules/playwright-core/cli.js install-deps chromium
  bun run scripts/ci/probe-browser.ts
else
  exit "$probe_status"
fi
