# Reasonix (experimental)

Reasonix 2.61.0 and 1.25.2 are supported. Upstream development has ended:
2.61.0 is the final release and the Reasonix repository is archived.

Version rule: Drive, Create and Resume need exactly 2.61.0 or 1.25.2. Every
other version opens stored sessions in Observe mode only. 1.x releases after
1.25.2 were not measured, and from 1.38.8 they keep new sessions in a
`sessions-v4` store this adapter does not list. 2.x releases before 2.61.0 were
not measured. `cosy doctor` reports any other version as `version-unverified`
and recommends 2.61.0.

`npm install --global reasonix` installs 2.61.0 now that no later release will
appear. Pin it anyway, then confirm that a new login shell can find it:

```bash
npm install --global reasonix@2.61.0
type -a reasonix
reasonix --version
cosyncing setup
cosy restart
cosy doctor
```

Setup does not install Reasonix, edit its configuration, or start a daemon.
The adapter reads Reasonix's local session store and starts a workspace-scoped
`reasonix acp` child when a resumed app connection requests the native command
catalog. Observe-only connections do not start Reasonix.
`REASONIX_HOME` is honored when Reasonix uses a non-default store root.
The broker checks the installed version about once an hour, and again on the
next refresh after the `reasonix` executable is reinstalled or replaced. When
`reasonix` on the `PATH` is a version-manager shim, the broker sees the shim,
which does not change when the manager switches versions behind it: after such
a switch, run `cosy restart` or allow up to an hour before Drive follows the
new version.

## Moving from 1.25.2 to 2.61.0

Both versions share the same session store, so sessions keep their ids. A
1.25.2 session continued from the app on 2.61.0 keeps its id and its files.
Reasonix's own upgrade notes say its terminal interface moves a continued 1.x
session to a new session; the ACP connection the app uses did not do this when
measured. If a turn is ever answered from another session's transcript, Drive
stops and the session stays readable in Observe mode.

Sessions that a 1.x release from 1.38.8 on keeps in `sessions-v4/`, and the
`v4-<id>.jsonl` copies 2.x makes when its terminal opens one, are not listed.

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
  double-counting cache buckets. A cost Reasonix states in another currency is
  not shown.
- On 2.61.0 a driven session also shows its context-window use, which
  Reasonix reports before each answer.
- A turn that fails at the model provider ends with an error message and the
  session stays writable; the next prompt can retry.
- Continuation instructions Reasonix writes into the transcript on 2.61.0 are
  shown as context, not as user messages.
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
- The app offers the Ask, Auto and Yolo approval modes. The `readOnly` and
  `dontAsk` modes Reasonix 2.61.0 has only under `reasonix acp
  --permission-mode` are not offered, and a session saved in one of them shows
  no current mode.
- The installed-version capture confirms the command-update event but does not
  yet pin its catalog payload or a native command result; command support stays provisional.
- Durable tool rows replay their bounded result, name, and call id. They do not
  retain the live tool-call arguments, so a reattached client cannot reconstruct
  the earlier tool-call card in full.
- The store has no attributable per-session context totals, so Observe-only
  connections and 1.25.2 show no context-window use.

See the [official Reasonix site](https://reasonix.io/).
