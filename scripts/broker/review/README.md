# Web review harness (`/cosy/`)

The **default way to visually verify the Flutter web client** the broker serves at `/cosy/`. It renders
the app in a **headful** browser under a virtual X display (Xvfb) and emits a machine-readable verdict
plus a screenshot — designed so a coding agent (or you) can drop it into a review loop and branch on the
result.

## Why headful + Xvfb

Headless Chrome **cannot** paint Flutter's CanvasKit/WebGL canvas in this WSL2 container — the compositor
wedges (screenshot + `evaluate` hang), while plain DOM pages screenshot fine. Headful Chrome on a real
(virtual) display works. WSLg headful hangs at launch; **Xvfb is the reliable path**. Background:
`docs/architecture/monorepo.md` §11.

## Prerequisite (one time)

```bash
sudo apt install -y xvfb
```

Also needs Python Playwright with the full Chromium build (already present in this repo's env).

## Usage (run from the repo root)

```bash
# Auto-launch a broker on a client build, review /cosy/, then tear it down:
COSYNCING_WEB_DIR="$PWD/apps/client/build/web" scripts/broker/review/web-review.sh

# Or review an already-running broker:
scripts/broker/review/web-review.sh http://127.0.0.1:7734
```

Build the client from the monorepo root with
`bun run scripts/client/run-client-command.ts flutter build web --release --base-href /cosy/`.
The output is `apps/client/build/web`.

## Output & exit codes

Prints one `VERDICT:{…}` JSON line and saves a screenshot (default `output/web-review.png`).

`pass: true` requires **all** of:

- `flutter_view` — the Flutter view painted (real UI, not a blank/loading shell)
- `app_fetched_roster` — the app called `GET /api/sessions` **on its own**, proving the same-origin
  default auto-connected and fetched the roster (not merely rendered or pre-selected a profile)
- `same_origin_fetch.ok` — an in-page `fetch('/api/health')` succeeded same-origin (no CORS)
- no `console_errors` / `page_errors`
- a screenshot was written

Also reported: `webgl2`, `sab` (SharedArrayBuffer — true only with cross-origin isolation, see
`COSYNCING_WEB_COI`), `api_requests`, `bad_responses`, `title`, `base_href`.

| Exit | Meaning |
|------|---------|
| 0 | pass |
| 1 | review ran but failed (see the verdict fields) |
| 3 | setup error (no `xvfb`, no broker, broker unhealthy) |
| 137 | render timed out (`REVIEW_TIMEOUT`) — a wedged renderer can't hang the caller |

## Env knobs

| Var | Default | Purpose |
|-----|---------|---------|
| `COSYNCING_WEB_DIR` | — | client Flutter build dir; required for auto-launch |
| `REVIEW_PORT` | `37799` | auto-launch broker port |
| `REVIEW_OUT` | `output/web-review.png` | screenshot path |
| `REVIEW_TIMEOUT` | `150` | hard cap (s) on the render step |

## Notes

- The harness **waits for** the app's own `/api/sessions` call (up to ~15s) rather than a fixed settle,
  because the same-origin hydration is IndexedDB-backed and the roster fetch can land several seconds
  after first paint. The screenshot is best-effort: a very large roster (hundreds+ sessions) may still be
  mid-render when captured, but the `pass` verdict is based on the detected fetch, not the pixels.
- `output/` is gitignored; screenshots are disposable.

## Files

- `web-review.sh` — entry point: launches/targets a broker, runs the driver under `xvfb-run`, tears down.
- `web_app_review.py` — the Playwright driver (headful Chromium, request/console capture, verdict).
