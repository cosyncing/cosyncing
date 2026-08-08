#!/usr/bin/env bash
# Agent/dev review: render the served Flutter `/cosy/` in a HEADFUL browser under a virtual X display
# (xvfb) and emit a JSON verdict + a screenshot. Headful-under-xvfb is what makes Flutter's CanvasKit
# canvas actually paint here — plain headless Chrome wedges the compositor in this WSL2 container.
#
# Usage (run from the repo root; no `cd` needed):
#   scripts/broker/review/web-review.sh                         # auto-launch a broker (needs COSYNCING_WEB_DIR) and review /cosy/
#   scripts/broker/review/web-review.sh http://127.0.0.1:7734   # review an already-running broker's /cosy/
#
# Env:
#   COSYNCING_WEB_DIR  client Flutter build dir (e.g. apps/client/build/web) — required for auto-launch
#   REVIEW_PORT      auto-launch port (default 37799)
#   REVIEW_OUT       screenshot path (default output/web-review.png)
#   REVIEW_TIMEOUT   hard cap on the render step in seconds (default 150) — a wedged renderer can't hang callers
#
# Exit: 0 = pass (Flutter view painted, same-origin /api/health ok, no console/page errors, screenshot saved).
#       3 = setup error (no xvfb / no broker / not healthy).  137 = render timed out.
# Intentionally no `set -e`: we always reach teardown and always print the verdict.

ROOT="$(realpath "$(dirname "${BASH_SOURCE[0]}")/../../..")"
DRIVER="$ROOT/scripts/broker/review/web_app_review.py"
OUT="${REVIEW_OUT:-$ROOT/output/web-review.png}"
PORT="${REVIEW_PORT:-37799}"
mkdir -p "$(dirname "$OUT")"

if ! command -v xvfb-run >/dev/null 2>&1; then
  echo "ERROR: xvfb-run not found. Install it once with:  sudo apt install -y xvfb" >&2
  exit 3
fi

BROKER_PID=""
BASE="${1:-}"
if [ -z "$BASE" ]; then
  if [ -z "${COSYNCING_WEB_DIR:-}" ]; then
    echo "ERROR: no broker URL given and COSYNCING_WEB_DIR is unset (needed to auto-launch)." >&2
    echo 'Either pass a URL, or: COSYNCING_WEB_DIR="$PWD/apps/client/build/web" scripts/broker/review/web-review.sh' >&2
    exit 3
  fi
  echo "[web-review] launching broker on :$PORT with COSYNCING_WEB_DIR=$COSYNCING_WEB_DIR"
  COSYNCING_WEB_DIR="$COSYNCING_WEB_DIR" PORT="$PORT" HOST=127.0.0.1 \
    COSYNCING_CLAUDE_HOOKS=0 COSYNCING_OPENCODE_NO_AUTOSERVE=1 COSYNCING_RESTART_DRY_RUN=1 \
    bun run "$ROOT/packages/typescript/broker/src/main.ts" >/dev/null 2>&1 &
  BROKER_PID=$!
  BASE="http://127.0.0.1:$PORT"
fi

# Wait for health (curl's own retry — no shell sleep).
curl -s --retry 40 --retry-connrefused --retry-delay 1 -o /dev/null -w "" "$BASE/api/health"
if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/api/health")" != "200" ]; then
  echo "ERROR: broker at $BASE not healthy." >&2
  [ -n "$BROKER_PID" ] && kill "$BROKER_PID" 2>/dev/null
  exit 3
fi

APP_URL="${BASE%/}/cosy/"
echo "[web-review] rendering $APP_URL under xvfb (headful)…"
timeout --signal=KILL "${REVIEW_TIMEOUT:-150}" \
  xvfb-run -a --server-args="-screen 0 1280x900x24" python3 "$DRIVER" "$APP_URL" "$OUT"
RC=$?
[ "$RC" = "137" ] && echo "[web-review] TIMED OUT after ${REVIEW_TIMEOUT:-150}s (renderer wedged)"

[ -n "$BROKER_PID" ] && kill "$BROKER_PID" 2>/dev/null

echo "[web-review] screenshot: $OUT"
echo "[web-review] verdict exit code: $RC (0=pass)"
exit $RC
