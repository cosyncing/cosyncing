# Kilo Code (experimental)

The CLI, authenticated serve, live HTTP/SSE, and SQLite contracts are measured
against Kilo Code 7.4.23, which is the supported FLOOR rather than a pin. That
version or newer offers local-store Observe plus broker-owned Create and live
Drive. Older versions remain Observe-only.

```bash
type -a kilo
kilo --version
cosyncing setup
cosy restart
cosy doctor
```

Setup does not install or update Kilo Code. `KILO_DATA_DIR` selects a deliberate
non-default data directory and `COSYNCING_KILO_BIN` selects a deliberate
nonstandard executable. With managed-runtime consent, cosyncing starts the
installed 7.4.23-or-newer binary on dedicated loopback port 4097 with generated Basic authentication. It
records and supervises only the process it owns. A user-managed server on port
4096 is never adopted, stopped, or reconfigured.

## Current behavior

- Parent sessions are discovered from bounded, read-only snapshots of
  `~/.local/share/kilo/kilo.db` and its SQLite WAL sidecars.
- Kilo-named databases take precedence over legacy `opencode*.db` names inside
  the Kilo data directory. Files outside that directory are never searched.
- User text, answers, reasoning, terminal summaries, model/provider,
  display-only agent state, and cache-aware token usage map through the shared
  OpenCode-lineage contract. Native Kilo tool display remains unsupported
  until a captured tool part proves its identity and field semantics.
- Recent incomplete rows do not imply that a Kilo process is still live. A
  live-qualified row gets working/idle status only from the authenticated
  managed server.
- A WAL commit triggers a fresh snapshot. Retained-history replacement resets
  history and invalidates stale paging instead of joining two database states.
- Unknown parts become named neutral context, never user messages.
- New Session, prompt/cancel, native rename, model selection, and per-tool
  permission replies use authenticated HTTP. SSE supplies live status, model,
  token/cache/cost, run-summary, and message updates; replay retains the same
  stable identities.
- Native child rows are Observe-only and require a live-server-qualified
  `parent_id` relationship. The installed physical capture confirmed native
  parent/child identity while keeping the child free of writer controls.

## Limits

- No terminal handoff, question route, permission-mode vocabulary, agent
  switch, files, artifacts, fork, clone, export, or trustworthy context-window
  denominator has been measured.
- Native tool display stays disabled until a captured Kilo tool part proves its
  identity and field semantics; shared OpenCode ancestry is not enough.
- The installed physical pass confirmed the managed host, Create/Drive, model
  propagation, exact answer, token telemetry, native rename, and child roster.
  No terminal join is claimed or required because the adapter does not
  advertise one.
