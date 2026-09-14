# Reasonix (experimental)

The current native contract is measured against Reasonix 1.25.2 exactly.
Other versions remain Observe-only until their ACP and store contracts are
measured. The installed broker/client physical pass completed against the
measured version. Install the official CLI, then confirm that a new login shell
can find it:

```bash
npm install --global reasonix@1.25.2
type -a reasonix
reasonix --version
cosyncing setup
cosy restart
cosy doctor
```

Setup does not install Reasonix, edit its configuration, or start a daemon.
Cosyncing keeps stored sessions available in Observe mode when another
Reasonix version is installed, but Create and Resume remain disabled until that
version's native ACP and store contract is measured.
The adapter reads Reasonix's local session store and starts a workspace-scoped
`reasonix acp` child when a resumed app connection requests the native command
catalog. Observe-only connections do not start Reasonix.
`REASONIX_HOME` is honored when Reasonix uses a non-default store root.

## Current behavior

- Stored sessions are discovered and replayed in read-only Observe mode without
  starting Reasonix.
- Resume loads the same durable session through a broker-owned ACP child and
  requests its command catalog before the first prompt. New
  sessions are offered only when the CLI is available and the ACP id appears in
  the durable store.
- Prompts are queued in order, survive reattach before Reasonix flushes them,
  and reconcile with the durable transcript without duplicate rows.
- Answer and reasoning output stream in separate lanes. Per-turn runtime,
  cumulative token counters, and USD cost are shown when ACP attributes them to
  the session. Partial usage updates merge without lowering token counters or
  double-counting cache buckets.
- Per-tool ACP permission requests can be approved once, approved as a rule, or
  rejected from the app.
- Protocol-shaped ACP slash commands are offered when the resumed child
  publishes its command catalog. Invoking one sends the advertised `/<name>`
  form through that same writer.
- Multiple clients join the same Drive connection and one ACP stdin. A
  detectable foreign transcript write cancels that writer and demotes every
  joined client to read-only Observe.

## Limits

- Reasonix has no verified terminal join channel. The app's ACP child and an
  independently resumed TUI must not write the same session together.
- The store does not expose a measured per-write native writer identity. An
  external writer that races the broker with the exact expected prompt text at
  the exact expected row can therefore be indistinguishable from the broker's
  own echo. This is a residual native-identity limitation, not a safe
  coexistence mode; do not run another writer against a driven session.
- Existing-session model switching, files, images, artifact delivery, question
  dialogs, task lists, subagent rows, rename, fork, and export
  are not exposed by this adapter.
- The installed-version capture confirms the command-update event but does not
  yet pin its catalog payload or a native command result; command support stays provisional.
- Durable tool rows replay their bounded result, name, and call id. They do not
  retain the live tool-call arguments, so a reattached client cannot reconstruct
  the earlier tool-call card in full.
- The store has no attributable per-session token or context totals. Live ACP
  can report tokens and cost, but no measured context-window maximum exists.

See the [official Reasonix site](https://reasonix.io/).
