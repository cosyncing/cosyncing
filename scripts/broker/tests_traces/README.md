# Scenario trace tests

This directory holds product-level trace tests. These are separate from `scripts/broker/tests`, which are
unit and adapter integration tests.

The first committed pieces are a catalog and a dry-run runner:

```bash
bun run scripts/broker/tests_traces/run-traces.ts --list
bun run scripts/broker/tests_traces/run-traces.ts --agent opencode --priority p0 --list
bun run scripts/broker/tests_traces/run-traces.ts --write-catalog
bun run scripts/broker/tests_traces/check-trace-manifest.ts
bun run scripts/broker/tests_traces/check-support-matrix-coverage.ts
bun run scripts/broker/tests_traces/opencode-private-observe-drive-trace.ts
bun run scripts/broker/tests_traces/opencode-real-run-drive-trace.ts
bun run scripts/broker/tests_traces/opencode-true-sync-trace.ts
bun run scripts/broker/tests_traces/opencode-real-tui-trace.ts
bun run scripts/broker/tests_traces/opencode-owner-degrade-trace.ts
bun run scripts/broker/tests_traces/transport-crypto-broker-trace.ts
bun run scripts/broker/tests_traces/transport-session-control-reference-trace.ts
COSYNCING_OPENCODE_REAL_SERVE_DEGRADE=1 bun run scripts/broker/tests_traces/opencode-real-serve-owner-degrade-trace.ts
bun run scripts/broker/tests_traces/pi-bridge-true-sync-trace.ts
COSYNCING_PI_REAL_TUI=1 COSYNCING_PI_USE_USER_CONFIG=1 COSYNCING_PI_TUI_MODEL=vllm-hpc/qwen3.6-27B-FP8 bun run scripts/broker/tests_traces/pi-real-tui-bridge-trace.ts
bun run scripts/broker/tests_traces/codex-surface-contract-trace.ts   # ST-27/ST-29 surface + task-list trace
bun run scripts/broker/tests_traces/codex-true-sync-trace.ts
COSYNCING_CODEX_APP_CREATED_SYNC=1 bun run scripts/broker/tests_traces/codex-app-created-tui-sync-trace.ts   # app-created → terminal-join true-sync (real daemon + TUI, spark)
bun run scripts/broker/tests_traces/codex-real-tui-smoke.ts
bun run scripts/broker/tests_traces/codex-control-mode-restart-trace.ts
bun run trace:real-agent-p0                    # manual/scheduled P0 real-agent lane with explicit pass/skip summary
```

The browser traces that drove the PoC UI at `/poc-ui/` are retired: the broker no longer serves that mount,
so they cannot pass. They are listed in `RETIRED_POC_UI_TRACES` in [`trace-manifest.ts`](trace-manifest.ts),
are cited by no manifest entry, and refuse to run with an explanation instead of failing on a 404 page. The
replacement is an `/cosy/` re-authoring against the Flutter client, which renders to a canvas and shares none
of these DOM selectors; it needs a web build (`bun run client:build:web`) that this tree does not carry.
The `trace:real-tui` lane was made entirely of them and is gone with them; `trace:real-agent-p0` keeps its
surviving real-agent traces.

The machine-readable taxonomy and coverage index is [`trace-manifest.ts`](trace-manifest.ts): every listed trace declares
which taxonomy functions (`F01`-`F16`) it covers and at what evidence level (`L0`, `L1`, `L2`, `L3`, or
`D`). Keep it honest with `bun run scripts/broker/tests_traces/check-trace-manifest.ts`.

The support-matrix evidence checker is [`support-matrix-claims.ts`](support-matrix-claims.ts) plus
[`check-support-matrix-coverage.ts`](check-support-matrix-coverage.ts). It generates and verifies the public
[`adapter support matrix`](../../../docs/protocol/adapter-support.md) and fails when a full/partial claim lacks
the required manifest evidence level.

The catalog runner is intentionally not a pass/fail test suite yet. Trace drivers such as
`opencode-private-observe-drive-trace.ts`, `opencode-real-run-drive-trace.ts`,
`opencode-true-sync-trace.ts`, `opencode-real-tui-trace.ts`, `opencode-owner-degrade-trace.ts`, `pi-bridge-true-sync-trace.ts`,
`opencode-real-serve-owner-degrade-trace.ts`,
`pi-real-tui-bridge-trace.ts`, `codex-surface-contract-trace.ts`, `codex-true-sync-trace.ts`,
`codex-real-tui-smoke.ts`, and `codex-control-mode-restart-trace.ts` are pass/fail scripts
and must record:

- `trace.json` with scenario id, agent, version, steps, assertions, pass/fail/skip, and skip reason.
- `frames.ndjson` with broker WebSocket frames in order.
- Native agent evidence where available, such as OpenCode messages, Pi JSONL/RPC events, Codex
  app-server notifications, or Claude transcript slices.
- File manifests for inbox/outbox/artifacts.
- Screenshots and browser console logs for UI traces.

Trace outputs should live under `output/traces/<run-id>/<agent>/<scenario-id>/`.
