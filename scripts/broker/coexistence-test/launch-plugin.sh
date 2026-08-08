#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Coexistence test — PRODUCTION (installed-plugin) form.
#
# launch.sh uses the `--channels server:` DEV form, which on claude 2.1.185 cannot have its permission REPLIES
# honored ("server: entries need --dangerously-load-development-channels" / "no MCP server configured with that
# name"). The production path is an INSTALLED plugin channel (`plugin:<name>@<marketplace>`) — it is on the
# approved allowlist, so its replies ARE honored, with NO --mcp-config and NO --dangerously-* flag.
#
# This installs our plugin from a LOCAL marketplace at **local scope**, confined to the throwaway dir, so it
# does NOT change your global Claude setup. Cleanup: `rm -rf /tmp/coexist-test` (+ optional marketplace remove).
# No `set -e` (per repo convention). The plugin steps may prompt for trust — accept them.
# ─────────────────────────────────────────────────────────────────────────────
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PLUGIN="$ROOT/packages/typescript/adapters/claude/plugin"
WORK="/tmp/coexist-test"
MODEL="${COEXIST_MODEL:-haiku}"

mkdir -p "$WORK"
cd "$WORK" || exit 1
echo "workspace : $WORK   (throwaway; rm -rf when done)"
echo "plugin    : $PLUGIN  → installed as plugin:cosyncing@cosyncing (local scope)"
echo "model     : $MODEL"
echo "───────────────────────────────────────────────────────────────────────────"
echo "1/3 registering local marketplace (local scope)…"
claude plugin marketplace add "$PLUGIN" --scope local 2>&1 | tail -4
echo "2/3 installing the plugin (local scope)…"
claude plugin install cosyncing@cosyncing --scope local 2>&1 | tail -4
echo "3/3 launching claude with the installed-plugin channel + dev-flag override (a LOCAL install is not on"
echo "    Anthropic's curated channel allowlist, so the dev flag is still needed; a PUBLISHED plugin would not need it)…"
echo "    After it starts: enable Remote Control from claude.ai, then probe.ts, then test permission allow."
echo "───────────────────────────────────────────────────────────────────────────"
claude --model "$MODEL" \
  --channels plugin:cosyncing@cosyncing \
  --dangerously-load-development-channels plugin:cosyncing@cosyncing

echo "───────────────────────────────────────────────────────────────────────────"
echo "claude exited. Clean up:  rm -rf $WORK"
echo "  (optional, removes the local-scoped marketplace/plugin cache: claude plugin marketplace remove cosyncing)"
