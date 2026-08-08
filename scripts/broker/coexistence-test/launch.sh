#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Coexistence test — STEP 1: launch a THROWAWAY first-party Claude session that
# carries OUR channel bridge, on the cheap haiku model.
#
# Channels are FIRST-PARTY ONLY (no free-wrapper substitute), so this runs on the
# subscription — `--model haiku` keeps the cost minimal. Run this in a terminal you
# KEEP OPEN, accept the trust/MCP prompts, then do STEP 2 (enable Remote Control on
# this session from claude.ai) so claude.ai's cse_ bridge and our channel are both live.
#
# No `set -e` (per repo convention). Root derived from this script's location.
# ─────────────────────────────────────────────────────────────────────────────
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PLUGIN="$ROOT/packages/typescript/adapters/claude/plugin"
WORK="/tmp/coexist-test"
MODEL="${COEXIST_MODEL:-haiku}"

mkdir -p "$WORK"
echo "workspace : $WORK   (throwaway; rm -rf when done)"
echo "plugin    : $PLUGIN"
echo "model     : $MODEL  (override with COEXIST_MODEL=…)"
echo "store     : default ~/.claude (first-party — required for channels)"
echo
echo "Launching claude with the cosyncing channel. Accept the folder-trust + MCP-server prompts."
echo "After it starts: (STEP 2) enable Remote Control on THIS session from the claude.ai app/web,"
echo "then in another terminal run:  bash $ROOT/scripts/broker/coexistence-test/check.sh"
echo "───────────────────────────────────────────────────────────────────────────"

cd "$WORK" || exit 1
# NOTE: `--dangerously-load-development-channels server:cosyncing` is REQUIRED on claude 2.1.185 for a
# `server:`-form channel's permission REPLIES to be honored (without it the channel RECEIVES permission_requests
# but claude IGNORES our `allow`/`deny` — the 2026-06-22 finding). It loads our dev channel; it does NOT skip
# permissions (NOT --dangerously-skip-permissions). Production uses the installed-plugin form
# (`plugin:cosyncing@<marketplace>`), trusted without this flag.
# Both `--channels` and `--dangerously-load-development-channels` are VARIADIC (`<servers...>`): each needs its
# own `server:cosyncing` entry, and the dev flag is LAST + `--model` FIRST so the variadic lists don't
# swallow other flags. If claude rejects passing the entry to BOTH, drop the `--channels` line (the dev flag
# alone loads the dev channel).
CLAUDE_PLUGIN_ROOT="$PLUGIN" claude \
  --model "$MODEL" \
  --mcp-config "$PLUGIN/.mcp.json" \
  --channels server:cosyncing \
  --dangerously-load-development-channels server:cosyncing

echo "───────────────────────────────────────────────────────────────────────────"
echo "claude exited. The bridge socket auto-unlinks. Clean up with:  rm -rf $WORK"
