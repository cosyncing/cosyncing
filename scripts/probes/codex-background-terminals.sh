#!/usr/bin/env bash
set -euo pipefail

# Run from the repository root. Evidence directories must be new for each run.
test -f scripts/probes/codex-background-terminals.py || {
  echo 'Run this probe from the repository root.' >&2
  exit 1
}
exec python3 scripts/probes/codex-background-terminals.py "$@"
