#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Coexistence test — preconditions check. Confirms OUR channel socket exists AND
# claude.ai's cse_ bridge is attached to the SAME session (i.e. both clients live).
# Run after launch.sh (STEP 1) + enabling Remote Control from claude.ai (STEP 2).
# Uses rg (NOT grep — grep is ugrep here with false negatives).
# ─────────────────────────────────────────────────────────────────────────────
BRIDGE="$HOME/.claude/cosyncing/bridge"
S="$(ls -t "$BRIDGE"/*.sock 2>/dev/null | head -1)"
if [ -z "$S" ]; then
  echo "✗ no channel socket under $BRIDGE — run launch.sh first (and accept the MCP prompt)."
  exit 1
fi
U="$(basename "$S" .sock)"
echo "✓ channel socket : $S"
echo "  session uuid   : $U"
echo "  bridge log     : $BRIDGE/$U.log"

T="$(find "$HOME/.claude/projects" -maxdepth 2 -name "$U.jsonl" 2>/dev/null | head -1)"
if [ -z "$T" ]; then
  echo "… transcript not written yet — send ONE turn in the session, then re-run."
  exit 0
fi
echo "  transcript     : $T"

if rg -q '"type":"bridge-session"' "$T" 2>/dev/null; then
  echo "✓ claude.ai cse_ bridge ATTACHED — both clients are live; coexistence is testable."
  rg -N '"type":"bridge-session"' "$T" 2>/dev/null | tail -1 | cut -c1-180
else
  echo "… no cse_ bridge-session line yet — (STEP 2) enable Remote Control on this session from claude.ai."
fi
echo
echo "Next: bun run $(cd "$(dirname "$0")/../../.." && pwd)/scripts/broker/coexistence-test/probe.ts"
