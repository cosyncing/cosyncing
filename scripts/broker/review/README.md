# Web review harness (`/cosy/`)

This optional visual diagnostic renders the Flutter web client served at
`/cosy/` in a **headful** browser under a virtual X display (Xvfb). It emits a
machine-readable verdict and a screenshot for an interactive review loop. The
repository's automated browser gates remain the required regression checks;
see [public build and test instructions](../../../docs/development/build-test.md).

## Why headful + Xvfb

Headless Chrome **cannot** paint Flutter's CanvasKit/WebGL canvas reliably in
this WSL2 container: the compositor can wedge while plain DOM pages still work.
Headful Chrome on a virtual display is the established path for this diagnostic.

## Prerequisite (one time)

```bash
sudo apt install -y xvfb
```

Also needs Python Playwright with the full Chromium build (already present in this repo's env).

## Broker safety

Passing an existing broker URL does not start or stop a broker. The harness only
loads `/cosy/`, waits for the roster request, checks health, and captures the
rendered result.

Auto-launch starts a full source broker. A different port and data directory do
not isolate host-global Codex/OpenCode processes, sockets, shims, or session
ownership. Do not auto-launch it beside the packaged production broker or
another review broker. First identify the listeners and owning working
directories, then use an explicit maintenance window: stop the packaged service,
run this diagnostic, stop its source broker, and restore the packaged service.
Never kill an unresolved listener. The harness's Claude-hook and OpenCode
autoserve flags reduce side effects but do not make simultaneous full brokers
safe.

## Usage (run from the repo root)

```bash
# During an explicit maintenance window, auto-launch a source broker on a
# client build, review /cosy/, then tear it down:
COSYNCING_WEB_DIR="$PWD/apps/client/build/web" scripts/broker/review/web-review.sh

# Or review an already-running broker without launching another one:
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
