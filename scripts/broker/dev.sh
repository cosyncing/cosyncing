#!/usr/bin/env bash
# Dev convenience: ensure an OpenCode server is running, then start the broker.
# Pi sessions are discovered from ~/.pi/agent/sessions automatically.

OPENCODE_PORT="${OPENCODE_PORT:-4096}"
export OPENCODE_URL="${OPENCODE_URL:-http://127.0.0.1:${OPENCODE_PORT}}"
export PORT="${PORT:-7734}"

if ! curl -s "http://127.0.0.1:${OPENCODE_PORT}/session" >/dev/null 2>&1; then
  echo "Starting opencode serve on :${OPENCODE_PORT} …"
  opencode serve --port "${OPENCODE_PORT}" --hostname 127.0.0.1 >/tmp/opencode-serve.log 2>&1 &
  sleep 2
fi

echo "Starting broker on :${PORT} (OPENCODE_URL=${OPENCODE_URL}) …"
exec bun run packages/typescript/broker/src/main.ts
