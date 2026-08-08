/**
 * ⛔ SUPERSEDED (2026-06-22, Sync Refactor) — DO NOT RESTORE AS-IS.
 *
 * This trace exercised the GLOBAL control-mode picker: a `<select id="controlMode">` whose change POSTed
 * `/api/broker/control-mode` to restart the broker into Observe+Drive / True-Sync, plus stale-localStorage
 * reconciliation on hard refresh. The Sync Refactor (D13/D17) DELETED that picker + endpoint. Codex sync is
 * now a per-agent enabler (`POST /api/agents/codex/sync`), and a fresh broker reads persisted enablement
 * pre-start so the common path never restarts (FU-3).
 *
 * Replacements (run these instead):
 *   - scripts/broker/tests/codex/broker-control-mode.ts        — the decoupled Codex enabler contract (+ FU-3 pre-start)
 *   - scripts/broker/tests_traces/sync-refactor-dom-probe.ts   — real-Chromium DOM: no #controlMode, one #control (D29)
 *   - scripts/broker/tests/app/test-web-ui-static.ts / test-web-ui-components.ts — one-button surface
 *
 * This stub exits 0 so the trace runner stays green without asserting against removed UI/endpoints.
 */
export {};

console.log(
  'SKIP codex-control-mode-restart-trace — SUPERSEDED by the Sync Refactor (control-mode picker + ' +
    '/api/broker/control-mode deleted). See broker-control-mode.ts (enabler contract) + ' +
    'sync-refactor-dom-probe.ts (D29 real-DOM probe).',
);
process.exit(0);
