# Kimi Code (experimental)

cosyncing talks to the local server Kimi Code starts with `kimi web --no-open`,
over its REST and WebSocket API. It was verified against Kimi Code 0.38.0; the
server API is marked experimental upstream, so the floor is the exact tested
version rather than an inferred earlier one.

The adapter is registered for every broker. Clients built before the contract
revision that added tolerant agent decoding are not shown it — one row they
cannot decode would cost them their whole agent list.

## Current behavior

- Every session on the server is discovered and observable read-only, whoever
  started it.
- Sessions cosyncing creates are additionally drivable: prompts, approvals,
  question replies, interruption, and model selection.
- A session cosyncing did not create can be taken over explicitly. That is a
  decision you make, not something cosyncing infers.
- Model selection is offered at creation time and while driving.
- File and image attachments are supported: images go inline as vision input,
  other files upload through the server's own file API.
- A deliverable the agent writes inside the session's own directory is surfaced
  as a downloadable file artifact. Source churn, a write outside that directory,
  and a write that failed surface nothing.
- The server's slash commands are offered, including `/goal` and its skills as
  prompt commands.
- Subagent runs appear as observe-only child rows under the session that
  spawned them, with live activity while a child is still writing.

Agent and mode switching are not implemented yet.

## Why a session you started elsewhere is read-only

Two processes writing one Kimi session silently fork its journal, and a terminal
`kimi -S <id>` is a writer cosyncing cannot see, negotiate with, or lock out. So
Drive is limited to sessions cosyncing created and can be extended to others only
by an explicit takeover. A drive connection also watches for foreign writes and
demotes itself to observing when it finds one.

## Managed hosts

An installed cosyncing service starts `kimi web` when none is running, restarts
it if it crashes, and stops it when the service stops. A foreground broker does
the same when `COSYNCING_KIMI_MANAGED_HOST=1` is set in its environment.

Authorization is not ownership. The broker acts only on a process it can prove
it started — pid, a start token that survives pid reuse, the boot it started in,
and the address the claim was recorded for must all match, re-proved immediately
before every signal. The command name is recorded as diagnostic evidence but is
not part of the proof: a process can rename itself at runtime. A `kimi web` you
started yourself is never stopped, replaced, or reconfigured, and neither is one
the machine will not let cosyncing identify.

`cosyncing doctor` reports what it found either way, but what it tells you to do
depends on whether cosyncing manages the Kimi home you are pointed at — the one
the service resolves, or one it started and recorded. Set `KIMI_CODE_HOME` to
something else and doctor treats that home as yours: nothing supervises it, so
the manual command is the right answer and you get it. Where it does, doctor never
offers a `kimi web` command — not to start the server and not to restart it,
because stopping a supervised host just opens a window for cosyncing to start a
replacement while you start another. It points at the service instead. Where
nothing manages the host, the direct command is the whole answer and doctor
gives it.
