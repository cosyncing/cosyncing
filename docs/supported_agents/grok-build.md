# Grok Build (experimental)

The local-store and ACP contract is physically measured against Grok Build 1.0.13
and 1.0.24. The shipped adapter offers Observe plus authenticated Create and
Resume on **1.0.13 or newer** — newer builds are not enumerated and do not need
to be. Grok updates itself in place, so a gate keyed to a version list would cost
you Create and Resume every time it did.

Builds older than 1.0.13 stay Observe-only: a missing capability is the one thing
no later check can detect. Everything else is enforced where it is used and fails
closed on its own — the ACP protocol major at handshake, reusable authentication
before any prompt, session-directory shape during discovery, and Create's
requirement that ACP and the durable store return the same new UUID. A future
build that genuinely breaks the contract is refused there, with a message naming
what broke, rather than by a version comparison that cannot say why.

The measured versions completed installed wire/client physical acceptance,
including model/mode propagation, exact output, and context usage.

Install the official Grok Build CLI, then confirm that a new login shell can
find the installed version:

```bash
type -a grok
grok --version
cosyncing setup
cosy restart
cosy doctor
```

The official CLI may be newer than any measured version. Doctor reports that as a
pass, noting the build is newer than the baseline; it is not a warning, because
warning on every ordinary Grok release would train you to ignore doctor. Create
is shown only once the running build advertises reusable cached-token
authentication. Run `grok login` first when that readiness check fails.

Setup does not install or update Grok Build and does not edit its state. It
records the validated executable path for the durable broker service. `GROK_HOME`
selects a non-default local store root, and `COSYNCING_GROK_BIN` selects a
deliberate nonstandard executable.

## Current behavior

- Stored sessions are discovered and replayed through bounded, read-only
  `summary.json`, `updates.jsonl`, and `signals.json` reads. Observe starts no
  Grok process.
- New Session and Resume use one broker-owned ACP stdio child. Creation grants
  Drive only after ACP and the durable store return the same new UUID. Resume is
  limited to durable app-created provenance. No Grok child starts during Observe.
- Answer and thinking chunks use separate lanes. Tool metadata and bounded raw
  input/output are preserved. Unknown update kinds become named neutral context,
  never user messages.
- Prompt queue, allow-once/reject permission, commands, model/mode relaunch, and
  cross-client writer sharing are covered by deterministic regressions. Foreign
  writes or transcript rewrites terminate and revoke the broker writer.
- The terminal hint uses `grok --cwd <workspace> --resume <uuid>`. It is a
  handoff to a separate process, not live synchronization with the ACP child.

## Limits

- Drive is fail-closed below 1.0.13, without reusable cached-token auth, or for a
  session that lacks durable app-created provenance.
- True terminal synchronization, files, images, artifact delivery, question
  dialogs, rename, fork, clone, export, and child-session identity are not
  exposed by this adapter.
- Background-task and task-completion updates render as activity and task-list
  state, but no task mutation control is exposed.
- Context usage is shown from the durable aggregate. Per-turn token usage is the
  native `turn_completed` report for that turn; cosyncing does not accumulate
  totals of its own.
- True terminal synchronization remains unavailable: the native resume command
  is an explicit ownership handoff to a separate process.
