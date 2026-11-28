# Grok Build (experimental)

The local-store and ACP contract is physically measured against Grok Build 1.0.13,
1.0.24 and 1.0.92. The shipped adapter offers Observe plus authenticated Create and
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

1.0.13 and 1.0.24 completed installed wire/client physical acceptance,
including model/mode propagation, exact output, and context usage. 1.0.92 was
driven through the adapter in a throwaway home: Create, Resume by a fresh
adapter as after a broker restart, prompts, an approved and a rejected
permission, and Stop. That run used a custom model with an API key, so its
cached-token sign-in was not exercised.

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
- While the app drives a session, the title Grok generates after the first
  prompt replaces the session title, unless you named the session when you
  created it. The broker keeps that name only in memory: if it restarts between
  Create and the first prompt, Grok's title replaces the name you gave. If the
  running Grok child reports a switch to another listed model, the current
  model follows; 1.0.92 was seen sending that report only while it loaded a
  session.
- A custom model whose `[model.<key>]` key differs from the `model` id it names
  keeps Drive on Resume. Grok stores the id and loads the model under its key,
  so the app shows the key, as the model picker lists it. The broker learns
  which id a key stores when it creates or resumes a session on that model;
  choosing such a model in the picker before then ends Drive, because Grok's
  stored id does not show that the switch took effect.
- In the default mode Grok 1.0.92 asks before writing a file and reads without
  asking. Rejecting a write ends the turn as cancelled: Grok stops the turn
  itself rather than letting the model continue.
- Stop is offered as an action while driving. It sends ACP `session/cancel`,
  drops prompts not yet delivered, and keeps Drive; the turn closes as
  cancelled when Grok answers the prompt with `stopReason: cancelled`. If the
  prompt has not answered 10 seconds after Stop, the writer is stopped and the
  session becomes read-only with a notice. Grok lists no stop command of its
  own; its bundled hook documentation counts a client `session/cancel` as a user
  interrupt. On 1.0.92 a Stop during a streamed answer closed the turn as
  cancelled 48 ms later, the partial answer stayed in the stored log, and Drive
  was kept.
- The terminal hint uses `grok --cwd <workspace> --resume <uuid>`. It is a
  handoff to a separate process, not live synchronization with the ACP child.

## Limits

- Drive is fail-closed below 1.0.13, without reusable cached-token auth, or for a
  session that lacks durable app-created provenance. A signed-out Grok 1.0.92
  set up with an API key offers `xai.api_key` and `grok.com` sign-in but no
  cached token, so Create stays hidden there until `grok login`.
- A real Stop has been measured on 1.0.92 only; older builds are covered by the
  conformance fake. 1.0.92 still reports `_meta.cancelRewind: true`, as 1.0.41
  did, but its stopped turn's log was not rewritten.
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
