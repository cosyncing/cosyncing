#!/usr/bin/env bash
set -euo pipefail

port="${1:-7734}"
case "$port" in
  ''|*[!0-9]*) echo "usage: $0 [broker-port]" >&2; exit 2 ;;
esac
if (( port < 1 || port > 65535 )); then
  echo "broker port must be between 1 and 65535" >&2
  exit 2
fi
if ! command -v tailscale >/dev/null 2>&1; then
  echo "tailscale is not installed; install and authenticate it independently" >&2
  exit 1
fi

echo "Creating an operator-owned Tailscale Serve route to 127.0.0.1:${port}."
tailscale serve --bg "http://127.0.0.1:${port}"
tailscale serve status
echo "Pair with: cosy pair --broker-url <HTTPS-origin-shown-above>"
echo "Teardown: tailscale serve --https=443 off"
