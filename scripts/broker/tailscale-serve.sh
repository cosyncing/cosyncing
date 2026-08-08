#!/usr/bin/env bash
# Expose the local cosyncing broker on your tailnet over HTTPS (TLS + MagicDNS
# handled by tailscaled). Reach it from your phone's browser at
#   https://<this-machine>.<your-tailnet>.ts.net
# Requires: tailscale up, and HTTPS/MagicDNS enabled for the tailnet.
# Do NOT use `tailscale funnel` (that exposes publicly via Tailscale relays).

PORT="${PORT:-7734}"

if ! command -v tailscale >/dev/null 2>&1; then
  echo "tailscale not found. Install it and run 'tailscale up' first." >&2
  exit 1
fi

echo "Exposing broker localhost:${PORT} on the tailnet…"
tailscale serve --bg "${PORT}"
echo
tailscale serve status
echo
echo "Open the MagicDNS URL above from any device on your tailnet."
echo "To stop:  tailscale serve --https=443 off"
