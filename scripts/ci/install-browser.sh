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
  set +e
  bun run scripts/ci/probe-browser.ts
  probe_status=$?
  set -e
fi
if test "$probe_status" = 79; then
  # The hosted image has Chrome's libraries but lacks CJK fonts. Install only
  # the diagnosed font dependencies, retaining all supported script coverage.
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends fontconfig fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji
  bun run scripts/ci/probe-browser.ts
else
  exit "$probe_status"
fi
