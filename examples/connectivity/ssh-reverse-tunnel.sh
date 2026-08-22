#!/usr/bin/env bash
set -euo pipefail

if (( $# < 1 || $# > 3 )); then
  echo "usage: $0 user@vps [vps-loopback-port] [broker-port]" >&2
  exit 2
fi
remote_host="$1"
remote_port="${2:-17734}"
broker_port="${3:-7734}"
for value in "$remote_port" "$broker_port"; do
  case "$value" in
    ''|*[!0-9]*) echo "ports must be decimal integers" >&2; exit 2 ;;
  esac
  if (( value < 1 || value > 65535 )); then
    echo "ports must be between 1 and 65535" >&2
    exit 2
  fi
done

echo "Opening an operator-owned reverse tunnel. Stop this process to tear it down."
exec ssh -N -T \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -R "127.0.0.1:${remote_port}:127.0.0.1:${broker_port}" \
  "$remote_host"
